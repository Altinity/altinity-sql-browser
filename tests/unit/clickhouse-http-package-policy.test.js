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
//
// Issue #630 Phase 5 — Rule D is revised (plan §8.2): the bare package
// specifier is no longer net-only for EVERY name — pure LANGUAGE exports
// (SQL quoting, the generic type grammar, the shared scanner) may now be
// imported directly outside `src/net/**` too, while transport/protocol APIs
// (`createClickHouseHttpClient`, `chUrl`, `streamLines`, …) and every
// non-named-import access form (default/namespace/side-effect/dynamic
// import, package re-export gateway) stay `src/net/**`-only. This identifier
// /import-shape analysis is NOT independently reimplemented here either, for
// the same reason as the Phase 3 rule above (a specifier-text regex cannot
// tell which NAMES a named import binds) — both the checker and this suite
// call the same shared `findPackageImportUsages` helper. Phase 5 also adds
// two more former-owner checks (`format.ts` must not regain SQL quoting;
// the package's own `client.ts` must not regain the retired Phase-4
// `quoteKillQueryId` stopgap), through the same generalized
// `findNamedIdentifierViolations` walker the Phase 3 rule now shares.

import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../../build/build.mjs';
import {
  findLegacyOwnerViolations,
  PHASE3_LEGACY_OWNER_FILES,
  PHASE3_MOVED_NAMES,
  findSqlQuoteOwnerViolations,
  PHASE5_SQL_QUOTE_OWNER_FILES,
  PHASE5_SQL_QUOTE_MOVED_NAMES,
  findKillStopgapOwnerViolations,
  PHASE5_KILL_STOPGAP_OWNER_FILES,
  PHASE5_KILL_STOPGAP_MOVED_NAMES,
  findDeepImportSpecifiers,
  findPackageImportUsages,
  PHASE5_PACKAGE_LANGUAGE_EXPORTS,
  mightReferencePackage,
  findRetiredTopLevelApiViolations,
  PHASE7_RETIRED_TOP_LEVEL_NAMES,
  PHASE7_DELETED_TRANSPORT_FILES,
  mightReferenceRetiredTopLevelApi,
  PHASE8_NARROW_RULE_D_EXCEPTIONS,
  findModuleSpecifiers,
  findTransportSurfaceOwnershipViolations,
  PHASE8_TRANSPORT_SURFACE_NAMES,
  PHASE8_PARSER_SURFACE_NAMES,
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
// inside this test process). The dynamic-import pattern also accepts a
// backtick no-substitution template literal, matching the production
// scanner (only a dynamic `import(...)` call can syntactically take one).
const SPECIFIER_PATTERNS = [
  /\bimport\s+[\w*{}\s,]+\s+from\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[\w*{}\s,]+\s+from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
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

// Rule D mirror (deep-import half). NOT independently reimplemented as a
// specifier-text regex — it shares `findDeepImportSpecifiers` with the
// production checker, same reason as the bare-specifier half just below and
// the Phase 3 legacy-owner rule before it: a hand-rolled regex scan stayed
// vulnerable to comment-trivia bypasses (a comment sitting between `import`
// and its call parens, or between the open paren and the specifier) that no
// amount of pattern-widening could close, while a real parse resolves
// comments as trivia by construction. Both halves of Rule D now call the
// same shared real-parser helper module.
const CLICKHOUSE_HTTP_SPECIFIER = '@altinity/clickhouse-http';
// Cheap pre-filter before spawning the real parser — imported from
// `build/lib/check-legacy-owners.mjs` (review pass 2 hardening) rather than
// hand-copied here a second time: two independently maintained copies (one
// here, one in `build/check-boundaries.mjs`) meant a production-only
// regression back to the old exact-substring gate could leave every
// escaped-specifier sabotage test below green, since they exercised only
// THIS file's own copy, never production's. Sharing the one implementation
// means the same call below now also proves production still uses it (see
// the drift-binding describe block at the bottom of this file). See that
// function's own doc comment for the escape-sequence reasoning.
// The on-disk tree under `dir` never changes within one test-file run, but
// every call site above re-passes `join(repoRoot, 'src')` with a DIFFERENT
// single sabotage probe appended — ~30 call sites across this describe
// block. Re-scanning and re-spawning the real TypeScript-parser child
// process (`findDeepImportSpecifiers`/`findPackageImportUsages`, transitively
// `withParsedSource`'s `new API(...)`) for every real file under `src/` that
// merely CONTAINS a backslash — common in ordinary source (regex literals,
// `\n`/`\t` escapes, JSDoc) now that `mightReferencePackage` had to widen
// past a plain substring test — turned "one full-tree scan" into "one
// full-tree scan PER TEST CASE," which is what actually timed out in CI
// (5000ms per-test default) even though it stayed comfortably under a
// human's patience locally. Memoize the on-disk component ONCE per `dir` and
// only re-run the (cheap, single-file) parser-backed check on the ACTUAL
// virtual probe each test adds — the combined result is identical to the
// unmemoized version, since the real tree's own violations (there are none
// today) can't change between calls in the same process.
const realTreeDeepImportCache = new Map();
function deepImportViolations(dir, virtualFiles = []) {
  let cached = realTreeDeepImportCache.get(dir);
  if (!cached) {
    cached = [];
    for (const file of collectFiles(dir)) {
      const relFile = relative(repoRoot, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');
      if (!mightReferencePackage(text, CLICKHOUSE_HTTP_SPECIFIER)) continue;
      for (const spec of findDeepImportSpecifiers(text, relFile, CLICKHOUSE_HTTP_SPECIFIER)) {
        cached.push(`${relFile} → ${spec}`);
      }
    }
    realTreeDeepImportCache.set(dir, cached);
  }
  const found = [...cached];
  for (const [rel, source] of virtualFiles) {
    const relFile = relative(repoRoot, join(repoRoot, rel)).split(sep).join('/');
    if (!mightReferencePackage(source, CLICKHOUSE_HTTP_SPECIFIER)) continue;
    for (const spec of findDeepImportSpecifiers(source, relFile, CLICKHOUSE_HTTP_SPECIFIER)) {
      found.push(`${relFile} → ${spec}`);
    }
  }
  return found;
}

// Rule D's revised bare-specifier half (issue #630 Phase 5, plan §8.2):
// outside `src/net/**`, only a named import of an approved pure-language
// export is allowed — every other name, and every non-named-import access
// form (default/namespace/side-effect/dynamic import, package re-export
// gateway), stays `src/net/**`-only. Calls the SAME real-parser helper the
// production `check:arch` gate calls.
// Same memoization rationale as `deepImportViolations` above — this half
// spawns the real-parser child process even more often (every describe
// block below adds its own single virtual probe), so the same O(tests ×
// real-tree-size) blowup applies here too.
const realTreePackageNameShapeCache = new Map();
function packageNameShapeViolations(dir, virtualFiles = []) {
  let cached = realTreePackageNameShapeCache.get(dir);
  if (!cached) {
    cached = [];
    for (const file of collectFiles(dir)) {
      const relFile = relative(repoRoot, file).split(sep).join('/');
      if (relFile.startsWith('src/net/')) continue; // net is unrestricted by design
      const text = readFileSync(file, 'utf8');
      if (!mightReferencePackage(text, CLICKHOUSE_HTTP_SPECIFIER)) continue;
      const narrowExceptionNames = PHASE8_NARROW_RULE_D_EXCEPTIONS[relFile] ?? [];
      for (const usage of findPackageImportUsages(text, relFile, CLICKHOUSE_HTTP_SPECIFIER)) {
        if (usage.kind === 'named' && PHASE5_PACKAGE_LANGUAGE_EXPORTS.includes(usage.name)) continue;
        if (usage.kind === 'named' && narrowExceptionNames.includes(usage.name)) continue;
        cached.push(`${relFile} → ${CLICKHOUSE_HTTP_SPECIFIER} (${usage.kind}${usage.name ? `:${usage.name}` : ''})`);
      }
    }
    realTreePackageNameShapeCache.set(dir, cached);
  }
  const found = [...cached];
  for (const [rel, source] of virtualFiles) {
    const relFile = relative(repoRoot, join(repoRoot, rel)).split(sep).join('/');
    if (relFile.startsWith('src/net/')) continue; // net is unrestricted by design
    if (!mightReferencePackage(source, CLICKHOUSE_HTTP_SPECIFIER)) continue;
    const narrowExceptionNames = PHASE8_NARROW_RULE_D_EXCEPTIONS[relFile] ?? [];
    for (const usage of findPackageImportUsages(source, relFile, CLICKHOUSE_HTTP_SPECIFIER)) {
      if (usage.kind === 'named' && PHASE5_PACKAGE_LANGUAGE_EXPORTS.includes(usage.name)) continue;
      if (usage.kind === 'named' && narrowExceptionNames.includes(usage.name)) continue;
      found.push(`${relFile} → ${CLICKHOUSE_HTTP_SPECIFIER} (${usage.kind}${usage.name ? `:${usage.name}` : ''})`);
    }
  }
  return found;
}

// Issue #630 Phase 7 — retired top-level runQuery/exportQuery/ordinary-
// killQuery resurrection guard. Calls the SAME real-parser helper the
// production `check:arch` gate calls (`findRetiredTopLevelApiViolations`) —
// not independently reimplemented, same reason as the Phase 3/5 rules and
// Rule D above. Same memoization rationale as `deepImportViolations`/
// `packageNameShapeViolations` above.
const realTreeRetiredApiCache = new Map();
function retiredApiViolations(dir, virtualFiles = []) {
  let cached = realTreeRetiredApiCache.get(dir);
  if (!cached) {
    cached = [];
    for (const file of collectFiles(dir)) {
      const relFile = relative(repoRoot, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');
      if (!mightReferenceRetiredTopLevelApi(text, PHASE7_RETIRED_TOP_LEVEL_NAMES)) continue;
      for (const name of findRetiredTopLevelApiViolations(text, relFile, PHASE7_RETIRED_TOP_LEVEL_NAMES)) {
        cached.push(`${relFile} → ${name}`);
      }
    }
    realTreeRetiredApiCache.set(dir, cached);
  }
  const found = [...cached];
  for (const [rel, source] of virtualFiles) {
    const relFile = relative(repoRoot, join(repoRoot, rel)).split(sep).join('/');
    if (!mightReferenceRetiredTopLevelApi(source, PHASE7_RETIRED_TOP_LEVEL_NAMES)) continue;
    for (const name of findRetiredTopLevelApiViolations(source, relFile, PHASE7_RETIRED_TOP_LEVEL_NAMES)) {
      found.push(`${relFile} → ${name}`);
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

// Issue #630 Phase 8 (plan §21, Guard 2) broadens Rule C's forbidden target
// from just `packages/clickhouse-http/src` to the WHOLE package directory
// (`packages/clickhouse-http`) — generated `dist/**` is a second possible
// relative deep-import escape a source-only ban would miss.
describe('Rule C — SQL Browser source does not deep-import the package (relative, whole package directory)', () => {
  it('the real src/** tree is clean', () => {
    expect(relativeViolations(join(repoRoot, 'src'), ['packages/clickhouse-http'])).toEqual([]);
  });

  it('flags a relative deep import into the package src/** implementation (sabotage probe, not written to disk)', () => {
    const found = relativeViolations(join(repoRoot, 'src'), ['packages/clickhouse-http'], [
      ['src/net/__boundary_probe_630_deep__.ts',
        "import { chUrl } from '../../packages/clickhouse-http/src/client.js';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_deep__') && line.includes('packages/clickhouse-http'))).toBe(true);
  });

  // Issue #630 Phase 8 (plan §21) — the NEW escape a source-only ban would
  // have missed: a relative deep import into generated dist/**.
  it('flags a relative deep import into the package dist/** build output (sabotage probe, not written to disk)', () => {
    const found = relativeViolations(join(repoRoot, 'src'), ['packages/clickhouse-http'], [
      ['src/net/__boundary_probe_630p8_deepdist__.ts',
        "import { chUrl } from '../../packages/clickhouse-http/dist/client.js';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630p8_deepdist__') && line.includes('packages/clickhouse-http'))).toBe(true);
  });

  // The bare deep-import subpath form needs no parallel Guard-2 change: Rule
  // D's `findDeepImportSpecifiers` (exercised in the Rule D describe block
  // below) already bans any subpath of the package specifier regardless of
  // what follows the slash — dist included.
  it('flags a bare deep-import subpath into the package dist/** build output (sabotage probe, not written to disk)', () => {
    const found = deepImportViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630p8_deepdistbare__.ts',
        "import { chUrl } from '@altinity/clickhouse-http/dist/client.js';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630p8_deepdistbare__'))).toBe(true);
  });
});

// Pre-warm all three real-tree caches once, in `beforeAll`, rather than
// letting whichever test happens to run first inside the Rule D / Phase 7
// describe blocks below pay for it under the DEFAULT per-test timeout: the
// cache-filling pass spawns the real TypeScript-parser child process once per
// real file that matches each check's own pre-filter, and that one-time
// cost — comfortably under a few seconds on a normal dev machine — has
// exceeded vitest's 5000ms per-test default under CI's more constrained
// scheduling. Explicit longer timeout here, attributed to setup rather than
// to an arbitrary specific test (also robust to test reordering).
beforeAll(() => {
  deepImportViolations(join(repoRoot, 'src'));
  packageNameShapeViolations(join(repoRoot, 'src'));
  retiredApiViolations(join(repoRoot, 'src'));
}, 30000);

describe('Rule D, deep-import half — the deep-import subpath form is forbidden everywhere under src/**', () => {
  it('the real src/** tree has no deep-import subpath', () => {
    expect(deepImportViolations(join(repoRoot, 'src'))).toEqual([]);
  });

  it('flags a deep-import subpath of the package from anywhere under src/** (sabotage probe, not written to disk)', () => {
    const found = deepImportViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630_deepbare__.ts',
        "import { createClickHouseHttpClient } from '@altinity/clickhouse-http/src/client';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_deepbare__'))).toBe(true);
  });

  // Regression for a real escape found in review: the quote-only version of
  // this scanner's dynamic-import pattern matched only `['"]`, so a
  // no-substitution TEMPLATE LITERAL deep import (backtick-delimited)
  // reached no branch of the scan at all and silently escaped the rule.
  it('flags a deep-import subpath spelled through a backtick template-literal dynamic import (sabotage probe, not written to disk)', () => {
    const found = deepImportViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630_deeptemplate__.ts',
        'export async function f() { await import(`@altinity/clickhouse-http/src/client`); }\n'],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_deeptemplate__'))).toBe(true);
  });

  it('flags a deep-import subpath even under src/net/** (deep imports stay forbidden everywhere, not just outside net)', () => {
    const found = deepImportViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630_deepnet__.ts',
        "import { chUrl } from '@altinity/clickhouse-http/url';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_deepnet__'))).toBe(true);
  });

  // Regression for a real escape found in review pass 2: the regex-based
  // predecessor of this check required `\s*` (whitespace only) between
  // `import` and `(`, and between `(` and the specifier delimiter. A block
  // comment in either gap is not whitespace, so the specifier was never
  // extracted at all — a real parse has no such gap to defeat, since
  // comments are trivia to the grammar, never AST nodes.
  it('flags a deep-import subpath with a block comment between "import" and its call parens (sabotage probe, not written to disk)', () => {
    const found = deepImportViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630_deepcomment1__.ts',
        "export async function f() { await import/*comment*/('@altinity/clickhouse-http/src/client'); }\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_deepcomment1__'))).toBe(true);
  });

  it('flags a deep-import subpath with a block comment between the open paren and the specifier (sabotage probe, not written to disk)', () => {
    const found = deepImportViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630_deepcomment2__.ts',
        "export async function f() { await import(/*comment*/'@altinity/clickhouse-http/src/client'); }\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_deepcomment2__'))).toBe(true);
  });

  // Regression for a real escape found in ChatGPT's post-review advisory
  // (not a formal review pass): TypeScript's inline import-type expression
  // (`type T = import('pkg/deep').Foo`) is its own `ImportTypeNode` grammar
  // production, structurally distinct from every form the checks above
  // handle (ImportDeclaration/ExportDeclaration/dynamic-import
  // CallExpression) — none of them ever visits it, so a deep-subpath
  // reference spelled this way silently escaped the ban entirely.
  it('flags a deep-import subpath spelled through an inline import-type expression (sabotage probe, not written to disk)', () => {
    const found = deepImportViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630_deepimporttype__.ts',
        "type T = import('@altinity/clickhouse-http/src/client').ClickHouseHttpClient;\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_deepimporttype__'))).toBe(true);
  });

  // Regression for a real escape found in review pass 1: the pre-filter
  // gating the real parser was a RAW substring test
  // (`text.includes(CLICKHOUSE_HTTP_SPECIFIER)`), which a string literal
  // spelling the same specifier through a JS hex-escape sequence never
  // contains, even though it decodes to the exact same text the real parser
  // resolves via `node.text`. `\x74` decodes to `t`, so this specifier
  // decodes to `@altinity/clickhouse-http/src/client`.
  it('flags a deep-import subpath spelled through a hex-escaped specifier that never contains the raw substring (sabotage probe, not written to disk)', () => {
    const found = deepImportViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630_deepescape__.ts',
        "import { createClickHouseHttpClient } from '@altinity/clickhouse-h\\x74tp/src/client';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_deepescape__'))).toBe(true);
  });
});

// Issue #630 Phase 5 — Rule D's revised bare-specifier half (plan §8.2):
// this phase's whole point is that SQL Browser language consumers (the
// generic quoting/type-grammar/scanner) now import the package's pure
// LANGUAGE exports directly, outside src/net/**, while the transport/client
// surface remains net-only and every non-named-import access form stays
// net-only too.
describe('Rule D, revised bare-specifier half (issue #630 Phase 5) — outside src/net/**, only a named import of an approved pure-language export is allowed', () => {
  it('the real src/** tree is clean under the revised policy', () => {
    expect(packageNameShapeViolations(join(repoRoot, 'src'))).toEqual([]);
  });

  it('passes a named import of an approved pure-language export outside src/net/** (e.g. sqlString from src/core/**)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_language__.ts',
        "import { sqlString } from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_language__'))).toBe(false);
  });

  it('flags a named import of a transport/client export outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_core__.ts',
        "import { createClickHouseHttpClient } from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_core__'))).toBe(true);
  });

  it('flags a default import of the package outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_default__.ts',
        "import Def from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_default__'))).toBe(true);
  });

  it('flags a namespace import of the package outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_namespace__.ts',
        "import * as ns from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_namespace__'))).toBe(true);
  });

  it('flags a side-effect import of the package outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_sideeffect__.ts',
        "import '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_sideeffect__'))).toBe(true);
  });

  it('flags a dynamic import of the package outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_dynamic__.ts',
        "export async function f() { await import('@altinity/clickhouse-http'); }\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_dynamic__'))).toBe(true);
  });

  // Regression for a real escape found in review: `findPackageImportUsages`'s
  // `isTargetSpecifier` matched only `SyntaxKind.StringLiteral`, so a dynamic
  // `import(...)` spelled with a no-substitution TEMPLATE LITERAL (backtick)
  // parsed to `SyntaxKind.NoSubstitutionTemplateLiteral` and never matched —
  // the bare-specifier half of Rule D silently let it through.
  it('flags a backtick-template-literal dynamic import of the package outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_dynamic_template__.ts',
        'export async function f() { await import(`@altinity/clickhouse-http`); }\n'],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_dynamic_template__'))).toBe(true);
  });

  // No type-only carve-out: a type-only reference to a transport/protocol
  // name is flagged on exactly the same terms as a value one (see the
  // updated doc comment on `findPackageImportUsages` and
  // `docs/ARCHITECTURE.md`/`CLAUDE.md`) — the boundary is a source-level
  // ownership boundary over which subsystem may even NAME a transport
  // export, not a bundle-output boundary erasure before bundling could
  // exempt. These are sabotage probes (not written to disk): each of these
  // three type-only forms must still be caught, even though
  // `createClickHouseHttpClient`/`ClickHouseError` are transport names, not
  // approved pure-language exports.
  it('flags a whole `import type` clause naming a transport export outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_importtype__.ts',
        "import type { createClickHouseHttpClient } from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_importtype__'))).toBe(true);
  });

  it('flags an individual `import { type X }` specifier naming a transport export outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_typespecifier__.ts',
        "import { type createClickHouseHttpClient } from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_typespecifier__'))).toBe(true);
  });

  it('flags an `export type { X } from` re-export naming a transport export outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_exporttype__.ts',
        "export type { ClickHouseError } from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_exporttype__'))).toBe(true);
  });

  // Regression for a real escape found in ChatGPT's post-review advisory
  // (not a formal review pass): TypeScript's inline import-type expression
  // (`type T = import('pkg').Foo`, `typeof import('pkg')`) is its own
  // `ImportTypeNode` grammar production — structurally distinct from every
  // form the checks above handle — so neither of the three historical
  // review passes' type-only fixes ever touched it. Reported unconditionally
  // regardless of which member it qualifies into: even `import('pkg').Span`
  // (a name that WOULD be allowed as a plain named import) must still be
  // flagged here, because allowlisting a qualifier would broaden the
  // documented contract (a plain named import) rather than just closing the
  // gap — see `findPackageImportUsages`'s own doc comment.
  it('flags an inline `import(...).Foo` import-type expression naming a transport export outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_importtypeexpr__.ts',
        "type T = import('@altinity/clickhouse-http').ClickHouseHttpClient;\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_importtypeexpr__'))).toBe(true);
  });

  it('flags an inline `import(...).Foo` import-type expression even for an approved language export name (allowlist is for plain named imports only)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_importtypeexprlang__.ts',
        "type T = import('@altinity/clickhouse-http').Span;\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_importtypeexprlang__'))).toBe(true);
  });

  it('flags a `typeof import(...)` import-type expression naming the package outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_typeofimport__.ts',
        "type Pkg = typeof import('@altinity/clickhouse-http');\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_typeofimport__'))).toBe(true);
  });

  // The allowlist filter still applies to type-only named imports: a
  // type-only reference to an APPROVED pure-language export is not a usage
  // the caller forbids, exactly like the value form (`Span` has no value
  // export at all — it can only ever be imported type-only — so this is
  // also the regression guard for that name ever becoming unimportable).
  it('passes a type-only named import of an approved pure-language export outside src/net/** (e.g. `import type { Span }`)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_typelanguage__.ts',
        "import type { Span } from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_typelanguage__'))).toBe(false);
  });

  it('passes an individual type-only `{ type sqlString }` specifier naming an approved pure-language export outside src/net/**', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_typespecifier_language__.ts',
        "import { type sqlString } from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_typespecifier_language__'))).toBe(false);
  });

  // Regression for a real escape found in review pass 1: same pre-filter
  // bypass as the deep-import half above, applied to a bare (non-deep)
  // specifier — a named import of a transport export, spelled with a
  // hex-escaped specifier that decodes to the exact plain package name
  // without the RAW source ever containing it as a substring.
  it('flags a named import of a transport export spelled through a hex-escaped specifier that never contains the raw substring (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_escapedspecifier__.ts',
        "import { createClickHouseHttpClient } from '@altinity/clickhouse-h\\x74tp';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_escapedspecifier__'))).toBe(true);
  });

  // The widened pre-filter (any backslash routes a file through the real
  // parser, not just a raw substring match) must not turn an UNRELATED
  // backslash — a regex literal, an unrelated string escape — into a false
  // positive: the real parser-backed check still requires the decoded
  // specifier to match exactly, so a file that merely contains a backslash
  // elsewhere stays clean.
  it('does not flag a file with an unrelated backslash and no reference to the package at all', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_unrelated_backslash__.ts',
        "export const re = /a\\/b/;\nexport function f(s) { return s.replace(/\\\\/g, ''); }\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_unrelated_backslash__'))).toBe(false);
  });

  it('flags a package re-export gateway outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/core/__boundary_probe_630_reexport__.ts',
        "export { sqlString } from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_reexport__'))).toBe(true);
  });

  it('passes any access form/name at all under src/net/** — net remains unrestricted by design', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630_net_transport__.ts',
        "import { createClickHouseHttpClient } from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630_net_transport__'))).toBe(false);
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

  // Issue #630 Phase 8 (plan §17) — the migration-only re-export gateway is
  // retired now that every spike consumer is gone: `ch-client.ts` no longer
  // imports or re-exports `chUrl` at all (it never used the value in its own
  // production code, only forwarded it). This replaces the pre-Phase-8
  // "re-exports rather than redeclaring" assertion, which is no longer true.
  it('src/net/ch-client.ts no longer imports or re-exports chUrl (the migration gateway is retired)', () => {
    const text = readFileSync(join(repoRoot, 'src/net/ch-client.ts'), 'utf8');
    // Historical prose narrating the retirement legitimately still mentions
    // the name (see this file's own header comment) — only an actual
    // import/export declaration binding it is a violation.
    expect(/import\s*\{[^}]*\bchUrl\b[^}]*\}\s*from/.test(text)).toBe(false);
    expect(/export\s*\{[^}]*\bchUrl\b[^}]*\}/.test(text)).toBe(false);
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
  // Issue #630 Phase 7 (plan §16/§2.6) — `PHASE3_LEGACY_OWNER_FILES` stays
  // pinned to its historical three-file former-owner set UNCHANGED (asserted
  // below, in the drift-bind describe block) even though two of those three
  // files are now intentionally deleted: the constant describes former
  // owners, not necessarily currently-existing files. Blindly `readFileSync`-
  // ing all three (the pre-Phase-7 shape) would ENOENT the moment the first
  // deleted file is read — replaced with explicit absence assertions for the
  // two retired production files, plus a real read+clean-scan of the one
  // survivor, `src/core/stream.ts`. Never "fixed" by reintroducing either
  // deleted file (plan §29 rollback rule).
  it(`${TRANSPORT_OWNER} is absent (issue #630 Phase 7 — deleted; the local compatibility transport moved wholly onto @altinity/clickhouse-http)`, () => {
    expect(existsSync(join(repoRoot, TRANSPORT_OWNER))).toBe(false);
  });

  it(`${CONTRACT_OWNER} is absent (issue #630 Phase 7 — deleted alongside its implementation)`, () => {
    expect(existsSync(join(repoRoot, CONTRACT_OWNER))).toBe(false);
  });

  it(`the real ${STREAM_OWNER} carries none of its former declarations`, () => {
    const text = readFileSync(join(repoRoot, STREAM_OWNER), 'utf8');
    expect(findLegacyOwnerViolations(text, STREAM_OWNER)).toEqual([]);
  });

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

// Issue #630 Phase 2 established that root esbuild bundles the workspace
// package's SOURCE and the workspace is not externalized. Issue #630 Phase 8
// (plan §12) flips this: the package's public manifest now points at BUILT
// output (`dist/**`, resolved through the workspace `node_modules` symlink),
// so root esbuild must consume that — never package source directly — while
// STILL not externalizing the workspace (it is project code, attributed to
// the `project` ownership bucket by `build/size-report-lib.mjs`, never
// `external`). This is a direct A17 proof, not a build convenience.
describe('production build consumes the built package dist/**, never package source (issue #630 Phase 8, A17)', () => {
  it('the real esbuild metafile contains packages/clickhouse-http/dist/** input(s), no packages/clickhouse-http/src/** input, and no @clickhouse/client-web input', async () => {
    const { metafile } = await buildArtifact({ metafile: true });
    const inputPaths = Object.keys(metafile.inputs);
    expect(inputPaths).toContain('src/main.ts');
    const distInputs = inputPaths.filter((p) => p.startsWith('packages/clickhouse-http/dist/'));
    expect(distInputs.length).toBeGreaterThan(0);
    const srcInputs = inputPaths.filter((p) => p.startsWith('packages/clickhouse-http/src/'));
    expect(srcInputs).toEqual([]);
    const clientWebInputs = inputPaths.filter((p) => p.includes('@clickhouse/client-web'));
    expect(clientWebInputs).toEqual([]);
    // Repository-relative, matching every other build-graph invariant test
    // in this repository (size-report.test.js, client-web-retirement-policy.test.js).
    for (const p of inputPaths) {
      expect(p.startsWith('/')).toBe(false);
      expect(p.startsWith('../')).toBe(false);
    }
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

  // Issue #630 Phase 8 (plan §21, Guard 2) broadened Rule C's forbidden
  // target from just `packages/clickhouse-http/src` to the whole package
  // directory (`packages/clickhouse-http`) — dist escape coverage.
  it('declares Rule C (src forbidden: packages/clickhouse-http, whole package directory)', () => {
    const entry = checkerSource.match(/\{\s*dir:\s*'src',\s*forbidden:\s*\[([^\]]*)\]/);
    expect(entry, 'Rule C entry missing from build/check-boundaries.mjs RULES').not.toBeNull();
    expect([...entry[1].matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(['packages/clickhouse-http']);
  });

  it('declares Rule D (deep imports banned everywhere; revised bare-specifier policy since issue #630 Phase 5)', () => {
    expect(checkerSource).toMatch(/CLICKHOUSE_HTTP_SPECIFIER/);
    expect(checkerSource).toMatch(/deep imports are forbidden everywhere/);
    // Issue #630 Phase 5 — the revised bare-specifier half must still call
    // the SAME shared real-parser helper this suite's own Rule D tests call,
    // and still special-case src/net/** as unrestricted.
    expect(checkerSource).toMatch(/from '\.\/lib\/check-legacy-owners\.mjs'/);
    expect(checkerSource).toMatch(/findPackageImportUsages\(/);
    expect(checkerSource).toMatch(/PHASE5_PACKAGE_LANGUAGE_EXPORTS/);
    expect(checkerSource).toMatch(/relFile\.startsWith\('src\/net\/'\)/);
    // Review pass 2 — the deep-import half must ALSO call the shared
    // real-parser helper, not the hand-rolled `extractSpecifiers` regex: a
    // comment sitting between `import`/`export` and the specifier defeated
    // that regex no matter how far its patterns were widened.
    expect(checkerSource).toMatch(/findDeepImportSpecifiers\(/);
  });

  // Review pass 2 finding — the drift bind above only proved the checker
  // still calls `findDeepImportSpecifiers`/`findPackageImportUsages`; it said
  // nothing about the CHEAP PRE-FILTER (`mightReferencePackage`) that gates
  // whether those real-parser calls even run. Until this test, that prefilter
  // was independently hand-copied here AND in the checker — two copies that
  // could drift, so a production-only regression back to the old
  // exact-substring-only gate (dropping the `|| source.includes('\\')` half)
  // would have left every escaped-specifier sabotage test in this file green,
  // since those tests exercised only this file's own copy, never
  // production's. Now both import the ONE implementation from
  // `build/lib/check-legacy-owners.mjs`, so this test pins that the checker
  // still imports and calls it, and never reintroduces a second inline copy.
  it('the deep-import/bare-specifier pre-filter (mightReferencePackage) is imported from the shared helper, not reimplemented inline', () => {
    const importBlock = checkerSource.match(/import \{([^}]*)\} from '\.\/lib\/check-legacy-owners\.mjs';/);
    expect(importBlock, 'check-legacy-owners import block missing from build/check-boundaries.mjs').not.toBeNull();
    expect(importBlock[1]).toMatch(/\bmightReferencePackage\b/);
    // Must actually CALL the shared helper, not merely import and shadow it.
    expect(checkerSource).toMatch(/=\s*mightReferencePackage\(/);
    // Guards exactly the regression this finding warned about: a
    // reintroduced inline exact-substring-only prefilter bypassing the
    // shared, escape-sequence-aware helper entirely.
    expect(checkerSource).not.toMatch(/const\s+\w+\s*=\s*source\.includes\(CLICKHOUSE_HTTP_SPECIFIER\)/);
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

  // Issue #630 Phase 5 — same drift-bind convention for the two new
  // former-owner rules this phase adds: the checker must still call the
  // shared helper (not a reintroduced text scanner) over the exact owner
  // file each rule protects.
  it('delegates the Phase 5 SQL-quote former-owner rule to build/lib/check-legacy-owners.mjs', () => {
    expect(checkerSource).toMatch(/findSqlQuoteOwnerViolations\(/);
    expect(checkerSource).toMatch(/for \(const relFile of PHASE5_SQL_QUOTE_OWNER_FILES\)/);
  });

  it('delegates the Phase 5 killQuery-stopgap former-owner rule to build/lib/check-legacy-owners.mjs', () => {
    expect(checkerSource).toMatch(/findKillStopgapOwnerViolations\(/);
    expect(checkerSource).toMatch(/for \(const relFile of PHASE5_KILL_STOPGAP_OWNER_FILES\)/);
  });

  it('the shared helper still names the exact Phase 5 owner files and moved-name sets', () => {
    expect([...PHASE5_SQL_QUOTE_OWNER_FILES]).toEqual(['src/core/format.ts']);
    expect([...PHASE5_SQL_QUOTE_MOVED_NAMES]).toEqual(['sqlString', 'BARE_IDENT', 'quoteIdent', 'qualifyIdent']);
    expect([...PHASE5_KILL_STOPGAP_OWNER_FILES]).toEqual(['packages/clickhouse-http/src/client.ts']);
    expect([...PHASE5_KILL_STOPGAP_MOVED_NAMES]).toEqual(['quoteKillQueryId']);
  });

  it('declares the Phase 5 deleted-implementation-file existence check for all three moved modules', () => {
    expect(checkerSource).toMatch(/PHASE5_DELETED_ROOT_FILES/);
    expect(checkerSource).toMatch(/src\/core\/clickhouse-type\.ts/);
    expect(checkerSource).toMatch(/src\/core\/sql-spans\.ts/);
    expect(checkerSource).toMatch(/src\/core\/quoted-span\.ts/);
  });

  // Issue #630 Phase 7 (Finding 2) — the checker must still wire the two
  // deleted-transport-path guards and the top-level retired-API-name guard
  // through the shared helper, not a reintroduced hand-rolled scanner.
  it('declares the Phase 7 deleted-transport-path existence check for both retired files', () => {
    expect(checkerSource).toMatch(/PHASE7_DELETED_TRANSPORT_FILES/);
    expect(checkerSource).toMatch(/for \(const relFile of PHASE7_DELETED_TRANSPORT_FILES\)/);
  });

  it('delegates the Phase 7 retired-top-level-API rule to build/lib/check-legacy-owners.mjs', () => {
    expect(checkerSource).toMatch(/from '\.\/lib\/check-legacy-owners\.mjs'/);
    expect(checkerSource).toMatch(/findRetiredTopLevelApiViolations\(/);
    expect(checkerSource).toMatch(/mightReferenceRetiredTopLevelApi\(/);
    expect(checkerSource).toMatch(/PHASE7_RETIRED_TOP_LEVEL_NAMES/);
  });

  it('the shared helper still names the exact Phase 7 retired top-level API names and deleted transport files', () => {
    expect([...PHASE7_RETIRED_TOP_LEVEL_NAMES]).toEqual([
      'runQuery',
      'RunQueryOptions',
      'RunQueryResult',
      'exportQuery',
      'ExportQueryOptions',
      'killQuery',
    ]);
    expect([...PHASE7_DELETED_TRANSPORT_FILES]).toEqual([
      'src/net/clickhouse-http-transport.ts',
      'src/net/clickhouse-transport.types.ts',
    ]);
  });
});

// Issue #630 Phase 5 — the moved implementation files must remain absent
// from SQL Browser src/**; a path-existence check, exercised directly here
// (mirroring the production checker's own mechanism) since there is no
// "helper" to call for a plain fs.existsSync check.
describe('the moved generic-grammar/scanner implementation files no longer exist under SQL Browser src/** (issue #630 Phase 5)', () => {
  it.each([
    'src/core/clickhouse-type.ts',
    'src/core/sql-spans.ts',
    'src/core/quoted-span.ts',
  ])('%s does not exist', (relFile) => {
    expect(existsSync(join(repoRoot, relFile))).toBe(false);
  });
});

// Issue #630 Phase 5 — the former-owner rule for the SQL-quoting helpers,
// exercised through the same shared helper the production checker calls.
describe('Phase 5 SQL-quote former-owner rule — src/core/format.ts cannot regain sqlString/BARE_IDENT/quoteIdent/qualifyIdent', () => {
  it('the real src/core/format.ts carries none of the moved declarations', () => {
    const text = readFileSync(join(repoRoot, 'src/core/format.ts'), 'utf8');
    expect(findSqlQuoteOwnerViolations(text, 'src/core/format.ts')).toEqual([]);
  });

  it('flags a re-added sqlString() function in format.ts (sabotage probe, not written to disk)', () => {
    const probe = "export function sqlString(s) { return \"'\" + String(s) + \"'\"; }";
    expect(findSqlQuoteOwnerViolations(probe, 'src/core/format.ts')).toEqual(['sqlString']);
  });

  it('flags a quoteIdent forwarding re-export in format.ts (sabotage probe, not written to disk)', () => {
    const probe = "import { quoteIdent } from '@altinity/clickhouse-http';\nexport { quoteIdent };\n";
    expect(findSqlQuoteOwnerViolations(probe, 'src/core/format.ts')).toEqual(['quoteIdent']);
  });

  it('flags a re-added private BARE_IDENT in format.ts (sabotage probe, not written to disk)', () => {
    const probe = 'const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;';
    expect(findSqlQuoteOwnerViolations(probe, 'src/core/format.ts')).toEqual(['BARE_IDENT']);
  });

  it('flags a re-added qualifyIdent wrapper delegating to the package implementation (sabotage probe, not written to disk)', () => {
    const probe = `
      import { qualifyIdent as packageQualifyIdent } from '@altinity/clickhouse-http';
      export function qualifyIdent(...parts) { return packageQualifyIdent(...parts); }
    `;
    expect(findSqlQuoteOwnerViolations(probe, 'src/core/format.ts')).toEqual(['qualifyIdent']);
  });

  it('is scoped to format.ts only — the same source under another filename is out of scope', () => {
    const probe = 'export function sqlString(s) { return s; }';
    expect(findSqlQuoteOwnerViolations(probe, 'src/core/variable-options.ts')).toEqual([]);
  });
});

// Issue #630 Phase 5 — the retired Phase-4 killQuery quoting stopgap must
// not return to the package's own client.ts.
describe('Phase 5 killQuery-stopgap former-owner rule — packages/clickhouse-http/src/client.ts cannot regain quoteKillQueryId', () => {
  it('the real package client.ts carries no quoteKillQueryId declaration', () => {
    const text = readFileSync(join(repoRoot, 'packages/clickhouse-http/src/client.ts'), 'utf8');
    expect(findKillStopgapOwnerViolations(text, 'packages/clickhouse-http/src/client.ts')).toEqual([]);
  });

  it('flags a re-added quoteKillQueryId() function (sabotage probe, not written to disk)', () => {
    const probe = "function quoteKillQueryId(queryId) { return \"'\" + queryId + \"'\"; }";
    expect(findKillStopgapOwnerViolations(probe, 'packages/clickhouse-http/src/client.ts')).toEqual(['quoteKillQueryId']);
  });

  it('does not flag the sanctioned sqlString import/use (a different identifier)', () => {
    const probe = "import { sqlString } from './sql-quote.js';\nconst x = sqlString('a');\n";
    expect(findKillStopgapOwnerViolations(probe, 'packages/clickhouse-http/src/client.ts')).toEqual([]);
  });
});

// Issue #630 Phase 7 (Finding 2) — the two local compatibility transport
// files must remain absent; same path-existence mechanism as the Phase 5
// deleted-implementation-file check above.
describe('the retired local compatibility transport files no longer exist under SQL Browser src/** (issue #630 Phase 7)', () => {
  it.each([...PHASE7_DELETED_TRANSPORT_FILES])('%s does not exist', (relFile) => {
    expect(existsSync(join(repoRoot, relFile))).toBe(false);
  });
});

// Issue #630 Phase 7 (Finding 2) — top-level resurrection guard for the
// retired generic runQuery/exportQuery/ordinary-killQuery APIs and their
// request/result types. Exercised through the SAME shared helper the
// production `check:arch` gate calls (`findRetiredTopLevelApiViolations`), a
// real TypeScript parse scoped to `sourceFile.statements` only (never a
// blanket identifier walk) — see that function's own doc comment in
// `build/lib/check-legacy-owners.mjs` for why this structurally cannot
// reject the frozen-lease cancellation path's legitimate
// `client.killQuery(...)` member call.
describe('Phase 7 retired-top-level-API rule — runQuery/exportQuery/ordinary killQuery cannot be resurrected', () => {
  it('the real src/** tree declares none of the retired top-level names', () => {
    expect(retiredApiViolations(join(repoRoot, 'src'))).toEqual([]);
  });

  it('the real src/net/ch-client.ts (killQueryWithLease\'s home) carries none of the retired declarations', () => {
    const text = readFileSync(join(repoRoot, 'src/net/ch-client.ts'), 'utf8');
    expect(findRetiredTopLevelApiViolations(text, 'src/net/ch-client.ts')).toEqual([]);
  });

  it('flags a top-level function declaration named runQuery (sabotage probe, not written to disk)', () => {
    const found = retiredApiViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630p7_runquery__.ts',
        'export async function runQuery(ctx, req) { return null; }\n'],
    ]);
    expect(found).toContain('src/net/__boundary_probe_630p7_runquery__.ts → runQuery');
  });

  it('flags a top-level function declaration named exportQuery (sabotage probe, not written to disk)', () => {
    const found = retiredApiViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630p7_exportquery__.ts', 'export function exportQuery() { return null; }\n'],
    ]);
    expect(found).toContain('src/net/__boundary_probe_630p7_exportquery__.ts → exportQuery');
  });

  it('flags a top-level function declaration named killQuery — the ordinary mutable-context signature (sabotage probe, not written to disk)', () => {
    const found = retiredApiViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630p7_killquery__.ts',
        'export async function killQuery(ctx, queryId, sqlStringFn) { return; }\n'],
    ]);
    expect(found).toContain('src/net/__boundary_probe_630p7_killquery__.ts → killQuery');
  });

  it('flags top-level RunQueryOptions/RunQueryResult/ExportQueryOptions type declarations (sabotage probe, not written to disk)', () => {
    const probe = [
      'export interface RunQueryOptions { sql: string; }',
      'export interface RunQueryResult { rows: unknown[]; }',
      'export interface ExportQueryOptions { sql: string; }',
    ].join('\n');
    const found = retiredApiViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630p7_types__.ts', probe],
    ]);
    expect(found).toEqual([
      'src/net/__boundary_probe_630p7_types__.ts → RunQueryOptions',
      'src/net/__boundary_probe_630p7_types__.ts → RunQueryResult',
      'src/net/__boundary_probe_630p7_types__.ts → ExportQueryOptions',
    ]);
  });

  it('flags a top-level const runQuery binding (sabotage probe, not written to disk)', () => {
    const found = retiredApiViolations(join(repoRoot, 'src'), [
      ['src/net/__boundary_probe_630p7_const__.ts', 'export const runQuery = async (ctx, req) => null;\n'],
    ]);
    expect(found).toContain('src/net/__boundary_probe_630p7_const__.ts → runQuery');
  });

  it('flags a forwarding re-export alias (export { foo as runQuery }) (sabotage probe, not written to disk)', () => {
    const probe = 'function foo() { return null; }\nexport { foo as runQuery };\n';
    expect(findRetiredTopLevelApiViolations(probe, 'src/net/ch-client.ts')).toEqual(['runQuery']);
  });

  it('flags a forwarding import alias (import { foo as exportQuery }) (sabotage probe, not written to disk)', () => {
    const probe = "import { foo as exportQuery } from './somewhere.js';\n";
    expect(findRetiredTopLevelApiViolations(probe, 'src/net/ch-client.ts')).toEqual(['exportQuery']);
  });

  // The exact carve-out the plan requires: a member-access call on the
  // package's own stateless client (`client.killQuery(...)`, the frozen-lease
  // cancellation path's real implementation) is a PropertyAccessExpression
  // nested inside a function body — never a top-level statement — so it
  // structurally cannot trip this check. No name-based exception needed.
  it('does NOT flag the legitimate client.killQuery(...) member call inside frozen-lease cancellation', () => {
    const probe = `
      export async function killQueryWithLease(lease, queryId) {
        if (!queryId) return;
        const client = createClickHouseHttpClient({ fetch: () => lease.fetch, origin: () => lease.origin });
        await client.killQuery({ queryId, authorization: lease.authorization });
      }
    `;
    expect(findRetiredTopLevelApiViolations(probe, 'src/net/ch-client.ts')).toEqual([]);
  });

  it('does not flag a comment merely narrating the deletion (comments are parser trivia, never AST nodes)', () => {
    const probe = '// runQuery/exportQuery/killQuery were all deleted this phase.\nexport function foo() {}\n';
    expect(findRetiredTopLevelApiViolations(probe, 'src/net/ch-client.ts')).toEqual([]);
  });

  it('does not flag a nested local function/variable named runQuery inside a function body (declaration-scoped, not a blanket identifier walk)', () => {
    const probe = `
      export function outer() {
        function runQuery() { return null; }
        const exportQuery = () => null;
        return runQuery() ?? exportQuery();
      }
    `;
    expect(findRetiredTopLevelApiViolations(probe, 'src/net/ch-client.ts')).toEqual([]);
  });
});

// Issue #630 Phase 8 (plan §18) — the narrow, named Rule-D exception: exactly
// `src/application/export-service.ts` may named-import exactly
// `findExceptionFrame`. No other application module gets protocol/client
// access — sabotaged below with an unrelated application module.
describe('Phase 8 narrow Rule-D exception — only export-service.ts may import findExceptionFrame outside src/net/**', () => {
  it('the real export-service.ts import is clean under the revised policy (no violation reported for its own findExceptionFrame import)', () => {
    const text = readFileSync(join(repoRoot, 'src/application/export-service.ts'), 'utf8');
    expect(findPackageImportUsages(text, 'src/application/export-service.ts', CLICKHOUSE_HTTP_SPECIFIER).length).toBeGreaterThan(0);
    expect(packageNameShapeViolations(join(repoRoot, 'src')).some((l) => l.startsWith('src/application/export-service.ts'))).toBe(false);
  });

  it('the real export-service.ts imports findExceptionFrame directly from the package (not through a ch-client.ts gateway)', () => {
    const text = readFileSync(join(repoRoot, 'src/application/export-service.ts'), 'utf8');
    expect(/import\s*\{[^}]*\bfindExceptionFrame\b[^}]*\}\s*from\s*['"]@altinity\/clickhouse-http['"]/.test(text)).toBe(true);
  });

  it('flags an unrelated application module importing findExceptionFrame outside src/net/** (sabotage probe, not written to disk)', () => {
    const found = packageNameShapeViolations(join(repoRoot, 'src'), [
      ['src/application/__boundary_probe_630p8_unrelated_findexceptionframe__.ts',
        "import { findExceptionFrame } from '@altinity/clickhouse-http';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_630p8_unrelated_findexceptionframe__'))).toBe(true);
  });

  it('the exception is scoped by exact name too — export-service.ts may not import an unrelated transport export under the same exception (sabotage probe, not written to disk)', () => {
    // A virtual probe under the exact exception filename, but naming a
    // DIFFERENT transport export — the allowlist is per-name, not per-file.
    const relFile = 'src/application/export-service.ts';
    const source = "import { createClickHouseHttpClient } from '@altinity/clickhouse-http';\n";
    const narrowExceptionNames = PHASE8_NARROW_RULE_D_EXCEPTIONS[relFile] ?? [];
    const usages = findPackageImportUsages(source, relFile, CLICKHOUSE_HTTP_SPECIFIER);
    const stillViolates = usages.some((usage) => usage.kind === 'named'
      && !PHASE5_PACKAGE_LANGUAGE_EXPORTS.includes(usage.name)
      && !narrowExceptionNames.includes(usage.name));
    expect(stillViolates).toBe(true);
  });
});

// Issue #630 Phase 8 (plan §20, Guard 1) — package containment, broadened to
// the package's own tooling/test surface (test/**, build.mjs,
// vitest.config.ts), exercised through the SAME real-parser helper
// (`findModuleSpecifiers`) the production `check:arch` gate calls.
describe('Guard 1 — package tooling/tests cannot escape the package root or silently consume an undeclared root-hoisted dependency', () => {
  const packageManifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
  const declaredDevDeps = new Set(Object.keys(packageManifest.devDependencies ?? {}));

  it('the real package test/**, build.mjs, and vitest.config.ts are clean', () => {
    const offenders = [];
    for (const target of ['test', 'build.mjs', 'vitest.config.ts']) {
      const full = join(PACKAGE_DIR, target);
      const files = statSync(full).isDirectory() ? collectFiles(full) : [full];
      for (const file of files) {
        const relFile = relative(repoRoot, file).split(sep).join('/');
        const text = readFileSync(file, 'utf8');
        for (const { spec } of findModuleSpecifiers(text, relFile)) {
          if (spec.startsWith('.')) {
            const resolved = resolveRelative(file, spec);
            const relResolved = relative(repoRoot, resolved).split(sep).join('/');
            if (relResolved !== 'packages/clickhouse-http' && !relResolved.startsWith('packages/clickhouse-http/')) {
              offenders.push(`${relFile} → ${spec}`);
            }
            continue;
          }
          if (spec === packageManifest.name) continue;
          if (spec === 'node' || spec.startsWith('node:') || declaredDevDeps.has(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])) continue;
          offenders.push(`${relFile} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('flags a package test escaping the package root with a deep relative import (sabotage probe, not written to disk)', () => {
    const relFile = 'packages/clickhouse-http/test/unit/__boundary_probe_630p8_guard1_test__.ts';
    const source = "import { something } from '../../../../src/application/does-not-exist.js';\n";
    const specs = findModuleSpecifiers(source, relFile);
    const escapes = specs.some(({ spec }) => {
      if (!spec.startsWith('.')) return false;
      const resolved = resolveRelative(join(repoRoot, relFile), spec);
      const relResolved = relative(repoRoot, resolved).split(sep).join('/');
      return relResolved !== 'packages/clickhouse-http' && !relResolved.startsWith('packages/clickhouse-http/');
    });
    expect(escapes).toBe(true);
  });

  it('flags a package build.mjs escaping the package root into root build/** (sabotage probe, not written to disk)', () => {
    const relFile = 'packages/clickhouse-http/build.mjs';
    const source = "import { buildArtifact } from '../../build/build.mjs';\n";
    const specs = findModuleSpecifiers(source, relFile);
    const escapes = specs.some(({ spec }) => {
      if (!spec.startsWith('.')) return false;
      const resolved = resolveRelative(join(repoRoot, relFile), spec);
      const relResolved = relative(repoRoot, resolved).split(sep).join('/');
      return relResolved !== 'packages/clickhouse-http' && !relResolved.startsWith('packages/clickhouse-http/');
    });
    expect(escapes).toBe(true);
  });

  it('flags a package test bare-importing an undeclared root-hoisted dependency (sabotage probe, not written to disk)', () => {
    const relFile = 'packages/clickhouse-http/test/unit/__boundary_probe_630p8_guard1_hoisted__.ts';
    const source = "import { signal } from '@preact/signals-core';\n";
    const specs = findModuleSpecifiers(source, relFile);
    const undeclared = specs.some(({ spec }) => {
      if (spec.startsWith('.')) return false;
      if (spec === packageManifest.name) return false;
      if (spec === 'node' || spec.startsWith('node:')) return false;
      const bareRoot = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      return !declaredDevDeps.has(bareRoot);
    });
    expect(undeclared).toBe(true);
  });

  it('does not flag a package test bare-importing its own declared devDependency (e.g. vitest)', () => {
    const relFile = 'packages/clickhouse-http/test/unit/__boundary_probe_630p8_guard1_declared__.ts';
    const source = "import { describe } from 'vitest';\n";
    const specs = findModuleSpecifiers(source, relFile);
    const undeclared = specs.some(({ spec }) => {
      if (spec.startsWith('.')) return false;
      if (spec === packageManifest.name) return false;
      if (spec === 'node' || spec.startsWith('node:')) return false;
      const bareRoot = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      return !declaredDevDeps.has(bareRoot);
    });
    expect(undeclared).toBe(false);
  });
});

// Issue #630 Phase 8 (plan §22/§23, Guards 3/4) — root-wide top-level
// declaration/re-export ownership for the historical generic transport/URL
// surface and the moved progress-stream/exception-parsing primitives,
// exercised through `findTransportSurfaceOwnershipViolations` — the SAME
// helper the production `check:arch` gate calls.
describe('Guards 3/4 — the historical generic transport/URL surface and the moved parser primitives cannot be redeclared or forwarded locally', () => {
  const guard34Names = [...PHASE8_TRANSPORT_SURFACE_NAMES, ...PHASE8_PARSER_SURFACE_NAMES];

  it('the real src/** tree declares none of the guarded names locally', () => {
    const offenders = [];
    for (const file of collectFiles(join(repoRoot, 'src'))) {
      const relFile = relative(repoRoot, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');
      if (!mightReferenceRetiredTopLevelApi(text, guard34Names)) continue;
      for (const name of findTransportSurfaceOwnershipViolations(text, relFile, guard34Names, CLICKHOUSE_HTTP_SPECIFIER)) {
        offenders.push(`${relFile} → ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the real src/net/authenticated-clickhouse-request.ts legitimately imports chUrl/streamLines/parseExceptionText from the package without tripping the guard', () => {
    const text = readFileSync(join(repoRoot, 'src/net/authenticated-clickhouse-request.ts'), 'utf8');
    expect(findTransportSurfaceOwnershipViolations(text, 'src/net/authenticated-clickhouse-request.ts', guard34Names, CLICKHOUSE_HTTP_SPECIFIER)).toEqual([]);
  });

  it('flags a root local chUrl() function declaration (sabotage probe, not written to disk)', () => {
    const probe = 'export function chUrl(origin, opts) { return origin; }\n';
    expect(findTransportSurfaceOwnershipViolations(probe, 'src/net/__boundary_probe_630p8_localchurl__.ts', guard34Names, CLICKHOUSE_HTTP_SPECIFIER))
      .toEqual(['chUrl']);
  });

  it('flags a root local createHttpTransport() function declaration (sabotage probe, not written to disk)', () => {
    const probe = 'export function createHttpTransport(deps) { return { send() {} }; }\n';
    expect(findTransportSurfaceOwnershipViolations(probe, 'src/net/__boundary_probe_630p8_createhttptransport__.ts', guard34Names, CLICKHOUSE_HTTP_SPECIFIER))
      .toEqual(['createHttpTransport']);
  });

  it('flags a chUrl import whose specifier is NOT the package (a forwarding-alias vector) (sabotage probe, not written to disk)', () => {
    const probe = "import { foo as chUrl } from './somewhere.js';\n";
    expect(findTransportSurfaceOwnershipViolations(probe, 'src/net/__boundary_probe_630p8_churlalias__.ts', guard34Names, CLICKHOUSE_HTTP_SPECIFIER))
      .toEqual(['chUrl']);
  });

  it('does NOT flag a chUrl named import whose specifier IS the package (the sanctioned Rule-D route)', () => {
    const probe = "import { chUrl } from '@altinity/clickhouse-http';\nchUrl('https://x');\n";
    expect(findTransportSurfaceOwnershipViolations(probe, 'src/net/__boundary_probe_630p8_churlsanctioned__.ts', guard34Names, CLICKHOUSE_HTTP_SPECIFIER))
      .toEqual([]);
  });

  it('flags a root duplicate streamLines forwarding-alias vector (sabotage probe, not written to disk)', () => {
    const probe = "import { foo as streamLines } from './somewhere.js';\n";
    expect(findTransportSurfaceOwnershipViolations(probe, 'src/core/__boundary_probe_630p8_streamlinesalias__.ts', guard34Names, CLICKHOUSE_HTTP_SPECIFIER))
      .toEqual(['streamLines']);
  });

  it('flags a root duplicate findExceptionFrame() function declaration (sabotage probe, not written to disk)', () => {
    const probe = 'export function findExceptionFrame(tailBytes, tag) { return null; }\n';
    expect(findTransportSurfaceOwnershipViolations(probe, 'src/core/__boundary_probe_630p8_findexceptionframedup__.ts', guard34Names, CLICKHOUSE_HTTP_SPECIFIER))
      .toEqual(['findExceptionFrame']);
  });

  it('flags a re-export gateway forwarding streamLines, regardless of specifier (sabotage probe, not written to disk)', () => {
    const probe = "export { streamLines } from '@altinity/clickhouse-http';\n";
    expect(findTransportSurfaceOwnershipViolations(probe, 'src/net/__boundary_probe_630p8_streamlinesreexport__.ts', guard34Names, CLICKHOUSE_HTTP_SPECIFIER))
      .toEqual(['streamLines']);
  });

  it('restoring the retired ch-client.ts forwarding gateway (export { chUrl, parseExceptionText, findExceptionFrame }) trips the guard (sabotage probe, not written to disk)', () => {
    const probe = "export { chUrl, parseExceptionText, findExceptionFrame };\n";
    expect(findTransportSurfaceOwnershipViolations(probe, 'src/net/__boundary_probe_630p8_restoredgateway__.ts', guard34Names, CLICKHOUSE_HTTP_SPECIFIER))
      .toEqual(['chUrl', 'parseExceptionText', 'findExceptionFrame']);
  });

  it('does not flag a nested local function/variable inside a function body (declaration-scoped, not a blanket identifier walk)', () => {
    const probe = `
      export function outer() {
        function chUrl() { return null; }
        return chUrl();
      }
    `;
    expect(findTransportSurfaceOwnershipViolations(probe, 'src/net/__boundary_probe_630p8_nested__.ts', guard34Names, CLICKHOUSE_HTTP_SPECIFIER))
      .toEqual([]);
  });
});

// The Guard 1/3/4 describe blocks above only prove today's tree is clean and
// that the shared real-parser helpers this file calls behave correctly —
// exactly the same gap the Rules A-D drift-bind block above (this file,
// around line 1011) exists to close for the older rules. Neither proves
// `build/check-boundaries.mjs` (the actual `check:arch` gate) still wires
// those helpers into its own Guard 1/3/4 rule blocks: a refactor could delete
// those blocks from the checker entirely while every test above kept passing,
// since they call the helpers directly rather than the checker. Same
// `checkerSource`-text-read convention as the Rules A-D block and
// `client-web-retirement-policy.test.js`'s Guard 5 equivalent.
describe('build/check-boundaries.mjs still declares the Guard 1/3/4 rule blocks this spec mirrors (issue #630 Phase 8)', () => {
  const checkerSource = readFileSync(join(repoRoot, 'build/check-boundaries.mjs'), 'utf8');

  it('declares the Guard 1 package-containment/tooling-dependency rule block', () => {
    // build/check-boundaries.mjs:549 — the exact four-target list Guard 1
    // scans (packages/clickhouse-http/{src,test,build.mjs,vitest.config.ts}).
    expect(checkerSource).toMatch(/guard1Targets\s*=\s*\['src',\s*'test',\s*'build\.mjs',\s*'vitest\.config\.ts'\]/);
    // build/check-boundaries.mjs:563 — the package-root-escape violation
    // message, only emitted by the Guard 1 relative-import check.
    expect(checkerSource).toMatch(/issue #630 Phase 8 Guard 1: a relative import cannot escape the package root/);
    // build/check-boundaries.mjs:576 — the undeclared-root-hoisted-dependency
    // violation message, only emitted by the Guard 1 bare-specifier check.
    expect(checkerSource).toMatch(/issue #630 Phase 8 Guard 1: package tooling\/tests may bare-import only node:\* or a dependency declared in the package's own devDependencies/);
  });

  it('declares the Guards 3/4 root-wide transport/parser-surface ownership rule block', () => {
    // build/check-boundaries.mjs:600 — the combined name list Guards 3/4
    // scan for, and the two real-parser helper calls it feeds (:605-:606).
    expect(checkerSource).toMatch(/guard34Names\s*=\s*\[\.\.\.PHASE8_TRANSPORT_SURFACE_NAMES,\s*\.\.\.PHASE8_PARSER_SURFACE_NAMES\]/);
    expect(checkerSource).toMatch(/mightReferenceRetiredTopLevelApi\(source,\s*guard34Names\)/);
    expect(checkerSource).toMatch(/findTransportSurfaceOwnershipViolations\(source,\s*relFile,\s*guard34Names,\s*CLICKHOUSE_HTTP_SPECIFIER\)/);
    // build/check-boundaries.mjs:607 — the violation message, only emitted
    // by this exact block.
    expect(checkerSource).toMatch(/issue #630 Phase 8 Guards 3\/4: the historical generic transport\/URL surface and the moved progress-stream\/exception-parsing primitives cannot be re-declared or forwarded locally/);
  });
});

// Issue #630 Phase 8 (plan §10, §25's "production wrapper build-order
// invariants") — every clean production build wrapper must build the
// package's own dist/** before invoking the root application builder.
// Exercised as a virtual/text composition check (not a real shell
// invocation — the real clean-state proof was run manually per the plan's
// §10.3/§38 acceptance sequence) so the sabotage case is a plain string, not
// a mutation of the real file.
function buildsPackageBeforeAppBuild(scriptText) {
  const prereqIndex = scriptText.indexOf('build:clickhouse-http');
  const appBuildIndex = scriptText.indexOf('build/build.mjs');
  return prereqIndex !== -1 && appBuildIndex !== -1 && prereqIndex < appBuildIndex;
}

describe('production wrapper build-order invariant — build:clickhouse-http must precede build/build.mjs', () => {
  it('the real build/bundle.sh builds the package before the app build', () => {
    const text = readFileSync(join(repoRoot, 'build/bundle.sh'), 'utf8');
    expect(buildsPackageBeforeAppBuild(text)).toBe(true);
  });

  it('the real deploy/install.sh builds the package before the app build', () => {
    const text = readFileSync(join(repoRoot, 'deploy/install.sh'), 'utf8');
    expect(buildsPackageBeforeAppBuild(text)).toBe(true);
  });

  it('flags a virtual bundle.sh composition with the package-build line removed (sabotage probe, not written to disk)', () => {
    const sabotaged = 'echo "==> Building SPA"\nASB_VERSION="$VERSION" node "$ROOT/build/build.mjs"\n';
    expect(buildsPackageBeforeAppBuild(sabotaged)).toBe(false);
  });

  it('flags a virtual install.sh composition with the package-build line removed (sabotage probe, not written to disk)', () => {
    const sabotaged = 'echo "==> Building dist/sql.html"\nnode "$ROOT/build/build.mjs"\n';
    expect(buildsPackageBeforeAppBuild(sabotaged)).toBe(false);
  });

  it('flags a virtual composition where the package build line comes AFTER the app build (wrong order, sabotage probe, not written to disk)', () => {
    const sabotaged = 'node "$ROOT/build/build.mjs"\nnpm --prefix "$ROOT" run build:clickhouse-http\n';
    expect(buildsPackageBeforeAppBuild(sabotaged)).toBe(false);
  });

  it('root package.json composes build:clickhouse-http as a prerequisite of build/size-report/dev/local/test', () => {
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    for (const script of ['build', 'size-report', 'dev', 'local', 'test', 'test:watch']) {
      expect(rootPkg.scripts[script], `scripts.${script} missing`).toMatch(/npm run build:clickhouse-http/);
    }
    expect(rootPkg.scripts['check:types']).toMatch(/npm run check:types --workspace @altinity\/clickhouse-http/);
  });
});
