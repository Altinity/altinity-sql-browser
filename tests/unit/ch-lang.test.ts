import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { chLanguageExtension } from '../../src/editor/ch-lang.js';
import { assembleReferenceData } from '../../src/core/completions.js';

// Extracted from codemirror-adapter.test.ts's `langExtensionFor` suites
// (#313) — same assertions, now against the standalone dialect/language
// builder directly (reference data in, extension array out; no `app` shape).

describe('chLanguageExtension', () => {
  it('builds an empty-set dialect when refData is absent', () => {
    const ext = chLanguageExtension(null);
    expect(Array.isArray(ext)).toBe(true);
    const st = EditorState.create({ doc: 'x', extensions: ext });
    expect(st.languageDataAt('closeBrackets', 0)[0]).toEqual({ brackets: ['(', '[', "'", '"', '`'] }); // quotes pair (editor-brackets.js parity)
  });

  it('also builds the empty-set dialect when refData is undefined', () => {
    const ext = chLanguageExtension(undefined);
    const st = EditorState.create({ doc: 'x', extensions: ext });
    expect(st.languageDataAt('closeBrackets', 0)[0]).toEqual({ brackets: ['(', '[', "'", '"', '`'] });
  });
});

describe('chLanguageExtension — ClickHouse dialect flags (#182)', () => {
  const ext = chLanguageExtension(assembleReferenceData(null));
  const nodesOf = (doc: string): { name: string; from: number; to: number }[] => {
    const st = EditorState.create({ doc, extensions: ext });
    const out: { name: string; from: number; to: number }[] = [];
    syntaxTree(st).iterate({ enter: (n) => { out.push({ name: n.name, from: n.from, to: n.to }); } });
    return out;
  };
  const has = (doc: string, name: string) => nodesOf(doc).some((n) => n.name === name);

  // The core scanner (sql-spans.js) is authoritative; these lock the CM6
  // editor behavior that is actually available, not exact parity.
  it('enables hash and slash line comments', () => {
    expect(has('SELECT 1 # note', 'LineComment')).toBe(true);
    expect(has('SELECT 1 #! note', 'LineComment')).toBe(true);
    expect(has('SELECT 1 // note', 'LineComment')).toBe(true);
  });
  it('recognizes # broadly (even #x) — a KNOWN editor approximation', () => {
    // hashComments can't express ClickHouse's space-or-`!` follow set, so CM6
    // treats `#x` as a comment. This affects only editor highlighting; the core
    // scanner keeps `#x` as code for all application analysis.
    expect(has('SELECT 1 #x', 'LineComment')).toBe(true);
  });
  it('enables $$…$$ and $tag$…$tag$ dollar-quoted strings', () => {
    expect(has('SELECT $$a$$', 'String')).toBe(true);
    expect(has('SELECT $tag$a$tag$', 'String')).toBe(true);
  });
  it('treats a nested block comment as one BlockComment construct', () => {
    const blocks = nodesOf('SELECT /* a /* b */ c */ 1').filter((n) => n.name === 'BlockComment');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].to - blocks[0].from).toBe('/* a /* b */ c */'.length);
  });
  it('treats double-quoted / backtick forms as identifiers, not strings', () => {
    expect(has('SELECT "c"', 'QuotedIdentifier')).toBe(true);
    expect(has('SELECT "c"', 'String')).toBe(false);
    expect(has('SELECT `c`', 'QuotedIdentifier')).toBe(true);
  });
  it('does NOT form the same doubled-delimiter boundary as core — a documented approximation', () => {
    // CM6 reads `"a""b"` as TWO adjacent QuotedIdentifier tokens; the core
    // scanner reads it as ONE quoted-ident span (doubled `""` escape). Core
    // logic never consults CM6 token boundaries, so this divergence is safe.
    const idents = nodesOf('SELECT "a""b"').filter((n) => n.name === 'QuotedIdentifier');
    expect(idents).toHaveLength(2);
  });
});
