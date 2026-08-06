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
  computeGates as computeGatesUntyped,
  deriveDecision as deriveDecisionUntyped,
} from './run-matrix.mjs';

const computeGates = computeGatesUntyped as (r: unknown) => Record<string, string>;
const deriveDecision = deriveDecisionUntyped as (gates: Record<string, string>) => { status: string; rationale: string[] };

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
  projectErrors?: string[];
}
const classifyBrowserMatrixCell = classifyBrowserMatrixCellUntyped as (args: {
  reportAvailable: boolean;
  rowOriginResults: Record<string, boolean> | null;
  rowOriginKey: string;
  allPassed: boolean;
  failureDetailByRowOrigin: Record<string, BrowserFailureRecord[]>;
  pwErrors?: string[];
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

  it('a "flaky" browser-matrix cell (passed only after a retry — the playwright.config.js retries:2 fix) still clears the browser hard gate, same as a clean "passed"', () => {
    const results = {
      matrixRows: {
        'current-altinity-stable': { status: 'passed', serverVersion: '26.3.16.10001.altinitystable' },
      },
      browserMatrix: {
        'current-altinity-stable/same-origin/webkit': {
          row: 'current-altinity-stable', origin: 'same-origin', browser: 'webkit', requested: true, executed: true,
          status: 'flaky',
          failureDetail: [{ title: 'renders without runtime errors', attempts: 2, lastStatus: 'passed', lastError: '' }],
        },
      },
    };
    // Before this fix, a flaky cell either laundered into a bare 'passed'
    // (losing the retry signal) or would have needed to be misclassified as
    // 'failed' to preserve it — neither is correct. It DID pass, just not on
    // attempt 1, and the row must still be named as having cleared the gate.
    expect(selectEarliestPassingVersion(results, matrixJson)).toBe('26.3.16.10001.altinitystable');
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

  // Issue #585 Docker-contention flake fix (playwright.config.js retries:2):
  // a spec that failed once and then passed on retry used to be silently
  // discarded here (the old `if (spec.ok === true) continue` guard saw only
  // the spec's FINAL, passing outcome) — a real flake laundered into a
  // clean, silent pass. This is the exact scenario that makes the
  // `attempts: 2` shape below meaningful now: with real retries:2 configured,
  // Playwright's OWN JSON report can genuinely contain 2 results for one
  // test, the second of which passed.
  it('collects a compact record for a FLAKY spec — passed only after a retry (attempts>1, final status passed, spec.ok true)', () => {
    const pw = pwReportWith([
      {
        title: 'row=current-altinity-stable origin=same-origin',
        specs: [
          {
            title: 'renders without runtime errors',
            ok: true, // the spec DID pass in the end — this is NOT a failure
            tests: [
              {
                results: [
                  { status: 'failed', error: { message: 'TimeoutError: waiting for selector (attempt 1)' } },
                  { status: 'passed' },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const detail = collectBrowserFailureDetail(pw);
    // Before the fix, this row/origin would have been entirely absent from
    // `detail` (spec.ok === true short-circuited the whole spec) even though
    // it needed a real retry to get there.
    expect(detail['current-altinity-stable/same-origin']).toEqual([
      { title: 'renders without runtime errors', attempts: 2, lastStatus: 'passed', lastError: '' },
    ]);
  });

  it('still omits a spec that passed cleanly on its very first attempt, even alongside a flaky one in the same row/origin', () => {
    const pw = pwReportWith([
      {
        title: 'row=current-stable-oss origin=same-origin',
        specs: [
          { title: 'clean pass', ok: true, tests: [{ results: [{ status: 'passed' }] }] },
          { title: 'flaky pass', ok: true, tests: [{ results: [{ status: 'failed', error: { message: 'boom' } }, { status: 'passed' }] }] },
        ],
      },
    ]);
    const detail = collectBrowserFailureDetail(pw);
    expect(detail['current-stable-oss/same-origin']).toEqual([
      { title: 'flaky pass', attempts: 2, lastStatus: 'passed', lastError: '' },
    ]);
  });

  // Observability-gap fix (issue #585): a captured `lastError` retained raw
  // ANSI escape codes live (verified: a literal `\x1b[2m...` sequence) —
  // stripped at CAPTURE time here, not just when rendering, so a committed
  // compatibility-matrix.md can never contain a terminal escape code.
  it('strips ANSI escape sequences from a captured lastError at capture time', () => {
    const rawMessage = '[2mgray context[22m real error text';
    const pw = pwReportWith([
      {
        title: 'row=current-altinity-stable origin=same-origin',
        specs: [
          { title: 'spec A', ok: false, tests: [{ results: [{ status: 'failed', error: { message: rawMessage } }] }] },
        ],
      },
    ]);
    const detail = collectBrowserFailureDetail(pw);
    expect(detail['current-altinity-stable/same-origin'][0].lastError).toBe('gray context real error text');
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

  // Issue #585 Docker-contention flake fix: a row/origin whose specs' FINAL
  // attempts all passed (rowOriginResults[key] === true) but which has
  // non-empty collected detail (i.e. at least one spec needed a retry) must
  // be reported as its own 'flaky' status — never a silent 'passed' that
  // discards the retry, and never 'failed', which it isn't.
  it('case 2 — a row/origin that passed overall but has non-empty detail (a flaky pass) is reported as "flaky", with the SAME detail attached', () => {
    const flakyDetail = [{ title: 'renders without runtime errors', attempts: 2, lastStatus: 'passed', lastError: '' }];
    const cell = classifyBrowserMatrixCell({
      reportAvailable: true,
      rowOriginResults: { 'current-altinity-stable/same-origin': true },
      rowOriginKey: 'current-altinity-stable/same-origin',
      allPassed: true,
      failureDetailByRowOrigin: { 'current-altinity-stable/same-origin': flakyDetail },
    });
    expect(cell).toEqual({ executed: true, status: 'flaky', failureDetail: flakyDetail });
  });

  it('case 2 — a row/origin that passed with NO detail (a genuinely clean pass) stays "passed", not "flaky"', () => {
    const cell = classifyBrowserMatrixCell({
      reportAvailable: true,
      rowOriginResults: { 'current-stable-oss/same-origin': true },
      rowOriginKey: 'current-stable-oss/same-origin',
      allPassed: true,
      failureDetailByRowOrigin: {},
    });
    expect(cell).toEqual({ executed: true, status: 'passed' });
  });

  // Observability-gap fix (issue #585): a whole-project/webServer-level
  // failure (Playwright's own top-level `pw.errors[]`) used to attach no
  // detail at all in cases 1 and 3 — as blank as a clean pass. `pwErrors` is
  // pre-extracted by the caller (ANSI-stripped, truncated) and threaded
  // through here as `projectErrors`.
  it('case 1 — report unavailable but pwErrors provided: attaches projectErrors alongside the blanket signal', () => {
    const cell = classifyBrowserMatrixCell({
      reportAvailable: false, rowOriginResults: null, rowOriginKey: 'current-stable-oss/same-origin', allPassed: false, failureDetailByRowOrigin: {},
      pwErrors: ['Timed out waiting 240000ms from config.webServer.'],
    });
    expect(cell).toEqual({ executed: true, status: 'failed', projectErrors: ['Timed out waiting 240000ms from config.webServer.'] });
  });

  it('case 3 — report exists with no matching suite at all, and pwErrors provided (a whole-project failure): attaches projectErrors, never blank', () => {
    const cell = classifyBrowserMatrixCell({
      reportAvailable: true, rowOriginResults: {}, rowOriginKey: 'current-altinity-stable/same-origin', allPassed: true, failureDetailByRowOrigin: {},
      pwErrors: ['globalSetup failed: ECONNREFUSED 127.0.0.1:5680'],
    });
    expect(cell).toEqual({ executed: false, status: 'no-matching-suite-in-report', projectErrors: ['globalSetup failed: ECONNREFUSED 127.0.0.1:5680'] });
  });

  it('pwErrors defaults to empty — no projectErrors field fabricated when omitted or empty', () => {
    expect(classifyBrowserMatrixCell({
      reportAvailable: false, rowOriginResults: null, rowOriginKey: 'x/y', allPassed: true, failureDetailByRowOrigin: {},
    })).toEqual({ executed: true, status: 'passed' });
    expect(classifyBrowserMatrixCell({
      reportAvailable: true, rowOriginResults: {}, rowOriginKey: 'x/y', allPassed: false, failureDetailByRowOrigin: {}, pwErrors: [],
    })).toEqual({ executed: false, status: 'no-matching-suite-in-report' });
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

describe('classifyFunctionRangesFromSource — broadened boundary regex (issue #585 Phase 1 drift: real ch-client.ts symbols lost their `export` keyword after the transport-seam refactor, PR #621)', () => {
  it('matches a non-exported top-level function declaration as its own boundary, not silently absorbed into (or dropped ahead of) an exported neighbor', () => {
    const src = [
      'function helper() {',
      '  return 1;',
      '}',
      'export function main() {',
      '  return 2;',
      '}',
    ].join('\n');
    const buckets = classifyFunctionRangesFromSource(src, { helper: 'bucketA', main: 'bucketB' });
    expect(buckets).toEqual({ bucketA: 3, bucketB: 3 });
  });

  it('matches a non-exported top-level const declaration as its own boundary', () => {
    const src = [
      'const TABLE = 1;',
      'export function main() {',
      '  return 2;',
      '}',
    ].join('\n');
    const buckets = classifyFunctionRangesFromSource(src, { TABLE: 'bucketA', main: 'bucketB' });
    expect(buckets).toEqual({ bucketA: 1, bucketB: 3 });
  });

  it('matches a non-exported top-level async function declaration', () => {
    const src = [
      'async function helper() {',
      '  return 1;',
      '}',
    ].join('\n');
    const buckets = classifyFunctionRangesFromSource(src, { helper: 'bucketA' });
    expect(buckets).toEqual({ bucketA: 3 });
  });

  it('still never matches a nested (indented) declaration as its own top-level boundary', () => {
    const src = [
      'export function outer() {',
      '  function inner() {',
      '    return 1;',
      '  }',
      '  return inner();',
      '}',
    ].join('\n');
    // `inner` is indented, never `^`-anchored — it must NOT appear as its own
    // boundary (and therefore needs no classification entry of its own);
    // its lines are simply part of `outer`'s range.
    const buckets = classifyFunctionRangesFromSource(src, { outer: 'bucketA' });
    expect(buckets).toEqual({ bucketA: 6 });
  });
});

describe('classifyFunctionRangesFromSource — symmetric drift guard (the mirror of the unclassified-symbol throw: a classification-table entry that stops matching anything)', () => {
  it('does not throw when every classification-table entry matches something in the source', () => {
    const src = 'export function foo() {\n  return 1;\n}\nconst bar = 2;\n';
    expect(() => classifyFunctionRangesFromSource(src, { foo: 'bucketA', bar: 'bucketB' })).not.toThrow();
  });

  it('throws when a classification-table entry never matches any top-level symbol in the source — the exact issue #585 Phase 1 shape (`chUrl` moving out of ch-client.ts without its old table entry being removed)', () => {
    const src = 'export function foo() {\n  return 1;\n}\n';
    expect(() => classifyFunctionRangesFromSource(src, { foo: 'bucketA', chUrl: 'bucketB' }, [], 'fixture.ts'))
      .toThrow(/classification-table entry that no longer match.*chUrl/);
  });

  it('reports every stale entry, not just the first, when more than one classification-table entry stops matching', () => {
    const src = 'export function foo() {\n  return 1;\n}\n';
    expect(() => classifyFunctionRangesFromSource(src, { foo: 'bucketA', gone1: 'bucketB', gone2: 'bucketC' }))
      .toThrow(/gone1, gone2/);
  });

  it('does not flag an ignore-listed symbol as stale even when it never matches anything (a type-only interface is legitimately never a boundary)', () => {
    const src = 'export function foo() {\n  return 1;\n}\n';
    // `TypeOnlyThing` is in `ignore`, not in `classification` — this must not
    // throw, matching how official-adapter.ts's `RefreshDrivenResult`
    // interface is handled in run-matrix.mjs's own OFFICIAL_ADAPTER_TEST_ONLY_SYMBOLS.
    expect(() => classifyFunctionRangesFromSource(src, { foo: 'bucketA' }, ['TypeOnlyThing'])).not.toThrow();
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

  it('classifies src/net/clickhouse-http-transport.ts on its own (issue #585 Phase 1, PR #621 moved chUrl/streamLines/createHttpTransport there) and combines its delete-after-cutover bucket into currentGenericLocEligibleForDeletion alongside ch-client.ts\'s own', async () => {
    const d = await computeDeletionEstimate();
    // The transport file gets its OWN manifest entry, distinct from
    // ch-client.ts's — per-file transparency is preserved even though the
    // two are summed for the headline figure.
    // `computeDeletionEstimate`'s return value comes from the untyped .mjs
    // orchestrator (same interop limitation `classifyFunctionRangesFromSource`
    // is cast for above) — the manifest's per-file bucket objects need the
    // same explicit local type for indexing.
    const httpTransportBuckets = d.manifest['clickhouse-http-transport.ts'] as Record<string, number>;
    const chClientBuckets = d.manifest['ch-client.ts'] as Record<string, number>;
    expect(httpTransportBuckets).toBeDefined();
    expect(Object.keys(httpTransportBuckets)).toEqual(['delete-after-cutover']);
    expect(httpTransportBuckets['delete-after-cutover']).toBeGreaterThan(0);
    // currentGenericLocEligibleForDeletion is the SUM of both files' own
    // delete-after-cutover buckets, not either one alone.
    const expectedCombined = (chClientBuckets['delete-after-cutover'] || 0)
      + httpTransportBuckets['delete-after-cutover'];
    expect(d.currentGenericLocEligibleForDeletion).toBe(expectedCombined);
  });

  it('does not throw for the real ch-client.ts / clickhouse-http-transport.ts / official-adapter.ts files under the broadened boundary regex and the new symmetric drift guard — the real-file proof that CH_CLIENT_CLASSIFICATION and HTTP_TRANSPORT_CLASSIFICATION stay exhaustive in both directions', async () => {
    await expect(computeDeletionEstimate()).resolves.toBeDefined();
  });
});

describe('computeGates / deriveDecision (2026-08-07 decision-methodology amendment: net-deletion demoted to measured; supported-server matrix narrowed to current-generation rows)', () => {
  const passedScenario = { status: 'passed', executed: true };
  const buildScenarios = (extra: Record<string, unknown> = {}) => ({
    'ordinary-query': passedScenario, 'table-streaming': passedScenario, 'empty-result': passedScenario, 'url-parameters-arrays-and-large-integers': passedScenario,
    'progressive-first-row': passedScenario, 'kpi-progress': passedScenario,
    'exception-after-headers-inband': passedScenario, 'malformed-stream': passedScenario, 'truncated-stream': passedScenario,
    'bearer-auth-exact-header': passedScenario, 'jwt-as-basic-exact-composition': passedScenario, 'refresh-then-retry': passedScenario,
    'stale-before-request': passedScenario, 'stale-during-refresh': passedScenario, 'stale-response': passedScenario,
    'raw-invalid-utf8': passedScenario, 'raw-tagged-late-exception': passedScenario, 'raw-legacy-untagged-exception': passedScenario,
    'raw-tsv-exact': passedScenario, 'raw-csv-exact': passedScenario, 'raw-json-exact': passedScenario,
    ...extra,
  });
  const baseResults = (matrixRows: Record<string, { executed: boolean; status: string }>, deletionEstimate: { netExecutableDeletion: number } | null) => ({
    scenarios: buildScenarios(),
    matrixRows,
    browserMatrix: { 'proposed-oldest-oss/same-origin/chromium': { requested: true, executed: true, status: 'passed' } },
    candidate: { selfContained: true },
    bundleDelta: { deltaBytes: 1234 },
    deletionEstimate,
  });
  const allFourRows = (overrides: Record<string, { executed: boolean; status: string }>) => ({
    'proposed-oldest-oss': { executed: true, status: 'passed' },
    'proposed-oldest-altinity-stable': { executed: true, status: 'passed' },
    'current-stable-oss': { executed: true, status: 'passed' },
    'current-altinity-stable': { executed: true, status: 'passed' },
    ...overrides,
  });

  it('"supported-server matrix" passes when only the two proposed-oldest rows fail (the exact #627 shape) — the shared, non-candidate-specific failure no longer blocks this gate', () => {
    const results = baseResults(allFourRows({
      'proposed-oldest-oss': { executed: true, status: 'failed' },
      'proposed-oldest-altinity-stable': { executed: true, status: 'failed' },
    }), { netExecutableDeletion: -154 });
    const gates = computeGates(results);
    expect(gates['supported-server matrix']).toBe('pass');
  });

  it('"supported-server matrix" still fails when a CURRENT-GENERATION row fails — a genuine candidate-specific regression is not waved through', () => {
    const results = baseResults(allFourRows({
      'current-stable-oss': { executed: true, status: 'failed' },
    }), { netExecutableDeletion: -154 });
    const gates = computeGates(results);
    expect(gates['supported-server matrix']).toBe('fail');
  });

  it('"net production-code deletion" is "measured", never "fail", regardless of a negative LOC figure', () => {
    const results = baseResults(allFourRows({}), { netExecutableDeletion: -154 });
    const gates = computeGates(results);
    expect(gates['net production-code deletion']).toBe('measured');
  });

  it('"net production-code deletion" is "inconclusive" (not "measured") when no deletion estimate was computed at all', () => {
    const results = baseResults(allFourRows({}), null);
    const gates = computeGates(results);
    expect(gates['net production-code deletion']).toBe('inconclusive');
  });

  it('deriveDecision computes Accepted from the exact ADR-0005 shape: both proposed-oldest rows fail, net deletion is -154, every other gate passes', () => {
    const results = baseResults(allFourRows({
      'proposed-oldest-oss': { executed: true, status: 'failed' },
      'proposed-oldest-altinity-stable': { executed: true, status: 'failed' },
    }), { netExecutableDeletion: -154 });
    const decision = deriveDecision(computeGates(results));
    expect(decision.status).toBe('Accepted');
  });

  it('deriveDecision still computes Rejected when a current-generation row genuinely regresses, even with the amendment in place', () => {
    const results = baseResults(allFourRows({
      'current-altinity-stable': { executed: true, status: 'failed' },
    }), { netExecutableDeletion: -154 });
    const decision = deriveDecision(computeGates(results));
    expect(decision.status).toBe('Rejected');
  });
});
