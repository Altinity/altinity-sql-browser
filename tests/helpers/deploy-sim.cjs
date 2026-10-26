// A tiny ClickHouse simulator behind shimmed `clickhouse-client` and `curl`
// binaries, for deploy/install.sh and deploy/uninstall.sh unit tests (#692).
// State + config live in the JSON file named by $ASB_SIM:
//   cfg:  { nodes, countOut?, preflightRows?, rules?: [...], urlContent?, badNodes? }
//   rule: { match: <regex source tested against the SQL>, stderr?, code?, times?,
//           http?: 'status'|'header'|'body' }    -- first live rule wins; `times` counts down
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
    out.push(`node-${i}\t1\t${f.len}\t${f.sha}`);
  }
  return out.join('\n');
}

// returns { stdout, stderr, code, rule }
function handle(sql, stdin, state) {
  for (const rule of state.cfg.rules || []) {
    if (rule.times === 0) continue;
    if (new RegExp(rule.match).test(sql)) {
      if (rule.times) rule.times--;
      return { stdout: '', stderr: rule.stderr || 'Code: 1. boom', code: rule.code || 1, rule };
    }
  }
  const files = state.files;
  const cluster = /ON CLUSTER|clusterAllReplicas/.test(sql);
  let m;
  if (/FROM system\.clusters/.test(sql)) return ok(state.cfg.countOut !== undefined ? String(state.cfg.countOut) : String(state.cfg.nodes));
  if (/view\(SELECT hostName\(\)\)/.test(sql) && !/SHA256/.test(sql)) {
    const r = state.cfg.preflightRows !== undefined ? state.cfg.preflightRows : state.cfg.nodes;
    return ok(Array.from({ length: r }, (_, i) => `node-${i + 1}`).join('\n'));
  }
  if (/SHA256\(any\(c\)\)/.test(sql)) {
    m = /FROM file\('([^']+)'/.exec(sql);
    return ok(rows(state, m[1], /clusterAllReplicas/.test(sql)));
  }
  if ((m = /^INSERT INTO FUNCTION file\('([^']+)'.*FORMAT RawBLOB/.exec(sql))) { files[m[1]] = { len: stdin.length, sha: sha(stdin) }; return ok(''); }
  if ((m = /^INSERT INTO FUNCTION file\('([^']+)'.*SELECT ''$/.exec(sql))) { files[m[1]] = EMPTY; return ok(''); }
  if (/^DROP TABLE/.test(sql)) return ok('');
  if ((m = /^CREATE TABLE \S+( ON CLUSTER `[^`]+`)? ENGINE=File\('RawBLOB','([^']+)'\) AS (.*)$/.exec(sql))) {
    const target = m[2], body = m[3];
    let src;
    if ((src = /^SELECT '((?:[^'\\]|\\.)*)' AS c/.exec(body))) files[target] = (() => { const b = Buffer.from(unescapeLit(src[1])); return { len: b.length, sha: sha(b) }; })();
    else if ((src = /file\('([^']+)'/.exec(body))) files[target] = files[src[1]] || EMPTY;
    else if (/FROM url\(/.test(body)) files[target] = state.cfg.urlContent || EMPTY;
    else return { stdout: '', stderr: 'sim: unhandled CTAS ' + sql, code: 99 };
    return ok(cluster ? 'node-1\t0\t\t0\t0' : '');
  }
  return { stdout: '', stderr: 'sim: unhandled query ' + sql, code: 99 };
}
const ok = (stdout) => ({ stdout, stderr: '', code: 0 });

function run(tool, sql, stdin, extra) {
  const state = load();
  const res = handle(sql, stdin, state);
  state.log.push({ tool, sql, stdinBytes: stdin.length, rc: res.code, ...extra });
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
  if (url.includes('.well-known')) process.exit(22); // OIDC discovery: offline
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
