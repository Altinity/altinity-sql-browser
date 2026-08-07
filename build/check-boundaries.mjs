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
// Hand-rolled regex scan, no AST parser: the codebase has no exotic import
// syntax, so scanning for import/export specifiers is enough and keeps this
// a zero-dependency, sub-second pretest step.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  {
    dir: 'src/net/clickhouse-http-transport.ts',
    forbidden: ['src/net/ch-client.ts', 'src/net/oauth.ts',
      'src/net/oauth-config.ts', 'src/application', 'src/ui'],
    why: 'issue #585 Phase 1: the generic transport cannot reach auth/application policy or UI',
  },
  {
    dir: 'src/net/clickhouse-transport.types.ts',
    forbidden: ['src/net/ch-client.ts', 'src/net/oauth.ts',
      'src/net/oauth-config.ts', 'src/application', 'src/ui'],
    why: 'issue #585 Phase 1: the transport contract must not couple to auth/application policy or UI, even type-only',
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
  // package's own src/** implementation files.
  {
    dir: 'src',
    forbidden: ['packages/clickhouse-http/src'],
    why: 'issue #630 Phase 2: SQL Browser must use the package public export',
  },
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
const SPECIFIER_PATTERNS = [
  /\bimport\s+[\w*{}\s,]+\s+from\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[\w*{}\s,]+\s+from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
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
const connectionAuthorityFiles = [
  'src/core/connection-lifecycle.ts',
  'src/application/connection-session.ts',
  'src/net/ch-client.ts',
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

// Issue #585 Phase 1: no file under src/** may import the official
// `@clickhouse/client-web` package (a bare specifier — the `RULES` loop above
// skips those, `if (!spec.startsWith('.')) continue;`, hence this separate
// block). ADR-0005 (docs/ADR-0005-clickhouse-web-client.md) is Rejected, so
// Phases 2-4 (the official-client cutover) do not proceed without a new
// decision — today this bans the import everywhere in `src/`. The single
// allowlist entry names the FUTURE official transport file (does not exist
// yet); the rule is written so it activates correctly the moment that file is
// born, rather than needing a second edit here.
const CLIENT_WEB_SPECIFIER = '@clickhouse/client-web';
const CLIENT_WEB_ALLOWLIST = new Set(['src/net/clickhouse-web-transport.ts']);
for (const file of collectFiles(path.join(repoRoot, 'src'))) {
  const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
  checkedFiles += 1;
  const source = fs.readFileSync(file, 'utf8');
  for (const spec of extractSpecifiers(source)) {
    if (spec !== CLIENT_WEB_SPECIFIER && !spec.startsWith(`${CLIENT_WEB_SPECIFIER}/`)) continue;
    if (CLIENT_WEB_ALLOWLIST.has(relFile)) continue;
    violations.push(`${relFile} → ${spec} (issue #585 Phase 1: only the future official transport file may import @clickhouse/client-web — ADR-0005 is Rejected, Phases 2-4 do not proceed without a new decision)`);
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

// Issue #630 Phase 2 — Rule D: the public package name may be imported by
// bare specifier only under src/net/** — the existing network-layer
// boundary — so src/core, src/workspace, src/dashboard, src/application, or
// UI code cannot bypass that layer merely because the low-level HTTP
// mechanics moved behind a bare package name. The deep-import subpath form
// (`@altinity/clickhouse-http/...`) is forbidden EVERYWHERE under src/** —
// only the package's "." export is public (contract A4).
const CLICKHOUSE_HTTP_SPECIFIER = '@altinity/clickhouse-http';
for (const file of collectFiles(path.join(repoRoot, 'src'))) {
  const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
  checkedFiles += 1;
  const source = fs.readFileSync(file, 'utf8');
  for (const spec of extractSpecifiers(source)) {
    if (spec === CLICKHOUSE_HTTP_SPECIFIER) {
      if (!relFile.startsWith('src/net/')) {
        violations.push(`${relFile} → ${spec} (issue #630 Phase 2: @altinity/clickhouse-http may only be imported under src/net/**)`);
      }
      continue;
    }
    if (spec.startsWith(`${CLICKHOUSE_HTTP_SPECIFIER}/`)) {
      violations.push(`${relFile} → ${spec} (issue #630 Phase 2: @altinity/clickhouse-http exposes only its "." export — deep imports are forbidden everywhere)`);
    }
  }
}

// Issue #630 Phase 3 — narrow legacy-owner regression rule: the former
// production owners of the moved progress-stream/exception-parsing
// primitives must not regain them. This mechanically rejects re-adding a
// `streamLines` forwarding wrapper to the old transport adapter, a
// `StreamCallbacks`/`streamLines` member to the transport contract, or a
// `StreamLine`/`splitBuffer`/`parseExceptionText`/`ExceptionFrame`/
// `findExceptionFrame` declaration to `core/stream.ts` — the "no duplicate
// stream/error implementation remains" contract this phase requires.
// Deliberately narrower than a repository-wide function-name ban (Phase 8
// owns broader anti-regrowth hardening): this names exactly the three former
// owners and the exact identifiers Phase 3 moved out of them.
// `applyStreamLine` stays explicitly allowed (SQL Browser result policy,
// never moved) — the word-boundary match below cannot mistake it for
// `StreamLine` (no boundary between "apply" and "StreamLine", so `\bStreamLine\b`
// never matches inside it).
//
// Comments are stripped (naive block/line-comment regex, matching this
// file's existing regex-only, non-AST approach) before matching, so this
// rule flags only a real code re-declaration/re-import — never this phase's
// own doc comments narrating the move.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
const PHASE3_LEGACY_OWNER_RULES = [
  {
    file: 'src/net/clickhouse-http-transport.ts',
    forbiddenWords: ['streamLines'],
    why: 'issue #630 Phase 3: the transport adapter must not regain a streamLines implementation/member — the package is the one stream owner',
  },
  {
    file: 'src/net/clickhouse-transport.types.ts',
    forbiddenWords: ['StreamCallbacks', 'streamLines'],
    why: 'issue #630 Phase 3: the transport contract must not regain StreamCallbacks or a streamLines member',
  },
  {
    file: 'src/core/stream.ts',
    forbiddenWords: ['StreamLine', 'splitBuffer', 'parseExceptionText', 'ExceptionFrame', 'findExceptionFrame'],
    why: 'issue #630 Phase 3: core/stream.ts must not regain the package-owned StreamLine/splitBuffer/parseExceptionText/ExceptionFrame/findExceptionFrame declarations',
  },
];
for (const rule of PHASE3_LEGACY_OWNER_RULES) {
  const file = path.join(repoRoot, rule.file);
  if (!fs.existsSync(file)) continue;
  checkedFiles += 1;
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  for (const word of rule.forbiddenWords) {
    const re = new RegExp(`\\b${word}\\b`);
    if (re.test(code)) {
      violations.push(`${rule.file} → regained ${word} (${rule.why})`);
    }
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
