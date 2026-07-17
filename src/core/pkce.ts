// PKCE (RFC 7636) + OAuth state generation. Uses Web Crypto, which is
// injectable so tests run under Node's webcrypto or a stub.

/** The minimal `crypto.getRandomValues` surface — real Web Crypto or a
 *  deterministic test stub. Deliberately non-generic (every call site here
 *  passes a `Uint8Array` and uses the result as one) — pinned to the
 *  `ArrayBuffer`-backed form (`new Uint8Array(n)`'s actual type) since
 *  lib.dom's own `Crypto.getRandomValues` requires exactly that, not the
 *  wider `ArrayBufferLike` (which also admits `SharedArrayBuffer`). */
interface RandomBytesSource {
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}

/** The minimal Web Crypto surface `generatePKCE` uses — real Web Crypto (the
 *  global `crypto`, browser or Node's `webcrypto`) or an injectable stub. */
interface PkceCrypto extends RandomBytesSource {
  subtle: { digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer> };
}

/** A PKCE verifier/challenge pair — see `generatePKCE` below. */
export interface Pkce {
  verifier: string;
  challenge: string;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a PKCE { verifier, challenge } pair. `cryptoObj` defaults to the
 * global Web Crypto; pass a stub in tests.
 */
export async function generatePKCE(cryptoObj: PkceCrypto = globalThis.crypto): Promise<Pkce> {
  const bytes = cryptoObj.getRandomValues(new Uint8Array(32));
  const verifier = base64url(bytes);
  const digest = await cryptoObj.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  const challenge = base64url(new Uint8Array(digest));
  return { verifier, challenge };
}

/** Generate a random hex CSRF state string (16 bytes → 32 hex chars). */
export function randomState(cryptoObj: RandomBytesSource = globalThis.crypto): string {
  return cryptoObj
    .getRandomValues(new Uint8Array(16))
    .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}
