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
// `streamLines`/`StreamCallbacks`/`StreamLine`/`ProgressMetaColumn`/
// `splitBuffer`/`parseExceptionText`/`ExceptionFrame`/`findExceptionFrame`.
// UNLIKE the Phase 2 rules above, this rule is NOT independently
// reimplemented here: three review passes each found a real lexical bypass
// in the hand-rolled comment/string/template/regex scanner this file and the
// checker used to duplicate, so both now import the ONE pure helper,
// `build/lib/check-legacy-owners.mjs` (a real TypeScript parse + AST
// identifier/property walk — importing it runs no top-level check). These
// tests exercise that helper's contract; the drift-binding describe block at
// the bottom confirms `build/check-boundaries.mjs` still calls the same
// helper over the same owner files.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../../build/build.mjs';
import {
  findLegacyOwnerViolations,
  PHASE3_LEGACY_OWNER_FILES,
  PHASE3_MOVED_NAMES,
} from '../../build/lib/check-legacy-owners.mjs';

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

// Issue #630 Phase 3 — the narrow legacy-owner rule, exercised through the
// SAME shared helper the production `check:arch` gate calls
// (`build/lib/check-legacy-owners.mjs`): a real TypeScript parse + AST
// identifier/property walk, so comments/strings/template literals/regex
// literals are resolved by the actual grammar rather than a hand-rolled
// scanner (three review passes each found a real lexical bypass in the
// previous duplicated implementation — those bypasses live on below as
// regression probes). Every probe is checked under a legacy-owner filename;
// the helper scopes itself to exactly those three files.
const TRANSPORT_OWNER = 'src/net/clickhouse-http-transport.ts';
const CONTRACT_OWNER = 'src/net/clickhouse-transport.types.ts';
const STREAM_OWNER = 'src/core/stream.ts';

describe('Phase 3 legacy-owner rule — the moved stream/exception primitives cannot regain their former owners', () => {
  for (const file of PHASE3_LEGACY_OWNER_FILES) {
    it(`the real ${file} carries none of its former declarations`, () => {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      expect(findLegacyOwnerViolations(text, file)).toEqual([]);
    });
  }

  it('flags a re-added streamLines forwarding-property wrapper in the transport adapter (sabotage probe, not written to disk)', () => {
    const probe = `
      export function createHttpTransport(deps) {
        const client = createClickHouseHttpClient(deps);
        return {
          async send(request) { return client.request(request); },
          streamLines: packageStreamLines,
        };
      }
    `;
    expect(findLegacyOwnerViolations(probe, TRANSPORT_OWNER)).toEqual(['streamLines']);
  });

  it('flags an import-and-re-export forwarding of the package streamLines (sabotage probe, not written to disk)', () => {
    const probe = `
      import { streamLines } from '@altinity/clickhouse-http';
      export { streamLines };
    `;
    expect(findLegacyOwnerViolations(probe, TRANSPORT_OWNER)).toEqual(['streamLines']);
  });

  it('flags an async streamLines(...) method wrapper delegating to the package implementation (sabotage probe, not written to disk)', () => {
    const probe = `
      export const transport = {
        async streamLines(body, cbs) { return packageStreamLines(body, cbs); },
      };
    `;
    expect(findLegacyOwnerViolations(probe, TRANSPORT_OWNER)).toEqual(['streamLines']);
  });

  it('flags a quoted (non-computed) "streamLines" property name too (sabotage probe, not written to disk)', () => {
    const probe = 'export const transport = { "streamLines": packageStreamLines };';
    expect(findLegacyOwnerViolations(probe, TRANSPORT_OWNER)).toEqual(['streamLines']);
  });

  it('flags a re-added StreamCallbacks/streamLines member on the transport contract (sabotage probe, not written to disk)', () => {
    const probe = `
      export interface StreamCallbacks { onLine?: (line: unknown) => void; onChunk?: () => void; }
      export interface ClickHouseTransport {
        send(request: TransportRequest): Promise<Response>;
        streamLines(body: ReadableStream<Uint8Array>, cbs: StreamCallbacks): Promise<void>;
      }
    `;
    // Returned in PHASE3_MOVED_NAMES order, deduplicated.
    expect(findLegacyOwnerViolations(probe, CONTRACT_OWNER)).toEqual(['streamLines', 'StreamCallbacks']);
  });

  it('flags a re-added export interface StreamLine in core/stream.ts (sabotage probe, not written to disk)', () => {
    const probe = `
      export interface StreamLine { meta?: unknown[]; row?: Record<string, unknown>; }
      export function applyStreamLine(json, result) { return result; }
    `;
    // applyStreamLine must never trip the StreamLine check — the AST walk
    // compares whole identifier names, and applyStreamLine is a different
    // identifier.
    expect(findLegacyOwnerViolations(probe, STREAM_OWNER)).toEqual(['StreamLine']);
  });

  it('does not flag applyStreamLine as a regained StreamLine declaration', () => {
    const probe = `
      export interface StreamColumn { name: string; type: string; }
      export function applyStreamLine(json, result) { return result; }
    `;
    expect(findLegacyOwnerViolations(probe, STREAM_OWNER)).toEqual([]);
  });

  it('flags a re-added splitBuffer/parseExceptionText/ExceptionFrame/findExceptionFrame in core/stream.ts (sabotage probe, not written to disk)', () => {
    const probe = `
      export function splitBuffer(buffer) { return { lines: [], rest: '' }; }
      export function parseExceptionText(text) { return text; }
      export interface ExceptionFrame { message: string; cleanBytes: number; }
      export function findExceptionFrame(tailBytes, tag) { return null; }
    `;
    expect(findLegacyOwnerViolations(probe, STREAM_OWNER))
      .toEqual(['parseExceptionText', 'findExceptionFrame', 'splitBuffer', 'ExceptionFrame']);
  });

  it('flags a re-added ProgressMetaColumn type on the transport contract (sabotage probe, not written to disk)', () => {
    const probe = 'export interface ProgressMetaColumn { name: string; type: string; }';
    expect(findLegacyOwnerViolations(probe, CONTRACT_OWNER)).toEqual(['ProgressMetaColumn']);
  });

  it('does not flag a doc comment merely narrating the move (comments are parser trivia, never AST nodes)', () => {
    const probe = `
      // streamLines() moved to the package; StreamCallbacks moved too.
      /** See also parseExceptionText and findExceptionFrame in the package. */
      export function createHttpTransport(deps) {
        return { async send(request) { return null; } };
      }
    `;
    expect(findLegacyOwnerViolations(probe, TRANSPORT_OWNER)).toEqual([]);
  });

  it('is scoped to the three legacy owners only — the same source under any other filename is out of scope', () => {
    const probe = 'export function streamLines() {}';
    // src/net/ch-client.ts is the sanctioned consumer of the package
    // exports, not a legacy owner.
    expect(findLegacyOwnerViolations(probe, 'src/net/ch-client.ts')).toEqual([]);
    expect(findLegacyOwnerViolations(probe, 'src/core/chart-data.ts')).toEqual([]);
  });

  // The four probes below are the historical bypasses of the retired
  // hand-rolled scanner, kept as regression coverage. Review pass 1: a
  // naive comment-stripping regex read the "/*"/"*/" INSIDE string literals
  // as a block comment and deleted the real declaration between them, and
  // read the "//" inside a URL string as a line-comment opener. Review pass
  // 2: it had no notion of regex literals, so the two adjacent slashes
  // produced by /\/\// were misread as a line comment. Review pass 3: its
  // regex-vs-division heuristic treated every ")" as "a value was just
  // produced", so a regex literal opening a control-flow statement body
  // (if (true) /\//.test("/");) was misread as division and then a comment.
  // A real parse has none of these failure modes: each probe's forbidden
  // declaration is an ordinary AST node.
  it('flags a re-added StreamLine sitting between two string literals that contain /* and */ (historical bypass 1)', () => {
    const probe = 'const marker = "/*"; export interface StreamLine {} const end = "*/";';
    expect(findLegacyOwnerViolations(probe, STREAM_OWNER)).toEqual(['StreamLine']);
  });

  it('flags a re-added streamLines following a string literal containing a "//" URL (historical bypass 2)', () => {
    const probe = 'const u = "https://example"; export function streamLines() {}';
    expect(findLegacyOwnerViolations(probe, TRANSPORT_OWNER)).toEqual(['streamLines']);
  });

  it('flags a re-added streamLines declared right after a regex literal containing "//" (historical bypass 3)', () => {
    const probe = 'const re = /\\/\\//; export function streamLines() {}';
    expect(findLegacyOwnerViolations(probe, TRANSPORT_OWNER)).toEqual(['streamLines']);
  });

  it('flags a re-added streamLines declared after an if-controlled statement that opens with a regex literal (historical bypass 4)', () => {
    const probe = 'if (true) /\\//.test("/"); export function streamLines() {}';
    expect(findLegacyOwnerViolations(probe, TRANSPORT_OWNER)).toEqual(['streamLines']);
  });

  // Ordinary division, in both shapes the old heuristic had to classify
  // (after a grouping paren and after a call paren). The parser needs no
  // regex-vs-division classification from us at all — these prove the real
  // declaration is still found with division present.
  it('still flags the real declaration when ordinary division follows a grouping paren', () => {
    const probe = `
      export function pct(read, total) {
        return (read / total) * 100;
      }
      export function streamLines() {}
    `;
    expect(findLegacyOwnerViolations(probe, TRANSPORT_OWNER)).toEqual(['streamLines']);
  });

  it('still flags the real declaration when ordinary division follows a call paren', () => {
    const probe = `
      export function ratio(fn, total) {
        return fn(total) / total;
      }
      export function streamLines() {}
    `;
    expect(findLegacyOwnerViolations(probe, TRANSPORT_OWNER)).toEqual(['streamLines']);
  });

  it('does not flag division-only source at all (no dependence on regex-vs-division classification)', () => {
    const probe = `
      export function pct(read, total) {
        return (read / total) * 100;
      }
    `;
    expect(findLegacyOwnerViolations(probe, TRANSPORT_OWNER)).toEqual([]);
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

  // Issue #630 Phase 3 — same drift bind, adapted to the shared-helper
  // convention: the Phase 3 tests above exercise
  // `build/lib/check-legacy-owners.mjs` directly, so what could silently
  // drift is the CHECKER — it must still import that same helper and feed it
  // every legacy-owner file. The owner/name lists themselves cannot drift
  // between suite and gate anymore (both read the helper's exported
  // constants), so here we pin the helper's contract instead: the exact
  // three former owners and the exact moved-name set Phase 3 banned.
  it('delegates the Phase 3 legacy-owner rule to build/lib/check-legacy-owners.mjs (same helper this suite tests)', () => {
    expect(checkerSource).toMatch(/from '\.\/lib\/check-legacy-owners\.mjs'/);
    expect(checkerSource).toMatch(/findLegacyOwnerViolations\(/);
    expect(checkerSource).toMatch(/for \(const relFile of PHASE3_LEGACY_OWNER_FILES\)/);
  });

  it('the shared helper still names the three former owners and the full Phase 3 moved-name set', () => {
    expect([...PHASE3_LEGACY_OWNER_FILES]).toEqual([
      'src/net/clickhouse-http-transport.ts',
      'src/net/clickhouse-transport.types.ts',
      'src/core/stream.ts',
    ]);
    expect([...PHASE3_MOVED_NAMES]).toEqual([
      'streamLines',
      'parseExceptionText',
      'findExceptionFrame',
      'splitBuffer',
      'StreamLine',
      'StreamCallbacks',
      'ProgressMetaColumn',
      'ExceptionFrame',
    ]);
  });
});
