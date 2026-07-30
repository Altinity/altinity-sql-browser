// Tests for the #577 UI-complexity measurement instrument.
//
// Two jobs. The ordinary one is covering the pure counting rules in
// `build/ui-complexity-lib.mjs`. The important one is the SABOTAGE suite: the
// instrument's whole claim to being decision-grade is that it counts code and
// not this repository's very heavy comment convention, so there are tests here
// that FAIL if comment-stripping regresses. That mirrors the convention in
// `tests/unit/typography-contract.test.js` — a gate is only evidence if it can
// be shown to fail.
//
// `build/` sits outside the coverage `include` glob (`src/**/*.{js,ts}`), so
// these tests are not driven by the per-file floor; they exist because a
// measurement instrument nobody tested is not reproducible, which is #577's
// acceptance criterion 5.

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as esbuild from 'esbuild';
import {
  COMPLEXITY_SCHEMA_VERSION,
  FILE_CLASSES,
  METRIC_TIERS,
  buildComplexityReport,
  computeComplexityDelta,
  countLifecycleSites,
  countNormalizedLines,
  diffComplexityReports,
  lookupLcov,
  parseLcov,
  renderComplexityMarkdown,
} from '../../build/ui-complexity-lib.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

/** Build a manifest-shaped entry with sane defaults so each test only states
 *  the fields it cares about. */
function entry(overrides = {}) {
  return {
    path: 'src/ui/x.ts',
    class: 'plumbing',
    sliceItem: '1',
    physicalLines: 10,
    sourceBlankLines: 2,
    normalizedLines: 5,
    minifiedBytes: 100,
    lifecycle: { domMutation: 0, listener: 0, effect: 0, disposal: 0, focus: 0 },
    lcov: { branchesFound: 4, branchesHit: 4, functionsFound: 2, functionsHit: 2 },
    ...overrides,
  };
}

describe('countNormalizedLines', () => {
  it('counts non-blank lines and ignores a trailing newline', () => {
    expect(countNormalizedLines('a\nb\n')).toEqual({ normalized: 2, blank: 1 });
  });

  it('does not count whitespace-only lines as code', () => {
    expect(countNormalizedLines('a\n   \n\t\nb')).toEqual({ normalized: 2, blank: 2 });
  });

  it('reports zero for empty input rather than throwing', () => {
    expect(countNormalizedLines('')).toEqual({ normalized: 0, blank: 1 });
  });
});

describe('countLifecycleSites', () => {
  it('counts OCCURRENCES, not matching lines', () => {
    // The first implementation of this measurement used `rg -c`, which counts
    // LINES — so this single line scored 1 instead of 3 and every per-file
    // number in the report was an undercount.
    const code = 'el.hidden = true; other.hidden = false; third.hidden = true;';
    expect(countLifecycleSites(code).domMutation).toBe(3);
  });

  it('counts each DOM-mutation family the issue names', () => {
    const code = [
      'a.hidden = true;',
      'b.dataset.navMode = "wide";',
      'c.textContent = "x";',
      'd.replaceChildren(e);',
      'f.setAttribute("aria-labelledby", g);',
      'h.removeAttribute("aria-labelledby");',
      'i.style.width = "1px";',
      'j.classList.add("k");',
    ].join('\n');
    expect(countLifecycleSites(code).domMutation).toBe(8);
  });

  it('separates listeners, effects, disposal and focus', () => {
    const code = [
      'el.addEventListener("keydown", f);',
      'el.removeEventListener("keydown", f);',
      'disposers.push(effect(() => { untracked(() => s.value); }));',
      'batch(() => {});',
      'const c = computed(() => 1);',
      'thing.dispose();',
      'button.focus();',
    ].join('\n');
    const sites = countLifecycleSites(code);
    expect(sites.listener).toBe(2);
    expect(sites.effect).toBe(4);
    expect(sites.focus).toBe(1);
    expect(sites.disposal).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// SABOTAGE SUITE — these are the tests that make the instrument defensible.
// ---------------------------------------------------------------------------
describe('comment stripping (sabotage cases)', () => {
  /** Exactly what the runner does: esbuild-transform, then count. */
  async function measure(source, loader = 'ts') {
    const stripped = await esbuild.transform(source, { loader });
    return {
      code: stripped.code,
      lines: countNormalizedLines(stripped.code).normalized,
      sites: countLifecycleSites(stripped.code),
    };
  }

  it('does not count comment-only lines as code', async () => {
    const source = [
      '// one',
      '// two',
      '/* three',
      '   four */',
      'const a = 1;',
    ].join('\n');
    expect((await measure(source)).lines).toBe(1);
  });

  it('does not count DOM mutations that appear only inside a comment', async () => {
    // This is the concrete bug the first pass at this measurement had: run over
    // RAW source, a regex matched the prose in this repo's rationale comments,
    // reporting 37 "mutation sites" in app-shell.ts where the stripped code has
    // a different, smaller number.
    const source = [
      '// Every `hidden`/text toggle below is set UNCONDITIONALLY, and',
      '// el.dataset.navMode is written here too, plus a.replaceChildren(b).',
      'const noop = 1;',
    ].join('\n');
    const { sites } = await measure(source);
    expect(sites.domMutation).toBe(0);
  });

  it('keeps a "//" that lives inside a string literal', async () => {
    const source = 'const url = "http://example.com//path";';
    const { code, lines } = await measure(source);
    expect(lines).toBe(1);
    expect(code).toContain('//path');
  });

  it('keeps an escaped "//" inside a regex literal', async () => {
    // A hand-rolled scanner tracking only quotes treats the `\/\/` here as the
    // start of a line comment and silently drops the rest of the line.
    const source = 'const re = /https:\\/\\/x/g;\nel.hidden = true;';
    const { lines, sites } = await measure(source);
    expect(lines).toBe(2);
    expect(sites.domMutation).toBe(1);
  });

  it('keeps a "*"-prefixed line inside a template literal', async () => {
    // A scanner that skips lines whose trimmed form starts with `*` (to handle
    // jsdoc continuation) eats real code here.
    const source = 'const t = `\n * not a comment\n`;\nel.focus();';
    const { code, sites } = await measure(source);
    expect(code).toContain('not a comment');
    expect(sites.focus).toBe(1);
  });

  it('strips a trailing comment without dropping the code before it', async () => {
    const source = 'el.hidden = true; // rationale here mentions .dataset.x';
    const { lines, sites } = await measure(source);
    expect(lines).toBe(1);
    expect(sites.domMutation).toBe(1);
  });

  it('normalizes formatting, so collapsing lines cannot win', async () => {
    // Without normalization an arm could halve its "LOC" purely by reformatting.
    const spread = 'function f(\n  a,\n  b\n) {\n  return a + b;\n}';
    const dense = 'function f(a, b) { return a + b; }';
    expect((await measure(spread)).lines).toBe((await measure(dense)).lines);
  });

  it('counting raw source really would inflate the numbers (the bug is reachable)', async () => {
    // Guards against this suite becoming vacuous. Every test above asserts that
    // STRIPPED code counts correctly — but esbuild's stripping cannot regress,
    // so on its own that proves nothing about our choice to strip. This one
    // pins the actual delta: the same input scores higher un-stripped, so the
    // strip step is load-bearing rather than decorative.
    const source = [
      '// sets el.hidden = true and writes el.dataset.navMode',
      'const noop = 1;',
    ].join('\n');
    const raw = countLifecycleSites(source).domMutation;
    const stripped = countLifecycleSites((await esbuild.transform(source, { loader: 'ts' })).code).domMutation;
    expect(raw).toBeGreaterThan(0);
    expect(stripped).toBe(0);
  });

  it('the runner counts stripped code, not raw source', async () => {
    // A structural guard on the one decision that makes every number in the
    // report trustworthy. The lib is pure by design (no fs, no esbuild), so the
    // strip-then-count wiring lives in the runner and is otherwise unguarded:
    // swapping `stripped.code` for `source` there would leave all 30+ tests
    // above green while silently restoring the comment-inflated counts.
    const runner = await readFile(resolve(repoRoot, 'build/ui-complexity-report.mjs'), 'utf8');
    expect(runner).toMatch(/countLifecycleSites\(\s*stripped\.code\s*\)/);
    expect(runner).toMatch(/countNormalizedLines\(\s*stripped\.code\s*\)/);
    expect(runner).not.toMatch(/countLifecycleSites\(\s*source\s*\)/);
  });
});

describe('parseLcov / lookupLcov', () => {
  const lcov = [
    'SF:/abs/repo/src/ui/app-shell.ts',
    'FNF:39',
    'FNH:38',
    'BRF:90',
    'BRH:85',
    'end_of_record',
    'SF:/abs/repo/src/ui/left-rail.ts',
    'FNF:6',
    'FNH:6',
    'BRF:2',
    'BRH:2',
    'end_of_record',
  ].join('\n');

  it('parses the found/hit totals per file', () => {
    const parsed = parseLcov(lcov);
    expect(parsed['/abs/repo/src/ui/app-shell.ts']).toEqual({
      branchesFound: 90, branchesHit: 85, functionsFound: 39, functionsHit: 38,
    });
  });

  it('resolves a repo-relative manifest path against an absolute lcov key', () => {
    // lcov writes absolute paths here while the manifest is repo-relative; a
    // plain lookup misses every file and would report zero branches everywhere.
    const parsed = parseLcov(lcov);
    expect(lookupLcov(parsed, 'src/ui/left-rail.ts').functionsFound).toBe(6);
  });

  it('returns null — never a zero record — for a file with no lcov data', () => {
    // "No coverage data" and "no branches" are different claims, and conflating
    // them would let a missing measurement read as a perfect one.
    expect(lookupLcov(parseLcov(lcov), 'src/ui/absent.ts')).toBeNull();
  });

  it('does not match a path that merely shares a filename suffix', () => {
    const parsed = parseLcov('SF:/abs/repo/src/ui/rail.ts\nBRF:1\nend_of_record');
    expect(lookupLcov(parsed, 'src/ui/left-rail.ts')).toBeNull();
  });
});

describe('buildComplexityReport', () => {
  it('rejects an unknown file class instead of silently bucketing it', () => {
    // The manifest is acceptance criterion 4's auditable artifact, so a typo in
    // a class name has to be loud.
    expect(() => buildComplexityReport({ entries: [entry({ class: 'plumbling' })] }))
      .toThrow(/unknown class "plumbling"/);
  });

  it('totals separately per class so domain is never credited to plumbing', () => {
    const report = buildComplexityReport({
      entries: [
        entry({ path: 'a.ts', class: 'plumbing', normalizedLines: 10 }),
        entry({ path: 'b.ts', class: 'domain', normalizedLines: 20 }),
        entry({ path: 'c.ts', class: 'island', normalizedLines: 30 }),
      ],
    });
    expect(report.byClass.plumbing.normalizedLines).toBe(10);
    expect(report.byClass.domain.normalizedLines).toBe(20);
    expect(report.byClass.island.normalizedLines).toBe(30);
    expect(report.overall.normalizedLines).toBe(60);
  });

  it('exposes the deciding metric under its own name', () => {
    const report = buildComplexityReport({
      entries: [entry({ class: 'plumbing', normalizedLines: 7 })],
    });
    expect(report.ownedProductionCode.plumbingNormalizedLines).toBe(7);
  });

  it('derives non-code lines as physical minus blank minus code', () => {
    const report = buildComplexityReport({
      entries: [entry({ physicalLines: 100, sourceBlankLines: 10, normalizedLines: 30 })],
    });
    expect(report.overall.nonCodeLines).toBe(60);
  });

  it('records an absent file without counting it as zero-sized code', () => {
    // The comparability rule: one canonical manifest across every state, so a
    // file that disappears is reported as absent rather than silently dropped —
    // for the treatment state, that absence IS the headline result.
    const report = buildComplexityReport({
      entries: [
        entry({ path: 'kept.ts', normalizedLines: 40 }),
        { path: 'deleted.ts', class: 'plumbing', absent: true },
      ],
    });
    expect(report.overall.absentFiles).toBe(1);
    expect(report.overall.files).toBe(1);
    expect(report.overall.normalizedLines).toBe(40);
  });

  it('marks an absent file in the rendered report instead of omitting the row', () => {
    const md = renderComplexityMarkdown(buildComplexityReport({
      entries: [{ path: 'deleted.ts', class: 'plumbing', absent: true }],
    }));
    expect(md).toContain('deleted.ts');
    expect(md).toContain('_absent_');
    expect(md).toMatch(/a deletion must show up, not vanish/);
  });

  it('still validates the class of an absent file', () => {
    expect(() => buildComplexityReport({ entries: [{ path: 'x.ts', class: 'bogus', absent: true }] }))
      .toThrow(/unknown class/);
  });

  it('counts files with no lcov record as unmatched', () => {
    const report = buildComplexityReport({ entries: [entry({ lcov: null })] });
    expect(report.overall.lcovUnmatchedFiles).toBe(1);
    expect(report.overall.lcovBranchesFound).toBe(0);
  });

  it('emits the metric tiering, so a demoted metric cannot be quietly promoted', () => {
    const report = buildComplexityReport({ entries: [entry()] });
    expect(report.metricTiers).toBe(METRIC_TIERS);
    expect(report.metricTiers.explanatory.lcovBranches.demotedBecause).toMatch(/externalized/);
    expect(Object.keys(report.metricTiers.deciding)).toContain('changeAmplification');
  });

  it('sorts files deterministically so two reports diff cleanly', () => {
    const report = buildComplexityReport({
      entries: [entry({ path: 'z.ts' }), entry({ path: 'a.ts' })],
    });
    expect(report.files.map((f) => f.path)).toEqual(['a.ts', 'z.ts']);
  });

  it('stamps the schema version', () => {
    expect(buildComplexityReport({ entries: [entry()] }).schemaVersion).toBe(COMPLEXITY_SCHEMA_VERSION);
  });
});

describe('deltas', () => {
  it('computes absolute and percentage change', () => {
    expect(computeComplexityDelta(120, 100)).toEqual({ current: 120, base: 100, abs: 20, pct: 20 });
  });

  it('reports a null percentage against a zero base rather than Infinity', () => {
    // Printing `Infinity%` in a decision document is worse than printing nothing.
    expect(computeComplexityDelta(5, 0).pct).toBeNull();
  });

  it('diffs per class and overall', () => {
    const mk = (n) => buildComplexityReport({ entries: [entry({ normalizedLines: n })] });
    const deltas = diffComplexityReports(mk(80), mk(100));
    expect(deltas.byClass.plumbing.normalizedLines.abs).toBe(-20);
    expect(deltas.overall.normalizedLines.abs).toBe(-20);
  });
});

describe('renderComplexityMarkdown', () => {
  it('states the demotion reason for every explanatory metric', () => {
    const md = renderComplexityMarkdown(buildComplexityReport({ entries: [entry()] }));
    for (const metric of Object.keys(METRIC_TIERS.explanatory)) {
      expect(md).toContain(`\`${metric}\``);
    }
    expect(md).toMatch(/must not be voted with/);
  });

  it('flags unmatched lcov files instead of printing a zero', () => {
    const md = renderComplexityMarkdown(buildComplexityReport({ entries: [entry({ lcov: null })] }));
    expect(md).toContain('_unmatched_');
    expect(md).toMatch(/never as zero branches/);
  });

  it('renders a delta section only when a base is supplied', () => {
    const report = buildComplexityReport({ entries: [entry()] });
    expect(renderComplexityMarkdown(report)).not.toContain('Delta vs base');
    expect(renderComplexityMarkdown(report, diffComplexityReports(report, report)))
      .toContain('Delta vs base');
  });

  it('renders the captured environment when present', () => {
    const report = buildComplexityReport({ entries: [entry()], environment: { commit: 'abc123' } });
    expect(renderComplexityMarkdown(report)).toContain('abc123');
  });
});

describe('the committed manifest', () => {
  /** The measured file set, pinned.
   *
   *  Deliberately a PINNED LIST rather than a filesystem-existence check. The
   *  same manifest is measured against every evaluation state, and a file is
   *  legitimately absent in some of them — the inspector does not exist in S0,
   *  and the vanilla shell does not exist in S2, which is the single most
   *  decision-relevant fact the whole report carries. An existence assertion
   *  would therefore fail on the states it matters most on.
   *
   *  A pin still catches what actually needs catching: a rename or an accidental
   *  drop silently shrinks the measured baseline, and that is exactly the kind of
   *  undetectable bias this instrument exists to prevent. Changing the set now
   *  requires consciously changing this list. */
  const PINNED_PATHS = [
    'src/application/left-nav.ts',
    'src/core/left-nav-layout.ts',
    'src/ui/app-shell.ts',
    'src/ui/drawer.ts',
    'src/ui/left-nav-separator.ts',
    'src/ui/left-rail.ts',
    'src/ui/nav-sections.ts',
    'src/ui/right-inspector.ts',
    'src/ui/shell/adopt.ts',
    'src/ui/shell/focus-settlement.ts',
    'src/ui/shell/right-inspector-view.ts',
    'src/ui/shell/shell-context.types.ts',
    'src/ui/shell/shell-host.ts',
    'src/ui/shell/shell-layout.ts',
    'src/ui/shell/shell-view.ts',
    'src/ui/sidebar-upper.ts',
    'src/ui/splitters.ts',
    'src/ui/workbench/workbench-shell.ts',
  ];

  async function loadManifest() {
    return JSON.parse(await readFile(resolve(repoRoot, 'build/ui-complexity-manifest.json'), 'utf8'));
  }

  it('measures exactly the pinned file set', async () => {
    const manifest = await loadManifest();
    expect([...manifest.files.map((f) => f.path)].sort()).toEqual([...PINNED_PATHS].sort());
  });

  it('declares a known class for every file, and no duplicate paths', async () => {
    const manifest = await loadManifest();
    const seen = new Set();
    for (const file of manifest.files) {
      expect(FILE_CLASSES, `${file.path} class`).toContain(file.class);
      expect(seen.has(file.path), `${file.path} duplicated`).toBe(false);
      seen.add(file.path);
    }
  });

  it('classifies the three calls a first pass got wrong', async () => {
    // These were mislabelled as replaceable plumbing in an early draft, which
    // overstated the baseline the Preact arm had to beat by ~1000 physical lines.
    const byPath = Object.fromEntries((await loadManifest()).files.map((f) => [f.path, f.class]));
    expect(byPath['src/ui/left-nav-separator.ts']).toBe('island');
    expect(byPath['src/ui/nav-sections.ts']).toBe('domain');
    expect(byPath['src/ui/sidebar-upper.ts']).toBe('domain');
  });

  it('covers every numbered item of #577\'s evaluation scope that has code today', async () => {
    // Items 1-3, 5 and 6 exist on main. Item 4 (the right inspector) is what the
    // control adds, and item 7 (CodeMirror) sits behind the EditorPort seam and
    // is measured as an island via its adapter, not as shell plumbing.
    const manifest = JSON.parse(await readFile(resolve(repoRoot, 'build/ui-complexity-manifest.json'), 'utf8'));
    const covered = manifest.files.map((f) => f.sliceItem || '').join(' ');
    for (const item of ['1', '2', '3', '5', '6']) {
      expect(covered, `slice item ${item}`).toContain(item);
    }
  });
});
