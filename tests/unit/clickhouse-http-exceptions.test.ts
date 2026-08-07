import { describe, it, expect } from 'vitest';
import { parseExceptionText, findExceptionFrame } from '@altinity/clickhouse-http';

// Issue #630 Phase 3 — direct spec for the package's HTTP exception-text
// parser and byte-safe late-exception framer, consumed exclusively through
// the package's public export (contract A4). Moved (not duplicated) from
// `tests/unit/stream.test.ts`'s `parseExceptionText`/`findExceptionFrame`
// describe blocks — those blocks no longer exist in that file. Frame
// fixtures are constructed as `Uint8Array` directly, matching the package's
// byte-oriented signature (the root suite's latin1-surrogate-string fixtures
// are gone along with the string-taking API).

const enc = new TextEncoder();

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function ascii(s: string): Uint8Array {
  return enc.encode(s);
}

/** Build a raw-byte tail carrying `cleanPrefix` followed by a tagged
 *  late-exception frame:
 *    \r\n__exception__\r\n<tag>\r\n<message>\n<len> <tag>\r\n__exception__\r\n
 *  `closed: false` omits the final closing trailer (truncated-stream case). */
function frameTail(cleanPrefix: Uint8Array, tag: string, message: string, { closed = true }: { closed?: boolean } = {}): Uint8Array {
  const msgBytes = ascii(message);
  const parts = [
    cleanPrefix,
    ascii('\r\n__exception__\r\n' + tag + '\r\n'),
    msgBytes,
    ascii('\n' + msgBytes.length + ' ' + tag),
  ];
  if (closed) parts.push(ascii('\r\n__exception__\r\n'));
  return concatBytes(...parts);
}

describe('parseExceptionText', () => {
  it('extracts the exception line', () => {
    expect(parseExceptionText('{"meta":1}\n{"exception":"DB::Exception: nope"}')).toBe('DB::Exception: nope');
  });
  it('falls back to raw text when no exception line', () => {
    expect(parseExceptionText('plain error')).toBe('plain error');
  });
  it('falls back to raw text when the exception line is malformed JSON', () => {
    expect(parseExceptionText('{"exception": bad')).toBe('{"exception": bad');
  });
});

describe('findExceptionFrame — tagged framing', () => {
  const TAG = 'abcdef0123456789';

  it('returns null for a clean tail with no frame at all', () => {
    expect(findExceptionFrame(ascii('nothing but data here'), TAG)).toBeNull();
  });

  it('a tagged frame with no clean prefix reports cleanBytes === 0', () => {
    const tail = frameTail(new Uint8Array(0), TAG, 'DB::Exception: Boom');
    expect(findExceptionFrame(tail, TAG)).toEqual({ message: 'DB::Exception: Boom', cleanBytes: 0 });
  });

  it('finds a tagged frame and reports the clean-byte offset + trimmed message (ordinary ASCII prefix)', () => {
    const clean = ascii('hello world');
    const tail = frameTail(clean, TAG, 'DB::Exception: Boom');
    expect(findExceptionFrame(tail, TAG)).toEqual({ message: 'DB::Exception: Boom', cleanBytes: clean.length });
  });

  it('preserves internal newlines in a multi-line message, trimming only the ends', () => {
    const msg = 'Memory limit exceeded\nStack trace:\n  foo()';
    const clean = ascii('rows...');
    const tail = frameTail(clean, TAG, msg);
    expect(findExceptionFrame(tail, TAG)).toEqual({ message: msg, cleanBytes: clean.length });
  });

  it('decodes a multibyte UTF-8 message correctly', () => {
    const msg = 'Ошибка: превышен лимит памяти';
    const clean = ascii('clean');
    const tail = frameTail(clean, TAG, msg);
    expect(findExceptionFrame(tail, TAG)).toEqual({ message: msg, cleanBytes: clean.length });
  });

  it('falls back to the raw tail when the closing trailer is missing (truncated stream)', () => {
    const clean = ascii('clean');
    const tail = frameTail(clean, TAG, 'boom', { closed: false });
    const frame = findExceptionFrame(tail, TAG);
    expect(frame!.cleanBytes).toBe(clean.length);
    expect(frame!.message).toContain('boom');
  });

  it('returns null when the supplied tag does not match the frame\'s own tag', () => {
    const tail = frameTail(ascii('clean'), TAG, 'boom');
    expect(findExceptionFrame(tail, 'ffffffffffffffff')).toBeNull();
  });
});

describe('findExceptionFrame — tagged false-positive resistance', () => {
  const TAG = 'abcdef0123456789';

  it('returns null when the clean payload contains a literal __exception__ marker but no exact tagged opener', () => {
    const tail = concatBytes(ascii('leading __exception__ mid-data, no real frame here'));
    expect(findExceptionFrame(tail, TAG)).toBeNull();
  });

  it('returns null when opener-shaped bytes exist but carry a different tag', () => {
    const tail = frameTail(ascii('clean'), 'ffffffffffffffff', 'boom');
    expect(findExceptionFrame(tail, TAG)).toBeNull();
  });

  it('returns null when the supplied tag string appears elsewhere in ordinary data without the complete opener sequence', () => {
    const tail = concatBytes(ascii('data mentions ' + TAG + ' in passing, not a real frame'));
    expect(findExceptionFrame(tail, TAG)).toBeNull();
  });

  it('returns null for an incomplete marker/opening sequence (truncated before the tag)', () => {
    const tail = ascii('some clean data\r\n__exception__\r\n' + TAG.slice(0, 4)); // opener cut short
    expect(findExceptionFrame(tail, TAG)).toBeNull();
  });
});

describe('findExceptionFrame — legacy fallback (no tag)', () => {
  it('scans for the plain-text Code: N. DB::Exception: suffix', () => {
    const tail = ascii('clean12345\nCode: 241. DB::Exception: Memory limit (total) exceeded');
    expect(findExceptionFrame(tail, null)).toEqual({
      message: 'Code: 241. DB::Exception: Memory limit (total) exceeded',
      cleanBytes: ascii('clean12345').length,
    });
  });

  it('tolerates one trailing newline after the message', () => {
    const tail = ascii('clean\nCode: 241. DB::Exception: boom\n');
    expect(findExceptionFrame(tail, null)).toEqual({ message: 'Code: 241. DB::Exception: boom', cleanBytes: ascii('clean').length });
  });

  it('does NOT misidentify real data containing Code:/DB::Exception: text when more data follows (e.g. a system.query_log.exception column)', () => {
    const tail = ascii('clean\nCode: 241. DB::Exception: Memory limit exceeded\tmore\nclean\trows\n');
    expect(findExceptionFrame(tail, null)).toBeNull();
  });

  it('returns null with no Code: prefix at all', () => {
    expect(findExceptionFrame(ascii('all clean, nothing to see'), null)).toBeNull();
  });

  it('returns null for a non-numeric/malformed Code prefix', () => {
    expect(findExceptionFrame(ascii('clean\nCode: N/A. DB::Exception: boom'), null)).toBeNull();
  });

  it('returns null for an empty tail', () => {
    expect(findExceptionFrame(new Uint8Array(0), null)).toBeNull();
    expect(findExceptionFrame(null, null)).toBeNull();
    expect(findExceptionFrame(undefined, null)).toBeNull();
  });
});

describe('findExceptionFrame — byte-boundary proof (invalid UTF-8 in the clean prefix)', () => {
  const TAG = 'abcdef0123456789';

  it('a tagged frame after an invalid-UTF-8 + multibyte clean prefix reports the exact byte count and byte-identical prefix', () => {
    // 0xff/0xfe are invalid UTF-8 lead bytes on their own; '€' is a valid
    // multibyte (3-byte) UTF-8 sequence. A byte-index implementation must
    // treat this prefix as opaque bytes, never running it through
    // TextDecoder (which would throw/substitute and desynchronize any
    // string-index-based offset from the real byte offset).
    const cleanPrefix = concatBytes(
      ascii('rows-before: '),
      new Uint8Array([0xff, 0xfe]),
      ascii(' euro='),
      ascii('€'), // 3 valid UTF-8 bytes
      ascii(' end'),
    );
    const tail = frameTail(cleanPrefix, TAG, 'DB::Exception: Boom after garbage bytes');
    const frame = findExceptionFrame(tail, TAG);
    expect(frame).not.toBeNull();
    expect(frame!.cleanBytes).toBe(cleanPrefix.byteLength);
    expect(tail.subarray(0, frame!.cleanBytes)).toEqual(cleanPrefix);
    expect(frame!.message).toBe('DB::Exception: Boom after garbage bytes');
  });

  it('legacy framing after an invalid-UTF-8 clean prefix also reports the exact byte count and byte-identical prefix', () => {
    // The regex match consumes the SEPARATING '\n' as part of the frame
    // (mirrors the root suite's own `'clean12345\nCode: ...'` precedent,
    // where `cleanBytes` is the length of the text BEFORE that newline) — so
    // the newline is deliberately NOT part of `cleanPrefix` itself here.
    const cleanPrefix = concatBytes(
      ascii('col1\tcol2\n'),
      new Uint8Array([0xff, 0xfe, 0x00]),
      ascii('\tmore-clean-rows'),
    );
    const tail = concatBytes(cleanPrefix, ascii('\nCode: 241. DB::Exception: Memory limit (total) exceeded'));
    const frame = findExceptionFrame(tail, null);
    expect(frame).not.toBeNull();
    expect(frame!.cleanBytes).toBe(cleanPrefix.byteLength);
    expect(tail.subarray(0, frame!.cleanBytes)).toEqual(cleanPrefix);
    expect(frame!.message).toBe('Code: 241. DB::Exception: Memory limit (total) exceeded');
  });
});
