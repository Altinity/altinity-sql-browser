// Recomputes docs/evidence/585/results.json's `gates`/`decision` fields (and
// regenerates decision-table.md from them) WITHOUT re-running the live
// Docker/browser matrix. Legitimate only when the underlying recorded FACTS
// (scenarios, matrixRows, browserMatrix, deletionEstimate, bundleDelta,
// candidate.selfContained) are unchanged and only the GATE-CLASSIFICATION
// RULE in computeGates()/deriveDecision() has been amended — e.g. the
// 2026-08-07 decision-methodology amendment (see ADR-0005's "Decision-
// methodology amendment addendum"). Re-running the full live matrix for a
// pure rule change would burn Docker/browser time to reproduce numbers that
// cannot have changed.
//
// Usage: node tests/spike/clickhouse-client/recompute-decision.mjs [--dir <evidenceDir>]

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeGates, deriveDecision, renderDecisionTableMd } from './run-matrix.mjs';

const repoRoot = resolvePath(fileURLToPath(new URL('.', import.meta.url)), '../../..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidenceDir = args.dir ? resolvePath(process.cwd(), args.dir) : join(repoRoot, 'docs/evidence/585');
  const resultsPath = join(evidenceDir, 'results.json');

  const results = JSON.parse(await readFile(resultsPath, 'utf8'));
  const previousGates = results.gates;
  const previousDecision = results.decision;

  results.gates = computeGates(results);
  results.decision = deriveDecision(results.gates);
  results.gatesMethodologyAmendment = {
    amendedAt: '2026-08-07',
    reason: [
      '"net production-code deletion" demoted from a hard pass/fail gate to a',
      'measured metric — LOC delta is a narrow proxy for maintenance cost and',
      'cannot see that a library absorbing protocol-format churn/security',
      'fixes upstream may reduce maintenance burden even at flat or negative',
      'LOC. "supported-server matrix" narrowed to gate on current-generation',
      'rows only — the two proposed-oldest (24.8.x) rows fail identically for',
      'the current transport and the candidate (tracked separately as #627),',
      'so that failure is not evidence against this candidate specifically.',
    ].join(' '),
    previousGates,
    previousDecision,
  };

  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  const decisionTablePath = join(evidenceDir, 'decision-table.md');
  const rendered = renderDecisionTableMd(results);
  await writeFile(decisionTablePath, rendered.endsWith('\n') ? rendered : `${rendered}\n`);

  console.log(`recompute-decision: ${previousDecision?.status} -> ${results.decision.status}`);
  console.log(JSON.stringify(results.gates, null, 2));
}

main();
