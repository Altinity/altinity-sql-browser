import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findSidePanelSourceContractViolations } from '../../build/lib/check-legacy-owners.mjs';
import type { SourceContractViolation } from '../../build/lib/check-legacy-owners.mjs';

// #587 AC5 (per R2.10's falsifiability requirement — a fake-panel test alone
// proves an injectable builder accepts injected data, not that adding a REAL
// panel avoids these four files; types are erased at runtime, so a
// compile-time guarantee alone isn't falsifiable either). This is the third
// leg: an executable, source-level check that no panel id/label comparison or
// hard-coded tab-row vocabulary has crept back into the four files #587 AC5
// names — it must go red the moment one does (see the sabotage checks below:
// reintroducing `sidePanel` into `workbench-session.ts`, or a hard-coded
// 'Databases' label into `state.ts`, both fail this test).
//
// #643 — this suite used to preprocess source with a two-pass regex comment
// stripper (`/\*[\s\S]*?\*\//g` then a line-comment regex) before matching.
// That order is unsound: a `/*`-shaped substring sitting inside a real `//`
// comment can make the block-comment pass consume real code through the
// NEXT genuine `*/`, hiding a real violation before this suite's assertions
// ever ran. Every check below instead calls
// `findSidePanelSourceContractViolations` (`build/lib/check-legacy-owners.mjs`,
// #643), which walks the REAL TypeScript AST the same shared parser
// infrastructure `tests/unit/clickhouse-http-package-policy.test.js` and
// `tests/unit/check-boundaries-dynamic-imports.test.js` already exercise —
// no second lexer, no comment/string/template/regex-literal ambiguity is
// even representable in what it inspects.

// `new URL(...)` goes through happy-dom's own (non-Node) URL implementation
// under this test environment, which rejects `file:` schemes — so this
// navigates from `import.meta.url` via `node:path` instead of the global URL.
const here = dirname(fileURLToPath(import.meta.url)); // tests/unit
const root = join(here, '..', '..'); // repo root

function realSource(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

function violations(source: string, filename: string): SourceContractViolation[] {
  return findSidePanelSourceContractViolations(source, filename);
}

// #643 review follow-up: mirrors `surface-lifecycle-arch.test.ts`'s own
// `rulesOf` helper. Nearly every sabotage case below expects EXACTLY one
// violation, so `rulesOf(...).toEqual([...])` is the single assertion that
// pins both the count and the exact rule code(s) — no separate `.rule`
// assertion needed. This matters because several of the guarded files
// dispatch to MULTIPLE distinct rule codes from the same
// `findSidePanelSourceContractViolations` call (`app-shell.ts` alone can
// report `app-shell-panel-def`, `app-shell-panel-id`, or
// `app-shell-host-accessor`) — a bug that swapped two of those rule-code
// strings in the dispatch table would still pass a bare `.toHaveLength(1)`.
function rulesOf(vs: SourceContractViolation[]): string[] {
  return vs.map((v) => v.rule);
}

const WORKBENCH_SESSION = 'src/ui/workbench/workbench-session.ts';
const APP_PREFERENCES = 'src/application/app-preferences.ts';
const STATE = 'src/state.ts';
const APP = 'src/ui/app.ts';
const APP_SHELL = 'src/ui/app-shell.ts';
const SIDE_PANELS_CORE = 'src/core/side-panels.ts';

describe('#587 AC5 source contract: no panel id/label selection outside the registry (real files)', () => {
  it('workbench-session.ts is clean: no `sidePanel` mention, no `=== \'history\'` comparison', () => {
    expect(violations(realSource(WORKBENCH_SESSION), WORKBENCH_SESSION)).toEqual([]);
  });

  it('app-preferences.ts is clean: no hard-coded panel id — its union is a TYPE, derived, never a literal comparison', () => {
    expect(violations(realSource(APP_PREFERENCES), APP_PREFERENCES)).toEqual([]);
  });

  it('state.ts is clean: no hard-coded display label — labels belong to the registry, not the state model', () => {
    expect(violations(realSource(STATE), STATE)).toEqual([]);
  });

  it('app.ts is clean: no direct lower-panel id string comparison — it addresses panels only through app.shell.sidePanels', () => {
    expect(violations(realSource(APP), APP)).toEqual([]);
  });

  // #600 review finding 1: `app-shell.ts` is the FOURTH file AC5 names
  // outright ("adding a panel must not touch app-shell.ts").
  it('app-shell.ts is clean: no concrete panel-def symbol, no bare panel-id literal, no concrete host accessor', () => {
    expect(violations(realSource(APP_SHELL), APP_SHELL)).toEqual([]);
  });

  it('side-panels.ts is clean: its derived pane id unions contain no hand-written literal panel id', () => {
    expect(violations(realSource(SIDE_PANELS_CORE), SIDE_PANELS_CORE)).toEqual([]);
  });
});

// #587 finding 2/3 (PR #600 review, round 2): `tests/types/side-panels.test-d.ts`
// pins coverage/disjointness of `UpperPanelId`/`LowerPanelId` against TODAY'S
// manifest only — for the current four-row `SIDE_PANELS`, the derived unions
// and a hand-written `Extract<SidePanelId, 'databases' | 'dashboards'>`
// literal produce IDENTICAL types, so that type-level test alone cannot
// detect a plain revert to hand-written literals with no accompanying
// manifest change. This suite is the source-level backstop for exactly that
// case — `side-panels-type-alias` (below) requires at least one type alias
// to exist AND rejects a protected literal anywhere in an alias's own type
// subtree, including one hidden behind a defaulted generic parameter.

describe('required lexical sabotage matrix (both analyzers share this shape)', () => {
  // The exact reported reproduction: the retired two-pass stripper would
  // genuinely have deleted the middle statement (a `/*`-shaped substring
  // inside a `//` comment eating real code through the next `*/`).
  it('a `//` comment containing a fake block-opener does not hide the real violation that follows', () => {
    const source = [
      '// documentation mentioning src/core/**',
      'const sidePanelViolation = 1;',
      '/* next real block comment */',
    ].join('\n');
    const found = violations(source, WORKBENCH_SESSION);
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe('workbench-sidepanel-mention');
  });

  it('a `//` comment mentioning a glob-like path does not hide the real violation that follows', () => {
    const source = '// src/core/**\nconst sidePanelViolation = 1;\n';
    expect(rulesOf(violations(source, WORKBENCH_SESSION))).toEqual(['workbench-sidepanel-mention']);
  });

  it('a legal block comment does not hide the real violation that follows', () => {
    const source = '/* a normal, legal block comment */\nconst sidePanelViolation = 1;\n';
    expect(rulesOf(violations(source, WORKBENCH_SESSION))).toEqual(['workbench-sidepanel-mention']);
  });

  it('comment-shaped text inside a string literal does not hide the real violation that follows', () => {
    const source = "const s = 'comment-shaped /* text';\nconst sidePanelViolation = 1;\n";
    expect(rulesOf(violations(source, WORKBENCH_SESSION))).toEqual(['workbench-sidepanel-mention']);
  });

  it('comment-shaped text inside a template literal does not hide the real violation that follows', () => {
    const source = 'const t = `comment-shaped /* text`;\nconst sidePanelViolation = 1;\n';
    expect(rulesOf(violations(source, WORKBENCH_SESSION))).toEqual(['workbench-sidepanel-mention']);
  });

  it('a parser-valid regex literal containing comment-shaped characters does not hide the real violation that follows', () => {
    const source = 'const r = /a\\/\\*b/;\nconst sidePanelViolation = 1;\n';
    expect(rulesOf(violations(source, WORKBENCH_SESSION))).toEqual(['workbench-sidepanel-mention']);
  });

  it('a real forbidden construct immediately following a lexical trap is still caught', () => {
    const source = '/*c*/const sidePanelViolation = 1;\n';
    expect(rulesOf(violations(source, WORKBENCH_SESSION))).toEqual(['workbench-sidepanel-mention']);
  });

  it('forbidden vocabulary appearing only in comments stays clean', () => {
    const source = [
      '// this comment mentions sidePanel, src/core/**, and forbiddenArchitectureViolation',
      '/* so does this block comment: sidePanel */',
      'const x = 1;',
    ].join('\n');
    expect(violations(source, WORKBENCH_SESSION)).toEqual([]);
  });
});

describe('additional side-panel sabotage: workbench breadth', () => {
  const cases: Array<[string, string]> = [
    ['identifier containing the raw spelling', 'const sidePanelThing = 1;'],
    ['string literal', "const text = 'sidePanel';"],
    ['no-substitution template literal', 'const tpl = `sidePanel`;'],
    ['regex literal', 'const re = /sidePanel/;'],
    ['computed string element access', "obj['sidePanel'];"],
    ['computed template element access', 'obj[`sidePanel`];'],
  ];
  for (const [label, code] of cases) {
    it(`${label} is a violation`, () => {
      expect(rulesOf(violations(code, WORKBENCH_SESSION))).toEqual(['workbench-sidepanel-mention']);
    });
  }

  it('comment-only equivalents of every shape above stay clean', () => {
    const source = [
      '// const sidePanelThing = 1;',
      "// const text = 'sidePanel';",
      '// const tpl = `sidePanel`;',
      '// const re = /sidePanel/;',
      "// obj['sidePanel'];",
      '// obj[`sidePanel`];',
      'const x = 1;',
    ].join('\n');
    expect(violations(source, WORKBENCH_SESSION)).toEqual([]);
  });

  it('the history comparison rule supports both operand orders and every quote style', () => {
    expect(rulesOf(violations("value === 'history';", WORKBENCH_SESSION))).toEqual(['workbench-history-compare']);
    expect(rulesOf(violations("'history' === value;", WORKBENCH_SESSION))).toEqual(['workbench-history-compare']);
    expect(rulesOf(violations('value === "history";', WORKBENCH_SESSION))).toEqual(['workbench-history-compare']);
    expect(rulesOf(violations('value === `history`;', WORKBENCH_SESSION))).toEqual(['workbench-history-compare']);
  });

  it('a string literal that merely LOOKS like the history comparison (not a real equality) stays clean', () => {
    const source = 'const note = "value === \'history\'";';
    expect(violations(source, WORKBENCH_SESSION)).toEqual([]);
  });
});

describe('additional side-panel sabotage: literal-value precision (app-preferences/state/app-shell ids)', () => {
  it('app-preferences.ts: an exact protected id literal fails, in every quote style, but a longer literal merely containing one stays clean', () => {
    expect(rulesOf(violations('const id = "library";', APP_PREFERENCES))).toEqual(['app-preferences-panel-id']);
    expect(rulesOf(violations('const id = `library`;', APP_PREFERENCES))).toEqual(['app-preferences-panel-id']);
    expect(violations("const note = \"pick 'library' now\";", APP_PREFERENCES)).toEqual([]);
  });

  it('state.ts: an exact protected label literal fails, but a longer literal merely containing one stays clean', () => {
    expect(rulesOf(violations('const label = "History";', STATE))).toEqual(['state-panel-label']);
    expect(violations("const note2 = \"old 'History' label\";", STATE)).toEqual([]);
  });

  it('app-shell.ts panel ids: an exact protected id literal fails, but a longer literal merely containing one stays clean', () => {
    expect(rulesOf(violations('const panel = `databases`;', APP_SHELL))).toEqual(['app-shell-panel-id']);
    expect(violations("const note3 = \"pick 'databases'\";", APP_SHELL)).toEqual([]);
  });

  // #643 mandatory addition 1 (pass-5 finding): the CURRENT regex-based test
  // scans the whole stripped file textually, so it already catches a
  // hand-written literal TYPE union too (e.g. `type Pref = 'library'`) —
  // exactly the #587 finding-2/3 regression shape. An implementation that
  // only walked EXPRESSION-position AST nodes for these three rule groups
  // would silently weaken that existing contract. These three cases pin that
  // a type-position `StringLiteral`/`NoSubstitutionTemplateLiteral` (a
  // `LiteralTypeNode`'s own literal) is caught on exactly the same terms as
  // an expression-position one.
  it('app-preferences.ts: a TYPE-position literal ("type Pref = \'library\';") still fails', () => {
    expect(rulesOf(violations("type Pref = 'library';", APP_PREFERENCES))).toEqual(['app-preferences-panel-id']);
  });

  it('state.ts: a TYPE-position literal ("type X = \'History\';") still fails', () => {
    expect(rulesOf(violations("type X = 'History';", STATE))).toEqual(['state-panel-label']);
  });

  it('app-shell.ts panel ids: a TYPE-position literal ("type X = \'databases\';") still fails', () => {
    expect(rulesOf(violations("type X = 'databases';", APP_SHELL))).toEqual(['app-shell-panel-id']);
  });
});

describe('additional side-panel sabotage: app.ts comparison', () => {
  it('supports the full receiver chain, both operand orders, and every quote style', () => {
    expect(rulesOf(violations("app.shell.sidePanel.value === 'saved';", APP))).toEqual(['app-side-panel-comparison']);
    expect(rulesOf(violations("'saved' === app.shell.sidePanel.value;", APP))).toEqual(['app-side-panel-comparison']);
    expect(rulesOf(violations('sidePanel.value === "history";', APP))).toEqual(['app-side-panel-comparison']);
    expect(rulesOf(violations('sidePanel.value === `library`;', APP))).toEqual(['app-side-panel-comparison']);
  });

  it('a string literal that merely LOOKS like the comparison (not a real equality) stays clean', () => {
    const source = 'const note = "sidePanel.value === \'saved\'";';
    expect(violations(source, APP)).toEqual([]);
  });
});

describe('additional side-panel sabotage: panel defs and hosts (app-shell.ts)', () => {
  it('a concrete panel-def identifier reference is a violation', () => {
    expect(rulesOf(violations('const x = databasesPanelDef;', APP_SHELL))).toEqual(['app-shell-panel-def']);
  });

  it('a concrete panel-def spelling in a real literal token is a violation', () => {
    expect(rulesOf(violations('const x = "dashboardsPanelDef";', APP_SHELL))).toEqual(['app-shell-panel-def']);
  });

  it('a comment naming a panel-def symbol stays clean', () => {
    expect(violations('// libraryPanelDef used to live here\nconst x = 1;', APP_SHELL)).toEqual([]);
  });

  it('dot host access is a violation', () => {
    expect(rulesOf(violations('host.databasesHost;', APP_SHELL))).toEqual(['app-shell-host-accessor']);
  });

  it('optional host access is a violation', () => {
    expect(rulesOf(violations('host?.dashboardsHost;', APP_SHELL))).toEqual(['app-shell-host-accessor']);
  });

  it('destructuring a host name is a violation', () => {
    expect(rulesOf(violations('const { databasesHost } = hosts;', APP_SHELL))).toEqual(['app-shell-host-accessor']);
  });

  it('string element access naming a host is a violation', () => {
    expect(rulesOf(violations("host['dashboardsHost'];", APP_SHELL))).toEqual(['app-shell-host-accessor']);
  });

  it('template element access naming a host is a violation', () => {
    expect(rulesOf(violations('host[`databasesHost`];', APP_SHELL))).toEqual(['app-shell-host-accessor']);
  });

  it('a contiguous ".databasesHost" spelling inside a literal token is a violation (preserving today\'s broad substring behavior)', () => {
    expect(rulesOf(violations('const msg = "call host.databasesHost please";', APP_SHELL))).toEqual([
      'app-shell-host-accessor',
    ]);
  });

  it('a comment-only host spelling stays clean', () => {
    expect(violations('// .databasesHost used to live here\nconst x = 1;', APP_SHELL)).toEqual([]);
  });

  it('dynamic construction of a host name is out of scope (no constant folding)', () => {
    expect(violations("host[prefix + 'Host'];", APP_SHELL)).toEqual([]);
  });
});

describe('additional side-panel sabotage: side-panels.ts type aliases', () => {
  it('a defaulted generic type parameter does not exempt the alias from the protected-literal check', () => {
    const found = violations("type Probe<T = SidePanelId> = T | 'databases';", SIDE_PANELS_CORE);
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe('side-panels-type-alias');
  });

  // Pass-2 review finding: a protected literal confined ENTIRELY to a type
  // parameter's own `extends` constraint (never appearing in the alias's
  // `.type` RHS at all) functions as a hand-written panel-id allowlist
  // bypass exactly like a literal in the RHS does — the guarded file itself
  // uses this exact `<P extends SidePanelPane>` shape in production
  // (src/core/side-panels.ts's `PanelIdInPane`), so this is a realistic
  // revert shape, not a contrived one.
  it('a protected literal confined to a type parameter\'s own extends-constraint is not exempt either', () => {
    const found = violations("type Probe<T extends 'databases'> = T;", SIDE_PANELS_CORE);
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe('side-panels-type-alias');
  });

  it('a protected literal confined to a type parameter\'s own default clause is not exempt either', () => {
    const found = violations("type Probe<T = 'library'> = T;", SIDE_PANELS_CORE);
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe('side-panels-type-alias');
  });

  it('a plain protected literal in a type alias fails', () => {
    expect(rulesOf(violations("type Probe = 'library';", SIDE_PANELS_CORE))).toEqual(['side-panels-type-alias']);
  });

  it('a file with zero type alias declarations at all is itself a violation (a total-removal regression must not read as clean)', () => {
    const found = violations('const x = 1;', SIDE_PANELS_CORE);
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe('side-panels-type-alias');
  });

  it('the manifest array itself (outside any type alias) legitimately spells the protected literals and stays clean', () => {
    const source = "type Probe = string;\nexport const SIDE_PANELS = [{ id: 'databases', pane: 'upper' }];\n";
    expect(violations(source, SIDE_PANELS_CORE)).toEqual([]);
  });
});

describe('a filename outside the six guarded files is never parsed and never reports a violation', () => {
  it('returns [] for an unrelated filename even with clearly-forbidden-looking source', () => {
    expect(violations("const sidePanel = 'library';", 'src/core/unrelated.ts')).toEqual([]);
  });
});
