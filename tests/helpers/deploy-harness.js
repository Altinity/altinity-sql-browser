// Scratch tree + shims for the deploy script tests (#692). The scripts are
// copied into a throwaway tree (ROOT derives from their location) with shimmed
// npm/node/curl/clickhouse-client so nothing builds and nothing leaves the box.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const repo = resolve(__dirname, '../..');
const sim = createRequire(import.meta.url)('./deploy-sim.cjs');
export const sha256 = sim.sha;
export const ARTIFACT_BYTES = '<html>asb artifact</html>';

export function makeHarness() {
  const work = mkdtempSync(join(tmpdir(), 'asb-deploy-'));
  for (const d of ['deploy/lib', 'dist', 'build', 'bin']) mkdirSync(join(work, d), { recursive: true });
  for (const f of ['install.sh', 'uninstall.sh', 'http_handlers.xml', 'lib/asb-ch.sh']) copyFileSync(join(repo, 'deploy', f), join(work, 'deploy', f));
  writeFileSync(join(work, 'build/build.mjs'), '');
  writeFileSync(join(work, 'dist/sql.html'), ARTIFACT_BYTES);
  copyFileSync(join(repo, 'tests/helpers/deploy-sim.cjs'), join(work, 'bin/sim.cjs'));
  const shim = (name, body) => {
    const p = join(work, 'bin', name);
    writeFileSync(p, `#!${process.execPath}\n${body}\n`);
    chmodSync(p, 0o755);
  };
  shim('clickhouse-client', `require(${JSON.stringify(join(work, 'bin/sim.cjs'))}).nativeMain(process.argv.slice(2));`);
  shim('curl', `require(${JSON.stringify(join(work, 'bin/sim.cjs'))}).curlMain(process.argv.slice(2));`);
  for (const name of ['npm', 'node']) { // build shims; `node` here is only the build step (the sim shims use an absolute node)
    const p = join(work, 'bin', name);
    writeFileSync(p, `#!/bin/sh\necho ${name} >> "${work}/build.log"\nexit 0\n`);
    chmodSync(p, 0o755);
  }
  const simFile = join(work, 'sim.json');

  function reset(cfg = {}) {
    writeFileSync(simFile, JSON.stringify({ cfg: { nodes: 1, ...cfg }, files: {}, log: [] }));
    rmSync(join(work, 'build.log'), { force: true });
  }
  function state() { return JSON.parse(readFileSync(simFile, 'utf8')); }
  function built() { return existsSync(join(work, 'build.log')) ? readFileSync(join(work, 'build.log'), 'utf8') : ''; }

  function run(script, args, { cfg = {}, env = {}, files = null, input = undefined } = {}) {
    reset(cfg);
    if (files) { const s = state(); s.files = files; writeFileSync(simFile, JSON.stringify(s)); }
    const r = spawnSync('bash', [join(work, 'deploy', script), ...args], {
      env: { ...process.env, ASB_SIM: simFile, CLICKHOUSE_PASSWORD: 'pw', PATH: `${join(work, 'bin')}:${process.env.PATH ?? ''}`, ...env },
      encoding: 'utf8', input,
    });
    const s = state();
    return { r, log: s.log, files: s.files, sqls: s.log.map((l) => l.sql) };
  }
  const install = (args, opts) => run('install.sh', ['--client-id', 'cid', '--ch-host', 'ch.example.com', ...args], opts);
  const uninstall = (args, opts) => run('uninstall.sh', ['--ch-host', 'ch.example.com', ...args], opts);
  return { work, install, uninstall, run, built, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}
