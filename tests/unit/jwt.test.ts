import { describe, it, expect } from 'vitest';
import { decodeJwtPayload, isTokenExpired } from '../../src/core/jwt.js';

// Build a JWT with the given payload (header + payload + dummy sig).
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: Record<string, unknown>): string =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

describe('decodeJwtPayload', () => {
  it('decodes a well-formed payload', () => {
    const t = makeJwt({ email: 'a@b.com', exp: 123 });
    expect(decodeJwtPayload(t)).toEqual({ email: 'a@b.com', exp: 123 });
  });
  it('returns {} for too-few segments', () => {
    expect(decodeJwtPayload('nodots')).toEqual({});
  });
  it('returns {} for null/empty', () => {
    expect(decodeJwtPayload(null)).toEqual({});
    expect(decodeJwtPayload('')).toEqual({});
  });
  it('returns {} for non-JSON payload', () => {
    expect(decodeJwtPayload('a.@@@.c')).toEqual({});
  });
});

describe('isTokenExpired', () => {
  const now = 1_000_000_000_000; // ms → 1e9 s
  it('true when token missing', () => {
    expect(isTokenExpired(null)).toBe(true);
    expect(isTokenExpired('')).toBe(true);
  });
  it('true when no exp claim', () => {
    expect(isTokenExpired(makeJwt({ email: 'x' }), 60, now)).toBe(true);
  });
  it('true when unparseable', () => {
    expect(isTokenExpired('a.@@@.c', 60, now)).toBe(true);
  });
  it('false when comfortably in the future', () => {
    const t = makeJwt({ exp: 1e9 + 3600 });
    expect(isTokenExpired(t, 60, now)).toBe(false);
  });
  it('true within the buffer window', () => {
    const t = makeJwt({ exp: 1e9 + 30 }); // 30s out, buffer 60s
    expect(isTokenExpired(t, 60, now)).toBe(true);
  });
  it('respects a zero buffer', () => {
    const t = makeJwt({ exp: 1e9 + 30 });
    expect(isTokenExpired(t, 0, now)).toBe(false);
  });
  it('defaults now to Date.now()', () => {
    expect(isTokenExpired(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }))).toBe(false);
  });
});
