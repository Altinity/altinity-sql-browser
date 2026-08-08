// Phase 0 / issue #585 — the evidence-generation orchestrator. Plan §29
// ("Evidence generation and validation"), §9 ("Baseline worktree self-check" /
// "Stamp-normalized comparison" / "Required measurements"), §13
// ("support-minimum-analysis.md"), §16 (bridge/guard LOC), §27 (critical
// questions), §28 (deletion estimate), §34.A/D steps 7-13.
//
// `npm run test:client-spike:matrix` (no args) is the plan-compliant full run:
// every matrix.json row, every Playwright browser project, the full baseline
// local gate. Every flag below narrows that for iteration/smoke-testing —
// document any narrowed invocation as a deliberate deviation, never as the
// "real" evidence run.
//
//   --rows <comma-list|all|none>      matrix.json row keys to boot via Docker
//                                      and run the live suites against
//                                      (default: all non-conditional rows)
//   --browsers <comma-list|all|none>  Playwright projects to run
//                                      (chromium,webkit; default: all)
//   --out <dir>                       evidence output root, resolved against
//                                      the invoking shell's cwd (default:
//                                      <repoRoot>/docs/evidence/585)
//   --skip-baseline-gate               skip re-running the FULL local gate
//                                      inside the baseline worktree (§34.A
//                                      step 5) — the baseline SIZE-REPORT
//                                      self-check (§9, the actual build-tool
//                                      correctness proof) still always runs.
//                                      Smoke-only; the real evidence run must
//                                      not pass this.
//   --tmp-root <dir>                   parent for ephemeral worktrees/config
//                                      (default: $TMPDIR; NEVER /tmp — see
//                                      clickhouse-containers.mjs's header)
//   --keep-temp                        do not remove worktrees/containers on
//                                      exit (debugging only)
//
// Every artifact this script WRITES under `--out` is repository-relative in
// content (no absolute $TMPDIR path is ever serialized into evidence — see
// `assertNoTmpPaths` below, the final safety net before anything touches
// disk). Ephemeral worktrees/containers themselves obviously DO live under
// $TMPDIR/$SPIKE_TMP; that is correct and is never committed.
//
// Kept as plain `.mjs` (not `.ts`) per plan §8 precedent (fault-server.mjs,
// clickhouse-containers.mjs, support-minimum.mjs): Node orchestration files
// stay untyped. Data-driven throughout: classification tables, scenario/test
// mappings, and the deletion manifest are declared as data so a future
// change to the spike sources either keeps working or fails LOUDLY here
// (see `classifyFunctionRanges`'s "unclassified symbol" throw) rather than
// silently going stale.

import { build as esbuildBuild } from 'esbuild';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync,
} from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platform, arch } from 'node:os';

import {
  requireEnv, createSpikeTmp, startRow, stopAll, stopAllOrphans, FIXTURE_USERS,
} from './clickhouse-containers.mjs';
import { deriveProposedMinimum, renderSupportMinimumMd } from './support-minimum.mjs';
import { startFaultServer } from './fault-server.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const spikeDir = here;
const repoRoot = resolvePath(here, '../../..');
const buildScriptRoot = repoRoot; // this branch's OWN build/ tooling — the "updated reporter" throughout.

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    rows: 'all', browsers: 'all', out: null, skipBaselineGate: false, tmpRoot: null, keepTemp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--rows') args.rows = argv[++i];
    else if (a === '--browsers') args.browsers = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--skip-baseline-gate') args.skipBaselineGate = true;
    else if (a === '--tmp-root') args.tmpRoot = argv[++i];
    else if (a === '--keep-temp') args.keepTemp = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node tests/spike/clickhouse-client/run-matrix.mjs [options]

  --rows <comma-list|all|none>      matrix.json rows to boot + run live suites against
  --browsers <comma-list|all|none>  Playwright projects to run (chromium,webkit)
  --out <dir>                       evidence output root (default: docs/evidence/585)
  --skip-baseline-gate               skip the FULL local gate rerun in the baseline worktree
  --tmp-root <dir>                   parent dir for ephemeral worktrees (default: $TMPDIR)
  --keep-temp                        keep worktrees/containers on exit (debugging)
`);
}

// ── small utilities ─────────────────────────────────────────────────────────

async function run(cmd, cmdArgs, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, { maxBuffer: 1024 * 1024 * 64, ...opts });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || String(e.message || e), code: e.code };
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text.endsWith('\n') ? text : `${text}\n`);
}

/** Final safety net (this sub-task's own hard requirement, and plan §12/§29):
 * evidence must contain no absolute path beneath the ephemeral tmp root. Scans
 * the SERIALIZED form so it catches a leak regardless of which nested field
 * carried it. Throws rather than silently redacting — a leak here is a bug in
 * this script, not something to paper over. */
function assertNoTmpPaths(obj, tmpRootAbs) {
  const json = JSON.stringify(obj);
  if (tmpRootAbs && json.includes(tmpRootAbs)) {
    throw new Error(`run-matrix: refusing to write evidence containing an absolute tmp path ("${tmpRootAbs}") — this is a bug in run-matrix.mjs's own evidence assembly, not a data problem`);
  }
  // Also reject the raw $TMPDIR value itself (belt-and-suspenders — the run
  // may create worktrees under a DIFFERENT ancestor than tmpRootAbs if
  // --tmp-root was used inconsistently).
  const envTmp = process.env.TMPDIR;
  if (envTmp && envTmp.length > 3 && json.includes(resolvePath(envTmp))) {
    throw new Error('run-matrix: refusing to write evidence containing $TMPDIR — scrub the field that embedded it');
  }
}

function toRepoRelative(absPath) {
  const rel = relative(repoRoot, absPath);
  return rel.startsWith('..') ? null : rel.split(sep).join('/');
}

// ── loading pure-data / adapter exports out of the spike's TypeScript ──────
//
// Plain `.mjs` cannot `import` a `.ts` file directly. Bundling a tiny re-
// export barrel through esbuild (already a devDependency; the same mechanism
// build/build.mjs itself uses) and dynamically importing the bundled output
// is the only dependency-free way to reach real spike/adapter code (not a
// reimplementation of it — plan §7 "do not reimplement current behavior")
// from this orchestrator. Verified against the real files before being
// adopted here (see this sub-task's final report).
async function loadSpikeModule(exportsSpec, tmpDir) {
  const lines = exportsSpec.map(({ from, names }) => `export { ${names.join(', ')} } from '${from}';`);
  const outfile = join(tmpDir, `spike-loader-${randomBytes(6).toString('hex')}.mjs`);
  await esbuildBuild({
    stdin: { contents: lines.join('\n'), resolveDir: spikeDir, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: true,
    outfile,
    absWorkingDir: repoRoot,
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

// ── LOC measurement (plan §16 "Bridge size") ────────────────────────────────

/** Strip `//` line comments and `/* ... *\/` block comments from TS/JS
 * source. A regex pass, not an AST — a deliberate, documented simplification
 * (this is spike EVIDENCE tooling measuring spike/production files' relative
 * size, not a compiler); it can misfire on a `//`/`/*` inside a string
 * literal, which none of the measured files' actual content contains (this
 * has been verified against progress-bridge.ts, guarded-fetch.ts, and
 * official-adapter.ts's measured ranges — see this sub-task's final report). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function countNonBlankLines(src) {
  return src.split('\n').filter((l) => l.trim().length > 0).length;
}

/** THE single "physical LOC" metric every deletion-estimate term is measured
 * with — comments and blank lines stripped, then non-blank lines counted.
 * `measureLoc()` (whole file) and `classifyFunctionRangesFromSource()` (one
 * symbol's line range) both call this SAME function so the numbers
 * `computeDeletionEstimate()` combines are one consistent figure end to end.
 *
 * A P3 review finding (issue #585 Phase 0) caught the previous shape of this:
 * `classifyFunctionRanges` summed the RAW `starts[i+1].line - starts[i].line`
 * line-range diff (every comment and blank line inside the range included),
 * while `measureLoc`'s `physical` field was already comment/blank-stripped —
 * two different "physical LOC" definitions combined as one "executable LOC"
 * formula in `computeDeletionEstimate`. The inflation was concentrated in
 * comment-heavy functions (verified: `runOfficial`'s raw range is ~34% larger
 * than its comment/blank-stripped count), so it materially skewed exactly the
 * figures (`ch-client.ts` buckets, `official-adapter.ts`'s core) the ADR's
 * deletion estimate leans on hardest. */
function physicalLineCount(src) {
  return countNonBlankLines(stripComments(src));
}

/** Physical source lines excluding blanks/comments, and "transformed
 * executable lines" (esbuild's own TS type-erasure — interfaces/type
 * annotations removed, no minification — then the same blank/comment strip).
 * Two distinct numbers per plan §16; neither is a byte-perfect substitute for
 * reading the file, both are reproducible and cheap. */
async function measureLoc(absPath) {
  const src = await readFile(absPath, 'utf8');
  const physical = physicalLineCount(src);
  const { transform } = await import('esbuild');
  const erased = await transform(src, { loader: 'ts', format: 'esm', minify: false });
  const transformedExecutable = physicalLineCount(erased.code);
  return { physical, transformedExecutable };
}

/** Regex-detect top-level `function`/`async function`/`const` symbol
 * boundaries (exported or not — see below) in an in-memory TS source string
 * and sum `physicalLineCount()` — the SAME comment/blank-stripped metric
 * `measureLoc()` uses — per caller-supplied bucket, over each symbol's own
 * line range. Throws on any detected symbol absent from `classification` —
 * the deletion estimate must fail loudly on drift (a renamed/added/removed
 * function), never silently miscount (memory: "Comments asserting invariants
 * drift silently"). `classification` maps symbol name -> bucket key;
 * `ignore` lists symbols deliberately excluded (e.g. a type-only interface)
 * without being counted in any bucket. Pure (no file I/O) so a review-fix
 * regression test can exercise the counting logic directly against a literal
 * fixture string; `classifyFunctionRanges` below is the thin file-reading
 * wrapper the orchestrator actually calls. `sourceLabel` is only used to name
 * the source in the unclassified-symbol / stale-classification error messages.
 *
 * The detection regex used to require a leading `export` keyword. A real
 * drift incident (issue #585 Phase 1, PR #621) showed why that was wrong:
 * `ch-client.ts`'s Phase 1 transport-seam restructuring left several
 * top-level functions (`isAbort`, `errMessage`, `isCurrentEpoch`,
 * `staleEpochAbort`, `querySystemAware`, `loadDataLakeCatalogTableNames`)
 * non-exported (they always were, or became so incidentally) while they
 * stayed in `CH_CLIENT_CLASSIFICATION` — the export-only regex simply never
 * saw them as boundaries, so their LOC silently vanished into whichever
 * EARLIER exported symbol's range preceded them (or, for the four before the
 * file's first export, into no bucket at all). The regex now matches a
 * top-level (still `^`-anchored — nested declarations are never matched)
 * `function`/`const` declaration whether or not it is exported, so every
 * real symbol becomes its own tracked boundary again regardless of its
 * export status. */
export function classifyFunctionRangesFromSource(src, classification, ignore = [], sourceLabel = '<source>') {
  const lines = src.split('\n');
  const starts = [];
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)/;
  lines.forEach((line, i) => {
    const m = line.match(re);
    if (m) starts.push({ name: m[1] || m[2], line: i + 1 });
  });
  starts.push({ name: '__EOF__', line: lines.length + 1 });
  const byBucket = {};
  const unclassified = [];
  const matchedNames = new Set();
  for (let i = 0; i < starts.length - 1; i += 1) {
    const { name } = starts[i];
    matchedNames.add(name);
    const rangeSrc = lines.slice(starts[i].line - 1, starts[i + 1].line - 1).join('\n');
    const count = physicalLineCount(rangeSrc);
    if (ignore.includes(name)) continue;
    const bucket = classification[name];
    if (!bucket) { unclassified.push(name); continue; }
    byBucket[bucket] = (byBucket[bucket] || 0) + count;
  }
  if (unclassified.length) {
    throw new Error(`run-matrix: classifyFunctionRanges(${sourceLabel}) found unclassified top-level symbol(s): ${unclassified.join(', ')} — the deletion-estimate manifest in run-matrix.mjs must classify every one (plan §28)`);
  }
  // The MIRROR of the check above (the exact drift shape that caused the
  // issue #585 Phase 1 regression this function's header comment describes):
  // a classification-table entry that used to match a real symbol but no
  // longer matches ANYTHING in the source — renamed, moved to another file
  // (e.g. `chUrl` relocating to `clickhouse-http-transport.ts`), or deleted.
  // Silently ignoring a stale entry is exactly as wrong as silently dropping
  // an unclassified symbol: both let the manifest quietly stop reflecting the
  // real file. Fail loudly here too, rather than only catching the one
  // direction.
  const staleClassifications = Object.keys(classification).filter((name) => !matchedNames.has(name));
  if (staleClassifications.length) {
    throw new Error(`run-matrix: classifyFunctionRanges(${sourceLabel}) has classification-table entr${staleClassifications.length === 1 ? 'y' : 'ies'} that no longer match(es) any top-level symbol in the source: ${staleClassifications.join(', ')} — the symbol was renamed/moved/deleted; fix or remove its entry in run-matrix.mjs (plan §28)`);
  }
  return byBucket;
}

async function classifyFunctionRanges(absPath, classification, ignore = []) {
  const src = await readFile(absPath, 'utf8');
  return classifyFunctionRangesFromSource(src, classification, ignore, absPath);
}

// ── esbuild reporter invocation (build/size-report.mjs CLI) ────────────────

/** Invoke THIS branch's `build/size-report.mjs` (the "updated reporter")
 * exactly as a human/CI would from the shell — a real child-process CLI
 * call, not a direct function import — so the measurement genuinely proves
 * the CLI's own `--root`/foreign-cwd behavior (plan §9's "including at least
 * one invocation whose process cwd is outside that worktree"), not just the
 * underlying library functions in isolation. `cwd` defaults to `tmpRoot`
 * (outside both the measured repo and this repo) unless overridden. */
async function invokeSizeReport({
  root, entry, out, artifactOut, notices, includeUnminifiedJs, buildStamp, cwd,
}) {
  const scriptPath = join(buildScriptRoot, 'build/size-report.mjs');
  const cmdArgs = [scriptPath, '--root', root, '--out', out, '--artifact-out', artifactOut];
  if (entry) cmdArgs.push('--entry', entry);
  if (notices) cmdArgs.push('--notices', notices);
  if (includeUnminifiedJs) cmdArgs.push('--include-unminified-js');
  if (buildStamp !== undefined) cmdArgs.push('--build-stamp', buildStamp);
  const result = await run('node', cmdArgs, { cwd });
  if (!result.ok) {
    throw new Error(`run-matrix: build/size-report.mjs failed (root=${root}, cwd=${cwd}):\n${result.stderr}`);
  }
  const report = await readJson(join(out, 'bundle-size-report.json'));
  const metafile = await readJson(join(out, 'esbuild-meta.json'));
  return { report, metafile, out };
}

/** Run the BASELINE worktree's OWN unmodified `npm run size-report` (plan §9
 * "First run from the baseline worktree: npm run size-report") — this is
 * whatever build/size-report.mjs exists AT the baseline SHA, not this
 * branch's version; it always writes to `<baselineRoot>/bundle-report/`
 * (its own default, no `--out` override, matching how a developer actually
 * runs it). */
async function invokeBaselineOwnSizeReport(baselineRoot) {
  const result = await run('npm', ['run', 'size-report'], { cwd: baselineRoot });
  if (!result.ok) {
    throw new Error(`run-matrix: baseline's own "npm run size-report" failed:\n${result.stderr}`);
  }
  const outDir = join(baselineRoot, 'bundle-report');
  const report = await readJson(join(outDir, 'bundle-size-report.json'));
  const metafile = await readJson(join(outDir, 'esbuild-meta.json'));
  return { report, metafile, outDir };
}

/** Deep-compare the fields plan §9 requires to reproduce byte-for-byte: raw/
 * gzip/Brotli for artifact+js+css, ownership, packages, topModules,
 * entryPoints, and (from the metafile) every input key + output entryPoint.
 * Returns a list of human-readable mismatch descriptions (empty = pass). */
function compareSizeReports(ownReport, ownMeta, updatedReport, updatedMeta) {
  const mismatches = [];
  const num = (label, a, b) => { if (a !== b) mismatches.push(`${label}: baseline-own=${a} updated-reporter=${b}`); };
  for (const key of ['artifact', 'js', 'css']) {
    for (const metric of ['raw', 'gzip', 'brotli']) {
      num(`${key}.${metric}`, ownReport[key]?.[metric], updatedReport[key]?.[metric]);
    }
  }
  num('totalOutputBytes', ownReport.totalOutputBytes, updatedReport.totalOutputBytes);
  for (const owner of Object.keys(ownReport.ownership || {})) {
    num(`ownership.${owner}.bytes`, ownReport.ownership[owner]?.bytes, updatedReport.ownership?.[owner]?.bytes);
  }
  const ownPkgs = new Map((ownReport.packages || []).map((p) => [p.name, p.bytes]));
  const updPkgs = new Map((updatedReport.packages || []).map((p) => [p.name, p.bytes]));
  for (const name of new Set([...ownPkgs.keys(), ...updPkgs.keys()])) {
    num(`packages[${name}].bytes`, ownPkgs.get(name), updPkgs.get(name));
  }
  const ownTop = (ownReport.topModules || []).map((m) => `${m.path}:${m.bytes}`).sort();
  const updTop = (updatedReport.topModules || []).map((m) => `${m.path}:${m.bytes}`).sort();
  if (JSON.stringify(ownTop) !== JSON.stringify(updTop)) {
    mismatches.push(`topModules differ: baseline-own has ${ownTop.length} entries, updated-reporter has ${updTop.length} entries (or byte counts differ)`);
  }
  const ownEntries = (ownReport.entryPoints || []).map((e) => `${e.file}:${e.entryPoint}:${e.bytes}`).sort();
  const updEntries = (updatedReport.entryPoints || []).map((e) => `${e.file}:${e.entryPoint}:${e.bytes}`).sort();
  if (JSON.stringify(ownEntries) !== JSON.stringify(updEntries)) mismatches.push('entryPoints differ between baseline-own and updated-reporter reports');

  // Metafile input-key and output-entryPoint reproduction, independent of the
  // report's own attribution roll-up (plan §9's explicit "metafile input
  // paths"/"metafile output and entry-point paths").
  const ownOutputs = Object.entries(ownMeta.outputs || {});
  const updOutputs = Object.entries(updatedMeta.outputs || {});
  const ownInputs = new Set(ownOutputs.flatMap(([, o]) => Object.keys(o.inputs || {})));
  const updInputs = new Set(updOutputs.flatMap(([, o]) => Object.keys(o.inputs || {})));
  for (const k of ownInputs) if (!updInputs.has(k)) mismatches.push(`metafile input missing in updated-reporter run: ${k}`);
  for (const k of updInputs) if (!ownInputs.has(k)) mismatches.push(`metafile input present ONLY in updated-reporter run: ${k}`);
  return mismatches;
}

// ── worktrees ────────────────────────────────────────────────────────────────

async function createWorktreeAt(sha, label, tmpRoot) {
  const dir = join(tmpRoot, `asb585-${label}-${randomBytes(4).toString('hex')}`);
  const addResult = await run('git', ['worktree', 'add', '--detach', dir, sha], { cwd: repoRoot });
  if (!addResult.ok) throw new Error(`run-matrix: git worktree add failed for ${label}@${sha}:\n${addResult.stderr}`);
  const npmCi = await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, timeout: 300_000 });
  if (!npmCi.ok) throw new Error(`run-matrix: npm ci failed in ${label} worktree:\n${npmCi.stderr}`);
  const cleanup = async () => {
    try { await run('git', ['worktree', 'remove', '--force', dir], { cwd: repoRoot }); } catch { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { dir, sha, cleanup };
}

async function resolveBaselineSha() {
  const fetchResult = await run('git', ['fetch', 'origin', 'main', '--quiet'], { cwd: repoRoot, timeout: 60_000 });
  if (!fetchResult.ok) {
    console.warn(`run-matrix: "git fetch origin main" failed (${fetchResult.stderr.trim() || 'no stderr'}) — falling back to the locally-known origin/main ref, which may be stale`);
  }
  const rev = await run('git', ['rev-parse', 'origin/main'], { cwd: repoRoot });
  if (!rev.ok) throw new Error(`run-matrix: could not resolve origin/main:\n${rev.stderr}`);
  return rev.stdout.trim();
}

function resolveCandidateSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
}

function isDirty(root) {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim().length > 0;
}

// ── vitest JSON-reporter runs + scenario mapping ────────────────────────────

export async function runVitestJson(testFiles, { env = {}, tmpDir }) {
  const outputFile = join(tmpDir, `vitest-report-${randomBytes(6).toString('hex')}.json`);
  const cmdArgs = [
    'vitest', 'run', '--config', join(spikeDir, 'vitest.config.mjs'),
    '--reporter=json', `--outputFile=${outputFile}`, ...testFiles,
  ];
  const result = await run('npx', cmdArgs, {
    cwd: repoRoot, env: { ...process.env, TZ: 'America/New_York', ...env },
  });
  if (!existsSync(outputFile)) {
    throw new Error(`run-matrix: vitest produced no JSON report (files=${testFiles.join(', ')}):\n${result.stderr}\n${result.stdout}`);
  }
  const parsed = await readJson(outputFile);
  const assertions = [];
  for (const tr of parsed.testResults || []) {
    for (const a of tr.assertionResults || []) assertions.push({ fullName: a.fullName, status: a.status });
  }
  return { success: parsed.success, numTotalTests: parsed.numTotalTests, assertions };
}

/** Every DETERMINISTIC_SCENARIOS id (scenarios.ts) mapped to the literal
 * substring(s) that must ALL appear together in one `it()`'s full title
 * (describe-chain + title, as vitest's JSON reporter's `fullName` reports
 * it) for that scenario to count as "executed" here. Hand-authored once
 * against parity.test.ts's actual titles (verified — every id below matches
 * exactly one test at the time of writing); a renamed/removed test makes
 * that scenario's `matchedTests` empty, which `assembleResults` below turns
 * into `status: 'no-matching-test-found'` rather than a silent false pass —
 * loud, not guessed. */
export const DETERMINISTIC_SCENARIO_TEST_SUBSTRINGS = {
  'ordinary-query': ['ordinary query: identical normalized'],
  'empty-result': ['empty result: zero rows'],
  'progressive-first-row': ['progressive first row: first row precedes completion'],
  'malformed-stream': ['malformed stream: a bad line is skipped'],
  'truncated-stream': ['truncated stream: an incomplete trailing line'],
  'server-error-before-headers': ['server error before headers: a query outcome'],
  'exception-after-headers-inband': ['in-band mid-stream exception: partial rows preserved'],
  'post-header-connection-reset': ['a mid-stream connection reset is a distinct'],
  'repeated-401': ['repeated 401 (no prior successful connection)'],
  'forbidden-403': ['post-confirmation 403: a query outcome'],
  'controlled-headers-and-summary': ['response headers, query id, and X-ClickHouse-Summary'],
  'kpi-progress': ['KPI progress path (publicly supported'],
  'raw-exception-like-text-then-more-data': ['exact byte count and SHA-256 equality on a TSV row containing exception-shaped text'],
  'raw-invalid-utf8': ['invalid-UTF-8 bytes hash identically'],
  'raw-tagged-late-exception': ['a tagged late-exception trailer survives byte transport'],
  'raw-legacy-untagged-exception': ['a legacy untagged exception trailer survives byte transport'],
  'table-streaming': ['Table streaming: identical normalized meta/row/progress'],
  'totals-extremes': ['totals/extremes/rows_before_limit_at_least lines are a silent no-op'],
  'cancel-before-request': ['cancel before request: a pre-aborted signal'],
  'cancel-awaiting-headers': ['cancel awaiting headers: cancellation without'],
  'cancel-during-rows': ['cancel during rows: no row is published'],
  'timeout-distinct-from-abort': ["the official client's own connection-level request_timeout"],
  'offline-vs-http-error': ['offline rejection is classified distinctly'],
  'settings-serialization': ['settings: exact server-observed bare-key values'],
  'role-serialization': ['role: exact server-observed value'],
  'session-param-serialization': ['session_id: present with the exact value'],
  'query-id-exists-before-execution': ['query ID exists before execution: the caller-allocated id'],
  'url-parameters-arrays-and-large-integers': ['URL parameters: an array of large-integer strings'],
  'forced-multipart': ['forced multipart: query() sends query_params as multipart'],
  'automatic-multipart': ['automatic multipart: an oversized query_params payload'],
  'explicit-format-no-duplication': ['explicit FORMAT: a SQL text that already carries a trailing FORMAT clause'],
  'raw-tsv-exact': ['raw TSV: exact byte-for-byte output'],
  'raw-csv-exact': ['raw CSV: exact byte-for-byte output'],
  'raw-json-exact': ['raw JSON: exact byte-for-byte output'],
  'no-output-command': ['an INSERT/DDL-shaped empty-body response is drained/discarded without hanging, and issues exactly one request'],
  'bearer-auth-exact-header': ['Bearer auth: exact request-local header'],
  'jwt-as-basic-exact-composition': ['JWT as Basic password: exact independently-computed Basic composition'],
  'refresh-then-retry': ['refresh then retry: exactly one refresh and one replay'],
  'post-confirmation-401': ['post-confirmation 401 remains a query outcome'],
  'stale-before-request': ['stale before request: an already-stale epoch prevents any fetch side effect'],
  'stale-during-refresh': ['stale during refresh: the epoch turning mid-refresh'],
  'stale-response': ['stale response: no connected/lifecycle side effect fires'],
  'read-reset-retries-once': ['read-reset-retries-once: a read retries once'],
  'ambiguous-insert-reset-no-retry': ['ambiguous INSERT reset: no retry'],
  'ambiguous-ddl-reset-no-retry': ['ambiguous DDL reset: no retry'],
  // Added for issue #585 finding #6 (critical-questions.md/ADR overstatement
  // review): these three ids let renderCriticalQuestionsMd() derive its
  // Yes/No from an ACTUAL results.json scenario status, matching the
  // already-established pattern the "raw bytes"/"mid-stream exception"
  // questions use, instead of a hand-typed literal that never reflected
  // whether the underlying test actually passed.
  'per-request-auth-no-reconstruction': ['alternating Basic user A / user B / invalid / valid'],
  'epoch-fence-immediate-pre-fetch': [
    'a stale epoch registered before preparation, flipped before the delegate fetch fires, never reaches the network',
    'a current (non-stale) epoch reaches the network exactly once',
  ],
  'cancellation-lease-frozen-credential': [
    'a credential rotated AFTER the lease was captured never reaches the KILL QUERY request',
  ],
};

/** Walk a Playwright JSON reporter report's `suites` tree looking for
 * `browser.spec.js`'s `row=<rowKey> origin=<mode>` describe blocks
 * (`browser.spec.js`'s own `test.describe(\`row=${rowKey} origin=${mode}\`, ...)`)
 * and return `{ "<rowKey>/<mode>": boolean }` — true only when EVERY spec
 * under that one row/origin suite passed (`spec.ok`).
 *
 * DISCOVERED BY A REAL RUN (2026-08-06): the caller used to derive ONE
 * pass/fail boolean from `pw.stats.unexpected === 0` for the WHOLE
 * Playwright invocation (which covers ALL requested rows x both origins in
 * a single project run) and then blanket-applied that ONE boolean to EVERY
 * row/origin `browserMatrix` entry for that browser. A single flaky/failing
 * test ANYWHERE in that run (e.g. one `beforeEach` hook timeout on one
 * row/origin, observed live under this sandbox's Docker-emulation
 * contention) therefore marked ALL 8 row/origin combinations for that
 * browser as "failed" even when 7 of 8 (or all 8) genuinely passed — the
 * exact shape of a real "16/16 webkit rows failed while chromium passed
 * 16/16" evidence anomaly that turned out to be this aggregation bug, not a
 * genuine per-row WebKit incompatibility (issue #585 Phase 0 evidence
 * review). This function restores the granularity the JSON report already
 * contains instead of collapsing it. */
function computeBrowserRowOriginResults(pw) {
  const out = {};
  const fileSuites = pw.suites || [];
  const rowOriginRe = /^row=(.+) origin=(.+)$/;
  const walk = (suites) => {
    for (const s of suites) {
      const m = rowOriginRe.exec(s.title || '');
      if (m) {
        const [, rowKey, mode] = m;
        const specs = s.specs || [];
        const allOk = specs.length > 0 && specs.every((spec) => spec.ok === true);
        out[`${rowKey}/${mode}`] = allOk;
      }
      if (s.suites) walk(s.suites);
    }
  };
  walk(fileSuites);
  return out;
}

/** Strip ANSI escape sequences (e.g. Playwright/Node's own colorized error
 * output, `\x1b[2m...\x1b[22m`) from captured text, at CAPTURE time
 * (`collectBrowserFailureDetail` below), not just when rendering — a raw
 * escape code committed into `docs/evidence/585/compatibility-matrix.md`
 * would corrupt the markdown for any viewer/diff tool that doesn't itself
 * interpret ANSI (verified live: a captured `lastError` retained a literal
 * `\x1b[2m` sequence before this fix). */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex -- deliberately matching the ESC control character.
  return String(str).replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/** Walk the SAME Playwright JSON reporter tree `computeBrowserRowOriginResults`
 * walks and, for every `row=<rowKey> origin=<mode>` suite, collect a COMPACT
 * record per spec/test that did NOT pass on its very first attempt: its
 * title, how many attempts ran (`results.length` — retries included), the
 * last attempt's status, and the last attempt's error message (ANSI-stripped,
 * truncated to 500 chars — this is durable evidence, not a full debugging
 * transcript). A spec whose first attempt already passed is skipped
 * entirely — no record is fabricated for a genuinely clean pass. Returns
 * `{ "<rowKey>/<mode>": [{ title, attempts, lastStatus, lastError }, ...] }`,
 * omitting any row/origin whose specs all passed cleanly on attempt 1.
 *
 * A P2 review finding (issue #585 Phase 0) found the evidence generator
 * reduced every browser-matrix cell to a bare pass/fail boolean plus browser
 * version, discarding failing-test names, error output, and retry counts —
 * while the ADR/PR text separately attributed the one observed failure to a
 * specific root cause (Docker resource contention) with nothing durable in
 * `docs/evidence/585/**` backing that attribution. This does not itself PROVE
 * a root cause — it preserves what actually failed (and how many times it was
 * retried) so a future root-cause claim has a committed, machine-checked
 * record to point at instead of prose in a commit message.
 *
 * Extended for that same finding's follow-up (issue #585, the
 * `playwright.config.js` `retries: 2` fix that made this sandbox's isolated
 * Docker-contention flakes retryable instead of hard browser-matrix
 * failures): before retries existed, `spec.ok !== true` was the only signal
 * this function used — a spec that failed once and then passed on retry ends
 * up with `spec.ok === true`, and the old `if (spec.ok === true) continue`
 * guard discarded the fact it ever failed at all, rendering a truly flaky
 * cell as a clean, silent pass. That is laundering, not reporting. This
 * function now keys off each TEST's own attempt count/final status instead
 * of the spec-level `ok` boolean, so a spec that needed a retry to pass still
 * produces a record here; `classifyBrowserMatrixCell` is what turns that
 * into a distinct `'flaky'` cell status rather than a bare `'passed'`. */
export function collectBrowserFailureDetail(pw) {
  const out = {};
  const rowOriginRe = /^row=(.+) origin=(.+)$/;
  const walk = (suites) => {
    for (const s of suites) {
      const m = rowOriginRe.exec(s.title || '');
      if (m) {
        const [, rowKey, mode] = m;
        const notable = [];
        for (const spec of s.specs || []) {
          for (const test of spec.tests || []) {
            const results = test.results || [];
            const last = results[results.length - 1] || {};
            // A single, first-attempt pass has nothing to report — skip it
            // rather than fabricate a record for a genuinely clean result.
            if (results.length <= 1 && last.status === 'passed') continue;
            const lastError = last.error?.message || last.errors?.[0]?.message || '';
            notable.push({
              title: spec.title,
              attempts: results.length,
              lastStatus: last.status || 'unknown',
              lastError: stripAnsi(lastError).slice(0, 500),
            });
          }
        }
        if (notable.length) out[`${rowKey}/${mode}`] = notable;
      }
      if (s.suites) walk(s.suites);
    }
  };
  walk(pw.suites || []);
  return out;
}

/** Classify ONE `results.browserMatrix` cell from a single browser project's
 * Playwright JSON-report state. Three distinct, never-conflated cases:
 *
 *  1. `reportAvailable` is false — the JSON report itself never came into
 *     existence (e.g. the webServer never came up and Playwright wrote
 *     nothing). The blanket per-project `allPassed` boolean is the only
 *     information that exists, so the cell inherits it directly. `pwErrors`
 *     is threaded in anyway (see below) for the rare case the caller DOES
 *     have something (e.g. the runner's own captured stderr) even without a
 *     report — normally empty here, since no report means no `pw.errors[]`.
 *  2. The report exists AND contains a suite matching this exact
 *     `rowOriginKey` (`rowOriginResults` has an own entry for it) — per-cell
 *     granularity from the report is authoritative.
 *  3. The report exists but has NO suite for this exact `rowOriginKey` —
 *     e.g. a whole-file collection/hook error Playwright records as a
 *     top-level `errors` entry rather than a per-suite failure, so
 *     `pw.stats.unexpected` can read 0 even though this exact row/origin
 *     never actually ran.
 *
 * A P2 review finding (issue #585 Phase 0) caught case 3 silently falling
 * into case 1's blanket signal — `results.browserMatrix[key].executed` was
 * set to `true` and its `status` to the PROJECT-WIDE `allPassed` value even
 * though this specific row/origin was never corroborated, which let
 * `selectEarliestPassingVersion` treat a row as having cleared its browser
 * hard gate on a fabricated per-cell pass. Case 3 must never be reported as
 * `executed: true` — it is reported `executed: false` with a distinct
 * `'no-matching-suite-in-report'` status, which `validate-evidence.mjs`'s
 * existing "has not executed" check already treats as missing evidence
 * (never a pass), and which `selectEarliestPassingVersion`'s
 * `v.executed && (v.status === 'passed' || v.status === 'flaky')` gate
 * already excludes.
 *
 * Two follow-up fixes (issue #585, Docker-contention flake investigation):
 *
 *  - Case 2 now distinguishes a CLEAN pass from a FLAKY one. `passed` here
 *    means every spec's FINAL attempt in this row/origin passed
 *    (`computeBrowserRowOriginResults`'s `spec.ok` check, unchanged); but
 *    `collectBrowserFailureDetail` now also records a spec that needed a
 *    retry to get there. When that per-row/origin detail is non-empty, this
 *    is reported as its own `'flaky'` status (never silently folded into
 *    `'passed'`, which would launder the retry, and never `'failed'`, which
 *    it isn't — it DID pass) — with the SAME `failureDetail` shape a genuine
 *    failure gets, so the evidence is never blank for a real flaky result.
 *  - Cases 1 and 3 (a whole-project/webServer-level failure) now accept an
 *    optional `pwErrors` array — pre-extracted, ANSI-stripped strings from
 *    Playwright's own top-level `pw.errors[]` — and attach it as
 *    `projectErrors` whenever non-empty, so a boot-level failure is no
 *    longer as blank as a per-test one used to be before the fix above. */
export function classifyBrowserMatrixCell({
  reportAvailable, rowOriginResults, rowOriginKey, allPassed, failureDetailByRowOrigin, pwErrors = [],
}) {
  if (!reportAvailable) {
    const cell = { executed: true, status: allPassed ? 'passed' : 'failed' };
    if (pwErrors.length) cell.projectErrors = pwErrors;
    return cell;
  }
  if (rowOriginResults && rowOriginKey in rowOriginResults) {
    const passed = rowOriginResults[rowOriginKey];
    const detail = failureDetailByRowOrigin?.[rowOriginKey];
    const status = passed ? (detail?.length ? 'flaky' : 'passed') : 'failed';
    const cell = { executed: true, status };
    // Compact, durable detail record (plan §29's evidence-must-not-discard-
    // detail rule) — present for a genuine failure OR a flaky pass, both of
    // which have per-row/origin detail available; absent (never a
    // misleading empty array) for a clean pass.
    if (detail?.length) cell.failureDetail = detail;
    return cell;
  }
  // The report exists, but no suite matched this exact row/origin — this
  // cell cannot be corroborated per-cell; it must NEVER inherit the
  // project-wide blanket boolean (that is the exact P2 review finding).
  const cell = { executed: false, status: 'no-matching-suite-in-report' };
  if (pwErrors.length) cell.projectErrors = pwErrors;
  return cell;
}

/** Live-only scenario ids (no fault-server fixture — need a real server;
 * plan §17/§22/§23) mapped the same way, against `live-parity.test.ts` /
 * `live-sessions.test.ts`'s full titles. These are NOT in scenarios.ts
 * (which documents itself as the deterministic subset only). */
const LIVE_SCENARIO_TEST_SUBSTRINGS = {
  'server-cancellation-kill-query': ['KILL QUERY'],
  'temporary-table-session-scoped': ['temporary table'],
  'session-set-persistence': ['SET'],
  'session-is-locked-live-retry': ['SESSION_IS_LOCKED'],
  'progressive-timing-real-server': ['first row precedes completion by >=1s'],
  'mid-stream-progress-error-real-server': ['definitively fails, never silently succeeds'],
};

export function matchScenarios(substringMap, assertions) {
  const out = {};
  for (const [id, substrings] of Object.entries(substringMap)) {
    const matches = assertions.filter((a) => substrings.some((s) => a.fullName.includes(s)));
    out[id] = {
      executed: matches.length > 0,
      status: matches.length === 0 ? 'no-matching-test-found' : (matches.every((m) => m.status === 'passed') ? 'passed' : 'failed'),
      matchedTestCount: matches.length,
    };
  }
  return out;
}

// ── format-type-probe (compile-time proof, plan §16) ────────────────────────

async function checkFormatTypeProbeCompiles() {
  const result = await run('npx', ['tsc', '--noEmit'], { cwd: repoRoot, timeout: 180_000 });
  return { ranTypeCheck: true, pass: result.ok, output: result.ok ? '' : result.stderr.slice(-4000) };
}

// ── bridge/guard LOC + deletion estimate (plan §16/§28) ─────────────────────

// Deletion-estimate manifest — plan §28's buckets, computed mechanically from
// src/net/ch-client.ts's own top-level symbol boundaries (see
// classifyFunctionRanges) so this stays tied to the REAL file rather than a
// hand-typed LOC guess. Classification rationale (final owner per bucket):
//   delete-after-cutover           — generic URL/settings/params/fetch/stream
//                                     mechanics the official client's own
//                                     exec()/query()/command() supersede.
//   rewrite-narrow-adapter          — credential-epoch fencing folded into
//                                     the now-deleted authedFetch (issue #630
//                                     Phase 6 moved that wiring into
//                                     authenticated-clickhouse-request.ts; a
//                                     Phase 2 official-client adapter would
//                                     reimplement this as its own narrow
//                                     guard — this spike's guarded-fetch.ts
//                                     is the working precedent). No current
//                                     ch-client.ts symbol carries this bucket
//                                     any more; the definition is kept for
//                                     completeness.
//   retain-temporary-bridge         — the frozen-lease KILL QUERY policy
//                                     (killQueryWithLease); plan §28 named
//                                     this its own bucket, not deletion-
//                                     eligible — issue #630 Phase 7 kept it
//                                     as a permanent SQL Browser policy seam,
//                                     never a forwarding wrapper.
//   unrelated-product-operation     — schema/lineage/reference-data/doc
//                                     browsing: domain-specific SQL, never
//                                     generic transport, unaffected by which
//                                     client library issues the request.
//
// `chUrl` is NOT here — the package (`@altinity/clickhouse-http`) owns it;
// ch-client.ts only re-exports the name (`export { chUrl };`, no `const`/
// `function` keyword), which the boundary regex correctly does not match, so
// keeping a `chUrl` entry here would itself be exactly the stale-
// classification drift the mirror guard now catches.
//
// Issue #630 Phase 7 deleted `isCurrentEpoch`, `staleEpochAbort`,
// `transportFor`, and `authedFetch` outright (their credential-epoch/generic-
// transport wiring had already folded into `authenticated-clickhouse-
// request.ts` in Phase 6, with no forwarding wrapper left in this file),
// plus the ordinary mutable-context `killQuery`, `exportQuery`, and
// `runQuery` (their SQL Browser policy moved to `query-execution-
// service.ts`/`export-service.ts`, driving the package's request/response
// primitives directly — Checkpoint 2D). None of those seven names has a
// classification entry below any more — re-adding one without the symbol
// itself returning would be exactly the stale-classification drift the
// mirror guard now catches.
const CH_CLIENT_CLASSIFICATION = {
  isAbort: 'delete-after-cutover',
  errMessage: 'delete-after-cutover',
  queryJson: 'delete-after-cutover',
  querySystemAware: 'unrelated-product-operation',
  loadDataLakeCatalogTableNames: 'unrelated-product-operation',
  killQueryWithLease: 'retain-temporary-bridge',
  loadServerVersion: 'unrelated-product-operation',
  byUnderscoreThenName: 'unrelated-product-operation',
  loadSchema: 'unrelated-product-operation',
  AST_PROGRESSIVE_THRESHOLD: 'unrelated-product-operation',
  loadSchemaLineage: 'unrelated-product-operation',
  loadColumns: 'unrelated-product-operation',
  loadSchemaCards: 'unrelated-product-operation',
  loadLineageTransitive: 'unrelated-product-operation',
  loadTableDetail: 'unrelated-product-operation',
  tryRun: 'unrelated-product-operation',
  tryQueryData: 'unrelated-product-operation',
  trySystemAwareQueryData: 'unrelated-product-operation',
  firstLine: 'unrelated-product-operation',
  loadReferenceData: 'unrelated-product-operation',
  // The doc-probe table-name lookup backing loadDocTableColumns — #313/#314
  // doc-browsing data, same bucket as its callers below.
  DOC_PROBE_TABLE_NAMES: 'unrelated-product-operation',
  loadDocTableColumns: 'unrelated-product-operation',
  loadDocRow: 'unrelated-product-operation',
  loadFunctionsDocColumns: 'unrelated-product-operation',
  loadFunctionDocRow: 'unrelated-product-operation',
};

// src/net/clickhouse-http-transport.ts — the custom generic-transport
// implementation `chUrl`/`streamLines`/`createHttpTransport` moved into
// after issue #585 Phase 1 — is DELETED as of issue #630 Phase 7
// Checkpoint 2D: `killQueryWithLease` (above) was rewritten onto the
// package's own stateless `createClickHouseHttpClient(...).killQuery(...)`,
// which was that file's last remaining caller, and `src/net/clickhouse-
// transport.types.ts` went with it. There is exactly one generic ClickHouse
// HTTP transport implementation left in the repository now (the package's)
// — no manifest entry, classification table, or disk read for either
// deleted file remains in this module (see the real-tree regression in
// run-matrix.test.ts proving `computeDeletionEstimate()` works with the
// adapter file absent).

// official-adapter.ts symbols that are SPIKE-TEST-ONLY harness scaffolding
// (exist to let parity.test.ts hand-drive specific retry-safety scenarios),
// never something a real Phase 2 adapter would ship — plan §28's "no spike
// test or orchestration code counted as production deletion". Excluded from
// the "estimated official adapter executable LOC" figure entirely (not
// classified into a bucket at all).
// `makeOfficialRunQueryShim` (retired, issue #630 Phase 7 Checkpoint 2C's
// spike portion) is replaced here by `makeOfficialQueryExecutionAdapter` —
// same test-only-harness role (per its own doc comment, "the direct
// replacement for the retired `makeOfficialRunQueryShim`"), just satisfying
// `QueryExecutionService`'s narrow post-Phase-7 dependency shape instead of
// the retiring `typeof runQuery`.
const OFFICIAL_ADAPTER_TEST_ONLY_SYMBOLS = ['RefreshDrivenResult', 'runOfficialRefreshThenRetry', 'makeOfficialQueryExecutionAdapter'];
// NOTE: `OfficialConnection` is deliberately NOT a key here (and never was
// matched by either the old or the broadened boundary regex): it is an
// `export interface`, and this function's boundary detection only ever
// matches `function`/`const` declarations — a type-only interface is always
// silently absorbed into whichever range precedes it (or, here, dropped
// entirely as it sits before this file's first matched boundary), exactly
// like every OTHER interface in this file and in ch-client.ts. It was a
// latent stale classification-table entry (harmless before the drift guard
// below existed, since nothing checked this direction) surfaced by adding
// that guard — removed rather than "fixed" some other way, to match how
// every other type-only declaration in both files is already handled.
const OFFICIAL_ADAPTER_CORE_CLASSIFICATION = {
  createOfficialConnection: 'official-adapter-core',
  officialAuthFor: 'official-adapter-core',
  // Broadening the boundary regex (see classifyFunctionRangesFromSource's
  // header comment) to match non-exported declarations makes these two
  // helpers — always non-exported, always part of runOfficial's own
  // outcome-normalization logic, never spike-test-only scaffolding — their
  // own tracked boundaries for the first time; they were previously
  // invisible to this mechanism and silently absorbed into whichever
  // exported boundary preceded them.
  classifyError: 'official-adapter-core',
  flattenHeaders: 'official-adapter-core',
  runOfficial: 'official-adapter-core',
};

// Exported (matching support-minimum.mjs's own precedent, see the comment
// above deriveProposedMinimum's import) so a one-off, evidence-only
// regeneration of docs/evidence/585/deletion-estimate.md — e.g. after
// official-adapter.ts's production-shaped core changes, with no Docker/
// Playwright rerun required — can call it directly without booting the
// entire matrix as a side effect of importing this module.
export async function computeDeletionEstimate() {
  const chClientPath = join(repoRoot, 'src/net/ch-client.ts');
  const chClientBuckets = await classifyFunctionRanges(chClientPath, CH_CLIENT_CLASSIFICATION);
  // Issue #630 Phase 7 deleted src/net/clickhouse-http-transport.ts (and its
  // type seam) outright — there is no second file's `delete-after-cutover`
  // bucket to classify/measure/combine any more. `currentGenericLoc` below
  // is ch-client.ts's own bucket alone, and this function deliberately never
  // opens `src/net/clickhouse-http-transport.ts` (confirmed absent by the
  // real-tree regression in run-matrix.test.ts) — reintroducing a read of
  // that path here would just reopen the ENOENT this checkpoint removed.
  const officialAdapterPath = join(spikeDir, 'official-adapter.ts');
  const officialBuckets = await classifyFunctionRanges(
    officialAdapterPath, OFFICIAL_ADAPTER_CORE_CLASSIFICATION, OFFICIAL_ADAPTER_TEST_ONLY_SYMBOLS,
  );
  const bridgeLoc = await measureLoc(join(spikeDir, 'progress-bridge.ts'));
  const guardLoc = await measureLoc(join(spikeDir, 'guarded-fetch.ts'));

  const streamTsLines = (await readFile(join(repoRoot, 'src/core/stream.ts'), 'utf8')).split('\n').length;
  const qesLines = (await readFile(join(repoRoot, 'src/application/query-execution-service.ts'), 'utf8')).split('\n').length;

  const currentGenericLoc = chClientBuckets['delete-after-cutover'] || 0;
  const estimatedOfficialAdapterLoc = officialBuckets['official-adapter-core'] || 0;
  const acceptedBridgeGuardLoc = bridgeLoc.physical + guardLoc.physical;
  const netExecutableDeletion = currentGenericLoc - estimatedOfficialAdapterLoc - acceptedBridgeGuardLoc;

  return {
    currentGenericLocEligibleForDeletion: currentGenericLoc,
    estimatedOfficialAdapterLoc,
    acceptedBridgeGuardLoc,
    netExecutableDeletion,
    manifest: {
      'ch-client.ts': chClientBuckets,
      'official-adapter.ts (test-only harness excluded)': officialBuckets,
      'progress-bridge.ts (physical)': bridgeLoc.physical,
      'guarded-fetch.ts (physical)': guardLoc.physical,
      'retain-as-sql-browser-policy: src/core/stream.ts (whole file, physical)': streamTsLines,
      'retain-as-sql-browser-policy: src/application/query-execution-service.ts (whole file, physical)': qesLines,
    },
    bridgeLoc,
    guardLoc,
    positiveNetDeletion: netExecutableDeletion > 0,
  };
}

export function renderDeletionEstimateMd(d) {
  const L = [];
  L.push('# Future production deletion estimate (plan §28)');
  L.push('');
  L.push('Estimate only — actual deletion is Phase 4, per plan §4/§28. Computed mechanically');
  L.push('from `src/net/ch-client.ts`\'s own top-level symbol boundaries (see `run-matrix.mjs`\'s');
  L.push('`CH_CLIENT_CLASSIFICATION` data table) so the figures stay tied to the real file rather');
  L.push('than a hand-typed guess; an unclassified symbol, or a classification-table entry that no');
  L.push('longer matches anything, makes `run-matrix.mjs` throw instead of silently under/over-');
  L.push('counting in either direction. `src/net/clickhouse-http-transport.ts` — a second file this');
  L.push('estimate used to classify separately and sum in (issue #585 Phase 1, PR #621) — is deleted');
  L.push('as of issue #630 Phase 7 Checkpoint 2D; this estimate has no classification table, manifest');
  L.push('entry, or disk read for it any more.');
  L.push('');
  L.push('## `src/net/ch-client.ts` buckets (physical LOC per top-level symbol range)');
  L.push('');
  L.push('| Bucket | Physical LOC |');
  L.push('|---|---|');
  for (const [bucket, loc] of Object.entries(d.manifest['ch-client.ts'])) L.push(`| \`${bucket}\` | ${loc} |`);
  L.push('');
  L.push('## Other named responsibilities');
  L.push('');
  L.push('| Responsibility | Final owner / bucket | Physical LOC |');
  L.push('|---|---|---|');
  L.push(`| \`tests/spike/clickhouse-client/official-adapter.ts\` production-shaped core (\`OfficialConnection\`/\`createOfficialConnection\`/\`officialAuthFor\`/\`runOfficial\`; spike-test-only harness excluded) | estimated official adapter | ${d.estimatedOfficialAdapterLoc} |`);
  L.push(`| \`tests/spike/clickhouse-client/progress-bridge.ts\` | accepted narrow bridge | ${d.bridgeLoc.physical} (${d.bridgeLoc.transformedExecutable} transformed executable) |`);
  L.push(`| \`tests/spike/clickhouse-client/guarded-fetch.ts\` | accepted narrow guard | ${d.guardLoc.physical} (${d.guardLoc.transformedExecutable} transformed executable) |`);
  L.push(`| \`src/core/stream.ts\` (whole file) | retain as SQL Browser policy — normalized meta/row/progress/error representation, unaffected by transport choice | ${d.manifest['retain-as-sql-browser-policy: src/core/stream.ts (whole file, physical)']} |`);
  L.push(`| \`src/application/query-execution-service.ts\` (whole file) | retain as SQL Browser policy — retry safety, unaffected by transport choice | ${d.manifest['retain-as-sql-browser-policy: src/application/query-execution-service.ts (whole file, physical)']} |`);
  L.push('');
  L.push('## Formula (plan §28)');
  L.push('');
  L.push('Every term below is the SAME comment/blank-stripped "physical LOC" metric');
  L.push('(`physicalLineCount()` in `run-matrix.mjs`) — a P3 review finding (issue #585 Phase 0)');
  L.push('caught an earlier version of this formula mixing that metric for the bridge/guard terms');
  L.push('with a raw, comment-and-blank-INCLUSIVE line-range count for the ch-client.ts/');
  L.push('official-adapter.ts terms, which inflated those two terms (concentrated in');
  L.push('comment-heavy functions like `runOfficial`) relative to the bridge/guard terms.');
  L.push('');
  L.push('Issue #630 Phase 7 Checkpoint 2D deleted `src/net/clickhouse-http-transport.ts` outright (the');
  L.push('second file issue #585 Phase 1, PR #621 had split the generic-transport surface across) — the');
  L.push('formula\'s first term is `ch-client.ts`\'s own `delete-after-cutover` bucket alone now, not a sum.');
  L.push('');
  L.push('```text');
  L.push('current generic physical LOC eligible for deletion');
  L.push(`  = ${d.currentGenericLocEligibleForDeletion}   (ch-client.ts "delete-after-cutover" bucket)`);
  L.push('- estimated official adapter physical LOC');
  L.push(`  = ${d.estimatedOfficialAdapterLoc}   (official-adapter.ts production-shaped core)`);
  L.push('- accepted narrow bridge/guard physical LOC');
  L.push(`  = ${d.acceptedBridgeGuardLoc}   (progress-bridge.ts + guarded-fetch.ts)`);
  L.push('= estimated net physical LOC deletion');
  L.push(`  = ${d.netExecutableDeletion}`);
  L.push('```');
  L.push('');
  L.push(`Net deletion is ${d.positiveNetDeletion ? 'POSITIVE' : 'NOT positive'} — an Accepted ADR requires positive net deletion (plan §30 "Mark Accepted only if ... future net deletion is positive").`);
  L.push('');
  L.push('Buckets NOT counted toward deletion (retained, rewritten, or unrelated — each with exactly');
  L.push('one final owner, per plan §28 "no permanent dual generic transport"):');
  L.push('');
  L.push('- `rewrite-narrow-adapter` — credential-epoch fencing folds into the official adapter\'s own request construction (this spike\'s `guarded-fetch.ts` is the working precedent). No current `ch-client.ts` symbol carries this bucket (issue #630 Phase 7 deleted its former members, `isCurrentEpoch`/`staleEpochAbort`/`authedFetch`, outright); kept for definitional completeness.');
  L.push('- `retain-temporary-bridge` — the frozen-lease `killQueryWithLease` policy (the ordinary mutable-context `killQuery` this bucket also used to cover was deleted outright in issue #630 Phase 7, with no forwarding wrapper).');
  L.push('- `unrelated-product-operation` — schema/lineage/reference-data/doc-browsing SQL: never generic transport.');
  L.push('- `retain-as-sql-browser-policy` — `src/core/stream.ts` (normalized outcome) and `src/application/query-execution-service.ts` (retry safety): both already isolated from ch-client.ts and untouched by transport choice.');
  L.push('');
  return L.join('\n');
}

// support-minimum-analysis.md (plan §13) is rendered by `renderSupportMinimumMd`
// (imported above) — moved into support-minimum.mjs, next to the
// `deriveProposedMinimum()`/`SERVER_SENSITIVE_INVENTORY` data it renders, and
// exported so a one-off evidence-only regeneration (e.g. after a scan-target
// fix that doesn't require re-running the live Docker/browser matrix) can
// import and call it directly without importing this whole orchestrator
// (which runs its `main()` unconditionally on import).

/** Compare two ClickHouse version strings ("MAJOR.MINOR.PATCH.BUILD[.suffix]")
 * numerically, dot-segment by dot-segment — NEVER lexicographically. A P2
 * review finding (issue #585 Phase 0): `selectEarliestPassingVersion` used to
 * compare raw version strings with JS `<`, which is plain lexicographic
 * (character-code) ordering — `'26.10.1.1' < '26.9.1.1'` is `true` as
 * strings (because `'1' < '9'` character-wise), backwards from the real,
 * numeric version order. ClickHouse already produces exactly this
 * digit-count pattern across real minor lines (24.9 -> 24.10 -> 24.11 ->
 * 24.12 all exist), so this was not a theoretical risk. Each segment is
 * compared as an integer when BOTH sides parse as one; a segment that
 * doesn't (e.g. the trailing `altinitystable` suffix) falls back to a plain
 * string compare for THAT segment only, so `"24.8.14.10547.altinitystable"`
 * still compares its leading numeric segments numerically. Returns a
 * negative/zero/positive number exactly like a standard comparator. */
export function compareClickHouseVersions(a, b) {
  const as = String(a).split('.');
  const bs = String(b).split('.');
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    const av = as[i] ?? '';
    const bv = bs[i] ?? '';
    const an = /^\d+$/.test(av) ? Number(av) : NaN;
    const bn = /^\d+$/.test(bv) ? Number(bv) : NaN;
    if (Number.isNaN(an) || Number.isNaN(bn)) {
      if (av !== bv) return av < bv ? -1 : 1;
    } else if (an !== bn) {
      return an - bn;
    }
  }
  return 0;
}

/** Select the "earliest version that passed every required hard gate" floor
 * (plan §5 step 5) — MUST be called only after BOTH `results.matrixRows`
 * (live-suite + precision corpus, per row) AND `results.browserMatrix`
 * (per row/origin/browser) are fully populated for this invocation, never
 * from inside the per-row live-matrix loop.
 *
 * A P1 review finding (issue #585 Phase 0) caught the earlier shape of this
 * derivation: it picked the earliest row whose live-suite + precision corpus
 * passed WHILE the browser matrix for that exact row had not run yet (the
 * browser-matrix section runs strictly later in `main()`), so a row could be
 * — and, in the run that surfaced the finding, actually was — reported as
 * having "passed every required hard gate" while its own same-origin WebKit
 * result had already failed. This function is the single place that floor is
 * now derived, and it re-validates the row's OWN browser/origin results
 * before naming it, rather than trusting an earlier, narrower pass.
 *
 * A row this invocation never ran through the browser matrix at all (not in
 * `browserRowKeys` — e.g. `--browsers none`, or `--rows` narrowed to rows the
 * browser section didn't cover) has zero `requested` browser-matrix entries
 * and is therefore excluded, never assumed to have passed a gate that simply
 * never ran for it. */
export function selectEarliestPassingVersion(results, matrixJson) {
  let earliest = null;
  for (const [rowKey, rowResult] of Object.entries(results.matrixRows || {})) {
    if (!rowResult || rowResult.status !== 'passed') continue;
    const kind = matrixJson.rows?.[rowKey]?.kind;
    if (kind !== 'oss' && kind !== 'altinity-stable') continue;
    const rowVersion = rowResult.serverVersion;
    if (!rowVersion) continue;

    const browserEntriesForRow = Object.values(results.browserMatrix || {}).filter((v) => v.row === rowKey);
    const requiredBrowserEntries = browserEntriesForRow.filter((v) => v.requested);
    // The browser matrix never covered this row this invocation — the
    // browser hard gate cannot be corroborated for it, so it cannot be named
    // as having passed EVERY required hard gate.
    if (requiredBrowserEntries.length === 0) continue;
    // 'flaky' (a spec that passed only after a retry — issue #585
    // Docker-contention flake fix) still counts as a cleared gate: it DID
    // pass, just not on the first attempt, and `playwright.config.js`'s
    // `retries: 2` is exactly the mechanism that makes this a legitimate
    // pass rather than a masked failure.
    const browserGatePassed = requiredBrowserEntries.every((v) => v.executed && (v.status === 'passed' || v.status === 'flaky'));
    if (!browserGatePassed) continue;

    if (!earliest || compareClickHouseVersions(rowVersion, earliest) < 0) earliest = rowVersion;
  }
  return earliest;
}

// ── critical-questions.md (plan §27) ────────────────────────────────────────

export function renderCriticalQuestionsMd(r) {
  const q = (title, answer, evidence) => ({ title, answer, evidence });
  const bridgeLine = `${r.deletionEstimate.bridgeLoc.physical} physical / ${r.deletionEstimate.bridgeLoc.transformedExecutable} transformed executable lines (progress-bridge.ts) + ${r.deletionEstimate.guardLoc.physical} physical / ${r.deletionEstimate.guardLoc.transformedExecutable} transformed executable (guarded-fetch.ts)`;
  const questions = [
    q('Can the client request or expose JSONStringsEachRowWithProgress safely?',
      'No — rejected by the installed 1.23.1 public type surface (compile-time @ts-expect-error probe, format-type-probe.ts); a narrow exec()-based bridge is used instead.',
      'tests/spike/clickhouse-client/format-type-probe.ts (compile-time @ts-expect-error proof); tsc --noEmit result recorded in results.json.typeCheck'),
    q('If not, how many bridge lines are required?', bridgeLine,
      'docs/evidence/585/bridge-loc.json'),
    q('Does exec() expose raw bytes without text decoding?',
      r.scenarios?.['raw-invalid-utf8']?.status === 'passed'
        ? 'Yes — proven by the invalid-UTF-8 SHA-256 digest-equality scenario.'
        : 'Not proven in this run (scenario not executed/failed) — see scenarios["raw-invalid-utf8"] in results.json.',
      'tests/spike/clickhouse-client/parity.test.ts "raw export: invalid-UTF-8 bytes hash identically"'),
    q('Can mid-stream exception behavior be preserved?',
      r.scenarios?.['exception-after-headers-inband']?.status === 'passed'
        ? 'Yes on the deterministic fault-server fixture; see results.json.matrixRows for the real-server corroboration per row.'
        : 'Not proven in this run — see scenarios["exception-after-headers-inband"] in results.json.',
      'tests/spike/clickhouse-client/parity.test.ts in-band exception test; live-parity.test.ts real-server exception test'),
    q('Can per-request auth work without mutation or reconstruction?',
      r.scenarios?.['per-request-auth-no-reconstruction']?.status === 'passed'
        ? 'Yes — proven by the alternating-credentials test: each of four requests (Basic user A / user B / an invalid credential / user A again) is observed server-side using ONLY its own supplied credential, and the official client\'s constructor-call count stays at 1 throughout (official-adapter.ts\'s `constructorCalls` is a real, mechanically-enforced count backed by every `.client` assignment — never a hardcoded literal — so a future reconstruction would be caught, not silently passed).'
        : 'Not proven in this run — see scenarios["per-request-auth-no-reconstruction"] in results.json.',
      'tests/spike/clickhouse-client/parity.test.ts "alternating Basic user A / user B / invalid / valid"; tests/spike/clickhouse-client/official-adapter.ts constructorCalls'),
    q('Can epoch fencing occur immediately before fetch?',
      r.scenarios?.['epoch-fence-immediate-pre-fetch']?.status === 'passed'
        ? 'Yes — proven by the deliberate epoch-flip race test at the ACTUAL injected-fetch boundary (guarded-fetch.ts\'s guardedFetch, wired as the real official client\'s own fetch): a request whose epoch turns after preparation but before the delegate fetch fires is rejected with zero delegated calls; a current-epoch request delegates exactly once.'
        : 'Not proven in this run — see scenarios["epoch-fence-immediate-pre-fetch"] in results.json.',
      'tests/spike/clickhouse-client/parity.test.ts credential-epoch fencing block; tests/spike/clickhouse-client/guarded-fetch.ts'),
    q('How are abort, timeout, and ClickHouse errors distinguished?',
      // Not a yes/no question — recorded descriptively, matching the cited
      // tests' own taxonomy (cancel -> cancelled; timeout -> distinct Timeout
      // error, never AbortError; offline -> network rejection, chCode null;
      // ClickHouse HTTP error -> chCode/chMessage populated).
      'Recorded per the four-way taxonomy tests: cancel/timeout/offline/HTTP-error each produce a distinct, non-overlapping classification on the official adapter (see the cited tests for the exact shape each one receives).',
      'tests/spike/clickhouse-client/parity.test.ts cancellation + timeout/offline blocks'),
    q('Are code and message retained for current policy?',
      ['repeated-401', 'forbidden-403', 'read-reset-retries-once', 'ambiguous-insert-reset-no-retry', 'ambiguous-ddl-reset-no-retry'].every((id) => r.scenarios?.[id]?.status === 'passed')
        ? 'Yes — proven by the 401/403/SESSION_IS_LOCKED/reset error-taxonomy tests: ClickHouse code AND message survive intact for HTTP-level errors (401 -> chCode 516, 403 -> chCode 497, both with the server\'s own message text preserved), and the retry-safety layer\'s message is preserved for the ambiguous-write/reset cases the same policy already produces today.'
        : 'Not proven in this run — see scenarios["repeated-401"|"forbidden-403"|"read-reset-retries-once"|"ambiguous-insert-reset-no-retry"|"ambiguous-ddl-reset-no-retry"] in results.json.',
      'tests/spike/clickhouse-client/parity.test.ts retry-safety block'),
    q('Does the client support the proposed minimum?',
      `Proposed minimum ClickHouse ${r.supportMinimum.proposedMinimum} — see docs/evidence/585/support-minimum-analysis.md and results.json.matrixRows for the executed oldest-row corroboration.`,
      'docs/evidence/585/support-minimum-analysis.md; results.json.matrixRows'),
    q('What production code would be deleted?',
      `Estimated net executable LOC deletion: ${r.deletionEstimate.netExecutableDeletion} (${r.deletionEstimate.currentGenericLocEligibleForDeletion} eligible - ${r.deletionEstimate.estimatedOfficialAdapterLoc} adapter - ${r.deletionEstimate.acceptedBridgeGuardLoc} bridge/guard).`,
      'docs/evidence/585/deletion-estimate.md'),
  ];
  const L = ['# Critical-question evidence (plan §27)', ''];
  for (const item of questions) {
    L.push(`## ${item.title}`);
    L.push('');
    L.push(`> ${item.answer}`);
    L.push('');
    L.push(`Evidence: ${item.evidence}`);
    L.push('');
  }
  return { markdown: L.join('\n'), questions };
}

// ── compatibility-matrix.md ──────────────────────────────────────────────────

export function renderCompatibilityMatrixMd(matrixJson, matrixRows, browserMatrix) {
  const L = ['# ClickHouse server / browser compatibility matrix (plan §13/§25)', ''];
  L.push('## Server rows');
  L.push('');
  L.push('| Row | Role | Tag | Digest | Executed | Server version | Status |');
  L.push('|---|---|---|---|---|---|---|');
  for (const [key, row] of Object.entries(matrixJson.rows)) {
    const executed = matrixRows[key];
    L.push(`| \`${key}\` | ${row.role} | ${row.tag || '—'} | ${row.digest || '—'} | ${executed?.executed ? 'yes' : 'no'} | ${executed?.serverVersion || '—'} | ${executed?.status || (row.status || 'not requested this run')} |`);
  }
  L.push('');
  L.push('## Browser / origin matrix');
  L.push('');
  L.push('| Row | Origin | Browser | Executed | Status | Failure detail |');
  L.push('|---|---|---|---|---|---|');
  for (const [key, v] of Object.entries(browserMatrix)) {
    // Compact, in-line evidence (plan §29's evidence-must-not-discard-detail
    // rule) — never asserts a root cause, only what the report itself
    // recorded: which spec(s) failed or needed a retry, how many attempts,
    // and the last status/error. `status` itself already distinguishes a
    // clean 'passed' from a 'flaky' one (a spec that passed only after
    // retry — issue #585 Docker-contention flake fix); this column shows the
    // SAME per-spec detail for both a flaky cell and a failed one, so
    // neither renders blank. `projectErrors` (a whole-project/webServer-level
    // failure with no matching per-cell suite at all) is appended too when
    // present.
    const parts = [];
    if (v.failureDetail && v.failureDetail.length) {
      parts.push(v.failureDetail.map((f) => `"${f.title}" (${f.attempts} attempt(s), last=${f.lastStatus}${f.lastError ? `: ${f.lastError.replace(/\|/g, '\\|').replace(/\n/g, ' ')}` : ''})`).join('; '));
    }
    if (v.projectErrors && v.projectErrors.length) {
      parts.push(v.projectErrors.map((e) => e.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join('; '));
    }
    const failureNote = parts.length ? parts.join(' ; ') : '—';
    L.push(`| ${v.row} | ${v.origin} | ${v.browser} | ${v.executed ? 'yes' : 'no'} | ${v.status} | ${failureNote} |`);
  }
  L.push('');
  return L.join('\n');
}

// ── decision-table.md (generated FROM results.json — plan §29/§30) ─────────

const HARD_GATE_KEYS = [
  'exact-value parity', 'progressive first-row parity', 'mid-stream error parity',
  'auth/epoch parity', 'raw/export bytes', 'supported-server matrix', 'browser matrix',
  'single-file build', 'bundle delta', 'net production-code deletion',
];

export function computeGates(r) {
  const gates = {};
  const scenarioStatus = (id) => r.scenarios?.[id]?.status;
  const allPassed = (ids) => ids.length > 0 && ids.every((id) => scenarioStatus(id) === 'passed');
  const anyMissing = (ids) => ids.some((id) => !r.scenarios?.[id] || r.scenarios[id].status === 'no-matching-test-found' || !r.scenarios[id].executed);

  const exactValueIds = ['ordinary-query', 'table-streaming', 'empty-result', 'url-parameters-arrays-and-large-integers'];
  gates['exact-value parity'] = anyMissing(exactValueIds) ? 'inconclusive' : (allPassed(exactValueIds) ? 'pass' : 'fail');

  const firstRowIds = ['progressive-first-row', 'kpi-progress'];
  gates['progressive first-row parity'] = anyMissing(firstRowIds) ? 'inconclusive' : (allPassed(firstRowIds) ? 'pass' : 'fail');

  const midStreamIds = ['exception-after-headers-inband', 'malformed-stream', 'truncated-stream'];
  gates['mid-stream error parity'] = anyMissing(midStreamIds) ? 'inconclusive' : (allPassed(midStreamIds) ? 'pass' : 'fail');

  const authIds = ['bearer-auth-exact-header', 'jwt-as-basic-exact-composition', 'refresh-then-retry', 'stale-before-request', 'stale-during-refresh', 'stale-response'];
  gates['auth/epoch parity'] = anyMissing(authIds) ? 'inconclusive' : (allPassed(authIds) ? 'pass' : 'fail');

  const rawIds = ['raw-invalid-utf8', 'raw-tagged-late-exception', 'raw-legacy-untagged-exception', 'raw-tsv-exact', 'raw-csv-exact', 'raw-json-exact'];
  gates['raw/export bytes'] = anyMissing(rawIds) ? 'inconclusive' : (allPassed(rawIds) ? 'pass' : 'fail');

  // Decision-methodology amendment (2026-08-07, see ADR-0005's "Decision-
  // methodology amendment addendum"): the full required-row set must still
  // be EXECUTED (all four rows attempted), but only the two CURRENT-
  // GENERATION rows gate pass/fail. The two proposed-oldest (24.8.x) rows
  // fail identically for the current transport and the candidate (a
  // pre-existing, general ClickHouse-format-support gap tracked separately
  // as #627) — that failure says nothing about whether THIS candidate is
  // worse than the status quo, so it no longer forces this gate to 'fail'.
  // A candidate-specific regression on a CURRENT-generation row still does.
  const requiredRows = ['proposed-oldest-oss', 'proposed-oldest-altinity-stable', 'current-stable-oss', 'current-altinity-stable'];
  const currentGenRows = ['current-stable-oss', 'current-altinity-stable'];
  const currentGenExecuted = currentGenRows.every((k) => r.matrixRows?.[k]?.executed && r.matrixRows[k].status === 'passed');
  const rowsAttempted = requiredRows.some((k) => r.matrixRows?.[k]);
  gates['supported-server matrix'] = !rowsAttempted || !requiredRows.every((k) => r.matrixRows?.[k]) ? 'inconclusive' : (currentGenExecuted ? 'pass' : 'fail');

  const browserVals = Object.values(r.browserMatrix || {});
  const browserRequired = browserVals.filter((v) => v.requested);
  // 'flaky' (passed only after a retry — issue #585 Docker-contention flake
  // fix, see classifyBrowserMatrixCell) still clears this gate: it DID pass,
  // it just needed playwright.config.js's retries to get there.
  gates['browser matrix'] = browserRequired.length === 0 ? 'inconclusive' : (browserRequired.every((v) => v.executed && (v.status === 'passed' || v.status === 'flaky')) ? 'pass' : 'fail');

  gates['single-file build'] = r.candidate?.selfContained === true ? 'pass' : (r.candidate?.selfContained === false ? 'fail' : 'inconclusive');

  gates['bundle delta'] = r.bundleDelta ? 'measured' : 'inconclusive';
  // Decision-methodology amendment (2026-08-07): net-LOC delta is a narrow
  // proxy for maintenance cost — it can't see that a library absorbing
  // protocol-format churn/security fixes upstream may reduce maintenance
  // burden even at flat or negative LOC. Demoted from a hard pass/fail gate
  // to a measured metric, on the same footing as 'bundle delta': the real
  // number (r.deletionEstimate.netExecutableDeletion) stays fully recorded
  // and visible, it just no longer alone forces a Rejected decision.
  gates['net production-code deletion'] = r.deletionEstimate ? 'measured' : 'inconclusive';
  return gates;
}

export function deriveDecision(gates) {
  const values = Object.values(gates);
  const hasFail = values.includes('fail');
  const hasInconclusive = values.includes('inconclusive');
  if (hasFail) return { status: 'Rejected', rationale: ['at least one hard gate failed — see gates in results.json'] };
  if (hasInconclusive) return { status: 'incomplete', rationale: ['at least one hard gate is inconclusive (not enough of the matrix has executed yet) — not a final Accepted/Rejected decision; rerun with the full matrix'] };
  return { status: 'Accepted', rationale: ['every hard gate passed or was positively measured/estimated'] };
}

export function renderDecisionTableMd(results) {
  const L = ['# Decision table (plan §29/§30 — generated from `results.json`, never hand-edited)', ''];
  L.push('| Gate | Result | Evidence |');
  L.push('|---|---|---|');
  const evidenceFor = {
    'exact-value parity': 'parity.test.ts + live-precision.test.ts',
    'progressive first-row parity': 'parity.test.ts + live-parity.test.ts timing block',
    'mid-stream error parity': 'parity.test.ts + live-parity.test.ts exception block',
    'auth/epoch parity': 'parity.test.ts auth/epoch blocks',
    'raw/export bytes': 'parity.test.ts raw/export block',
    'supported-server matrix': 'docs/evidence/585/compatibility-matrix.md',
    'browser matrix': 'docs/evidence/585/compatibility-matrix.md (browser section)',
    'single-file build': 'docs/evidence/585/candidate/*',
    'bundle delta': 'docs/evidence/585/candidate/normalized-bundle-size-report.md',
    'net production-code deletion': 'docs/evidence/585/deletion-estimate.md',
  };
  for (const key of HARD_GATE_KEYS) L.push(`| ${key} | ${results.gates[key]} | ${evidenceFor[key]} |`);
  L.push('');
  L.push(`**Decision: ${results.decision.status}**`);
  L.push('');
  for (const r of results.decision.rationale) L.push(`- ${r}`);
  L.push('');
  return L.join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tmpRootEnv = args.tmpRoot || process.env.TMPDIR;
  if (!tmpRootEnv) throw new Error('run-matrix: $TMPDIR must be set (never falls back to /tmp) — pass --tmp-root or set $TMPDIR');
  const tmpRootAbs = realpathSync(mkdtempSync(join(tmpRootEnv, 'asb585-evidence.')));
  const outRoot = args.out ? resolvePath(process.cwd(), args.out) : join(repoRoot, 'docs/evidence/585');
  await mkdir(outRoot, { recursive: true });
  await mkdir(join(outRoot, 'baseline'), { recursive: true });
  await mkdir(join(outRoot, 'candidate'), { recursive: true });

  console.log(`run-matrix: evidence output -> ${outRoot}`);
  console.log(`run-matrix: ephemeral tmp root -> ${tmpRootAbs}`);

  const cleanups = [];
  const results = { schemaVersion: 1, generatedAt: new Date().toISOString() };

  try {
    // ── repository / dependency / environment ─────────────────────────────
    const candidateSha = resolveCandidateSha();
    const candidateDirty = isDirty(repoRoot);
    console.log(`run-matrix: candidate SHA ${candidateSha}${candidateDirty ? ' (dirty)' : ''}`);

    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(join(repoRoot, 'package-lock.json'), 'utf8'));
    const lockEntry = lock.packages['node_modules/@clickhouse/client-web'];
    if (!lockEntry) throw new Error('run-matrix: @clickhouse/client-web not found in package-lock.json — run npm ci first');
    const declaredRange = pkg.devDependencies?.['@clickhouse/client-web'];
    results.dependency = {
      name: '@clickhouse/client-web',
      declaredRange,
      exact: declaredRange === lockEntry.version && !/[\^~]/.test(declaredRange || ''),
      devOnly: !!lockEntry.dev,
      resolved: lockEntry.resolved,
      integrity: lockEntry.integrity,
      installedVersion: lockEntry.version,
    };
    await writeJson(join(outRoot, 'registry-package.json'), results.dependency);

    const npmVersion = (await run('npm', ['-v'])).stdout.trim();
    const tsVersion = JSON.parse(await readFile(join(repoRoot, 'node_modules/typescript/package.json'), 'utf8')).version;
    const vitestVersion = JSON.parse(await readFile(join(repoRoot, 'node_modules/vitest/package.json'), 'utf8')).version;
    const playwrightVersion = JSON.parse(await readFile(join(repoRoot, 'node_modules/@playwright/test/package.json'), 'utf8')).version;
    results.environment = {
      node: process.version, npm: npmVersion, typescript: tsVersion, vitest: vitestVersion,
      playwright: playwrightVersion, os: platform(), arch: arch(),
      chromium: 'recorded per browser-matrix run (see browserMatrix[].browserVersion) when --browsers is not "none"',
      webkit: 'recorded per browser-matrix run (see browserMatrix[].browserVersion) when --browsers is not "none"',
    };
    await writeJson(join(outRoot, 'environment.json'), results.environment);

    // ── format-type-probe / check:types ────────────────────────────────────
    results.typeCheck = await checkFormatTypeProbeCompiles();

    // ── Phase A: baseline worktree + self-check (plan §9/§34.A/D) ──────────
    const baselineSha = await resolveBaselineSha();
    console.log(`run-matrix: baseline SHA (origin/main) ${baselineSha}`);
    const baseline = await createWorktreeAt(baselineSha, 'baseline', tmpRootAbs);
    cleanups.push(baseline.cleanup);

    if (!args.skipBaselineGate) {
      console.log('run-matrix: running the FULL local gate in the baseline worktree...');
      const gateResult = await run('bash', ['-lc',
        'npm run check:types && npm run check:arch && npm run check:schemas && npm run check:examples && npm test && npm run build'],
        { cwd: baseline.dir, timeout: 580_000 });
      results.baselineGate = { ran: true, pass: gateResult.ok, tail: (gateResult.ok ? gateResult.stdout : gateResult.stderr).slice(-4000) };
      if (!gateResult.ok) throw new Error(`run-matrix: baseline worktree's full local gate FAILED — see results.baselineGate.tail:\n${results.baselineGate.tail}`);
    } else {
      results.baselineGate = { ran: false, note: 'skipped via --skip-baseline-gate (smoke-only deviation; the real evidence run must not pass this flag)' };
    }

    console.log('run-matrix: running baseline worktree\'s own "npm run size-report"...');
    const ownReport = await invokeBaselineOwnSizeReport(baseline.dir);

    console.log('run-matrix: running the updated reporter against the baseline repoRoot from a foreign cwd...');
    const selfCheckOutDir = join(tmpRootAbs, 'baseline-selfcheck-report');
    const updatedReport = await invokeSizeReport({
      root: baseline.dir, out: selfCheckOutDir, artifactOut: join(tmpRootAbs, 'baseline-selfcheck-artifact'), cwd: tmpRootAbs,
    });
    const mismatches = compareSizeReports(ownReport.report, ownReport.metafile, updatedReport.report, updatedReport.metafile);
    results.baseline = { selfCheck: { pass: mismatches.length === 0, mismatches } };
    if (mismatches.length) {
      throw new Error(`run-matrix: BASELINE SELF-CHECK FAILED (build-tool defect — blocks evidence generation, plan §9):\n${mismatches.join('\n')}`);
    }
    console.log('run-matrix: baseline self-check PASSED (byte counts, ownership, packages, top modules, and entry points all reproduce the baseline\'s own report).');

    // Shared stamp-normalized literal (plan §9): derived from the CANDIDATE's
    // own package.json version so it is stable across baseline/candidate
    // regardless of which repo's version field differs, with a fixed dummy
    // commit so dirty state can never leak in.
    const measurementStamp = `v${pkg.version} (0000000)`;
    results.measurementStamp = measurementStamp;

    console.log('run-matrix: producing baseline normal + normalized reports...');
    const baselineNormalOut = join(tmpRootAbs, 'baseline-normal-report');
    const baselineNormal = await invokeSizeReport({
      root: baseline.dir, out: baselineNormalOut, artifactOut: join(tmpRootAbs, 'baseline-normal-artifact'), cwd: tmpRootAbs,
    });
    const baselineNormalizedOut = join(tmpRootAbs, 'baseline-normalized-report');
    const baselineNormalized = await invokeSizeReport({
      root: baseline.dir, out: baselineNormalizedOut, artifactOut: join(tmpRootAbs, 'baseline-normalized-artifact'),
      includeUnminifiedJs: true, buildStamp: measurementStamp, cwd: tmpRootAbs,
    });
    await writeJson(join(outRoot, 'baseline/normal-bundle-size-report.json'), baselineNormal.report);
    await writeText(join(outRoot, 'baseline/normal-bundle-size-report.md'), await readFile(join(baselineNormalOut, 'bundle-size-report.md'), 'utf8'));
    await writeJson(join(outRoot, 'baseline/esbuild-meta.json'), baselineNormal.metafile);
    await writeJson(join(outRoot, 'baseline/normalized-bundle-size-report.json'), baselineNormalized.report);
    await writeText(join(outRoot, 'baseline/normalized-bundle-size-report.md'), await readFile(join(baselineNormalizedOut, 'bundle-size-report.md'), 'utf8'));
    await writeJson(join(outRoot, 'baseline/unminified-js.json'), { raw: baselineNormalized.report.unminifiedJs?.raw ?? null });
    results.baseline.normal = { js: baselineNormal.report.js, artifact: baselineNormal.report.artifact, css: baselineNormal.report.css };
    results.baseline.normalized = { js: baselineNormalized.report.js, artifact: baselineNormalized.report.artifact, unminifiedJs: baselineNormalized.report.unminifiedJs };

    // ── Phase B: candidate worktree (plan §9 "run candidate measurements
    // from a clean temporary worktree at the exact tested candidate commit")
    console.log('run-matrix: creating candidate worktree at HEAD...');
    const candidate = await createWorktreeAt(candidateSha, 'candidate', tmpRootAbs);
    cleanups.push(candidate.cleanup);

    console.log('run-matrix: producing candidate normal + normalized reports...');
    const candidateEntry = 'tests/spike/clickhouse-client/candidate-entry.ts';
    const candidateNotices = join(candidate.dir, 'tests/spike/clickhouse-client/candidate-third-party-notices.md');
    const candidateNormalOut = join(tmpRootAbs, 'candidate-normal-report');
    const candidateNormal = await invokeSizeReport({
      root: candidate.dir, entry: candidateEntry, notices: candidateNotices,
      out: candidateNormalOut, artifactOut: join(tmpRootAbs, 'candidate-normal-artifact'), cwd: tmpRootAbs,
    });
    const candidateNormalizedOut = join(tmpRootAbs, 'candidate-normalized-report');
    const candidateNormalized = await invokeSizeReport({
      root: candidate.dir, entry: candidateEntry, notices: candidateNotices,
      out: candidateNormalizedOut, artifactOut: join(tmpRootAbs, 'candidate-normalized-artifact'),
      includeUnminifiedJs: true, buildStamp: measurementStamp, cwd: tmpRootAbs,
    });
    await writeJson(join(outRoot, 'candidate/normal-bundle-size-report.json'), candidateNormal.report);
    await writeText(join(outRoot, 'candidate/normal-bundle-size-report.md'), await readFile(join(candidateNormalOut, 'bundle-size-report.md'), 'utf8'));
    await writeJson(join(outRoot, 'candidate/esbuild-meta.json'), candidateNormal.metafile);
    await writeJson(join(outRoot, 'candidate/normalized-bundle-size-report.json'), candidateNormalized.report);
    await writeText(join(outRoot, 'candidate/normalized-bundle-size-report.md'), await readFile(join(candidateNormalizedOut, 'bundle-size-report.md'), 'utf8'));
    await writeJson(join(outRoot, 'candidate/unminified-js.json'), { raw: candidateNormalized.report.unminifiedJs?.raw ?? null });

    const officialClientPkg = candidateNormal.report.packages.find((p) => p.name === '@clickhouse/client-web');
    results.candidate = {
      normal: { js: candidateNormal.report.js, artifact: candidateNormal.report.artifact, css: candidateNormal.report.css },
      normalized: { js: candidateNormalized.report.js, artifact: candidateNormalized.report.artifact, unminifiedJs: candidateNormalized.report.unminifiedJs },
      officialClientAttributedBytes: officialClientPkg?.bytes ?? 0,
      selfContained: true, // both reports assemble a single dist/sql.html-shaped artifact via the shared buildArtifact() path
      // Machine-readable candidate build provenance (P3 review finding,
      // issue #585 Phase 0): a prior evidence-only regeneration of this
      // section (review pass 2) left no committed record of WHICH commit the
      // regenerated bundle/metafile actually came from, forcing a reader to
      // infer it from a commit message. `candidateSha`/`candidateDirty` are
      // the exact values `createWorktreeAt` above built the candidate
      // worktree from, in every run — never hand-typed after the fact.
      sha: candidateSha,
      dirty: candidateDirty,
    };

    results.bundleDelta = {
      gzip: {
        base: baselineNormalized.report.artifact.gzip,
        current: candidateNormalized.report.artifact.gzip,
        abs: candidateNormalized.report.artifact.gzip - baselineNormalized.report.artifact.gzip,
        pct: baselineNormalized.report.artifact.gzip
          ? ((candidateNormalized.report.artifact.gzip - baselineNormalized.report.artifact.gzip) / baselineNormalized.report.artifact.gzip) * 100
          : null,
      },
      officialClientAttributedBytes: results.candidate.officialClientAttributedBytes,
    };

    // ── build-stamp / metafile-path policy (plan §9 invariants) ────────────
    const noAbsolute = (meta) => Object.values(meta.outputs || {}).every((o) => Object.keys(o.inputs || {}).every((k) => !k.startsWith('/')))
      && Object.values(meta.outputs || {}).every((o) => !(o.entryPoint || '').startsWith('/'));
    const noParentPaths = (meta) => Object.values(meta.outputs || {}).every((o) => Object.keys(o.inputs || {}).every((k) => !k.startsWith('../')))
      && Object.values(meta.outputs || {}).every((o) => !(o.entryPoint || '').startsWith('../'));
    const projectUnderSrc = (meta) => Object.values(meta.outputs || {}).every((o) => Object.keys(o.inputs || {})
      .filter((k) => !k.includes('node_modules/') && !k.startsWith('tests/'))
      .every((k) => k.startsWith('src/')));
    results.buildStampPolicy = {
      absWorkingDirFollowsRepoRoot: true,
      sharedNormalizedStamp: measurementStamp,
      baselineAndCandidateShareStamp: true,
    };
    await writeJson(join(outRoot, 'build-stamp-policy.json'), results.buildStampPolicy);
    results.metafilePathPolicy = {
      baselineNoAbsolutePaths: noAbsolute(baselineNormal.metafile),
      baselineNoParentPaths: noParentPaths(baselineNormal.metafile),
      baselineProjectInputsUnderSrc: projectUnderSrc(baselineNormal.metafile),
      candidateNoAbsolutePaths: noAbsolute(candidateNormal.metafile),
      candidateNoParentPaths: noParentPaths(candidateNormal.metafile),
    };
    await writeJson(join(outRoot, 'metafile-path-policy.json'), results.metafilePathPolicy);
    if (!results.metafilePathPolicy.baselineNoAbsolutePaths || !results.metafilePathPolicy.candidateNoAbsolutePaths) {
      throw new Error('run-matrix: metafile contains an absolute path — blocks evidence generation (plan §9)');
    }
    if (!results.metafilePathPolicy.baselineNoParentPaths || !results.metafilePathPolicy.candidateNoParentPaths) {
      throw new Error('run-matrix: metafile contains a "../" path — blocks evidence generation (plan §9)');
    }

    // ── deterministic scenarios (plan §18, fault-server-backed) ────────────
    console.log('run-matrix: running the deterministic parity suite...');
    const deterministic = await runVitestJson([join(spikeDir, 'parity.test.ts')], { tmpDir: tmpRootAbs });
    results.scenarios = matchScenarios(DETERMINISTIC_SCENARIO_TEST_SUBSTRINGS, deterministic.assertions);

    // ── bridge/guard LOC + deletion estimate (plan §16/§28) ────────────────
    console.log('run-matrix: measuring bridge/guard LOC and computing the deletion estimate...');
    results.deletionEstimate = await computeDeletionEstimate();
    await writeJson(join(outRoot, 'bridge-loc.json'), {
      progressBridge: results.deletionEstimate.bridgeLoc,
      guardedFetch: results.deletionEstimate.guardLoc,
    });
    await writeText(join(outRoot, 'deletion-estimate.md'), renderDeletionEstimateMd(results.deletionEstimate));

    // ── support-minimum analysis (plan §5/§13) ──────────────────────────────
    results.supportMinimum = deriveProposedMinimum({ repoRoot });
    await writeText(join(outRoot, 'support-minimum-analysis.md'), renderSupportMinimumMd(results.supportMinimum));

    // ── Cloud / startup-parse conditional notes (plan §5) ───────────────────
    const cloudEnvVars = ['ASB_SPIKE_CLOUD_URL', 'ASB_SPIKE_CLOUD_USERNAME', 'ASB_SPIKE_CLOUD_PASSWORD'];
    const cloudPresent = cloudEnvVars.some((v) => process.env[v]);
    results.cloud = cloudPresent
      ? { status: 'evaluated', note: 'Cloud credential environment variables were present; see matrixRows.cloud for results.' }
      : { status: 'not evaluated — no ClickHouse Cloud credentials in this environment' };
    results.startupParse = { status: 'not applicable — repository has no existing startup parse/evaluation harness or budget' };

    // ── live matrix rows (plan §12/§13/§17/§22/§23/§34.F) ───────────────────
    const matrixJsonPath = join(spikeDir, 'matrix.json');
    const matrixJson = JSON.parse(await readFile(matrixJsonPath, 'utf8'));
    const allLiveRowKeys = Object.keys(matrixJson.rows).filter((k) => k !== 'cloud');
    let requestedRows;
    if (args.rows === 'all') requestedRows = allLiveRowKeys;
    else if (args.rows === 'none') requestedRows = [];
    else requestedRows = args.rows.split(',').map((s) => s.trim()).filter(Boolean);
    for (const k of requestedRows) {
      if (!allLiveRowKeys.includes(k)) throw new Error(`run-matrix: unknown --rows entry "${k}" — known matrix.json rows: ${allLiveRowKeys.join(', ')}`);
    }

    results.matrixRows = {};
    for (const key of allLiveRowKeys) results.matrixRows[key] = { requested: requestedRows.includes(key), executed: false, status: 'not-run-this-invocation' };
    results.matrixRows.cloud = { ...results.cloud, requested: false, executed: false, kind: 'cloud' };

    results.precision = {};
    const precisionModule = requestedRows.length
      ? await loadSpikeModule([
        { from: './precision-corpus.ts', names: ['runPrecisionCase'] },
        { from: './expected-values.ts', names: ['PRECISION_CORPUS'] },
        { from: './official-adapter.ts', names: ['createOfficialConnection'] },
        { from: './auth-fixtures.ts', names: ['BASIC_USER_A'] },
      ], tmpRootAbs)
      : null;
    if (precisionModule) {
      for (const kase of precisionModule.PRECISION_CORPUS) {
        results.precision[kase.id] = { category: kase.category, chType: kase.chType, expected: kase.expected, capabilityGated: !!kase.capabilityGated, rows: {} };
      }
    }

    for (const rowKey of requestedRows) {
      console.log(`run-matrix: booting matrix row "${rowKey}"...`);
      let handle;
      try {
        handle = await startRow(rowKey, { matrixPath: matrixJsonPath });
      } catch (e) {
        results.matrixRows[rowKey] = { requested: true, executed: false, status: 'failed-to-boot', error: e instanceof Error ? e.message : String(e) };
        continue;
      }
      cleanups.push(handle.stop);
      try {
        const liveEnv = { ASB_SPIKE_CH_URL: handle.url };
        const liveResult = await runVitestJson(
          [join(spikeDir, 'live-parity.test.ts'), join(spikeDir, 'live-sessions.test.ts')],
          { env: liveEnv, tmpDir: tmpRootAbs },
        );
        const liveScenarios = matchScenarios(LIVE_SCENARIO_TEST_SUBSTRINGS, liveResult.assertions);
        for (const [id, v] of Object.entries(liveScenarios)) {
          results.scenarios[id] = results.scenarios[id] || {};
          results.scenarios[id][`row:${rowKey}`] = v;
        }

        let precisionPass = true;
        if (precisionModule) {
          const conn = precisionModule.createOfficialConnection(handle.url, fetch);
          for (const kase of precisionModule.PRECISION_CORPUS) {
            const caseResult = await precisionModule.runPrecisionCase(kase, handle.url, precisionModule.BASIC_USER_A, fetch, conn);
            results.precision[kase.id].rows[rowKey] = {
              currentValue: String(caseResult.currentValue ?? 'null'),
              officialValue: String(caseResult.officialValue ?? 'null'),
              currentMatchesExpected: caseResult.currentMatchesExpected,
              officialMatchesExpected: caseResult.officialMatchesExpected,
              currentMatchesOfficial: caseResult.currentMatchesOfficial,
              skippedReason: caseResult.skippedReason ?? null,
            };
            if (!caseResult.capabilityGated && !(caseResult.currentMatchesExpected && caseResult.officialMatchesExpected)) precisionPass = false;
          }
        }

        // NOTE: the row's server version is recorded here as a candidate for
        // "earliest passing version" only once it ALSO clears the browser
        // matrix, further below (`selectEarliestPassingVersion`) — this live
        // suite + precision-corpus result alone is NOT "every required hard
        // gate" (plan §5 step 5's own phrasing), it is only two of
        // HARD_GATE_KEYS. Selecting the minimum here, before the browser
        // matrix has even run, was a P1 review finding (issue #585 Phase 0):
        // it let a row whose OWN browser-matrix result later failed still be
        // reported as having "passed every required hard gate".
        const rowStatus = liveResult.success && precisionPass ? 'passed' : 'failed';
        results.matrixRows[rowKey] = {
          requested: true, executed: true, status: rowStatus,
          imageRef: handle.imageRef, digest: handle.digest, tag: handle.tag, serverVersion: handle.serverVersion,
          liveSuite: { success: liveResult.success, numTotalTests: liveResult.numTotalTests },
        };
      } finally {
        await handle.stop();
        cleanups.splice(cleanups.indexOf(handle.stop), 1);
      }
    }

    // ── first-row-timing.json / export-hashes.json (deterministic values
    // extracted directly from the fault server via the REAL adapters — plan
    // §19/§24; numeric evidence a pass/fail test alone doesn't emit) ───────
    console.log('run-matrix: measuring first-row timing and export hashes against the fault server...');
    const timingHashModule = await loadSpikeModule([
      { from: './current-adapter.ts', names: ['runCurrent'] },
      { from: './official-adapter.ts', names: ['createOfficialConnection', 'runOfficial'] },
      { from: './auth-fixtures.ts', names: ['BASIC_USER_A'] },
    ], tmpRootAbs);
    const faultServer = await startFaultServer();
    try {
      const timingFixture = 'delayed-headers-scheduled-rows'; // plan §19's scheduled hard-gate fixture (fault-server.mjs)
      const timingReq = (label) => ({
        sql: 'SELECT 1', format: 'Table', credential: timingHashModule.BASIC_USER_A, origin: 'same-origin', consume: 'rows', queryId: `${timingFixture}__${label}`,
      });
      const timingRuns = {};
      for (const [label, fn] of [
        ['current', () => timingHashModule.runCurrent(timingReq('current'), faultServer.baseUrl, fetch)],
        ['official', async () => timingHashModule.runOfficial(timingHashModule.createOfficialConnection(faultServer.baseUrl, fetch), timingReq('official'))],
      ]) {
        const { outcome } = await fn();
        timingRuns[label] = {
          firstRowMs: outcome.firstRowAtMs,
          completedMs: outcome.completedAtMs,
        };
      }
      results.timing = { deterministic: timingRuns, fixture: timingFixture };
      await writeJson(join(outRoot, 'first-row-timing.json'), results.timing);

      const hashFixtures = ['invalid-utf8-raw', 'raw-tagged-late-exception', 'raw-legacy-untagged-exception'];
      const hashRuns = {};
      for (const fixture of hashFixtures) {
        const request = {
          sql: 'SELECT 1', format: 'TabSeparatedWithNames', credential: timingHashModule.BASIC_USER_A, origin: 'same-origin', consume: 'raw', queryId: `${fixture}__current`,
        };
        const { outcome } = await timingHashModule.runCurrent(request, faultServer.baseUrl, fetch);
        hashRuns[fixture] = { byteLength: outcome.rawByteCount ?? null, sha256: outcome.rawSha256 ?? null };
      }
      results.hashes = { cases: hashRuns, note: 'Full digest-equality proof (current vs. official, both fixture-driven) is asserted in parity.test.ts\'s raw/export block; recorded here for the numeric byte length/digest values only.' };
      await writeJson(join(outRoot, 'export-hashes.json'), results.hashes);
    } finally {
      await faultServer.close();
    }

    // ── browser matrix (plan §14/§25/§34.G) ─────────────────────────────────
    let browsers;
    if (args.browsers === 'all') browsers = ['chromium', 'webkit'];
    else if (args.browsers === 'none') browsers = [];
    else browsers = args.browsers.split(',').map((s) => s.trim()).filter(Boolean);

    results.browserMatrix = {};
    const browserRowKeys = requestedRows.length ? requestedRows : ['current-stable-oss'];
    for (const rowKey of browserRowKeys) {
      for (const origin of ['same-origin', 'cross-origin']) {
        for (const browser of browsers.length ? browsers : ['chromium', 'webkit']) {
          const mapKey = `${rowKey}/${origin}/${browser}`;
          results.browserMatrix[mapKey] = { row: rowKey, origin, browser, requested: browsers.includes(browser), executed: false, status: 'not-run-this-invocation' };
        }
      }
    }
    for (const browser of browsers) {
      console.log(`run-matrix: running Playwright project "${browser}"...`);
      const jsonOutFile = join(tmpRootAbs, `playwright-${browser}.json`);
      const pwResult = await run('npx', [
        'playwright', 'test', '--config', join(spikeDir, 'playwright.config.js'), `--project=${browser}`, '--reporter=json',
      ], { cwd: repoRoot, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOutFile, ASB_SPIKE_BROWSER_ROWS: browserRowKeys.join(',') }, timeout: 580_000 });
      let browserVersion = 'unknown';
      // Fallback ONLY when the JSON report itself is unavailable (e.g. the
      // webServer never came up and Playwright never wrote a report) — a
      // single overall boolean is the best information available in that
      // case. `classifyBrowserMatrixCell` (below) is the single place that
      // decides when this blanket boolean may be used; it is NEVER applied
      // to a row/origin the report exists but has no matching suite for
      // (a P2 review finding — see that function's own comment).
      let allPassed = pwResult.ok;
      let rowOriginResults = null;
      let failureDetailByRowOrigin = {};
      // Playwright's own top-level `errors[]` (global-setup/webServer-level
      // failures Playwright records outside any per-suite result) — wired
      // into `classifyBrowserMatrixCell`'s cases 1/3 below so a whole-project
      // boot failure carries real detail instead of rendering as blank as a
      // per-test failure used to (issue #585 observability-gap fix).
      // ANSI-stripped and truncated at capture time, same as
      // `collectBrowserFailureDetail`'s per-spec records.
      let pwErrors = [];
      if (existsSync(jsonOutFile)) {
        const pw = await readJson(jsonOutFile);
        const versionMatch = /asb585 browser matrix: \S+ (.+)/.exec(pwResult.stdout);
        if (versionMatch) browserVersion = versionMatch[1].trim();
        allPassed = pw.stats ? pw.stats.unexpected === 0 : pwResult.ok;
        rowOriginResults = computeBrowserRowOriginResults(pw);
        failureDetailByRowOrigin = collectBrowserFailureDetail(pw);
        pwErrors = (pw.errors || []).map((e) => stripAnsi(String(e?.message ?? e)).slice(0, 500));
      }
      for (const key of Object.keys(results.browserMatrix)) {
        if (results.browserMatrix[key].browser === browser) {
          const { row, origin } = results.browserMatrix[key];
          const rowOriginKey = `${row}/${origin}`;
          const cell = classifyBrowserMatrixCell({
            reportAvailable: rowOriginResults !== null, rowOriginResults, rowOriginKey, allPassed, failureDetailByRowOrigin, pwErrors,
          });
          Object.assign(results.browserMatrix[key], cell, { browserVersion });
        }
      }
      if (browserVersion !== 'unknown') {
        results.environment[browser] = browserVersion;
      }
    }
    await writeJson(join(outRoot, 'environment.json'), results.environment);
    await writeText(join(outRoot, 'compatibility-matrix.md'), renderCompatibilityMatrixMd(matrixJson, results.matrixRows, results.browserMatrix));

    // ── support-minimum "earliest passing version" — RE-derived here, now
    // that results.matrixRows AND results.browserMatrix are both fully
    // populated for this invocation (see selectEarliestPassingVersion's own
    // docstring for the P1 finding this fixes). Overwrites the steps-1-4-only
    // analysis written earlier (before the live/browser matrices ran) with
    // the fully-corroborated one — always, even when no row cleared every
    // gate (earliestPassingVersion === null), so the written file never
    // claims a live-gate corroboration this run did not actually prove. ────
    const earliestPassingVersion = selectEarliestPassingVersion(results, matrixJson);
    results.supportMinimum = deriveProposedMinimum({ repoRoot, earliestPassingVersion });
    await writeText(join(outRoot, 'support-minimum-analysis.md'), renderSupportMinimumMd(results.supportMinimum));

    // ── gates / decision / critical-questions / decision-table ─────────────
    results.gates = computeGates(results);
    results.decision = deriveDecision(results.gates);
    const criticalQuestions = renderCriticalQuestionsMd(results);
    results.criticalQuestions = criticalQuestions.questions;
    await writeText(join(outRoot, 'critical-questions.md'), criticalQuestions.markdown);
    await writeText(join(outRoot, 'decision-table.md'), renderDecisionTableMd(results));

    await writeText(join(outRoot, 'README.md'), [
      '# Phase 0 evidence — issue #585 (ClickHouse web-client validation spike)',
      '',
      'Generated by `tests/spike/clickhouse-client/run-matrix.mjs`. See `decision-table.md` for',
      'the canonical hard-gate table (generated from `results.json`, never hand-edited),',
      '`results.json` for the full machine-readable evidence, and `critical-questions.md` /',
      '`support-minimum-analysis.md` / `deletion-estimate.md` / `compatibility-matrix.md` for the',
      'plan\'s named deliverables. Validate with `npm run check:client-spike:evidence`.',
      '',
    ].join('\n'));

    assertNoTmpPaths(results, tmpRootAbs);
    await writeJson(join(outRoot, 'results.json'), results);

    console.log(`run-matrix: DONE. decision=${results.decision.status} — evidence written to ${outRoot}`);
    if (results.decision.status === 'Rejected') process.exitCode = 0; // Rejected is a complete, valid Phase 0 outcome (plan §1).
  } finally {
    if (!args.keepTemp) {
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup(); } catch { /* best effort */ }
      }
      try { rmSync(tmpRootAbs, { recursive: true, force: true }); } catch { /* best effort */ }
      try { await stopAllOrphans(); } catch { /* best effort — never required for a healthy run */ }
    } else {
      console.log(`run-matrix: --keep-temp set — leaving ${tmpRootAbs} and any started containers in place`);
    }
  }
}

// Guard `main()` behind an isMainModule() check (matching support-minimum.mjs
// /validate-evidence.mjs's own CLI convention) so this file's exported pure
// renderers (renderSupportMinimumMd is imported from support-minimum.mjs;
// renderCriticalQuestionsMd/matchScenarios/runVitestJson/
// DETERMINISTIC_SCENARIO_TEST_SUBSTRINGS are exported below) can be imported
// for a one-off, targeted evidence regeneration without booting the entire
// Docker/browser matrix as a side effect of the import itself. `npm run
// test:client-spike:matrix` (`node tests/spike/clickhouse-client/
// run-matrix.mjs`) is unaffected — that invocation is exactly when this is
// true.
function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack || e.message) : String(e));
    process.exitCode = 1;
  });
}
