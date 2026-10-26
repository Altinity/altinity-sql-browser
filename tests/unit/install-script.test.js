// deploy/install.sh (#692): SQL-only, two-phase install with server-side
// fan-out. The script runs for real in a scratch tree against shimmed
// clickhouse-client/curl that simulate just enough ClickHouse (tests/helpers/
// deploy-sim.cjs) to log every statement, scripted failures, and per-node
// verification rows. Nothing builds and nothing leaves the box.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { ARTIFACT_BYTES, makeHarness, sha256 } from '../helpers/deploy-harness.js';

// each case spawns real bash + shim processes; allow for a loaded CI box
vi.setConfig({ testTimeout: 60000 });

let h;
beforeAll(() => { h = makeHarness(); });
afterAll(() => h.cleanup());

const TOKEN = { ASB_STAGE_TOKEN: 'tok123' };
const ART_SHA = sha256(ARTIFACT_BYTES);
const CFG = '{"issuer":"https://accounts.google.com","client_id":"cid"}';
const CFG_SHA = sha256(CFG);
const idx = (sqls, re) => sqls.findIndex((s) => re.test(s));
const live = /CREATE TABLE default\._asb_t_live_/;
const ctas = (sqls) => sqls.filter((s) => /^CREATE TABLE/.test(s));
const writes = (sqls) => sqls.filter((s) => /^(CREATE|DROP|INSERT)/.test(s));

describe('next-steps output (--dry-run, no ClickHouse contact)', () => {
  const dry = (...args) => {
    const x = h.run('install.sh', ['--client-id', 'cid', '--dry-run', ...args]);
    expect(x.r.status, x.r.stderr).toBe(0);
    expect(x.log).toEqual([]);
    return x.r.stdout;
  };
  it('prints http and the plain HTTP port without --secure', () => {
    const out = dry('--ch-host', 'ch.example.com');
    expect(out).toContain('http://ch.example.com:8123/sql');
    expect(out).not.toContain('https://ch.example.com');
  });
  it('prints https and the TLS HTTP port with --secure', () => {
    const out = dry('--ch-host', 'ch.example.com', '--secure');
    expect(out).toContain('https://ch.example.com:8443/sql');
    expect(out).not.toContain('http://ch.example.com');
  });
  it('uses a placeholder host when --ch-host is omitted', () => {
    expect(dry()).toContain('http://<ch-host>:8123/sql');
  });
  it('renders the config and http_handlers without a build under --artifact', () => {
    const out = dry('--artifact', `${h.work}/dist/sql.html`);
    expect(out).toContain(CFG);
    expect(h.built()).toBe('');
  });
});

describe('single-node install (no --cluster)', () => {
  it('uploads straight to the next file, verifies, promotes locally, verifies live', () => {
    const { r, sqls, files } = h.install([], { env: TOKEN });
    expect(r.status, r.stderr).toBe(0);
    expect(sqls.some((s) => /ON CLUSTER|clusterAllReplicas/.test(s))).toBe(false);
    const up = idx(sqls, /^INSERT INTO FUNCTION file\('_asb_next_sql\.html','RawBLOB'\).*FORMAT RawBLOB/);
    const v1 = idx(sqls, /SHA256.*_asb_next_sql\.html/);
    const promote = idx(sqls, /ENGINE=File\('RawBLOB','sql\.html'\)/);
    expect(up).toBeGreaterThan(-1);
    expect(v1).toBeGreaterThan(up);
    expect(promote).toBeGreaterThan(v1);
    expect(files['sql.html']).toEqual({ len: ARTIFACT_BYTES.length, sha: ART_SHA });
    expect(files['sql-config.json'].sha).toBe(CFG_SHA);
    expect(r.stdout).toContain('==> Assets uploaded');
    expect(r.stdout).toContain('verified on 1 node(s)');
    expect(r.stdout).toContain('behind a load balancer');
    expect(r.stdout).toContain('http://ch.example.com:8123/sql');
  });
  it('builds from source without --artifact, and not with it', () => {
    h.install([], { env: TOKEN });
    expect(h.built()).toContain('npm');
    expect(h.built()).toContain('node');
    const x = h.install(['--artifact', `${h.work}/dist/sql.html`], { env: TOKEN });
    expect(x.r.status, x.r.stderr).toBe(0);
    expect(h.built()).toBe('');
  });
  it('passes --secure to every clickhouse-client call and prints https next steps', () => {
    const { r, log } = h.install(['--secure'], { env: TOKEN });
    expect(log.length).toBeGreaterThan(5);
    expect(log.every((l) => l.argv.includes('--secure'))).toBe(true);
    expect(r.stdout).toContain('https://ch.example.com:8443/sql');
  });
  it('sets distributed_ddl_task_timeout from --ddl-timeout (default 180)', () => {
    expect(h.install([], { env: TOKEN }).log[0].argv).toContain('--distributed_ddl_task_timeout=180');
    expect(h.install(['--ddl-timeout', '7'], { env: TOKEN }).log[0].argv).toContain('--distributed_ddl_task_timeout=7');
  });
  it('supports --pull-url on one node', () => {
    const { r, sqls } = h.install(['--pull-url', 'http://x/sql.html'], { env: TOKEN, cfg: { urlContent: { len: ARTIFACT_BYTES.length, sha: ART_SHA } } });
    expect(r.status, r.stderr).toBe(0);
    expect(sqls.some((s) => /FROM url\('http:\/\/x\/sql\.html'/.test(s))).toBe(true);
  });
});

describe('cluster install: two-phase ordering', () => {
  const run = (extra = [], opts = {}) => h.install(['--cluster', 'c1', ...extra], { env: TOKEN, cfg: { nodes: 3 }, ...opts });

  it('preflights, pre-cleans, stages, fans out, verifies, THEN promotes, verifies, cleans up', () => {
    const { r, sqls, files } = run();
    expect(r.status, r.stderr).toBe(0);
    const pre = idx(sqls, /view\(SELECT hostName\(\)\)\)/);
    const clean = idx(sqls, /^DROP TABLE IF EXISTS default\._asb_t_next_html ON CLUSTER `c1` SYNC/);
    const stage = idx(sqls, /^INSERT INTO FUNCTION file\('_asb_stage_tok123\.html','RawBLOB'\).*FORMAT RawBLOB/);
    const stageVerify = idx(sqls, /SHA256.*_asb_stage_tok123\.html/);
    const next = idx(sqls, /^CREATE TABLE default\._asb_t_next_html ON CLUSTER `c1` ENGINE=File\('RawBLOB','_asb_next_sql\.html'\)/);
    const v1 = idx(sqls, /SHA256.*_asb_next_sql\.html/);
    const promote = idx(sqls, /ENGINE=File\('RawBLOB','sql\.html'\) AS SELECT c FROM file\('_asb_next_sql\.html'/);
    const v2 = idx(sqls, /SHA256.*FROM file\('sql\.html'/);
    expect([pre, clean, stage, stageVerify, next, v1, promote, v2].every((i) => i >= 0)).toBe(true);
    expect([pre, clean, stage, stageVerify, next, v1, promote, v2]).toEqual([pre, clean, stage, stageVerify, next, v1, promote, v2].slice().sort((a, b) => a - b));
    // no live-file CTAS anywhere before the first phase-1 verify
    expect(sqls.slice(0, v1).some((s) => live.test(s))).toBe(false);
    // the live CTAS copies the node's OWN next file, never a remote source
    for (const s of sqls.filter((x) => live.test(x))) expect(s).not.toMatch(/clusterAllReplicas|url\(/);
    expect(files['sql.html'].sha).toBe(ART_SHA);
    // always-cleanup: stage truncated, then every temp table dropped IF EXISTS
    const tail = sqls.slice(-5);
    expect(tail[0]).toBe("INSERT INTO FUNCTION file('_asb_stage_tok123.html','RawBLOB') SETTINGS engine_file_truncate_on_insert=1 SELECT ''");
    expect(tail.slice(1).every((s) => /^DROP TABLE IF EXISTS default\._asb_t_\w+ ON CLUSTER `c1` SYNC$/.test(s))).toBe(true);
    expect(files['_asb_stage_tok123.html'].len).toBe(0);
    expect(r.stdout).toContain('verified on 3 node(s)');
    expect(r.stdout).toMatch(/node-3\s+\d+\s+[0-9a-f]{64} ok/);
  });

  it('every CTAS truncates on insert; the stage CTAS tolerates a missing file', () => {
    const { sqls } = run();
    const all = ctas(sqls);
    expect(all.length).toBe(4);
    for (const s of all) expect(s).toContain('engine_file_truncate_on_insert=1');
    const stageCtas = all.find((s) => s.includes('clusterAllReplicas'));
    expect(stageCtas).toContain('engine_file_empty_if_not_exists=1');
    expect(stageCtas).toContain("file('_asb_stage_tok123.html'");
  });

  it('a 3-node cluster is accepted (the multi-node guard is gone)', () => {
    expect(run().r.status).toBe(0);
  });

  it('a sha mismatch on one node in phase 1 aborts with the live files untouched', () => {
    const { r, sqls, files } = run([], { cfg: { nodes: 3, badNodes: { '_asb_next_sql.html': { 2: { len: 1, sha: 'dead' } } } } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('phase 1 verification failed; live files were NOT touched');
    expect(r.stdout).toMatch(/node-2\s+1\s+dead\s+MISMATCH/);
    expect(sqls.some((s) => live.test(s))).toBe(false);
    expect(files['sql.html']).toBeUndefined();
    expect(sqls.slice(-5)[0]).toContain("SELECT ''"); // cleanup still ran
  });

  it('refuses to continue when fewer nodes answer the preflight than system.clusters lists', () => {
    const { r, sqls } = h.install(['--cluster', 'c1'], { env: TOKEN, cfg: { nodes: 3, preflightRows: 2 } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('only 2 of 3 nodes answered');
    expect(writes(sqls)).toEqual([]);
  });

  describe.each([
    ['preflight reachability', /view\(SELECT hostName\(\)\)\)/, false],
    ['pre-clean', /^DROP TABLE IF EXISTS default\._asb_t_next_html/, true],
    ['stage upload', /FORMAT RawBLOB/, true],
    ['stage verification', /SHA256.*_asb_stage_/, true],
    ['sql.html fan-out', /^CREATE TABLE default\._asb_t_next_html/, true],
    ['config fan-out', /^CREATE TABLE default\._asb_t_next_cfg/, true],
    ['phase-1 verification', /SHA256.*_asb_next_sql/, true],
  ])('failure at %s', (name, match, cleanupArmed) => {
    it('exits non-zero, never writes a live file, and cleans up', () => {
      const { r, sqls, files } = run([], { cfg: { nodes: 3, rules: [{ match: match.source, stderr: 'Code: 1. injected' }] } });
      expect(r.status).toBe(1);
      expect(sqls.some((s) => live.test(s))).toBe(false);
      expect(files['sql.html']).toBeUndefined();
      if (!cleanupArmed) expect(h.built()).toBe(''); // preflight fails fast, before the slow build
      const cleaned = sqls.some((s) => s === "INSERT INTO FUNCTION file('_asb_stage_tok123.html','RawBLOB') SETTINGS engine_file_truncate_on_insert=1 SELECT ''");
      expect(cleaned).toBe(cleanupArmed && name !== 'pre-clean'); // nothing staged yet at pre-clean
      if (cleanupArmed) expect(sqls.filter((s) => /^DROP TABLE IF EXISTS/.test(s)).length).toBeGreaterThanOrEqual(4);
    });
  });

  it('a phase-2 failure stops, reports, and still cleans up', () => {
    const { r, sqls } = run([], { cfg: { nodes: 3, rules: [{ match: '^CREATE TABLE default\\._asb_t_live_cfg', stderr: 'Code: 1. injected' }] } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('promote sql-config.json failed');
    expect(sqls.slice(-5)[0]).toContain("SELECT ''");
  });

  it('a phase-2 verification mismatch fails the install', () => {
    const { r } = run([], { cfg: { nodes: 3, badNodes: { 'sql.html': { 3: { len: 9, sha: 'beef' } } } } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('phase 2 verification failed');
  });
});

describe('cluster install: url source', () => {
  const url = 'https://github.com/o/r/releases/download/v1/sql.html?a=1&b=it\'s';
  const run = (urlContent) => h.install(['--cluster', 'c1', '--pull-url', url], { env: TOKEN, cfg: { nodes: 2, urlContent } });
  it('pulls with url() and redirects enabled, with no stage upload', () => {
    const { r, sqls } = run({ len: ARTIFACT_BYTES.length, sha: ART_SHA });
    expect(r.status, r.stderr).toBe(0);
    const c = sqls.find((s) => /FROM url\(/.test(s));
    expect(c).toContain('max_http_get_redirects=10');
    expect(c).toContain('engine_file_truncate_on_insert=1');
    expect(c).toContain("it\\'s"); // the URL is SQL-escaped
    expect(sqls.some((s) => /_asb_stage_|FORMAT RawBLOB/.test(s) && !/^DROP/.test(s))).toBe(false);
  });
  it('a pulled file that does not match the local artifact aborts before promoting', () => {
    const { r, sqls } = run({ len: 5, sha: 'beef' });
    expect(r.status).toBe(1);
    expect(sqls.some((s) => live.test(s))).toBe(false);
  });
});

describe('inputs', () => {
  it('escapes the config JSON in SQL (\\ and \')', () => {
    const { r, sqls, files } = h.install(['--client-id', "it's\\x"], { env: TOKEN });
    const cfg = '{"issuer":"https://accounts.google.com","client_id":"it\'s\\x"}';
    expect(r.status, r.stderr).toBe(0); // verification compares the locally computed sha to what the server wrote
    expect(files['sql-config.json'].sha).toBe(sha256(cfg));
    expect(sqls.find((s) => /_asb_t_next_cfg/.test(s) && /^CREATE/.test(s))).toContain("it\\'s\\\\x");
  });
  it.each(["c'; DROP TABLE x; --", 'a b', 'a`b', ''])('rejects the cluster name %j without touching ClickHouse', (name) => {
    const { r, log } = h.install(['--cluster', name || 'x y']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('invalid --cluster name');
    expect(log).toEqual([]);
  });
  it('accepts dots and dashes in a cluster name, quoting it', () => {
    const { r, sqls } = h.install(['--cluster', 'my-c.1'], { env: TOKEN, cfg: { nodes: 2 } });
    expect(r.status, r.stderr).toBe(0);
    expect(sqls.some((s) => s.includes('ON CLUSTER `my-c.1`'))).toBe(true);
  });
  it('rejects an unsafe stage token', () => {
    const { r } = h.install([], { env: { ASB_STAGE_TOKEN: "x'; --" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('invalid stage token');
  });
  it('generates a distinct stage token per run', () => {
    const t = () => h.install(['--cluster', 'c1'], { cfg: { nodes: 2 } }).sqls.find((s) => /^INSERT INTO FUNCTION file\('_asb_stage_/.test(s));
    expect(t()).toMatch(/_asb_stage_\d+\.html/);
    // ($RANDOM x2 + epoch seconds; two runs colliding is a 1-in-2^30 flake we accept)
    expect(t()).not.toBe(t());
  });
  it.each([
    [['--transport', 'ftp'], '--transport must be'],
    [['--ddl-timeout', 'x'], '--ddl-timeout must be'],
    [['--http-port', '8x'], '--http-port must be'],
    [['--artifact', '/nonexistent/sql.html'], 'no such file'],
    [['--pull-url', 'http://x', '--verify-only'], 'mutually exclusive'],
    [['--bogus'], 'unknown arg'],
    [['--cluster'], 'missing value for --cluster'],
  ])('rejects %j', (args, msg) => {
    const { r, log } = h.install(args);
    expect(r.status).toBe(args[0] === '--bogus' || args[0] === '--cluster' ? 2 : r.status);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(msg);
    expect(log).toEqual([]);
  });
  it('requires --client-id and (outside a dry run) --ch-host', () => {
    expect(h.run('install.sh', ['--ch-host', 'x']).r.status).toBe(2);
    expect(h.run('install.sh', ['--client-id', 'c']).r.stderr).toContain('--ch-host is required');
  });
});

describe('fail-closed cluster checks', () => {
  const run = (cfg) => h.install(['--cluster', 'c1'], { env: TOKEN, cfg });
  it('fails when the count query fails, surfacing its error but not the password', () => {
    const { r } = run({ rules: [{ match: 'FROM system\\.clusters', stderr: 'Code: 210. Connection refused', code: 210 }] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not query system.clusters');
    expect(r.stderr).toContain('Connection refused');
    expect(r.stderr).toContain('unreachable');
    expect(r.stderr).not.toContain('pw\n');
    expect(h.built()).toBe('');
  });
  it('fails when the cluster is not found (0 nodes)', () => {
    const { r, sqls } = run({ countOut: 0 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('was not found in system.clusters');
    expect(writes(sqls)).toEqual([]);
  });
  it.each([['empty', ''], ['malformed', 'abc']])('fails on %s count output', (_n, out) => {
    const { r } = run({ countOut: out });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unexpected system.clusters output');
    expect(h.built()).toBe('');
  });
  it('explains AUTHENTICATION_FAILED on the cross-node preflight (<secret>)', () => {
    const { r } = run({ nodes: 2, rules: [{ match: 'view\\(SELECT hostName\\(\\)\\)\\)', stderr: 'Code: 516. DB::Exception: AUTHENTICATION_FAILED' }] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('AUTHENTICATION_FAILED');
    expect(r.stderr).toContain('<secret>');
  });
  it('passes missing-grant errors through with a hint', () => {
    const { r } = run({ nodes: 2, rules: [{ match: '^CREATE TABLE default\\._asb_t_next_html', stderr: 'Code: 497. DB::Exception: deploy: Not enough privileges. (ACCESS_DENIED)' }] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Not enough privileges');
    expect(r.stderr).toContain('missing grants');
  });
  it('explains a DDL timeout from a dead node', () => {
    const { r } = run({ nodes: 2, rules: [{ match: '^CREATE TABLE default\\._asb_t_next_cfg', stderr: 'Code: 159. (TIMEOUT_EXCEEDED)' }] });
    expect(r.stderr).toContain('--ddl-timeout');
  });
});

describe('--verify-only', () => {
  const good = { 'sql.html': { len: ARTIFACT_BYTES.length, sha: ART_SHA }, 'sql-config.json': { len: CFG.length, sha: CFG_SHA } };
  it('performs no writes and exits 0 when every node matches', () => {
    const { r, sqls } = h.install(['--cluster', 'c1', '--verify-only'], { cfg: { nodes: 3 }, files: good });
    expect(r.status, r.stderr).toBe(0);
    expect(writes(sqls)).toEqual([]);
    expect(r.stdout).toContain('Verified: every node serves the expected files');
    expect(r.stdout).not.toContain('Final step');
  });
  it('performs no writes and exits 1 on a mismatch, printing the table', () => {
    const { r, sqls } = h.install(['--verify-only'], { files: { ...good, 'sql.html': { len: 3, sha: 'bad' } } });
    expect(r.status).toBe(1);
    expect(writes(sqls)).toEqual([]);
    expect(r.stdout).toContain('MISMATCH');
  });
});

describe('--transport http', () => {
  const PW = 'sekret-pw';
  const run = (extra = [], opts = {}) => h.install(['--transport', 'http', ...extra], { env: { ...TOKEN, CLICKHOUSE_PASSWORD: PW }, ...opts });

  it('never puts the password (or user) in curl argv; credentials ride a 0600 header file that is removed', () => {
    const { r, log } = run(['--cluster', 'c1'], { cfg: { nodes: 2 } });
    expect(r.status, r.stderr).toBe(0);
    const calls = log.filter((l) => l.tool === 'curl');
    expect(calls.length).toBeGreaterThan(8);
    expect(log.some((l) => l.tool === 'ch')).toBe(false);
    for (const c of calls) {
      expect(c.argv.join(' ')).not.toContain(PW);
      expect(c.argv.join(' ')).not.toContain('X-ClickHouse-Key');
      expect(c.authMode).toBe(0o600);
      expect(c.authContent).toContain(`X-ClickHouse-Key: ${PW}`);
      expect(c.authContent).toContain('X-ClickHouse-User: default');
      expect(c.argv).toContain(`@${c.authFile}`);
      expect(existsSync(c.authFile)).toBe(false);
      expect(c.url).toContain('wait_end_of_query=1');
      expect(c.url).toContain('distributed_ddl_task_timeout=180');
    }
    expect(r.stdout + r.stderr).not.toContain(PW);
  });
  it('honours --http-port, --ddl-timeout and --secure', () => {
    expect(run(['--http-port', '9999', '--ddl-timeout', '9']).log[0].url).toBe('http://ch.example.com:9999/?wait_end_of_query=1&distributed_ddl_task_timeout=9');
    expect(run(['--secure']).log[0].url).toMatch(/^https:\/\/ch\.example\.com:8443\/\?/);
  });
  it('uploads the artifact bytes as the request body after the SQL', () => {
    const { log, files } = run();
    expect(log.some((l) => l.sql.includes('FORMAT RawBLOB') && l.stdinBytes === ARTIFACT_BYTES.length)).toBe(true);
    expect(files['sql.html'].sha).toBe(ART_SHA);
  });
  it.each([
    ['a non-2xx status', 'status'],
    ['an X-ClickHouse-Exception-Code header', 'header'],
    ['__exception__ in a 200 body', 'body'],
  ])('treats %s as failure and keeps the live file untouched', (_n, http) => {
    const { r, sqls, files } = run([], { cfg: { rules: [{ match: '^CREATE TABLE default\\._asb_t_next_cfg', stderr: 'Code: 60. DB::Exception: boom', http }] } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('boom');
    expect(sqls.some((s) => live.test(s))).toBe(false);
    expect(files['sql.html']).toBeUndefined();
  });
  it('does not mistake Access-Control-Expose-Headers for an exception header', () => {
    expect(run().r.status).toBe(0);
  });
  it('rejects credentials with newlines (header injection)', () => {
    const { r, log } = run([], { env: { CLICKHOUSE_PASSWORD: 'a\nb' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('newlines');
    expect(log).toEqual([]);
  });
});
