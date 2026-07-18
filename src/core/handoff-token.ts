// Pure token generation for the one-time dashboard view handoff (#288/#302).
// No DOM, no globals — `crypto` is injected exactly like the OAuth PKCE
// verifier/state generation in `src/net/oauth.ts`, so this stays testable
// without a real `crypto` global.

const HEX = '0123456789abcdef';

/**
 * An unguessable 256-bit token, hex-encoded (64 lowercase hex chars). Backs
 * the one-time `?st=` handoff URL param: the opener writes a `HandoffRecord`
 * keyed by this token, the new tab consumes+deletes it exactly once.
 *
 * `crypto` is injected (the caller passes `env.crypto` or the real
 * `globalThis.crypto`) so tests can supply a deterministic fake. Reads exactly
 * 32 bytes via `getRandomValues(new Uint8Array(32))`.
 */
export function randomHandoffToken(crypto: Pick<Crypto, 'getRandomValues'>): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    hex += HEX[(byte >> 4) & 0xf] + HEX[byte & 0xf];
  }
  return hex;
}
