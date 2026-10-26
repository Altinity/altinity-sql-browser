// deploy/uninstall.sh (#692): empties sql.html + sql-config.json on every node
// with the same ON CLUSTER CTAS pattern as the installer, then verifies 0 bytes
// per node. Shared shims: tests/helpers/deploy-harness.js.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { makeHarness, sha256 } from '../helpers/deploy-harness.js';

// each case spawns real bash + shim processes; allow for a loaded CI box
vi.setConfig({ testTimeout: 60000 });

let h;
beforeAll(() => { h = makeHarness(); });
afterAll(() => h.cleanup());

const EMPTY = { len: 0, sha: sha256('') };
const installed = { 'sql.html': { len: 100, sha: 'aa' }, 'sql-config.json': { len: 10, sha: 'bb' } };

describe('uninstall.sh single node', () => {
  it('truncates both live files with INSERT INTO FUNCTION file ... SELECT \'\' (no table, no INSERT grant) and verifies 0 bytes', () => {
    const { r, sqls, files } = h.uninstall([], { files: installed });
    expect(r.status, r.stderr).toBe(0);
    expect(files['sql.html']).toEqual(EMPTY);
    expect(files['sql-config.json']).toEqual(EMPTY);
    expect(sqls.some((s) => /^CREATE TABLE/.test(s))).toBe(false);
    const c = sqls.filter((s) => /^INSERT INTO FUNCTION file\('sql(-config\.json|\.html)'/.test(s));
    expect(c).toHaveLength(2);
    for (const s of c) {
      expect(s).toContain("SELECT '' AS c");
      expect(s).toContain('engine_file_truncate_on_insert=1');
      expect(s).not.toContain('ON CLUSTER');
    }
    expect(r.stdout).toContain('Asset files emptied on 1 node(s)');
    expect(r.stdout).toContain('http_handlers.xml');
    expect(r.stdout).toContain('Single-node mode');
  });
  it('passes --secure and --ddl-timeout to the client', () => {
    const { log } = h.uninstall(['--secure', '--ddl-timeout', '5'], { files: installed });
    expect(log.every((l) => l.argv.includes('--secure') && l.argv.includes('--distributed_ddl_task_timeout=5'))).toBe(true);
  });
});

describe('uninstall.sh cluster', () => {
  const run = (extra = [], opts = {}) => h.uninstall(['--cluster', 'c1', ...extra], { cfg: { nodes: 3 }, files: installed, ...opts });
  it('runs every DDL ON CLUSTER and verifies every node is empty', () => {
    const { r, sqls, files } = run();
    expect(r.status, r.stderr).toBe(0);
    for (const s of sqls.filter((x) => /^(CREATE|DROP)/.test(x))) expect(s).toContain('ON CLUSTER `c1`');
    expect(files['sql.html']).toEqual(EMPTY);
    expect(r.stdout).toMatch(/node-3\s+0\s+e3b0c442[0-9a-f]{56} ok/);
    expect(r.stdout).toContain('emptied on 3 node(s)');
  });
  it('fails when any node still serves bytes', () => {
    const { r } = run([], { cfg: { nodes: 3, badNodes: { 'sql-config.json': { 2: { len: 4, sha: 'cc' } } } } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('some files were not emptied on every node');
    expect(r.stdout).toMatch(/node-2\s+4\s+cc\s+MISMATCH/);
  });
  it('a failing CTAS stops the run and still drops the temp tables', () => {
    const { r, sqls } = run([], { cfg: { nodes: 3, rules: [{ match: '^CREATE TABLE default\\._asb_t_rm_cfg', stderr: 'Code: 1. injected' }] } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('empty sql-config.json failed');
    expect(sqls.slice(-4).every((s) => /^DROP TABLE IF EXISTS default\._asb_t_(rm|next)_/.test(s))).toBe(true);
  });
  it('also empties the _asb_next_* copies (a full copy of the SPA) on every node', () => {
    const { r, sqls, files } = run([], { files: { ...installed, '_asb_next_sql.html': { len: 100, sha: 'aa' }, '_asb_next_sql-config.json': { len: 10, sha: 'bb' } } });
    expect(r.status, r.stderr).toBe(0);
    expect(files['_asb_next_sql.html']).toEqual(EMPTY);
    expect(files['_asb_next_sql-config.json']).toEqual(EMPTY);
    expect(sqls.some((s) => /^CREATE TABLE default\._asb_t_next_html ON CLUSTER `c1` ENGINE=File\('RawBLOB','_asb_next_sql\.html'\) AS SELECT '' AS c/.test(s))).toBe(true);
    expect(r.stdout).toMatch(/node-3\s+0\s+e3b0c442[0-9a-f]{56} ok/);
  });
  it('fails when a stale non-empty _asb_next_* copy survives on a node', () => {
    const { r } = run([], { cfg: { nodes: 3, badNodes: { '_asb_next_sql.html': { 3: { len: 7, sha: 'dd' } } } } });
    expect(r.status).toBe(1);
  });
  it('accepts n=0 rows for the 0-byte check (the only caller allowed to) but not extra/dropped/duplicate rows', () => {
    expect(run([], { cfg: { nodes: 3, verify: { n: { 2: 0 } } } }).r.status).toBe(0);
    expect(run([], { cfg: { nodes: 3, verify: { dropNodes: [3] } } }).r.status).toBe(1);
    expect(run([], { cfg: { nodes: 3, verify: { hostAs: { 3: 1 } } } }).r.status).toBe(1);
  });
  it('fails fast and writes nothing when preflight fails', () => {
    const { r, sqls } = run([], { cfg: { nodes: 3, countOut: 0 } });
    expect(r.status).toBe(1);
    expect(sqls.filter((s) => /^(CREATE|DROP)/.test(s))).toEqual([]);
  });
  it('warns when cleanup drops fail', () => {
    const { r } = run([], { cfg: { nodes: 2, rules: [{ match: '^CREATE TABLE default\\._asb_t_rm_html', stderr: 'x' }, { match: '^DROP TABLE IF EXISTS default\\._asb_t_rm_cfg', stderr: 'x' }] } });
    expect(r.status).toBe(1);
  });
  it.each(["c'; DROP", 'a b'])('rejects cluster name %j', (name) => {
    const { r, log } = h.uninstall(['--cluster', name]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('invalid --cluster name');
    expect(log).toEqual([]);
  });
});

describe('uninstall.sh http transport', () => {
  it('keeps the password out of argv and cleans up the header file', () => {
    const { r, log } = h.uninstall(['--transport', 'http', '--cluster', 'c1'], { cfg: { nodes: 2 }, files: installed, env: { CLICKHOUSE_PASSWORD: 'sekret-pw' } });
    expect(r.status, r.stderr).toBe(0);
    const calls = log.filter((l) => l.tool === 'curl');
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      expect(c.argv.join(' ')).not.toContain('sekret-pw');
      expect(c.authMode).toBe(0o600);
      expect(existsSync(c.authFile)).toBe(false);
    }
  });
  it('detects an exception reported only in the body', () => {
    const { r } = h.uninstall(['--transport', 'http'], { files: installed, cfg: { rules: [{ match: "^INSERT INTO FUNCTION file\\('sql\\.html'", stderr: 'boom', http: 'body' }] } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('boom');
  });
});

describe('uninstall.sh secrets and cleanup', () => {
  it('keeps the password in clickhouse-client only (never argv), pins output mode, removes the header file when cleanup fails', () => {
    const { log: l1 } = h.uninstall([], { files: installed, env: { CLICKHOUSE_PASSWORD: 'sekret-native-pw' } });
    for (const l of l1) { expect(l.argv.join(' ')).not.toContain('sekret-native-pw'); expect(l.pwEnv).toBe('sekret-native-pw'); expect(l.argv).toContain('--distributed_ddl_output_mode=throw'); }
    const { r, log } = h.uninstall(['--transport', 'http'], {
      files: installed,
      cfg: { rules: [{ match: "^INSERT INTO FUNCTION file\\('sql\\.html'", stderr: 'boom' }] },
      env: { CLICKHOUSE_PASSWORD: 'sekret-pw' },
    });
    expect(r.status).toBe(1);
    for (const c of log) {
      expect(c.pwEnv).toBeUndefined();
      expect(c.argv[0]).toBe('-q');
      expect(c.url).toContain('distributed_ddl_output_mode=throw');
      expect(existsSync(c.authFile)).toBe(false);
    }
  });
});

describe('uninstall.sh arguments', () => {
  it.each([
    [[], '--ch-host is required'],
    [['--ch-host', 'x', '--bogus'], 'unknown arg'],
    [['--ch-host'], 'missing value for --ch-host'],
    [['--ch-host', 'x', '--transport', 'ftp'], '--transport must be'],
    [['--ch-host', 'x', '--ddl-timeout', 'z'], '--ddl-timeout must be'],
    [['--ch-host', 'x', '--ddl-timeout', '0'], '--ddl-timeout must be an integer >= 1'],
    [['--ch-host', 'x', '--http-port', 'z'], '--http-port must be'],
  ])('rejects %j', (args, msg) => {
    const { r, log } = h.run('uninstall.sh', args);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(msg);
    expect(log).toEqual([]);
  });
});
