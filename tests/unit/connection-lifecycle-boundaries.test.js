// Mechanical connection-authority/status contracts (#512 Phase 1). The
// runtime tests prove behavior; this Node-tooling spec makes the architectural
// prohibition and narrow-phone visibility difficult to accidentally bypass.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(join(repoRoot, file), 'utf8');
const sourceFiles = (path) => statSync(path).isFile()
  ? [path]
  : readdirSync(path).flatMap((entry) => sourceFiles(join(path, entry)));

describe('connection lifecycle architecture', () => {
  it('never infers lifecycle/readiness from serverVersion in authority or projection modules', () => {
    const authorityFiles = [
      'src/core/connection-lifecycle.ts',
      'src/application/connection-session.ts',
      'src/net/ch-client.ts',
      'src/ui/app-header.ts',
      'src/ui/shell/shell-host.ts',
  'src/ui/shell/shell-view.ts',
    ];
    const violations = authorityFiles.filter((file) => /\bserverVersion\b/.test(read(file)));
    expect(violations).toEqual([]);
  });

  it('keeps connection-chip rendering exclusive to the lifecycle projector and header', () => {
    const owners = new Set([
      'src/core/connection-lifecycle.ts',
      'src/ui/app-header.ts',
      'src/ui/app.types.ts',
    ]);
    const projectionPattern =
      /\bconnStatus\b|conn-status|connection-(?:state|chip)|data-connection-state|\bconnectionLifecyclePresentation\b/;
    const violations = sourceFiles(join(repoRoot, 'src'))
      .map((file) => file.slice(repoRoot.length + 1))
      .filter((file) => /\.(?:ts|tsx|js|mjs)$/.test(file))
      .filter((file) => !owners.has(file))
      .filter((file) => projectionPattern.test(read(file)));
    expect(violations).toEqual([]);
  });

  it('does not hide the authoritative connection chip at the narrow-phone breakpoint', () => {
    const css = read('src/styles.css');
    expect(css).not.toMatch(/\.connection-chip\s*\{\s*display:\s*none\s*;\s*\}/);
  });

  it('keeps in-place authentication recovery out of the mounted workspace layout', () => {
    const css = read('src/styles.css');
    const authHost = /\.auth-host\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] || '';
    expect(authHost).toMatch(/position:\s*fixed/);
    expect(authHost).toMatch(/inset:\s*0/);
    expect(authHost).toMatch(/z-index:\s*120/);
    expect(authHost).toMatch(/background:\s*var\(--scrim\)/);
    expect(authHost).not.toMatch(/max-height/);
  });
});
