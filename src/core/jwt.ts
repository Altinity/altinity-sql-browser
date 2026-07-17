// JWT payload decoding + expiry check. Pure: takes a token string, returns
// data. No verification (the server validates signatures) — this only reads
// the unverified payload to surface the email and drive refresh timing.

/** A decoded JWT payload — `exp` (seconds since epoch) is the one claim this
 *  module reads itself; other claims (email/preferred_username/sub/…) pass
 *  through untyped for the ConnectionSession's `chUsername`
 *  (`application/connection-session.ts`, #276 Phase 2). */
export interface JwtPayload {
  exp?: number;
  [key: string]: unknown;
}

/**
 * Decode the base64url payload (second segment) of a JWT into an object.
 * Returns {} for malformed input rather than throwing.
 */
export function decodeJwtPayload(token: unknown): JwtPayload {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return {};
  let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  try {
    return JSON.parse(atob(b64));
  } catch {
    return {};
  }
}

/**
 * True when the token is missing, has no `exp`, is unparseable, or expires
 * within `bufferSeconds` of `now` (ms). `now` is injectable for tests.
 */
export function isTokenExpired(token: unknown, bufferSeconds = 60, now: number = Date.now()): boolean {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload.exp) return true;
  return payload.exp - bufferSeconds < now / 1000;
}
