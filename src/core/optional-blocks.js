// Optional SQL blocks (#165): the one template construct this app supports —
// a comment-wrapped block, written  /*[ AND d = {d:String} ]*/  in a query.
// A block is included (markers stripped, content byte-identical) only when
// every parameter referenced inside it is *active*; otherwise the whole block
// is removed before the SQL is sent. Values are never interpolated — the
// materialized SQL still carries native {name:Type} placeholders and ClickHouse
// performs the typed, injection-safe substitution.
//
// The syntax is SQL-transparent by construction: to any tool that doesn't know
// the convention the raw template is a plain block comment, so it parses and
// runs everywhere with all filters inactive — exactly the intended default.
// The trade-off is ClickHouse's non-nesting comment lexer: block content can
// never contain the two characters `*` + `/` in any form (not even inside a
// string literal), which rules 3–4 below turn into clear errors.
//
// Pure module: string in, structure out. No pipeline imports — the parameter
// pipeline (param-pipeline.js) wires this into its analysis/execution stage
// seams; this file only understands one statement string at a time.

import { scanSpans } from './sql-spans.js';
import { scanParamDeclarations } from './param-scan.js';

/** Activation sentinel: materialize with *every* block retained (markers
 *  stripped) — the analysis view all param discovery works on (rule 9). */
export const ALL_ACTIVE = Symbol('all-active');

const OPEN = '/*[';
const CLOSE = ']*/';

/**
 * The number of optional-block candidates in `sql` — comment spans opening
 * with `/*[` in code context (one inside a string, quoted identifier, line
 * comment or ordinary block comment is not a delimiter — rule 1). Candidates
 * are counted whether or not they validate, so callers can detect a template
 * (Format's skip policy) and the pipeline can detect a block-only statement
 * the splitter dropped as a comment-only fragment (rule 4). Pure.
 * @param {string} sql
 */
export function countOptionalBlocks(sql) {
  const text = String(sql || '');
  let n = 0;
  for (const span of scanSpans(text)) {
    if (span.kind === 'comment' && text.startsWith(OPEN, span.start)) n += 1;
  }
  return n;
}

/** True when `sql` contains at least one optional-block candidate. Pure. */
export function hasOptionalBlocks(sql) {
  return countOptionalBlocks(sql) > 0;
}

// True when `text`'s final lexical span is a string / quoted-identifier
// literal that never closes — i.e. the text ends mid-string. This is how a
// `*`+`/` *inside a string literal* in block content manifests: ClickHouse's
// comment lexer knows nothing about string quoting, so the comment ends at the
// in-string sequence and the candidate's content is cut off mid-literal. The
// sneakiest form is a string containing the three characters `]`+`*`+`/` — the
// truncated candidate still *looks* well-formed (it ends with the close
// marker), so only the content's own lexical shape reveals the damage.
function endsInOpenString(text) {
  let last = null;
  for (const s of scanSpans(text)) last = s;
  if (!last || last.kind !== 'string') return false;
  // Replay the scanner's own string rules (`\` escape, doubled-quote escape)
  // to decide whether the final literal actually closed at the text's end.
  const quote = text[last.start];
  let j = last.start + 1;
  while (j < last.end) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote) {
      if (text[j + 1] === quote) { j += 2; continue; }
      return false; // the literal closed (exactly at the end of the text)
    }
    j += 1;
  }
  return true;
}

const OPEN_STRING_ERROR = 'optional block: content ends inside a string literal — a "*/" inside a string still ends the SQL comment; remove it';

// Scan one statement's optional blocks, validating rules 1/3/4/5/6. Each valid
// block is `{start, end, content, params}` (offsets of the whole marker-to-
// marker span in `text`; params unique, in appearance order). Invalid
// candidates produce error strings instead.
function scanBlocks(text) {
  const blocks = [];
  const errors = [];
  for (const span of scanSpans(text)) {
    if (span.kind !== 'comment' || !text.startsWith(OPEN, span.start)) continue;
    const t = text.slice(span.start, span.end);
    if (!t.endsWith(CLOSE)) {
      // The comment either ran to EOF (unbalanced — rule 5) or was ended early
      // by a stray `*`+`/` in the content (rule 3: not allowed in any form —
      // ClickHouse's comment lexer knows nothing about string quoting here, so
      // an in-string occurrence gets its own message).
      errors.push(!t.endsWith('*/')
        ? 'optional block: unbalanced "/*[" — missing its closing "]*/"'
        : endsInOpenString(t.slice(OPEN.length, -2))
          ? OPEN_STRING_ERROR
          : 'optional block: content cannot contain "*/" — the SQL comment ends there (close the block with "]*/")');
      continue;
    }
    const content = t.slice(OPEN.length, -CLOSE.length);
    if (endsInOpenString(content)) {
      // A string literal containing `]*/` ended the comment early, yet the
      // truncated candidate still ends with `]*/` — reject instead of
      // materializing silently-mangled SQL.
      errors.push(OPEN_STRING_ERROR);
      continue;
    }
    if (content.includes('/*')) {
      // Nested blocks are unsupported (rule 3), and an ordinary block comment
      // cannot live inside a block — its closing `*`+`/` would end the outer
      // comment early. (Line comments inside a block are fine.)
      errors.push(content.includes(OPEN)
        ? 'optional block: blocks cannot nest ("/*[" inside "/*[ … ]*/")'
        : 'optional block: an ordinary block comment cannot appear inside "/*[ … ]*/"');
      continue;
    }
    // Rule 4: no statement separators inside a block — the pipeline splits
    // statements *before* materializing, so a block that changes the statement
    // count would break every downstream per-statement assumption. Only a
    // code-context `;` counts (one inside a string literal or line comment in
    // the content is passthrough).
    let separator = false;
    for (const s of scanSpans(content)) {
      if (s.kind === 'code' && content.slice(s.start, s.end).includes(';')) { separator = true; break; }
    }
    if (separator) {
      errors.push('optional block: content cannot contain a statement separator ";"');
      continue;
    }
    const params = [];
    for (const p of scanParamDeclarations(content)) {
      if (!params.includes(p.name)) params.push(p.name);
    }
    if (!params.length) {
      // Rule 6: a block with nothing to activate it can never be included.
      errors.push('optional block: must reference at least one {name:Type} parameter');
      continue;
    }
    blocks.push({ start: span.start, end: span.end, content, params });
  }
  return { blocks, errors };
}

/**
 * Materialize one statement's optional blocks against an activation map.
 *
 * `active` is either the `ALL_ACTIVE` sentinel (every block retained — the
 * analysis view) or a `{name: boolean}` map: a block is included only when
 * every parameter it references is truthy there (rule 7); a missing entry is
 * inactive. Markers are stripped from included blocks and removed blocks
 * disappear whole — all other text is preserved byte-identically, so a
 * statement without blocks round-trips unchanged.
 *
 * Returns `{ sql, requiredParams, optionalParams, blocks, errors }`:
 *   - `sql`            — the materialized statement (the input, verbatim, when
 *                        `errors` is non-empty);
 *   - `requiredParams` — names visible to the raw scan, i.e. outside every
 *                        block (rule 8 — these stay required); a name both
 *                        outside one block and inside another is required;
 *   - `optionalParams` — names confined to blocks (unique, appearance order);
 *   - `blocks`         — `{start, end, content, params, included}` per block;
 *   - `errors`         — rule violations (nesting, unbalanced, separator,
 *                        parameterless, whole-statement — rules 3–6).
 *
 * The #134 `isRowReturning` gate is deliberately NOT applied here — the
 * pipeline (and any other caller) decides which statements materialize; a
 * non-row-returning statement must simply never be passed in. Pure.
 * @param {string} stmt
 * @param {Object<string, boolean>|symbol} [active]
 */
export function materializeOptionalBlocks(stmt, active = {}) {
  const text = String(stmt || '');
  const { blocks, errors } = scanBlocks(text);
  const requiredParams = [];
  for (const p of scanParamDeclarations(text)) {
    if (!requiredParams.includes(p.name)) requiredParams.push(p.name);
  }
  const failed = (errs) => ({ sql: text, requiredParams, optionalParams: [], blocks: [], errors: errs });
  if (errors.length) return failed(errors);
  if (blocks.length) {
    // Rule 4 (second half): a block may not wrap a whole statement. With every
    // block removed, some runnable code (or a string literal) must remain.
    let rest = '';
    let pos = 0;
    for (const b of blocks) { rest += text.slice(pos, b.start); pos = b.end; }
    rest += text.slice(pos);
    let hasCode = false;
    for (const s of scanSpans(rest)) {
      if (s.kind === 'string' || (s.kind === 'code' && /\S/.test(rest.slice(s.start, s.end)))) { hasCode = true; break; }
    }
    if (!hasCode) return failed(['optional block: a block cannot wrap a whole statement']);
  }
  const all = active === ALL_ACTIVE;
  const optionalParams = [];
  const outBlocks = [];
  let sql = '';
  let pos = 0;
  for (const b of blocks) {
    const included = all || b.params.every((n) => !!active[n]);
    sql += text.slice(pos, b.start) + (included ? b.content : '');
    pos = b.end;
    for (const n of b.params) {
      if (!requiredParams.includes(n) && !optionalParams.includes(n)) optionalParams.push(n);
    }
    outBlocks.push({ start: b.start, end: b.end, content: b.content, params: b.params.slice(), included });
  }
  sql += text.slice(pos);
  return { sql, requiredParams, optionalParams, blocks: outBlocks, errors: [] };
}
