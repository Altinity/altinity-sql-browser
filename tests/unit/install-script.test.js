// deploy/install.sh --dry-run prints the post-install next steps (#692). The
// script is copied into a scratch tree (ROOT is derived from its location) and
// run with shimmed npm/node/curl so nothing is built and nothing leaves the box.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const [name, code] of [['npm', 0], ['node', 0], ['curl', 22]]) {
    const p = join(work, 'bin', name);
    writeFileSync(p, `#!/bin/sh\nexit ${code}\n`);
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
