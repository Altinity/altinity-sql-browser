// The CM6 ClickHouse-flavored SQL dialect/language construction, extracted
// from codemirror-adapter.ts's `langExtensionFor` so a second consumer (a
// docs pane rendering SQL examples, Markdown code blocks — phase 3) can build
// the same highlighting extension from reference data without importing the
// whole editor adapter (#313). Zero behavior change from the original
// `langExtensionFor` body: same fallback branches, same dialect flags.

import type { Extension } from '@codemirror/state';
import { sql, SQLDialect } from '@codemirror/lang-sql';
import type { AssembledReference } from '../core/completions.js';

/**
 * The ClickHouse-flavored SQL language extension for the given reference
 * data: server keywords/function names when loaded (#25), the built-in
 * fallback sets otherwise (`ref` null/undefined — no connection yet, or a
 * caller with no reference data at all). Both word lists are lowercased —
 * lang-sql looks dialect words up via `word.toLowerCase()`, so a verbatim
 * `toDateTime` would never match. Backticks and double quotes are identifier
 * quotes in ClickHouse; strings take backslash escapes. Auto-close covers
 * `(`, `[`, and the three quotes (parity with the deleted
 * core/editor-brackets.js) — `{` deliberately doesn't pair (it would fight
 * the #134 `{name:Type}` variables).
 */
export function chLanguageExtension(ref: AssembledReference | null | undefined): Extension[] {
  const dialect = SQLDialect.define({
    keywords: (ref ? ref.keywords : []).join(' ').toLowerCase(),
    builtin: Object.keys(ref ? ref.functions : {}).join(' ').toLowerCase(),
    backslashEscapes: true,
    identifierQuotes: '`"',
    // ClickHouse comment/heredoc forms (#182). These are editor approximations
    // of the authoritative core scanner (sql-spans.js): `hashComments` treats
    // every `#` as a comment (it can't express the space-or-`!` follow set), and
    // CM6's quoted-identifier escaping differs — but these affect only CM6-owned
    // editor behavior (highlighting, tree-based bracket/quote guards, hover),
    // never core completion/split/param analysis. `doubleQuotedStrings` stays
    // default-false: `"` is an identifier delimiter in ClickHouse.
    hashComments: true,
    slashComments: true,
    doubleDollarQuotedStrings: true,
  });
  return [
    sql({ dialect }),
    dialect.language.data.of({ closeBrackets: { brackets: ['(', '[', "'", '"', '`'] } }),
  ];
}
