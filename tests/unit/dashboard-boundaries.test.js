// Dependency-boundary tests (#286): the Dashboard model and application layers
// — including the DashboardViewerSession — must be constructible and testable
// without the Workbench UI, the full App controller, global AppState, the
// CodeMirror editors, the src/application services, or the src/net client. This
// mirrors (and double-checks in the unit suite) the `build/check-boundaries.mjs`
// pretest guard: a regression here fails `npm test`, not just `check:arch`.
//
// Node-tooling spec (kept .js like schema-build.test.js / spec-examples.test.js:
// typing the node: imports would need @types/node — a deferred decision).

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDynamicImportUsages, mightContainDynamicImport } from '../../build/lib/check-legacy-owners.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;

const FORBIDDEN = [
  'src/ui', 'src/editor', 'src/application', 'src/state.ts', 'src/net', 'src/main.ts',
];

// Issue #455: src/core is a pure, reusable-logic leaf — it must not depend on
// workspace, application, UI, or network layers (mirrors the
// `build/check-boundaries.mjs` RULES entry added for #455). Deliberately
// narrower than FORBIDDEN above: `src/editor` is NOT listed, because
// `core/saved-io.ts` keeps a documented legacy type-only import from
// `editor/spec-editor.types.js`.
const FORBIDDEN_CORE = ['src/workspace', 'src/application', 'src/ui', 'src/net'];

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

const SPECIFIER = /\bimport\s+(?:type\s+)?[\w*{}\s,]*\s*from\s*['"]([^'"]+)['"]|\bexport\s+(?:type\s+)?[\w*{}\s,]*\s*from\s*['"]([^'"]+)['"]/g;

function relativeSpecifiers(file, sourceOverride) {
  const source = sourceOverride ?? readFileSync(file, 'utf8');
  const specs = [];
  let match;
  SPECIFIER.lastIndex = 0;
  while ((match = SPECIFIER.exec(source))) {
    const spec = match[1] || match[2];
    if (spec && spec.startsWith('.')) specs.push(spec);
  }
  return specs;
}

function resolveSpec(fromFile, spec) {
  const target = resolve(dirname(fromFile), spec);
  const noExt = target.replace(SOURCE_EXT, '');
  const candidates = [target, `${noExt}.ts`, `${noExt}.js`, join(target, 'index.ts'), join(target, 'index.js')];
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? target;
  return relative(repoRoot, found).split('\\').join('/');
}

/** `virtualFiles` are `[repoRelativePath, source]` pairs checked alongside the
 *  real ones on disk. They let a sabotage probe exercise this walk without
 *  writing a file into the working tree (#554 review): the previous probe
 *  created and deleted a real `src/core/*.ts`, which a crash or a kill between
 *  write and `unlink` would have left behind, and which file watchers see. */
function violations(dir, forbidden = FORBIDDEN, virtualFiles = []) {
  const abs = join(repoRoot, dir);
  const found = [];
  const entries = [
    ...collectFiles(abs).map((file) => [file, undefined]),
    ...virtualFiles.map(([rel, source]) => [join(repoRoot, rel), source]),
  ];
  for (const [file, source] of entries) {
    for (const spec of relativeSpecifiers(file, source)) {
      const resolved = resolveSpec(file, spec);
      const hit = forbidden.find((f) => resolved === f || resolved.startsWith(`${f}/`));
      if (hit) found.push(`${relative(repoRoot, file)} → ${spec} (${hit})`);
    }
    // Issue #642: combine the existing static relative-specifier path above
    // with the shared parser-backed dynamic-import classifier — a `static`
    // dynamic import is resolved and checked exactly like an ordinary
    // relative import; an `uncheckable` one (identifier, computed template,
    // concatenation, conditional, or any other non-literal argument shape)
    // is an explicit, unconditional finding, independent of where it might
    // have resolved.
    const text = source ?? readFileSync(file, 'utf8');
    if (!mightContainDynamicImport(text)) continue;
    const relFile = relative(repoRoot, file).split('\\').join('/');
    for (const usage of findDynamicImportUsages(text, relFile)) {
      if (usage.kind === 'uncheckable') {
        found.push(`${relative(repoRoot, file)} → dynamic import(...) (uncheckable)`);
        continue;
      }
      if (!usage.spec.startsWith('.')) continue; // bare/package specifiers can't reach the forbidden dirs
      const resolved = resolveSpec(file, usage.spec);
      const hit = forbidden.find((f) => resolved === f || resolved.startsWith(`${f}/`));
      if (hit) found.push(`${relative(repoRoot, file)} → ${usage.spec} (${hit})`);
    }
  }
  return found;
}

describe('dashboard dependency boundaries', () => {
  it('src/dashboard/application imports no Workbench UI / App / AppState / editor / service / net modules', () => {
    expect(violations('src/dashboard/application')).toEqual([]);
  });

  it('src/dashboard/model imports no Workbench UI / App / AppState / editor / service / net modules', () => {
    expect(violations('src/dashboard/model')).toEqual([]);
  });

  it('src/dashboard/layouts imports no Workbench UI / App / AppState / editor / service / net modules', () => {
    expect(violations('src/dashboard/layouts')).toEqual([]);
  });

  it('the DashboardViewerSession specifically declares its own narrow seams', () => {
    const file = join(repoRoot, 'src/dashboard/application/dashboard-viewer-session.ts');
    const specs = relativeSpecifiers(file).map((spec) => resolveSpec(file, spec));
    expect(specs.some((spec) => FORBIDDEN.some((f) => spec === f || spec.startsWith(`${f}/`)))).toBe(false);
  });

  // #407: the live workspace aggregate is the Dashboard viewer's persistence
  // layer. It remains constructible without UI/App/editor/service/net modules.
  it('src/workspace imports no Workbench UI / App / AppState / editor / service / net modules', () => {
    expect(violations('src/workspace')).toEqual([]);
  });

  // #455: src/core is a pure, reusable-logic leaf and must not depend on
  // workspace, application, UI, or network layers (the invariant
  // `src/application/main-surface.ts` documents, and `build/check-boundaries.mjs`
  // now mechanically enforces via its own RULES entry).
  it('src/core imports no workspace / application / UI / net modules', () => {
    expect(violations('src/core', FORBIDDEN_CORE)).toEqual([]);
  });

  // Sabotage check: the check above only proves the CURRENT tree is clean —
  // it says nothing about whether the detector would actually catch a
  // regression. Feed the same walk a virtual `src/core` file with a forbidden
  // import and confirm it is flagged. Virtual, not written to disk, so the
  // working tree is never touched even if this process dies mid-test.
  it('flags a src/core import that reaches into src/workspace (proves the rule above is not vacuous)', () => {
    const found = violations('src/core', FORBIDDEN_CORE, [
      ['src/core/__boundary_probe_455__.ts', "import { nothing } from '../workspace/does-not-exist.js';\n"],
    ]);
    expect(found.some((line) => line.includes('__boundary_probe_455__') && line.includes('src/workspace'))).toBe(true);
  });

  // ...and the walk above is only a MIRROR of the real gate, which lives in
  // `build/check-boundaries.mjs`. A mirror can drift from what it mirrors: with
  // the `src/core` entry deleted from the production `RULES`, this entire spec
  // stayed green (60/60) and `check:arch` happily reported "OK … 8 active
  // rules" — #455's whole deliverable was removable without a single failure
  // (#554 review). Bind the two so that cannot happen silently.
  //
  // Read as TEXT rather than imported on purpose: `check-boundaries.mjs` runs
  // its entire check at module top level and exits non-zero on violations, so
  // importing it here would run the production gate inside the test process.
  it('build/check-boundaries.mjs still declares the src/core rule this spec mirrors (#455)', () => {
    const checkerSource = readFileSync(join(repoRoot, 'build/check-boundaries.mjs'), 'utf8');
    const entry = checkerSource.match(/\{\s*dir:\s*'src\/core',\s*forbidden:\s*\[([^\]]*)\]/);
    expect(entry, "build/check-boundaries.mjs has no `dir: 'src/core'` rule — #455 regressed").not.toBeNull();
    const forbidden = [...entry[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(forbidden.slice().sort()).toEqual(FORBIDDEN_CORE.slice().sort());
  });

  // Issue #642 — computed/non-static dynamic imports must fail closed under
  // the same generic guarded-directory rule a static import already obeys.
  // Every probe below is virtual (never written to disk), matching this
  // file's own #554 convention.
  describe('issue #642 — dynamic import(...) fails closed for src/core (mirrors build/check-boundaries.mjs)', () => {
    it('flags a single-quoted dynamic import into src/workspace', () => {
      const found = violations('src/core', FORBIDDEN_CORE, [
        ['src/core/__boundary_probe_642_single__.ts',
          "export async function f() { await import('../workspace/does-not-exist.js'); }\n"],
      ]);
      expect(found.some((line) => line.includes('__boundary_probe_642_single__') && line.includes('src/workspace'))).toBe(true);
    });

    it('flags a double-quoted dynamic import into src/workspace', () => {
      const found = violations('src/core', FORBIDDEN_CORE, [
        ['src/core/__boundary_probe_642_double__.ts',
          'export async function f() { await import("../workspace/does-not-exist.js"); }\n'],
      ]);
      expect(found.some((line) => line.includes('__boundary_probe_642_double__') && line.includes('src/workspace'))).toBe(true);
    });

    it('flags a no-substitution-template dynamic import into src/workspace', () => {
      const found = violations('src/core', FORBIDDEN_CORE, [
        ['src/core/__boundary_probe_642_template__.ts',
          'export async function f() { await import(`../workspace/does-not-exist.js`); }\n'],
      ]);
      expect(found.some((line) => line.includes('__boundary_probe_642_template__') && line.includes('src/workspace'))).toBe(true);
    });

    it('rejects a computed template-literal dynamic import as uncheckable', () => {
      const found = violations('src/core', FORBIDDEN_CORE, [
        ['src/core/__boundary_probe_642_computed__.ts',
          'export async function f(name) { await import(`../workspace/${name}.js`); }\n'],
      ]);
      expect(found.some((line) => line.includes('__boundary_probe_642_computed__') && line.includes('uncheckable'))).toBe(true);
    });

    it('rejects an identifier-argument dynamic import as uncheckable', () => {
      const found = violations('src/core', FORBIDDEN_CORE, [
        ['src/core/__boundary_probe_642_identifier__.ts',
          'export async function f(specifier) { await import(specifier); }\n'],
      ]);
      expect(found.some((line) => line.includes('__boundary_probe_642_identifier__') && line.includes('uncheckable'))).toBe(true);
    });

    it('rejects a concatenated dynamic import as uncheckable — never reduced to its quoted prefix', () => {
      const found = violations('src/core', FORBIDDEN_CORE, [
        ['src/core/__boundary_probe_642_concat__.ts',
          "export async function f(name) { await import('../workspace/' + name); }\n"],
      ]);
      expect(found.some((line) => line.includes('__boundary_probe_642_concat__') && line.includes('uncheckable'))).toBe(true);
      // Regression: must never resolve to (or report) the quoted prefix alone.
      expect(found.some((line) => line.includes('__boundary_probe_642_concat__') && line.includes("→ '../workspace/'"))).toBe(false);
    });

    it('rejects a conditional-expression dynamic import as uncheckable', () => {
      const found = violations('src/core', FORBIDDEN_CORE, [
        ['src/core/__boundary_probe_642_conditional__.ts',
          "export async function f(cond) { await import(cond ? '../workspace/a.js' : '../workspace/b.js'); }\n"],
      ]);
      expect(found.some((line) => line.includes('__boundary_probe_642_conditional__') && line.includes('uncheckable'))).toBe(true);
    });

    it('accepts a direct dynamic import resolving within an allowed layer', () => {
      const found = violations('src/core', FORBIDDEN_CORE, [
        ['src/core/__boundary_probe_642_legal__.ts',
          "export async function f() { await import('./format.js'); }\n"],
      ]);
      expect(found.some((line) => line.includes('__boundary_probe_642_legal__'))).toBe(false);
    });

    // Regression coverage for the required static export forms — these must
    // continue through the existing static fast path, not the new dynamic
    // parser helper, and must still be rejected when they cross the boundary.
    it('flags export * from crossing a forbidden boundary (regression)', () => {
      const found = violations('src/core', FORBIDDEN_CORE, [
        ['src/core/__boundary_probe_642_exportstar__.ts', "export * from '../workspace/does-not-exist.js';\n"],
      ]);
      expect(found.some((line) => line.includes('__boundary_probe_642_exportstar__') && line.includes('src/workspace'))).toBe(true);
    });

    it('flags export { name } from crossing a forbidden boundary (regression)', () => {
      const found = violations('src/core', FORBIDDEN_CORE, [
        ['src/core/__boundary_probe_642_exportnamed__.ts', "export { nothing } from '../workspace/does-not-exist.js';\n"],
      ]);
      expect(found.some((line) => line.includes('__boundary_probe_642_exportnamed__') && line.includes('src/workspace'))).toBe(true);
    });

    it('flags export * as ns from crossing a forbidden boundary (regression)', () => {
      const found = violations('src/core', FORBIDDEN_CORE, [
        ['src/core/__boundary_probe_642_exportnamespace__.ts', "export * as ns from '../workspace/does-not-exist.js';\n"],
      ]);
      expect(found.some((line) => line.includes('__boundary_probe_642_exportnamespace__') && line.includes('src/workspace'))).toBe(true);
    });

    // Drift bind: proves `build/check-boundaries.mjs` itself — not just this
    // mirror — actually classifies dynamic imports through the shared
    // real-parser helpers and no longer carries the old dynamic-import regex
    // arm this issue retires.
    it('build/check-boundaries.mjs classifies dynamic imports via the shared parser-backed helper and fails closed (#642)', () => {
      const checkerSource = readFileSync(join(repoRoot, 'build/check-boundaries.mjs'), 'utf8');
      const importBlock = checkerSource.match(/import \{([^}]*)\} from '\.\/lib\/check-legacy-owners\.mjs';/);
      expect(importBlock, 'check-legacy-owners import block missing from build/check-boundaries.mjs').not.toBeNull();
      expect(importBlock[1]).toMatch(/\bfindDynamicImportUsages\b/);
      expect(importBlock[1]).toMatch(/\bmightContainDynamicImport\b/);
      expect(checkerSource).toMatch(/findDynamicImportUsages\(/);
      expect(checkerSource).toMatch(/mightContainDynamicImport\(/);
      expect(checkerSource).toMatch(/cannot be statically checked against the architecture boundary/);
      // The old dynamic-import regex arm (matching a `` ` ``/'/" -delimited
      // argument directly against a `\bimport\s*\(` prefix) must be gone.
      expect(checkerSource.includes("[`'\"]([^`'\"]+)[`'\"]")).toBe(false);
    });
  });

  it('does not restore the retired saved-query repair planner or its vocabulary', () => {
    const retiredPath = ['saved-query', 'mutation.ts'].join('-');
    expect(existsSync(join(repoRoot, 'src/dashboard/application', retiredPath))).toBe(false);
    const retiredTerms = [
      ['plan', 'SavedQuery', 'Mutation'].join(''),
      ['suggest', 'Repairs'].join(''),
      ['SavedQuery', 'Repair'].join(''),
      ['remove', '-affected', '-tiles'].join(''),
    ];
    const hits = [];
    for (const file of [...collectFiles(join(repoRoot, 'src')), ...collectFiles(join(repoRoot, 'tests'))]) {
      const source = readFileSync(file, 'utf8');
      for (const term of retiredTerms) {
        if (source.includes(term)) hits.push(`${relative(repoRoot, file)} → ${term}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
