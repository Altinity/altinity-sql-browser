// Architecture boundary guard (issue #276). Rule list, grown per phase:
//   Phase 0 — src/application/ must not import src/ui/ or src/editor/: the
//   service layer coordinates state and network, it does not reach into DOM
//   rendering or the CodeMirror editor adapters.
//   Phase 3 — the route sessions must not import each other's implementation
//   modules (ui/workbench ↔ ui/dashboard), and the Dashboard surface must not
//   depend on the editor ports at all.
//   Phase 5 — neither route shell (ui/workbench/**, ui/dashboard.ts +
//   ui/dashboard/**) may import src/ui/app.ts: both receive everything they
//   need injected (a narrow deps bag / the App type only) — reaching back
//   into app.ts itself would recreate the coupling this phase removes.
// `import type` counts too: a type-only import still couples the layers at
// compile time. Extend RULES below in later phases rather than growing a
// second script.
//
// Hand-rolled regex scan for the internal src-layering rules (RULES below)
// and Rule B's zero-bare-specifier check: the codebase has no exotic import
// syntax there, so scanning for import/export specifiers is enough and keeps
// those rules a zero-dependency, sub-second pretest step. The exceptions are
// the former-owner rules, Rule C (the package relative-deep-import ban,
// Guard 2 — issue #630 Phase 8, review pass 1), BOTH halves of the revised
// package Rule D (the deep-import-subpath ban and the bare-specifier
// name/shape check), and the `@clickhouse/client-web` reintroduction ban
// (Guard 5) below — all of which need identifier/import-shape-level (not
// specifier-text-level) detection and therefore delegate to a real
// TypeScript parse in `build/lib/check-legacy-owners.mjs` — see that module
// for why textual matching was retired there (issue #630 Phase 3), and why
// the same real-parser mechanism (not a new hand-rolled scanner) was
// required again for issue #630 Phase 5's revised Rule D, and again for
// issue #630 Phase 8's Rule C/Guard 2 broadening and Guard 5: a comment
// sitting between `import`/`export` and the specifier, or an escaped
// string-literal segment, defeats a regex (however far its
// whitespace/delimiter patterns are widened) but is ordinary parser
// trivia/decoded text to a real parse — review pass 1 confirmed Rule C's
// production enforcement still ran the regex (`extractSpecifiers`) despite
// this file's own stated Phase 8 design goal, while its unit-test mirror
// independently reimplemented the identical regex rather than calling the
// real parser.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findLegacyOwnerViolations,
  PHASE3_LEGACY_OWNER_FILES,
  findSqlQuoteOwnerViolations,
  PHASE5_SQL_QUOTE_OWNER_FILES,
  findKillStopgapOwnerViolations,
  PHASE5_KILL_STOPGAP_OWNER_FILES,
  findDeepImportSpecifiers,
  findPackageImportUsages,
  PHASE5_PACKAGE_LANGUAGE_EXPORTS,
  mightReferencePackage,
  findRetiredTopLevelApiViolations,
  PHASE7_RETIRED_TOP_LEVEL_NAMES,
  PHASE7_DELETED_TRANSPORT_FILES,
  mightReferenceRetiredTopLevelApi,
  PHASE8_NARROW_RULE_D_EXCEPTIONS,
  findModuleSpecifiers,
  mightReferenceForbiddenRelativeDir,
  findTransportSurfaceOwnershipViolations,
  PHASE8_TRANSPORT_SURFACE_NAMES,
  PHASE8_PARSER_SURFACE_NAMES,
  manifestDependencyFields,
  lockHasPackage,
  retiredClientSpikeScriptNames,
} from './lib/check-legacy-owners.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;

/** Each rule: every source file under `dir` must not import anything that
 *  resolves under any of `forbidden` (directories OR single files,
 *  repo-relative — `dir` itself may also name a single file, e.g.
 *  `src/ui/dashboard.ts`, since that route shell has no dedicated directory
 *  of its own the way `src/ui/workbench/**`/`src/ui/dashboard/**` do).
 *  `except` (optional) names specific files inside a forbidden directory
 *  that stay importable — for deliberate, documented carve-outs only. */
const RULES = [
  {
    dir: 'src/core',
    forbidden: ['src/workspace', 'src/application', 'src/ui', 'src/net'],
    why: 'issue #455: core must not depend on higher-level workspace, application, UI, or network layers',
  },
  { dir: 'src/application', forbidden: ['src/ui', 'src/editor'], why: 'issue #276 day-1 rule' },
  {
    dir: 'src/ui/workbench',
    forbidden: ['src/ui/dashboard', 'src/ui/app.ts'],
    why: 'issue #276 Phase 3/5: route sessions must not import each other, and the shell must not reach back into app.ts (everything it needs is injected)',
  },
  {
    dir: 'src/ui/dashboard',
    forbidden: ['src/ui/workbench', 'src/editor', 'src/ui/app.ts'],
    why: 'issue #276 Phase 3/5: route sessions must not import each other, dashboard has no editor, and the shell must not reach back into app.ts',
  },
  {
    // The dashboard route's own shell file (no dedicated directory, unlike
    // its `dashboard-session.ts` runtime under `src/ui/dashboard/`) — same
    // Phase 5 rule as the workbench shell above.
    dir: 'src/ui/dashboard.ts',
    forbidden: ['src/ui/app.ts'],
    why: 'issue #276 Phase 5: the dashboard shell must not reach back into app.ts (everything it needs is injected)',
  },
  // Issue #280 phase 1 (#283): the Dashboard module keeps the dependency
  // direction `model <- application <- UI adapters`, and neither the model
  // nor the workspace aggregate may depend on the App controller, Workbench
  // UI, editors, global AppState, or the network layer.
  {
    dir: 'src/dashboard',
    forbidden: ['src/ui', 'src/editor', 'src/application', 'src/state.ts', 'src/net'],
    why: 'issue #280 phase 1: Dashboard model/application code is pure and must not depend on App, Workbench UI, editors, global AppState, or the network layer',
  },
  {
    dir: 'src/dashboard/model',
    forbidden: ['src/dashboard/application', 'src/dashboard/layouts', 'src/dashboard/ui'],
    why: 'issue #280 phase 1: dependency direction is model <- application <- UI adapters',
  },
  {
    // Issue #280 phase 3 (#285): the Dashboard authoring/application layer may
    // import the model, the layout plugins, and the workspace aggregate, but
    // must NOT reach up into any UI adapter (the App, Workbench UI, editors,
    // and global AppState are already forbidden by the `src/dashboard` rule
    // above). This keeps the direction model/layouts <- application <- UI.
    //
    // Issue #286 phase 4: the DashboardViewerSession lives here, so this rule
    // also names the App/AppState/editor/service/network boundary EXPLICITLY
    // (not just transitively via the `src/dashboard` rule) — the viewer session
    // must be constructible and testable without the Workbench UI, the full
    // `App` controller, global `AppState`, the CodeMirror editors, the
    // `src/application` services, or the `src/net` client; it depends only on
    // the narrow injected interfaces it declares. `main.ts` (the bootstrap) is
    // named too so the application layer can never reach the composition root.
    dir: 'src/dashboard/application',
    forbidden: [
      'src/dashboard/ui', 'src/ui', 'src/editor', 'src/application',
      'src/state.ts', 'src/net', 'src/main.ts',
    ],
    why: 'issue #280 phase 3 / #286 phase 4: application (incl. DashboardViewerSession) must not import Dashboard UI adapters, Workbench UI, the App, global AppState, editors, src/application services, or the network layer',
  },
  {
    dir: 'src/workspace',
    forbidden: ['src/ui', 'src/editor', 'src/application', 'src/state.ts', 'src/net'],
    why: 'issue #280 phase 1: the workspace aggregate layer is pure and must not depend on App, Workbench UI, editors, global AppState, or the network layer',
  },
  {
    // Issue #60/#313: the editor adapters are a LEAF layer, addressed only
    // through the injected ports (app.sqlEditor/app.specEditor) — they must
    // not reach up into UI render modules. UI-owned actions the editor
    // triggers (e.g. the reference pane's openDocEntry) are injected as app
    // callbacks at wiring time (app.ts), never imported. Two deliberate
    // carve-outs predating the rule: `dnd-mime` (pure MIME-string constants
    // shared with the drag-source UI) and `dom` (the generic hyperscript
    // helper — a DOM-builder utility with no app/render-module coupling).
    dir: 'src/editor',
    forbidden: ['src/ui'],
    except: ['src/ui/dnd-mime.js', 'src/ui/dnd-mime.ts', 'src/ui/dom.js', 'src/ui/dom.ts'],
    why: 'issue #60/#313: the editor layer is a leaf — UI actions are injected via app callbacks, not imported',
  },
  // Issue #585 Phase 1: the generic ClickHouse transport (and its type-only
  // contract) is a low-level leaf that must not reach auth/application
  // policy or UI, even type-only (the checker's own header comment: `import
  // type` counts too). Two entries, not one, because collectFiles(ruleDir)
  // matches per-`dir` — a single-file rule naming only the implementation
  // file would leave the sibling contract file unguarded. `forbidden` targets
  // are resolved repo-relative paths (never raw specifier strings like
  // './ch-client.ts'), matching how the checker resolves and compares them.
  //
  // Issue #630 Phase 6: the normal-request auth/epoch/refresh/lifecycle
  // policy moved out of `ch-client.ts` into the new
  // `src/net/authenticated-clickhouse-request.ts` — the CURRENT auth-policy
  // owner this transport leaf must not reach, so both forbidden lists below
  // name it alongside `ch-client.ts`.
  {
    dir: 'src/net/clickhouse-http-transport.ts',
    forbidden: ['src/net/ch-client.ts', 'src/net/authenticated-clickhouse-request.ts',
      'src/net/oauth.ts', 'src/net/oauth-config.ts', 'src/application', 'src/ui'],
    why: 'issue #585 Phase 1 / #630 Phase 6: the generic transport cannot reach auth/application policy or UI',
  },
  {
    dir: 'src/net/clickhouse-transport.types.ts',
    forbidden: ['src/net/ch-client.ts', 'src/net/authenticated-clickhouse-request.ts',
      'src/net/oauth.ts', 'src/net/oauth-config.ts', 'src/application', 'src/ui'],
    why: 'issue #585 Phase 1 / #630 Phase 6: the transport contract must not couple to auth/application policy or UI, even type-only',
  },
  // Issue #630 Phase 2 — Rule A: the new workspace package must not depend on
  // ANY SQL Browser source, relatively. (A separate dedicated block below
  // additionally bans a browser-root-literal or bare-specifier escape, since
  // this generic loop only inspects specifiers starting with '.'.)
  {
    dir: 'packages/clickhouse-http/src',
    forbidden: ['src'],
    why: 'issue #630 Phase 2: clickhouse-http must not depend on SQL Browser source',
  },
  // Issue #630 Phase 2 — Rule C: SQL Browser source must consume the package
  // through its public export, never a relative deep import into the
  // package's own implementation files. Issue #630 Phase 8 (plan §21, Guard
  // 2) broadens the forbidden target from just `packages/clickhouse-http/src`
  // to the WHOLE package directory (`packages/clickhouse-http`, no `/src`
  // suffix) — generated `dist/**` is a second possible relative deep-import
  // escape a source-only ban would miss (e.g.
  // `../../packages/clickhouse-http/dist/client.js`). The bare deep-import
  // subpath form (`@altinity/clickhouse-http/dist/client.js`) needs no
  // parallel change: Rule D's `findDeepImportSpecifiers` below already bans
  // any subpath of the package specifier regardless of what follows the
  // slash, dist included. NOT an entry in this RULES array (review pass 1):
  // this generic loop's `extractSpecifiers` regex missed a comment-trivia'd
  // import clause or an escaped string-literal segment spelling out a
  // `packages/clickhouse-http` path, so Rule C is enforced by its own real-
  // parser (`findModuleSpecifiers`) block, alongside Rule D, below.
];

function collectFiles(target) {
  if (fs.statSync(target).isFile()) return SOURCE_EXT.test(target) ? [target] : [];
  const out = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

// Matches, in order: static `import ... from '...'` (incl. `import type`),
// `export ... from '...'` (incl. `export type`), a bare side-effect
// `import '...'`, and dynamic `import('...')`. Each pattern requires only
// identifier/brace/comma/whitespace characters between the keyword and
// `from`, so it can't skip past a from-less import into a later statement's
// clause, and `\b` keeps it off the word "import" inside an identifier.
// Used only by the checks named in the comment above (internal src layering,
// the @clickhouse/client-web ban, Rule B) — NEITHER half of Rule D's
// `@altinity/clickhouse-http` check calls this anymore (both now delegate to
// the real-parser helpers in `build/lib/check-legacy-owners.mjs`, below).
//
// Only the dynamic-import pattern also accepts a backtick-delimited
// no-substitution template literal (`` import(`pkg`) ``): a static
// import/export declaration's module specifier and a bare side-effect
// import's specifier must be a plain string literal per grammar — only a
// dynamic `import(...)` call can take a template literal argument — so
// widening the other three patterns to backticks would only ever match
// syntax that can't occur.
const SPECIFIER_PATTERNS = [
  /\bimport\s+[\w*{}\s,]+\s+from\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[\w*{}\s,]+\s+from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
];

function extractSpecifiers(source) {
  const specs = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) specs.push(match[1]);
  }
  return specs;
}

// Relative specifiers resolve like esbuild/tsc do: a `.js` specifier written
// against a `.ts` source file still resolves to the `.ts` file on disk.
function resolveRelative(fromFile, spec) {
  const resolved = path.resolve(path.dirname(fromFile), spec);
  const noExt = resolved.replace(/\.(ts|tsx|js|mjs)$/, '');
  const candidates = [
    resolved, `${noExt}.ts`, `${noExt}.tsx`, `${noExt}.js`, `${noExt}.mjs`,
    path.join(resolved, 'index.ts'), path.join(resolved, 'index.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? resolved;
}

const violations = [];
let checkedFiles = 0;
let activeRules = 0;
for (const rule of RULES) {
  const ruleDir = path.join(repoRoot, rule.dir);
  const files = fs.existsSync(ruleDir) ? collectFiles(ruleDir) : [];
  if (files.length === 0) continue; // directory not born yet — rule activates with it
  activeRules += 1;
  checkedFiles += files.length;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const spec of extractSpecifiers(source)) {
      if (!spec.startsWith('.')) continue; // bare/package specifiers can't reach src dirs
      const resolved = resolveRelative(file, spec);
      const relResolved = path.relative(repoRoot, resolved).split(path.sep).join('/');
      const hit = rule.forbidden.find((f) => relResolved === f || relResolved.startsWith(`${f}/`));
      if (hit && (rule.except ?? []).includes(relResolved)) continue;
      if (hit) {
        const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
        violations.push(`${relFile} → ${spec} (resolved: ${relResolved}; ${rule.dir} must not import ${hit} — ${rule.why})`);
      }
    }
  }
}

// Issue #512 Phase 1: connection readiness has one authority. These are the
// modules that own or project the lifecycle, and none may regain the retired
// server-version shortcut. `serverVersion` remains legitimate catalog/query
// capability metadata and user-menu display elsewhere.
//
// Issue #630 Phase 6: the normal-request lifecycle classification
// (`onTransportConnected`/`onTransportOffline`/`onSignedOut` dispatch) moved
// from `ch-client.ts` into `src/net/authenticated-clickhouse-request.ts` —
// the list below keeps `ch-client.ts` (its product-client `ChCtx`/callers
// still matter to this guard through Phase 6) and adds the new lifecycle-
// owning file explicitly, rather than replacing one with the other.
const connectionAuthorityFiles = [
  'src/core/connection-lifecycle.ts',
  'src/application/connection-session.ts',
  'src/net/ch-client.ts',
  'src/net/authenticated-clickhouse-request.ts',
  'src/ui/app-header.ts',
  'src/ui/app-shell.ts',
];
for (const relFile of connectionAuthorityFiles) {
  const file = path.join(repoRoot, relFile);
  if (!fs.existsSync(file)) continue;
  checkedFiles += 1;
  if (/\bserverVersion\b/.test(fs.readFileSync(file, 'utf8'))) {
    violations.push(`${relFile} → serverVersion (issue #512: lifecycle/readiness must not be inferred from version metadata)`);
  }
}

// The DOM projection is exclusive too. The retired bridge lived in app.ts:
// catalog version metadata called back into the composition root, which then
// mutated the chip. Keep the handle declaration in app.types.ts, but reject
// every chip selector/projector reference outside its pure projector and
// header renderer. This catches that exact regression without banning
// legitimate server-version capability data or the user-menu version label.
const connectionProjectionOwners = new Set([
  'src/core/connection-lifecycle.ts',
  'src/ui/app-header.ts',
  'src/ui/app.types.ts',
]);
const connectionProjectionPattern =
  /\bconnStatus\b|conn-status|connection-(?:state|chip)|data-connection-state|\bconnectionLifecyclePresentation\b/;
for (const file of collectFiles(path.join(repoRoot, 'src'))) {
  const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
  if (connectionProjectionOwners.has(relFile)) continue;
  if (connectionProjectionPattern.test(fs.readFileSync(file, 'utf8'))) {
    violations.push(`${relFile} → connection-chip projection (issue #512: only app-header may render lifecycle state)`);
  }
}

// Issue #585 Phase 1 / #630 Phase 8 (plan §24, Guard 5): no executable/config
// source anywhere in the repository may import the official
// `@clickhouse/client-web` package, or a subpath of it. ADR-0005
// (docs/ADR-0005-clickhouse-web-client.md) is and remains Rejected — there is
// no future-transport allowlist anymore (Phase 8 deletes it outright; #639
// covers only the workspace-extraction side of this issue, never a reversal
// of this ADR). A real-parser scan (`findModuleSpecifiers`), not a
// specifier-text regex, for the same comment-trivia-bypass reason as Rule D
// above — this is exactly the "genuinely new source analysis" case this
// module's header comment requires the real parser for, now covering four
// trees instead of one: `src/**`, `packages/clickhouse-http/**` (excluding
// generated `dist/**`, which is build output, not source), `tests/**`, and
// `build/**`. A plain substring pre-filter gates the expensive real-parser
// call per file (matching `mightReferenceRetiredTopLevelApi`'s established,
// accepted-risk convention above, not Rule D's heavier escape-sequence-aware
// `mightReferencePackage`) — an exotic escaped spelling of this well-known,
// no-longer-evolving vendor package name is outside this guard's threat
// model, same acceptance as this module's own stated scope. Review pass 1:
// the prefilter now CALLS `mightReferenceRetiredTopLevelApi` (imported
// above) instead of an inline `source.includes(CLIENT_WEB_SPECIFIER)` —
// production and the in-suite mirror
// (`tests/unit/client-web-retirement-policy.test.js`) previously each
// hand-copied that same one-line check independently, so a production-only
// regression could leave the mirror's own copy — and its sabotage tests —
// green while production silently diverged; sharing the one implementation
// closes that drift risk, matching this file's convention for every other
// pre-filter above.
const CLIENT_WEB_SPECIFIER = '@clickhouse/client-web';
const CLIENT_WEB_BAN_ROOTS = ['src', 'packages/clickhouse-http', 'tests', 'build'];
for (const rootDir of CLIENT_WEB_BAN_ROOTS) {
  const fullRootDir = path.join(repoRoot, rootDir);
  if (!fs.existsSync(fullRootDir)) continue;
  for (const file of collectFiles(fullRootDir)) {
    const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
    if (relFile.startsWith('packages/clickhouse-http/dist/')) continue; // generated, not source
    checkedFiles += 1;
    const source = fs.readFileSync(file, 'utf8');
    if (!mightReferenceRetiredTopLevelApi(source, [CLIENT_WEB_SPECIFIER])) continue;
    for (const { spec } of findModuleSpecifiers(source, relFile)) {
      if (spec === CLIENT_WEB_SPECIFIER || spec.startsWith(`${CLIENT_WEB_SPECIFIER}/`)) {
        violations.push(`${relFile} → ${spec} (issue #630 Phase 8 Guard 5: @clickhouse/client-web must never be reintroduced — ADR-0005 remains Rejected)`);
      }
    }
  }
}

// Structural manifest/lockfile checks (plan §24) — plain object inspection,
// no parser needed: the vendor dependency, its retired npm scripts, and the
// executable spike directory must all stay absent.
for (const manifestPath of ['package.json', 'packages/clickhouse-http/package.json']) {
  const fullManifestPath = path.join(repoRoot, manifestPath);
  if (!fs.existsSync(fullManifestPath)) continue;
  checkedFiles += 1;
  const manifest = JSON.parse(fs.readFileSync(fullManifestPath, 'utf8'));
  for (const depField of manifestDependencyFields(manifest, CLIENT_WEB_SPECIFIER)) {
    violations.push(`${manifestPath} → ${depField}.${CLIENT_WEB_SPECIFIER} (issue #630 Phase 8 Guard 5: the vendor dependency must not return to any manifest)`);
  }
  if (manifestPath === 'package.json') {
    for (const scriptName of retiredClientSpikeScriptNames(manifest.scripts)) {
      violations.push(`${manifestPath} → scripts.${scriptName} (issue #630 Phase 8 Guard 5: the retired vendor-spike npm scripts must not return)`);
    }
  }
}
const lockPath = path.join(repoRoot, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  checkedFiles += 1;
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lockHasPackage(lock, CLIENT_WEB_SPECIFIER)) {
    violations.push(`package-lock.json → ${CLIENT_WEB_SPECIFIER} (issue #630 Phase 8 Guard 5: the vendor package must not remain installed in the lockfile)`);
  }
}
{
  const spikeDir = path.join(repoRoot, 'tests/spike/clickhouse-client');
  checkedFiles += 1;
  if (fs.existsSync(spikeDir)) {
    violations.push('tests/spike/clickhouse-client → directory exists (issue #630 Phase 8 Guard 5: the executable vendor-spike directory must not be recreated)');
  }
}

// Issue #630 Phase 2 — Rule B: packages/clickhouse-http/src/** must have
// ZERO bare specifiers (an empty allowlist, not just an empty manifest
// `dependencies` object). Root hoists many runtime dependencies already
// (e.g. @preact/signals-core), so a zero-dependency manifest alone would not
// stop package source from importing one undeclared — TypeScript/esbuild
// could still resolve it. This block also catches a browser-root-literal
// import (e.g. `/src/net/ch-client.js`) reaching back into SQL Browser
// source: the generic RULES loop above only inspects specifiers that start
// with '.', so a literal absolute-looking path would otherwise slip past
// Rule A undetected — everything that isn't a relative specifier is a
// violation here, with no exceptions.
const PACKAGE_SRC_DIR = path.join(repoRoot, 'packages/clickhouse-http/src');
if (fs.existsSync(PACKAGE_SRC_DIR)) {
  for (const file of collectFiles(PACKAGE_SRC_DIR)) {
    const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
    checkedFiles += 1;
    const source = fs.readFileSync(file, 'utf8');
    for (const spec of extractSpecifiers(source)) {
      if (spec.startsWith('.')) continue; // relative — governed by Rule A above
      violations.push(`${relFile} → ${spec} (issue #630 Phase 2: clickhouse-http has zero bare package imports)`);
    }
  }
}

// Issue #630 Phase 2 — Rule C (Guard 2, broadened Phase 8 plan §21): SQL
// Browser source must consume the package through its public export only —
// no relative deep import into ANY part of the package directory
// (`packages/clickhouse-http/**`, including generated `dist/**`). This is a
// real TypeScript parse (`findModuleSpecifiers`), NOT the generic RULES
// loop's `extractSpecifiers` regex above (review pass 1 finding): production
// was still running the hand-rolled regex here even though this file's own
// header comment already required the real-parser mechanism for exactly
// this class of escape. A comment sitting between `import`/`export` and the
// specifier, or an escaped string-literal segment (e.g. a hex/unicode escape
// spelling out `../../packages/clickhouse-http/dist/index.js` without ever
// containing that raw substring), both defeat `extractSpecifiers` — it
// captures the still-escaped/comment-adjacent raw source text, which then
// fails to resolve to the real file on disk, so the escape silently slips
// the guard — while a real parse decodes the literal via `node.text` exactly
// like Guard 1, Guard 5, and Rule D below already do for the identical
// reason. No `except` carve-outs apply here (none existed for the old RULES
// entry either).
//
// Review pass 2 (second CI-only timeout occurrence, mirrored by the same
// fix in the in-suite mirror's `beforeAll`): this block originally spawned
// the real-parser check unconditionally for every file — no pre-filter at
// all, unlike Guard 5 (`mightReferenceRetiredTopLevelApi`) and Rule D
// (`mightReferencePackage`) beside it. `mightReferenceForbiddenRelativeDir`
// closes that gap the same accepted-risk way those two already do.
for (const file of collectFiles(path.join(repoRoot, 'src'))) {
  const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
  checkedFiles += 1;
  const source = fs.readFileSync(file, 'utf8');
  if (!mightReferenceForbiddenRelativeDir(source, ['packages/clickhouse-http'])) continue;
  for (const { spec } of findModuleSpecifiers(source, relFile)) {
    if (!spec.startsWith('.')) continue; // bare/package specifiers can't reach src dirs
    const resolved = resolveRelative(file, spec);
    const relResolved = path.relative(repoRoot, resolved).split(path.sep).join('/');
    if (relResolved === 'packages/clickhouse-http' || relResolved.startsWith('packages/clickhouse-http/')) {
      violations.push(`${relFile} → ${spec} (resolved: ${relResolved}; src must not import packages/clickhouse-http — issue #630 Phase 2/8 Guard 2: SQL Browser must use the package public export, never a relative deep import into src/** or generated dist/**)`);
    }
  }
}

// Issue #630 Phase 2 — Rule D (revised Phase 5, plan §8.2): the deep-import
// subpath form (`@altinity/clickhouse-http/...`) is forbidden EVERYWHERE
// under src/** — only the package's "." export is public (contract A4).
// This half is a real TypeScript parse (`findDeepImportSpecifiers`), not a
// specifier-text regex: a hand-rolled scanner stayed vulnerable to
// comment-trivia bypasses no amount of pattern-widening could close (e.g.
// `import/*c*/('@altinity/clickhouse-http/src/client')` or
// `import(/*c*/'@altinity/clickhouse-http/src/client')` never matched
// `\bimport\s*\(\s*['"\`]` because a comment token isn't whitespace) — the
// same real-parser mechanism the bare-specifier half below already needed,
// now applied to both halves of Rule D. Deliberately unconditional on
// `import type`: the deep-import ban applies to a type-only deep import
// exactly as much as a value one (see `findDeepImportSpecifiers`'s own
// comment).
const CLICKHOUSE_HTTP_SPECIFIER = '@altinity/clickhouse-http';
for (const file of collectFiles(path.join(repoRoot, 'src'))) {
  const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
  checkedFiles += 1;
  const source = fs.readFileSync(file, 'utf8');
  // Cheap pre-filter before spawning the real parser — shared with the
  // in-suite mirror (`tests/unit/clickhouse-http-package-policy.test.js`) as
  // `build/lib/check-legacy-owners.mjs`'s `mightReferencePackage` (review
  // pass 2: two independently hand-copied implementations here and in the
  // test suite meant a production-only regression to the old exact-substring
  // gate could leave the test's escaped-specifier sabotage cases green,
  // since they exercised only the test's own copy — see that function's own
  // doc comment for the escape-sequence reasoning).
  const fileMightReferencePackage = mightReferencePackage(source, CLICKHOUSE_HTTP_SPECIFIER);

  if (fileMightReferencePackage) {
    for (const spec of findDeepImportSpecifiers(source, relFile, CLICKHOUSE_HTTP_SPECIFIER)) {
      violations.push(`${relFile} → ${spec} (issue #630 Phase 2: @altinity/clickhouse-http exposes only its "." export — deep imports are forbidden everywhere)`);
    }
  }

  // Issue #630 Phase 5 — Rule D's bare-specifier half now distinguishes two
  // categories of package export (plan §8.2) rather than a blanket
  // net-only ban: TRANSPORT/PROTOCOL APIs (`createClickHouseHttpClient`,
  // `chUrl`, `streamLines`, the response consumers/types, `ClickHouseError`)
  // remain importable only under `src/net/**` — value AND type-only alike —
  // exactly as Phase 2 established; pure LANGUAGE APIs (SQL quoting, the
  // generic type grammar, the shared scanner — `PHASE5_PACKAGE_LANGUAGE_EXPORTS`)
  // may now be imported directly by their real SQL Browser consumers outside
  // `src/net/**` too, but ONLY as a plain named import (value or type-only)
  // of an approved name — a specifier-text regex cannot tell which names a
  // named import binds, so this half needs the real parser
  // (`findPackageImportUsages`). There is no type-only carve-out here:
  // `findPackageImportUsages` reports a type-only named import/export on
  // exactly the same terms as a value one (see its own doc comment), so a
  // transport/protocol name stays `src/net/**`-only no matter how it is
  // referenced — matching the deep-import half above, which was already
  // unconditional on `import type` for the identical reason. This also
  // covers TypeScript's inline import-type expression (`type T =
  // import('pkg').Foo` / `typeof import('pkg')`) — a distinct grammar
  // production none of the other forms' checks can reach, reported
  // unconditionally rather than allowlisted by qualifier (see
  // `findPackageImportUsages`'s own doc comment for why). Inside
  // `src/net/**` every access form/name remains unrestricted, matching
  // existing production usage (`ch-client.ts`, `clickhouse-http-transport.ts`).
  // Issue #630 Phase 8 adds exactly ONE additional, narrower exception on top
  // of this net-only/language-export split (plan §18) — see
  // `PHASE8_NARROW_RULE_D_EXCEPTIONS` below and its own doc comment in
  // `check-legacy-owners.mjs`: `src/application/export-service.ts` alone may
  // named-import exactly `findExceptionFrame`, a transport/protocol export,
  // now that the `ch-client.ts` forwarding gateway it used to resolve through
  // is retired. This is a per-file allowlist entry, not a widened category —
  // no other application module gains protocol/client access.
  if (relFile.startsWith('src/net/')) continue;
  if (!fileMightReferencePackage) continue;
  // Issue #630 Phase 8 (plan §18) — a narrow, PER-FILE, PER-NAME exception:
  // exactly `src/application/export-service.ts` may named-import exactly
  // `findExceptionFrame`, a transport/protocol export that is not on the
  // pure-language allowlist. No other file/name pair is granted this.
  const narrowExceptionNames = PHASE8_NARROW_RULE_D_EXCEPTIONS[relFile] ?? [];
  for (const usage of findPackageImportUsages(source, relFile, CLICKHOUSE_HTTP_SPECIFIER)) {
    if (usage.kind === 'named' && PHASE5_PACKAGE_LANGUAGE_EXPORTS.includes(usage.name)) continue;
    if (usage.kind === 'named' && narrowExceptionNames.includes(usage.name)) continue;
    const label = usage.kind === 'named' ? `named import of '${usage.name}' (transport/protocol API)`
      : usage.kind === 'default' ? 'default import'
        : usage.kind === 'namespace' ? 'namespace import'
          : usage.kind === 'side-effect' ? 'side-effect import'
            : usage.kind === 'dynamic' ? 'dynamic import'
              : usage.kind === 'import-type' ? 'inline import-type expression'
                : 'package re-export gateway';
    violations.push(`${relFile} → ${CLICKHOUSE_HTTP_SPECIFIER} (${label}) (issue #630 Phase 5: outside src/net/**, only a named import of an approved pure-language export is allowed — the transport/client surface and every other access form stay src/net/**-only)`);
  }
}

// Issue #630 Phase 8 (plan §20, Guard 1) — package containment, broadened
// past Rule A/B's original scope (package `src/**` only) to the package's
// own tooling/test surface too: `test/**`, `build.mjs`, `vitest.config.ts`.
// A real-parser scan (`findModuleSpecifiers`), not a hand-rolled regex, for
// the same comment-trivia-bypass reason as Rule D above — "genuinely new
// source analysis" per this file's own header comment and
// `check-legacy-owners.mjs`'s adopted convention.
//
// Three rules, matching the plan exactly:
//   1. a relative import anywhere in these four targets cannot escape the
//      package root (`packages/clickhouse-http/**`) — broader than Rule A,
//      which only bans escaping into SQL Browser's `src/**` specifically;
//   2. runtime `src/**` retains zero bare specifiers — already Rule B,
//      untouched here (this block explicitly skips bare specifiers under
//      `packages/clickhouse-http/src/**` to avoid double-reporting the same
//      violation under two different messages);
//   3. package tooling/tests (`test/**`, `build.mjs`, `vitest.config.ts`)
//      may bare-import only `node:*` or a dependency the package's OWN
//      manifest declares in `devDependencies` — no tool/test may silently
//      consume a root-only hoisted dev package (npm hoists many root dev
//      dependencies into the same `node_modules` tree the package resolves
//      against, so an undeclared import can still resolve locally even
//      though the package's own manifest never asked for it).
{
  const packageRoot = path.join(repoRoot, 'packages/clickhouse-http');
  const packageManifestPath = path.join(packageRoot, 'package.json');
  if (fs.existsSync(packageManifestPath)) {
    const packageManifest = JSON.parse(fs.readFileSync(packageManifestPath, 'utf8'));
    const declaredDevDeps = new Set(Object.keys(packageManifest.devDependencies ?? {}));
    const guard1Targets = ['src', 'test', 'build.mjs', 'vitest.config.ts'].map((p) => path.join(packageRoot, p));
    for (const target of guard1Targets) {
      if (!fs.existsSync(target)) continue;
      const files = fs.statSync(target).isFile() ? [target] : collectFiles(target);
      for (const file of files) {
        const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
        const isRuntimeSrc = relFile.startsWith('packages/clickhouse-http/src/');
        checkedFiles += 1;
        const source = fs.readFileSync(file, 'utf8');
        for (const { spec } of findModuleSpecifiers(source, relFile)) {
          if (spec.startsWith('.')) {
            const resolved = resolveRelative(file, spec);
            const relResolved = path.relative(repoRoot, resolved).split(path.sep).join('/');
            if (relResolved !== 'packages/clickhouse-http' && !relResolved.startsWith('packages/clickhouse-http/')) {
              violations.push(`${relFile} → ${spec} (resolved: ${relResolved}; issue #630 Phase 8 Guard 1: a relative import cannot escape the package root)`);
            }
            continue;
          }
          if (isRuntimeSrc) continue; // Rule B (above) already owns this exact case
          // Package tests legitimately import the package's OWN public name
          // (`@altinity/clickhouse-http`) to exercise the barrel like a real
          // external consumer would (plan §8's "exercise the source public
          // barrel rather than deep-importing private modules") — this is
          // not a root-hoisted dependency escape, it is the package testing
          // itself through its own declared identity.
          if (spec === packageManifest.name) continue;
          if (spec === 'node' || spec.startsWith('node:') || declaredDevDeps.has(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])) continue;
          violations.push(`${relFile} → ${spec} (issue #630 Phase 8 Guard 1: package tooling/tests may bare-import only node:* or a dependency declared in the package's own devDependencies)`);
        }
      }
    }
  }
}

// Issue #630 Phase 8 (plan §22/§23, Guards 3/4) — root-wide top-level
// declaration/re-export ownership for the historical generic
// transport/URL surface (`chUrl`/`createHttpTransport`/`ClickHouseTransport`/
// `TransportDeps`/`TransportRequest`) and the moved progress-stream/
// exception-parsing primitives (`streamLines`/`splitBuffer`/
// `parseExceptionText`/`findExceptionFrame` and their canonical wire/frame
// types), across ALL of SQL Browser `src/**` — broader than Phase 3's
// `PHASE3_LEGACY_OWNER_FILES` former-owner scope (three specific files) and
// broader than Rule D's net-only/language-export split (which governs WHERE
// the package may be imported, not whether a same-named LOCAL declaration or
// forwarding gateway may exist elsewhere). Real production imports of these
// names directly from the package (`chUrl`/`streamLines`/`parseExceptionText`
// in `src/net/**`, `findExceptionFrame` in the one narrow
// `export-service.ts` exception) are exempted by
// `findTransportSurfaceOwnershipViolations`'s own specifier check — see its
// doc comment in `check-legacy-owners.mjs`.
{
  const guard34Names = [...PHASE8_TRANSPORT_SURFACE_NAMES, ...PHASE8_PARSER_SURFACE_NAMES];
  for (const file of collectFiles(path.join(repoRoot, 'src'))) {
    const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
    checkedFiles += 1;
    const source = fs.readFileSync(file, 'utf8');
    if (!mightReferenceRetiredTopLevelApi(source, guard34Names)) continue;
    for (const name of findTransportSurfaceOwnershipViolations(source, relFile, guard34Names, CLICKHOUSE_HTTP_SPECIFIER)) {
      violations.push(`${relFile} → top-level ${name} (issue #630 Phase 8 Guards 3/4: the historical generic transport/URL surface and the moved progress-stream/exception-parsing primitives cannot be re-declared or forwarded locally)`);
    }
  }
}

// Issue #630 Phase 3 — narrow legacy-owner regression rule: the former
// production owners of the moved progress-stream/exception-parsing
// primitives must not regain them — not as a second implementation and not
// as a forwarding wrapper. The detection is a real TypeScript parse (an AST
// identifier/property walk), shared with the unit suite via
// `build/lib/check-legacy-owners.mjs`; see that module for the owner/name
// lists and for why the earlier hand-rolled comment/string/template/regex
// scanner was retired. Deliberately narrower than a repository-wide
// function-name ban (Phase 8 owns broader anti-regrowth hardening): exactly
// the three former owners, exactly the names Phase 3 moved out of them.
// `applyStreamLine` (SQL Browser result policy, never moved) stays allowed:
// it is a different identifier, and the AST walk matches exact names only.
for (const relFile of PHASE3_LEGACY_OWNER_FILES) {
  const file = path.join(repoRoot, relFile);
  if (!fs.existsSync(file)) continue;
  checkedFiles += 1;
  for (const name of findLegacyOwnerViolations(fs.readFileSync(file, 'utf8'), relFile)) {
    violations.push(`${relFile} → regained ${name} (issue #630 Phase 3: the moved stream/exception primitives are owned by @altinity/clickhouse-http — a former owner must not redeclare, re-import, or forward them)`);
  }
}

// Issue #630 Phase 5 — the same narrow former-owner regression rule for the
// two SQL-quoting owners this phase moved: `src/core/format.ts` must not
// regain `sqlString`/`BARE_IDENT`/`quoteIdent`/`qualifyIdent`, and the
// package's own `client.ts` must not regain the retired Phase-4
// `quoteKillQueryId` stopgap. Same shared real-parser helper as Phase 3.
for (const relFile of PHASE5_SQL_QUOTE_OWNER_FILES) {
  const file = path.join(repoRoot, relFile);
  if (!fs.existsSync(file)) continue;
  checkedFiles += 1;
  for (const name of findSqlQuoteOwnerViolations(fs.readFileSync(file, 'utf8'), relFile)) {
    violations.push(`${relFile} → regained ${name} (issue #630 Phase 5: ClickHouse SQL quoting is owned by @altinity/clickhouse-http — a former owner must not redeclare, re-import, or forward it)`);
  }
}
for (const relFile of PHASE5_KILL_STOPGAP_OWNER_FILES) {
  const file = path.join(repoRoot, relFile);
  if (!fs.existsSync(file)) continue;
  checkedFiles += 1;
  for (const name of findKillStopgapOwnerViolations(fs.readFileSync(file, 'utf8'), relFile)) {
    violations.push(`${relFile} → regained ${name} (issue #630 Phase 5: killQuery must quote through the shared public sql-quote.js API — the retired Phase-4 stopgap must not return)`);
  }
}

// Issue #630 Phase 5 — the moved generic-grammar/scanner implementation
// files must not be recreated under SQL Browser src/**, under any name
// inside them: a path-existence check is stronger and simpler than
// source-text matching here, since it catches a full reimplementation
// regardless of what its internals are renamed to.
const PHASE5_DELETED_ROOT_FILES = Object.freeze([
  'src/core/clickhouse-type.ts',
  'src/core/sql-spans.ts',
  'src/core/quoted-span.ts',
]);
for (const relFile of PHASE5_DELETED_ROOT_FILES) {
  checkedFiles += 1;
  if (fs.existsSync(path.join(repoRoot, relFile))) {
    violations.push(`${relFile} → recreated (issue #630 Phase 5: this implementation moved to @altinity/clickhouse-http and must not be recreated under SQL Browser src/**)`);
  }
}

// Issue #630 Phase 7 — the local SQL Browser compatibility transport seam is
// retired: `killQueryWithLease`'s own rewrite (plan §10) onto the package's
// stateless `killQuery` left it with no remaining production caller, so
// there is exactly one generic ClickHouse HTTP transport implementation left
// in the repository (the package's). A path-existence check, same mechanism
// as `PHASE5_DELETED_ROOT_FILES` just above — even an empty or
// differently-implemented file at either path must fail, regardless of its
// contents (plan §29 rollback rule: never "fix" this by reintroducing either
// deleted file).
for (const relFile of PHASE7_DELETED_TRANSPORT_FILES) {
  checkedFiles += 1;
  if (fs.existsSync(path.join(repoRoot, relFile))) {
    violations.push(`${relFile} → recreated (issue #630 Phase 7: the local compatibility transport seam is retired onto @altinity/clickhouse-http and must not be recreated)`);
  }
}

// Issue #630 Phase 7 — ban top-level resurrection of the retired generic
// runQuery/exportQuery/ordinary-killQuery APIs and their request/result
// types, anywhere under SQL Browser src/**. `findRetiredTopLevelApiViolations`
// is declaration-scoped (see its own doc comment in check-legacy-owners.mjs),
// not a blanket identifier walk, so the frozen-lease cancellation path's own
// `client.killQuery(...)` member call (the package's stateless kill) can
// never trip it — no name-based exception needed.
for (const file of collectFiles(path.join(repoRoot, 'src'))) {
  const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
  checkedFiles += 1;
  const source = fs.readFileSync(file, 'utf8');
  if (!mightReferenceRetiredTopLevelApi(source, PHASE7_RETIRED_TOP_LEVEL_NAMES)) continue;
  for (const name of findRetiredTopLevelApiViolations(source, relFile, PHASE7_RETIRED_TOP_LEVEL_NAMES)) {
    violations.push(`${relFile} → top-level ${name} (issue #630 Phase 7: the generic runQuery/exportQuery/ordinary-killQuery APIs are deleted and must not be resurrected)`);
  }
}

if (violations.length) {
  console.error('check-boundaries: architecture violations:');
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}

if (checkedFiles === 0) {
  console.log('check-boundaries: no files under any guarded directory yet');
  process.exit(0);
}
console.log(`check-boundaries: OK (${checkedFiles} file${checkedFiles === 1 ? '' : 's'} across ${activeRules} active rule${activeRules === 1 ? '' : 's'}, no violations)`);
process.exit(0);
