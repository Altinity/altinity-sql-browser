// deploy/install.sh (#692): SQL-only, two-phase install with server-side
// fan-out. The script runs for real in a scratch tree against shimmed
// clickhouse-client/curl that simulate just enough ClickHouse (tests/helpers/
// deploy-sim.cjs) to log every statement, scripted failures, and per-node
// verification rows. Nothing builds and nothing leaves the box.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('creates dist/ itself when running from the release bundle layout (no dist/)', () => {
    copyFileSync(`${h.work}/dist/sql.html`, `${h.work}/sql.html`);
    rmSync(`${h.work}/dist`, { recursive: true, force: true });
    const out = dry('--artifact', `${h.work}/sql.html`);
    expect(out).toContain('connect-src');
    expect(existsSync(`${h.work}/dist/http_handlers.xml`)).toBe(true);
    copyFileSync(`${h.work}/sql.html`, `${h.work}/dist/sql.html`); // restore for later cases
    mkdirSync(`${h.work}/dist`, { recursive: true });
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
    const promote = idx(sqls, /^INSERT INTO FUNCTION file\('sql\.html','RawBLOB'\) .*SELECT c FROM file\('_asb_next_sql\.html'/);
    // no table is created in single-node mode: a CTAS would also need INSERT on it (found by tests/deploy)
    expect(sqls.some((s) => /^CREATE TABLE/.test(s))).toBe(false);
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
    const pre = idx(sqls, /view\(SELECT toString\(serverUUID\(\)\) AS id/);
    const clean = idx(sqls, /^DROP TABLE IF EXISTS default\._asb_t_next_html ON CLUSTER `c1` SYNC/);
    const stage = idx(sqls, /^INSERT INTO FUNCTION file\('_asb_stage_tok123\.html','RawBLOB'\).*FORMAT RawBLOB/);
    const stageVerify = idx(sqls, /SHA256.*_asb_stage_tok123\.html/);
    const next = idx(sqls, /^CREATE TABLE default\._asb_t_next_html ON CLUSTER `c1` ENGINE=File\('RawBLOB','_asb_next_sql\.html'\) AS SELECT c FROM clusterAllReplicas/);
    const emptied = idx(sqls, /^CREATE TABLE default\._asb_t_next_html ON CLUSTER `c1` ENGINE=File\('RawBLOB','_asb_next_sql\.html'\) AS SELECT '' AS c/);
    const v1 = idx(sqls, /SHA256.*_asb_next_sql\.html/);
    const promote = idx(sqls, /ENGINE=File\('RawBLOB','sql\.html'\) AS SELECT c FROM file\('_asb_next_sql\.html'/);
    const v2 = idx(sqls, /SHA256.*FROM file\('sql\.html'/);
    expect([pre, clean, emptied, stage, stageVerify, next, v1, promote, v2].every((i) => i >= 0)).toBe(true);
    expect([pre, clean, emptied, stage, stageVerify, next, v1, promote, v2]).toEqual([pre, clean, emptied, stage, stageVerify, next, v1, promote, v2].slice().sort((a, b) => a - b));
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
    expect(r.stdout).toMatch(/uuid-3\s+node-3\s+\d+\s+[0-9a-f]{64} ok/);
  });

  it('every CTAS truncates on insert; the stage CTAS tolerates a missing file', () => {
    const { sqls } = run();
    const all = ctas(sqls);
    expect(all.length).toBe(6); // 2 pre-clean empties + 2 fan-outs + 2 promotes
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
    expect(r.stdout).toMatch(/uuid-2\s+node-2\s+1\s+dead\s+MISMATCH/);
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

  it('refuses when the preflight sees the same instance (serverUUID) twice', () => {
    const { r, sqls } = h.install(['--cluster', 'c1'], { env: TOKEN, cfg: { nodes: 3, preflightDuplicate: true } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('2 distinct node identities (serverUUID) for 3 nodes');
    expect(writes(sqls)).toEqual([]);
  });

  describe.each([
    ['preflight reachability', /view\(SELECT toString\(serverUUID\(\)\) AS id/, false],
    ['pre-clean', /^DROP TABLE IF EXISTS default\._asb_t_next_html/, true],
    ['stage upload', /FORMAT RawBLOB/, true],
    ['stage verification', /SHA256.*_asb_stage_/, true],
    ['sql.html fan-out', /^CREATE TABLE default\._asb_t_next_html .*clusterAllReplicas/, true],
    ['config fan-out', /^CREATE TABLE default\._asb_t_next_cfg .*SELECT '\{/, true],
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
    // a hung url() is bounded: per-query deadline + HTTP connect/receive timeouts, derived from --ddl-timeout (default 180)
    expect(c).toContain('max_execution_time=180');
    expect(c).toContain('http_receive_timeout=180');
    expect(c).toContain('http_connection_timeout=10');
    expect(c).toContain("it\\'s"); // the URL is SQL-escaped
    expect(sqls.some((s) => /_asb_stage_|FORMAT RawBLOB/.test(s) && !/^DROP/.test(s))).toBe(false);
  });
  it('a pulled file that does not match the local artifact aborts before promoting', () => {
    const { r, sqls } = run({ len: 5, sha: 'beef' });
    expect(r.status).toBe(1);
    expect(sqls.some((s) => live.test(s))).toBe(false);
  });
});

describe('url source timeouts', () => {
  const pull = (extra) => h.install(['--cluster', 'c1', '--pull-url', 'http://x/sql.html', ...extra], { env: TOKEN, cfg: { nodes: 2, urlContent: { len: ARTIFACT_BYTES.length, sha: ART_SHA } } });
  it('derives max_execution_time and the receive timeout from --ddl-timeout', () => {
    const c = pull(['--ddl-timeout', '45']).sqls.find((s) => /FROM url\(/.test(s));
    expect(c).toContain('max_execution_time=45');
    expect(c).toContain('http_receive_timeout=45');
  });
  it('rejects --ddl-timeout 0 (0 means asynchronous DDL in ClickHouse) before contacting ClickHouse', () => {
    const x = pull(['--ddl-timeout', '0']);
    expect(x.r.status).toBe(1);
    expect(x.r.stderr).toContain('--ddl-timeout must be a decimal integer from 1 to 999999');
    expect(x.log).toEqual([]);
  });
});

describe('inputs', () => {
  it('escapes the config JSON in SQL (\\ and \')', () => {
    const { r, sqls, files } = h.install(['--client-id', "it's\\x"], { env: TOKEN });
    const cfg = '{"issuer":"https://accounts.google.com","client_id":"it\'s\\x"}';
    expect(r.status, r.stderr).toBe(0); // verification compares the locally computed sha to what the server wrote
    expect(files['sql-config.json'].sha).toBe(sha256(cfg));
    expect(sqls.find((s) => /^INSERT INTO FUNCTION file\('_asb_next_sql-config\.json'.*it/.test(s))).toContain("it\\'s\\\\x");
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
  describe('test barrier hook (ASB_TEST_BARRIER)', () => {
    const bdir = mkdtempSync(join(tmpdir(), 'asb-barrier-'));
    const cl = ['--cluster', 'c1'];
    const fanout = /^CREATE TABLE default\._asb_t_next_html (?!.*AS SELECT '' AS c)/;   // pre-clean also CTASes the next tables, from an empty SELECT
    const cfg2 = { cfg: { nodes: 2 } };
    it('unset: creates no files and behaves as before', () => {
      const { r } = h.install(cl, { env: TOKEN, ...cfg2 });
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(bdir)).toEqual([]);
    });
    it.each(['relative/b', '/tmp/a b', '/tmp/../x', "/tmp/x'y"])('rejects the invalid path %j', (p) => {
      const { r, log } = h.install(cl, { env: { ...TOKEN, ASB_TEST_BARRIER: p }, ...cfg2 });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('invalid ASB_TEST_BARRIER');
      expect(log).toEqual([]);
    });
    it('rejects an unknown point and a bad timeout', () => {
      const b = join(bdir, 'bad');
      let x = h.install(cl, { env: { ...TOKEN, ASB_TEST_BARRIER: b, ASB_TEST_BARRIER_POINT: 'nope' }, ...cfg2 });
      expect(x.r.status).toBe(1); expect(x.r.stderr).toContain('invalid ASB_TEST_BARRIER_POINT');
      x = h.install(cl, { env: { ...TOKEN, ASB_TEST_BARRIER: b, ASB_TEST_BARRIER_TIMEOUT: 'x' }, ...cfg2 });
      expect(x.r.status).toBe(1); expect(x.r.stderr).toContain('invalid ASB_TEST_BARRIER_TIMEOUT');
    });
    it.each(['x', '0', '09', '10000', '-1'])('rejects the invalid timeout %j', (t) => {
      const b = join(bdir, 'tmo');
      const x = h.install(cl, { env: { ...TOKEN, ASB_TEST_BARRIER: b, ASB_TEST_BARRIER_TIMEOUT: t }, ...cfg2 });
      expect(x.r.status).toBe(1); expect(x.r.stderr).toContain('invalid ASB_TEST_BARRIER_TIMEOUT');
    });
    it('prints a loud stderr WARNING when active and keeps the hook out of child environments', () => {
      const b = join(bdir, 'warn');
      writeFileSync(`${b}.go`, '');
      const x = h.install(cl, { env: { ...TOKEN, ASB_TEST_BARRIER: b, ASB_TEST_BARRIER_POINT: 'pre_promote', ASB_TEST_BARRIER_TIMEOUT: '5' }, ...cfg2 });
      expect(x.r.status, x.r.stderr).toBe(0);
      expect(x.r.stderr).toContain('WARNING: test hook ASB_TEST_BARRIER active');
      expect(h.built()).not.toBe('');
      expect(h.builtEnv()).not.toMatch(/ASB_TEST_BARRIER/);
      expect(h.run('install.sh', ['--client-id', 'cid', '--ch-host', 'x', ...cl], { env: TOKEN, cfg: { nodes: 2 } }).r.stderr).not.toContain('WARNING');
    });
    it.each(['pre_fanout', 'pre_promote'])('%s: marks .reached and proceeds once .go exists', (point) => {
      const b = join(bdir, point);
      writeFileSync(`${b}.go`, '');   // pre-released: proves it proceeds on .go and still marks .reached
      const { r, sqls } = h.install(cl, { env: { ...TOKEN, ASB_TEST_BARRIER: b, ASB_TEST_BARRIER_POINT: point }, ...cfg2 });
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(`${b}.reached`)).toBe(true);
      expect(sqls.some((s) => /^CREATE TABLE default\._asb_t_live_/.test(s))).toBe(true);
    });
    it('waits for .go (released late), and the pre_fanout pause precedes every fan-out write', async () => {
      const b = join(bdir, 'late');
      const p = h.runAsync('install.sh', ['--client-id', 'cid', '--ch-host', 'ch.example.com', ...cl], {
        cfg: { nodes: 2 }, env: { ...TOKEN, ASB_TEST_BARRIER: b }, onSleeping: () => {},
      });
      for (let i = 0; i < 200 && !existsSync(`${b}.reached`); i++) await new Promise((res) => setTimeout(res, 50));
      expect(existsSync(`${b}.reached`)).toBe(true);
      await new Promise((res) => setTimeout(res, 400));
      const mid = h.state().log.map((l) => l.sql);
      expect(mid.some((s) => fanout.test(s))).toBe(false);
      writeFileSync(`${b}.go`, '');
      const x = await p;
      expect(x.status, x.stderr).toBe(0);
    });
    it('fails once the cap passes without .go', () => {
      const b = join(bdir, 'cap');
      const { r, sqls } = h.install(cl, { env: { ...TOKEN, ASB_TEST_BARRIER: b, ASB_TEST_BARRIER_TIMEOUT: '1' }, ...cfg2 });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('not released within 1s');
      expect(existsSync(`${b}.reached`)).toBe(true);
      expect(sqls.some((s) => fanout.test(s))).toBe(false);
    });
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
    [['--ddl-timeout', '0'], '--ddl-timeout must be a decimal integer from 1 to 999999'],
    [['--ddl-timeout', '09'], '--ddl-timeout must be a decimal integer from 1 to 999999'],   // bash would call it a bad octal
    [['--ddl-timeout', '010'], '--ddl-timeout must be a decimal integer from 1 to 999999'],  // ...or 8
    [['--ddl-timeout', '1000000'], '--ddl-timeout must be a decimal integer from 1 to 999999'],
    [['--ddl-timeout', '99999999999999999999999'], '--ddl-timeout must be a decimal integer from 1 to 999999'], // would overflow arithmetic
    [['--ddl-timeout', '-5'], '--ddl-timeout must be a decimal integer from 1 to 999999'],
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
    const { r } = run({ nodes: 2, rules: [{ match: 'view\\(SELECT toString\\(serverUUID\\(\\)\\) AS id', stderr: 'Code: 516. DB::Exception: AUTHENTICATION_FAILED' }] });
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
    }
    expect(r.stdout + r.stderr).not.toContain(PW);
  });
  it('http: client-side --max-time is ddl+300 normally and ddl+10 in cleanup; the cleanup DDL timeout is exactly 30', () => {
    const failPhase1 = { match: "^CREATE TABLE default\\._asb_t_next_cfg .*SELECT '\\{", stderr: 'Code: 1. injected' };
    const { log } = run(['--cluster', 'c1'], { cfg: { nodes: 2, rules: [failPhase1] } });
    const fail = log.findIndex((l) => l.rc !== 0);
    const maxTime = (l) => l.argv[l.argv.indexOf('--max-time') + 1];
    const connect = (l) => l.argv[l.argv.indexOf('--connect-timeout') + 1];
    const main = log.slice(0, fail + 1), clean = log.slice(fail + 1);
    expect(clean.length).toBeGreaterThanOrEqual(5);
    for (const l of main) { expect(l.url).toContain('distributed_ddl_task_timeout=180&'); expect(maxTime(l)).toBe('480'); expect(connect(l)).toBe('30'); }
    for (const l of clean) { expect(l.url).toContain('distributed_ddl_task_timeout=30&'); expect(maxTime(l)).toBe('40'); expect(connect(l)).toBe('10'); }
    // --ddl-timeout below the cap is kept as is
    const small = run(['--cluster', 'c1', '--ddl-timeout', '7'], { cfg: { nodes: 2, rules: [failPhase1] } }).log;
    for (const l of small) { expect(l.url).toContain('distributed_ddl_task_timeout=7&'); }
    expect(maxTime(small[small.length - 1])).toBe('17');
  });
  it('honours --http-port, --ddl-timeout and --secure', () => {
    expect(run(['--http-port', '9999', '--ddl-timeout', '9']).log[0].url).toBe('http://ch.example.com:9999/?wait_end_of_query=1&distributed_ddl_task_timeout=9&distributed_ddl_output_mode=throw');
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
    const { r, sqls, files } = run([], { cfg: { rules: [{ match: "^INSERT INTO FUNCTION file\\('_asb_next_sql-config\\.json'", stderr: 'Code: 60. DB::Exception: boom', http }] } });
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

describe('verification rows are strict (one row, one host, n == 1, per node)', () => {
  const good = { 'sql.html': { len: ARTIFACT_BYTES.length, sha: ART_SHA }, 'sql-config.json': { len: CFG.length, sha: CFG_SHA } };
  const verify = (knob) => h.install(['--cluster', 'c1', '--verify-only'], { cfg: { nodes: 3, verify: knob }, files: good });

  it('control: untouched rows verify', () => {
    expect(verify({}).r.status).toBe(0);
  });
  it('a dropped row fails (fewer rows than nodes, even though every returned row matches)', () => {
    const { r } = verify({ dropNodes: [3] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('rows returned: 2');
  });
  it('an extra row fails', () => {
    const { r } = verify({ extra: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('rows returned: 4');
  });
  it('the same instance (serverUUID) answering twice fails: the row count equals the node count but distinct nodes do not', () => {
    const { r } = verify({ hostAs: { 3: 1 }, uuidAs: { 3: 1 } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('rows returned: 3, distinct nodes: 2');
  });
  it('two instances on one host (same hostName, distinct serverUUID) are distinct nodes and pass', () => {
    const { r } = verify({ hostAs: { 3: 1 } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/uuid-3\s+node-1\s+\d+\s+[0-9a-f]{64} ok/);
  });
  it('a duplicate serverUUID fails even when the hosts differ', () => {
    const { r } = verify({ uuidAs: { 3: 1 } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('rows returned: 3, distinct nodes: 2');
  });
  it('a row with n=0 fails for an install even when len and sha match', () => {
    const { r } = verify({ n: { 2: 0 } });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/uuid-2\s+node-2\s+\d+\s+[0-9a-f]{64} MISMATCH/);
  });
  it('a row with n=2 fails too', () => {
    expect(verify({ n: { 1: 2 } }).r.status).toBe(1);
  });
  it('phase 1 stops on a bad row with the live files untouched', () => {
    const { r, sqls } = h.install(['--cluster', 'c1'], { env: TOKEN, cfg: { nodes: 3, verify: { uuidAs: { 3: 1 } } } });
    expect(r.status).toBe(1);
    expect(sqls.some((s) => live.test(s))).toBe(false);
  });
});

describe('stage MATCH guard', () => {
  it('an uploaded stage that no node reports with the expected sha aborts before the fan-out', () => {
    const { r, sqls } = h.install(['--cluster', 'c1'], { env: TOKEN, cfg: { nodes: 3, badNodes: { '_asb_stage_tok123.html': { 1: { len: 1, sha: 'dead' } } } } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('staged upload not found with the expected length/sha256 on exactly one node');
    expect(sqls.some((s) => /clusterAllReplicas\('c1', file\('_asb_stage_/.test(s))).toBe(false);
    expect(sqls.some((s) => live.test(s))).toBe(false);
    expect(sqls.slice(-5)[0]).toContain("SELECT ''"); // the stage is still emptied
  });
  it('a stage reported on more than one node is not accepted either (exactly one)', () => {
    const good = { len: ARTIFACT_BYTES.length, sha: ART_SHA };
    const { r } = h.install(['--cluster', 'c1'], { env: TOKEN, cfg: { nodes: 3, badNodes: { '_asb_stage_tok123.html': { 1: good, 2: good } } } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('exactly one node');
  });
  it('a stage verification missing a node row aborts', () => {
    const { r, sqls } = h.install(['--cluster', 'c1'], { env: TOKEN, cfg: { nodes: 3, verify: { dropNodes: [3] } } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('stage verification returned 2 rows');
    expect(sqls.some((s) => /^CREATE TABLE default\._asb_t_next_html .*clusterAllReplicas/.test(s))).toBe(false);
  });
});

describe('single node: phase-1 failure never touches the live file', () => {
  it('writes no INSERT INTO FUNCTION file(\'sql.html\' before (or after) a failed phase-1 verify', () => {
    const { r, sqls, files } = h.install([], { env: TOKEN, cfg: { badNodes: { '_asb_next_sql.html': { 1: { len: 1, sha: 'dead' } } } } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('phase 1 verification failed; live files were NOT touched');
    expect(sqls.some((s) => s.startsWith("INSERT INTO FUNCTION file('sql.html'"))).toBe(false);
    expect(sqls.some((s) => s.startsWith("INSERT INTO FUNCTION file('sql-config.json'"))).toBe(false);
    expect(files['sql.html']).toBeUndefined();
  });
});

describe('artifact sanity', () => {
  it('rejects a zero-byte artifact before any write', () => {
    writeFileSync(`${h.work}/empty.html`, '');
    for (const args of [[], ['--cluster', 'c1']]) {
      const { r, sqls } = h.install([...args, '--artifact', `${h.work}/empty.html`], { env: TOKEN, cfg: { nodes: 3 } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('is empty (0 bytes)');
      expect(writes(sqls)).toEqual([]);
    }
  });
  it('without the SPA build entry point (package.json present): the same clear error, no ClickHouse contact', () => {
    renameSync(`${h.work}/build/build.mjs`, `${h.work}/build/build.mjs.off`);
    try {
      const { r, log } = h.install([], { env: TOKEN });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('SPA build entry point is missing');
      expect(r.stderr).toContain('pass --artifact');
      expect(log).toEqual([]);
      expect(h.built()).toBe('');
      expect(h.install(['--artifact', `${h.work}/dist/sql.html`], { env: TOKEN }).r.status).toBe(0);
    } finally { renameSync(`${h.work}/build/build.mjs.off`, `${h.work}/build/build.mjs`); }
  });
  it('without --artifact and without a build tree: a clear error, no ClickHouse contact', () => {
    renameSync(`${h.work}/package.json`, `${h.work}/package.json.off`);
    try {
      const { r, log } = h.install([], { env: TOKEN });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('pass --artifact');
      expect(log).toEqual([]);
      // ...and --artifact still works in the same tree
      expect(h.install(['--artifact', `${h.work}/dist/sql.html`], { env: TOKEN }).r.status).toBe(0);
    } finally { renameSync(`${h.work}/package.json.off`, `${h.work}/package.json`); }
  });
});

describe('distributed_ddl_output_mode is pinned to throw', () => {
  it('native: on every clickhouse-client call', () => {
    const { log } = h.install(['--cluster', 'c1'], { env: TOKEN, cfg: { nodes: 2 } });
    expect(log.length).toBeGreaterThan(10);
    expect(log.every((l) => l.argv.includes('--distributed_ddl_output_mode=throw'))).toBe(true);
  });
  it('http: on every request URL', () => {
    const { log } = h.install(['--transport', 'http', '--cluster', 'c1'], { env: TOKEN, cfg: { nodes: 2 } });
    expect(log.length).toBeGreaterThan(10);
    expect(log.every((l) => l.url.includes('&distributed_ddl_output_mode=throw'))).toBe(true);
  });
});

describe('pre-clean empties the _asb_next_* files on every node, before anything is staged', () => {
  it('cluster', () => {
    const { r, sqls } = h.install(['--cluster', 'c1'], { env: TOKEN, cfg: { nodes: 2 } });
    expect(r.status, r.stderr).toBe(0);
    const emptyHtml = idx(sqls, /^CREATE TABLE default\._asb_t_next_html ON CLUSTER `c1` ENGINE=File\('RawBLOB','_asb_next_sql\.html'\) AS SELECT '' AS c SETTINGS engine_file_truncate_on_insert=1$/);
    const emptyCfg = idx(sqls, /^CREATE TABLE default\._asb_t_next_cfg ON CLUSTER `c1` ENGINE=File\('RawBLOB','_asb_next_sql-config\.json'\) AS SELECT '' AS c SETTINGS engine_file_truncate_on_insert=1$/);
    const stage = idx(sqls, /FORMAT RawBLOB/);
    expect(emptyHtml).toBeGreaterThan(-1);
    expect(emptyCfg).toBeGreaterThan(-1);
    expect(Math.max(emptyHtml, emptyCfg)).toBeLessThan(stage);
  });
  it('a stale next file cannot satisfy phase 1: it is emptied, then re-verified against the new bytes', () => {
    const stale = { len: ARTIFACT_BYTES.length, sha: ART_SHA };
    const { r, sqls, files } = h.install(['--cluster', 'c1'], {
      env: TOKEN, cfg: { nodes: 2 }, files: { '_asb_next_sql.html': stale },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(files['_asb_next_sql.html']).toEqual(stale); // rewritten with the same bytes by THIS run
    const firstEmpty = idx(sqls, /_asb_next_sql\.html'\) AS SELECT '' AS c/);
    const fanOut = idx(sqls, /_asb_next_sql\.html'\) AS SELECT c FROM clusterAllReplicas/);
    expect(firstEmpty).toBeGreaterThan(-1);
    expect(fanOut).toBeGreaterThan(firstEmpty);
  });
  it('single node', () => {
    const { sqls } = h.install([], { env: TOKEN });
    const e = idx(sqls, /^INSERT INTO FUNCTION file\('_asb_next_sql\.html','RawBLOB'\) SETTINGS engine_file_truncate_on_insert=1 SELECT '' AS c/);
    expect(e).toBeGreaterThan(-1);
    expect(e).toBeLessThan(idx(sqls, /FORMAT RawBLOB/));
  });
});

describe('the password stays out of everything but clickhouse-client', () => {
  const PW = 'sekret-native-pw';
  it('native: never in argv; only clickhouse-client has it in its environment; build steps and the OIDC curl do not', () => {
    const { r, log, oidc } = h.install([], { env: { ...TOKEN, CLICKHOUSE_PASSWORD: PW } });
    expect(r.status, r.stderr).toBe(0);
    expect(log.length).toBeGreaterThan(5);
    for (const l of log) {
      expect(l.argv.join(' ')).not.toContain(PW);
      expect(l.pwEnv).toBe(PW); // the env prefix on that one invocation
    }
    expect(h.built()).toMatch(/npm pw=unset/);
    expect(h.built()).toMatch(/node pw=unset/);
    expect(h.built()).not.toContain(PW);
    // the WHOLE environment of each build shim and of the OIDC curl, not just one variable
    expect(h.builtEnv().split('\n').length).toBeGreaterThan(5); // positive control: the dump really happened
    expect(h.builtEnv()).not.toContain(PW);
    expect(oidc.length).toBe(1);
    expect(oidc[0].pwEnv).toBeUndefined();
    expect(Object.keys(oidc[0].env).length).toBeGreaterThan(3);
    expect(JSON.stringify(oidc[0].env)).not.toContain(PW);
  });
  it('http: curl never has it in argv or environment either', () => {
    const { log, oidc } = h.install(['--transport', 'http'], { env: { ...TOKEN, CLICKHOUSE_PASSWORD: PW } });
    expect(log.length).toBeGreaterThan(5);
    for (const l of log) { expect(l.argv.join(' ')).not.toContain(PW); expect(l.pwEnv).toBeUndefined(); }
    expect(oidc[0].pwEnv).toBeUndefined();
    expect(h.builtEnv()).not.toContain(PW);
    expect(JSON.stringify(oidc[0].env)).not.toContain(PW);
  });
});

describe('curl ignores ~/.curlrc', () => {
  it('passes -q first on the OIDC discovery and on every HTTP-transport call', () => {
    const { log, oidc } = h.install(['--transport', 'http'], { env: TOKEN });
    expect(oidc[0].argv[0]).toBe('-q');
    expect(log.every((l) => l.argv[0] === '-q')).toBe(true);
  });
});

describe('cleanup is robust', () => {
  const stageEmpty = "^INSERT INTO FUNCTION file\\('_asb_stage_tok123\\.html','RawBLOB'\\) SETTINGS engine_file_truncate_on_insert=1 SELECT ''$";
  const failPhase1 = { match: "^CREATE TABLE default\\._asb_t_next_cfg .*SELECT '\\{", stderr: 'Code: 1. injected' };

  it('removes the credential header file even when every cleanup statement fails', () => {
    const rules = [failPhase1, { match: stageEmpty, stderr: 'Code: 1. cleanup boom' }];
    const a = h.install(['--transport', 'http', '--cluster', 'c1'], { env: TOKEN, cfg: { nodes: 2, rules } });
    expect(a.r.status).toBe(1);
    expect(a.r.stderr).toContain('could not empty stage file');
    // every DROP fails too (pre-clean dies first, cleanup then fails on every table)
    const b = h.install(['--transport', 'http', '--cluster', 'c1'], { env: TOKEN, cfg: { nodes: 2, rules: [{ match: '^DROP TABLE IF EXISTS default\\._asb_t_live_', stderr: 'Code: 1. cleanup boom' }] } });
    expect(b.r.status).toBe(1);
    expect(b.r.stderr).toContain('could not drop default._asb_t_live_html');
    for (const { log } of [a, b]) {
      const auth = log.filter((l) => l.authFile).map((l) => l.authFile);
      expect(auth.length).toBeGreaterThan(3);
      for (const f of new Set(auth)) expect(existsSync(f)).toBe(false);
      expect(log.some((l) => l.sql.startsWith("INSERT INTO FUNCTION file('sql.html'"))).toBe(false);
    }
  });
  it('bounds cleanup DDL to min(--ddl-timeout, 30) seconds, after a normal-length main run', () => {
    const run = (t) => h.install(['--cluster', 'c1', '--ddl-timeout', t], { env: TOKEN, cfg: { nodes: 2, rules: [failPhase1] } });
    const big = run('100').log;
    const fail = big.findIndex((l) => l.rc !== 0);
    expect(big.slice(0, fail + 1).every((l) => l.argv.includes('--distributed_ddl_task_timeout=100'))).toBe(true);
    expect(big.slice(fail + 1).length).toBeGreaterThanOrEqual(5);
    expect(big.slice(fail + 1).every((l) => l.argv.includes('--distributed_ddl_task_timeout=30'))).toBe(true);
    const small = run('7').log;
    expect(small.every((l) => l.argv.includes('--distributed_ddl_task_timeout=7'))).toBe(true);
  });
  it('native cleanup carries bounded client-side timeouts (main calls carry none)', () => {
    const { log } = h.install(['--cluster', 'c1', '--ddl-timeout', '100'], { env: TOKEN, cfg: { nodes: 2, rules: [failPhase1] } });
    const fail = log.findIndex((l) => l.rc !== 0);
    const clean = log.slice(fail + 1);
    expect(clean.length).toBeGreaterThanOrEqual(5);
    for (const l of log.slice(0, fail + 1)) expect(l.argv.some((a) => /^--(connect|send|receive)_timeout/.test(a))).toBe(false);
    for (const l of clean) {
      expect(l.argv).toContain('--connect_timeout=10');
      expect(l.argv).toContain('--send_timeout=40');
      expect(l.argv).toContain('--receive_timeout=40');
    }
  });
  describe('native cleanup is wrapped in coreutils timeout when available', () => {
    const run = (path) => h.install(['--cluster', 'c1', '--ddl-timeout', '100'], { env: { ...TOKEN, PATH: path }, cfg: { nodes: 2, rules: [failPhase1] } });
    it('wraps cleanup calls (ddl 30 + slack 10 = 40 s) but not main calls', () => {
      const tlog = join(h.work, 'timeout.log');
      rmSync(tlog, { force: true });
      const shim = join(h.work, 'tbin'); mkdirSync(shim, { recursive: true });
      writeFileSync(join(shim, 'timeout'), `#!/bin/sh\necho "$1 $2" >> "${tlog}"\nshift\nexec "$@"\n`);
      chmodSync(join(shim, 'timeout'), 0o755);
      const { log } = run(`${shim}:${join(h.work, 'bin')}:${process.env.PATH}`);
      const calls = readFileSync(tlog, 'utf8').trim().split('\n');
      const fail = log.findIndex((l) => l.rc !== 0);
      expect(calls.length).toBe(log.length - fail - 1);
      expect(calls.length).toBeGreaterThanOrEqual(5);
      expect(new Set(calls.map((c) => c.split(' ')[0]))).toEqual(new Set(['40']));
      expect(calls.every((c) => c.split(' ')[1] === 'clickhouse-client' || c.endsWith('clickhouse-client'))).toBe(true);
    });
    it('falls back to the idle client timeouts alone when timeout is not installed', () => {
      // a PATH holding every system tool except timeout/gtimeout
      const only = join(h.work, 'nobin'); mkdirSync(only, { recursive: true });
      for (const d of (process.env.PATH ?? '').split(':')) {
        if (!d || !existsSync(d)) continue;
        for (const f of readdirSync(d)) {
          if (f === 'timeout' || f === 'gtimeout' || existsSync(join(only, f))) continue;
          try { symlinkSync(join(d, f), join(only, f)); } catch { /* ignore */ }
        }
      }
      const { r, log } = run(`${join(h.work, 'bin')}:${only}`);
      expect(r.status).toBe(1);
      const fail = log.findIndex((l) => l.rc !== 0);
      const clean = log.slice(fail + 1);
      expect(clean.length).toBeGreaterThanOrEqual(5);
      for (const l of clean) expect(l.argv).toContain('--receive_timeout=40');
      expect(r.stderr).not.toMatch(/timeout: /);
    });
  });
  it('a SIGINT that lands while a cleanup statement is running is ignored: cleanup completes and the temp dir is removed', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'asb-sigint-'));
    try {
      const rules = [failPhase1, { match: stageEmpty, delayMs: 1500 }];
      const x = await h.runAsync('install.sh', ['--client-id', 'cid', '--ch-host', 'ch.example.com', '--cluster', 'c1'], {
        cfg: { nodes: 2, rules }, env: { ...TOKEN, TMPDIR: tmpRoot },
        onSleeping: (pid) => process.kill(pid, 'SIGINT'),
      });
      expect(x.status).toBe(1);                      // the original failure, not 130 and not a signal death
      expect(x.signal).toBeNull();
      expect(x.stdout).toContain('==> Cleanup');
      const after = x.sqls.slice(x.sqls.findIndex((q) => new RegExp(stageEmpty).test(q)) + 1);
      for (const t of ['next_html', 'next_cfg', 'live_html', 'live_cfg']) {
        expect(after.some((q) => q.startsWith(`DROP TABLE IF EXISTS default._asb_t_${t} ON CLUSTER`)), t).toBe(true);
      }
      expect(readdirSync(tmpRoot)).toEqual([]);      // $TMP (credentials) gone
    } finally { rmSync(tmpRoot, { recursive: true, force: true }); }
  });
  it('ignores INT/TERM while cleaning up and always removes the temp dir', () => {
    const src = readFileSync(`${h.work}/deploy/install.sh`, 'utf8');
    expect(src).toMatch(/cleanup\(\) \{[^}]*trap '' INT TERM[^}]*set \+e/s);
    expect(src).toMatch(/rm -rf "\$TMP"/);
  });
});

describe('shims', () => {
  it('are /bin/sh scripts that exec the quoted node binary on the sim', () => {
    const t = readFileSync(`${h.work}/bin/clickhouse-client`, 'utf8');
    expect(t.startsWith('#!/bin/sh\n')).toBe(true);
    expect(t).toContain(`exec "${process.execPath}" "${h.work}/bin/sim.cjs" ch "$@"`);
  });
});
