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
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function relativeSpecifiers(file) {
  const source = readFileSync(file, 'utf8');
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

function violations(dir, forbidden = FORBIDDEN) {
  const abs = join(repoRoot, dir);
  const found = [];
  for (const file of collectFiles(abs)) {
    for (const spec of relativeSpecifiers(file)) {
      const resolved = resolveSpec(file, spec);
      const hit = forbidden.find((f) => resolved === f || resolved.startsWith(`${f}/`));
      if (hit) found.push(`${relative(repoRoot, file)} → ${spec} (${hit})`);
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
  // regression. Plant a real, throwaway file with a forbidden import inside
  // src/core, confirm the same detection logic flags it, then remove it
  // regardless of outcome so the source tree is left exactly as found.
  it('flags a src/core import that reaches into src/workspace (proves the rule above is not vacuous)', () => {
    const probe = join(repoRoot, 'src/core/__boundary_probe_455__.ts');
    writeFileSync(probe, "import { nothing } from '../workspace/does-not-exist.js';\nexport const probe = nothing;\n");
    try {
      const found = violations('src/core', FORBIDDEN_CORE);
      expect(found.some((line) => line.includes('__boundary_probe_455__') && line.includes('src/workspace'))).toBe(true);
    } finally {
      unlinkSync(probe);
    }
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
