import { describe, it, expect } from 'vitest';
import {
  validatePng, MAX_PNG_WIDTH, MAX_PNG_HEIGHT, MAX_PNG_PIXELS, MAX_PNG_BYTES,
} from '../../src/core/png.js';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/** Build minimal PNG bytes: signature + an IHDR chunk (length/type/width/
 *  height only — no CRC, no other chunks; `validatePng` never reads past
 *  IHDR's first 8 header bytes so this is sufficient). `ihdrLength` and
 *  `type` are overridable to exercise the malformed-chunk branches. */
function makePng(opts: {
  width?: number;
  height?: number;
  ihdrLength?: number;
  type?: string;
  extraTrailingBytes?: number;
} = {}): Uint8Array {
  const {
    width = 100, height = 50, ihdrLength = 13, type = 'IHDR', extraTrailingBytes = 0,
  } = opts;
  const bytes = new Uint8Array(8 + 8 + 13 + extraTrailingBytes);
  bytes.set(SIG, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, ihdrLength, false);
  for (let i = 0; i < 4; i++) bytes[12 + i] = type.charCodeAt(i);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

describe('validatePng', () => {
  it('accepts a well-formed minimal PNG', () => {
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
