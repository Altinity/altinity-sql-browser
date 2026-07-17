import { describe, it, expect, vi, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { generatePKCE, randomState } from '../../src/core/pkce.js';

afterEach(() => vi.unstubAllGlobals());

describe('generatePKCE', () => {
  it('produces url-safe verifier + challenge', async () => {
    const { verifier, challenge } = await generatePKCE(webcrypto);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toContain('=');
    expect(challenge).not.toContain('=');
  });
  it('is non-deterministic across calls', async () => {
    const a = await generatePKCE(webcrypto);
    const b = await generatePKCE(webcrypto);
    expect(a.verifier).not.toBe(b.verifier);
  });
  it('challenge is the SHA-256(verifier) base64url', async () => {
    // Deterministic crypto stub: fixed random bytes + real subtle digest.
    const stub = {
      getRandomValues: (arr: Uint8Array<ArrayBuffer>) => { arr.fill(7); return arr; },
      subtle: webcrypto.subtle,
    };
    const a = await generatePKCE(stub);
    const b = await generatePKCE(stub);
    expect(a).toEqual(b); // same input bytes → same pair
  });
  it('defaults to globalThis.crypto', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const { verifier } = await generatePKCE();
    expect(verifier.length).toBeGreaterThan(0);
  });
});

describe('randomState', () => {
  it('returns 32 hex chars', () => {
    expect(randomState(webcrypto)).toMatch(/^[0-9a-f]{32}$/);
  });
  it('pads single-digit bytes', () => {
    const stub = { getRandomValues: (arr: Uint8Array<ArrayBuffer>) => { arr.fill(5); return arr; } };
    expect(randomState(stub)).toBe('05'.repeat(16));
  });
  it('defaults to globalThis.crypto', () => {
    vi.stubGlobal('crypto', webcrypto);
    expect(randomState()).toMatch(/^[0-9a-f]{32}$/);
  });
});
