// Phase 0 / issue #585 — regression coverage for review pass 1 findings
// (P1 "support-minimum derivation runs before the browser matrix" and P2
// "evidence discards browser-failure detail") fixed in `run-matrix.mjs`.
//
// Deliberately narrow: this file tests the exported PURE derivation
// functions directly against hand-built fixtures shaped exactly like the
// real `results.json.matrixRows`/`results.json.browserMatrix` and a real
// Playwright `--reporter=json` report's `suites` tree — no Docker, no
// Playwright, no live ClickHouse. `tests/spike/clickhouse-client/**` is
// explicitly excluded from the repo's 100/95/90/100 coverage floor
// (vitest.config.mjs's own header), so this is not a coverage-gate
// requirement — it is regression coverage for two review findings, per
// CLAUDE.md hard rule 1 ("add tests in the same change as the code").
import { describe, expect, it } from 'vitest';
import {
  selectEarliestPassingVersion,
  collectBrowserFailureDetail as collectBrowserFailureDetailUntyped,
  compareClickHouseVersions,
  classifyBrowserMatrixCell as classifyBrowserMatrixCellUntyped,
  classifyFunctionRangesFromSource as classifyFunctionRangesFromSourceUntyped,
  computeDeletionEstimate,
} from './run-matrix.mjs';

// `run-matrix.mjs` is a deliberately untyped `.mjs` orchestration module (plan
// §8) — `tsc`'s allowJs/checkJs:false interop infers its exports' shapes only
// weakly (e.g. an object literal built up via assignment infers as `{}`), so
// this file gives the one export it exercises beyond its return VALUE (never
// re-implementing its logic) an explicit local type for indexing.
interface BrowserFailureRecord {
  title: string;
  attempts: number;
  lastStatus: string;
  lastError: string;
}
const collectBrowserFailureDetail = collectBrowserFailureDetailUntyped as (pw: unknown) => Record<string, BrowserFailureRecord[]>;

interface BrowserMatrixCell {
  executed: boolean;
  status: string;
  failureDetail?: BrowserFailureRecord[];
}
const classifyBrowserMatrixCell = classifyBrowserMatrixCellUntyped as (args: {
  reportAvailable: boolean;
  rowOriginResults: Record<string, boolean> | null;
  rowOriginKey: string;
  allPassed: boolean;
  failureDetailByRowOrigin: Record<string, BrowserFailureRecord[]>;
}) => BrowserMatrixCell;

const classifyFunctionRangesFromSource = classifyFunctionRangesFromSourceUntyped as (
  src: string,
  classification: Record<string, string>,
  ignore?: string[],
  sourceLabel?: string,
) => Record<string, number>;

describe('selectEarliestPassingVersion (P1 review finding: derive only after the browser matrix runs)', () => {
  const matrixJson = {
    rows: {
      'proposed-oldest-oss': { kind: 'oss' },
      'current-stable-oss': { kind: 'oss' },
      'current-altinity-stable': { kind: 'altinity-stable' },
      cloud: { kind: 'cloud' },
    },
  };

  it('excludes a row whose OWN browser-matrix cell failed, even though its live suite + precision corpus passed — the exact P1 regression', () => {
    const results = {
      matrixRows: {
        'current-altinity-stable': { status: 'passed', serverVersion: '26.3.16.10001.altinitystable' },
        'current-stable-oss': { status: 'passed', serverVersion: '26.6.2.160' },
      },
      browserMatrix: {
        'current-altinity-stable/same-origin/chromium': { row: 'current-altinity-stable', origin: 'same-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
        'current-altinity-stable/same-origin/webkit': { row: 'current-altinity-stable', origin: 'same-origin', browser: 'webkit', requested: true, executed: true, status: 'failed' },
        'current-altinity-stable/cross-origin/chromium': { row: 'current-altinity-stable', origin: 'cross-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
        'current-altinity-stable/cross-origin/webkit': { row: 'current-altinity-stable', origin: 'cross-origin', browser: 'webkit', requested: true, executed: true, status: 'passed' },
        'current-stable-oss/same-origin/chromium': { row: 'current-stable-oss', origin: 'same-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
        'current-stable-oss/same-origin/webkit': { row: 'current-stable-oss', origin: 'same-origin', browser: 'webkit', requested: true, executed: true, status: 'passed' },
        'current-stable-oss/cross-origin/chromium': { row: 'current-stable-oss', origin: 'cross-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
        'current-stable-oss/cross-origin/webkit': { row: 'current-stable-oss', origin: 'cross-origin', browser: 'webkit', requested: true, executed: true, status: 'passed' },
      },
    };
    // 26.3.16.10001.altinitystable is lexicographically/numerically "earlier"
    // than 26.6.2.160 — the OLD (buggy) derivation, run before the browser
    // matrix existed, picked it anyway. The fix must exclude it because its
    // own same-origin/webkit cell failed, and select the row that actually
    // cleared every required combination instead.
    expect(selectEarliestPassingVersion(results, matrixJson)).toBe('26.6.2.160');
  });

  it('selects a row whose live suite AND every one of its own requested browser/origin combinations passed', () => {
    const results = {
      matrixRows: {
        'current-stable-oss': { status: 'passed', serverVersion: '26.6.2.160' },
      },
      browserMatrix: {
        'current-stable-oss/same-origin/chromium': { row: 'current-stable-oss', origin: 'same-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
        'current-stable-oss/same-origin/webkit': { row: 'current-stable-oss', origin: 'same-origin', browser: 'webkit', requested: true, executed: true, status: 'passed' },
      },
    };
    expect(selectEarliestPassingVersion(results, matrixJson)).toBe('26.6.2.160');
  });

  it('excludes a row the browser matrix never covered this invocation (no requested browser-matrix entries) — never assumes a gate that never ran', () => {
    const results = {
      matrixRows: {
        'current-stable-oss': { status: 'passed', serverVersion: '26.6.2.160' },
      },
      browserMatrix: {}, // e.g. --browsers none this invocation
    };
    expect(selectEarliestPassingVersion(results, matrixJson)).toBeNull();
  });

  it('picks the EARLIEST among multiple fully-corroborated candidates', () => {
    const results = {
      matrixRows: {
        'proposed-oldest-oss': { status: 'passed', serverVersion: '24.8.14.39' },
        'current-stable-oss': { status: 'passed', serverVersion: '26.6.2.160' },
      },
      browserMatrix: {
        'proposed-oldest-oss/same-origin/chromium': { row: 'proposed-oldest-oss', origin: 'same-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
        'current-stable-oss/same-origin/chromium': { row: 'current-stable-oss', origin: 'same-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
      },
    };
    expect(selectEarliestPassingVersion(results, matrixJson)).toBe('24.8.14.39');
  });

  it('excludes a row whose live suite/precision corpus did not pass, regardless of its browser-matrix result', () => {
    const results = {
      matrixRows: {
        'proposed-oldest-oss': { status: 'failed', serverVersion: '24.8.14.39' },
      },
      browserMatrix: {
        'proposed-oldest-oss/same-origin/chromium': { row: 'proposed-oldest-oss', origin: 'same-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
      },
    };
    expect(selectEarliestPassingVersion(results, matrixJson)).toBeNull();
  });

  it('excludes a row whose kind is not oss/altinity-stable (e.g. cloud) even if every gate passed', () => {
    const results = {
      matrixRows: {
        cloud: { status: 'passed', serverVersion: '99.9.9.9' },
      },
      browserMatrix: {
        'cloud/same-origin/chromium': { row: 'cloud', origin: 'same-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
      },
    };
    expect(selectEarliestPassingVersion(results, matrixJson)).toBeNull();
  });

  it('P2 review finding regression: picks the numerically-earlier 26.9.1.1 over 26.10.1.1, not the lexicographically-earlier one', () => {
    // '26.10.1.1' < '26.9.1.1' as plain strings (JS lexicographic '<') — the
    // exact digit-count-mismatch bug the finding named. The numerically
    // earlier version is 26.9.1.1; the fix must select it, never 26.10.1.1.
    const results = {
      matrixRows: {
        'current-stable-oss': { status: 'passed', serverVersion: '26.10.1.1' },
        'current-altinity-stable': { status: 'passed', serverVersion: '26.9.1.1' },
      },
      browserMatrix: {
        'current-stable-oss/same-origin/chromium': { row: 'current-stable-oss', origin: 'same-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
        'current-altinity-stable/same-origin/chromium': { row: 'current-altinity-stable', origin: 'same-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
      },
    };
    expect(selectEarliestPassingVersion(results, matrixJson)).toBe('26.9.1.1');
  });

  it('a browser-matrix cell that is present but NOT requested this invocation does not corroborate, and does not count as required', () => {
    // Only requested cells are "required" — an unrequested (informational)
    // entry present in the map must never make an otherwise-uncorroborated
    // row look validated.
    const results = {
      matrixRows: {
        'current-stable-oss': { status: 'passed', serverVersion: '26.6.2.160' },
      },
      browserMatrix: {
        'current-stable-oss/same-origin/chromium': { row: 'current-stable-oss', origin: 'same-origin', browser: 'chromium', requested: true, executed: true, status: 'passed' },
        'current-stable-oss/same-origin/webkit': { row: 'current-stable-oss', origin: 'same-origin', browser: 'webkit', requested: false, executed: false, status: 'not-run-this-invocation' },
      },
    };
    // The requested chromium cell passed; the unrequested webkit cell is
    // correctly ignored (not a required combo this invocation), so the row
    // still corroborates.
    expect(selectEarliestPassingVersion(results, matrixJson)).toBe('26.6.2.160');
  });
});

describe('collectBrowserFailureDetail (P2 review finding: preserve a compact failure record)', () => {
  function pwReportWith(suites: unknown[]) {
    return { suites: [{ title: 'browser.spec.js', suites }] };
  }

  it('collects a compact record (title, attempts, lastStatus, lastError) for a failing spec, keyed by row/origin', () => {
    const pw = pwReportWith([
      {
        title: 'row=current-altinity-stable origin=same-origin',
        specs: [
          {
            title: 'renders without runtime errors',
            ok: false,
            tests: [
              {
                results: [
                  { status: 'failed', error: { message: 'TimeoutError: waiting for selector (attempt 1)' } },
                  { status: 'failed', error: { message: 'TimeoutError: waiting for selector (attempt 2)' } },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const detail = collectBrowserFailureDetail(pw);
    expect(detail['current-altinity-stable/same-origin']).toEqual([
      { title: 'renders without runtime errors', attempts: 2, lastStatus: 'failed', lastError: 'TimeoutError: waiting for selector (attempt 2)' },
    ]);
  });

  it('omits a row/origin whose specs all passed cleanly — never a misleading empty entry', () => {
    const pw = pwReportWith([
      {
        title: 'row=current-stable-oss origin=same-origin',
        specs: [{ title: 'renders without runtime errors', ok: true, tests: [{ results: [{ status: 'passed' }] }] }],
      },
    ]);
    const detail = collectBrowserFailureDetail(pw);
    expect(detail).toEqual({});
  });

  it('walks nested suites and handles multiple row/origin blocks independently', () => {
    const pw = pwReportWith([
      {
        title: 'row=current-altinity-stable origin=same-origin',
        specs: [{ title: 'spec A', ok: false, tests: [{ results: [{ status: 'failed', error: { message: 'boom A' } }] }] }],
      },
      {
        title: 'nesting wrapper',
        suites: [
          {
            title: 'row=current-stable-oss origin=cross-origin',
            specs: [{ title: 'spec B', ok: false, tests: [{ results: [{ status: 'timedOut' }] }] }],
          },
        ],
      },
    ]);
    const detail = collectBrowserFailureDetail(pw);
    expect(detail['current-altinity-stable/same-origin']).toEqual([{ title: 'spec A', attempts: 1, lastStatus: 'failed', lastError: 'boom A' }]);
    expect(detail['current-stable-oss/cross-origin']).toEqual([{ title: 'spec B', attempts: 1, lastStatus: 'timedOut', lastError: '' }]);
  });

  it('truncates a long error message to 500 characters — durable evidence, not a full debugging transcript', () => {
    const longMessage = 'x'.repeat(2000);
    const pw = pwReportWith([
      {
        title: 'row=current-altinity-stable origin=same-origin',
        specs: [{ title: 'spec A', ok: false, tests: [{ results: [{ status: 'failed', error: { message: longMessage } }] }] }],
      },
    ]);
    const detail = collectBrowserFailureDetail(pw);
    expect(detail['current-altinity-stable/same-origin'][0].lastError).toHaveLength(500);
  });

  it('returns an empty object for a report with no suites at all', () => {
    expect(collectBrowserFailureDetail({})).toEqual({});
  });
});

describe('compareClickHouseVersions (P2 review finding: numeric, not lexicographic, ordering)', () => {
  it('orders 26.9.1.1 before 26.10.1.1 — the exact digit-count-mismatch regression the finding asked for', () => {
    expect(compareClickHouseVersions('26.9.1.1', '26.10.1.1')).toBeLessThan(0);
    expect(compareClickHouseVersions('26.10.1.1', '26.9.1.1')).toBeGreaterThan(0);
    // The old lexicographic comparator got this backwards.
    expect('26.10.1.1' < '26.9.1.1').toBe(true);
  });

  it('orders 24.9 before 24.10 before 24.11 before 24.12 — a real ClickHouse minor-line pattern', () => {
    const versions = ['24.10', '24.12', '24.9', '24.11'];
    const sorted = [...versions].sort(compareClickHouseVersions);
    expect(sorted).toEqual(['24.9', '24.10', '24.11', '24.12']);
  });

  it('returns 0 for identical versions', () => {
    expect(compareClickHouseVersions('26.6.2.160', '26.6.2.160')).toBe(0);
  });

  it('compares the real matrix.json candidate versions consistently with their intended order', () => {
    expect(compareClickHouseVersions('24.8.14.39', '26.6.2.160')).toBeLessThan(0);
    expect(compareClickHouseVersions('26.3.16.10001.altinitystable', '26.6.2.160')).toBeLessThan(0);
  });

  it('falls back to a string compare only for a non-numeric trailing segment, after all leading numeric segments are equal', () => {
    // Same numeric prefix, different non-numeric suffix — never throws, never
    // treats the non-numeric segment as numerically equal.
    expect(compareClickHouseVersions('24.8.14.1.altinitystable', '24.8.14.1.zzz')).toBeLessThan(0);
  });
});

describe('classifyBrowserMatrixCell (P2 review finding: a missing suite must never inherit the project-wide blanket pass)', () => {
  it('case 3 — report exists but has no suite for this row/origin: executed:false, status "no-matching-suite-in-report", even when the project-wide signal is a pass', () => {
    const cell = classifyBrowserMatrixCell({
      reportAvailable: true,
      rowOriginResults: { 'current-stable-oss/same-origin': true }, // a DIFFERENT row/origin's suite ran and passed
      rowOriginKey: 'current-altinity-stable/same-origin', // this row/origin has no matching suite at all
      allPassed: true, // the project-wide blanket signal, which must NOT be inherited
      failureDetailByRowOrigin: {},
    });
    expect(cell).toEqual({ executed: false, status: 'no-matching-suite-in-report' });
  });

  it('a focused reproduction of the finding: feeding case-3 output into selectEarliestPassingVersion never corroborates the row', () => {
    const matrixJson = { rows: { 'current-altinity-stable': { kind: 'altinity-stable' } } };
    const cell = classifyBrowserMatrixCell({
      reportAvailable: true,
      rowOriginResults: {}, // no suite for ANY row/origin matched (e.g. a whole-file collection error)
      rowOriginKey: 'current-altinity-stable/same-origin',
      allPassed: true, // pw.stats.unexpected === 0 — the fabricated-pass condition the finding describes
      failureDetailByRowOrigin: {},
    });
    const results = {
      matrixRows: { 'current-altinity-stable': { status: 'passed', serverVersion: '26.3.16.10001.altinitystable' } },
      browserMatrix: {
        'current-altinity-stable/same-origin/webkit': { row: 'current-altinity-stable', origin: 'same-origin', browser: 'webkit', requested: true, ...cell },
      },
    };
    // Before the fix, `cell` would have been `{ executed: true, status: 'passed' }`
    // (inherited from `allPassed`), and this would have returned the
    // fabricated-pass version instead of null.
    expect(selectEarliestPassingVersion(results, matrixJson)).toBeNull();
  });

  it('case 2 — report exists and has a matching suite: per-cell result is authoritative, independent of the blanket signal', () => {
    const passCell = classifyBrowserMatrixCell({
      reportAvailable: true,
      rowOriginResults: { 'current-stable-oss/same-origin': true },
      rowOriginKey: 'current-stable-oss/same-origin',
      allPassed: false, // blanket signal disagrees — must not matter
      failureDetailByRowOrigin: {},
    });
    expect(passCell).toEqual({ executed: true, status: 'passed' });

    const failCell = classifyBrowserMatrixCell({
      reportAvailable: true,
      rowOriginResults: { 'current-stable-oss/same-origin': false },
      rowOriginKey: 'current-stable-oss/same-origin',
      allPassed: true, // blanket signal disagrees — must not matter
      failureDetailByRowOrigin: { 'current-stable-oss/same-origin': [{ title: 'spec A', attempts: 1, lastStatus: 'failed', lastError: 'boom' }] },
    });
    expect(failCell).toEqual({
      executed: true,
      status: 'failed',
      failureDetail: [{ title: 'spec A', attempts: 1, lastStatus: 'failed', lastError: 'boom' }],
    });
  });

  it('case 1 — report itself unavailable: inherits the blanket signal (the ONLY case this is legitimate)', () => {
    expect(classifyBrowserMatrixCell({
      reportAvailable: false, rowOriginResults: null, rowOriginKey: 'current-stable-oss/same-origin', allPassed: true, failureDetailByRowOrigin: {},
    })).toEqual({ executed: true, status: 'passed' });
    expect(classifyBrowserMatrixCell({
      reportAvailable: false, rowOriginResults: null, rowOriginKey: 'current-stable-oss/same-origin', allPassed: false, failureDetailByRowOrigin: {},
    })).toEqual({ executed: true, status: 'failed' });
  });

  it('a failed per-cell result with no failureDetail entry never fabricates an empty array', () => {
    const cell = classifyBrowserMatrixCell({
      reportAvailable: true,
      rowOriginResults: { 'current-stable-oss/same-origin': false },
      rowOriginKey: 'current-stable-oss/same-origin',
      allPassed: false,
      failureDetailByRowOrigin: {}, // no detail collected for this key
    });
    expect(cell).toEqual({ executed: true, status: 'failed' });
    expect(cell.failureDetail).toBeUndefined();
  });
});

describe('classifyFunctionRangesFromSource (P3 review finding: one consistent comment/blank-stripped metric for every deletion-estimate term)', () => {
  it('excludes a symbol range\'s own comments and blank lines the same way measureLoc excludes them from a whole file', () => {
    // `foo`'s raw line range (its declaration line through the line before
    // `bar`'s declaration) is 8 lines, 4 of which are a line comment, a
    // blank line, and a two-line block comment — none of which are
    // "executable" by any definition. Before the fix, this function summed
    // the raw 8; the fix sums the comment/blank-stripped 4, matching
    // measureLoc()'s own `physical` field's definition exactly.
    const src = [
      'export function foo() {',
      '  // a comment line',
      '',
      '  const x = 1; // trailing',
      '  /* block',
      '     comment */',
      '  return x;',
      '}',
      'export function bar() {',
      '  return 2;',
      '}',
    ].join('\n');

    const buckets = classifyFunctionRangesFromSource(src, { foo: 'commentHeavy', bar: 'commentLight' });

    expect(buckets.commentHeavy).toBe(4); // NOT 8 (the raw range size)
    expect(buckets.commentLight).toBe(3); // unaffected — bar has no comments/blanks to strip
  });

  it('still throws on an unclassified top-level symbol (drift protection unaffected by the metric change)', () => {
    const src = 'export function unclassifiedOne() {\n  return 1;\n}\n';
    expect(() => classifyFunctionRangesFromSource(src, {}, [], 'fixture.ts'))
      .toThrow(/unclassified top-level symbol.*unclassifiedOne/);
  });

  it('still honors the ignore list without counting the ignored symbol into any bucket', () => {
    const src = 'export const ignoredOne = 1;\nexport function counted() {\n  return 2;\n}\n';
    const buckets = classifyFunctionRangesFromSource(src, { counted: 'bucketA' }, ['ignoredOne']);
    expect(buckets).toEqual({ bucketA: 3 });
  });
});

describe('computeDeletionEstimate (P3 review finding: the whole-formula regression — every term consistent end to end)', () => {
  it('produces internally self-consistent buckets: the formula computed by hand from the manifest matches netExecutableDeletion exactly', async () => {
    const d = await computeDeletionEstimate();
    const handComputed = d.currentGenericLocEligibleForDeletion - d.estimatedOfficialAdapterLoc - d.acceptedBridgeGuardLoc;
    expect(d.netExecutableDeletion).toBe(handComputed);
    // acceptedBridgeGuardLoc is bridgeLoc.physical + guardLoc.physical, and
    // both bridgeLoc/guardLoc come from measureLoc() — same physicalLineCount
    // helper classifyFunctionRangesFromSource now uses for the other two
    // terms, so this is genuinely one metric throughout, not two that
    // happen to agree on this particular file pair.
    expect(d.acceptedBridgeGuardLoc).toBe(d.bridgeLoc.physical + d.guardLoc.physical);
  });
});
