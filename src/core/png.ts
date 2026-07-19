// Pure PNG-bytes validation for ClickHouse `FORMAT PNG` image results (#307).
// No DOM, no globals — the raw bytes come off the wire (ch-client's binary
// branch); this module only inspects the PNG signature + IHDR chunk so the
// UI can trust width/height/size before handing the bytes to an <img>/blob
// URL. Never decodes pixel data.

/** Hard caps a PNG result must satisfy to be considered a valid, renderable
 *  image — guards against a malformed/huge response wedging the tab. */
export const MAX_PNG_WIDTH = 8192;
export const MAX_PNG_HEIGHT = 8192;
export const MAX_PNG_PIXELS = 32_000_000;
export const MAX_PNG_BYTES = 64 * 1024 * 1024;

/** The 8-byte PNG file signature (always the first 8 bytes of a real PNG). */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A validated `FORMAT PNG` result, ready for the results panel to render as
 *  an image. `width`/`height` come from the IHDR chunk (no pixel decode). */
export interface ImageResultPayload {
  kind: 'image';
  format: 'PNG';
  mimeType: 'image/png';
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** `validatePng`'s outcome: the IHDR-reported dimensions, or a human-readable
 *  reason a result error line can show verbatim. */
export type ValidatePngResult =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: string };

/** The constant, structurally-fixed IEND chunk: 4-byte zero length, 'IEND'
 *  type, and its (also constant, since IEND never carries data) CRC-32. */
const IEND_TAIL = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]; // len=0, 'IEND', CRC

/**
 * Validate `bytes` as a well-formed, in-bounds, structurally-COMPLETE PNG:
 * non-empty, under `MAX_PNG_BYTES`, the 8-byte PNG signature, a readable
 * IHDR chunk (first chunk at offset 8, length EXACTLY 13, type 'IHDR', its
 * 13 data bytes + 4-byte CRC fully in bounds) with positive width/height
 * within `MAX_PNG_WIDTH`/`MAX_PNG_HEIGHT` and `width*height <=
 * MAX_PNG_PIXELS`, AND a terminal IEND chunk (the last 12 bytes: zero
 * length + 'IEND' + IEND's constant CRC) — guarding against a
 * header-only/truncated response that never actually finished writing.
 * Never decodes pixel data — only the signature + IHDR header + trailing
 * IEND bytes. Pure.
 */
export function validatePng(bytes: Uint8Array): ValidatePngResult {
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'Empty PNG result' };
  if (bytes.length > MAX_PNG_BYTES) {
    return { ok: false, reason: `PNG result too large (${bytes.length} bytes, max ${MAX_PNG_BYTES})` };
  }
  if (bytes.length < 8 + 8 + 13) {
    return { ok: false, reason: 'PNG result too short to contain a header' };
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return { ok: false, reason: 'Not a valid PNG (bad signature)' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkLength = view.getUint32(8, false);
  const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunkType !== 'IHDR') return { ok: false, reason: 'Not a valid PNG (missing IHDR chunk)' };
  if (chunkLength !== 13) return { ok: false, reason: 'Not a valid PNG (IHDR chunk too short)' };
  // IHDR's 13 data bytes + its 4-byte CRC must actually be present.
  if (8 + 8 + 13 + 4 > bytes.length) {
    return { ok: false, reason: 'PNG result truncated (incomplete IHDR chunk)' };
  }
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width <= 0 || height <= 0) return { ok: false, reason: 'Not a valid PNG (non-positive dimensions)' };
  if (width > MAX_PNG_WIDTH || height > MAX_PNG_HEIGHT) {
    return { ok: false, reason: `PNG dimensions too large (${width}x${height}, max ${MAX_PNG_WIDTH}x${MAX_PNG_HEIGHT})` };
  }
  if (width * height > MAX_PNG_PIXELS) {
    return { ok: false, reason: `PNG has too many pixels (${width * height}, max ${MAX_PNG_PIXELS})` };
  }
  // A structurally complete PNG always ends with IEND (zero-length, constant
  // CRC) as its very last 12 bytes — a header-only/truncated body never has
  // this, which is exactly what this guards against. (No separate
  // length-vs-IEND_TAIL.length check needed: the bounds check above already
  // guarantees `bytes.length >= 33 > IEND_TAIL.length`, so `tailStart` is
  // always non-negative here.)
  const tailStart = bytes.length - IEND_TAIL.length;
  for (let i = 0; i < IEND_TAIL.length; i++) {
    if (bytes[tailStart + i] !== IEND_TAIL[i]) {
      return { ok: false, reason: 'PNG result truncated (missing IEND chunk)' };
    }
  }
  return { ok: true, width, height };
}
