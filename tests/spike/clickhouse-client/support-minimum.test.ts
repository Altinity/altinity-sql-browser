// Phase 0 / issue #585 — regression coverage for the P1 review finding's
// mislabeling half: `deriveProposedMinimum`'s "earliest passing" floor label
// claimed "(live matrix)" even though `run-matrix.mjs` feeds it back only
// after ALSO validating the row's own browser-matrix results (fixed
// alongside `selectEarliestPassingVersion` in run-matrix.mjs). Deliberately
// narrow: exercises the real `deriveProposedMinimum`/`renderSupportMinimumMd`
// against the real installed `@clickhouse/client-web` README (no fixture
// substitute — the function's own citation-or-throw contract requires it),
// asserting only the label text this fix changed. `tests/spike/
// clickhouse-client/**` is excluded from the repo's 100/95/90/100 coverage
// floor (vitest.config.mjs's own header) — this is regression coverage, not
// a coverage-gate requirement, per CLAUDE.md hard rule 1.
import { describe, expect, it } from 'vitest';
import { deriveProposedMinimum as deriveProposedMinimumUntyped, renderSupportMinimumMd } from './support-minimum.mjs';

// `support-minimum.mjs` is a deliberately untyped `.mjs` module (plan §8) —
// `tsc`'s allowJs/checkJs:false interop infers `earliestPassingVersion`'s
// parameter type from its `= null` default alone (never widened to
// `string | null`), so this file gives the one call signature it exercises
// an explicit local type, never re-implementing the function's own logic.
interface SupportMinimumAnalysis {
  floors: Array<{ source: string; value: string }>;
  liveGateCorroboration: { evaluated: boolean; earliestPassingVersion?: string | null };
  [key: string]: unknown;
}
const deriveProposedMinimum = deriveProposedMinimumUntyped as (opts: { repoRoot?: string; earliestPassingVersion?: string | null }) => SupportMinimumAnalysis;

describe('deriveProposedMinimum / renderSupportMinimumMd — earliest-passing-version label accuracy', () => {
  it('labels the live-gate-corroboration floor as validated against the live matrix, precision corpus, AND browser matrix — never "(live matrix)" alone', () => {
    const analysis = deriveProposedMinimum({ earliestPassingVersion: '26.6.2.160' });
    const floor = analysis.floors.find((f: { source: string }) => f.source.startsWith('earliest version that passed every required hard gate'));
    expect(floor).toBeDefined();
    expect(floor!.source).toBe('earliest version that passed every required hard gate (live matrix, precision corpus, and browser matrix)');
    expect(floor!.value).toBe('26.6.2.160');

    const md = renderSupportMinimumMd(analysis);
    expect(md).toContain('earliest version that passed every required hard gate (live matrix, precision corpus, and browser matrix)');
    expect(md).not.toContain('earliest version that passed every required hard gate (live matrix)=');
  });

  it('omits the live-gate-corroboration floor entirely when no version has been fed back yet (steps 1-4 only)', () => {
    const analysis = deriveProposedMinimum({});
    const floor = analysis.floors.find((f: { source: string }) => f.source.startsWith('earliest version that passed every required hard gate'));
    expect(floor).toBeUndefined();
    expect(analysis.liveGateCorroboration.evaluated).toBe(false);
  });
});
