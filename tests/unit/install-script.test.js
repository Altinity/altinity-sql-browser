// deploy/install.sh --dry-run prints the post-install next steps (#692). The
// script is copied into a scratch tree (ROOT is derived from its location) and
// run with shimmed npm/node/curl so nothing is built and nothing leaves the box.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(__dirname, '../..');
let work = '';

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'asb-install-'));
  mkdirSync(join(work, 'deploy'));
  mkdirSync(join(work, 'dist'));
  mkdirSync(join(work, 'build'));
  mkdirSync(join(work, 'bin'));
  copyFileSync(join(repo, 'deploy/install.sh'), join(work, 'deploy/install.sh'));
  copyFileSync(join(repo, 'deploy/http_handlers.xml'), join(work, 'deploy/http_handlers.xml'));
  writeFileSync(join(work, 'build/build.mjs'), '');
  writeFileSync(join(work, 'dist/sql.html'), '<html></html>'); // the shimmed build produces nothing
  // clickhouse-client shim: log argv and stdin size, succeed. A system.clusters
  // count query answers with $ASB_NODE_COUNT (default 1; may be empty) or, with
  // $ASB_FAIL set, fails with stderr.
  const ch = join(work, 'bin', 'clickhouse-client');
  writeFileSync(ch, `#!/bin/sh
{ printf 'ARGS:'; for a in "$@"; do printf ' [%s]' "$(printf %s "$a" | tr '\\n' ' ')"; done; printf ' STDIN:%s\\n' "$(wc -c | tr -d ' ')"; } >> "${work}/ch.log"
case "$*" in *system.clusters*)
  if [ -n "\${ASB_FAIL:-}" ]; then echo "Code: 210. DB::NetException: Connection refused" >&2; exit 210; fi
  echo "\${ASB_NODE_COUNT-1}"; exit 0;;
esac
exit 0
`);
  chmodSync(ch, 0o755);
  for (const [name, code] of [['npm', 0], ['node', 0], ['curl', 22]]) {
    const p = join(work, 'bin', name);
    writeFileSync(p, `#!/bin/sh\necho ${name} >> "${work}/build.log"\nexit ${code}\n`);
    chmodSync(p, 0o755);
  }
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

function dryRun(...args) {
  const r = spawnSync('bash', [join(work, 'deploy/install.sh'), '--client-id', 'cid', '--dry-run', ...args], {
    env: { ...process.env, PATH: `${join(work, 'bin')}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe('install.sh next-steps output', () => {
  it('prints http and the plain HTTP port without --secure', () => {
    const out = dryRun('--ch-host', 'ch.example.com');
    expect(out).toContain('http://ch.example.com:8123/sql');
    expect(out).not.toContain('https://ch.example.com');
  });

  it('prints https and the TLS HTTP port with --secure', () => {
    const out = dryRun('--ch-host', 'ch.example.com', '--secure');
    expect(out).toContain('https://ch.example.com:8443/sql');
    expect(out).not.toContain('http://ch.example.com');
  });

  it('uses a placeholder host when --ch-host is omitted in a dry run', () => {
    expect(dryRun()).toContain('http://<ch-host>:8123/sql');
  });
});

describe('install.sh real upload path', () => {
  function install(...args) {
    const log = join(work, 'ch.log');
    rmSync(log, { force: true });
    const r = spawnSync('bash', [join(work, 'deploy/install.sh'), '--client-id', 'cid', '--ch-host', 'ch.example.com', ...args], {
      env: { ...process.env, CLICKHOUSE_PASSWORD: 'pw', PATH: `${join(work, 'bin')}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    return { out: r.stdout, calls: readFileSync(log, 'utf8').trim().split('\n') };
  }

  it('uploads both assets and prints http next steps without --secure', () => {
    const { out, calls } = install();
    expect(calls.some((c) => c.includes('_asb_sql_html'))).toBe(true);
    expect(calls.some((c) => c.includes('_asb_sql_config_json'))).toBe(true);
    expect(calls.some((c) => c.includes('[--secure]'))).toBe(false);
    expect(out).toContain('==> Assets uploaded');
    expect(out).toContain('http://ch.example.com:8123/sql');
    expect(out).not.toContain('https://ch.example.com');
  });

  it('passes --secure to every call and prints https next steps with --secure', () => {
    const { out, calls } = install('--secure');
    expect(calls.some((c) => c.includes('_asb_sql_html'))).toBe(true);
    expect(calls.some((c) => c.includes('_asb_sql_config_json'))).toBe(true);
    expect(calls.every((c) => c.includes('[--secure]'))).toBe(true);
    expect(out).toContain('https://ch.example.com:8443/sql');
    expect(out).not.toContain('http://ch.example.com');
  });
});

describe('install.sh --cluster guard (#692)', () => {
  function clusterInstall(count, fail = false) {
    rmSync(join(work, 'ch.log'), { force: true });
    rmSync(join(work, 'build.log'), { force: true });
    const env = { ...process.env, ASB_NODE_COUNT: String(count), CLICKHOUSE_PASSWORD: 'pw', PATH: `${join(work, 'bin')}:${process.env.PATH ?? ''}` };
    if (fail) env.ASB_FAIL = '1';
    const r = spawnSync('bash', [join(work, 'deploy/install.sh'), '--client-id', 'cid', '--ch-host', 'ch.example.com', '--cluster', 'c1'], { env, encoding: 'utf8' });
    let built = '';
    try { built = readFileSync(join(work, 'build.log'), 'utf8'); } catch { /* no build ran */ }
    return { r, built };
  }

  it('fails fast with exit 2 before building when the cluster has more than one replica', () => {
    const { r, built } = clusterInstall(2);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('has 2 replicas');
    expect(r.stderr).toContain('#692');
    expect(r.stderr).toContain('docs/ASSET-DISTRIBUTION.md');
    expect(built).toBe('');
  });

  it('fails closed when the count query fails, surfacing the first stderr line but not the password', () => {
    const { r, built } = clusterInstall(1, true);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('could not query system.clusters');
    expect(r.stderr).toContain('Connection refused');
    expect(r.stderr).not.toContain('pw\n');
    expect(built).toBe('');
  });

  it('fails closed when the cluster is not found (count 0)', () => {
    const { r, built } = clusterInstall(0);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("was not found in system.clusters");
    expect(built).toBe('');
  });

  it.each([['empty', ''], ['malformed', 'abc']])('fails closed on %s output', (_n, out) => {
    const { r, built } = clusterInstall(out);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unexpected system.clusters output');
    expect(built).toBe('');
  });

  it('proceeds for a one-node cluster', () => {
    const { r, built } = clusterInstall(1);
    expect(r.status, r.stderr).toBe(0);
    expect(built).toContain('npm');
    expect(r.stdout).toContain('==> Assets uploaded');
  });
});
