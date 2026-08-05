// Phase 0 / issue #585, plan §5 "Server minimum" and §13 "Server support
// analysis and matrix". This module performs the CHECKED SEARCH the plan
// requires before proposing a ClickHouse version floor: it (1) proves —
// programmatically, not by assertion — whether the repository currently
// pins/exercises/promises any ClickHouse server version anywhere in CI,
// Docker, deployment docs, demo config, README, or tests; (2) inventories
// every server-sensitive format/setting/error-shape/fallback the application
// actually relies on, with each entry's required/optional/capability-gated
// status, current fallback, and earliest documented support; and (3)
// combines both with the pinned `@clickhouse/client-web@1.23.1`'s own
// documented compatibility floor into the plan's exact formula:
//
//   proposed minimum = max(
//     application feature/fallback minimum,
//     pinned official-client guaranteed minimum,
//     earliest version that passes every required hard gate,
//   )
//
// Kept as plain `.mjs` (not `.ts`) per plan §8: Node orchestration/analysis
// files stay untyped so this doesn't force a repository-wide `@types/node`
// decision (the same reasoning `fault-server.mjs`/`clickhouse-containers.mjs`
// already follow).
//
// This module does NOT write `docs/evidence/585/support-minimum-analysis.md`
// itself — that file is `run-matrix.mjs`'s job (a later sub-task, per the
// plan's execution order §34.F/H). Running this file directly prints the
// full analysis as JSON to stdout, which a later sub-task redirects into
// that evidence file. Every claim below is either produced by a live grep
// over this checkout (`scanForPinnedServerVersion`) or cites its exact
// source (a repository file:line, or the installed package's own README) —
// nothing here is asserted without a citation.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = join(here, '../../..');

// ── Official-client documented compatibility floor ──────────────────────────

/** Read the EXACT installed `@clickhouse/client-web` package's own README
 * compatibility table and parse its "Client version | ClickHouse" row
 * matching installed `1.23.1` (the "1.12.0+" row covers it — client versions
 * are inclusive-and-later per the table's own "+" notation). Throws loudly
 * rather than silently falling back to a hardcoded literal, so a future
 * `npm update` of this exact-pinned devDependency (which would need its own
 * deliberate `package.json` edit per plan §8) can't leave this citation
 * silently stale — a reviewer must re-run this and see it either still
 * resolve, or fail with a clear "the table changed" signal. */
export function readOfficialClientGuaranteedMinimum(repoRoot = DEFAULT_REPO_ROOT) {
  const readmePath = join(repoRoot, 'node_modules/@clickhouse/client-web/README.md');
  if (!existsSync(readmePath)) {
    throw new Error(`support-minimum: installed @clickhouse/client-web README not found at ${readmePath} — run npm ci first`);
  }
  const readme = readFileSync(readmePath, 'utf8');
  // The table shape (as of installed 1.23.1):
  //   | Client version | ClickHouse |
  //   | -------------- | ---------- |
  //   | 1.12.0+        | 24.8+      |
  const rowMatch = readme.match(/\|\s*([\d.]+)\+\s*\|\s*([\d.]+)\+\s*\|/);
  if (!rowMatch) {
    throw new Error(
      'support-minimum: could not find a "| <client>+ | <clickhouse>+ |" compatibility row in the installed '
      + '@clickhouse/client-web README — the table shape changed; update this parser and re-cite the ADR evidence.',
    );
  }
  const [, clientFloor, chFloor] = rowMatch;
  return {
    clientVersionFloor: clientFloor,
    clickhouseVersionFloor: chFloor,
    citation: `node_modules/@clickhouse/client-web/README.md, "## Compatibility with ClickHouse" table row "${clientFloor}+ | ${chFloor}+"`,
    caveat: readme.includes('best-effort support and is not guaranteed')
      ? 'README explicitly states the client "may work with older versions too; however, this is best-effort support and is not guaranteed" — the plan requires treating this as supplemental evidence only, never a lowered documented minimum.'
      : null,
  };
}

// ── Checked search: does the repository already pin/promise a CH version? ──

/** Every location plan §13 names as a place a pinned/promised ClickHouse
 * version could hide. Paths are relative to `repoRoot`; `optional: true`
 * means "scan if present, skip silently if the path doesn't exist" (some of
 * these — `deploy/`, `.github/workflows/` — always exist in this repo, but
 * the list is written defensively). */
const SCAN_TARGETS = [
  { label: 'CI workflows', globDir: '.github/workflows', extensions: ['.yml', '.yaml'] },
  { label: 'Docker/deploy files', globDir: 'deploy', extensions: ['.xml', '.sh', '.example', '.md'] },
  { label: 'repository docker-compose.yaml', file: 'docker-compose.yaml' },
  { label: 'top-level Dockerfile (if any)', file: 'Dockerfile' },
  { label: 'README.md', file: 'README.md' },
  {
    label: 'docs/ (deployment/demo/operations docs; excluding docs/design — a hypothetical, not-yet-built feature design tree, see docs/design/google-sheets/README.md\'s own "design-only" framing — its version mentions describe a FUTURE feature\'s own configurable minimum, not a current repository promise)',
    globDir: 'docs',
    extensions: ['.md', '.xml'],
    excludeDir: 'docs/design',
  },
  { label: 'tests/ (excluding this spike directory and its own matrix.json)', globDir: 'tests', extensions: ['.ts', '.js', '.mjs'], excludeDir: 'tests/spike/clickhouse-client' },
];

// A ClickHouse-release-shaped version token: 2-4 dot-separated numeric
// groups whose first component looks like a plausible CH year-major (18-99),
// optionally followed by a qualifier ClickHouse itself uses
// (altinitystable/stable/lts/-alpine, etc.) — narrow enough to skip unrelated
// numbers (port numbers, byte counts, issue numbers) while catching the shape
// this repository's own docs already use for illustrative examples (e.g.
// "26.3.10", "26.8").
// `(?<!\d\.)` rules out a match starting mid-way through a larger dotted
// number (e.g. "23.1" inside the npm devDependency literal "1.23.1" — a
// package semver, not a ClickHouse version, and NOT preceded by a plain word
// boundary since the preceding "1." is itself digits-then-dot).
const VERSION_TOKEN = /(?<!\d\.)\b(1[89]|[2-9]\d)\.\d{1,2}(?:\.\d+){0,2}\+?\b/g;

/** Known-benign mentions of a ClickHouse-version-shaped token that are NOT a
 * repository promise/pin — recorded here, WITH a reasoning citation, instead
 * of silently filtering them, so a reviewer can audit every exclusion. Each
 * entry is matched by file path (relative to `repoRoot`) and the surrounding
 * line text, so a genuinely new pin elsewhere in the same file still shows up
 * as a real finding. */
const KNOWN_BENIGN_VERSION_MENTIONS = [
  {
    file: 'docs/design/google-sheets/resource-model.md',
    lineIncludes: 'minimumClickHouseVersion: string',
    reason: 'A hypothetical future Google-Sheets-integration design doc\'s FIELD NAME/TYPE declaration (schema shape for a not-yet-built feature), not a version literal at all — no digits present on this line.',
  },
  {
    file: 'docs/design/google-sheets/configuration.md',
    lineIncludes: '"min_clickhouse_version": "26.8"',
    reason: 'An illustrative example VALUE inside a not-yet-built, unshipped design doc\'s sample JSON config — describes a hypothetical per-resource field, not a repository-wide supported-version promise exercised by CI/Docker/tests.',
  },
  {
    file: 'docs/ui-snapshots/CAPTURE-SPEC.md',
    lineIncludes: '"clickhouse_version": "26.3.10"',
    reason: 'An example literal inside a spec describing what METADATA FIELDS a UI screenshot capture should record (read from the running server\'s own version() at capture time) — not a pin of which version to run.',
  },
  {
    file: 'docs/ui-snapshots/g6410a06/notes.md',
    lineIncludes: 'ClickHouse `26.3.10.20001.altinityantalya`.',
    reason: 'A historical provenance note recording which server version happened to be used for ONE past snapshot capture session — not an ongoing supported-version promise.',
  },
  {
    file: 'docs/ui-snapshots/g6410a06/notes.md',
    lineIncludes: 'header shows a short version chip (`ClickHouse 26.3.10`)',
    reason: 'Describes the UI\'s OWN version-chip DISPLAY behavior (it echoes whatever version() the connected server reports) in a specific past capture, not a pinned/required server version.',
  },
  {
    file: 'deploy/http_handlers.xml',
    lineIncludes: '26.3.x rejects a <name> child',
    reason: 'A deployment-config authoring note explaining why `name=` is an XML ATTRIBUTE rather than a child element (dodges ClickHouse config.d merge bug #70636) — a compatibility workaround note, not a minimum-version promise or requirement.',
  },
  {
    file: 'docs/ADR-0003-dashboard-viewing.md',
    lineIncludes: 'ClickHouse 26.6.',
    reason: 'An architecture-decision-record note about WHEN an upstream ClickHouse capability became available, for engineering-decision context — not a repository support promise.',
  },
  {
    file: 'docs/ADR-0003-dashboard-viewing.md',
    lineIncludes: 'it first shipped in ClickHouse **25.2**, so',
    reason: 'Same ADR historical-context note as above — records upstream feature-shipping history that INFORMED a decision to avoid depending on it (see the matching src/core/variable-options.ts inventory entry, which deliberately uses pre-20.4 functions instead), not a version requirement.',
  },
  {
    file: 'docs/drafts/visualization-spec-authoring-guide.md',
    lineIncludes: 'ClickHouse 24.7 named-tuple aliases',
    reason: 'A citation link to ClickHouse\'s own upstream release-blog post, for authoring-guide background — not a repository version requirement.',
  },
  {
    file: 'tests/unit/schema-graph.test.ts',
    lineIncludes: 'Fixtures are the *actual* outputs captured from ClickHouse 26.5.1',
    reason: 'Fixture-provenance comment (which real server produced these committed sample outputs) — schema-graph parsing itself is version-agnostic text parsing, not gated on this or any other server version.',
  },
  {
    file: 'tests/unit/kpi.test.ts',
    lineIncludes: "tupleString.diagnostics[0].message).toContain('ClickHouse 24.3')",
    reason: 'Tests the already-inventoried capability-gated named-tuple diagnostic (see SERVER_SENSITIVE_INVENTORY: "KPI named-tuple detection") — the diagnostic MESSAGE echoes whatever serverVersion string the caller supplies for display; this test line does not pin or require CH 24.3, and the feature has a graceful fallback (a warning diagnostic, never a crash) regardless of server version.',
  },
  {
    file: 'tests/unit/dashboard-viewer-session.test.ts',
    lineIncludes: 'and none is available before ClickHouse 25.2',
    reason: 'Tests the already-inventoried "variable-option batch reads" entry (see SERVER_SENSITIVE_INVENTORY) — this comment documents that the app DELIBERATELY avoided the 25.2+-only wire format in favor of tupleElement(tuple(*), n) (functions since 20.4), specifically so the floor is NOT raised to 25.2.',
  },
];

function isKnownBenign(fileRel, lineText) {
  return KNOWN_BENIGN_VERSION_MENTIONS.find((k) => k.file === fileRel && lineText.includes(k.lineIncludes)) || null;
}

// Recursive file lister — written directly with node:fs, no glob dependency:
// the spike stays dependency-free for its own tooling, matching
// fault-server.mjs's "dependency-free Node http server" precedent.
import { readdirSync } from 'node:fs';
function walk(dirAbs, extensions, excludeDirAbs, out) {
  let entries;
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return; // optional target dir doesn't exist — nothing to scan
  }
  for (const entry of entries) {
    const abs = join(dirAbs, entry.name);
    if (excludeDirAbs && abs === excludeDirAbs) continue;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(abs, extensions, excludeDirAbs, out);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(abs);
    }
  }
}

/** Run the checked search. Returns `{ scanned: string[], findings: [...],
 * benignExclusions: [...], pinned: boolean }` — `pinned` is true only if a
 * finding survives the benign-mention allowlist above, i.e. the repository
 * genuinely promises/exercises a specific ClickHouse version somewhere. */
export function scanForPinnedServerVersion(repoRoot = DEFAULT_REPO_ROOT) {
  const scanned = [];
  const findings = [];
  const benignExclusions = [];

  const files = [];
  for (const target of SCAN_TARGETS) {
    if (target.file) {
      const abs = join(repoRoot, target.file);
      if (existsSync(abs)) files.push(abs);
      continue;
    }
    const dirAbs = join(repoRoot, target.globDir);
    const excludeAbs = target.excludeDir ? join(repoRoot, target.excludeDir) : null;
    walk(dirAbs, target.extensions, excludeAbs, files);
  }

  for (const abs of files) {
    const rel = relative(repoRoot, abs);
    scanned.push(rel);
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    lines.forEach((lineText, idx) => {
      const matches = lineText.match(VERSION_TOKEN);
      if (!matches) return;
      // Filter out matches that are clearly not ClickHouse-version context on
      // this line (e.g. a semver of an unrelated npm package, a byte count) —
      // require the word "clickhouse" (any case) to appear somewhere on the
      // same line, OR the file itself to be exclusively about a ClickHouse
      // image/deployment (deploy/, docker-compose.yaml, Dockerfile) where any
      // bare version token is presumptively CH-related.
      const fileIsChScoped = rel === 'docker-compose.yaml' || rel === 'Dockerfile' || rel.startsWith('deploy/');
      if (!fileIsChScoped && !/clickhouse/i.test(lineText)) return;
      const benign = isKnownBenign(rel, lineText);
      const finding = { file: rel, line: idx + 1, text: lineText.trim(), tokens: matches };
      if (benign) benignExclusions.push({ ...finding, reason: benign.reason });
      else findings.push(finding);
    });
  }

  return {
    scanned,
    findings,
    benignExclusions,
    pinned: findings.length > 0,
  };
}

// ── Server-sensitive dependency inventory (plan §13) ────────────────────────

/** One inventoried server-sensitive dependency. `citation` points at the
 * repository source proving the behavior (never asserted without one);
 * `earliestDocumentedSupport` is either a specific version with its own
 * citation, or the literal string below when the feature is a long-standing
 * part of ClickHouse's HTTP interface with no version-gated introduction
 * documented anywhere this search could authoritatively cite — recorded
 * honestly as "not independently documented" rather than inventing a date. */
const PREDATES_EVERY_EVALUATED_ROW = 'not independently documented; long-standing ClickHouse HTTP-interface behavior, predates every evaluated matrix row (oldest evaluated: 24.8)';

export const SERVER_SENSITIVE_INVENTORY = [
  {
    feature: 'JSONStringsEachRowWithProgress (Table streaming format)',
    status: 'required',
    fallback: 'none — this is the current adapter\'s own default Table format (ch-client.ts chUrl default)',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/net/ch-client.ts chUrl(): "const format = opts.format || \'JSONStringsEachRowWithProgress\'"',
    raisesFloor: false,
  },
  {
    feature: 'JSONEachRowWithProgress (KPI streaming format)',
    status: 'required',
    fallback: 'none — KPI tiles use this format unconditionally',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/net/ch-client.ts / src/dashboard — KPI execution path (CLAUDE.md "KPI execution uses JSONEachRowWithProgress")',
    raisesFloor: false,
  },
  {
    feature: 'totals/extremes lines (rows_before_limit_at_least, totals, extremes)',
    status: 'optional',
    fallback: 'silently tolerated as a no-op if present; never requested by a setting the app requires',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/core/stream.ts applyStreamLine — lines without meta/row/progress/exception are ignored',
    raisesFloor: false,
  },
  {
    feature: 'HTTP settings sent by ch-client.ts (max_result_rows, result_overflow_mode, add_http_cors_header, enable_http_compression)',
    status: 'required',
    fallback: 'none — sent on every request',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/net/ch-client.ts chUrl()/runQuery()',
    raisesFloor: false,
  },
  {
    feature: 'wait_end_of_query (non-streaming reads only)',
    status: 'optional',
    fallback: 'only set for the non-streaming (rowLimit-less) branch; streaming Table/KPI reads never set it',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/net/ch-client.ts runQuery(): "wait_end_of_query buffers the whole response server-side..."',
    raisesFloor: false,
  },
  {
    feature: 'enable_http_compression=1 (gzip/br response compression negotiation)',
    status: 'required',
    fallback: 'none',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/net/ch-client.ts chUrl()',
    raisesFloor: false,
  },
  {
    feature: 'X-ClickHouse-Summary response header',
    status: 'optional',
    fallback: 'summary is read best-effort; absence does not fail a query',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/application/export-service.ts and core/stream.ts summary handling',
    raisesFloor: false,
  },
  {
    feature: 'X-ClickHouse-Exception-Tag header + tagged late-exception frame',
    status: 'capability-gated',
    fallback: 'plain-text scan (legacy untagged exception detection) on servers that never send the header',
    earliestDocumentedSupport: '24.11',
    citation: 'README.md "Export" section: "CH ≥ 24.11; older servers fall back to a plain-text scan" — src/core/stream.ts findExceptionFrame(tailLatin1, tag)',
    raisesFloor: false,
  },
  {
    feature: 'Legacy untagged late-exception detection (plain-text "Code: N. DB::Exception:" scan)',
    status: 'required (as the fallback path for pre-24.11 servers)',
    fallback: 'n/a — this IS the fallback',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/core/stream.ts findExceptionFrame — untagged branch',
    raisesFloor: false,
  },
  {
    feature: 'Native query parameters (param_<name> query-string args)',
    status: 'optional',
    fallback: 'omitted entirely when a query defines none',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/net/ch-client.ts queryJson()/runQuery() params; README.md "Query variables"',
    raisesFloor: false,
  },
  {
    feature: 'Roles (role=<name> query-string arg)',
    status: 'optional',
    fallback: 'omitted when the user has no role selection',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'tests/spike/clickhouse-client/current-adapter.ts nativeParamsForCurrent() role handling',
    raisesFloor: false,
  },
  {
    feature: 'Sessions (session_id query-string arg)',
    status: 'optional',
    fallback: 'session-less by default; only multi-statement scripts opt in',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/application/query-execution-service.ts ScriptStatement.params session_id',
    raisesFloor: false,
  },
  {
    feature: 'SESSION_IS_LOCKED (code 373) retry classification',
    status: 'required (for the retry-safety invariant, whenever a session IS used)',
    fallback: 'none — the regex is the detection mechanism itself; no server-version branch',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/application/query-execution-service.ts SESSION_BUSY regex',
    raisesFloor: false,
  },
  {
    feature: 'KILL QUERY WHERE query_id = ... ASYNC',
    status: 'optional (best-effort cancellation only)',
    fallback: 'errors are swallowed — killQuery() never throws',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/net/ch-client.ts killQuery()/killQueryWithLease()',
    raisesFloor: false,
  },
  {
    feature: 'DataLakeCatalog visibility setting (show_data_lake_catalogs_in_system_tables / renamed show_remote_databases_in_system_tables)',
    status: 'capability-gated',
    fallback: 'plain system.tables/system.columns query on "Unknown setting", latched per-connection (dataLakeCatalogSettingUnsupported)',
    earliestDocumentedSupport: '25.8',
    citation: 'src/net/ch-client.ts querySystemAware() docstring',
    raisesFloor: false,
  },
  {
    feature: 'Older system-table fallback shape generally (system.tables/system.columns queried without the data-lake setting)',
    status: 'required (as the universal fallback)',
    fallback: 'n/a — this IS the fallback used by every server below 25.8',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/net/ch-client.ts querySystemAware() plain() branch',
    raisesFloor: false,
  },
  {
    feature: 'KPI named-tuple detection (Tuple(value, delta) returned as a JSON object vs. a positional array/string)',
    status: 'capability-gated',
    fallback: 'a "kpi-server-named-tuple-unsupported" warning diagnostic (never a crash) when the server/query returns a positional tuple instead of a named one — e.g. a tuple literal without enable_named_columns_in_function_tuple or an explicit named-type CAST; see README.md "KPI" section',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/core/kpi.ts readKpiFields() — kpi-server-named-tuple-unsupported diagnostic; tests/unit/kpi.test.ts serverVersion display case',
    raisesFloor: false,
  },
  {
    feature: 'Variable-option batch reads (tupleElement(tuple(*), n) positional projection for __variable_name/__variable_value/__variable_label)',
    status: 'required',
    fallback: 'n/a — this IS the app\'s own fallback: it deliberately uses tuple()/tupleElement() (functions available since ClickHouse 20.4) instead of the newer positional wire format ClickHouse first shipped in 25.2, specifically so this feature does not require 25.2+',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/core/variable-options.ts — "Both functions have existed since ClickHouse 20.4 ... the alternative, a positional wire format, first shipped in 25.2 and would have made the whole feature fail on anything older."',
    raisesFloor: false,
  },
  {
    feature: 'Authentication error code/message forms (401/403, AUTHENTICATION_FAILED code 516, isAuthExpiredBody text matching)',
    status: 'required',
    fallback: 'none — this IS the retry/sign-out policy',
    earliestDocumentedSupport: PREDATES_EVERY_EVALUATED_ROW,
    citation: 'src/net/ch-client.ts authedFetch(); src/core/stream.ts isAuthExpiredBody()',
    raisesFloor: false,
  },
];

// ── Combine into the plan's exact formula ───────────────────────────────────

/** Parse a ClickHouse-style version string's leading `major.minor` as
 * `[major, minor]` numbers, for a coarse (major.minor-only) comparison — the
 * granularity the plan's formula and the client's own compatibility table
 * both operate at ("24.8+"), never patch-level. */
function majorMinor(v) {
  const m = String(v).match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** `a` vs `b` at major.minor granularity: -1/0/1, or `null` if either is
 * unparseable (e.g. the "not independently documented" sentinel). */
function compareChVersion(a, b) {
  const pa = majorMinor(a);
  const pb = majorMinor(b);
  if (!pa || !pb) return null;
  if (pa[0] !== pb[0]) return pa[0] - pb[0];
  return pa[1] - pb[1];
}

/**
 * Derive the plan §5 proposed minimum. `earliestPassingVersion` (optional) is
 * fed back by `run-matrix.mjs`'s live gate run (out of this module's own
 * scope — this module only performs the CHECKED SEARCH and the STATIC
 * feature-floor computation, steps 1-2 of the plan's 5-step derivation;
 * steps 3-5 need the actual live matrix to have run). Absent, the function
 * still returns a fully-justified minimum from steps 1-2 alone, explicitly
 * flagging that the live-gate corroboration step has not yet run. */
export function deriveProposedMinimum({ repoRoot = DEFAULT_REPO_ROOT, earliestPassingVersion = null } = {}) {
  const pinnedScan = scanForPinnedServerVersion(repoRoot);
  const officialFloor = readOfficialClientGuaranteedMinimum(repoRoot);

  // Step 2-3: does any inventoried feature raise the floor above the
  // client's own guaranteed minimum? Only features with a specific
  // (non-sentinel) earliestDocumentedSupport can even be compared.
  const candidateRaisers = SERVER_SENSITIVE_INVENTORY.filter((f) => f.raisesFloor);
  let applicationFeatureMinimum = null;
  for (const f of SERVER_SENSITIVE_INVENTORY) {
    if (f.earliestDocumentedSupport === PREDATES_EVERY_EVALUATED_ROW) continue;
    if (!f.raisesFloor) continue; // capability-gated-with-fallback features never raise the floor
    if (applicationFeatureMinimum === null || compareChVersion(f.earliestDocumentedSupport, applicationFeatureMinimum) > 0) {
      applicationFeatureMinimum = f.earliestDocumentedSupport;
    }
  }

  const floors = [
    { source: 'pinned official-client guaranteed minimum', value: officialFloor.clickhouseVersionFloor },
  ];
  if (applicationFeatureMinimum) {
    floors.push({ source: 'application feature/fallback minimum', value: applicationFeatureMinimum });
  }
  if (earliestPassingVersion) {
    floors.push({ source: 'earliest version that passed every required hard gate (live matrix)', value: earliestPassingVersion });
  }

  let proposedMinimum = officialFloor.clickhouseVersionFloor;
  let proposedMinimumSource = 'pinned official-client guaranteed minimum';
  for (const f of floors) {
    const cmp = compareChVersion(f.value, proposedMinimum);
    if (cmp !== null && cmp > 0) {
      proposedMinimum = f.value;
      proposedMinimumSource = f.source;
    }
  }

  return {
    repositoryPromisesNoPinnedVersion: !pinnedScan.pinned,
    pinnedVersionScan: pinnedScan,
    officialClientGuaranteedMinimum: officialFloor,
    serverSensitiveInventory: SERVER_SENSITIVE_INVENTORY,
    inventoryFeaturesThatRaiseFloor: candidateRaisers.map((f) => f.feature),
    applicationFeatureMinimum,
    liveGateCorroboration: earliestPassingVersion
      ? { evaluated: true, earliestPassingVersion }
      : { evaluated: false, note: 'run-matrix.mjs has not yet fed back a live-tested oldest-candidate result into this derivation' },
    floors,
    proposedMinimum,
    proposedMinimumSource,
    rationale: [
      pinnedScan.pinned
        ? `Repository scan found ${pinnedScan.findings.length} genuine pinned-version mention(s) — see pinnedVersionScan.findings.`
        : `Checked search over ${pinnedScan.scanned.length} files (CI workflows, deploy/, docker-compose.yaml, README.md, docs/, tests/) found no genuine ClickHouse version pin/promise; ${pinnedScan.benignExclusions.length} version-shaped token(s) were found and excluded with a recorded reason (see pinnedVersionScan.benignExclusions) — none is a repository-exercised promise.`,
      `Official client ${officialFloor.citation} documents a guaranteed floor of ClickHouse ${officialFloor.clickhouseVersionFloor}+.`,
      applicationFeatureMinimum
        ? `Application inventory raises the floor to ${applicationFeatureMinimum} via: ${candidateRaisers.map((f) => f.feature).join(', ')}.`
        : 'No inventoried server-sensitive dependency raises the floor above the official client\'s own guaranteed minimum — every capability newer than that floor (X-ClickHouse-Exception-Tag/24.11, DataLakeCatalog visibility/25.8) has a working fallback for older servers, so none is REQUIRED.',
      `Proposed minimum = max(${floors.map((f) => `${f.source}=${f.value}`).join(', ')}) = ${proposedMinimum} (binding source: ${proposedMinimumSource}).`,
      earliestPassingVersion
        ? 'Live-gate corroboration (step 5 of the plan\'s derivation) has run and is folded in above.'
        : 'Live-gate corroboration (plan §5 step 5: "testing the resulting oldest candidate against every hard gate") has NOT yet run through this module — that is run-matrix.mjs\'s job against the resolved matrix.json rows; this derivation is steps 1-4 only.',
    ],
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  try {
    const analysis = deriveProposedMinimum();
    process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`support-minimum: ${e instanceof Error ? e.stack || e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
