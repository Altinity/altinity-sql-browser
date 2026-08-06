// Phase 0 / issue #585, plan §12 "Temporary files and Docker orchestration"
// and §13 "Required matrix rows". A dependency-free Node orchestrator that
// boots one real ClickHouse server (OSS or Altinity Stable, resolved by
// `matrix.json`) in Docker for the live-server test specs
// (`live-parity.test.ts`/`live-precision.test.ts`/`live-sessions.test.ts`).
//
// Kept as plain `.mjs` (not `.ts`) per plan §8, matching `fault-server.mjs`'s
// precedent: Node orchestration files stay untyped.
//
// CRITICAL environment rule (this sandbox's own CLAUDE.md, and plan §12):
// Docker bind mounts from `/tmp` are BLOCKED here — every generated config
// file this module mounts into a container MUST live under `$TMPDIR`, never
// `/tmp` directly (they're different paths in this environment; `/tmp` is
// shared across sandbox users and rejected by the Docker daemon's own mount
// allowlist). `assertUnderSpikeTmp` enforces this before every `-v` flag this
// module constructs — never bypass it.
//
// DISCOVERED FOOTGUN — bind-mounting OVER /etc/clickhouse-server/config.d
// HIDES THE BASE IMAGE'S OWN docker_related_config.xml (verified empirically
// while building this module, with repeated live-container trials — record
// in memory if you hit it again): the official `clickhouse/clickhouse-server`
// image ships that one file inside `config.d/` specifically to override
// `<listen_host>` from the base config's loopback-only default to `::` /
// `0.0.0.0` ("Listen wildcard address to allow accepting connections from
// other containers and host network"). A bind mount TARGETING
// `config.d` itself (as opposed to a subdirectory or a different config
// path) REPLACES the whole directory, silently losing that file — the
// server then binds loopback-only INSIDE its own network namespace, so
// `docker exec ... wget http://127.0.0.1:8123/` still succeeds (loopback,
// from inside the same namespace) while the HOST's published port NAT-
// forwards a TCP connection that ClickHouse's own listener never accepts on
// that interface — curl sees "Connected... Empty reply from server" (exit
// 52) forever, indistinguishable from a slow cold start unless you check
// `docker exec` reachability too. This has NOTHING to do with
// `$DOCKER_NETWORK` attachment (a customs-network red herring this module's
// author chased first — both `--network`-attached and default-bridge-only
// containers reproduce it identically once `config.d` is shadowed, and
// neither reproduces it once the override below is restored).
//
// FIX: this module's own generated `config.d` always ships an EQUIVALENT
// `<listen_host>` override (`CORS_CONFIG_XML`, below) alongside its CORS
// settings, so mounting over `config.d` never loses that behavior.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, sep, resolve as resolvePath } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MATRIX_PATH = join(here, 'matrix.json');

/** The Docker label key every container this module creates carries. The
 * value is a per-process run ID (see `RUN_ID` below) so a crashed/leaked run
 * can still be identified and swept by `stopAllOrphans()` even from a fresh
 * process — plan §12 "use unique names and labels" / "remove only containers
 * carrying the run label". */
export const RUN_LABEL_KEY = 'com.altinity.sql-browser.spike585';

/** One value per Node process invocation of this module — every container
 * `startRow` creates in THIS process carries this exact label value, so
 * `stopAll()` (no args) cleans up only what THIS run started, never a
 * concurrent run's containers. */
export const RUN_ID = `run-${Date.now()}-${randomBytes(4).toString('hex')}`;

// ── Non-secret fixture credentials ──────────────────────────────────────────
// MUST stay byte-identical to `auth-fixtures.ts`'s BASIC_USER_A/B/DENIED_USER
// (cross-referenced there too) — this file is plain `.mjs` and therefore
// cannot import that `.ts` module directly under a bare `node
// clickhouse-containers.mjs` invocation (no vitest/esbuild transform present
// outside the test runner), so the two non-secret literal sets are kept in
// sync by comment cross-reference rather than a shared import. Every value
// here is a throwaway, container-local, non-secret fixture (plan §12 "create
// non-secret users").
export const FIXTURE_USERS = {
  basicA: { username: 'asb_spike_a', password: 'asb-spike-a-nonsecret' },
  basicB: { username: 'asb_spike_b', password: 'asb-spike-b-nonsecret' },
  denied: { username: 'asb_spike_denied', password: 'asb-spike-denied-nonsecret' },
};
export const FIXTURE_ROLE = 'asb_spike_role';

// ── Env preflight (plan §12: "require non-empty $DOCKER_NETWORK" / "$TMPDIR") ─

/** Throws unless both `$DOCKER_NETWORK` and `$TMPDIR` are non-empty. Never
 * defaults either — a missing value is a hard stop, not a fallback to `/tmp`
 * or the default bridge network. */
export function requireEnv(env = process.env) {
  const dockerNetwork = env.DOCKER_NETWORK;
  const tmpdir = env.TMPDIR;
  if (!dockerNetwork) throw new Error('clickhouse-containers: $DOCKER_NETWORK must be set and non-empty (never falls back to the default bridge)');
  if (!tmpdir) throw new Error('clickhouse-containers: $TMPDIR must be set and non-empty (never falls back to /tmp — Docker bind mounts from /tmp are blocked in this environment)');
  return { dockerNetwork, tmpdir };
}

/** `mktemp -d "$TMPDIR/asb-585.XXXXXX"` (plan §12's exact pattern), returning
 * the created directory's absolute, symlink-resolved path. */
export function createSpikeTmp(env = process.env) {
  const { tmpdir } = requireEnv(env);
  const dir = mkdtempSync(join(tmpdir, 'asb-585.'));
  return realpathSync(dir);
}

/** Throws unless `candidateAbs` resolves to a path strictly beneath
 * `spikeTmpAbs` (both already-resolved, symlink-free absolute paths) — the
 * preflight every bind-mount source this module constructs must pass (plan
 * §12 "resolve and verify every bind source stays beneath $SPIKE_TMP" /
 * §35 sabotage case 26 "bind-mount from /tmp"). */
export function assertUnderSpikeTmp(candidateAbs, spikeTmpAbs) {
  const candidate = resolvePath(candidateAbs);
  const base = resolvePath(spikeTmpAbs);
  if (candidate !== base && !candidate.startsWith(base + sep)) {
    throw new Error(`clickhouse-containers: refusing to bind-mount "${candidate}" — it is not beneath SPIKE_TMP ("${base}")`);
  }
  return candidate;
}

// ── matrix.json ──────────────────────────────────────────────────────────────

export function loadMatrix(matrixPath = DEFAULT_MATRIX_PATH) {
  return JSON.parse(readFileSync(matrixPath, 'utf8'));
}

/** Resolve one matrix.json row by key, or pass a fully-formed row object
 * straight through (tests occasionally want a row that isn't in matrix.json,
 * e.g. a throwaway digest). Throws on an unknown key, a `cloud`/conditional
 * row (no `pullRef` — nothing to boot), or a row missing `pullRef`. */
export function resolveRow(rowKeyOrRow, matrixPath = DEFAULT_MATRIX_PATH) {
  if (typeof rowKeyOrRow === 'object' && rowKeyOrRow !== null) {
    if (!rowKeyOrRow.pullRef) throw new Error('clickhouse-containers: row object has no pullRef to boot');
    return rowKeyOrRow;
  }
  const matrix = loadMatrix(matrixPath);
  const row = matrix.rows[rowKeyOrRow];
  if (!row) throw new Error(`clickhouse-containers: no matrix.json row named "${rowKeyOrRow}" (known rows: ${Object.keys(matrix.rows).join(', ')})`);
  if (!row.pullRef) throw new Error(`clickhouse-containers: matrix.json row "${rowKeyOrRow}" has no pullRef — it is conditional/not resolved (${row.status || 'unknown reason'})`);
  return row;
}

// ── CORS + exposed-headers config (plan §12/§14) ────────────────────────────

const CORS_CONFIG_XML = `<clickhouse>
  <!-- Restores the base image's own docker_related_config.xml override that
       our config.d bind mount would otherwise shadow — see this module's
       header docstring ("DISCOVERED FOOTGUN"). Without this, ClickHouse
       binds loopback-only INSIDE its own network namespace and the
       host-published port never receives a response. -->
  <listen_host>::</listen_host>
  <listen_host>0.0.0.0</listen_host>
  <listen_try>1</listen_try>
  <http_options_response>
    <header><name>Access-Control-Allow-Origin</name><value>*</value></header>
    <header><name>Access-Control-Allow-Headers</name><value>Authorization, Content-Type, X-ClickHouse-Format</value></header>
    <header><name>Access-Control-Allow-Methods</name><value>POST, GET, OPTIONS</value></header>
    <header><name>Access-Control-Expose-Headers</name><value>X-ClickHouse-Summary, X-ClickHouse-Query-Id, X-ClickHouse-Exception-Tag, X-ClickHouse-Format, X-ClickHouse-Timezone</value></header>
  </http_options_response>
</clickhouse>
`;

/** Write the read-only CORS/exposed-headers config ClickHouse merges from
 * `config.d/` under `${spikeTmp}/<rowLabel>/config.d/cors.xml`, verifying the
 * result stays under `spikeTmp` before returning it. */
function writeRowConfig(spikeTmp, rowLabel) {
  const configDir = join(spikeTmp, rowLabel, 'config.d');
  assertUnderSpikeTmp(configDir, spikeTmp);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'cors.xml'), CORS_CONFIG_XML, 'utf8');
  return configDir;
}

// ── docker CLI helpers ───────────────────────────────────────────────────────

async function docker(args, opts = {}) {
  try {
    const { stdout } = await execFileAsync('docker', args, { maxBuffer: 32 * 1024 * 1024, ...opts });
    return stdout;
  } catch (e) {
    const stderr = e && typeof e === 'object' && 'stderr' in e ? String(e.stderr) : '';
    throw new Error(`clickhouse-containers: docker ${args.join(' ')} failed: ${stderr || (e instanceof Error ? e.message : String(e))}`);
  }
}

async function httpPost(url, { username, password, body, timeoutMs = 5000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      body,
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
      signal: controller.signal,
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `SELECT 1` with the given admin credential until it succeeds, a hard
 * failure is observed (container exited), or `maxWaitMs` elapses. Cold start
 * under this sandbox's amd64-under-emulation Docker runtime has been
 * observed to take up to ~2 minutes — the default budget is generous on
 * purpose; a genuinely broken container fails fast via the `docker inspect`
 * exited-state check rather than waiting out the whole budget. */
async function waitForReady(containerName, url, admin, { maxWaitMs = 180_000, pollIntervalMs = 2000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      const { ok, text } = await httpPost(url, { ...admin, body: 'SELECT 1', timeoutMs: 3000 });
      if (ok && text.trim() === '1') return;
    } catch { /* connection refused/reset while starting — keep polling */ }
    let status = 'unknown';
    try {
      status = (await docker(['inspect', '--format', '{{.State.Status}}', containerName])).trim();
    } catch { /* container may not be inspectable yet on the very first tick */ }
    if (status === 'exited' || status === 'dead') {
      let logs = '';
      try { logs = await docker(['logs', '--tail', '50', containerName]); } catch { /* best-effort */ }
      throw new Error(`clickhouse-containers: container "${containerName}" ${status} before becoming ready. Last logs:\n${logs}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`clickhouse-containers: container "${containerName}" did not answer an authenticated SELECT 1 within ${maxWaitMs}ms`);
    }
    await sleep(pollIntervalMs);
  }
}

/** Run one bootstrap SQL statement as admin, throwing with the exact
 * ClickHouse error text on failure (bootstrap DDL must never fail silently —
 * a swallowed GRANT failure would surface as a much more confusing auth
 * failure much later, in an unrelated test). */
async function runAdminStatement(url, admin, sql) {
  const { ok, status, text } = await httpPost(url, { ...admin, body: sql, timeoutMs: 15_000 });
  if (!ok) throw new Error(`clickhouse-containers: bootstrap statement failed (HTTP ${status}): ${sql}\n${text}`);
}

/** Every bootstrap statement run against a fresh row after readiness (plan
 * §12: "create non-secret users for Basic auth, roles, denial, and
 * cancellation observation"). Grants are intentionally narrow (no superuser)
 * — `system.*` SELECT for the deterministic-suite-compatible fixture shape,
 * plus exactly what the live session/temp-table/cancellation specs need. */
function bootstrapStatements() {
  const { basicA, basicB, denied } = FIXTURE_USERS;
  return [
    `CREATE USER IF NOT EXISTS ${basicA.username} IDENTIFIED WITH plaintext_password BY '${basicA.password}'`,
    `CREATE USER IF NOT EXISTS ${basicB.username} IDENTIFIED WITH plaintext_password BY '${basicB.password}'`,
    `CREATE USER IF NOT EXISTS ${denied.username} IDENTIFIED WITH plaintext_password BY '${denied.password}'`,
    `GRANT SELECT ON system.* TO ${basicA.username}`,
    `GRANT SELECT ON system.* TO ${basicB.username}`,
    // Temporary-table + session SET tests (plan §23) need CREATE TEMPORARY
    // TABLE plus ordinary read/write on a scratch namespace; cancellation
    // observation (plan §22) needs KILL QUERY on the user's OWN queries.
    `GRANT CREATE TEMPORARY TABLE, SELECT, CREATE TABLE, INSERT, DROP TABLE ON *.* TO ${basicA.username}`,
    `GRANT CREATE TEMPORARY TABLE, SELECT, CREATE TABLE, INSERT, DROP TABLE ON *.* TO ${basicB.username}`,
    `GRANT KILL QUERY ON *.* TO ${basicA.username}`,
    `CREATE ROLE IF NOT EXISTS ${FIXTURE_ROLE}`,
    `GRANT SELECT ON system.* TO ${FIXTURE_ROLE}`,
    `GRANT ${FIXTURE_ROLE} TO ${basicA.username}`,
    // asb_spike_denied deliberately receives NO grants beyond its own
    // existence — the 403/denial fixture (plan §13 "roles, denial").
  ];
}

/** A single bounded liveness probe: does an unauthenticated `/ping` return
 * "Ok." within `attempts * intervalMs`? Used only to health-check the
 * opt-in `$DOCKER_NETWORK` attach below — NOT the main readiness gate
 * (`waitForReady`, which additionally waits out ClickHouse's own cold-start
 * and requires authenticated `SELECT 1`). */
async function probePing(url, attempts, intervalMs) {
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(intervalMs, 2000));
      const resp = await fetch(`${url}ping`, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok && (await resp.text()).trim() === 'Ok.') return true;
    } catch { /* keep trying */ }
    await sleep(intervalMs);
  }
  return false;
}

/** Attach `containerName` to `dockerNetwork`, then verify the already-
 * working published port (`url`, confirmed reachable at container-boot time
 * by the caller before this runs) is STILL reachable afterward. On any sign
 * of the documented footgun (this module's header docstring), disconnects
 * again and returns `false` — the container proceeds default-bridge-only
 * rather than carrying a silently-broken port. Never throws: a failed
 * attach/rollback here must never abort an otherwise-healthy container boot. */
async function attachDockerNetworkWithRollback(containerName, url, dockerNetwork) {
  try {
    await docker(['network', 'connect', dockerNetwork, containerName]);
  } catch (e) {
    process.stderr?.write?.(`clickhouse-containers: warning — "docker network connect ${dockerNetwork} ${containerName}" failed, continuing default-bridge-only: ${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
  await sleep(1000);
  const healthy = await probePing(url, 4, 1000);
  if (healthy) return true;
  process.stderr?.write?.(`clickhouse-containers: warning — attaching "${containerName}" to $DOCKER_NETWORK broke host->container HTTP delivery (the documented sandbox footgun); disconnecting and continuing default-bridge-only.\n`);
  try {
    await docker(['network', 'disconnect', dockerNetwork, containerName]);
  } catch { /* best-effort rollback */ }
  return false;
}

// ── Port discovery (plan §12: "discover assigned ports programmatically") ──

async function discoverPort(containerName, containerPort = '8123/tcp') {
  const out = (await docker(['port', containerName, containerPort])).trim();
  // "127.0.0.1:32770" (possibly multiple lines if published on more than one
  // interface — this module always publishes loopback-only, so the first
  // line is authoritative).
  const line = out.split('\n')[0];
  const m = line.match(/:(\d+)\s*$/);
  if (!m) throw new Error(`clickhouse-containers: could not parse published port from "docker port ${containerName} ${containerPort}" output: "${out}"`);
  return Number(m[1]);
}

// ── Public API ───────────────────────────────────────────────────────────────

/** One booted row's handle. `stop()` is idempotent and always safe to call
 * more than once (removes the container by name + rm -f semantics, which
 * already no-ops on an already-removed container name at the docker CLI
 * level via a clean error we swallow). */

/**
 * Boot one ClickHouse server matching `rowKeyOrRow` (a matrix.json key or a
 * fully-formed row object), bootstrap its non-secret fixture users/role, and
 * wait for it to answer an authenticated `SELECT 1`. Returns a `Handle`:
 * `{ rowKey, url, port, containerName, configDir, spikeTmp, ownsSpikeTmp,
 *    imageRef, digest, tag, serverVersion, admin, fixtureUsers, role, stop }`.
 *
 * `opts.spikeTmp` (optional): reuse a caller-provided `$SPIKE_TMP` (e.g. one
 * shared across several rows in the same run) instead of minting a fresh one
 * — when omitted, this call creates its own and `stop()` removes it too
 * (`ownsSpikeTmp: true` on the returned handle marks that case).
 */
export async function startRow(rowKeyOrRow, opts = {}) {
  const env = opts.env || process.env;
  const { dockerNetwork } = requireEnv(env);
  const matrixPath = opts.matrixPath || DEFAULT_MATRIX_PATH;
  const row = resolveRow(rowKeyOrRow, matrixPath);
  const rowKey = typeof rowKeyOrRow === 'string' ? rowKeyOrRow : (row.role || 'custom-row');
  const rowLabel = rowKey.replace(/[^a-zA-Z0-9._-]/g, '-');

  const ownsSpikeTmp = !opts.spikeTmp;
  const spikeTmp = opts.spikeTmp || createSpikeTmp(env);
  const configDir = writeRowConfig(spikeTmp, rowLabel);

  const admin = { username: `asb_spike_admin_${randomBytes(3).toString('hex')}`, password: `asb-spike-admin-${randomUUID()}` };
  const containerName = `asb585-${rowLabel}-${randomBytes(4).toString('hex')}`;

  // `stop` is defined THIS early (before `docker pull`/`docker run` even run)
  // and the try/catch below wraps EVERYTHING from here through readiness —
  // not just the later readiness-wait — so a pull/run/discoverPort/attach
  // failure cleans up exactly like a bootstrap/readiness failure already did.
  // `docker rm -f` on a container that was never created (a pull or early
  // run failure) is a harmless, already-caught no-op, so calling `stop()`
  // unconditionally here is always safe. Discovered by review: the previous
  // try/catch only wrapped `waitForReady`+bootstrap, so a pull or `docker
  // run` failure returned/threw WITHOUT ever removing the scratch config
  // directory this function creates unconditionally above.
  const stop = async () => {
    try { await docker(['rm', '-f', containerName]); } catch { /* already gone — fine */ }
    if (ownsSpikeTmp) {
      try { rmSync(spikeTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  };

  try {
    // Explicit `docker pull` FIRST (plan §13: "If a required Altinity build
    // cannot be resolved or run: do not substitute OSS silently; record the
    // exact failure") — a pull failure here throws a clear, row-tagged error
    // rather than an ambiguous `docker run` failure buried under container
    // creation.
    try {
      await docker(['pull', row.pullRef]);
    } catch (e) {
      throw new Error(`clickhouse-containers: pull failed for row "${rowKey}" (${row.pullRef}) — recording exact failure, NOT substituting another image:\n${e instanceof Error ? e.message : String(e)}`);
    }

    // Step 1: create on the DEFAULT bridge with the published port — see this
    // module's header docstring for why `--network` must NOT be passed here.
    await docker([
      'run', '-d',
      '--name', containerName,
      '--label', `${RUN_LABEL_KEY}=${RUN_ID}`,
      '--label', `asb585.row=${rowLabel}`,
      '-p', '127.0.0.1::8123',
      '-v', `${configDir}:/etc/clickhouse-server/config.d:ro`,
      '-e', `CLICKHOUSE_USER=${admin.username}`,
      '-e', `CLICKHOUSE_PASSWORD=${admin.password}`,
      '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
      row.pullRef,
    ]);

    const port = await discoverPort(containerName);
    const url = `http://127.0.0.1:${port}/`;

    // Step 2 (plan §12 "attach every container with --network $DOCKER_NETWORK"):
    // attach the sandbox's allowlisted network, health-checking the result
    // (belt-and-suspenders after the config.d footgun above) and rolling back
    // rather than leaving a broken container if attaching ever does regress
    // host->container delivery again. Pass `{ attachDockerNetwork: false }` to
    // skip this entirely (e.g. a caller that wants the fastest possible boot
    // and has no need for the row to be reachable from another container on
    // that network).
    let dockerNetworkAttached = false;
    if (opts.attachDockerNetwork !== false) {
      dockerNetworkAttached = await attachDockerNetworkWithRollback(containerName, url, dockerNetwork);
    }

    await waitForReady(containerName, url, admin, opts.readiness);
    for (const stmt of bootstrapStatements()) {
      await runAdminStatement(url, admin, stmt);
    }
    const versionResp = await httpPost(url, { ...admin, body: 'SELECT version()' });
    const serverVersion = versionResp.text.trim();

    return {
      rowKey,
      url,
      port,
      containerName,
      configDir,
      spikeTmp,
      ownsSpikeTmp,
      dockerNetworkAttached,
      imageRef: row.pullRef,
      digest: row.digest,
      tag: row.tag,
      serverVersion,
      admin,
      fixtureUsers: FIXTURE_USERS,
      role: FIXTURE_ROLE,
      stop,
    };
  } catch (e) {
    // Never leak a half-booted container OR the scratch config directory on
    // ANY failure between directory creation and readiness (pull, run,
    // discoverPort, network-attach, bootstrap, readiness).
    await stop();
    throw e;
  }
}

/** Remove every container carrying THIS process's `RUN_ID` label value
 * (never another concurrent run's containers). `stop()` on individual
 * handles already does this per-container; call this as a final sweep (e.g.
 * in a `finally` around a whole multi-row run) to guarantee nothing from
 * this run is left even if an individual `stop()` was skipped. */
export async function stopAll(env = process.env) {
  await stopByLabel(`${RUN_LABEL_KEY}=${RUN_ID}`);
}

/** Crash-recovery sweep: remove EVERY container carrying `RUN_LABEL_KEY`
 * regardless of run value (a previous process that crashed before its own
 * `stopAll()` ran). Never touches a container without this exact label. */
export async function stopAllOrphans() {
  await stopByLabel(RUN_LABEL_KEY);
}

async function stopByLabel(labelFilter) {
  const out = await docker(['ps', '-a', '--filter', `label=${labelFilter}`, '--format', '{{.Names}}']);
  const names = out.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    try { await docker(['rm', '-f', name]); } catch { /* best-effort */ }
  }
  return names;
}

/** List every container currently carrying `RUN_LABEL_KEY` (any run value) —
 * used by the smoke-test/doneWhen check ("docker ps -a filtered by the run
 * label is empty") without shelling out to `docker` directly. */
export async function listLabeledContainers() {
  const out = await docker(['ps', '-a', '--filter', `label=${RUN_LABEL_KEY}`, '--format', '{{.Names}}']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// `node clickhouse-containers.mjs up <rowKey>` — boots one row, prints a
// single "READY <json>" line to stdout once authenticated SELECT 1 succeeds
// and bootstrap DDL has run, then blocks (trapping SIGINT/SIGTERM/SIGHUP) —
// a caller (a shell wrapper, or a human) reads that line for the connection
// info, runs whatever it wants against `url`, then sends a signal to trigger
// cleanup. `node clickhouse-containers.mjs down` sweeps every orphaned
// labeled container from any previous run (crash recovery).

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'up') {
    if (!arg) {
      process.stderr.write('usage: node clickhouse-containers.mjs up <rowKey>\n');
      process.exitCode = 2;
      return;
    }
    const handle = await startRow(arg);
    const summary = {
      rowKey: handle.rowKey,
      url: handle.url,
      port: handle.port,
      containerName: handle.containerName,
      imageRef: handle.imageRef,
      digest: handle.digest,
      tag: handle.tag,
      serverVersion: handle.serverVersion,
      admin: handle.admin,
      fixtureUsers: handle.fixtureUsers,
      role: handle.role,
      spikeTmp: handle.spikeTmp,
      configDir: handle.configDir,
    };
    process.stdout.write(`READY ${JSON.stringify(summary)}\n`);
    let cleaningUp = false;
    const cleanup = async (signal) => {
      if (cleaningUp) return;
      cleaningUp = true;
      process.stderr.write(`clickhouse-containers: received ${signal}, cleaning up ${handle.containerName}...\n`);
      await handle.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('SIGHUP', () => cleanup('SIGHUP'));
    // Block forever (until a signal above fires) — a plain empty Promise
    // rather than a busy-wait, so this process is idle while the caller
    // drives tests against `url`.
    await new Promise(() => {});
  } else if (cmd === 'down') {
    const removed = await stopAllOrphans();
    process.stdout.write(`${JSON.stringify({ removed })}\n`);
  } else {
    process.stderr.write('usage: node clickhouse-containers.mjs <up <rowKey>|down>\n');
    process.exitCode = 2;
  }
}

if (isMainModule()) {
  main().catch((e) => {
    process.stderr.write(`clickhouse-containers: ${e instanceof Error ? e.stack || e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
