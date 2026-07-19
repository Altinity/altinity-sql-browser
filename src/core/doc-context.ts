// Pure, kind-neutral "what does this word refer to" classifier for the CM6
// documentation feature (#313 Phase 1 — "function-call/known-function
// recognition and literal suppression only"). Given a SQL string, a caret/
// hover position, and the currently-loaded function reference data
// (`AssembledReference.functions`, core/completions.ts), resolves at most one
// `DocTarget` — a known function or aggregate-function — or `null` when the
// word isn't a known function/aggregate, or there's no word there at all.
//
// No DOM, no syntax tree, no SQL: this module has no way to tell a bare word
// apart from one sitting inside a comment/string/quoted identifier. That
// suppression is a CM6 syntax-tree concern the CALLER already owns
// (codemirror-adapter.ts's `LITERAL_NODE` check) — the contract is that the
// caller runs that check FIRST and simply does not call into this module at
// all when the position is inside a literal node. There is deliberately no
// `suppressed` boolean parameter here: threading one through would let a
// caller "ask anyway and get null" for a case it already knows the answer to,
// and it would give this pure module a second responsibility (literal
// awareness) it has no data to honor correctly — the single early-return the
// caller already needs is simpler than a flag it has to remember to pass.

import type { CompletionFunctionEntry } from './completions.js';
import { wordAt } from './completions.js';
import type { DocKind, DocTarget } from './doc-types.js';

/** One resolved functions-table match: the exact key the lookup matched
 *  under (case may differ from the word as typed — this is the "canonical"
 *  name, e.g. the server's lowercase `system.functions` key) and its entry. */
export interface FunctionMatch {
  key: string;
  entry: CompletionFunctionEntry;
}

// Own properties only: a column/identifier named `constructor` must not
// resolve a phantom `Object.prototype` entry.
function own<T>(m: Record<string, T>, k: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined;
}

/**
 * Case-insensitive functions-table lookup: exact match, then lowercase, then
 * UPPERCASE — SQL function calls are case-insensitive, and this mirrors the
 * server's mostly-canonical-lowercase keys (the old editor-intel `lookupFn`
 * behavior, #27/#313). Returns the matched key alongside the entry so a
 * caller can report the canonical name from the reference data rather than
 * the case the user happened to type.
 */
export function lookupFunctionEntry(
  functions: Record<string, CompletionFunctionEntry>, word: string,
): FunctionMatch | undefined {
  const exact = own(functions, word);
  if (exact) return { key: word, entry: exact };
  const lower = word.toLowerCase();
  const lowerEntry = own(functions, lower);
  if (lowerEntry) return { key: lower, entry: lowerEntry };
  const upper = word.toUpperCase();
  const upperEntry = own(functions, upper);
  if (upperEntry) return { key: upper, entry: upperEntry };
  return undefined;
}

// `system.functions`/the built-in fallback only ever tags an entry 'agg'
// (aggregate) or 'fn'/'cast' (scalar) — see CompletionFunctionEntry's own
// doc comment. The catalog (schema-catalog-service.ts) re-normalizes the
// TRUE kind from the fetched row regardless (its documented kind-mismatch
// policy), so this is only ever a best-effort seed for the request, never
// trusted as the final answer.
function kindFor(entry: CompletionFunctionEntry): DocKind {
  return entry.kind === 'agg' ? 'aggregate-function' : 'function';
}

/** Build the `DocTarget` for an already-matched functions-table entry. */
export function docTargetForMatch(match: FunctionMatch): DocTarget {
  return { kind: kindFor(match.entry), name: match.key };
}

/**
 * Resolve the documentation target at `pos` in `text`, or `null` when
 * there's no word there, or the word doesn't match a known function/
 * aggregate in `functions` (case-insensitively — see `lookupFunctionEntry`).
 * `text`/`pos` need only cover enough context to contain the word at `pos` —
 * a caller may pass the whole document or just the current line (identifiers
 * never span lines; the caller can slice cheaply either way, exactly like
 * `codemirror-adapter.ts`'s own hover/F1 callers do).
 */
export function resolveDocTarget(
  text: string, pos: number, functions: Record<string, CompletionFunctionEntry>,
): DocTarget | null {
  const w = wordAt(text, pos);
  if (!w) return null;
  const match = lookupFunctionEntry(functions, w.word);
  if (!match) return null;
  return docTargetForMatch(match);
}
