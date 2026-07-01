// Pure result accumulator for ClickHouse's JSONStringsEachRowWithProgress
// streaming format. Each newline-delimited JSON object is one of:
//   { meta: [{name,type}, ...] }   — column headers (once, first)
//   { row:  { col: value, ... } }  — one data row
//   { progress: {...} }            — incremental progress stats
//   { exception: "..." }           — server-side error
// `applyStreamLine` folds one parsed object into a mutable result; keeping it
// pure (no fetch, no DOM) makes the streaming parser fully unit-testable.

/**
 * A fresh, empty result object for a query run in output format `fmt`. `rowLimit`
 * (default 0 = uncapped) is the client-side row cap: the server's
 * result_overflow_mode='break' stops at the cap but can overshoot to the next
 * block boundary, so applyStreamLine trims any rows past `rowLimit` and flags
 * `capped` once it's reached.
 */
export function newResult(fmt, rowLimit = 0) {
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

/** Fold one parsed stream object into `result` (mutated in place). */
export function applyStreamLine(json, result) {
  if (json.meta) {
    result.columns = json.meta.map((m) => ({ name: m.name, type: m.type }));
  } else if (json.row) {
    // At the cap: drop the row (block-boundary overage from `break`) and flag it.
    if (result.rowLimit > 0 && result.rows.length >= result.rowLimit) {
      result.capped = true;
    } else {
      result.rows.push(result.columns.map((c) => json.row[c.name]));
    }
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

const EXCEPTION_MARKER = '__exception__'; // ClickHouse WriteBufferFromHTTPServerResponse

// Re-decode a latin1 (1 byte -> 1 char) slice back into proper UTF-8 text.
const utf8 = (latin1) => new TextDecoder().decode(Uint8Array.from(latin1, (c) => c.charCodeAt(0)));

/**
 * Find ClickHouse's mid-stream exception frame in the retained tail of a
 * streamed HTTP response. Once headers (HTTP 200) are sent, a later server-side
 * failure can't change the status — so ClickHouse (since v24.11) appends a
 * structured frame to the very end of the body instead:
 *   \r\n__exception__\r\n<tag>\r\n<message>\n<len> <tag>\r\n__exception__\r\n
 * `tag` is the 16-byte value ClickHouse ALSO sends up front in the
 * `X-ClickHouse-Exception-Tag` response header — read it from the response and
 * pass it here, so a server-chosen random tag (never present in real data by
 * accident) frames the match with zero false positives. `tailLatin1` is the
 * retained tail of the body decoded 1 byte -> 1 char (so a char index is a byte
 * offset, even though the message itself may be UTF-8 multibyte).
 *
 * Legacy fallback (`tag` falsy — servers < 24.11 send no tag header): scan for
 * the plain-text `\nCode: <n>. DB::Exception:` prefix instead (less precise
 * excision, but still detected + reported). Anchored to the *end* of the tail
 * (optionally one trailing newline) — a genuine unframed exception is always
 * the last thing ClickHouse writes, and anchoring avoids misidentifying real
 * exported data that happens to *contain* that text (e.g. a `system.query_log`
 * `exception` column) as a server failure, so long as more data follows it.
 *
 * Returns `{ message, cleanBytes }` (`cleanBytes` = the byte length of real
 * data before the frame — what the caller should keep) or `null` when the
 * tail carries no exception frame. Pure.
 */
export function findExceptionFrame(tailLatin1, tag) {
  const s = String(tailLatin1 || '');
  if (tag) {
    const open = '\r\n' + EXCEPTION_MARKER + '\r\n' + tag + '\r\n';
    const start = s.indexOf(open);
    if (start < 0) return null;
    const body = s.slice(start + open.length);
    const close = body.indexOf('\r\n' + EXCEPTION_MARKER + '\r\n'); // closing trailer
    const raw = close < 0 ? body : body.slice(0, body.lastIndexOf('\n', close - 1));
    return { message: utf8(raw).trim(), cleanBytes: start };
  }
  const m = /\nCode:\s*\d+\.\s*DB::Exception:[^\n]*\n?$/.exec(s);
  return m ? { message: utf8(m[0]).trim(), cleanBytes: m.index } : null;
}

/**
 * The 0-based caret offset a ClickHouse error points at, or null. CH syntax
 * errors carry "failed at position N (token): …" where N is 1-based and relative
 * to the query string (newlines counted as one char), so it maps straight onto
 * the editor text. Used to jump the caret to a format/parse error. Pure.
 */
export function parseErrorPos(msg) {
  const m = /\bposition (\d+)/i.exec(String(msg || ''));
  return m ? Math.max(0, parseInt(m[1], 10) - 1) : null;
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
