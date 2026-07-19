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

/**
 * Validate `bytes` as a well-formed, in-bounds PNG: non-empty, under
 * `MAX_PNG_BYTES`, the 8-byte PNG signature, a readable IHDR chunk (first
 * chunk at offset 8, length >= 13, type 'IHDR') with positive width/height
 * within `MAX_PNG_WIDTH`/`MAX_PNG_HEIGHT` and `width*height <=
 * MAX_PNG_PIXELS`. Never decodes pixel data — only the signature + IHDR
 * header. Pure.
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
  if (chunkLength < 13) return { ok: false, reason: 'Not a valid PNG (IHDR chunk too short)' };
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width <= 0 || height <= 0) return { ok: false, reason: 'Not a valid PNG (non-positive dimensions)' };
  if (width > MAX_PNG_WIDTH || height > MAX_PNG_HEIGHT) {
    return { ok: false, reason: `PNG dimensions too large (${width}x${height}, max ${MAX_PNG_WIDTH}x${MAX_PNG_HEIGHT})` };
  }
  if (width * height > MAX_PNG_PIXELS) {
    return { ok: false, reason: `PNG has too many pixels (${width * height}, max ${MAX_PNG_PIXELS})` };
  }
  return { ok: true, width, height };
}
