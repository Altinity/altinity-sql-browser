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
import { selectEarliestPassingVersion, collectBrowserFailureDetail as collectBrowserFailureDetailUntyped } from './run-matrix.mjs';

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
