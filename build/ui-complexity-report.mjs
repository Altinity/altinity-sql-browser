// UI-complexity report runner (issue #577).
//
// Measures the file set in `build/ui-complexity-manifest.json` and emits a
// machine-readable JSON report plus a human-readable Markdown one, with
// optional deltas against a prior report. The pure counting rules live in
// `ui-complexity-lib.mjs` (unit-tested, including sabotage cases); this file
// owns only filesystem access, the esbuild call, and environment capture.
//
// Usage: node build/ui-complexity-report.mjs [--out <dir>] [--base <report.json>]
//                                            [--label <name>] [--manifest <path>]
//   --out       output directory (default: complexity-report/)
//   --base      a prior ui-complexity-report.json to diff against
//   --label     a name for this measurement (e.g. baseline / control / treatment)
//   --manifest  manifest to measure (default: build/ui-complexity-manifest.json)
//
// `--manifest` exists so ONE canonical manifest can be run against several
// checked-out states. Every evaluation state must be measured over an IDENTICAL
// file set or the totals are not comparable — and the two most decision-relevant
// facts are precisely a file appearing (S1 adds the inspector) and a file
// disappearing (S2 deletes the vanilla shell). A manifest entry whose file is
// absent from the current checkout is reported as `absent`, never skipped, so a
// deletion shows up in the comparison instead of vanishing from it.
//
// Reporting only — it reads source and never writes into src/.
//
// WHY esbuild AND NOT A REGEX: see ui-complexity-lib.mjs's header. Short
// version: every count runs over comment-stripped, re-printed source, because
// counting raw text both credits this repo's very high comment density as
// complexity and matches the prose inside those comments.
//
// Environment capture is deliberately part of the report rather than a footnote:
// #577's acceptance criterion 5 requires REPRODUCIBLE measurements, and a git
// tag preserves source, not a build environment. The captured commit SHA is the
// resolved one, never a tag name (tags can be moved).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';
import {
  buildComplexityReport,
  countLifecycleSites,
  countNormalizedLines,
  diffComplexityReports,
  lookupLcov,
  parseLcov,
  renderComplexityMarkdown,
} from './ui-complexity-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function parseArgs(argv) {
  const args = {
    out: 'complexity-report', base: null, label: null,
    manifest: 'build/ui-complexity-manifest.json',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[i + 1], i += 1;
    else if (argv[i] === '--base') args.base = argv[i + 1], i += 1;
    else if (argv[i] === '--label') args.label = argv[i + 1], i += 1;
    else if (argv[i] === '--manifest') args.manifest = argv[i + 1], i += 1;
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Best-effort `git`/tool version capture. A missing value is recorded as
 *  'unavailable' rather than omitted, so a report can never look like it
 *  captured an environment it did not. */
function capture(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

async function captureEnvironment() {
  let lockHash = 'unavailable';
  try {
    const lock = await readFile(resolve(root, 'package-lock.json'));
    lockHash = 'sha256:' + createHash('sha256').update(lock).digest('hex').slice(0, 16);
  } catch { /* recorded as unavailable */ }
  return {
    // Resolved SHA, never a tag name — an annotated tag can be moved unless
    // repository policy prevents it, so the SHA is what actually pins a state.
    commit: capture('git', ['rev-parse', 'HEAD']),
    commitDirty: capture('git', ['status', '--porcelain']) === '' ? 'clean' : 'DIRTY',
    node: process.version,
    esbuild: esbuild.version,
    platform: `${process.platform}-${process.arch}`,
    packageLock: lockHash,
  };
}

async function measureFile(entry, lcovByFile) {
  const abs = resolve(root, entry.path);
  let source;
  try {
    source = await readFile(abs, 'utf8');
  } catch {
    // Absent in THIS state. Recorded, not skipped — see the `--manifest` note in
    // the header: for the treatment state, the absence of the vanilla shell IS
    // the headline measurement.
    return { path: entry.path, class: entry.class, sliceItem: entry.sliceItem || null, absent: true };
  }
  const sourceLines = source.split('\n');
  // A trailing newline yields a final empty element that is not a line.
  const physicalLines = sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === ''
    ? sourceLines.length - 1
    : sourceLines.length;
  let sourceBlankLines = 0;
  for (let i = 0; i < physicalLines; i += 1) {
    if (sourceLines[i].trim() === '') sourceBlankLines += 1;
  }

  const loader = entry.path.endsWith('.ts') ? 'ts' : 'js';
  const stripped = await esbuild.transform(source, { loader });
  const minified = await esbuild.transform(source, { loader, minify: true });
  const { normalized } = countNormalizedLines(stripped.code);

  return {
    path: entry.path,
    class: entry.class,
    sliceItem: entry.sliceItem || null,
    physicalLines,
    sourceBlankLines,
    normalizedLines: normalized,
    minifiedBytes: Buffer.byteLength(minified.code, 'utf8'),
    // Counted over STRIPPED code, so a comment discussing `.hidden =` no longer
    // inflates the number the way a raw-source regex did.
    lifecycle: countLifecycleSites(stripped.code),
    lcov: lookupLcov(lcovByFile, entry.path),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readJson(resolve(process.cwd(), args.manifest));

  let lcovByFile = {};
  try {
    lcovByFile = parseLcov(await readFile(resolve(root, 'coverage/lcov.info'), 'utf8'));
  } catch {
    // No coverage run yet. Every file then reports lcov as unmatched, which the
    // report prints as `_unmatched_` — never as zero branches, since "no data"
    // and "no branches" are different claims.
  }

  const entries = [];
  for (const entry of manifest.files) entries.push(await measureFile(entry, lcovByFile));

  const report = buildComplexityReport({
    label: args.label,
    entries,
    environment: await captureEnvironment(),
  });

  const base = args.base ? await readJson(resolve(process.cwd(), args.base)) : null;
  const deltas = base ? diffComplexityReports(report, base) : null;

  const outDir = resolve(process.cwd(), args.out);
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'ui-complexity-report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(outDir, 'ui-complexity-report.md'), renderComplexityMarkdown(report, deltas));

  const o = report.overall;
  console.log(`ui-complexity report -> ${args.out}/`);
  console.log(`  ${o.files} files: ${o.normalizedLines} code lines (${o.physicalLines} physical, ${o.nonCodeLines} non-code)`);
  console.log(`  plumbing ${report.byClass.plumbing.normalizedLines} | domain ${report.byClass.domain.normalizedLines} | island ${report.byClass.island.normalizedLines}`);
  if (o.absentFiles > 0) console.log(`  ${o.absentFiles} manifest file(s) absent in this state`);
  if (deltas) {
    const n = deltas.overall.normalizedLines;
    console.log(`  Δ code lines vs base: ${n.abs > 0 ? '+' : ''}${n.abs}`);
  } else {
    console.log('  (no base report — deltas omitted)');
  }
  if (report.environment.commitDirty === 'DIRTY') {
    console.log('  WARNING: working tree is dirty — this measurement is not reproducible from the recorded commit.');
  }
}

await main();
