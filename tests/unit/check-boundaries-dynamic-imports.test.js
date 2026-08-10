// Issue #642 — focused coverage for the shared parser-backed dynamic-import
// classifier (`findDynamicImportUsages`) and its conservative textual gate
// (`mightContainDynamicImport`), both in `build/lib/check-legacy-owners.mjs`.
// This is syntax-classification proof only, isolated from the two larger
// policy mirrors (`tests/unit/dashboard-boundaries.test.js` and
// `tests/unit/clickhouse-http-package-policy.test.js`) that apply an actual
// forbidden-directory/package policy on top of this classification.
//
// Node-tooling spec (kept .js like the other build-tooling specs in this
// tree: typing the node: imports would need @types/node, a deferred
// decision).

import { describe, expect, it } from 'vitest';
import { findDynamicImportUsages, mightContainDynamicImport } from '../../build/lib/check-legacy-owners.mjs';

const FILE = 'src/core/__probe__.ts';

describe('findDynamicImportUsages — static literal arguments', () => {
  it("classifies import('../x.js') (single-quoted) as static with the decoded specifier", () => {
    const found = findDynamicImportUsages("export async function f() { await import('../x.js'); }\n", FILE);
    expect(found).toEqual([{ kind: 'static', spec: '../x.js', pos: expect.any(Number) }]);
  });

  it('classifies import("../x.js") (double-quoted) as static with the decoded specifier', () => {
    const found = findDynamicImportUsages('export async function f() { await import("../x.js"); }\n', FILE);
    expect(found).toEqual([{ kind: 'static', spec: '../x.js', pos: expect.any(Number) }]);
  });

  it('classifies import(`../x.js`) (no-substitution template) as static with the decoded specifier', () => {
    const found = findDynamicImportUsages('export async function f() { await import(`../x.js`); }\n', FILE);
    expect(found).toEqual([{ kind: 'static', spec: '../x.js', pos: expect.any(Number) }]);
  });

  it('classifies a static import with legal trivia around the call and argument', () => {
    const found = findDynamicImportUsages(
      "export async function f() { await import ( '../x.js' ); }\n",
      FILE,
    );
    expect(found).toEqual([{ kind: 'static', spec: '../x.js', pos: expect.any(Number) }]);
  });

  it('classifies a static import with a comment between "import" and its call parens', () => {
    const found = findDynamicImportUsages(
      "export async function f() { await import/*c*/('../x.js'); }\n",
      FILE,
    );
    expect(found).toEqual([{ kind: 'static', spec: '../x.js', pos: expect.any(Number) }]);
  });

  it('classifies a static import with a comment between the open paren and the specifier', () => {
    const found = findDynamicImportUsages(
      "export async function f() { await import(/*c*/'../x.js'); }\n",
      FILE,
    );
    expect(found).toEqual([{ kind: 'static', spec: '../x.js', pos: expect.any(Number) }]);
  });
});

describe('findDynamicImportUsages — uncheckable arguments (never no result, never null)', () => {
  it('classifies a computed template literal (with a substitution) as uncheckable', () => {
    const found = findDynamicImportUsages(
      'export async function f(name) { await import(`../${name}.js`); }\n',
      FILE,
    );
    expect(found).toEqual([{ kind: 'uncheckable', pos: expect.any(Number) }]);
  });

  it('classifies a bare identifier argument as uncheckable', () => {
    const found = findDynamicImportUsages('export async function f(specifier) { await import(specifier); }\n', FILE);
    expect(found).toEqual([{ kind: 'uncheckable', pos: expect.any(Number) }]);
  });

  it('classifies a concatenated argument as uncheckable — never reduced to its quoted prefix', () => {
    const found = findDynamicImportUsages(
      "export async function f(name) { await import('../' + name); }\n",
      FILE,
    );
    expect(found).toEqual([{ kind: 'uncheckable', pos: expect.any(Number) }]);
    // Regression assertion: the result must never carry the quoted prefix as
    // though it proved anything about the full runtime specifier.
    expect(found.some((u) => u.spec === '../')).toBe(false);
  });

  it('classifies a conditional (ternary) expression argument as uncheckable', () => {
    const found = findDynamicImportUsages(
      "export async function f(cond) { await import(cond ? './a.js' : './b.js'); }\n",
      FILE,
    );
    expect(found).toEqual([{ kind: 'uncheckable', pos: expect.any(Number) }]);
  });

  it('classifies a parenthesized/computed expression argument as uncheckable', () => {
    const found = findDynamicImportUsages(
      "export async function f(name) { await import((name)); }\n",
      FILE,
    );
    expect(found).toEqual([{ kind: 'uncheckable', pos: expect.any(Number) }]);
  });

  it('classifies a call-expression argument as uncheckable', () => {
    const found = findDynamicImportUsages(
      "export async function f(resolve) { await import(resolve('x')); }\n",
      FILE,
    );
    expect(found).toEqual([{ kind: 'uncheckable', pos: expect.any(Number) }]);
  });

  it('classifies a missing argument as uncheckable rather than throwing', () => {
    const found = findDynamicImportUsages('export async function f() { await import(); }\n', FILE);
    expect(found).toEqual([{ kind: 'uncheckable', pos: expect.any(Number) }]);
  });
});

describe('findDynamicImportUsages — multiple occurrences and clean source', () => {
  it('reports one result per dynamic-import call expression, in source order', () => {
    const probe = `
      export async function f(name) {
        await import('../a.js');
        await import(name);
      }
    `;
    const found = findDynamicImportUsages(probe, FILE);
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({ kind: 'static', spec: '../a.js', pos: expect.any(Number) });
    expect(found[1]).toEqual({ kind: 'uncheckable', pos: expect.any(Number) });
  });

  it('returns an empty array for source with no dynamic import at all', () => {
    expect(findDynamicImportUsages("import { x } from './x.js';\nexport const y = x;\n", FILE)).toEqual([]);
  });

  it('does not classify a static import/export declaration as a dynamic import', () => {
    expect(findDynamicImportUsages("import './x.js';\nexport * from './y.js';\n", FILE)).toEqual([]);
  });
});

describe('mightContainDynamicImport — conservative gate, never inspects the argument', () => {
  it('returns true for a plain dynamic import', () => {
    expect(mightContainDynamicImport("import('x')")).toBe(true);
  });

  it('returns true with whitespace/newlines before the call parens', () => {
    expect(mightContainDynamicImport('import\n  \t (\'x\')')).toBe(true);
  });

  it('returns true with a block comment between "import" and its call parens', () => {
    expect(mightContainDynamicImport("import/*comment*/('x')")).toBe(true);
  });

  it('returns true with a line comment between "import" and its call parens', () => {
    expect(mightContainDynamicImport('import // comment\n (\'x\')')).toBe(true);
  });

  it('returns false for source with no dynamic import at all', () => {
    expect(mightContainDynamicImport("import { x } from './x.js';\nexport const y = x;\n")).toBe(false);
  });

  it('returns false for a source that merely mentions the word "import" without a call', () => {
    expect(mightContainDynamicImport('// see the import graph in docs/ARCHITECTURE.md\nexport const z = 1;\n')).toBe(false);
  });

  it('does not match "import" as a suffix of a longer identifier (e.g. reimport)', () => {
    expect(mightContainDynamicImport('function reimport() {}\nreimport();\n')).toBe(false);
  });

  it('returns true (harmless false positive) for a string literal that merely spells "import(" — proving the parser, not the gate, stays authoritative', () => {
    expect(mightContainDynamicImport('const s = "please call import(fn) sometime";\n')).toBe(true);
    // And the real parser correctly finds no dynamic-import call at all.
    expect(findDynamicImportUsages('const s = "please call import(fn) sometime";\n', FILE)).toEqual([]);
  });
});

describe('mightContainDynamicImport — real ECMAScript trivia beyond ASCII space/tab/CR/LF', () => {
  // Issue #642 review — the gate's original regex only recognized ASCII
  // space/tab/CR/LF as whitespace and only `\n` as a line-comment
  // terminator. Real ECMAScript trivia is broader: LineTerminator also
  // includes a bare CR (not followed by LF), U+2028 LINE SEPARATOR, and
  // U+2029 PARAGRAPH SEPARATOR; WhiteSpace also includes `\v`, `\f`, and
  // other Unicode space separators. Each case below is a shape the real
  // parser (`findDynamicImportUsages`) correctly classifies as a dynamic
  // import — the gate must never return `false` for source it is fed,
  // or `check-boundaries.mjs`'s pre-pass silently skips the parser call
  // entirely and the file escapes the fail-closed check outright.

  it('returns true for a bare-CR-terminated line comment between "import" and its call parens (not CRLF)', () => {
    const src = 'export async function f(specifier) { await import //c\r(specifier); }\n';
    expect(mightContainDynamicImport(src)).toBe(true);
    // Cross-check against the real parser, matching this issue's own live
    // reproduction: it must find a real (uncheckable) dynamic import here.
    expect(findDynamicImportUsages(src, FILE)).toEqual([{ kind: 'uncheckable', pos: expect.any(Number) }]);
  });

  it('returns true for U+2028 LINE SEPARATOR as whitespace between "import" and its call parens', () => {
    const src = `export async function f() { await import${'\u2028'}('../x.js'); }\n`;
    expect(mightContainDynamicImport(src)).toBe(true);
    expect(findDynamicImportUsages(src, FILE)).toEqual([{ kind: 'static', spec: '../x.js', pos: expect.any(Number) }]);
  });

  it('returns true for U+2029 PARAGRAPH SEPARATOR as whitespace between "import" and its call parens', () => {
    const src = `export async function f() { await import${'\u2029'}('../x.js'); }\n`;
    expect(mightContainDynamicImport(src)).toBe(true);
    expect(findDynamicImportUsages(src, FILE)).toEqual([{ kind: 'static', spec: '../x.js', pos: expect.any(Number) }]);
  });

  it('returns true for a vertical tab (\\v) as whitespace between "import" and its call parens', () => {
    const src = `export async function f() { await import${'\v'}('../x.js'); }\n`;
    expect(mightContainDynamicImport(src)).toBe(true);
    expect(findDynamicImportUsages(src, FILE)).toEqual([{ kind: 'static', spec: '../x.js', pos: expect.any(Number) }]);
  });

  it('returns true for a form feed (\\f) as whitespace between "import" and its call parens', () => {
    const src = `export async function f() { await import${'\f'}('../x.js'); }\n`;
    expect(mightContainDynamicImport(src)).toBe(true);
    expect(findDynamicImportUsages(src, FILE)).toEqual([{ kind: 'static', spec: '../x.js', pos: expect.any(Number) }]);
  });

  it('still terminates a line comment at U+2028, not just \\n, so a call after it is still seen', () => {
    const src = `export async function f() { await import //c${'\u2028'}('../x.js'); }\n`;
    expect(mightContainDynamicImport(src)).toBe(true);
    expect(findDynamicImportUsages(src, FILE)).toEqual([{ kind: 'static', spec: '../x.js', pos: expect.any(Number) }]);
  });
});
