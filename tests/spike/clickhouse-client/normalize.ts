// Phase 0 / issue #585 — pure comparison/normalization helpers for the parity
// harness. No fetch, no DOM, no adapter-specific imports: this module only
// knows about the test-owned `SpikeOutcome`/`ExpectedOutcome` shapes
// (types.ts), matching the "pure logic has no side effects" discipline
// CLAUDE.md asks of `src/core/` — this is the spike's equivalent for
// `tests/spike/clickhouse-client/`.

import type { ExpectedOutcome, ParityResult, SpikeOutcome } from './types.js';

/** Incremental-BY-INTERFACE SHA-256 over raw byte chunks, built on the
 * standard Web Crypto `crypto.subtle` API (available globally in Node >=19
 * and every target browser) rather than `node:crypto` — deliberately, so
 * this TypeScript file needs no `@types/node` (plan §8: "Node orchestration
 * and configuration files remain `.mjs` or `.js`, avoiding an unrelated
 * global Node-type decision" — the same reasoning extends to every spike
 * `.ts` file, not just the `.mjs` orchestrators). `SubtleCrypto` has no
 * streaming `update()`, so chunks are retained and concatenated once at
 * `digestHex()` time; for the spike's fixture/export-sized payloads this is
 * negligible and the *comparison* (current vs. official, both computed the
 * same way) is unaffected either way. Used identically for the current
 * export path and the official `exec()` raw path so a match proves
 * byte-for-byte equality regardless of chunk boundaries (plan §24). */
export class IncrementalSha256 {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  update(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
  }
  async digestHex(): Promise<string> {
    const whole = new Uint8Array(this.bytes);
    let offset = 0;
    for (const c of this.chunks) { whole.set(c, offset); offset += c.byteLength; }
    const digest = await crypto.subtle.digest('SHA-256', whole);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  get totalBytes(): number {
    return this.bytes;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** Fields an `ExpectedOutcome` may declare — everything on `SpikeOutcome`
 * except the raw `events` timeline (which is evidence, not an assertion
 * target) and the `because` justification string itself. */
const COMPARABLE_KEYS: (keyof Omit<SpikeOutcome, 'events'>)[] = [
  'columns', 'rows', 'partialRowCount', 'progress', 'error', 'cancelled',
  'chCode', 'chMessage', 'httpStatus', 'queryId', 'responseHeaders', 'summary',
  'rawByteCount', 'rawSha256', 'authEffects', 'firstRowAtMs', 'completedAtMs',
];

/** Compare one adapter's outcome against an independently-declared expected
 * partial. Only keys present on `expected` are checked (plan §15: an
 * `ExpectedOutcome` is deliberately partial). Returns the mismatch messages
 * (empty = match). */
export function diffAgainstExpected(actual: SpikeOutcome, expected: ExpectedOutcome, label: string): string[] {
  const mismatches: string[] = [];
  for (const key of COMPARABLE_KEYS) {
    if (!(key in expected)) continue;
    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (!deepEqual(actualValue, expectedValue)) {
      mismatches.push(`${label}.${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`);
    }
  }
  return mismatches;
}

/** Compare the current-adapter outcome directly against the official-adapter
 * outcome (pairwise) — plan §15: "Pairwise equality alone is insufficient",
 * so this is ALWAYS run alongside (never instead of) `diffAgainstExpected`
 * for both sides. */
export function diffOutcomes(current: SpikeOutcome, official: SpikeOutcome): string[] {
  const mismatches: string[] = [];
  for (const key of COMPARABLE_KEYS) {
    if (!deepEqual(current[key], official[key])) {
      mismatches.push(`current.${key} vs official.${key}: ${JSON.stringify(current[key])} !== ${JSON.stringify(official[key])}`);
    }
  }
  return mismatches;
}

/** Assemble one scenario's full `ParityResult` from both adapters' raw
 * outcomes plus the scenario's independent expectation. */
export function buildParityResult(
  scenarioId: string,
  currentOutcome: SpikeOutcome,
  officialOutcome: SpikeOutcome,
  expected: ExpectedOutcome,
): ParityResult {
  const currentMismatches = diffAgainstExpected(currentOutcome, expected, 'current');
  const officialMismatches = diffAgainstExpected(officialOutcome, expected, 'official');
  const pairwiseMismatches = diffOutcomes(currentOutcome, officialOutcome);
  return {
    scenarioId,
    currentOutcome,
    officialOutcome,
    currentMatchesExpected: currentMismatches.length === 0,
    officialMatchesExpected: officialMismatches.length === 0,
    currentMatchesOfficial: pairwiseMismatches.length === 0,
    mismatches: [...currentMismatches, ...officialMismatches, ...pairwiseMismatches],
  };
}

/** A fresh, empty `SpikeOutcome` — the shape every adapter builds up via
 * `applyStreamLine`-equivalent folding (current) or the progress bridge
 * (official). Mirrors `core/stream.ts`'s `newResult()` shape but in the
 * spike's own normalized vocabulary. */
export function emptyOutcome(): SpikeOutcome {
  return {
    columns: [],
    rows: [],
    partialRowCount: 0,
    progress: null,
    error: null,
    cancelled: false,
    chCode: null,
    chMessage: null,
    httpStatus: null,
    queryId: null,
    responseHeaders: {},
    summary: null,
    rawByteCount: null,
    rawSha256: null,
    authEffects: [],
    events: [],
    firstRowAtMs: null,
    completedAtMs: null,
  };
}
