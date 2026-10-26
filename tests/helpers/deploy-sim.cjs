// A tiny ClickHouse simulator behind shimmed `clickhouse-client` and `curl`
// binaries, for deploy/install.sh and deploy/uninstall.sh unit tests (#692).
// State + config live in the JSON file named by $ASB_SIM:
//   cfg:  { nodes, countOut?, preflightRows?, rules?: [...], urlContent?, badNodes?, verify? }
//   verify (verification-row knobs, all optional):
//     dropNodes: [i]   -- omit node i's row           hostAs: { i: j } -- node i's row reports host node-j
//     extra: true      -- append a (nodes+1)th row    n: { i: k }      -- node i's row reports count() = k
//     portAs: { i: p } -- node i's row reports tcpPort() = p (default 9000); a row id is "node-<host>:<port>"
//   rule: { match: <regex source tested against the SQL>, stderr?, code?, times?,
//           http?: 'status'|'header'|'body' }    -- first live rule wins; `times` counts down
//   rule with delayMs: not a failure; the matching statement first sleeps delayMs (writing
//           "$ASB_SIM.sleeping" when it starts, so a test can signal the script mid-statement), then runs normally
//   files: { <user_files name>: { len, sha } }     -- node-agnostic file state
//   log:   [ { tool, sql, stdinBytes, ... } ]
const fs = require('node:fs');
const crypto = require('node:crypto');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const EMPTY = { len: 0, sha: sha('') };
const load = () => JSON.parse(fs.readFileSync(process.env.ASB_SIM, 'utf8'));
const save = (s) => fs.writeFileSync(process.env.ASB_SIM, JSON.stringify(s));
const unescapeLit = (s) => s.replace(/\\(.)/g, '$1');

function rows(state, name, cluster) {
  const n = cluster ? state.cfg.nodes : 1;
  const out = [];
  for (let i = 1; i <= n; i++) {
    let f = state.files[name] || EMPTY;
    if (name.startsWith('_asb_stage_') && i > 1) f = EMPTY; // the stage lives on the connected node only
    const bad = ((state.cfg.badNodes || {})[name] || {})[i];
    if (bad) f = bad;
    const k = state.cfg.verify || {};
    if ((k.dropNodes || []).includes(i)) continue;
    const host = (k.hostAs || {})[i] || i;
    const cnt = (k.n || {})[i] !== undefined ? k.n[i] : 1;
    const port = (k.portAs || {})[i] || 9000;
    out.push(`node-${host}:${port}\t${cnt}\t${f.len}\t${f.sha}`);
  }
  if (cluster && (state.cfg.verify || {}).extra) out.push(`node-${n + 1}:9000\t1\t${(state.files[name] || EMPTY).len}\t${(state.files[name] || EMPTY).sha}`);
  return out.join('\n');
}

// returns { stdout, stderr, code, rule }
function handle(sql, stdin, state) {
  for (const rule of state.cfg.rules || []) {
    if (rule.times === 0) continue;
    if (new RegExp(rule.match).test(sql)) {
      if (rule.times) rule.times--;
      if (rule.delayMs) {
        fs.writeFileSync(process.env.ASB_SIM + '.sleeping', String(process.pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, rule.delayMs);
        break;
      }
      return { stdout: '', stderr: rule.stderr || 'Code: 1. boom', code: rule.code || 1, rule };
    }
  }
  const files = state.files;
  const cluster = /ON CLUSTER|clusterAllReplicas/.test(sql);
  let m;
  if (/FROM system\.clusters/.test(sql)) return ok(state.cfg.countOut !== undefined ? String(state.cfg.countOut) : String(state.cfg.nodes));
  if (/view\(SELECT concat\(hostName\(\)/.test(sql) && !/SHA256/.test(sql)) {
    const r = state.cfg.preflightRows !== undefined ? state.cfg.preflightRows : state.cfg.nodes;
    const dup = state.cfg.preflightDuplicate; // a cluster definition repeating one instance
    return ok(Array.from({ length: r }, (_, i) => `node-${dup && i === r - 1 ? 1 : i + 1}:9000`).join('\n'));
  }
  if (/SHA256\(any\(c\)\)/.test(sql)) {
    m = /FROM file\('([^']+)'/.exec(sql);
    return ok(rows(state, m[1], /clusterAllReplicas/.test(sql)));
  }
  if ((m = /^INSERT INTO FUNCTION file\('([^']+)'.*FORMAT RawBLOB/.exec(sql))) { files[m[1]] = { len: stdin.length, sha: sha(stdin) }; return ok(''); }
  if ((m = /^INSERT INTO FUNCTION file\('([^']+)'.*SELECT ''$/.exec(sql))) { files[m[1]] = EMPTY; return ok(''); }
  if (/^DROP TABLE/.test(sql)) return ok('');
  // CTAS fan-out (cluster) and INSERT INTO FUNCTION file ... SELECT (single node) share one body grammar.
  const write = (target, body) => {
    let src;
    if ((src = /^SELECT '((?:[^'\\]|\\.)*)'( AS c)?/.exec(body))) { const b = Buffer.from(unescapeLit(src[1])); files[target] = { len: b.length, sha: sha(b) }; }
    else if ((src = /file\('([^']+)'/.exec(body))) files[target] = files[src[1]] || EMPTY;
    else if (/FROM url\(/.test(body)) files[target] = state.cfg.urlContent || EMPTY;
    else return { stdout: '', stderr: 'sim: unhandled body ' + sql, code: 99 };
    return ok(cluster ? 'node-1\t0\t\t0\t0' : '');
  };
  if ((m = /^CREATE TABLE \S+( ON CLUSTER `[^`]+`)? ENGINE=File\('RawBLOB','([^']+)'\) AS (.*)$/.exec(sql))) return write(m[2], m[3]);
  if ((m = /^INSERT INTO FUNCTION file\('([^']+)','RawBLOB'\) SETTINGS engine_file_truncate_on_insert=1 (SELECT .*)$/.exec(sql))) return write(m[1], m[2]);
  return { stdout: '', stderr: 'sim: unhandled query ' + sql, code: 99 };
}
const ok = (stdout) => ({ stdout, stderr: '', code: 0 });

function run(tool, sql, stdin, extra) {
  const state = load();
  const res = handle(sql, stdin, state);
  state.log.push({ tool, sql, stdinBytes: stdin.length, rc: res.code, pwEnv: process.env.CLICKHOUSE_PASSWORD, ...extra });
  save(state);
  return res;
}

function nativeMain(argv) {
  const q = argv.indexOf('--query');
  const stdin = fs.readFileSync(0);
  const res = run('ch', argv[q + 1], stdin, { argv });
  process.stdout.write(res.stdout ? res.stdout + '\n' : '');
  process.stderr.write(res.stderr);
  process.exit(res.code);
}

function curlMain(argv) {
  const arg = (flag) => argv[argv.indexOf(flag) + 1];
  const url = argv[argv.length - 1];
  if (url.includes('.well-known')) { // OIDC discovery: offline; recorded apart from the ClickHouse statements
    const st = load();
    (st.oidc = st.oidc || []).push({ argv, pwEnv: process.env.CLICKHOUSE_PASSWORD, env: process.env });
    save(st);
    process.exit(22);
  }
  const out = arg('-o'), hdrOut = arg('-D');
  const hFile = arg('-H') && argv.filter((a, i) => argv[i - 1] === '-H' && a.startsWith('@'))[0].slice(1);
  const bodyFile = arg('--data-binary').slice(1);
  const body = fs.readFileSync(bodyFile);
  const nl = body.indexOf(10);
  const isUpload = /FORMAT RawBLOB/.test(body.toString('utf8', 0, nl < 0 ? body.length : nl));
  const sql = isUpload ? body.toString('utf8', 0, nl) : body.toString('utf8');
  const data = isUpload ? body.subarray(nl + 1) : Buffer.alloc(0);
  const res = run('curl', sql, data, {
    argv, url, authFile: hFile, authContent: fs.readFileSync(hFile, 'utf8'), authMode: fs.statSync(hFile).mode & 0o777,
  });
  let status = 200, hdrs = 'Access-Control-Expose-Headers: X-ClickHouse-Exception-Code\r\n', text = res.stdout ? res.stdout + '\n' : '';
  if (res.code !== 0) {
    const mode = (res.rule && res.rule.http) || 'status';
    if (mode === 'status') { status = 500; text = res.stderr; }
    else if (mode === 'header') { hdrs += 'X-ClickHouse-Exception-Code: 60\r\n'; text = res.stderr; }
    else { text = 'partial\n__exception__\r\ntag\r\n' + res.stderr; }
  }
  fs.writeFileSync(out, text);
  fs.writeFileSync(hdrOut, `HTTP/1.1 ${status} X\r\n${hdrs}\r\n`);
  process.stdout.write(String(status));
}

module.exports = { nativeMain, curlMain, sha };

// Shim entry point: `node deploy-sim.cjs ch|curl ARGS...` (see deploy-harness.js).
if (require.main === module) {
  const [which, ...rest] = process.argv.slice(2);
  (which === 'ch' ? nativeMain : curlMain)(rest);
}
