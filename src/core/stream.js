// Pure result accumulator for ClickHouse's JSONStringsEachRowWithProgress
// streaming format. Each newline-delimited JSON object is one of:
//   { meta: [{name,type}, ...] }   — column headers (once, first)
//   { row:  { col: value, ... } }  — one data row
//   { progress: {...} }            — incremental progress stats
//   { exception: "..." }           — server-side error
// `applyStreamLine` folds one parsed object into a mutable result; keeping it
// pure (no fetch, no DOM) makes the streaming parser fully unit-testable.

/** A fresh, empty result object for a query run in output format `fmt`. */
export function newResult(fmt) {
  return {
    columns: [],
    rows: [],
    rawText: null,
    rawFormat: fmt,
    progress: { rows: 0, bytes: 0, elapsed_ns: 0 },
    error: null,
    cancelled: false,
    pct: 0,
  };
}

/** Fold one parsed stream object into `result` (mutated in place). */
export function applyStreamLine(json, result) {
  if (json.meta) {
    result.columns = json.meta.map((m) => ({ name: m.name, type: m.type }));
  } else if (json.row) {
    result.rows.push(result.columns.map((c) => json.row[c.name]));
  } else if (json.progress) {
    const p = json.progress;
    const total = +p.total_rows_to_read || 0;
    const read = +p.read_rows || 0;
    result.progress = {
      rows: read,
      bytes: +p.read_bytes || 0,
      elapsed_ns: +p.elapsed_ns || 0,
      total_rows: total,
    };
    result.pct = total > 0 ? Math.min(100, (read / total) * 100) : 0;
  } else if (json.exception) {
    result.error = json.exception;
  }
  return result;
}

/**
 * Split a streaming text buffer into complete lines plus the trailing
 * remainder. Returns { lines, rest } where `rest` is the (possibly partial)
 * last line to carry into the next chunk.
 */
export function splitBuffer(buffer) {
  const lines = buffer.split('\n');
  const rest = lines[lines.length - 1];
  return { lines: lines.slice(0, -1).filter((l) => l !== ''), rest };
}

/**
 * Pull the ClickHouse exception out of an error response body. CH emits one
 * `{"exception": "..."}` line; fall back to the raw text if absent.
 */
export function parseExceptionText(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('{"exception"')) {
      try {
        return JSON.parse(line).exception;
      } catch {
        break;
      }
    }
  }
  return text;
}

/**
 * True when a non-OK response body indicates an expired/invalid JWT. CH
 * returns HTTP 500 with `token_verification_exception` for a bad token, which
 * we treat like a 401 so the refresh/relogin path fires.
 */
export function isAuthExpiredBody(text) {
  return /token_verification_exception|token expired/i.test(text);
}

/**
 * Build the login-screen message shown when ClickHouse rejects a *valid* login
 * (HTTP 401/403 with a non-expired token) — an authorization/identity problem,
 * not session expiry. `reason` is ClickHouse's own text (already run through
 * parseExceptionText); it's trimmed/collapsed and appended only when present.
 */
export function authDeniedMessage(status, reason) {
  const base =
    'ClickHouse denied your account (HTTP ' + status + "). You're signed in, " +
    'but this server is not authorizing you — your identity may have no ' +
    'ClickHouse user or the required grants.';
  const r = String(reason || '').replace(/\s+/g, ' ').trim();
  return r ? base + ' Server: ' + r : base;
}
