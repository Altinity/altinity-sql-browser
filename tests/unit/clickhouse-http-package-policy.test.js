// Issue #630 Phase 2 — dependency-boundary + manifest/lockfile POLICY gate
// for the first npm workspace, `@altinity/clickhouse-http`. This mirrors (and
// double-checks inside the coverage-gated unit suite, per CLAUDE.md's
// `ignore-scripts=true` footgun) the `build/check-boundaries.mjs` Rules
// A–D and the manifest/lockfile/build-graph invariants from the Phase 2
// plan §14/§24/§31. An INDEPENDENTLY implemented scanner, same accepted-risk
// convention as `tests/unit/dashboard-boundaries.test.js`'s own mirror: the
// two can drift, so a "drift bind" test at the end greps
// `build/check-boundaries.mjs`'s own source to confirm each production rule
// this file mirrors still exists.
//
// Issue #630 Phase 3 — extends this same file with the narrow legacy-owner
// ownership check (plan §14): the former production owners of the moved
// progress-stream/exception-parsing primitives
// (`src/net/clickhouse-http-transport.ts`, `src/net/clickhouse-transport.
// types.ts`, `src/core/stream.ts`) must not regain
// `streamLines`/`StreamCallbacks`/`StreamLine`/`splitBuffer`/
// `parseExceptionText`/`ExceptionFrame`/`findExceptionFrame`. Same
// independent-scanner convention as the Phase 2 rules above — this file's
// own `stripComments`/word-boundary logic is a fresh reimplementation, not an
// import of `build/check-boundaries.mjs`'s own copy — and the drift-binding
// describe block at the bottom is extended to cover this rule too.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../../build/build.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;
const PACKAGE_DIR = join(repoRoot, 'packages/clickhouse-http');
const PACKAGE_SRC_DIR = join(PACKAGE_DIR, 'src');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

// Same four-pattern specifier scan as build/check-boundaries.mjs's own
// `extractSpecifiers` (static import/export-from, bare side-effect import,
// dynamic import) — independently implemented, not imported (importing the
// production script would run its whole top-level check-and-exit routine
// inside this test process).
const SPECIFIER_PATTERNS = [
  /\bimport\s+[\w*{}\s,]+\s+from\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[\w*{}\s,]+\s+from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
];

function extractSpecifiers(source) {
  const specs = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) specs.push(match[1]);
  }
  return specs;
}

function resolveRelative(fromFile, spec) {
  const resolved = resolve(dirname(fromFile), spec);
  const noExt = resolved.replace(/\.(ts|tsx|js|mjs)$/, '');
  const candidates = [
    resolved, `${noExt}.ts`, `${noExt}.tsx`, `${noExt}.js`, `${noExt}.mjs`,
    join(resolved, 'index.ts'), join(resolved, 'index.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? resolved;
}

/** `virtualFiles` are `[repoRelativePath, source]` pairs checked alongside
 *  real files on disk — a sabotage probe never writes into the working tree
 *  (matches dashboard-boundaries.test.js's own virtual-file convention). */
function collectEntries(dir, virtualFiles = []) {
  return [
    ...collectFiles(dir).map((file) => [file, undefined]),
    ...virtualFiles.map(([rel, source]) => [join(repoRoot, rel), source]),
  ];
}

// Rule A/C mirror: relative specifiers resolving into a forbidden directory.
function relativeViolations(dir, forbidden, virtualFiles = []) {
  const found = [];
  for (const [file, source] of collectEntries(dir, virtualFiles)) {
    const text = source ?? readFileSync(file, 'utf8');
    for (const spec of extractSpecifiers(text)) {
      if (!spec.startsWith('.')) continue;
      const resolved = resolveRelative(file, spec);
      const relResolved = relative(repoRoot, resolved).split(sep).join('/');
      const hit = forbidden.find((f) => relResolved === f || relResolved.startsWith(`${f}/`));
      if (hit) found.push(`${relative(repoRoot, file).split(sep).join('/')} → ${spec} (resolved: ${relResolved})`);
    }
  }
  return found;
}

// Rule B mirror: every non-relative specifier in package source is a
// violation (empty bare-specifier allowlist) — this also naturally catches
// a browser-root-literal import like `/src/net/ch-client.js`, which is not
// a relative specifier either.
function bareSpecifierViolations(dir, virtualFiles = []) {
  const found = [];
  for (const [file, source] of collectEntries(dir, virtualFiles)) {
    const text = source ?? readFileSync(file, 'utf8');
    for (const spec of extractSpecifiers(text)) {
      if (spec.startsWith('.')) continue;
      found.push(`${relative(repoRoot, file).split(sep).join('/')} → ${spec}`);
    }
  }
  return found;
}

// Rule D mirror: the exact bare package name may be imported only under
// src/net/**; the deep-import subpath form is forbidden everywhere.
const CLICKHOUSE_HTTP_SPECIFIER = '@altinity/clickhouse-http';
function bareLocationViolations(dir, virtualFiles = []) {
  const found = [];
  for (const [file, source] of collectEntries(dir, virtualFiles)) {
    const relFile = relative(repoRoot, file).split(sep).join('/');
    const text = source ?? readFileSync(file, 'utf8');
    for (const spec of extractSpecifiers(text)) {
      if (spec === CLICKHOUSE_HTTP_SPECIFIER) {
        if (!relFile.startsWith('src/net/')) found.push(`${relFile} → ${spec}`);
        continue;
      }
      if (spec.startsWith(`${CLICKHOUSE_HTTP_SPECIFIER}/`)) found.push(`${relFile} → ${spec}`);
    }
  }
  return found;
}

describe('root workspace/manifest declares the clickhouse-http package (issue #630 Phase 2)', () => {
  const rootPkg = readJson(join(repoRoot, 'package.json'));
  const pkgPkg = readJson(join(PACKAGE_DIR, 'package.json'));

  it('declares packages/clickhouse-http in root workspaces', () => {
    expect(rootPkg.workspaces).toContain('packages/clickhouse-http');
  });

  it('declares a root dependency on @altinity/clickhouse-http', () => {
    expect(rootPkg.dependencies).toHaveProperty('@altinity/clickhouse-http');
  });

  it('the root dependency version and the workspace manifest version agree', () => {
    expect(rootPkg.dependencies['@altinity/clickhouse-http']).toBe(pkgPkg.version);
  });

  it('the workspace package is private', () => {
    expect(pkgPkg.private).toBe(true);
  });

  it('the workspace package manifest declares zero runtime dependencies', () => {
    expect(pkgPkg.dependencies ?? {}).toEqual({});
  });

  it('the workspace package exports only "."', () => {
    expect(Object.keys(pkgPkg.exports)).toEqual(['.']);
  });

  it('the workspace package exposes no internal/deep export subpath', () => {
    const exportKeys = Object.keys(pkgPkg.exports);
    expect(exportKeys.some((k) => k !== '.')).toBe(false);
  });

  it('the committed lockfile represents the workspace package, linked (not registry-resolved)', () => {
    const lock = readJson(join(repoRoot, 'package-lock.json'));
    const workspaceEntry = lock.packages['packages/clickhouse-http'];
    expect(workspaceEntry).toBeDefined();
    expect(workspaceEntry.name).toBe('@altinity/clickhouse-http');
    const linkEntry = lock.packages['node_modules/@altinity/clickhouse-http'];
    expect(linkEntry).toBeDefined();
    expect(linkEntry.link).toBe(true);
    expect(linkEntry.resolved).toBe('packages/clickhouse-http');
  });
});

describe('Rule A — package source imports no SQL Browser src/** (relative)', () => {
  it('the real packages/clickhouse-http/src/** tree is clean', () => {
    expect(relativeViolations(PACKAGE_SRC_DIR, ['src'])).toEqual([]);
  });

  it('flags a relative import reaching into src/application (sabotage probe, not written to disk)', () => {
    const found = relativeViolations(PACKAGE_SRC_DIR, ['src'], [
      ['packages/clickhouse-http/src/__boundary_probe_630__.ts',
        "import { nothing } from '../../../src/application/does-not-exist.js';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630__') && line.includes('src/application'))).toBe(true);
  });
});

describe('Rule B — package source has zero bare specifiers (empty allowlist)', () => {
  it('the real packages/clickhouse-http/src/** tree has no bare/side-effect/dynamic bare import', () => {
    expect(bareSpecifierViolations(PACKAGE_SRC_DIR)).toEqual([]);
  });

  // The @preact/signals-core sabotage specifically proves the zero-runtime-
  // dependency rule is not defeated by root dependency hoisting: root
  // installs this package for its OWN production use, so TypeScript/esbuild
  // could resolve it from package source even though the package manifest
  // itself declares no dependency on it.
  it('flags an import of a real root-hoisted dependency (@preact/signals-core) that the package never declared', () => {
    const found = bareSpecifierViolations(PACKAGE_SRC_DIR, [
      ['packages/clickhouse-http/src/__boundary_probe_630_hoisted__.ts',
        "import { signal } from '@preact/signals-core';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_hoisted__') && line.includes('@preact/signals-core'))).toBe(true);
  });

  it('flags a browser-root-literal import reaching back into SQL Browser source', () => {
    const found = bareSpecifierViolations(PACKAGE_SRC_DIR, [
      ['packages/clickhouse-http/src/__boundary_probe_630_literal__.ts',
        "import { authedFetch } from '/src/net/ch-client.js';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_literal__') && line.includes('/src/net/ch-client.js'))).toBe(true);
  });
});

describe('Rule C — SQL Browser source does not deep-import the package\'s own src/** (relative)', () => {
  it('the real src/** tree is clean', () => {
    expect(relativeViolations(join(repoRoot, 'src'), ['packages/clickhouse-http/src'])).toEqual([]);
  });

  it('flags a relative deep import into the package implementation (sabotage probe, not written to disk)', () => {
    const found = relativeViolations(join(repoRoot, 'src'), ['packages/clickhouse-http/src'], [
      ['src/net/__boundary_probe_630_deep__.ts',
        "import { chUrl } from '../../packages/clickhouse-http/src/client.js';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_deep__') && line.includes('packages/clickhouse-http/src'))).toBe(true);
  });
});

describe('Rule D — the bare package import is restricted to src/net/**; deep-import subpaths are forbidden everywhere', () => {
  it('the real src/** tree only imports @altinity/clickhouse-http under src/net/**, with no deep-import subpath', () => {
    expect(bareLocationViolations(join(repoRoot, 'src'))).toEqual([]);
  });

  it('flags a bare package import from outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = bareLocationViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_core__.ts',
        "import { chUrl } from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_core__'))).toBe(true);
  });

  it('flags a deep-import subpath of the package from anywhere under src/** (sabotage probe, not written to disk)', () => {
    const found = bareLocationViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630_deepbare__.ts',
        "import { createClickHouseHttpClient } from '@altinity/clickhouse-http/src/client';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_deepbare__'))).toBe(true);
  });
});

describe('A5 — chUrl() has exactly one implementation, owned by the package', () => {
  it('the package src/url.ts declares chUrl()', () => {
    const text = readFileSync(join(PACKAGE_SRC_DIR, 'url.ts'), 'utf8');
    expect(/export function chUrl\(/.test(text)).toBe(true);
  });

  it('root src/** no longer declares a chUrl() implementation', () => {
    const offenders = [];
    for (const file of collectFiles(join(repoRoot, 'src'))) {
      const text = readFileSync(file, 'utf8');
      if (/function chUrl\(/.test(text)) offenders.push(relative(repoRoot, file).split(sep).join('/'));
    }
    expect(offenders).toEqual([]);
  });

  it('src/net/ch-client.ts re-exports the package chUrl rather than redeclaring it', () => {
    const text = readFileSync(join(repoRoot, 'src/net/ch-client.ts'), 'utf8');
    // #630 Phase 3 widened this single import/export declaration to also
    // carry streamLines/parseExceptionText/findExceptionFrame — so `chUrl`
    // is one of several named imports/exports rather than the sole name
    // inside the braces; match it as a member of a comma-separated list
    // rather than requiring it alone.
    expect(/import\s*\{[^}]*\bchUrl\b[^}]*\}\s*from\s*['"]@altinity\/clickhouse-http['"]/.test(text)).toBe(true);
    expect(/export\s*\{[^}]*\bchUrl\b[^}]*\}/.test(text)).toBe(true);
  });
});

// Issue #630 Phase 3 — independent reimplementation of the narrow
// legacy-owner rule (comments stripped, then a bare word-boundary check per
// forbidden identifier — see build/check-boundaries.mjs's own comment for
// why `applyStreamLine` can never false-positive against `StreamLine`). A
// hand-rolled lexical scanner, not a regex — see the production checker's
// own comment for why a naive `/\*[\s\S]*?\*\/|\/\/.*/` alternation is
// fooled by `/*`/`*/`/`//` substrings that only look like comment
// delimiters because they sit inside a string or template literal (e.g.
// `const marker = "/*"; export interface StreamLine {} const end = "*/";`
// or `const u = "https://example"; export function streamLines() {}`).
// This mirror must stay lexically identical to the production scanner —
// see its comment for the walk-through.
function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  const stack = [];
  while (i < n) {
    const top = stack[stack.length - 1];
    if (top === 'template') {
      const c = source[i];
      if (c === '\\') {
        out += c;
        i += 1;
        if (i < n) {
          out += source[i];
          i += 1;
        }
        continue;
      }
      if (c === '`') {
        out += c;
        i += 1;
        stack.pop();
        continue;
      }
      if (c === '$' && source[i + 1] === '{') {
        out += '${';
        i += 2;
        stack.push({ type: 'expr', depth: 0 });
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          out += source[i];
          i += 1;
          if (i < n) {
            out += source[i];
            i += 1;
          }
          continue;
        }
        out += source[i];
        i += 1;
      }
      if (i < n) {
        out += source[i];
        i += 1;
      }
      continue;
    }
    if (c === '`') {
      out += c;
      i += 1;
      stack.push('template');
      continue;
    }
    if (top && top.type === 'expr') {
      if (c === '{') {
        top.depth += 1;
        out += c;
        i += 1;
        continue;
      }
      if (c === '}') {
        if (top.depth === 0) {
          out += c;
          i += 1;
          stack.pop();
          continue;
        }
        top.depth -= 1;
        out += c;
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}
const PHASE3_LEGACY_OWNER_RULES = [
  {
    file: 'src/net/clickhouse-http-transport.ts',
    forbiddenWords: ['streamLines'],
  },
  {
    file: 'src/net/clickhouse-transport.types.ts',
    forbiddenWords: ['StreamCallbacks', 'streamLines'],
  },
  {
    file: 'src/core/stream.ts',
    forbiddenWords: ['StreamLine', 'splitBuffer', 'parseExceptionText', 'ExceptionFrame', 'findExceptionFrame'],
  },
];
function legacyOwnerViolations(fileText, forbiddenWords) {
  const code = stripComments(fileText);
  return forbiddenWords.filter((word) => new RegExp(`\\b${word}\\b`).test(code));
}

describe('Phase 3 legacy-owner rule — the moved stream/exception primitives cannot regain their former owners', () => {
  for (const rule of PHASE3_LEGACY_OWNER_RULES) {
    it(`the real ${rule.file} carries none of its former declarations`, () => {
      const text = readFileSync(join(repoRoot, rule.file), 'utf8');
      expect(legacyOwnerViolations(text, rule.forbiddenWords)).toEqual([]);
    });
  }

  it('flags a re-added streamLines forwarding wrapper in the transport adapter (sabotage probe, not written to disk)', () => {
    const probe = `
      export function createHttpTransport(deps) {
        const client = createClickHouseHttpClient(deps);
        return {
          async send(request) { return client.request(request); },
          streamLines: packageStreamLines,
        };
      }
    `;
    expect(legacyOwnerViolations(probe, ['streamLines'])).toEqual(['streamLines']);
  });

  it('flags a re-added StreamCallbacks/streamLines member on the transport contract (sabotage probe, not written to disk)', () => {
    const probe = `
      export interface StreamCallbacks { onLine?: (line: unknown) => void; onChunk?: () => void; }
      export interface ClickHouseTransport {
        send(request: TransportRequest): Promise<Response>;
        streamLines(body: ReadableStream<Uint8Array>, cbs: StreamCallbacks): Promise<void>;
      }
    `;
    expect(legacyOwnerViolations(probe, ['StreamCallbacks', 'streamLines'])).toEqual(['StreamCallbacks', 'streamLines']);
  });

  it('flags a re-added export interface StreamLine in core/stream.ts (sabotage probe, not written to disk)', () => {
    const probe = `
      export interface StreamLine { meta?: unknown[]; row?: Record<string, unknown>; }
      export function applyStreamLine(json, result) { return result; }
    `;
    // applyStreamLine must never trip the StreamLine check — no word
    // boundary between "apply" and "StreamLine".
    expect(legacyOwnerViolations(probe, ['StreamLine'])).toEqual(['StreamLine']);
  });

  it('does not flag applyStreamLine as a regained StreamLine declaration', () => {
    const probe = `
      export interface StreamColumn { name: string; type: string; }
      export function applyStreamLine(json, result) { return result; }
    `;
    expect(legacyOwnerViolations(probe, ['StreamLine'])).toEqual([]);
  });

  it('flags a re-added splitBuffer/parseExceptionText/ExceptionFrame/findExceptionFrame in core/stream.ts (sabotage probe, not written to disk)', () => {
    const probe = `
      export function splitBuffer(buffer) { return { lines: [], rest: '' }; }
      export function parseExceptionText(text) { return text; }
      export interface ExceptionFrame { message: string; cleanBytes: number; }
      export function findExceptionFrame(tailBytes, tag) { return null; }
    `;
    expect(legacyOwnerViolations(probe, ['splitBuffer', 'parseExceptionText', 'ExceptionFrame', 'findExceptionFrame']))
      .toEqual(['splitBuffer', 'parseExceptionText', 'ExceptionFrame', 'findExceptionFrame']);
  });

  it('does not flag a doc comment merely narrating the move (comments are stripped before matching)', () => {
    const probe = `
      // streamLines() moved to the package; StreamCallbacks moved too.
      export function createHttpTransport(deps) {
        return { async send(request) { return null; } };
      }
    `;
    expect(legacyOwnerViolations(probe, ['streamLines', 'StreamCallbacks'])).toEqual([]);
  });

  // Regression cases for a real bypass of the earlier regex-only
  // stripComments: a naive `/\*[\s\S]*?\*\/|\/\/.*/` alternation has no
  // notion of "inside a string", so a `/*`/`*/`/`//` substring that only
  // *looks* like a comment delimiter because it sits inside a string
  // literal used to swallow the real forbidden declaration between (or
  // after) the string literals, producing a false-clean scan. The scanner
  // must track string-literal boundaries so these are flagged.
  it('flags a re-added StreamLine sitting between two string literals that contain /* and */ (regex-stripComments bypass 1)', () => {
    const probe = 'const marker = "/*"; export interface StreamLine {} const end = "*/";';
    expect(legacyOwnerViolations(probe, ['StreamLine'])).toEqual(['StreamLine']);
  });

  it('flags a re-added streamLines following a string literal containing a "//" URL (regex-stripComments bypass 2)', () => {
    const probe = 'const u = "https://example"; export function streamLines() {}';
    expect(legacyOwnerViolations(probe, ['streamLines'])).toEqual(['streamLines']);
  });
});

describe('production build includes the workspace package source (issue #630 Phase 2)', () => {
  it('the real esbuild metafile contains packages/clickhouse-http/src/** and the workspace is not externalized', async () => {
    const { metafile } = await buildArtifact({ metafile: true });
    const inputPaths = Object.keys(metafile.inputs);
    const packageInputs = inputPaths.filter((p) => p.startsWith('packages/clickhouse-http/src/'));
    expect(packageInputs.length).toBeGreaterThan(0);
    // Repository-relative, matching every other build-graph invariant test
    // in this repository (size-report.test.js, client-web-spike-policy.test.js).
    for (const p of inputPaths) {
      expect(p.startsWith('/')).toBe(false);
      expect(p.startsWith('../')).toBe(false);
    }
    expect(inputPaths).toContain('src/main.ts');
  }, 60_000);
});

// The walks above only prove today's tree is clean and that the mirror's OWN
// logic would catch a regression. Neither proves `build/check-boundaries.mjs`
// (the actual `check:arch` gate) still declares the matching production
// rules — with those entries deleted from `RULES`/the dedicated blocks, this
// entire spec could stay green while `check:arch` silently lost its Phase 2
// coverage (the exact drift `dashboard-boundaries.test.js` already guards
// against for #455). Read as TEXT rather than imported: `check-boundaries.mjs`
// runs its whole check-and-exit routine at module top level.
describe('build/check-boundaries.mjs still declares the Rules A-D this spec mirrors (issue #630 Phase 2)', () => {
  const checkerSource = readFileSync(join(repoRoot, 'build/check-boundaries.mjs'), 'utf8');

  it('declares Rule A (packages/clickhouse-http/src forbidden: src)', () => {
    const entry = checkerSource.match(/\{\s*dir:\s*'packages\/clickhouse-http\/src',\s*forbidden:\s*\[([^\]]*)\]/);
    expect(entry, 'Rule A entry missing from build/check-boundaries.mjs RULES').not.toBeNull();
    expect([...entry[1].matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(['src']);
  });

  it('declares Rule B (zero bare specifiers under packages/clickhouse-http/src)', () => {
    expect(checkerSource).toMatch(/PACKAGE_SRC_DIR/);
    expect(checkerSource).toMatch(/clickhouse-http has zero bare package imports/);
  });

  it('declares Rule C (src forbidden: packages/clickhouse-http/src)', () => {
    const entry = checkerSource.match(/\{\s*dir:\s*'src',\s*forbidden:\s*\[([^\]]*)\]/);
    expect(entry, 'Rule C entry missing from build/check-boundaries.mjs RULES').not.toBeNull();
    expect([...entry[1].matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(['packages/clickhouse-http/src']);
  });

  it('declares Rule D (bare @altinity/clickhouse-http restricted to src/net/**, deep imports banned everywhere)', () => {
    expect(checkerSource).toMatch(/CLICKHOUSE_HTTP_SPECIFIER/);
    expect(checkerSource).toMatch(/may only be imported under src\/net\/\*\*/);
    expect(checkerSource).toMatch(/deep imports are forbidden everywhere/);
  });

  // Issue #630 Phase 3 — same drift bind, extended to the narrow
  // legacy-owner rule: deleting `PHASE3_LEGACY_OWNER_RULES` (or its
  // `stripComments` gate) from the real checker must not leave this file's
  // own independent mirror as the only thing enforcing it.
  it('declares the Phase 3 legacy-owner rule for all three former owners, with comments stripped before matching', () => {
    expect(checkerSource).toMatch(/PHASE3_LEGACY_OWNER_RULES/);
    expect(checkerSource).toMatch(/function stripComments\(/);
    for (const rule of PHASE3_LEGACY_OWNER_RULES) {
      const escapedFile = rule.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const entry = checkerSource.match(new RegExp(`file:\\s*'${escapedFile}',\\s*forbiddenWords:\\s*\\[([^\\]]*)\\]`));
      expect(entry, `Phase 3 rule entry missing for ${rule.file}`).not.toBeNull();
      const words = [...entry[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(words).toEqual(rule.forbiddenWords);
    }
  });
});
