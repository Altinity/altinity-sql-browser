import { describe, it, expect } from 'vitest';
import { randomHandoffToken } from '../../src/core/handoff-token.js';

/** A fake `Crypto.getRandomValues` that fills a deterministic byte pattern and
 * records what it was asked to fill, so tests can assert the exact call shape
 * (one Uint8Array, 32 bytes long) as well as the resulting hex mapping. */
function fakeCrypto(fill: (bytes: Uint8Array) => void): { crypto: Pick<Crypto, 'getRandomValues'>; calls: Uint8Array[] } {
  const calls: Uint8Array[] = [];
  return {
    calls,
    crypto: {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        const bytes = array as unknown as Uint8Array;
        calls.push(bytes);
        fill(bytes);
        return array;
      },
    },
  };
}

describe('randomHandoffToken', () => {
  it('reads exactly 32 bytes via getRandomValues', () => {
    const { crypto, calls } = fakeCrypto((bytes) => bytes.fill(0));
    randomHandoffToken(crypto);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(Uint8Array);
    expect(calls[0].length).toBe(32);
  });

  it('returns 64 lowercase hex chars', () => {
    const { crypto } = fakeCrypto((bytes) => bytes.fill(0xab));
    const token = randomHandoffToken(crypto);
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps each byte to its correct hex pair, in order', () => {
    const { crypto } = fakeCrypto((bytes) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = i;
    });
    const token = randomHandoffToken(crypto);
    const expected = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('');
    expect(token).toBe(expected);
  });

  it('covers the low/high nibble boundary (0x00 and 0xff)', () => {
    const { crypto } = fakeCrypto((bytes) => {
      bytes[0] = 0x00;
      bytes[1] = 0xff;
      for (let i = 2; i < bytes.length; i++) bytes[i] = 0;
    });
    const token = randomHandoffToken(crypto);
    expect(token.slice(0, 4)).toBe('00ff');
  });
});
