// Issue #630 Phase 3 — ClickHouse HTTP exception-text parsing and byte-safe
// late-exception framing, moved from `src/core/stream.ts` (mechanically
// unchanged — see that file's pre-Phase-3 history). This is the ONE
// production implementation of both primitives (contract A7).
//
// `findExceptionFrame`'s public signature changed from a caller-supplied
// latin1 SURROGATE STRING to a raw `Uint8Array` (plan §5.3): the latin1
// byte<->char mapping this module needs to search byte-exact offsets now
// happens INSIDE this module (`latin1View`, below) instead of being the
// caller's responsibility — removing the workaround
// `src/application/export-service.ts` used to carry for exactly this reason.

/**
 * Pull the ClickHouse exception out of an error response body. CH emits one
 * `{"exception": "..."}` line; fall back to the raw text if absent.
 */
export function parseExceptionText(text: string): string {
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

// A byte<->char VIEW (not a decode): 1 byte -> 1 char (latin1), used only to
// locate byte-exact offsets via string search. Unlike a real UTF-8
// TextDecoder — which can collapse a multi-byte sequence into one code point
// or substitute U+FFFD for an invalid one, both of which break a 1:1
// index<->byte correspondence — this mapping is bijective and lossless for
// every byte value 0-255, so a string index found through it IS the exact
// byte offset into the original array. The clean prefix therefore never
// passes through a real decode; only the matched candidate exception text
// is later re-encoded and run through an actual `TextDecoder` (`utf8`,
// below) to produce the human-readable message.
function latin1View(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

// Re-decode a latin1 (1 byte -> 1 char) slice back into proper UTF-8 text —
// applied only to an already-located candidate exception-message substring,
// never to the clean prefix.
const utf8 = (latin1: string): string => new TextDecoder().decode(Uint8Array.from(latin1, (c) => c.charCodeAt(0)));

/** `findExceptionFrame`'s successful-match shape — the decoded/trimmed
 *  message plus how many leading BYTES of the tail are real data.
 *  `cleanBytes` is an index into the supplied `Uint8Array` — never a string
 *  index, code-point count, UTF-16 code-unit count, or re-encoded length. */
export interface ExceptionFrame {
  message: string;
  cleanBytes: number;
}

/**
 * Find ClickHouse's mid-stream exception frame in the retained tail of a
 * streamed HTTP response. Once headers (HTTP 200) are sent, a later server-side
 * failure can't change the status — so ClickHouse (since v24.11) appends a
 * structured frame to the very end of the body instead:
 *   \r\n__exception__\r\n<tag>\r\n<message>\n<len> <tag>\r\n__exception__\r\n
 * `tag` is the 16-byte value ClickHouse ALSO sends up front in the
 * `X-ClickHouse-Exception-Tag` response header — read it from the response and
 * pass it here, so a server-chosen random tag (never present in real data by
 * accident) frames the match with zero false positives. `tailBytes` is the
 * retained tail of the body, as raw bytes — every offset this function
 * computes and returns is a byte index into exactly this array; the caller
 * needs no pre-conversion.
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
export function findExceptionFrame(tailBytes: Uint8Array | null | undefined, tag: string | null | undefined): ExceptionFrame | null {
  const s = latin1View(tailBytes || new Uint8Array(0));
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
