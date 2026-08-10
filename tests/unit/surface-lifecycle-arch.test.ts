// #590 §1.9 / invariant (k) — the static-source architecture test backing the
// surface-retirement coordinator's "no lifecycle bypass outside the
// coordinator" claim, at the strength each layer honestly has (pass-7
// narrowing): compile-time elimination is already covered by
// `surface-accessor-contracts.test.ts`'s `@ts-expect-error` fixtures (the
// asymmetric `currentWorkspace` setter, the narrowed structural ports); THIS
// test is the third, weakest layer — a real-TypeScript-parser-backed scan
// over `src/**` production sources (#643; see below), the same idiom
// `build/check-boundaries.mjs` (mechanical dependency-direction checks) and
// `typography-contract.test.js` (reading `src/styles.css` directly) already
// use in this repo. It fails the build on:
//   (a) an out-of-coordinator `.value` write naming the private signal
//       identifiers (identifier-anchored, so an alias/non-literal
//       right-hand-side is caught too — pass-7 finding);
//   (b) an out-of-coordinator `currentWorkspace = null` assignment anywhere
//       in `src/**` (a cast-bypassing write would still slip past `tsc`);
//   (c) a `disposeShell(`/`disposeCurrentSurface(`/`shell.dispose(` call
//       outside the coordinator region in `src/ui/app.ts`;
//   (d) any of those three declarations moving outside the marked region;
//   (e) the ADJACENCY hazard no compile-time mechanism can foreclose: a
//       `mainSurface`/`currentWorkspace` assignment lexically preceding a
//       `retireTo*`/retirement-hook call in the SAME ordering scope (the
//       exported `retireTo*` ops are meant to be callable from outside the
//       coordinator by design, so this is the one shape compile scoping
//       cannot reject).
//
// #643 — this suite used to preprocess source with a two-pass regex comment
// stripper before scanning, and located "function bodies" via a textual
// `/(?:=>|\))\s*\{/` opener plus manual brace-depth matching. Both were
// unsound/imprecise in ways that mattered for an architecture GUARD: the
// stripper could delete real code hidden behind a `/*`-shaped substring
// inside a `//` comment, and the textual opener both MISSED
// return-annotated function declarations (`function f(): T { ... }` — the
// return-type text sits between the parameter list's `)` and the body's
// `{`) and accidentally treated every parenthesized control-flow block
// (`if (...) {`, `for (...) {`, etc.) as an independent ordering scope. Every
// check below instead calls `findSurfaceLifecycleSourceContractViolations`
// (`build/lib/check-legacy-owners.mjs`, #643): a real TypeScript parse over
// one shared parser batch for the whole scanned tree, using explicit
// AST-recognized ordering scopes (every block-bodied function-like node —
// now INCLUDING return-annotated ones — plus the exact parenthesized
// control-flow forms the old opener happened to also match: `if`'s
// then-block, `for`/`for-in`/`for-of`/`while`/`with` bodies, a `switch`'s
// whole case block, and a `catch (e) { ... }` block). `else`/`do`/`try`/
// `finally`/binding-less-`catch`/a bare standalone block are deliberately
// NOT independent scopes (the old opener never recognized them either); they
// remain visible through whichever enclosing scope contains them.
//
// Stays `.js`-idiom-compatible (reads files via `node:fs`) but is `.ts`,
// matching `tests/unit/side-panel-source-contract.test.ts`'s precedent (the
// repo carries no `@types/node`; `tests/types/node-fs-url.d.ts` is the
// minimal ambient shim both files share).

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findSurfaceLifecycleSourceContractViolations } from '../../build/lib/check-legacy-owners.mjs';
import type { SourceContractViolation, SurfaceLifecycleSourceEntry } from '../../build/lib/check-legacy-owners.mjs';

const here = dirname(fileURLToPath(import.meta.url)); // tests/unit
const root = join(here, '..', '..'); // repo root
const srcDir = join(root, 'src');

const APP_TS = 'src/ui/app.ts';
const BEGIN_MARKER = '// #590-COORDINATOR-BEGIN';
const END_MARKER = '// #590-COORDINATOR-END';

function listSourceFiles(): string[] {
  return readdirSync(srcDir, { recursive: true })
    .filter((rel) => /\.(ts|js)$/.test(rel))
    // Generated code is never hand-edited and can't legally reference these
    // app.ts-local identifiers anyway — excluded for signal, not correctness.
    .filter((rel) => !rel.startsWith('generated' + '/') && !rel.includes(`${'generated'}/`))
    .map((rel) => 'src/' + rel.split('\\').join('/'));
}

const files = listSourceFiles();
const rawSources: SurfaceLifecycleSourceEntry[] = files.map((relPath) => ({
  filename: relPath,
  source: readFileSync(join(root, relPath), 'utf8'),
}));

const appTsRawFull = rawSources.find((entry) => entry.filename === APP_TS)?.source;
if (appTsRawFull == null) throw new Error(`fixture assumption failed: ${APP_TS} not found by the source walk`);

// #643 "Measure the surface batch" — five fresh `vitest run` invocations of
// this exact file, instrumented with `performance.now()` around the
// `beforeAll` body below (instrumentation since removed), measured:
// 307.19ms / 273.43ms / 269.27ms / 244.54ms / 243.43ms — worst 307.19ms.
// 3x that is ~922ms, well under the plan's own 10000ms floor, so the floor
// (not the 3x figure) sets this timeout; the one real parser batch over the
// whole `src/**` tree (#643's own point — one process, not one per file) is
// nowhere near the 30000ms this repo already treats as a parser/batching
// performance defect (`tests/unit/clickhouse-http-package-policy.test.js`'s
// own `beforeAll`, by contrast, budgets 60000ms for FOUR real-tree scans).
const SURFACE_BATCH_TIMEOUT_MS = 10000;

describe('#590 surface-lifecycle architecture (invariant (k))', () => {
  it('the coordinator markers exist exactly once each, in order, in src/ui/app.ts', () => {
    // Coordinator marker uniqueness/order stays a RAW-text check over
    // src/ui/app.ts (rule scope matrix) — the markers are themselves `//`
    // comments that intentionally define the coordinator region for every
    // AST-based rule below, so their own discovery deliberately never goes
    // through the parser.
    const beginIndex = appTsRawFull.indexOf(BEGIN_MARKER);
    const endIndex = appTsRawFull.indexOf(END_MARKER);
    expect(beginIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(beginIndex);
    expect(appTsRawFull.indexOf(BEGIN_MARKER, beginIndex + 1)).toBe(-1);
    expect(appTsRawFull.indexOf(END_MARKER, endIndex + 1)).toBe(-1);
  });

  let violations: SourceContractViolation[];

  beforeAll(() => {
    const beginIndex = appTsRawFull.indexOf(BEGIN_MARKER);
    const endIndex = appTsRawFull.indexOf(END_MARKER);
    violations = findSurfaceLifecycleSourceContractViolations(rawSources, {
      appFile: APP_TS,
      coordinatorStart: beginIndex,
      coordinatorEnd: endIndex,
    });
  }, SURFACE_BATCH_TIMEOUT_MS);

  it('the four coordinator-owned declarations are declared inside the coordinator region, and nowhere outside it', () => {
    expect(violations.filter((v) => v.rule === 'surface-protected-declaration')).toEqual([]);
  });

  it('no out-of-coordinator call to disposeShell(/disposeCurrentSurface(/shell.dispose( exists in app.ts', () => {
    expect(violations.filter((v) => v.rule === 'surface-teardown-call')).toEqual([]);
  });

  it('no out-of-coordinator .value write names the private signal identifiers, in ANY src file', () => {
    expect(violations.filter((v) => v.rule === 'surface-signal-write')).toEqual([]);
  });

  it('no out-of-coordinator `currentWorkspace = null` assignment exists in ANY src file', () => {
    expect(violations.filter((v) => v.rule === 'surface-current-workspace-null')).toEqual([]);
  });

  it('no ordering scope writes mainSurface/currentWorkspace lexically before calling a retireTo*/retirement hook', () => {
    expect(violations.filter((v) => v.rule === 'surface-retirement-ordering')).toEqual([]);
  });
});

// ── Synthetic characterization — every check below builds its OWN small
// batch, exercising the analyzer directly (never the real tree) ───────────

const CLEAN_COORDINATOR = [
  '// #590-COORDINATOR-BEGIN',
  'const disposeShell = () => {};',
  'const disposeCurrentSurface = () => {};',
  'const committedWorkspaceSignal = { value: null };',
  'const mainSurfaceSignal = { value: null };',
  '// #590-COORDINATOR-END',
].join('\n');

function surfaceViolations(
  appBody: string,
  otherSources: SurfaceLifecycleSourceEntry[] = [],
): SourceContractViolation[] {
  const appSource = `${appBody}\n${CLEAN_COORDINATOR}\n`;
  const beginIndex = appSource.indexOf(BEGIN_MARKER);
  const endIndex = appSource.indexOf(END_MARKER);
  const sources: SurfaceLifecycleSourceEntry[] = [{ filename: APP_TS, source: appSource }, ...otherSources];
  return findSurfaceLifecycleSourceContractViolations(sources, {
    appFile: APP_TS,
    coordinatorStart: beginIndex,
    coordinatorEnd: endIndex,
  });
}

function rulesOf(violations: SourceContractViolation[]): string[] {
  return violations.map((v) => v.rule);
}

describe('required lexical sabotage matrix (both analyzers share this shape)', () => {
  it('a `//` comment containing a fake block-opener does not hide the real teardown violation that follows', () => {
    const body = [
      '// documentation mentioning src/core/**',
      'disposeShell();',
      '/* next real block comment */',
    ].join('\n');
    expect(rulesOf(surfaceViolations(body))).toContain('surface-teardown-call');
  });

  it('a `//` comment mentioning a glob-like path does not hide the real violation that follows', () => {
    const body = '// src/core/**\ndisposeShell();';
    expect(rulesOf(surfaceViolations(body))).toContain('surface-teardown-call');
  });

  it('a legal block comment does not hide the real violation that follows', () => {
    const body = '/* a normal, legal block comment */\ndisposeShell();';
    expect(rulesOf(surfaceViolations(body))).toContain('surface-teardown-call');
  });

  it('comment-shaped text inside a string literal does not hide the real violation that follows', () => {
    const body = "const s = 'comment-shaped /* text';\ndisposeShell();";
    expect(rulesOf(surfaceViolations(body))).toContain('surface-teardown-call');
  });

  it('comment-shaped text inside a template literal does not hide the real violation that follows', () => {
    const body = 'const t = `comment-shaped /* text`;\ndisposeShell();';
    expect(rulesOf(surfaceViolations(body))).toContain('surface-teardown-call');
  });

  it('a parser-valid regex literal containing comment-shaped characters does not hide the real violation that follows', () => {
    const body = 'const r = /a\\/\\*b/;\ndisposeShell();';
    expect(rulesOf(surfaceViolations(body))).toContain('surface-teardown-call');
  });

  it('a real forbidden construct immediately following a lexical trap is still caught', () => {
    const body = '/*c*/disposeShell();';
    expect(rulesOf(surfaceViolations(body))).toContain('surface-teardown-call');
  });

  it('forbidden vocabulary appearing only in comments stays clean', () => {
    const body = [
      '// this comment mentions disposeShell(, src/core/**, and forbiddenArchitectureViolation',
      '/* so does this block comment: disposeCurrentSurface( */',
      'const x = 1;',
    ].join('\n');
    expect(surfaceViolations(body)).toEqual([]);
  });
});

describe('additional surface sabotage: scope', () => {
  it('a teardown call outside the coordinator in app.ts fails', () => {
    expect(rulesOf(surfaceViolations('disposeShell();'))).toContain('surface-teardown-call');
  });

  it('an equivalent teardown-shaped call in an UNRELATED file is not governed by the app-only teardown rule', () => {
    const found = surfaceViolations('const x = 1;', [
      { filename: 'src/ui/unrelated.ts', source: 'function f() { disposeShell(); }\n' },
    ]);
    expect(found.filter((v) => v.rule === 'surface-teardown-call')).toEqual([]);
  });

  it('a currentWorkspace = null write in an unrelated source file fails (the null rule is tree-wide)', () => {
    const found = surfaceViolations('const x = 1;', [
      { filename: 'src/ui/unrelated.ts', source: 'function f() { target.currentWorkspace = null; }\n' },
    ]);
    expect(rulesOf(found)).toContain('surface-current-workspace-null');
  });

  it('a private signal .value write in an unrelated source file fails (the signal rule is tree-wide)', () => {
    const found = surfaceViolations('const x = 1;', [
      { filename: 'src/ui/unrelated.ts', source: 'function f() { obj.mainSurfaceSignal.value = next; }\n' },
    ]);
    expect(rulesOf(found)).toContain('surface-signal-write');
  });

  it('an ordering violation in an unrelated source file fails (ordering is tree-wide, unconditional on the coordinator)', () => {
    const found = surfaceViolations('const x = 1;', [
      {
        filename: 'src/ui/unrelated.ts',
        source: 'function f() { app.mainSurface = next; retireToLater(); }\n',
      },
    ]);
    expect(rulesOf(found)).toContain('surface-retirement-ordering');
  });
});

describe('additional surface sabotage: member chains', () => {
  it('obj.committedWorkspaceSignal.value = next; fails', () => {
    expect(rulesOf(surfaceViolations('function f() { obj.committedWorkspaceSignal.value = next; }'))).toContain(
      'surface-signal-write',
    );
  });

  it('obj.mainSurfaceSignal.value = next; fails', () => {
    expect(rulesOf(surfaceViolations('function f() { obj.mainSurfaceSignal.value = next; }'))).toContain(
      'surface-signal-write',
    );
  });

  it('app.shell.dispose(); fails (member-terminal shell.dispose match through a longer receiver chain)', () => {
    expect(rulesOf(surfaceViolations('function f() { app.shell.dispose(); }'))).toContain('surface-teardown-call');
  });

  it('owner.disposeShell(); fails (member-terminal disposeShell match)', () => {
    expect(rulesOf(surfaceViolations('function f() { owner.disposeShell(); }'))).toContain('surface-teardown-call');
  });
});

describe('additional surface sabotage: null wrappers (currentWorkspace = null)', () => {
  const wrapped: Array<[string, string]> = [
    ['bare null', 'target.currentWorkspace = null;'],
    ['as never', 'target.currentWorkspace = null as never;'],
    ['as any', 'target.currentWorkspace = null as any;'],
    ['non-null assertion', 'target.currentWorkspace = null!;'],
    ['satisfies', 'target.currentWorkspace = null satisfies never;'],
    ['parenthesized cast', 'target.currentWorkspace = (null as never);'],
  ];
  for (const [label, stmt] of wrapped) {
    it(`${label} still fails (a cast-bypassing write must not slip past this defense)`, () => {
      expect(rulesOf(surfaceViolations(`function f() { ${stmt} }`))).toContain('surface-current-workspace-null');
    });
  }

  // #643 mandatory addition 3 (pass-5 finding). Today's regex
  // (`\.currentWorkspace\s*=\s*null\b(?!\s*[=!]=)`) would actually flag
  // `x.currentWorkspace = null ?? y` too — the negative lookahead only
  // excludes a following `==`/`!=`, not `??`. This is a DELIBERATE
  // precision change, not a preservation: the real invariant this rule
  // enforces is "this property was set to a bare null-equivalent value",
  // and `??` introduces genuine conditional/fallback semantics that is not
  // that — see `unwrapNullEquivalentWrappers`'s own doc comment in
  // `build/lib/check-legacy-owners.mjs` for why `??` is not treated as a
  // transparent wrapper the way `as`/`!`/`satisfies`/parens are.
  it('### Deliberate precision change: `null ?? fallback` is intentionally treated as clean, not a violation', () => {
    const found = surfaceViolations('function f() { target.currentWorkspace = null ?? fallback; }');
    expect(found.filter((v) => v.rule === 'surface-current-workspace-null')).toEqual([]);
  });
});

describe('additional surface sabotage: ordering', () => {
  it('1. write before the first retire fails', () => {
    const body = 'function probe() { app.mainSurface = next; retireToLater(); }';
    expect(rulesOf(surfaceViolations(body))).toContain('surface-retirement-ordering');
  });

  it('2. first retire, then write, then a later retire passes', () => {
    const body = 'function probe() { retireToEarly(); app.mainSurface = next; retireToLater(); }';
    expect(surfaceViolations(body).filter((v) => v.rule === 'surface-retirement-ordering')).toEqual([]);
  });

  it('3. an outer write with the first retire only in a NESTED scope fails under the enclosing lexical scope', () => {
    const body = 'function probe() { app.mainSurface = next; if (c) { retireToLater(); } }';
    expect(rulesOf(surfaceViolations(body))).toContain('surface-retirement-ordering');
  });

  it('4. an early outer retire, then a write, then a later NESTED retire passes in the outer scope (the required control-block characterization)', () => {
    // The outer function passes because firstRetire < firstWrite, but the
    // independent `if` scope fails because ITS first write precedes ITS
    // first retire — both facts are true of the SAME source at once.
    const body = [
      'function probe() {',
      '  retireToEarly();',
      '  if (condition) {',
      '    app.mainSurface = next;',
      '    retireToLater();',
      '  }',
      '}',
    ].join('\n');
    const found = surfaceViolations(body).filter((v) => v.rule === 'surface-retirement-ordering');
    expect(found).toHaveLength(1); // only the inner `if` scope violates
  });

  it('5. a return-annotated function participates: retire, write, retire passes', () => {
    const body = [
      'export function typed(): void {',
      '  retireToEarly();',
      '  app.mainSurface = next;',
      '  retireToLater();',
      '}',
    ].join('\n');
    expect(surfaceViolations(body).filter((v) => v.rule === 'surface-retirement-ordering')).toEqual([]);
  });

  it('5b. a return-annotated function participates: write, retire fails (the old textual opener would have missed this scope entirely)', () => {
    const body = [
      'export function typed(): void {',
      '  app.mainSurface = next;',
      '  retireToLater();',
      '}',
    ].join('\n');
    expect(rulesOf(surfaceViolations(body))).toContain('surface-retirement-ordering');
  });

  // 6. Every preserved parenthesized control-block scope, table-driven —
  // each must independently fail on its own local write-before-retire, even
  // though the ENCLOSING function scope is clean (an early outer retire
  // precedes the outer scope's own first write, which is nested).
  const controlBlocks: Array<[string, string]> = [
    ['if', 'function probe() { retireToEarly(); if (c) { app.mainSurface = next; retireToLater(); } }'],
    ['for', 'function probe() { retireToEarly(); for (let i = 0; i < 1; i++) { app.mainSurface = next; retireToLater(); } }'],
    ['for-in', 'function probe() { retireToEarly(); for (const k in obj) { app.mainSurface = next; retireToLater(); } }'],
    ['for-of', 'function probe() { retireToEarly(); for (const k of obj) { app.mainSurface = next; retireToLater(); } }'],
    ['while', 'function probe() { retireToEarly(); while (c) { app.mainSurface = next; retireToLater(); } }'],
    ['switch', 'function probe() { retireToEarly(); switch (v) { case 1: app.mainSurface = next; retireToLater(); break; } }'],
    ['catch (e)', 'function probe() { retireToEarly(); try {} catch (e) { app.mainSurface = next; retireToLater(); } }'],
  ];
  for (const [label, body] of controlBlocks) {
    it(`6. ${label} is an independently checked ordering scope`, () => {
      const found = surfaceViolations(body).filter((v) => v.rule === 'surface-retirement-ordering');
      expect(found).toHaveLength(1); // only the control-block scope violates; the outer function scope is clean
    });
  }

  // Explicitly NOT independent scopes — the old textual opener never
  // recognized these either, so widening to cover them would be a NEW
  // enforcement the plan's non-goals forbid.
  const nonScopes: Array<[string, string]> = [
    ['else', 'function probe() { retireToEarly(); if (c) {} else { app.mainSurface = next; retireToLater(); } }'],
    ['do', 'function probe() { retireToEarly(); do { app.mainSurface = next; retireToLater(); } while (c); }'],
    ['try', 'function probe() { retireToEarly(); try { app.mainSurface = next; retireToLater(); } catch {} }'],
    ['binding-less catch', 'function probe() { retireToEarly(); try {} catch { app.mainSurface = next; retireToLater(); } }'],
    ['bare block', 'function probe() { retireToEarly(); { app.mainSurface = next; retireToLater(); } }'],
  ];
  for (const [label, body] of nonScopes) {
    it(`6b. ${label} is NOT an independently checked ordering scope`, () => {
      // The enclosing function scope's own first retire (retireToEarly)
      // precedes its first write (nested inside the non-scope), so the
      // whole thing is clean UNLESS the non-scope were wrongly treated as
      // independent.
      expect(surfaceViolations(body).filter((v) => v.rule === 'surface-retirement-ordering')).toEqual([]);
    });
  }

  it('7. braces and a retireToX(-shaped call inside comments/strings/templates/regex create no phantom calls or scopes', () => {
    const body = [
      'function probe() {',
      '  // if (x) { app.mainSurface = y; retireToPhantom(); }',
      "  const s = 'if (x) { app.mainSurface = y; retireToPhantom(); }';",
      '  const t = `if (x) { app.mainSurface = y; retireToPhantom(); }`;',
      '  const r = /retireTo\\w*\\(/;',
      '  retireToEarly();',
      '  app.mainSurface = next;',
      '}',
    ].join('\n');
    // The only REAL write (app.mainSurface) has no real retire after it —
    // the phantom text must not manufacture either a call or a scope.
    expect(surfaceViolations(body).filter((v) => v.rule === 'surface-retirement-ordering')).toEqual([]);
  });
});

describe('coordinator boundary classification', () => {
  it('a node whose range straddles the BEGIN marker is a deterministic boundary violation, not silently accepted', () => {
    // A multi-line declaration whose opening half sits before the marker and
    // whose closing half sits after it — impossible to place wholly inside
    // OR wholly outside.
    const appSource = [
      'const disposeShell = (',
      '// #590-COORDINATOR-BEGIN',
      ') => {};',
      'const disposeCurrentSurface = () => {};',
      'const committedWorkspaceSignal = { value: null };',
      'const mainSurfaceSignal = { value: null };',
      '// #590-COORDINATOR-END',
    ].join('\n');
    const beginIndex = appSource.indexOf(BEGIN_MARKER);
    const endIndex = appSource.indexOf(END_MARKER);
    const found = findSurfaceLifecycleSourceContractViolations(
      [{ filename: APP_TS, source: appSource }],
      { appFile: APP_TS, coordinatorStart: beginIndex, coordinatorEnd: endIndex },
    );
    expect(found.some((v) => v.rule === 'surface-protected-declaration')).toBe(true);
  });
});

describe('fail-loud contract', () => {
  it('throws when appFile is not present in the supplied source batch', () => {
    expect(() =>
      findSurfaceLifecycleSourceContractViolations(
        [{ filename: 'src/ui/other.ts', source: 'const x = 1;\n' }],
        { appFile: APP_TS, coordinatorStart: 0, coordinatorEnd: 0 },
      ),
    ).toThrow();
  });
});
