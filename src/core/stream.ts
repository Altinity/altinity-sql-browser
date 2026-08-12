// Pure result accumulator for ClickHouse's JSONStringsEachRowWithProgress
// streaming format. Each newline-delimited JSON object is one of:
//   { meta: [{name,type}, ...] }   — column headers (usually first, but may
//                                     be absent entirely — see below)
//   { row:  { col: value, ... } }  — one data row
//   { progress: {...} }            — incremental progress stats
//   { exception: "..." }           — server-side error
// `applyStreamLine` folds one parsed object into a mutable result; keeping it
// pure (no fetch, no DOM) makes the streaming parser fully unit-testable.
//
// Issue #627 — ClickHouse 24.8 and earlier streams omit `meta` entirely for
// ordinary queries. When the first `row` line arrives before any columns are
// established, `applyStreamLine` establishes name-only columns from that
// row's object keys, with the unknown-type sentinel `type: ''` (never a
// value-based type guess). This is SQL Browser result policy, not protocol
// parsing — see the fallback in the `json.row` arm below.
//
// Issue #630 Phase 3 — the canonical progress-line wire type (`StreamLine`)
// and the generic stream/exception-parsing primitives (`splitBuffer`,
// `parseExceptionText`, `ExceptionFrame`, `findExceptionFrame`) moved to
// `@altinity/clickhouse-http` (`progress-stream.ts`/`exceptions.ts`) — they
// are protocol mechanics, not SQL Browser result policy. `applyStreamLine`
// stays here (SQL Browser owns row caps, progress/percentage folding, and
// in-band exception -> result.error), but now accepts an open parsed-record
// boundary (`Record<string, unknown>`) rather than re-declaring a second
// copy of the package's wire-shape interface — see this module's doc on
// `applyStreamLine` below for why. `parseErrorPos`/`isAuthExpiredBody`/
// `authDeniedMessage` (editor caret + auth-expiry/denial UI policy) stay
// here unchanged; `src/core/**` cannot import `src/net/**` or the package
// (`build/check-boundaries.mjs` Rule for `src/core`), so this module never
// imports the package type either — it narrows the fields it needs from the
// open record instead.

/** One streamed result column, as reported by a `{meta}` line — or, when a
 *  stream omits `meta` entirely (ClickHouse 24.8 and earlier, issue #627),
 *  a name-only column established from the first `row`'s object keys, with
 *  `type: ''` as the unknown-type sentinel. */
export interface StreamColumn {
  name: string;
  type: string;
  [k: string]: unknown;
}

/** The accumulated progress stats `applyStreamLine` folds `{progress}` lines
 *  into — `total_rows` only appears once a `{progress}` line has actually
 *  been seen (the fresh `newResult()` shape omits it). */
export interface StreamProgress {
  rows: number;
  bytes: number;
  elapsed_ns: number;
  total_rows?: number;
}

/** A streamed query result accumulator — `newResult`'s fresh shape and
 *  `applyStreamLine`'s mutated-in-place shape. */
export interface StreamResult {
  columns: StreamColumn[];
  rows: unknown[][];
  rawText: string | null;
  rawFormat: string;
  progress: StreamProgress;
  error: string | null;
  cancelled: boolean;
  pct: number;
  rowLimit: number;
  capped: boolean;
}

/**
 * A fresh, empty result object for a query run in output format `fmt`. `rowLimit`
 * (default 0 = uncapped) is the client-side row cap: the server's
 * result_overflow_mode='break' stops at the cap but can overshoot to the next
 * block boundary, so applyStreamLine trims any rows past `rowLimit` and flags
 * `capped` once it's reached.
 */
export function newResult(fmt: string, rowLimit = 0): StreamResult {
  return {
    columns: [],
    rows: [],
    rawText: null,
    rawFormat: fmt,
    progress: { rows: 0, bytes: 0, elapsed_ns: 0 },
    error: null,
    cancelled: false,
    pct: 0,
    rowLimit,
    capped: false,
  };
}

/**
 * Fold one parsed progress-stream record into `result` (mutated in place).
 * `json` is deliberately typed as an open `Record<string, unknown>` boundary
 * rather than a re-declared structural mirror of the package's `StreamLine`
 * (issue #630 Phase 3 §8.1) — the canonical progress-line wire shape is
 * package-owned (`@altinity/clickhouse-http`'s `StreamLine`); this module
 * only needs to recognize the four property names a consumer must interpret
 * (`meta`/`row`/`progress`/`exception`), narrowing each locally, without
 * re-exporting a second declared wire contract. Unrecognized records are a
 * no-op — the module doc above lists the four shapes a line can take.
 *
 * Issue #627: when a `row` line arrives before `result.columns` has been
 * established (no `meta` line ever arrived, or none will), this is SQL
 * Browser result policy — not protocol parsing — establishing name-only
 * columns from that first row's object keys (`type: ''`, no value-based
 * inference) so meta-less ClickHouse 24.8-and-earlier streams still produce
 * a usable Table result instead of silently discarding every row.
 */
export function applyStreamLine(json: Record<string, unknown>, result: StreamResult): StreamResult {
  if (json.meta) {
    const meta = json.meta as { name: string; type: string }[];
    result.columns = meta.map((m) => ({ name: m.name, type: m.type }));
  } else if (json.row) {
    const row = json.row as Record<string, unknown>;

    if (result.columns.length === 0) {
      result.columns = Object.keys(row).map((name) => ({ name, type: '' }));
    }

    // At the cap: drop the row (block-boundary overage from `break`) and flag it.
    if (result.rowLimit > 0 && result.rows.length >= result.rowLimit) {
      result.capped = true;
    } else {
      result.rows.push(result.columns.map((c) => row[c.name]));
    }
  } else if (json.progress) {
    const p = json.progress as Record<string, unknown>;
    const total = Number(p.total_rows_to_read) || 0;
    const read = Number(p.read_rows) || 0;
    result.progress = {
      rows: read,
      bytes: Number(p.read_bytes) || 0,
      elapsed_ns: Number(p.elapsed_ns) || 0,
      total_rows: total,
    };
    result.pct = total > 0 ? Math.min(100, (read / total) * 100) : 0;
  } else if (json.exception) {
    result.error = json.exception as string;
  }
  return result;
}

/**
 * The 0-based caret offset a ClickHouse error points at, or null. CH syntax
 * errors carry "failed at position N (token): …" where N is 1-based and relative
 * to the query string (newlines counted as one char), so it maps straight onto
 * the editor text. Used to jump the caret to a format/parse error. Pure.
 */
export function parseErrorPos(msg: unknown): number | null {
  const m = /\bposition (\d+)/i.exec(String(msg || ''));
  return m ? Math.max(0, parseInt(m[1], 10) - 1) : null;
}

/**
 * True when a non-OK response body indicates an expired/invalid JWT. CH
 * returns HTTP 500 with `token_verification_exception` for a bad token, which
 * we treat like a 401 so the refresh/relogin path fires.
 */
export function isAuthExpiredBody(text: string): boolean {
  return /token_verification_exception|token expired/i.test(text);
}

/**
 * Build the login-screen message shown when ClickHouse rejects a *valid* login
 * (HTTP 401/403 with a non-expired token) — an authorization/identity problem,
 * not session expiry. `reason` is ClickHouse's own text (already run through
 * parseExceptionText); it's trimmed/collapsed and appended only when present.
 */
export function authDeniedMessage(status: number, reason?: unknown): string {
  const base =
    'ClickHouse denied your account (HTTP ' + status + "). You're signed in, " +
    'but this server is not authorizing you — your identity may have no ' +
    'ClickHouse user or the required grants.';
  const r = String(reason || '').replace(/\s+/g, ' ').trim();
  return r ? base + ' Server: ' + r : base;
}
