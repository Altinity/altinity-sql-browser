// Phase 0 / issue #585 — evidence validator. Plan §29's exhaustive failure-
// rule list, checked against the exact `results.json` shape `run-matrix.mjs`
// produces (the two files are designed together; see run-matrix.mjs's
// header for the schema this reads).
//
// Usage: node tests/spike/clickhouse-client/validate-evidence.mjs [--dir <evidenceDir>]
//   --dir <dir>   evidence root to validate, resolved against the invoking
//                 shell's cwd (default: <repoRoot>/docs/evidence/585 — the
//                 committed location). Passing a smoke-test `--out` dir from
//                 run-matrix.mjs here is exactly how the two scripts are
//                 meant to be chained.
//
// Exit code 0 with no findings = evidence is complete and self-consistent.
// Exit code 1 with a printed, itemized list otherwise. Never mutates
// anything; never prints a credential value even when reporting that one
// was found (see `CREDENTIAL_KEY_PATTERN` below — the finding names the KEY,
// never the VALUE).
//
// Kept as plain `.mjs` per plan §8 precedent. The completeness checks
// (missing scenario/matrix-row/precision-case/browser-combo) are
// deliberately reported SEPARATELY from every other check: plan §34's
// execution order runs this validator repeatedly as the matrix fills in, and
// the ADR/wiki-consistency checks (§31) are only MEANINGFUL once the matrix
// is complete — asserting them against a partial run would either force a
// premature ADR or produce a spurious failure on a legitimately-not-yet-
// pending wiki page. See `main()`'s `completenessFindings.length === 0` gate
// below.

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuildBuild } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const spikeDir = here;
const repoRoot = resolvePath(here, '../../..');

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log('Usage: node tests/spike/clickhouse-client/validate-evidence.mjs [--dir <evidenceDir>]');
}

// ── loading scenarios.ts's manifest (same dependency-free bundling trick as
// run-matrix.mjs — see there for why plain .mjs needs it to reach .ts data) ──

async function loadDeterministicScenarioIds() {
  const tmpDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'asb585-validate.'));
  try {
    const outfile = join(tmpDir, `loader-${randomBytes(6).toString('hex')}.mjs`);
    await esbuildBuild({
      stdin: { contents: "export { DETERMINISTIC_SCENARIOS } from './scenarios.ts';", resolveDir: spikeDir, loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', target: 'node22', write: true, outfile,
      absWorkingDir: repoRoot, logLevel: 'silent',
    });
    const mod = await import(pathToFileURL(outfile).href);
    return mod.DETERMINISTIC_SCENARIOS.map((s) => s.id);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function loadPrecisionCaseIds() {
  const tmpDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'asb585-validate.'));
  try {
    const outfile = join(tmpDir, `loader-${randomBytes(6).toString('hex')}.mjs`);
    await esbuildBuild({
      stdin: { contents: "export { PRECISION_CORPUS } from './expected-values.ts';", resolveDir: spikeDir, loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', target: 'node22', write: true, outfile,
      absWorkingDir: repoRoot, logLevel: 'silent',
    });
    const mod = await import(pathToFileURL(outfile).href);
    return mod.PRECISION_CORPUS.map((c) => ({ id: c.id, capabilityGated: !!c.capabilityGated }));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Live-only scenario ids (no fault-server fixture — plan §17/§22/§23) MUST
// stay in sync with run-matrix.mjs's `LIVE_SCENARIO_TEST_SUBSTRINGS` keys —
// duplicated here (not imported; each CLI stays self-contained per this
// sub-task's file-scope boundary) rather than sharing a module.
const REQUIRED_LIVE_SCENARIO_IDS = [
  'server-cancellation-kill-query', 'temporary-table-session-scoped',
  'session-set-persistence', 'session-is-locked-live-retry',
  'progressive-timing-real-server', 'mid-stream-progress-error-real-server',
];

const REQUIRED_MATRIX_ROWS = ['proposed-oldest-oss', 'proposed-oldest-altinity-stable', 'current-stable-oss', 'current-altinity-stable'];
const REQUIRED_BROWSERS = ['chromium', 'webkit'];
const REQUIRED_ORIGINS = ['same-origin', 'cross-origin'];

const HARD_GATE_KEYS = [
  'exact-value parity', 'progressive first-row parity', 'mid-stream error parity',
  'auth/epoch parity', 'raw/export bytes', 'supported-server matrix', 'browser matrix',
  'single-file build', 'bundle delta', 'net production-code deletion',
];

const PLACEHOLDER_PATTERN = /\b(TODO|TBD|FIXME|PLACEHOLDER|XXX|lorem ipsum)\b/i;
// Flags a finding by KEY name only — a finding never prints the associated
// VALUE (CLAUDE.md / this repo's global credential-hygiene rule applies to
// this validator's own output just as much as to any other command).
const CREDENTIAL_KEY_PATTERN = /password|secret|(?:^|[^a-zA-Z])token(?:[^a-zA-Z]|$)|authorization|api[-_]?key/i;
// Fields whose key legitimately matches the pattern above but whose value is
// a repository-committed, deliberately non-secret spike fixture (never a
// real credential) — see auth-fixtures.ts / clickhouse-containers.mjs.
const CREDENTIAL_KEY_ALLOWLIST = new Set(['declaredRange', 'integrity']);

function addFinding(findings, message) {
  findings.push(message);
}

// ── generic helpers ──────────────────────────────────────────────────────────

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

function get(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/** Recursively scan an object for a key matching `CREDENTIAL_KEY_PATTERN`
 * whose value is a non-empty string not on the allowlist. Returns the list
 * of dotted key PATHS (never values) found. */
function findCredentialLikeKeys(obj, pathPrefix = '') {
  const found = [];
  if (obj === null || typeof obj !== 'object') return found;
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (CREDENTIAL_KEY_PATTERN.test(key) && !CREDENTIAL_KEY_ALLOWLIST.has(key)) {
      if (typeof value === 'string' && value.length > 0) found.push(fullPath);
    }
    if (value && typeof value === 'object') found.push(...findCredentialLikeKeys(value, fullPath));
  }
  return found;
}

/** Scan one string value for a placeholder marker (plan §29 "a result is
 * unknown or placeholder text"). Returns the finding string, or null. */
function checkPlaceholderString(value, pathLabel) {
  if (typeof value !== 'string') return null;
  return PLACEHOLDER_PATTERN.test(value) ? `${pathLabel} = "${value.slice(0, 80)}"` : null;
}

/** Placeholder scanning is deliberately targeted at the specific RESULT/
 * ANSWER-shaped fields plan §29 means ("a result is unknown or placeholder
 * text") — not a blind recursive scan of the whole evidence tree. A blind
 * scan false-positives on entirely legitimate data that happens to contain
 * the substring "placeholder" as part of unrelated content (e.g. this
 * repository genuinely has a file named `tests/unit/placeholder.test.ts`,
 * which `supportMinimum.pinnedVersionScan.scanned` legitimately lists as a
 * SCANNED PATH, not a result). */
function findPlaceholderStrings(results) {
  const found = [];
  const push = (value, label) => {
    const finding = checkPlaceholderString(value, label);
    if (finding) found.push(finding);
  };
  for (const q of results.criticalQuestions || []) {
    push(q.answer, `criticalQuestions[${q.title}].answer`);
    push(q.evidence, `criticalQuestions[${q.title}].evidence`);
  }
  for (const line of results.decision?.rationale || []) push(line, 'decision.rationale[]');
  for (const line of results.supportMinimum?.rationale || []) push(line, 'supportMinimum.rationale[]');
  for (const [key, value] of Object.entries(results.gates || {})) push(value, `gates["${key}"]`);
  for (const [key, row] of Object.entries(results.matrixRows || {})) {
    push(row.status, `matrixRows["${key}"].status`);
    push(row.error, `matrixRows["${key}"].error`);
  }
  for (const [id, s] of Object.entries(results.scenarios || {})) {
    if (s && typeof s === 'object' && 'status' in s) push(s.status, `scenarios["${id}"].status`);
  }
  for (const [id, kase] of Object.entries(results.precision || {})) {
    for (const [rowKey, rowEntry] of Object.entries(kase.rows || {})) {
      push(rowEntry.skippedReason, `precision["${id}"].rows["${rowKey}"].skippedReason`);
    }
  }
  return found;
}

// ── individual rule groups (each returns an array of finding strings) ──────

function checkCompleteness(results, deterministicIds, precisionCases) {
  const findings = [];

  for (const id of deterministicIds) {
    const s = results.scenarios?.[id];
    if (!s || s.executed !== true) {
      addFinding(findings, `missing scenario: deterministic scenario "${id}" has not executed (results.scenarios["${id}"] is ${s ? `present but executed=${s.executed}` : 'absent'})`);
    } else if (s.status !== 'passed') {
      addFinding(findings, `scenario "${id}" executed but did not pass (status=${s.status})`);
    }
  }

  for (const rowKey of REQUIRED_MATRIX_ROWS) {
    const row = results.matrixRows?.[rowKey];
    if (!row || row.executed !== true) {
      addFinding(findings, `missing matrix row: required row "${rowKey}" has not executed (results.matrixRows["${rowKey}"] is ${row ? `present but executed=${row.executed}` : 'absent'})`);
    } else if (row.status !== 'passed') {
      addFinding(findings, `matrix row "${rowKey}" executed but did not pass (status=${row.status})`);
    }
  }

  const executedRows = REQUIRED_MATRIX_ROWS.filter((k) => results.matrixRows?.[k]?.executed === true);
  for (const rowKey of executedRows) {
    for (const liveId of REQUIRED_LIVE_SCENARIO_IDS) {
      const entry = results.scenarios?.[liveId]?.[`row:${rowKey}`];
      if (!entry || entry.executed !== true) {
        addFinding(findings, `missing scenario: live-only scenario "${liveId}" has not executed for row "${rowKey}"`);
      } else if (entry.status !== 'passed') {
        addFinding(findings, `live-only scenario "${liveId}" for row "${rowKey}" executed but did not pass (status=${entry.status})`);
      }
    }
    for (const { id, capabilityGated } of precisionCases) {
      const caseEntry = results.precision?.[id];
      const rowEntry = caseEntry?.rows?.[rowKey];
      if (!rowEntry) {
        addFinding(findings, `missing precision case: "${id}" has no recorded result for row "${rowKey}"`);
      } else if (!capabilityGated && !rowEntry.skippedReason
        && !(rowEntry.currentMatchesExpected && rowEntry.officialMatchesExpected)) {
        addFinding(findings, `precision case "${id}" did not match the independent expectation for row "${rowKey}" (not capability-gated)`);
      } else if (capabilityGated && !rowEntry.skippedReason && !(rowEntry.currentMatchesExpected && rowEntry.officialMatchesExpected)) {
        addFinding(findings, `precision case "${id}" for row "${rowKey}" mismatched WITHOUT a recorded capability-gated skip reason (plan §29 "a precision case is absent without a capability explanation")`);
      }
    }
  }

  for (const rowKey of REQUIRED_MATRIX_ROWS) {
    for (const origin of REQUIRED_ORIGINS) {
      for (const browser of REQUIRED_BROWSERS) {
        const key = `${rowKey}/${origin}/${browser}`;
        const entry = results.browserMatrix?.[key];
        if (!entry || entry.executed !== true) {
          addFinding(findings, `missing browser-matrix row: "${key}" has not executed (results.browserMatrix["${key}"] is ${entry ? `present but executed=${entry.executed}` : 'absent'})`);
        } else if (entry.status !== 'passed') {
          addFinding(findings, `browser-matrix row "${key}" executed but did not pass (status=${entry.status})`);
        }
      }
    }
  }

  return findings;
}

function checkCriticalQuestions(results) {
  const findings = [];
  const questions = results.criticalQuestions;
  if (!Array.isArray(questions) || questions.length === 0) {
    addFinding(findings, 'critical questions: results.criticalQuestions is missing or empty (plan §27)');
    return findings;
  }
  for (const q of questions) {
    if (!q.answer || typeof q.answer !== 'string' || q.answer.trim().length === 0) {
      addFinding(findings, `critical question empty: "${q.title}" has no recorded answer`);
    }
    if (!q.evidence || typeof q.evidence !== 'string' || q.evidence.trim().length === 0) {
      addFinding(findings, `critical question missing evidence citation: "${q.title}"`);
    }
  }
  return findings;
}

function checkGateConsistency(results) {
  const findings = [];
  const gates = results.gates;
  const decision = results.decision;
  if (!gates || !decision) {
    addFinding(findings, 'gates/decision: results.gates or results.decision is missing');
    return findings;
  }
  for (const key of HARD_GATE_KEYS) {
    if (gates[key] === undefined) addFinding(findings, `hard gate table incomplete: "${key}" is missing from results.gates`);
  }
  const values = Object.values(gates);
  const hasFail = values.includes('fail');
  const hasInconclusive = values.includes('inconclusive');
  if (decision.status === 'Accepted' && (hasFail || hasInconclusive)) {
    addFinding(findings, `Accepted decision with a failed or inconclusive hard gate: ${JSON.stringify(gates)} (plan §29 "Accepted has a failed or inconclusive hard gate")`);
  }
  if (decision.status === 'Rejected' && !hasFail) {
    addFinding(findings, 'Rejected decision but results.gates lists no failed gate (plan §29 "Rejected omits failed gates")');
  }
  return findings;
}

function checkStampAndBuildInvariants(results) {
  const findings = [];
  if (!results.measurementStamp || typeof results.measurementStamp !== 'string') {
    addFinding(findings, 'measurement stamp missing: results.measurementStamp is not set');
  }
  if (results.buildStampPolicy?.baselineAndCandidateShareStamp !== true) {
    addFinding(findings, 'baseline and candidate normalized reports do not use the same explicit stamp (results.buildStampPolicy.baselineAndCandidateShareStamp is not true)');
  }
  if (results.buildStampPolicy?.absWorkingDirFollowsRepoRoot !== true) {
    addFinding(findings, 'a report was created without absWorkingDir following its repoRoot (results.buildStampPolicy.absWorkingDirFollowsRepoRoot is not true)');
  }
  const mp = results.metafilePathPolicy;
  if (!mp) {
    addFinding(findings, 'metafile path policy missing: results.metafilePathPolicy is not set');
  } else {
    if (mp.baselineNoAbsolutePaths !== true || mp.candidateNoAbsolutePaths !== true) {
      addFinding(findings, 'a relevant metafile input or entry point is absolute (results.metafilePathPolicy.*NoAbsolutePaths)');
    }
    if (mp.baselineNoParentPaths !== true || mp.candidateNoParentPaths !== true) {
      addFinding(findings, 'a relevant metafile input or entry point begins with "../" (results.metafilePathPolicy.*NoParentPaths)');
    }
    if (mp.baselineProjectInputsUnderSrc !== true) {
      addFinding(findings, 'a baseline project input that should be under src/ is classified as other (results.metafilePathPolicy.baselineProjectInputsUnderSrc is not true)');
    }
  }
  if (results.baseline?.selfCheck?.pass !== true) {
    const mismatches = results.baseline?.selfCheck?.mismatches || ['(no mismatch detail recorded)'];
    addFinding(findings, `baseline self-check did not reproduce the baseline's own report byte counts/attribution: ${mismatches.join('; ')}`);
  }
  if (!results.baseline?.normal || !results.baseline?.normalized) {
    addFinding(findings, 'baseline normal and/or normalized report is missing from results.json');
  }
  if (!results.candidate?.normal || !results.candidate?.normalized) {
    addFinding(findings, 'candidate normal and/or normalized report is missing from results.json');
  }
  if (results.baseline?.normalized?.unminifiedJs?.raw == null) {
    addFinding(findings, 'unminified evidence is absent for baseline (results.baseline.normalized.unminifiedJs.raw)');
  }
  if (results.candidate?.normalized?.unminifiedJs?.raw == null) {
    addFinding(findings, 'unminified evidence is absent for candidate (results.candidate.normalized.unminifiedJs.raw)');
  }
  return findings;
}

function checkDependencyAndPackageGraph(results, baselineNormalReport, candidateNormalReport) {
  const findings = [];
  const dep = results.dependency;
  if (!dep) {
    addFinding(findings, 'dependency evidence missing: results.dependency is not set');
  } else {
    if (!dep.exact) addFinding(findings, `dependency is not exact-pinned: declaredRange="${dep.declaredRange}"`);
    if (!dep.devOnly) addFinding(findings, 'dependency is not dev-only (results.dependency.devOnly is not true) — plan §29 "package in production graph"');
  }
  const baselinePkgs = (baselineNormalReport?.packages || []).map((p) => p.name);
  if (baselinePkgs.includes('@clickhouse/client-web')) {
    addFinding(findings, 'normal production graph contains the package: baseline/normal-bundle-size-report.json lists @clickhouse/client-web');
  }
  const candidatePkgs = (candidateNormalReport?.packages || []).map((p) => p.name);
  if (!candidatePkgs.includes('@clickhouse/client-web')) {
    addFinding(findings, 'candidate graph does NOT contain the package: candidate/normal-bundle-size-report.json is missing @clickhouse/client-web (plan §9/§26 "official package appears in candidate metafile")');
  }
  return findings;
}

function checkPlaceholdersAndCredentials(results) {
  const findings = [];
  for (const p of findPlaceholderStrings(results)) {
    addFinding(findings, `placeholder text found: results.${p}`);
  }
  for (const keyPath of findCredentialLikeKeys(results)) {
    addFinding(findings, `possible credential in evidence: results.${keyPath} (value redacted — never printed by this validator)`);
  }
  return findings;
}

async function checkDecisionTableMatchesResults(evidenceDir, results) {
  const findings = [];
  const path = join(evidenceDir, 'decision-table.md');
  if (!existsSync(path)) {
    addFinding(findings, 'decision-table.md is missing');
    return findings;
  }
  const md = readFileSync(path, 'utf8');
  for (const key of HARD_GATE_KEYS) {
    const value = results.gates?.[key];
    const rowRe = new RegExp(`\\|\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|\\s*${String(value)}\\s*\\|`);
    if (value === undefined || !rowRe.test(md)) {
      addFinding(findings, `decision-table.md diverges from results.json for gate "${key}" (expected result "${value}")`);
    }
  }
  if (!results.decision?.status || !md.includes(`Decision: ${results.decision.status}`)) {
    addFinding(findings, `decision-table.md diverges from results.json's decision status ("${results.decision?.status}")`);
  }
  return findings;
}

async function checkAdrAndWikiConsistency(results) {
  const findings = [];
  const adrPath = join(repoRoot, 'docs/ADR-0005-clickhouse-web-client.md');
  const wikiPath = join(repoRoot, '.wiki/Decisions-and-Roadmap.md');
  if (!existsSync(adrPath)) {
    // Not a failure — a complete matrix run can occur before the ADR-
    // reconciliation sub-task has landed. Nothing to cross-check yet.
    return findings;
  }
  const adrText = readFileSync(adrPath, 'utf8');
  const statusMatch = /^Status:\s*(\S+)/m.exec(adrText) || /\*\*Status\*\*:?\s*(\S+)/i.exec(adrText);
  const adrStatus = statusMatch ? statusMatch[1].replace(/[.,]$/, '') : null;
  if (!adrStatus) {
    addFinding(findings, 'ADR-0005 has no parseable "Status:" line');
  } else if (adrStatus !== results.decision?.status) {
    addFinding(findings, `ADR status ("${adrStatus}") differs from results.json's machine-readable decision ("${results.decision?.status}")`);
  }
  if (!existsSync(wikiPath)) {
    addFinding(findings, '.wiki/Decisions-and-Roadmap.md is missing');
    return findings;
  }
  const wikiText = readFileSync(wikiPath, 'utf8');
  if (!wikiText.includes('ADR-0005')) {
    addFinding(findings, 'wiki lacks a link to ADR-0005 (.wiki/Decisions-and-Roadmap.md does not mention "ADR-0005")');
  }
  const adrMentionIdx = wikiText.indexOf('ADR-0005');
  if (adrMentionIdx !== -1) {
    const windowText = wikiText.slice(Math.max(0, adrMentionIdx - 400), adrMentionIdx + 400);
    // A QUOTED "pending" (inside backticks or quotes) describing a past
    // state is fine; bare pending wording describing the CURRENT status is
    // the stale-wording failure plan §29/§31 name.
    const barePending = /(?<!["'`])\bpending\b(?!["'`])/i.test(windowText.replace(/`[^`]*`/g, '').replace(/"[^"]*"/g, ''));
    if (barePending) {
      addFinding(findings, 'wiki still describes ADR-0005 as pending (unquoted "pending" near the ADR-0005 mention in .wiki/Decisions-and-Roadmap.md)');
    }
    if (adrStatus && !windowText.includes(adrStatus)) {
      addFinding(findings, `wiki status text near the ADR-0005 mention does not include the ADR's own status ("${adrStatus}")`);
    }
  }
  return findings;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidenceDir = args.dir ? resolvePath(process.cwd(), args.dir) : join(repoRoot, 'docs/evidence/585');
  const resultsPath = join(evidenceDir, 'results.json');

  if (!existsSync(resultsPath)) {
    console.error(`validate-evidence: no results.json found at ${resultsPath} — run run-matrix.mjs first`);
    process.exitCode = 1;
    return;
  }
  const results = JSON.parse(await readFile(resultsPath, 'utf8'));

  const [deterministicIds, precisionCases, baselineNormalReport, candidateNormalReport] = await Promise.all([
    loadDeterministicScenarioIds(),
    loadPrecisionCaseIds(),
    readJsonIfExists(join(evidenceDir, 'baseline/normal-bundle-size-report.json')),
    readJsonIfExists(join(evidenceDir, 'candidate/normal-bundle-size-report.json')),
  ]);

  const completenessFindings = checkCompleteness(results, deterministicIds, precisionCases);
  const otherFindings = [
    ...checkCriticalQuestions(results),
    ...checkGateConsistency(results),
    ...checkStampAndBuildInvariants(results),
    ...checkDependencyAndPackageGraph(results, baselineNormalReport, candidateNormalReport),
    ...checkPlaceholdersAndCredentials(results),
    ...(await checkDecisionTableMatchesResults(evidenceDir, results)),
  ];

  // ADR/wiki consistency is only meaningful once the matrix has ACTUALLY
  // completed (see this file's header comment) — skip it while completeness
  // findings remain, so a partial/smoke run reports ONLY the completeness
  // gap it genuinely has, not a spurious "wiki still pending" failure for a
  // decision that hasn't really been reached yet.
  const adrFindings = completenessFindings.length === 0 ? await checkAdrAndWikiConsistency(results) : [];

  const allFindings = [...completenessFindings, ...otherFindings, ...adrFindings];

  if (allFindings.length === 0) {
    console.log(`validate-evidence: PASS — ${evidenceDir} is complete and self-consistent.`);
    return;
  }

  console.error(`validate-evidence: FAIL — ${allFindings.length} finding(s) in ${evidenceDir}:\n`);
  for (const f of allFindings) console.error(`  - ${f}`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack || e.message) : String(e));
  process.exitCode = 1;
});
