import { describe, it, expect } from 'vitest';
import {
  validatePng, MAX_PNG_WIDTH, MAX_PNG_HEIGHT, MAX_PNG_PIXELS, MAX_PNG_BYTES,
} from '../../src/core/png.js';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
// PNG's IEND chunk is always zero-length with a constant CRC-32 (CRC of just
// the 4 type bytes 'IEND', since IEND never carries data) — the same
// structural tail `validatePng` now requires.
const IEND_TAIL = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];

/** Build a structurally-COMPLETE minimal PNG: signature + a real IHDR chunk
 *  (13-byte data + 4-byte CRC, CRC bytes are dummy zeros — `validatePng`
 *  never verifies the IHDR CRC's *value*, only that it's in bounds) + a real
 *  terminal IEND chunk. `ihdrLength`/`type` are overridable to exercise the
 *  malformed-chunk branches. */
function makePng(opts: {
  width?: number;
  height?: number;
  ihdrLength?: number;
  type?: string;
} = {}): Uint8Array {
  const {
    width = 100, height = 50, ihdrLength = 13, type = 'IHDR',
  } = opts;
  const bytes = new Uint8Array(8 + 8 + 13 + 4 + IEND_TAIL.length);
  bytes.set(SIG, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, ihdrLength, false);
  for (let i = 0; i < 4; i++) bytes[12 + i] = type.charCodeAt(i);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  // bytes[24..27] is the IHDR CRC — left as zeros (dummy; never verified).
  bytes.set(IEND_TAIL, 8 + 8 + 13 + 4);
  return bytes;
}

describe('validatePng', () => {
  it('accepts a well-formed, structurally complete minimal PNG', () => {
    expect(validatePng(makePng({ width: 100, height: 50 }))).toEqual({ ok: true, width: 100, height: 50 });
  });

  it('rejects empty bytes', () => {
    expect(validatePng(new Uint8Array(0))).toEqual({ ok: false, reason: 'Empty PNG result' });
  });

  it('rejects bytes over MAX_PNG_BYTES', () => {
    // A cheap over-cap buffer: length alone triggers the byte-cap branch
    // before any signature/IHDR parsing.
    const big = new Uint8Array(MAX_PNG_BYTES + 1);
    const r = validatePng(big);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/too large/);
  });

  it('rejects bytes too short to hold a header', () => {
    const r = validatePng(new Uint8Array(10));
    expect(r).toEqual({ ok: false, reason: 'PNG result too short to contain a header' });
  });

  it('rejects a bad signature', () => {
    const bytes = makePng();
    bytes[0] = 0;
    expect(validatePng(bytes)).toEqual({ ok: false, reason: 'Not a valid PNG (bad signature)' });
  });

  it('rejects a missing IHDR chunk type', () => {
    const bytes = makePng({ type: 'IDAT' });
    expect(validatePng(bytes)).toEqual({ ok: false, reason: 'Not a valid PNG (missing IHDR chunk)' });
  });

  it('rejects an IHDR chunk shorter than 13 bytes', () => {
    const bytes = makePng({ ihdrLength: 12 });
    expect(validatePng(bytes)).toEqual({ ok: false, reason: 'Not a valid PNG (IHDR chunk too short)' });
  });

  it('rejects an IHDR chunk longer than 13 bytes (length must be exactly 13)', () => {
    const bytes = makePng({ ihdrLength: 14 });
    expect(validatePng(bytes)).toEqual({ ok: false, reason: 'Not a valid PNG (IHDR chunk too short)' });
  });

  it('rejects a payload truncated right after IHDR data (missing CRC bytes)', () => {
    const full = makePng({ width: 100, height: 50 });
    const truncated = full.slice(0, 8 + 8 + 13); // IHDR data present, no CRC, no IEND
    const r = validatePng(truncated);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/truncated/);
  });

  it('rejects a payload with a valid IHDR but no terminal IEND chunk (structurally incomplete)', () => {
    const full = makePng({ width: 100, height: 50 });
    const noIend = full.slice(0, 8 + 8 + 13 + 4); // IHDR + CRC only, IEND missing entirely
    const r = validatePng(noIend);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/IEND/);
  });

  it('rejects a payload with a corrupted/incomplete IEND tail', () => {
    const full = makePng({ width: 100, height: 50 });
    const corrupted = full.slice();
    corrupted[corrupted.length - 1] = 0; // flip a byte of IEND's constant CRC
    const r = validatePng(corrupted);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/IEND/);
  });

  it('rejects zero/negative-equivalent (unsigned zero) width or height', () => {
    expect(validatePng(makePng({ width: 0, height: 50 }))).toEqual({ ok: false, reason: 'Not a valid PNG (non-positive dimensions)' });
    expect(validatePng(makePng({ width: 100, height: 0 }))).toEqual({ ok: false, reason: 'Not a valid PNG (non-positive dimensions)' });
  });

  it('rejects dimensions over MAX_PNG_WIDTH/HEIGHT', () => {
    const wide = validatePng(makePng({ width: MAX_PNG_WIDTH + 1, height: 10 }));
    expect(wide.ok).toBe(false);
    expect((wide as { ok: false; reason: string }).reason).toMatch(/dimensions too large/);
    const tall = validatePng(makePng({ width: 10, height: MAX_PNG_HEIGHT + 1 }));
    expect(tall.ok).toBe(false);
    expect((tall as { ok: false; reason: string }).reason).toMatch(/dimensions too large/);
  });

  it('rejects width*height over MAX_PNG_PIXELS while each dimension alone is in range', () => {
    // sqrt(32_000_000) ≈ 5657; pick dims each under MAX_PNG_WIDTH/HEIGHT but
    // whose product exceeds MAX_PNG_PIXELS.
    const width = 6000;
    const height = 6000;
    expect(width).toBeLessThanOrEqual(MAX_PNG_WIDTH);
    expect(height).toBeLessThanOrEqual(MAX_PNG_HEIGHT);
    expect(width * height).toBeGreaterThan(MAX_PNG_PIXELS);
    const r = validatePng(makePng({ width, height }));
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/too many pixels/);
  });

  it('accepts dimensions exactly at the pixel cap', () => {
    // 8000 x 4000 = 32,000,000 exactly.
    expect(validatePng(makePng({ width: 8000, height: 4000 }))).toEqual({ ok: true, width: 8000, height: 4000 });
  });
});
