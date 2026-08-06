// Phase 0 / issue #585 — dependency, build-graph, and documentation POLICY
// gate for the `@clickhouse/client-web` validation spike (plan §8 "Tests
// that remain under tests/unit/", §9 "Candidate entry"/"Candidate notices",
// §26 "CSP and self-contained artifact", §10 "New unit/tooling test"). This
// is a NORMAL tests/unit/*.test.js module — part of the coverage-gated `npm
// test` run (though it asserts repo policy, not `src/**` behavior, so it
// sits outside the per-file coverage floor; see tests/vitest.config.ts's
// `coverage.include: ['src/**/*.{js,ts}']`). It is deliberately separate
// from tests/spike/clickhouse-client/parity.test.ts, which is a NODE-
// environment suite under its own dedicated Vitest config that `npm test`
// never discovers (plan §8 "Normal npm test intentionally does not discover
// the spike behavior suite").
//
// Five responsibilities, matching this sub-task's description:
//   1. the dependency is exact-pinned and dev-only (manifest + lockfile);
//   2. a normal production build's metafile excludes the package;
//   3. a measurement-only CANDIDATE build's metafile includes it, producing
//      one self-contained HTML artifact under $TMPDIR;
//   4. no file under tests/spike/clickhouse-client imports a CDN/remote URL;
//   5. docs/ADR-0005-clickhouse-web-client.md and
//      .wiki/Decisions-and-Roadmap.md never disagree — fail-closed in both
//      directions (ADR exists vs. does not exist yet).

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../../build/build.mjs';
import {
  checkCompleteness, REQUIRED_MATRIX_ROWS, REQUIRED_LIVE_SCENARIO_IDS, REQUIRED_ORIGINS, REQUIRED_BROWSERS,
} from '../spike/clickhouse-client/validate-evidence.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SPIKE_DIR = resolve(projectRoot, 'tests/spike/clickhouse-client');
const CANDIDATE_ENTRY = 'tests/spike/clickhouse-client/candidate-entry.ts';
const CANDIDATE_NOTICES_PATH = resolve(SPIKE_DIR, 'candidate-third-party-notices.md');
const ADR_PATH = resolve(projectRoot, 'docs/ADR-0005-clickhouse-web-client.md');
const WIKI_PATH = resolve(projectRoot, '.wiki/Decisions-and-Roadmap.md');
const PACKAGE_INPUT_RE = /^node_modules\/@clickhouse\/client-web\//;

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('@clickhouse/client-web dependency policy', () => {
  it('is pinned to the exact version 1.23.1 as a dev-only dependency in package.json', async () => {
    const pkg = await readJson(resolve(projectRoot, 'package.json'));
    expect(pkg.devDependencies['@clickhouse/client-web']).toBe('1.23.1');
    // Exact, no range operator (^, ~, >=, etc.) — a caret/range would still
    // satisfy a `.toBe('1.23.1')` check on the RESOLVED version below, so
    // this checks the manifest's own literal string too.
    expect(pkg.devDependencies['@clickhouse/client-web']).not.toMatch(/[\^~*<>]/);
    expect(pkg.dependencies).not.toHaveProperty('@clickhouse/client-web');
  });

  it('resolves to exactly 1.23.1 as a dev dependency in the committed lockfile', async () => {
    const lock = await readJson(resolve(projectRoot, 'package-lock.json'));
    const key = Object.keys(lock.packages)
      .find((k) => k.endsWith('node_modules/@clickhouse/client-web'));
    expect(key).toBeDefined();
    expect(lock.packages[key].version).toBe('1.23.1');
    expect(lock.packages[key].dev).toBe(true);
  });
});

// Normal `npm run build`/`npm run size-report` always call buildArtifact()
// with its DEFAULT entryPoint (`<repoRoot>/src/main.ts`) — the same default
// every other production-facing caller uses. This is the exact call shape
// `npm run build` makes; a real esbuild bundle of the whole production graph.
describe('normal production build graph', () => {
  it('excludes @clickhouse/client-web from the metafile', async () => {
    const { metafile } = await buildArtifact({ metafile: true });
    const inputPaths = Object.keys(metafile.inputs);
    expect(inputPaths.some((p) => PACKAGE_INPUT_RE.test(p))).toBe(false);
    // Sanity: the metafile is non-trivial and correctly repository-relative
    // (build-tooling sub-task's own invariant), so an empty/misrooted
    // metafile can't vacuously pass the assertion above.
    expect(inputPaths).toContain('src/main.ts');
    for (const p of inputPaths) {
      expect(p.startsWith('/')).toBe(false);
      expect(p.startsWith('../')).toBe(false);
    }
  }, 60_000);
});

// A measurement-only candidate build (plan §9 "Candidate entry"/"Candidate
// notices") using the exact build-tooling options a real Phase 0 evidence
// run would use: entryPoint = candidate-entry.ts, additionalNotices = the
// candidate notices fragment, output written under $TMPDIR (never into this
// repository's own dist/).
describe('candidate build graph', () => {
  it('includes @clickhouse/client-web and produces one self-contained HTML artifact', async () => {
    const additionalNotices = await readFile(CANDIDATE_NOTICES_PATH, 'utf8');
    const { html, metafile } = await buildArtifact({
      entryPoint: CANDIDATE_ENTRY,
      metafile: true,
      additionalNotices,
    });

    const inputPaths = Object.keys(metafile.inputs);
    const packageInputs = inputPaths.filter((p) => PACKAGE_INPUT_RE.test(p));
    expect(packageInputs.length).toBeGreaterThan(0);
    // Repository-relative, same invariant as the normal-build case above —
    // a candidate build must not silently escape absWorkingDir either.
    for (const p of inputPaths) {
      expect(p.startsWith('/')).toBe(false);
      expect(p.startsWith('../')).toBe(false);
    }
    // The candidate entry point itself is part of the graph, alongside the
    // real production entry it imports.
    expect(inputPaths).toContain(CANDIDATE_ENTRY);
    expect(inputPaths).toContain('src/main.ts');

    // The candidate-only notice fragment reached the assembled artifact...
    expect(html).toContain('ClickHouse, Inc.');
    expect(html).toContain('Apache License');
    // ...but never the normal production artifact.
    const normal = await buildArtifact({});
    expect(normal.html).not.toContain('ClickHouse, Inc.');

    // Write the artifact to disk under $TMPDIR to prove it really is one
    // self-contained HTML file (no external <script src>, matching every
    // other build/build.mjs artifact's template) — not just an in-memory
    // string that happens to look right.
    const outDir = await mkdtemp(join(tmpdir(), 'asb-candidate-'));
    try {
      const outFile = join(outDir, 'candidate.html');
      await writeFile(outFile, html);
      const written = await readFile(outFile, 'utf8');
      expect(written).toBe(html);
      expect(written).not.toMatch(/<script[^>]*\ssrc\s*=/i);
      expect(written).not.toMatch(/<link[^>]*\shref\s*=\s*["'](https?:)?\/\//i);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// Recursively collect spike source files (not the .md notices/README — this
// check is about IMPORTS in code, not license/doc text, which legitimately
// contains an https:// URL to the Apache license itself).
async function collectSpikeSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSpikeSourceFiles(full));
    } else if (['.ts', '.js', '.mjs', '.html'].includes(extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

// Import specifiers / dynamic imports / <script src> pointing at a remote
// URL (absolute http(s):// or protocol-relative //). Deliberately does NOT
// flag a bare "http://" substring anywhere in a file — fault-server.mjs
// legitimately constructs loopback URL STRINGS like `http://127.0.0.1:${port}`
// for its own local server; those are runtime string values, not import
// specifiers, and must not trip this check.
const CDN_IMPORT_PATTERNS = [
  /\bfrom\s+['"](?:https?:)?\/\//,
  /\bimport\(\s*['"](?:https?:)?\/\//,
  /<script[^>]*\ssrc\s*=\s*["'](?:https?:)?\/\//i,
];

describe('no CDN or remote-URL import in spike sources', () => {
  it('scans every tests/spike/clickhouse-client source file for a CDN/remote import', async () => {
    const files = await collectSpikeSourceFiles(SPIKE_DIR);
    expect(files.length).toBeGreaterThan(0);
    const offenders = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const pattern of CDN_IMPORT_PATTERNS) {
        if (pattern.test(text)) offenders.push(`${relative(projectRoot, file)}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Plan §31 "Wiki reconciliation": "The evidence validator and normal unit
// test must reject a mismatch among: ADR Status; machine-readable decision;
// wiki status text; wiki ADR link." This sub-task only owns the normal-
// unit-test half. It must FAIL CLOSED in both directions:
//   * once docs/ADR-0005-clickhouse-web-client.md exists, its Status must
//     match the wiki's wording, and the wiki must link the ADR file;
//   * until it exists, the wiki must not claim a settled Accepted/Rejected
//     decision.
//
// "Claims a settled decision" is detected as an UNQUOTED occurrence of
// "Accepted" or "Rejected" near an ADR-0005/#585 mention — today's wiki
// wording deliberately quotes the hypothetical ('a "Rejected" outcome still
// completes the phase'), which is NOT a settled claim and must not trip this
// check; a future ADR reconciliation stating the real status will use the
// word unquoted, exactly like ADR-0004's own `**Status:** Accepted — ...`
// line in docs/ADR-0004-ui-shell.md.
function statusMentionsNear(text, marker, radius = 400) {
  const mentions = [];
  const markerRe = new RegExp(marker, 'g');
  let m;
  while ((m = markerRe.exec(text))) {
    const start = Math.max(0, m.index - radius);
    const end = Math.min(text.length, m.index + radius);
    mentions.push(text.slice(start, end));
  }
  return mentions;
}

function unquotedStatusWords(excerpt) {
  const found = new Set();
  for (const status of ['Accepted', 'Rejected']) {
    const re = new RegExp(`(^|[^"])\\b${status}\\b([^"]|$)`);
    if (re.test(excerpt)) found.add(status);
  }
  return found;
}

describe('ADR-0005 / wiki consistency (fail-closed)', () => {
  it('keeps the ADR Status and the wiki wording in sync, in whichever state currently exists', async () => {
    const wiki = await readFile(WIKI_PATH, 'utf8');
    const excerpts = [
      ...statusMentionsNear(wiki, 'ADR-0005'),
      ...statusMentionsNear(wiki, '#585'),
    ];
    let adrExists = true;
    let adrText;
    try {
      adrText = await readFile(ADR_PATH, 'utf8');
    } catch {
      adrExists = false;
    }

    if (!adrExists) {
      // No settled decision may be claimed yet. Every excerpt around an
      // ADR-0005/#585 mention must contain no UNQUOTED "Accepted"/"Rejected".
      for (const excerpt of excerpts) {
        expect([...unquotedStatusWords(excerpt)]).toEqual([]);
      }
      return;
    }

    const statusMatch = adrText.match(/Status:\*{0,2}\s*(Accepted|Rejected)\b/);
    expect(statusMatch, 'docs/ADR-0005-clickhouse-web-client.md must declare Status: Accepted or Rejected').not.toBeNull();
    const status = statusMatch[1];

    // The wiki must link the ADR file itself.
    expect(wiki).toContain('docs/ADR-0005-clickhouse-web-client.md');

    // At least one excerpt around an ADR-0005/#585 mention must contain the
    // SAME status word, unquoted, and none may contain the OPPOSITE status
    // word unquoted.
    const opposite = status === 'Accepted' ? 'Rejected' : 'Accepted';
    const foundMatchingStatus = excerpts.some((excerpt) => unquotedStatusWords(excerpt).has(status));
    const foundOppositeStatus = excerpts.some((excerpt) => unquotedStatusWords(excerpt).has(opposite));
    expect(foundMatchingStatus, `wiki must state the ADR's actual status (${status}) near an ADR-0005/#585 mention`).toBe(true);
    expect(foundOppositeStatus, `wiki must not claim the opposite status (${opposite})`).toBe(false);
  });
});

describe('evidence completeness distinguishes "never ran" from "ran and legitimately failed"', () => {
  // Reproduces the exact real shape found on issue #585 Phase 0: every
  // required row/scenario/case/browser-combo EXECUTED, but the two
  // proposed-oldest server rows genuinely fail (a real, evidenced ClickHouse
  // 24.8.x incompatibility, not incompleteness). A fully-complete run that
  // reaches a correctly-evidenced Rejected decision keeps reporting these
  // findings forever -- that must not be conflated with "the matrix run
  // itself is unfinished," or the ADR/wiki cross-check (gated on this
  // function's completeness signal in validate-evidence.mjs's main()) would
  // never run for exactly the scenario it exists to protect.
  function fullyExecutedResults({ oldRowsPass }) {
    const results = { matrixRows: {}, scenarios: {}, precision: {}, browserMatrix: {} };
    for (const rowKey of REQUIRED_MATRIX_ROWS) {
      const isOldRow = rowKey.startsWith('proposed-oldest');
      const passed = isOldRow ? oldRowsPass : true;
      results.matrixRows[rowKey] = { executed: true, status: passed ? 'passed' : 'failed' };
      for (const liveId of REQUIRED_LIVE_SCENARIO_IDS) {
        results.scenarios[liveId] ??= {};
        results.scenarios[liveId][`row:${rowKey}`] = { executed: true, status: passed ? 'passed' : 'failed' };
      }
      for (const origin of REQUIRED_ORIGINS) {
        for (const browser of REQUIRED_BROWSERS) {
          results.browserMatrix[`${rowKey}/${origin}/${browser}`] = { executed: true, status: 'passed' };
        }
      }
    }
    return results;
  }

  it('reports zero missingCount for a fully-executed run even when some rows legitimately fail', () => {
    const results = fullyExecutedResults({ oldRowsPass: false });
    const findings = checkCompleteness(results, [], []);
    expect(findings.missingCount).toBe(0);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.includes('proposed-oldest-oss') && f.includes('did not pass'))).toBe(true);
  });

  it('reports a nonzero missingCount when something required never executed', () => {
    const results = fullyExecutedResults({ oldRowsPass: true });
    delete results.matrixRows['current-stable-oss'];
    const findings = checkCompleteness(results, [], []);
    expect(findings.missingCount).toBeGreaterThan(0);
    expect(findings.some((f) => f.includes('missing matrix row') && f.includes('current-stable-oss'))).toBe(true);
  });

  it('reports zero findings at all for a fully-executed, fully-passing run', () => {
    const results = fullyExecutedResults({ oldRowsPass: true });
    const findings = checkCompleteness(results, [], []);
    expect(findings.missingCount).toBe(0);
    expect(findings.length).toBe(0);
  });
});
