// UI-complexity report — pure half (issue #577).
//
// The measurement instrument the Preact evaluation (#577) decides on. Split
// lib/runner exactly like size-report-lib.mjs / size-report.mjs so every
// counting rule below is unit-testable without touching the filesystem or
// esbuild.
//
// WHY THIS EXISTS, and why it is not a LOC counter:
//
// #577's decision principle asks whether a completed migration would REDUCE,
// not merely reorganize, production UI code and lifecycle complexity. Two
// naive instruments both lie about this repository:
//
//   1. Physical LOC. The five shell-plumbing modules total 1791 physical lines
//      but only ~709 lines of code — 989 are comment-only, because this repo
//      documents each invariant next to the review bug that found it. Any arm
//      written at normal comment density "wins" on physical LOC while
//      containing more code.
//   2. Regex counts of manual DOM mutation (`.hidden =`, `.dataset.`,
//      `.replaceChildren(`). Three of those four families become
//      SYNTACTICALLY INVISIBLE under a vDOM whether or not the underlying
//      number of presentation decisions changed — a component arm scores ~0 by
//      construction. Worse, run over raw source they also match the prose IN
//      the comments, which is how a first pass at this measured 37
//      "mutation sites" in app-shell.ts.
//
// So: every count here runs over ESBUILD-TRANSFORMED source, never raw text.
// esbuild is the repo's only build tool, it strips comments correctly where a
// hand-rolled scanner does not (`//` inside a string, `\/\/` inside a regex
// literal, a `*`-prefixed line inside a template literal, a trailing
// `code; // note`), and it re-prints the code — which normalizes formatting, so
// an arm cannot win by collapsing statements onto fewer lines. See
// `tests/unit/ui-complexity-report.test.js` for the sabotage cases that hold
// this claim.
//
// METRIC TIERING IS PART OF THE OUTPUT (`METRIC_TIERS` below). Two independent
// plan reviews of #577 found that a report carrying ten unranked numbers lets
// almost any outcome support either recommendation. The tier each metric sits
// in is therefore emitted in the JSON, so a demoted metric cannot be quietly
// promoted to a deciding one when the report is written.

export const COMPLEXITY_SCHEMA_VERSION = 1;

/**
 * Which metrics may decide #577, and which may only explain it.
 *
 * `deciding` mirrors the four evidence classes in the approved plan. Three of
 * them are NOT computable from source text and are therefore recorded here as
 * declared-but-external: behavioural parity comes from the e2e suite, the
 * artifact numbers come from `build/size-report.mjs`, and change amplification
 * comes from the frozen controlled-change experiment. This instrument owns only
 * `ownedProductionCode`.
 *
 * `explanatory` metrics are reported per file and per class but never voted
 * with. Each carries the reason it was demoted, so the report cannot silently
 * re-promote it:
 *  - `minifiedBytes` ignores cross-module tree shaking, shared helper
 *    generation, and complexity moved INTO a dependency;
 *  - `lcovBranches`/`lcovFunctions` fall when mechanisms move into Preact —
 *    that is externalized, not eliminated, complexity;
 *  - `lifecycleSites` is the vDOM-invisible family described above.
 */
export const METRIC_TIERS = {
  deciding: {
    ownedProductionCode: { owner: 'this instrument' },
    parity: { owner: 'tests/e2e/shell-parity.spec.js' },
    artifact: { owner: 'build/size-report.mjs' },
    changeAmplification: { owner: 'frozen controlled-change experiment' },
    cleanupObligations: { owner: 'leak invariant + manual obligation count' },
  },
  explanatory: {
    minifiedBytes: { demotedBecause: 'ignores tree shaking, shared helpers, and complexity moved into a dependency' },
    lcovBranches: { demotedBecause: 'falls when mechanisms move into Preact — externalized, not eliminated' },
    lcovFunctions: { demotedBecause: 'falls when mechanisms move into Preact — externalized, not eliminated' },
    lifecycleSites: { demotedBecause: 'hidden/dataset/replaceChildren go syntactically invisible under a vDOM' },
  },
};

/** The three classes a manifest entry may declare. `domain` is preserved by
 *  both arms, `island` stays imperative under any render model (hard rule 5 —
 *  signals coordinate, they do not own mousemove), and only `plumbing` is
 *  genuinely in play. Mislabelling here is a wrong decision, not a wrong
 *  number, which is why the manifest is committed and the report names every
 *  file in it. */
export const FILE_CLASSES = ['domain', 'plumbing', 'island'];

/**
 * Count the code-bearing lines of already-comment-stripped, re-printed source.
 *
 * Takes esbuild's `transform().code`, NOT raw source — the caller owns that
 * step so this stays pure. Blank lines are excluded; a trailing newline does
 * not count as a line.
 */
export function countNormalizedLines(transformedCode) {
  const lines = String(transformedCode).split('\n');
  let normalized = 0;
  let blank = 0;
  for (const line of lines) {
    if (line.trim() === '') blank += 1;
    else normalized += 1;
  }
  return { normalized, blank };
}

/**
 * Occurrence counts (not line hits) of the lifecycle families #577's
 * Measurements section names, over comment-stripped code.
 *
 * A first pass at this used `rg -c`, which counts matching LINES — so a line
 * touching three of these families scored 1, and a comment discussing one
 * scored 1 with no code at all. Both are fixed here: the caller passes stripped
 * code, and every family is counted with a global regex.
 */
export function countLifecycleSites(strippedCode) {
  const code = String(strippedCode);
  const count = (re) => (code.match(re) || []).length;
  return {
    domMutation: count(/\.(?:hidden|textContent|value)\s*=|\.dataset\.[A-Za-z]/g)
      + count(/\.(?:replaceChildren|append|setAttribute|removeAttribute)\(/g)
      + count(/\.style\.[A-Za-z]+\s*=|\.classList\.[A-Za-z]+\(/g),
    listener: count(/\.(?:add|remove)EventListener\(/g),
    effect: count(/\b(?:effect|computed|untracked|batch)\(/g),
    disposal: count(/\bdispose\w*\b/g),
    focus: count(/\.focus\(\)/g),
  };
}

/**
 * Parse the `BRF`/`BRH`/`FNF`/`FNH` totals out of an lcov report, keyed by the
 * `SF:` path exactly as lcov wrote it.
 *
 * Explanatory only (see `METRIC_TIERS`). Reported as "repo-owned executable
 * test surface" rather than as a complexity verdict: a framework migration can
 * cut these counts by moving mechanisms into Preact, which is a real reduction
 * in code the project owns but not automatically a reduction in total
 * lifecycle complexity.
 */
export function parseLcov(text) {
  const byFile = {};
  let current = null;
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      current = line.slice(3);
      byFile[current] = { branchesFound: 0, branchesHit: 0, functionsFound: 0, functionsHit: 0 };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('BRF:')) byFile[current].branchesFound = Number(line.slice(4)) || 0;
    else if (line.startsWith('BRH:')) byFile[current].branchesHit = Number(line.slice(4)) || 0;
    else if (line.startsWith('FNF:')) byFile[current].functionsFound = Number(line.slice(4)) || 0;
    else if (line.startsWith('FNH:')) byFile[current].functionsHit = Number(line.slice(4)) || 0;
    else if (line === 'end_of_record') current = null;
  }
  return byFile;
}

/**
 * Resolve a manifest path against lcov's own key set.
 *
 * lcov paths are absolute in this repo's coverage output while the manifest is
 * repo-relative, so a plain lookup misses every file and would silently report
 * zero branches everywhere — indistinguishable from "this file has no
 * branches". Matching on a path suffix keeps that failure loud instead: an
 * unmatched file is reported as `null`, never as 0.
 */
export function lookupLcov(lcovByFile, relPath) {
  if (Object.prototype.hasOwnProperty.call(lcovByFile, relPath)) return lcovByFile[relPath];
  const suffix = '/' + relPath;
  for (const key of Object.keys(lcovByFile)) {
    if (key.endsWith(suffix)) return lcovByFile[key];
  }
  return null;
}

/**
 * Assemble the report from per-file measurements the runner has already taken.
 *
 * `entries` items: `{ path, class, sliceItem, normalizedLines,
 * sourceBlankLines, physicalLines, minifiedBytes, lifecycle, lcov }`. Totals
 * are grouped by
 * class, because criterion 4 of #577 requires the report to distinguish
 * product-specific domain logic from framework-like rendering plumbing — an
 * undifferentiated grand total cannot do that.
 */
export function buildComplexityReport({ label, entries, environment = null }) {
  const files = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of files) {
    if (!FILE_CLASSES.includes(entry.class)) {
      throw new Error(`ui-complexity: file "${entry.path}" has unknown class "${entry.class}" (expected one of ${FILE_CLASSES.join(', ')})`);
    }
  }
  const emptyTotals = () => ({
    files: 0,
    // A manifest entry whose file does not exist in THIS state. Central to the
    // method: all three evaluation states are measured against ONE canonical
    // manifest, so the set is identical and the totals are comparable. S1 adds
    // `right-inspector.ts` (absent in S0) and S2 DELETES `app-shell.ts` (absent
    // there) — if each state used its own manifest, S1's cost and S2's deletion
    // would both vanish from the comparison instead of showing up in it.
    absentFiles: 0,
    physicalLines: 0,
    normalizedLines: 0,
    nonCodeLines: 0,
    minifiedBytes: 0,
    lifecycle: { domMutation: 0, listener: 0, effect: 0, disposal: 0, focus: 0 },
    lcovBranchesFound: 0,
    lcovFunctionsFound: 0,
    lcovUnmatchedFiles: 0,
  });
  const byClass = {};
  const overall = emptyTotals();
  for (const cls of FILE_CLASSES) byClass[cls] = emptyTotals();

  for (const entry of files) {
    for (const bucket of [byClass[entry.class], overall]) {
      if (entry.absent) {
        bucket.absentFiles += 1;
        continue;
      }
      bucket.files += 1;
      bucket.physicalLines += entry.physicalLines;
      bucket.normalizedLines += entry.normalizedLines;
      // NOT called "comment-only": esbuild RE-PRINTS the code, so its line
      // count is not the source's code-line count and
      // `physical - blank - normalized` is not a comment total. What it IS,
      // exactly: source non-blank lines carrying no code after normalization —
      // comments PLUS formatting-only lines (a lone `)`, a multi-line call
      // esbuild re-joins). That is still the number a raw-LOC comparison would
      // have wrongly credited as complexity, which is why it is reported; it is
      // just not a comment count, and naming it one would be a measurement
      // error in the metric this whole decision rests on.
      bucket.nonCodeLines += entry.physicalLines - entry.sourceBlankLines - entry.normalizedLines;
      bucket.minifiedBytes += entry.minifiedBytes;
      for (const key of Object.keys(bucket.lifecycle)) bucket.lifecycle[key] += entry.lifecycle[key];
      if (entry.lcov) {
        bucket.lcovBranchesFound += entry.lcov.branchesFound;
        bucket.lcovFunctionsFound += entry.lcov.functionsFound;
      } else {
        bucket.lcovUnmatchedFiles += 1;
      }
    }
  }

  return {
    schemaVersion: COMPLEXITY_SCHEMA_VERSION,
    label: label || null,
    metricTiers: METRIC_TIERS,
    environment,
    // The deciding metric this instrument owns. Named explicitly so the report
    // cannot substitute a different number for it.
    ownedProductionCode: {
      plumbingNormalizedLines: byClass.plumbing.normalizedLines,
      islandNormalizedLines: byClass.island.normalizedLines,
      domainNormalizedLines: byClass.domain.normalizedLines,
    },
    byClass,
    overall,
    files,
  };
}

/** Absolute + percentage delta between two reports, for the same metric set.
 *  `null` percentage when the base is 0 — a 0 → n change has no meaningful
 *  percentage and printing `Infinity%` in a decision document is worse than
 *  printing nothing. */
export function computeComplexityDelta(current, base) {
  const abs = current - base;
  return { current, base, abs, pct: base === 0 ? null : (abs / base) * 100 };
}

/** Diff two whole reports, per class and overall. */
export function diffComplexityReports(current, base) {
  const out = { byClass: {}, overall: {} };
  const metrics = ['physicalLines', 'normalizedLines', 'nonCodeLines', 'minifiedBytes'];
  for (const cls of FILE_CLASSES) {
    out.byClass[cls] = {};
    for (const metric of metrics) {
      out.byClass[cls][metric] = computeComplexityDelta(current.byClass[cls][metric], base.byClass[cls][metric]);
    }
  }
  for (const metric of metrics) {
    out.overall[metric] = computeComplexityDelta(current.overall[metric], base.overall[metric]);
  }
  return out;
}

function formatPct(pct) {
  if (pct === null) return 'n/a';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function formatSigned(n) {
  return (n > 0 ? '+' : '') + String(n);
}

/** Human-readable report. Deliberately leads with the tiering and with the
 *  physical-vs-normalized gap, because those two facts are what stop a reader
 *  from misreading the table underneath them. */
export function renderComplexityMarkdown(report, deltas = null) {
  const lines = [];
  lines.push(`# UI complexity report${report.label ? ` — ${report.label}` : ''}`);
  lines.push('');
  lines.push(`Schema version ${report.schemaVersion}. Counts run over esbuild-transformed`);
  lines.push('source (comments stripped, formatting normalized), never raw text.');
  lines.push('');
  lines.push('**Deciding metric owned here:** `ownedProductionCode` — normalized lines by class.');
  lines.push('Every other number below is explanatory and must not be voted with:');
  for (const [metric, meta] of Object.entries(report.metricTiers.explanatory)) {
    lines.push(`- \`${metric}\` — ${meta.demotedBecause}`);
  }
  lines.push('');
  lines.push('## Owned production code (deciding)');
  lines.push('');
  lines.push('| Class | Files | Normalized (code) | Physical | Non-code |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const cls of FILE_CLASSES) {
    const t = report.byClass[cls];
    if (t.files === 0) continue;
    lines.push(`| ${cls} | ${t.files} | **${t.normalizedLines}** | ${t.physicalLines} | ${t.nonCodeLines} |`);
  }
  const o = report.overall;
  lines.push(`| **total** | **${o.files}** | **${o.normalizedLines}** | **${o.physicalLines}** | **${o.nonCodeLines}** |`);
  lines.push('');
  lines.push(`Physical LOC overstates code by **${o.nonCodeLines}** non-code lines`);
  lines.push('(comments plus formatting-only lines). A raw-LOC comparison would have credited');
  lines.push('those as complexity — which is the specific error this instrument exists to prevent.');
  lines.push('');
  lines.push('## Explanatory metrics');
  lines.push('');
  lines.push('| File | Class | Code | Minified B | DOM | Listeners | Effects | Disposal | focus() | lcov BRF/FNF |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const f of report.files) {
    if (f.absent) {
      // Explicitly present as a row rather than omitted: "this state does not
      // have this file" is a measurement, and for S2 it is THE measurement.
      lines.push(`| \`${f.path}\` | ${f.class} | _absent_ | — | — | — | — | — | — | — |`);
      continue;
    }
    const lc = f.lcov ? `${f.lcov.branchesFound}/${f.lcov.functionsFound}` : '_unmatched_';
    lines.push(`| \`${f.path}\` | ${f.class} | ${f.normalizedLines} | ${f.minifiedBytes} | ${f.lifecycle.domMutation} | ${f.lifecycle.listener} | ${f.lifecycle.effect} | ${f.lifecycle.disposal} | ${f.lifecycle.focus} | ${lc} |`);
  }
  if (report.overall.absentFiles > 0) {
    lines.push('');
    lines.push(`> ${report.overall.absentFiles} manifest file(s) absent in this state — measured against the one canonical`);
    lines.push('> manifest so every state covers an identical file set (a deletion must show up, not vanish).');
  }
  if (o.lcovUnmatchedFiles > 0) {
    lines.push('');
    lines.push(`> ${o.lcovUnmatchedFiles} file(s) had no lcov record — reported as unmatched, never as zero branches.`);
  }
  if (deltas) {
    lines.push('');
    lines.push('## Delta vs base');
    lines.push('');
    lines.push('| Class | Normalized (code) | Δ | Minified B | Δ |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const cls of FILE_CLASSES) {
      const n = deltas.byClass[cls].normalizedLines;
      const m = deltas.byClass[cls].minifiedBytes;
      if (n.base === 0 && n.current === 0) continue;
      lines.push(`| ${cls} | ${n.current} | ${formatSigned(n.abs)} (${formatPct(n.pct)}) | ${m.current} | ${formatSigned(m.abs)} (${formatPct(m.pct)}) |`);
    }
    const n = deltas.overall.normalizedLines;
    lines.push(`| **total** | **${n.current}** | **${formatSigned(n.abs)} (${formatPct(n.pct)})** | ${deltas.overall.minifiedBytes.current} | ${formatSigned(deltas.overall.minifiedBytes.abs)} |`);
  }
  if (report.environment) {
    lines.push('');
    lines.push('## Environment');
    lines.push('');
    for (const [key, value] of Object.entries(report.environment)) {
      lines.push(`- **${key}**: \`${value}\``);
    }
  }
  lines.push('');
  return lines.join('\n');
}
