// Issue #630 Phase 3 — the narrow legacy-owner ownership check, shared by
// `build/check-boundaries.mjs` (the `check:arch` gate) and
// `tests/unit/clickhouse-http-package-policy.test.js` (the in-suite mirror,
// which imports THIS module rather than maintaining a second copy of the
// scanning algorithm — the two-implementations-that-drift convention was
// retired for this rule after three review passes each found a real lexical
// bypass in the hand-rolled comment/string/template/regex scanner it used).
//
// The check is a real TypeScript parse, not textual matching. typescript@7
// (the native, Go-based compiler) ships no in-process JS parser — the classic
// `ts.createSourceFile(fileName, text, …)` does not exist in its public
// surface — but its `typescript/unstable/sync` API spawns the bundled native
// `tsc` binary (`--api` mode, a synchronous MessagePack RPC channel over
// stdio; see `dist/api/syncChannel.js`) and decodes real parser output into
// walkable JS AST nodes. Fed through `typescript/unstable/fs`'s virtual file
// system, that parses an arbitrary in-memory string deterministically and
// synchronously — comments, strings, template literals, and regex-vs-division
// are resolved by the actual full grammar, so none of the three historical
// scanner bypasses (comment markers inside strings, `//` inside a regex
// literal, a regex literal after a control-flow `)`) is even representable
// here. `typescript` stays a devDependency of the root: this module is
// build/test tooling only and must never be imported by `src/**` or
// `packages/clickhouse-http/**` runtime code.
//
// Scope (post-#643): a shared, narrowly-scoped real-TypeScript-parser
// architecture-source utility module — NOT a generic static-analysis
// framework. It originated with #630's legacy-owner/package-boundary checks
// (below) and, since #643, also hosts two further explicit, named
// source-contract analyzers: `findSidePanelSourceContractViolations` (the
// #587 side-panel registry contract) and
// `findSurfaceLifecycleSourceContractViolations` (the #590 surface-retirement
// coordinator contract). Every exported analyzer in this module owns one
// named, bounded architecture contract; none of them generalizes into a
// vocabulary any caller can extend ad hoc. The paragraph below — computed
// strings/dynamically built property names sitting outside this check's
// threat model — describes `findNamedIdentifierViolations`'s own contract
// specifically (the #630 owner/name-list checks and the thin wrappers over
// it), not a blanket statement about every analyzer this module exports: the
// #643 analyzers' own doc comments state their own (different, narrower or
// broader as appropriate) obfuscation boundaries.
//
// An AST walk flags any Identifier with a moved name — a declaration, an
// import/export specifier, a member reference — and any string-literal
// property/member name (`{ "streamLines": … }`), so a second implementation
// and a forwarding wrapper both fail. Comments and JSDoc are trivia to the
// parser, so prose narrating the move can never false-positive.
//
// Issue #630 Phase 5 — generalized into a small shared AST utility (plan
// §8.3): the Phase 3 owner/name-list check below is now a thin wrapper over
// a parameterized `findNamedIdentifierViolations`, reused for the Phase 5
// former-owner rules (`format.ts` must not regain SQL quoting; the retired
// Phase-4 `quoteKillQueryId` stopgap must not return) — no parallel parser
// implementation, only new owner/name-list DATA. The revised architecture
// Rule D also needs real import/export/dynamic-import SHAPE analysis (which
// names a named import binds; default/namespace/side-effect/dynamic/
// re-export forms), added here as `findPackageImportUsages` for the same
// reason the Phase 3 rule couldn't stay a text scanner: a specifier-text
// regex cannot tell which NAMES a named import binds.

import path from 'node:path';
import { API } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { NodeFlags, SyntaxKind } from 'typescript/unstable/ast';
import * as is from 'typescript/unstable/ast/is';

/** Every symbol Phase 3 moved out of the legacy owners into the package
 *  (`splitBuffer` was absorbed into the package's stream loop rather than
 *  re-exported, but regaining it would equally restore the old surface). */
export const PHASE3_MOVED_NAMES = Object.freeze([
  'streamLines',
  'parseExceptionText',
  'findExceptionFrame',
  'splitBuffer',
  'StreamLine',
  'StreamCallbacks',
  'ProgressMetaColumn',
  'ExceptionFrame',
]);

/** The three former production owners. `src/net/ch-client.ts` is NOT one of
 *  them: it is the sanctioned consumer/migration-plumbing surface and
 *  legitimately imports the moved names from the package. */
export const PHASE3_LEGACY_OWNER_FILES = Object.freeze([
  'src/net/clickhouse-http-transport.ts',
  'src/net/clickhouse-transport.types.ts',
  'src/core/stream.ts',
]);

/** Issue #630 Phase 5 — the SQL-quoting names moved out of `format.ts` into
 *  the package's `sql-quote.ts` (`BARE_IDENT` was private there too, but a
 *  reintroduced private helper of the same name is exactly the same
 *  regrowth risk, so it stays in scope). */
export const PHASE5_SQL_QUOTE_MOVED_NAMES = Object.freeze([
  'sqlString',
  'BARE_IDENT',
  'quoteIdent',
  'qualifyIdent',
]);

/** The one former owner of the moved SQL-quoting helpers. */
export const PHASE5_SQL_QUOTE_OWNER_FILES = Object.freeze(['src/core/format.ts']);

/** Issue #630 Phase 5 — the retired Phase-4 `killQuery` quoting stopgap.
 *  `sqlString` (the sanctioned replacement) is a DIFFERENT identifier and
 *  never trips this rule. */
export const PHASE5_KILL_STOPGAP_MOVED_NAMES = Object.freeze(['quoteKillQueryId']);

/** The one former owner of the retired Phase-4 stopgap. */
export const PHASE5_KILL_STOPGAP_OWNER_FILES = Object.freeze(['packages/clickhouse-http/src/client.ts']);

/** Issue #630 Phase 5 — exactly the package's exported names that are pure
 *  ClickHouse LANGUAGE mechanics (SQL quoting + the generic type grammar +
 *  the shared lexical scanner) — plan §8.2's allowlist. Every other current
 *  package export (`createClickHouseHttpClient`, `chUrl`,
 *  `streamLines`, the response consumers, `ClickHouseError`, and their
 *  types) is transport/protocol and stays `src/net/**`-only. */
export const PHASE5_PACKAGE_LANGUAGE_EXPORTS = Object.freeze([
  'sqlString',
  'quoteIdent',
  'qualifyIdent',
  'scanSpans',
  'Span',
  'SpanKind',
  'LiteralArg',
  'TypeArg',
  'TypeNode',
  'EnumMember',
  'TypeModifiers',
  'parseClickHouseType',
  'unwrapNullable',
  'unwrapLowCardinality',
  'unwrapValueTransparentWrappers',
  'analyzeTypeModifiers',
  'typeBaseName',
  'arrayElement',
  'mapTypes',
  'namedTupleMembers',
  'enumMembers',
  'enumValues',
  'canonicalType',
]);

/** Issue #630 Phase 8 (plan §18) — the ONE narrow, named Rule-D exception:
 *  `src/application/export-service.ts` may named-import exactly
 *  `findExceptionFrame` from `@altinity/clickhouse-http`, even though it sits
 *  outside `src/net/**` and `findExceptionFrame` is a transport/protocol
 *  export (not on `PHASE5_PACKAGE_LANGUAGE_EXPORTS`). This is a per-file,
 *  per-name allowlist, not a broadened category: no other application module
 *  gets protocol/client access, and this file gets no other package name. */
export const PHASE8_NARROW_RULE_D_EXCEPTIONS = Object.freeze({
  'src/application/export-service.ts': Object.freeze(['findExceptionFrame']),
});

// ── Shared real-parser plumbing ─────────────────────────────────────────────

// Issue #643 — one real parser session per CALL, not per FILE. Every prior
// caller of `withParsedSource` (the #630/#642 helpers above/below) parses
// exactly one source at a time, so spawning one native `tsc` child process
// per call was never wasteful for THEM. #643's own surface-lifecycle
// analyzer instead needs one violation pass over the ENTIRE scanned
// `src/**` tree (a hundred-plus files) — one process per file there would
// multiply this module's own documented startup cost by the file count, the
// exact CI-timeout-pressure shape `mightReferencePackage`'s/
// `mightReferenceForbiddenRelativeDir`'s own doc comments already warn
// about for a *parse* (not just a pre-filter) granularity. `withParsedSources`
// is the batch primitive both cases now share: one `API`/one virtual
// filesystem for an arbitrary number of (source, filename) entries, all
// recovered from the SAME parsed snapshot. `withParsedSource` becomes a
// one-entry compatibility wrapper over it — every existing #630/#642 caller
// keeps its original 3-argument call shape and `fn(sourceFile)` callback
// unchanged.
//
// Virtual paths are the entry's own repo-relative path (forward-slash,
// preserving its real extension so the parser selects the right grammar),
// rooted under `/legacy-owner-check/` — collision-proof by construction: two
// distinct real (or synthetic-but-caller-distinct) repo-relative paths can
// never collide, unlike the single-file wrapper's now-removed
// basename-only scheme, which relied on there only ever being one entry to
// namespace at all.
// Issue #592 addendum (Architecture decision 6, post-PR-#672-review) — this
// batch primitive also hands back each file's real TypeScript `checker:
// Checker` (via its `Project`, `snapshot.getDefaultProjectForFile(virtualPath)
// .checker`), alongside the `SourceFile` it always returned. Every prior
// caller's callback still destructures/ignores whatever it likes from a
// two-argument call — `fn(sourceFiles)` (the #630/#642/#587/#590 callers
// above/below, none of which need name-binding resolution) keeps working
// unchanged because JS simply drops an extra call argument a callback's own
// signature never names. The `checkers` map exists so #592's own
// `findShellGuardrailSourceContractViolations` (below) can ask the REAL
// TypeScript binder "what does this identifier resolve to" instead of
// re-deriving JS/TS scope semantics by hand — the root-cause fix for three
// review passes' worth of hand-rolled-scope-walker defects (see this file's
// `## Issue #592` section header comment for the retrospective).
function withParsedSources(entries, fn) {
  const virtualPaths = new Map(); // filename -> virtualPath
  const files = {};
  for (const { source, filename } of entries) {
    const virtualPath = path.posix.join('/legacy-owner-check', filename);
    virtualPaths.set(filename, virtualPath);
    files[virtualPath] = source;
  }
  const api = new API({ fs: createVirtualFileSystem(files) });
  try {
    const snapshot = api.updateSnapshot({ openFiles: [...virtualPaths.values()] });
    const sourceFiles = new Map(); // filename -> SourceFile
    const checkers = new Map(); // filename -> Checker
    for (const [filename, virtualPath] of virtualPaths) {
      const project = snapshot.getDefaultProjectForFile(virtualPath);
      const sourceFile = project?.program.getSourceFile(virtualPath);
      if (!sourceFile) {
        // Fail loud, never silently-clean: an unparseable probe must not read
        // as "no violations".
        throw new Error(`check-legacy-owners: could not parse ${filename}`);
      }
      sourceFiles.set(filename, sourceFile);
      checkers.set(filename, project.checker);
    }
    return fn(sourceFiles, checkers);
  } finally {
    api.close(); // always reap the native child process, on every return path
  }
}

// Parse `source` (claiming to be the repo-relative `filename`) with the real
// TypeScript parser and hand back its root AST node — the original #630
// single-source entry point, now a thin one-entry wrapper over
// `withParsedSources` above. Every existing caller's behavior (including the
// thrown-on-unparseable-source contract) is unchanged; `fn`'s optional SECOND
// parameter (the file's own `Checker`, #592 addendum) is available to any
// future single-source caller that wants it, but no current caller of this
// wrapper does.
function withParsedSource(source, filename, fn) {
  return withParsedSources(
    [{ source, filename }],
    (sourceFiles, checkers) => fn(sourceFiles.get(filename), checkers.get(filename)),
  );
}

/**
 * Parse `source` and return which of `movedNames` it declares or references
 * — a declaration, an import/export specifier, a member reference, or a
 * quoted (non-computed) property/member name (`{ "streamLines": impl }`,
 * `"streamLines"() {}`, the string module-export-name forms) — in
 * `movedNames` order, deduplicated. `filename` is the repo-relative path the
 * source claims to be; files not in `ownerFiles` are out of scope and return
 * `[]` without parsing at all.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated
 * @param {readonly string[]} ownerFiles
 * @param {readonly string[]} movedNames
 * @returns {string[]} the forbidden names found (empty when clean)
 */
export function findNamedIdentifierViolations(source, filename, ownerFiles, movedNames) {
  if (!ownerFiles.includes(filename)) return [];
  const moved = new Set(movedNames);
  return withParsedSource(source, filename, (sourceFile) => {
    const found = new Set();
    const walk = (node) => {
      if (node.kind === SyntaxKind.Identifier && moved.has(node.text)) {
        found.add(node.text);
      }
      // A quoted (non-computed) property/member name is an exact property
      // declaration too: `{ "streamLines": impl }`, `"streamLines"() {}`,
      // and the string module-export-name forms `import { "streamLines" as
      // x }` / `export { x as "streamLines" }` (propertyName/name).
      for (const nameNode of [node.name, node.propertyName]) {
        if (
          nameNode
          && (nameNode.kind === SyntaxKind.StringLiteral
            || nameNode.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
          && moved.has(nameNode.text)
        ) {
          found.add(nameNode.text);
        }
      }
      node.forEachChild(walk);
    };
    walk(sourceFile);
    return movedNames.filter((name) => found.has(name));
  });
}

/**
 * Issue #630 Phase 3's original entry point — an exact-behavior wrapper over
 * `findNamedIdentifierViolations` fixed to the three legacy owners and the
 * Phase 3 moved-name set. Kept under its original name/signature so existing
 * callers (the `check:arch` gate, this rule's own unit suite) are unaffected
 * by the Phase 5 generalization.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated
 * @returns {string[]} the forbidden names found (empty when clean)
 */
export function findLegacyOwnerViolations(source, filename) {
  return findNamedIdentifierViolations(source, filename, PHASE3_LEGACY_OWNER_FILES, PHASE3_MOVED_NAMES);
}

/**
 * Issue #630 Phase 5 — `src/core/format.ts` must not regain
 * `sqlString`/`BARE_IDENT`/`quoteIdent`/`qualifyIdent`.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated
 * @returns {string[]} the forbidden names found (empty when clean)
 */
export function findSqlQuoteOwnerViolations(source, filename) {
  return findNamedIdentifierViolations(source, filename, PHASE5_SQL_QUOTE_OWNER_FILES, PHASE5_SQL_QUOTE_MOVED_NAMES);
}

/**
 * Issue #630 Phase 5 — `packages/clickhouse-http/src/client.ts` must not
 * regain the retired Phase-4 `quoteKillQueryId` stopgap.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated
 * @returns {string[]} the forbidden names found (empty when clean)
 */
export function findKillStopgapOwnerViolations(source, filename) {
  return findNamedIdentifierViolations(source, filename, PHASE5_KILL_STOPGAP_OWNER_FILES, PHASE5_KILL_STOPGAP_MOVED_NAMES);
}

// ── Phase 7 — retired top-level API resurrection guard ──────────────────────
//
// Issue #630 Phase 7 deletes the generic, format-agnostic `runQuery`/
// `exportQuery` functions and their request/result types, plus the ordinary
// mutable-context `killQuery` (distinct from the frozen-lease
// `killQueryWithLease` that survives, and from the package's OWN stateless
// `client.killQuery(...)` member method `killQueryWithLease` now calls
// through — plan §10/§21). Unlike the Phase 3/5 rules above
// (`findNamedIdentifierViolations`, a blanket identifier walk scoped to a
// short former-owner allowlist), this rule cannot be a blanket identifier
// walk: `client.killQuery(...)` is a legitimate, surviving production call
// (inside `killQueryWithLease` itself) whose right-hand side is ALSO a plain
// `killQuery` Identifier node to the parser — a blanket walk would reject the
// exact call the plan requires to keep working. `findRetiredTopLevelApiViolations`
// below instead inspects only `sourceFile.statements` (the module's OWN
// top-level declarations/import-bindings/export-bindings) — a
// PropertyAccessExpression like `client.killQuery` is never a top-level
// statement itself (it's an expression nested inside one), so it structurally
// cannot trip this check; no name-based exception is needed to carve it out.

/** The exact top-level API surface Phase 7 retires. `killQuery` here means
 *  the ORDINARY mutable-context function (`killQuery(ctx, queryId, ...)`)
 *  `ch-client.ts` used to export — never `killQueryWithLease` (a different
 *  identifier) and never the package's own `client.killQuery(...)` member
 *  (never a top-level declaration in SQL Browser source at all). */
export const PHASE7_RETIRED_TOP_LEVEL_NAMES = Object.freeze([
  'runQuery',
  'RunQueryOptions',
  'RunQueryResult',
  'exportQuery',
  'ExportQueryOptions',
  'killQuery',
]);

/** Issue #630 Phase 7 — the two local compatibility transport files this
 *  phase deletes outright (plan §14/§22): `killQueryWithLease`'s own rewrite
 *  onto the package's stateless `killQuery` (plan §10) leaves this transport
 *  with no remaining production caller, so there is exactly one generic
 *  ClickHouse HTTP transport implementation left in the repository (the
 *  package's) and neither path may return, in any form (even empty, even
 *  differently implemented) — a path-existence check, not a content scan. */
export const PHASE7_DELETED_TRANSPORT_FILES = Object.freeze([
  'src/net/clickhouse-http-transport.ts',
  'src/net/clickhouse-transport.types.ts',
]);

/**
 * Cheap textual pre-filter, same accepted-risk convention as
 * `mightReferencePackage` above: a plain substring test against each
 * candidate name. Unlike the package-specifier pre-filter, this deliberately
 * does NOT widen for backslash-escaped spellings — an identifier spelled
 * through a Unicode identifier escape (`runQuery`) is exotic enough,
 * and absent from every real caller in this codebase today, that it stays
 * outside this check's threat model (matching this module's own stated scope
 * — "intentionally obfuscated constructs...are outside this check's threat
 * model"). Gates whether a file is even worth handing to the real parser.
 *
 * @param {string} source
 * @param {readonly string[]} [names]
 * @returns {boolean} true if `source` might declare/bind one of `names`
 */
export function mightReferenceRetiredTopLevelApi(source, names = PHASE7_RETIRED_TOP_LEVEL_NAMES) {
  return names.some((name) => source.includes(name));
}

/**
 * Find every TOP-LEVEL (module-scope) declaration or import/export binding
 * in `source` whose name is one of `names` — a real TypeScript parse that
 * inspects only `sourceFile.statements` (never descending into function/
 * class/block bodies), so this is deliberately narrower than
 * `findNamedIdentifierViolations`'s blanket identifier walk. Covers:
 *   - a top-level function/class/interface/type-alias declaration
 *     (`export function runQuery(...)`, `export interface RunQueryOptions`);
 *   - a top-level const/let/var binding (`export const runQuery = ...`);
 *   - a named import whose LOCAL binding takes one of these names — a
 *     forwarding-alias vector (`import { foo as runQuery } from './x.js'`);
 *   - a named export specifier binding one of these names — a
 *     forwarding-re-export vector (`export { runQuery }` / `export { foo as
 *     runQuery }`, including the `export { x } from 'pkg'` gateway form).
 * A nested reference — a call expression, a property/member access such as
 * `client.killQuery(...)`, a local variable inside a function body — is never
 * a top-level statement and therefore never inspected; this is precisely how
 * the plan's carve-out ("the killQuery guard must not reject
 * client.killQuery(...) inside frozen cancellation") is satisfied, with no
 * separate name-based exception required. Comments/strings/template literals
 * are parser trivia, never AST nodes, so prose narrating the deletion can
 * never false-positive.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated
 * @param {readonly string[]} [names]
 * @returns {string[]} the forbidden names found, in `names` order, deduplicated
 */
export function findRetiredTopLevelApiViolations(source, filename, names = PHASE7_RETIRED_TOP_LEVEL_NAMES) {
  const banned = new Set(names);
  return withParsedSource(source, filename, (sourceFile) => {
    const found = new Set();
    const note = (name) => { if (name && banned.has(name)) found.add(name); };
    for (const stmt of sourceFile.statements) {
      if (
        is.isFunctionDeclaration(stmt) || is.isClassDeclaration(stmt)
        || is.isInterfaceDeclaration(stmt) || is.isTypeAliasDeclaration(stmt)
      ) {
        note(stmt.name && stmt.name.text);
      } else if (is.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (decl.name && decl.name.kind === SyntaxKind.Identifier) note(decl.name.text);
        }
      } else if (is.isImportDeclaration(stmt)) {
        const bindings = stmt.importClause && stmt.importClause.namedBindings;
        if (bindings && is.isNamedImports(bindings)) {
          for (const el of bindings.elements) note(el.name.text);
        }
      } else if (is.isExportDeclaration(stmt)) {
        const clause = stmt.exportClause;
        if (clause && is.isNamedExports(clause)) {
          for (const el of clause.elements) note(el.name.text);
        }
      }
    }
    return names.filter((name) => found.has(name));
  });
}

// ── Phase 8 — general-purpose AST helpers (plan §19.1) ──────────────────────
//
// Issue #630 Phase 8 broadens architecture-guard coverage across five areas
// (plan §19-24) that are all "genuinely new source analysis" per this
// module's own adopted convention: real TypeScript parsing, never a new
// hand-rolled text/regex scanner (the repeated lexical-bypass lesson from
// Phases 3/5/6/7 this module's header comment already documents). Two
// reusable helpers below cover every new Phase-8 guard; no guard gets its own
// bespoke parser walk.

/** Issue #630 Phase 8 (plan §19.1) — every module-specifier-bearing form in
 *  `source`, generically (not filtered to any one package): a static
 *  `import ... from` (with or without a clause, including a bare
 *  side-effect `import 'pkg'`), a static `export ... from` (a re-export
 *  gateway), a dynamic `import(...)` call, and TypeScript's inline
 *  import-type expression (`type T = import('pkg').Foo`, `typeof
 *  import('pkg')`) — the same four forms `findDeepImportSpecifiers`/
 *  `findPackageImportUsages` already recognize above, generalized to report
 *  every specifier found rather than filtering for one target package. The
 *  module specifier itself may be a plain string literal or a
 *  no-substitution template literal, matching every sibling helper in this
 *  module. Used by Phase-8 Guards 1 (package containment) and 5
 *  (`@clickhouse/client-web` reintroduction) so neither needs its own
 *  specifier-extraction regex.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated (used only
 *   for the virtual-file basename/grammar selection)
 * @returns {{spec: string, kind: 'import'|'side-effect'|'re-export'|'dynamic'|'import-type'}[]}
 */
export function findModuleSpecifiers(source, filename) {
  return withParsedSource(source, filename, (sourceFile) => {
    const found = [];
    const specText = (node) => {
      if (
        !node
        || (node.kind !== SyntaxKind.StringLiteral && node.kind !== SyntaxKind.NoSubstitutionTemplateLiteral)
      ) return null;
      return node.text;
    };
    const walk = (node) => {
      if (is.isImportDeclaration(node)) {
        const spec = specText(node.moduleSpecifier);
        if (spec !== null) found.push({ spec, kind: node.importClause ? 'import' : 'side-effect' });
      }
      if (is.isExportDeclaration(node)) {
        const spec = specText(node.moduleSpecifier);
        if (spec !== null) found.push({ spec, kind: 're-export' });
      }
      if (
        is.isCallExpression(node)
        && node.expression
        && node.expression.kind === SyntaxKind.ImportKeyword
      ) {
        const spec = specText(node.arguments[0]);
        if (spec !== null) found.push({ spec, kind: 'dynamic' });
      }
      if (is.isImportTypeNode(node)) {
        const spec = specText(node.argument && node.argument.literal);
        if (spec !== null) found.push({ spec, kind: 'import-type' });
      }
      node.forEachChild(walk);
    };
    walk(sourceFile);
    return found;
  });
}

// ── Issue #642 — fail-closed dynamic-import classification ──────────────────
//
// `findModuleSpecifiers` above (and `findDeepImportSpecifiers`/
// `findPackageImportUsages` before it) all share the same accepted
// convention: a dynamic `import(...)` call whose first argument is not a
// plain string/no-substitution-template literal contributes NOTHING to their
// result — `specText`/`deepSpecifierText`/`isTargetSpecifier` all return
// `null`/`false` for that shape, and the caller's `if (spec !== null)
// push(...)` guard then silently drops it. That is the correct contract for
// those checks (a computed dynamic import naming a package/deep-subpath
// cannot be proven to reach that package, so it cannot be proven to violate
// THEIR rule either) but it is exactly the wrong contract for the generic
// `RULES` boundary in `build/check-boundaries.mjs`: that rule's whole point
// is that an import whose target cannot be statically determined must fail,
// not fall through as if it were absent. `findDynamicImportUsages` is a
// SEPARATE entry point (never a modification of the four existing dynamic-
// import branches above) that reports a discriminated union for every
// dynamic-import call expression AND every TypeScript inline import-type
// expression (`type T = import('x').Foo`, `typeof import('x')` — its own
// `ImportTypeNode` grammar production, textually indistinguishable from a
// dynamic-import call at the `import(...)` shape `mightContainDynamicImport`
// gates on, but a structurally different AST node a plain
// `is.isCallExpression`-only walk never visits), so nothing is ever silently
// dropped: a `{ kind: 'static', spec }` where the caller's existing
// resolution logic can treat `spec` exactly like an ordinary import, and a
// `{ kind: 'uncheckable' }` that must always become a violation in a
// generic-guarded file, regardless of what its argument might eventually
// resolve to. A concatenated expression such as `import('../' + name)` is
// `uncheckable` in full — never reduced to the quoted `'../'` prefix, since
// that half alone proves nothing about the complete runtime specifier.
//
// Review pass 1 finding: an earlier revision of this function walked ONLY
// `is.isCallExpression` nodes, so `type T = import('../workspace/model.js').
// Foo` — an `ImportTypeNode`, never a `CallExpression` — contributed nothing
// at all, silently exempting it from the generic `RULES` loop and Rule B even
// though `mightContainDynamicImport`'s gate (a pure `import\b...\(` trivia
// scan, blind to which AST shape follows) correctly let the file through to
// this function. The RETIRED textual `extractSpecifiers` regex this issue
// replaces (`/\bimport\s*\(\s*[`'"]([^`'"]+)[`'"]/g`) could not distinguish a
// call from an inline type expression either — both are just "the word
// `import` then a paren then a quote" to a regex — so it matched and reported
// this form too, meaning the AST-based replacement had strictly LESS coverage
// than the regex it retired for this one shape. Every import-type expression
// is now classified through the exact same discriminated union as a dynamic
// call: its argument is a `LiteralTypeNode` wrapping a string/no-substitution-
// template literal for the ordinary case (`{ kind: 'static', spec }`); any
// other argument shape (e.g. a bare type reference like `import(Bar).Baz`,
// which parses but can never resolve to a real module specifier) is
// `{ kind: 'uncheckable' }`, matching this function's own fail-closed
// contract rather than silently contributing nothing the way
// `findModuleSpecifiers`'s sibling `'import-type'` branch deliberately does.
//
// `mightContainDynamicImport` is the paired conservative pre-filter (the same
// accepted-risk shape as `mightReferencePackage`/`mightReferenceForbiddenRelativeDir`
// above): it decides whether a file is even worth handing to the expensive
// real-parser call, and it must never inspect or match the module-specifier
// text itself — only whether an `import` keyword could be followed by legal
// trivia (whitespace, a line comment, or a block comment) and then `(`.
// Ambiguity always resolves to `true` (send it to the parser); this is
// deliberately looser than a real grammar check (e.g. it does not verify
// `import` is being used as a call rather than, say, `import.meta`) because
// this gate's only job is to avoid the parser for source that PROVABLY has no
// dynamic import at all — any narrower attempt to also decide the argument's
// shape textually would reopen exactly the lexical-bypass risk this module's
// header comment already warns about.

/**
 * Classify every dynamic `import(...)` call expression AND every TypeScript
 * inline import-type expression (`type T = import('x').Foo`, `typeof
 * import('x')`) in `source` — a real TypeScript parse, never a
 * specifier-text regex. Every such node contributes exactly one result; there
 * is no `if (spec !== null) push(...)` shape here that could silently drop an
 * unsupported argument (contrast `findModuleSpecifiers` above, whose whole
 * point is the opposite: silently skip what it cannot resolve, because ITS
 * callers have no fail-closed contract to uphold). The two node shapes are
 * structurally distinct — a `CallExpression` whose callee is the bare
 * `import` keyword token, versus its own `ImportTypeNode` grammar production
 * — so both are matched explicitly; classification of the specifier argument
 * (a `LiteralTypeNode`'s wrapped literal for the import-type case, in place
 * of a call's own first argument) is otherwise identical for both.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated (used only
 *   for the virtual-file basename/grammar selection)
 * @returns {({kind: 'static', spec: string, pos: number} | {kind: 'uncheckable', pos: number})[]}
 *   `pos` is the matched node's own start offset (`node.getStart(sourceFile)`)
 *   — a stable identity a caller MAY use to de-duplicate the same occurrence
 *   across overlapping guarded-directory rules; it is not a line/column and
 *   is not required in any user-facing diagnostic.
 */
export function findDynamicImportUsages(source, filename) {
  return withParsedSource(source, filename, (sourceFile) => {
    const found = [];
    // Shared classification for both node shapes' specifier-bearing argument:
    // a plain string/no-substitution-template literal is `static`; every
    // other shape — a missing argument, an Identifier, a template literal
    // WITH a substitution, a binary concatenation, a call, a conditional, a
    // parenthesized/computed expression, a bare type reference (the
    // import-type case's own analogous "not actually a literal" shape,
    // e.g. `import(Bar).Baz`), or any future shape this list does not name —
    // is uncheckable. There is deliberately no partial extraction attempt
    // (e.g. reading a template literal's first quasi span): that is precisely
    // the class of bug this issue exists to close (`import('../' + name)`
    // must never be treated as `'../'`).
    const classify = (arg, pos) => {
      if (
        arg
        && (arg.kind === SyntaxKind.StringLiteral || arg.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
      ) {
        found.push({ kind: 'static', spec: arg.text, pos });
      } else {
        found.push({ kind: 'uncheckable', pos });
      }
    };
    const walk = (node) => {
      if (
        is.isCallExpression(node)
        && node.expression
        && node.expression.kind === SyntaxKind.ImportKeyword
      ) {
        classify(node.arguments[0], node.getStart(sourceFile));
      } else if (is.isImportTypeNode(node)) {
        // `node.argument` is expected to be a `LiteralTypeNode` wrapping the
        // actual string/template literal (`.literal`); any other type-node
        // shape there (e.g. a `TypeReferenceNode` from `import(Bar).Baz`)
        // leaves `.literal` undefined, which `classify` already treats as
        // uncheckable — no separate shape check needed here.
        classify(node.argument && node.argument.literal, node.getStart(sourceFile));
      }
      node.forEachChild(walk);
    };
    walk(sourceFile);
    return found;
  });
}

/**
 * Cheap, deliberately over-inclusive textual pre-filter gating the expensive
 * `findDynamicImportUsages` parse: true whenever `source` MIGHT contain a
 * dynamic `import(...)` call — an `import` keyword, at a word boundary on
 * both sides (so it never matches inside a longer identifier like
 * `importFoo`), followed by any amount of ordinary whitespace/line-comment/
 * block-comment trivia and then an opening `(`. Never inspects or matches
 * anything about the argument/specifier — that is exclusively
 * `findDynamicImportUsages`'s job. A false positive (e.g. the literal text
 * `"import("` sitting inside an unrelated string literal) merely costs one
 * wasted parse that then correctly reports no dynamic-import call expression
 * at all; a false negative would silently exempt a real dynamic import from
 * ever reaching the parser, which this gate must never do.
 *
 * Issue #642 review — an earlier revision of this gate hand-rolled its trivia
 * character classes (`[ \t\r\n]` for whitespace, `[^\n]*(?:\n|$)` for a
 * line-comment's extent) and only covered the ASCII subset of what
 * ECMAScript's own grammar treats as WhiteSpace/LineTerminator: real
 * LineTerminators also include a bare CR (not followed by LF), U+2028 LINE
 * SEPARATOR, and U+2029 PARAGRAPH SEPARATOR, and real WhiteSpace also
 * includes VT (`\v`), FF (`\f`), NBSP, ZWNBSP, and every other Unicode
 * `Space_Separator` code point — none of which `[ \t\r\n]`/`[^\n]` covered,
 * so a comment or run of whitespace built from one of them made the gate
 * return `false` for source the real parser (correctly) sees as containing a
 * dynamic import, exempting that file from ever reaching the fail-closed
 * check this issue exists to add. Rather than chase individual code points
 * one at a time (the same trap that produced the gap), this uses regex `\s`
 * for the whitespace/line-terminator alternative: `\s` is not an
 * approximation here, it is ECMA-262-DEFINED to match exactly the union of
 * WhiteSpace and LineTerminator code points (`\t\n\v\f\r` plus the space
 * character, NBSP, ZWNBSP/BOM, U+2028, U+2029, and the rest of Unicode
 * `Space_Separator`) regardless of the `u`/`v` flag, so it is sound by
 * construction rather than by enumeration. The line-comment alternative
 * separately needs its own explicit LineTerminator class, spelled with
 * literal `\u2028`/`\u2029` regex escapes (never raw characters, so the
 * source itself stays free of invisible/hard-to-diff code points) — at both
 * its "not part of the comment" and "ends the comment" positions. `\s`
 * itself is unsuitable there because it also matches plain whitespace (an
 * ordinary space does NOT end a `//` comment, only a real LineTerminator
 * does), so reusing `\s` for that spot would have plain spaces terminate
 * the comment early instead of extending it. (There is no cheaper
 * alternative to a regex here: this module's own header comment already
 * establishes that typescript@7 ships no in-process JS scanner/parser to
 * delegate trivia-skipping to — every parse, including a trivia-only one,
 * would mean spawning the native `tsc` child process this gate exists
 * specifically to avoid paying for on every file.)
 *
 * @param {string} source
 * @returns {boolean}
 */
const DYNAMIC_IMPORT_GATE =
  /\bimport\b(?:\s|\/\/[^\n\r\u2028\u2029]*(?:[\n\r\u2028\u2029]|$)|\/\*[\s\S]*?\*\/)*\(/;

export function mightContainDynamicImport(source) {
  return DYNAMIC_IMPORT_GATE.test(source);
}

/** Issue #630 Phase 8 (plan §19.1) — the plan's own generic vocabulary for
 *  `findRetiredTopLevelApiViolations` above, which already generalizes over
 *  an explicit `names` argument (it is not hardcoded to the Phase 7 retired
 *  API set — see its own doc comment/default parameter). A thin re-export
 *  under that name, not a second implementation: every new Phase-8 guard
 *  that needs "which of these names does this file declare/bind at module
 *  top level" calls this one function.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated
 * @param {readonly string[]} names
 * @returns {string[]} the forbidden names found, in `names` order, deduplicated
 */
export function findTopLevelOwnedDeclarations(source, filename, names) {
  return findRetiredTopLevelApiViolations(source, filename, names);
}

/** Issue #630 Phase 8 (plan §22/§23, Guards 3/4) — root-wide declaration/
 *  re-export ownership for a historical generic-transport/parser name list,
 *  WITH one exemption `findTopLevelOwnedDeclarations` doesn't need: some of
 *  these names (`chUrl`, `streamLines`, `parseExceptionText`,
 *  `findExceptionFrame`, and their canonical wire/frame types) are REAL
 *  package exports that legitimate production code imports directly under
 *  Rule D (`src/net/**`'s unrestricted access, and `export-service.ts`'s one
 *  narrow `findExceptionFrame` exception) — `import { chUrl } from
 *  '@altinity/clickhouse-http'` followed by calling it is the SANCTIONED
 *  shape, not a violation. So a top-level IMPORT whose local binding is one
 *  of `names` is flagged only when its module specifier is something OTHER
 *  than `packageSpecifier` (a forwarding-alias vector smuggling in a
 *  same-named local binding from anywhere else, e.g. `import { foo as chUrl}
 *  from './somewhere.js'`); a top-level DECLARATION or EXPORT (re-export
 *  gateway, `export { chUrl }` / `export { chUrl } from 'anywhere'`) named
 *  one of `names` is ALWAYS flagged, regardless of specifier — a second
 *  implementation and a forwarding wrapper both fail either way.
 *  Declaration-scoped (`sourceFile.statements` only, never descending into
 *  function/class/block bodies), same reasoning as
 *  `findRetiredTopLevelApiViolations` — a nested `client.killQuery(...)`-style
 *  member call or local variable is never inspected.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated
 * @param {readonly string[]} names
 * @param {string} packageSpecifier the exact bare specifier whose import is exempted
 * @returns {string[]} the forbidden names found, in `names` order, deduplicated
 */
export function findTransportSurfaceOwnershipViolations(source, filename, names, packageSpecifier) {
  const watched = new Set(names);
  return withParsedSource(source, filename, (sourceFile) => {
    const found = new Set();
    const note = (name) => { if (name && watched.has(name)) found.add(name); };
    for (const stmt of sourceFile.statements) {
      if (
        is.isFunctionDeclaration(stmt) || is.isClassDeclaration(stmt)
        || is.isInterfaceDeclaration(stmt) || is.isTypeAliasDeclaration(stmt)
      ) {
        note(stmt.name && stmt.name.text);
      } else if (is.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (decl.name && decl.name.kind === SyntaxKind.Identifier) note(decl.name.text);
        }
      } else if (is.isImportDeclaration(stmt)) {
        const specNode = stmt.moduleSpecifier;
        const specText = (specNode.kind === SyntaxKind.StringLiteral
          || specNode.kind === SyntaxKind.NoSubstitutionTemplateLiteral) ? specNode.text : null;
        const bindings = stmt.importClause && stmt.importClause.namedBindings;
        if (bindings && is.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (specText === packageSpecifier) continue; // the sanctioned route
            note(el.name.text);
          }
        }
      } else if (is.isExportDeclaration(stmt)) {
        const clause = stmt.exportClause;
        if (clause && is.isNamedExports(clause)) {
          for (const el of clause.elements) note(el.name.text);
        }
      }
    }
    return names.filter((name) => found.has(name));
  });
}

/** Issue #630 Phase 8 (plan §22) — the historical generic transport/URL
 *  surface Guard 3 protects: `chUrl` is a real package export (exempted via
 *  `findTransportSurfaceOwnershipViolations`'s specifier check above); the
 *  other four never had a legitimate top-level import binding anywhere in
 *  this repository at all, so the exemption is harmless for them too. */
export const PHASE8_TRANSPORT_SURFACE_NAMES = Object.freeze([
  'chUrl',
  'createHttpTransport',
  'ClickHouseTransport',
  'TransportDeps',
  'TransportRequest',
]);

/** Issue #630 Phase 8 (plan §23) — the moved progress-stream/exception-parsing
 *  primitives Guard 4 protects, root-wide (broader than Phase 3's
 *  `PHASE3_LEGACY_OWNER_FILES` former-owner scope above — this list runs
 *  across ALL of `src/**`, not just the three historical owners). */
export const PHASE8_PARSER_SURFACE_NAMES = Object.freeze([
  'streamLines',
  'splitBuffer',
  'parseExceptionText',
  'findExceptionFrame',
  'StreamLine',
  'StreamCallbacks',
  'ProgressMetaColumn',
  'ExceptionFrame',
]);

// ── Shared cheap pre-filter (review pass 2 hardening) ───────────────────────

/**
 * Cheap textual pre-filter, shared by the production `check:arch` gate
 * (`build/check-boundaries.mjs`) and its in-suite mirror
 * (`tests/unit/clickhouse-http-package-policy.test.js`), that decides
 * whether a file is even worth handing to the real-parser checks above
 * (`findDeepImportSpecifiers`/`findPackageImportUsages`) — spawning the
 * native `tsc` child process for every file in the tree is the expensive
 * part, so files that provably cannot reference `packageSpecifier` skip it.
 *
 * A raw substring test alone is unsound: a valid string/template literal can
 * spell the exact same specifier through a JS escape sequence — a hex escape
 * (`@altinity/clickhouse-h\x74tp`), a Unicode escape, or even a
 * per-character identity escape (`\@\a\l\t...`, legal and decodes to the
 * plain character for almost any char that isn't itself a multi-char escape
 * introducer) — none of which contain the RAW substring, so
 * `source.includes(packageSpecifier)` alone would silently skip the real
 * parser for exactly the files that most need it. Every one of those escape
 * forms requires at least one literal backslash in the source, so "no plain
 * substring AND no backslash anywhere in the file" is the only combination
 * that can safely skip the parser-backed checks — any backslash routes the
 * file through them instead, which decode escapes correctly via the real
 * parser's own `node.text`.
 *
 * Previously two independently hand-copied implementations (production and
 * the test suite) mirrored this exact logic; a production-only regression
 * back to the old exact-substring form would have left every
 * escaped-specifier sabotage test green, since the test exercised only its
 * own copy, never production's. Sharing this one implementation closes that
 * gap — there is now only one place this logic can drift from.
 *
 * @param {string} source
 * @param {string} packageSpecifier the exact bare specifier being guarded
 * @returns {boolean} true if `source` might reference `packageSpecifier`
 *   (via a plain substring OR an escape sequence) and must go through the
 *   real-parser checks; false only when it provably cannot
 */
export function mightReferencePackage(source, packageSpecifier) {
  return source.includes(packageSpecifier) || source.includes('\\');
}

/**
 * Cheap textual pre-filter for Rule C / Guard 2's parser-backed relative-
 * import check — the whole-package-directory deep-import ban
 * (`relativeViolationsParserBacked` in the test mirror; the dedicated Guard 2
 * block in `build/check-boundaries.mjs`) — added after that check shipped
 * with NO pre-filter at all (issue #630 Phase 8, review pass 1): it had to
 * parse every file under the scanned tree unconditionally, which was the
 * single most expensive of the cache-warming calls this suite's `beforeAll`
 * makes and, stacked with the other three, pushed CI's more constrained
 * scheduling past even the already-generous 30000ms setup timeout (a second
 * occurrence of the exact CI-only class of failure `mightReferencePackage`
 * above was introduced to fix for Rule D).
 *
 * Same accepted-risk shape as `mightReferencePackage`: a relative specifier
 * can only resolve INTO a directory named `clickhouse-http` (or whatever a
 * future `forbiddenDirs` entry's own leaf segment is) by literally spelling
 * that segment somewhere in its own text, once any escape sequence is
 * decoded — path resolution here is pure textual segment concatenation (via
 * `node:path`, no symlinks), so there is no way to reach that directory
 * without a path component that names it. Matching only each forbidden
 * directory's LAST path segment (rather than its full path, e.g. just
 * `clickhouse-http`, not `packages/clickhouse-http`) is deliberately looser
 * than an exact-path match: the segment need not sit textually adjacent to
 * the rest of the forbidden path in the specifier (e.g.
 * `../other/../clickhouse-http/src` still resolves under
 * `packages/clickhouse-http` without ever spelling the two segments
 * together), so anchoring on the leaf alone keeps this sound for that case
 * too. As with `mightReferencePackage`, a bare substring test alone is
 * unsound against an escaped spelling (a hex/Unicode escape, or a
 * per-character identity escape) — every such form requires at least one
 * literal backslash in the source, so "no forbidden leaf substring AND no
 * backslash anywhere in the file" is the only combination that can safely
 * skip the real-parser check.
 *
 * @param {string} source
 * @param {readonly string[]} forbiddenDirs repo-relative forbidden
 *   directories (e.g. `['packages/clickhouse-http']`)
 * @returns {boolean} true if `source` might contain a relative import
 *   resolving into one of `forbiddenDirs` (via a plain leaf substring OR an
 *   escape sequence) and must go through the real-parser check; false only
 *   when it provably cannot
 */
export function mightReferenceForbiddenRelativeDir(source, forbiddenDirs) {
  if (source.includes('\\')) return true;
  return forbiddenDirs.some((dir) => source.includes(dir.split('/').pop()));
}

// ── Revised Rule D: deep-import subpath detection ────────────────────────────

/**
 * Find every module-specifier string in `source` that names a DEEP subpath
 * of `packageSpecifier` (`${packageSpecifier}/...`) — a real TypeScript
 * parse, not a specifier-text regex. Unlike `findPackageImportUsages` below,
 * this is intentionally unconditional on `import type`/type-only: the
 * deep-import ban (only the package's `.` export is public) applies to a
 * type-only deep import exactly as much as a value one, so there is no
 * type-only carve-out to encode here.
 *
 * Covers every module-specifier-bearing form: a static `import ... from`
 * (with or without a clause — including a bare side-effect `import 'pkg'`),
 * a static `export ... from`, and a dynamic `import(...)` call — matching
 * `findPackageImportUsages`'s own form coverage below. This function exists
 * because a hand-rolled regex scan (`build/check-boundaries.mjs`'s retired
 * `extractSpecifiers`) stayed vulnerable to comment-trivia bypasses no
 * amount of further pattern-widening could close — e.g. a block comment
 * sitting between the `import` keyword and its call parens, or between the
 * open paren and the specifier itself — the exact class of lexical bypass
 * the real parser is immune to by construction (comments are trivia, never
 * AST nodes).
 *
 * The module specifier itself may be a plain string literal OR a
 * no-substitution template literal (`` import(`pkg`) ``), for the same
 * grammar reason `findPackageImportUsages` matches both kinds.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated (used only
 *   for the virtual-file basename/grammar selection)
 * @param {string} packageSpecifier the exact bare specifier whose deep
 *   subpaths are forbidden
 * @returns {string[]} every deep-subpath specifier text found (not deduped —
 *   callers report one violation per occurrence, matching prior behavior)
 */
export function findDeepImportSpecifiers(source, filename, packageSpecifier) {
  const prefix = `${packageSpecifier}/`;
  return withParsedSource(source, filename, (sourceFile) => {
    const found = [];
    const deepSpecifierText = (node) => {
      if (
        !node
        || (node.kind !== SyntaxKind.StringLiteral && node.kind !== SyntaxKind.NoSubstitutionTemplateLiteral)
      ) return null;
      return node.text.startsWith(prefix) ? node.text : null;
    };
    const walk = (node) => {
      if (is.isImportDeclaration(node)) {
        const spec = deepSpecifierText(node.moduleSpecifier);
        if (spec) found.push(spec);
      }
      if (is.isExportDeclaration(node)) {
        const spec = deepSpecifierText(node.moduleSpecifier);
        if (spec) found.push(spec);
      }
      // Dynamic `import('pkg/deep')`: a CallExpression whose callee is the
      // bare `import` keyword token, exactly as `findPackageImportUsages`
      // recognizes it below.
      if (
        is.isCallExpression(node)
        && node.expression
        && node.expression.kind === SyntaxKind.ImportKeyword
      ) {
        const spec = deepSpecifierText(node.arguments[0]);
        if (spec) found.push(spec);
      }
      // TypeScript's inline import-type expression — `type T =
      // import('pkg/deep').Foo` or `typeof import('pkg/deep')` — is a FOURTH
      // module-specifier-bearing form distinct from all three above (it is
      // its own `ImportTypeNode`, never an ImportDeclaration/
      // ExportDeclaration/dynamic-import CallExpression), so none of the
      // three walks above ever visits it. The specifier lives one level
      // deeper than the others: `node.argument` is a `LiteralTypeNode`, and
      // `node.argument.literal` is the actual string/template literal.
      if (is.isImportTypeNode(node)) {
        const spec = deepSpecifierText(node.argument && node.argument.literal);
        if (spec) found.push(spec);
      }
      node.forEachChild(walk);
    };
    walk(sourceFile);
    return found;
  });
}

// ── Revised Rule D: package import shape/name analysis ──────────────────────

/**
 * One usage of `packageSpecifier` found in `source`:
 *   - `{ kind: 'named', name }` — a plain named import/export-specifier
 *     binding, `name` being the ORIGINAL exported name in the package (the
 *     `propertyName` side of an aliased specifier, matching how
 *     `import { x as y }` / `export { x as y } from` bind);
 *   - `{ kind: 'default' }` — a default import;
 *   - `{ kind: 'namespace' }` — a namespace import (`import * as ns from`);
 *   - `{ kind: 'side-effect' }` — a bare `import 'pkg'` with no clause;
 *   - `{ kind: 'dynamic' }` — a dynamic `import('pkg')` call;
 *   - `{ kind: 'reexport-gateway' }` — `export { ... } from 'pkg'` or
 *     `export * from 'pkg'` (bypasses ever binding an import at all);
 *   - `{ kind: 'import-type' }` — TypeScript's inline import-type expression,
 *     `type T = import('pkg').Foo` or `typeof import('pkg')`. This is its
 *     own `ImportTypeNode` grammar production, never an ImportDeclaration/
 *     ExportDeclaration/dynamic-import CallExpression, so none of the other
 *     branches below ever visits it — a real, previously-unhandled parser
 *     gap, not a deliberate omission. Reported unconditionally, regardless
 *     of which member it qualifies into (`import('pkg').Span` included): the
 *     caller's per-name allowlist is specifically for a PLAIN named import
 *     of an approved pure-language export, and an import-type expression is
 *     a different access mechanism, not that form — narrowing this to
 *     inspect the qualifier and allowlist it too would broaden the
 *     documented contract, not just close the gap.
 * `import type`/`export type` declarations and individual type-only
 * specifiers (`import { type X }`) are reported on exactly the same terms as
 * their value counterparts — there is no type-only carve-out. A named
 * specifier's usage is keyed by NAME regardless of `isTypeOnly` (so a
 * type-only reference to an approved pure-language export, e.g.
 * `import type { Span }`, is not something the caller need forbid, exactly
 * like the value form), but a type-only reference to anything else — a
 * transport/protocol name, or any default/namespace/side-effect/dynamic/
 * re-export form — is reported exactly like the value form would be. An
 * earlier revision of this rule treated type-only access as inherently
 * exempt (erasure before bundling — see `build/e2e-serve.mjs`'s
 * type-stripping and esbuild's own `import type` elision — was read as "no
 * real package access"), but the boundary this rule enforces is a
 * SOURCE-level ownership boundary over which subsystem may even NAME a
 * transport/protocol export, not a bundle-output boundary, so erasure at
 * build time does not exempt it. This matches `findDeepImportSpecifiers`
 * above, which was already unconditional on `import type` for the identical
 * reason.
 *
 * The module specifier itself may be a plain string literal OR a
 * no-substitution template literal (`` import(`pkg`) ``) — only a dynamic
 * `import(...)` call can syntactically take the latter (a static
 * import/export declaration's module specifier must be a StringLiteral per
 * grammar), but matching both kinds here, like the sibling
 * `findNamedIdentifierViolations` already does for property/member names,
 * keeps this one check from being the only AST matcher in the file that
 * still assumes quotes.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated (used only
 *   for the virtual-file basename/grammar selection — this function is not
 *   scoped to any owner-file allowlist, unlike the former-owner checks above)
 * @param {string} packageSpecifier the exact bare specifier to look for
 * @returns {{kind: string, name?: string}[]}
 */
export function findPackageImportUsages(source, filename, packageSpecifier) {
  return withParsedSource(source, filename, (sourceFile) => {
    const found = [];
    const isTargetSpecifier = (node) =>
      !!node
      && (node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
      && node.text === packageSpecifier;
    const walk = (node) => {
      if (is.isImportDeclaration(node) && isTargetSpecifier(node.moduleSpecifier)) {
        const clause = node.importClause;
        if (!clause) {
          found.push({ kind: 'side-effect' });
        } else {
          // Deliberately unconditional on `clause.isTypeOnly`/`el.isTypeOnly`:
          // a type-only reference is reported on exactly the same terms as a
          // value one (see this function's own doc comment above) — the
          // per-name allowlist filtering happens in the caller, keyed by
          // `name` alone, so a type-only named import of an approved
          // pure-language export still passes there while a type-only named
          // import of anything else still gets flagged.
          if (clause.name) found.push({ kind: 'default' });
          const bindings = clause.namedBindings;
          if (bindings && is.isNamespaceImport(bindings)) {
            found.push({ kind: 'namespace' });
          } else if (bindings && is.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              found.push({ kind: 'named', name: (el.propertyName ?? el.name).text });
            }
          }
        }
      }
      // Deliberately unconditional on `node.isTypeOnly` too, for the same
      // reason: `export type { X } from 'pkg'` is a re-export gateway exactly
      // like `export { X } from 'pkg'` is.
      if (is.isExportDeclaration(node) && isTargetSpecifier(node.moduleSpecifier)) {
        found.push({ kind: 'reexport-gateway' });
      }
      // Dynamic `import('pkg')`: a CallExpression whose callee is the bare
      // `import` keyword token — the real parser's own representation, not a
      // regex guess at parenthesized text.
      if (
        is.isCallExpression(node)
        && node.expression
        && node.expression.kind === SyntaxKind.ImportKeyword
        && isTargetSpecifier(node.arguments[0])
      ) {
        found.push({ kind: 'dynamic' });
      }
      // `type T = import('pkg').Foo` / `typeof import('pkg')`: an
      // `ImportTypeNode` whose `argument` is a `LiteralTypeNode` wrapping the
      // actual string/template literal — one level deeper than every other
      // form above, and structurally distinct from all of them (see this
      // function's own doc comment for why no other branch can reach it).
      if (is.isImportTypeNode(node) && isTargetSpecifier(node.argument && node.argument.literal)) {
        found.push({ kind: 'import-type' });
      }
      node.forEachChild(walk);
    };
    walk(sourceFile);
    return found;
  });
}

// Issue #630 Phase 8 (plan §24, Guard 5) — the three plain-object structural
// predicates behind the manifest/lockfile/script half of the Guard 5 check
// (`build/check-boundaries.mjs`'s CLIENT_WEB_SPECIFIER block). Unlike every
// AST-backed check above, these need no parser — they inspect already-parsed
// JSON shapes — but they still belong here, not duplicated inline in both
// `build/check-boundaries.mjs` and its mirror
// `tests/unit/client-web-retirement-policy.test.js`: that file used to
// reimplement the exact same three booleans as its own "sabotage" test
// fixtures, which could only ever prove its OWN copy was self-consistent,
// never that the real production check still matched. Exporting the real
// predicates and having both call sites use them removes that drift risk
// outright, the same "one implementation" convention the AST checks above
// already follow.

/** Returns the dependency field names in `manifest` (a parsed package.json-
 *  shaped object) that declare `specifier`, out of the four fields npm
 *  recognizes — empty when none do. The production caller pushes one
 *  violation per returned field (preserving its existing per-field message);
 *  a caller that only needs the aggregate yes/no (e.g. a sabotage probe)
 *  checks `.length > 0`. */
export function manifestDependencyFields(manifest, specifier) {
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .filter((field) => Object.prototype.hasOwnProperty.call(manifest[field] ?? {}, specifier));
}

/** True when `lock` (a parsed package-lock.json-shaped object) still
 *  installs `specifier` anywhere under `lock.packages`. */
export function lockHasPackage(lock, specifier) {
  return Object.keys(lock.packages ?? {}).some((k) => k.endsWith(`node_modules/${specifier}`));
}

/** Returns the script names in `scripts` (a package.json `scripts` map)
 *  that are one of the retired issue #585 vendor-spike comparison-harness
 *  npm scripts issue #630 Phase 8 deleted (`check:client-spike:evidence`, or
 *  any `test:client-spike*` variant) — empty when none remain. */
export function retiredClientSpikeScriptNames(scripts) {
  return Object.keys(scripts ?? {}).filter((s) => s === 'check:client-spike:evidence' || s.startsWith('test:client-spike'));
}

// ── Issue #643 — parser-backed side-panel / surface-lifecycle source
// contracts ───────────────────────────────────────────────────────────────
//
// `tests/unit/side-panel-source-contract.test.ts` and
// `tests/unit/surface-lifecycle-arch.test.ts` used to preprocess source with
// a hand-rolled two-pass regex comment stripper
// (`/\*[\s\S]*?\*\//g` then `/(^|[^:"'`])\/\/.*$/gm`) before applying their
// own textual assertions. That stripper is unsound in the direction that
// matters most for an architecture GUARD: the block-comment pass runs
// BEFORE line-comment removal, so a `/*`-shaped substring sitting inside a
// real `//` comment (e.g. `// documentation mentioning src/core/**`) can
// make the block pass consume every real line of code up to the next
// genuine `*/`, deleting a real violation before either test's assertions
// ever see it — exactly backwards for a check whose entire job is to catch
// code a reviewer might miss. Below replaces both stripping/scanning
// implementations with real-TypeScript-parser-backed analyzers, sharing the
// same `withParsedSources`/`withParsedSource` plumbing the #630/#642 checks
// above already use — comments, strings, template literals, and
// regex-vs-division are resolved by the actual grammar, so none of the
// stripper's lexical-bypass shapes is even representable in the AST these
// analyzers walk.
//
// `findSidePanelSourceContractViolations` and
// `findSurfaceLifecycleSourceContractViolations` are the two public
// entrypoints (mirroring the `SidePanelRule`/`SurfaceLifecycleRule` unions
// `build/lib/check-legacy-owners.d.mts` declares); every other export in
// this section is an internal building block composed differently by each
// rule — per this module's own stated policy, they are NOT collapsed into
// one generic vocabulary matcher, because the six side-panel rule groups and
// the five surface-lifecycle rule groups each have genuinely different
// literal/structural semantics (exact-value literal comparison vs. broad
// contiguous-substring detection vs. structural chain/call-shape matching).

/** Every AST node kind whose `.text` is a real decoded source string this
 *  module's broad-substring/exact-value checks may safely inspect. This is a
 *  DELIBERATE allowlist, not "every node with a `.text` field": `SourceFile`
 *  itself also carries a `.text` property (the file's entire raw content,
 *  comments included) — checking it unconditionally would silently
 *  reintroduce exactly the "matches inside a comment" defect this whole
 *  migration exists to close, since it sits above and outside the parser's
 *  own trivia/AST distinction. Restricting to these leaf literal/identifier
 *  kinds means every match found this way is provably a real code token, not
 *  raw file text. */
const TEXTUAL_LEAF_KINDS = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
]);

/** The two literal kinds a "complete parser value equals X" exact-match rule
 *  ever accepts — a plain string literal or a no-substitution template
 *  literal (`` `library` ``), matching every sibling exact-value check
 *  elsewhere in this module (e.g. `findNamedIdentifierViolations`'s own
 *  quoted-property-name arm). A substitution template (`` `${x}` ``) is
 *  never one node with one decoded `.text` — it has no single "complete
 *  value" a parser can hand back — so it is correctly never eligible here. */
const EXACT_LITERAL_KINDS = new Set([SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral]);

/** Depth-first pre-order walk of `root` and every descendant, calling
 *  `visit(node)` once per node (including `root` itself). Deliberately
 *  unconditional — `visit`'s return value never prunes recursion — because
 *  every #643 rule below wants "the whole subtree", never "the whole
 *  subtree except nodes underneath the first match": e.g. the ordering
 *  rule's own nested-scope requirement (a retirement call visible to BOTH
 *  its own enclosing scope and every scope that contains it) depends on
 *  this never stopping early. */
function walkTree(root, visit) {
  const step = (node) => {
    visit(node);
    node.forEachChild(step);
  };
  step(root);
}

/** True when `node` is one of `EXACT_LITERAL_KINDS` and its complete decoded
 *  value is exactly one of `targets` (a `Set<string>`). Because this checks
 *  the AST NODE KIND, not the node's syntactic position, it identically
 *  matches an expression-position literal (`const id = "library"`) and a
 *  type-position one (`type Pref = 'library'`, a `StringLiteral` sitting
 *  inside a `LiteralTypeNode`) — a plain unscoped tree walk reaches both, so
 *  none of the exact-value rules below need (or have) a separate
 *  type-position branch: restricting a walk to "expression-context nodes
 *  only" is precisely the narrowing this helper's callers must avoid. */
function exactLiteralMatch(node, targets) {
  return !!node && EXACT_LITERAL_KINDS.has(node.kind) && targets.has(node.text);
}

/** True when `node` is a plain (non-private) identifier whose complete text
 *  is exactly one of `targets`. Matches a declaration, a reference, a
 *  property-access `.name`, or a destructuring binding's `.name` identically
 *  — they are all the same AST node kind to this check, by construction of
 *  a blanket tree walk. */
function exactIdentifierMatch(node, targets) {
  return !!node
    && (node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.PrivateIdentifier)
    && targets.has(node.text);
}

/**
 * The last (innermost-to-outermost, i.e. rightmost-in-source) `count`
 * identifier names of a property-access chain ending at `expr` — e.g. for
 * `app.shell.sidePanel.value`, `terminalNames(expr, 2)` returns
 * `['sidePanel', 'value']` regardless of how many segments precede them.
 * Stops (returning fewer than `count` names) the moment the chain hits
 * anything other than a `PropertyAccessExpression` or a terminal
 * `Identifier`/`PrivateIdentifier` — an `ElementAccessExpression`, a call, a
 * parenthesized expression, etc. — so a computed/dynamic segment anywhere in
 * the chain correctly makes the match fail rather than guessing past it.
 * Shared by every #643 rule that cares only about a chain's OWN terminal
 * segments, not its full length or receiver (member-terminal matching):
 * teardown calls, the private-signal `.value` write rule, and the
 * `app.ts` side-panel comparison rule.
 *
 * @param {object} expr
 * @param {number} count
 * @returns {string[]}
 */
function terminalNames(expr, count) {
  const names = [];
  let current = expr;
  while (current && names.length < count) {
    if (current.kind === SyntaxKind.PropertyAccessExpression) {
      names.unshift(current.name.text);
      current = current.expression;
    } else if (current.kind === SyntaxKind.Identifier || current.kind === SyntaxKind.PrivateIdentifier) {
      names.unshift(current.text);
      current = null;
    } else {
      current = null;
    }
  }
  return names;
}

/** Unwrap every transparent cast/assertion wrapper the plan names around a
 *  `currentWorkspace = null` RHS — `ParenthesizedExpression`, `AsExpression`
 *  (`null as never`), `SatisfiesExpression` (`null satisfies never`),
 *  `NonNullExpression` (`null!`), and `TypeAssertionExpression`
 *  (`<never>null`) — returning the innermost expression a cast-bypassing
 *  write can never hide behind. Deliberately does NOT unwrap a
 *  `BinaryExpression` (`null ?? fallback`): that operator introduces genuine
 *  conditional/fallback semantics, so the actual invariant this rule
 *  enforces — "this property was set to a bare null-equivalent value" — no
 *  longer holds once a `??` is present, and treating it as transparent would
 *  be a correctness bug, not extra coverage. */
function unwrapNullEquivalentWrappers(expr) {
  let current = expr;
  while (current) {
    if (
      current.kind === SyntaxKind.ParenthesizedExpression
      || current.kind === SyntaxKind.AsExpression
      || current.kind === SyntaxKind.SatisfiesExpression
      || current.kind === SyntaxKind.NonNullExpression
      || current.kind === SyntaxKind.TypeAssertionExpression
    ) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

/** One violation both #643 analyzers report — matches
 *  `build/lib/check-legacy-owners.d.mts`'s `SourceContractViolation` DTO
 *  exactly (a plain-data shape, no `SourceFile`/`Node` ever crosses this
 *  boundary). `pos` is the offending node's own `getStart(sourceFile)` (or
 *  `0` for a whole-file "required construct is entirely absent" finding,
 *  which names no single node) — a stable, deterministic identity, not a
 *  line/column. */
function makeViolation(rule, filename, pos, detail) {
  return { rule, filename, pos, detail };
}

// ── Side-panel source contract (#587 AC5 regression backstop) ──────────────

const WORKBENCH_SESSION_FILE = 'src/ui/workbench/workbench-session.ts';
const APP_PREFERENCES_FILE = 'src/application/app-preferences.ts';
const STATE_FILE = 'src/state.ts';
const APP_FILE = 'src/ui/app.ts';
const APP_SHELL_FILE = 'src/ui/app-shell.ts';
const SIDE_PANELS_CORE_FILE = 'src/core/side-panels.ts';

/** #276/#587 — `app-preferences.ts` may never hard-code one of the registry's
 *  own panel-id literals; its `sidePanel` preference stays typed as
 *  `SidePanelKey`, derived from the manifest. */
export const SIDE_PANEL_APP_PREFERENCES_IDS = Object.freeze(['library', 'databases', 'dashboards']);
/** #587 — `state.ts` may never hard-code one of the registry's own display
 *  labels; labels belong to the registry, not the state model. */
export const SIDE_PANEL_STATE_LABELS = Object.freeze(['Databases', 'Dashboards', 'Library', 'History']);
/** #587/#600 — `app-shell.ts` may never hard-code one of the registry's own
 *  panel ids as a literal. */
export const SIDE_PANEL_APP_SHELL_IDS = Object.freeze(['databases', 'dashboards', 'library', 'history']);
/** #600 — `app-shell.ts` may never name one of the four concrete panel-def
 *  symbols the registry composes instead. */
export const SIDE_PANEL_APP_SHELL_DEFS = Object.freeze([
  'databasesPanelDef', 'dashboardsPanelDef', 'libraryPanelDef', 'historyPanelDef',
]);
/** #600 (round 2) — `app-shell.ts` may never name one of the two concrete
 *  upper-pane host accessors the registry's own `entries` should supply
 *  instead. */
export const SIDE_PANEL_APP_SHELL_HOSTS = Object.freeze(['databasesHost', 'dashboardsHost']);
/** #587 — `side-panels.ts`'s own derived pane-id type aliases
 *  (`UpperPanelId`/`LowerPanelId`/etc.) may never contain a hand-written
 *  protected literal panel id — the whole point of deriving them from
 *  `SIDE_PANELS` is that adding a manifest row is the only thing that grows
 *  either union. */
export const SIDE_PANEL_TYPE_ALIAS_IDS = Object.freeze(['databases', 'dashboards', 'library', 'history']);
/** #587 — `app.ts` may never directly string-compare `sidePanel.value`; it
 *  must address panels only through `app.shell.sidePanels`. */
export const SIDE_PANEL_APP_COMPARISON_VALUES = Object.freeze(['saved', 'history', 'library']);

/** #587 AC5 — `workbench-session.ts` must never spell the contiguous raw
 *  string `sidePanel` in real code: not as an identifier, a string/template
 *  literal, a regex literal, or a computed-element-access argument. This is
 *  DELIBERATELY a broad contiguous-substring check (not an exact-value
 *  check like the panel-id/label rules below) — it preserves today's
 *  `/sidePanel/` raw-regex contract, which flags ANY occurrence containing
 *  that spelling, e.g. `sidePanelAlias`, not only the bare word. Comments
 *  are trivia the parser never hands to `TEXTUAL_LEAF_KINDS`, so prose
 *  explaining the invariant can never false-positive. */
function workbenchSidePanelMentionViolations(sourceFile, filename) {
  const violations = [];
  walkTree(sourceFile, (node) => {
    if (TEXTUAL_LEAF_KINDS.has(node.kind) && typeof node.text === 'string' && node.text.includes('sidePanel')) {
      violations.push(makeViolation(
        'workbench-sidepanel-mention', filename, node.getStart(sourceFile),
        'contiguous "sidePanel" spelling found in real code (identifier/string/template/regex/computed-access)',
      ));
    }
  });
  return violations;
}

/**
 * A real strict-equality (`===`) `BinaryExpression` where one operand is an
 * exact-value literal in `literalTargets` and the other satisfies
 * `chainPredicate` — in EITHER operand order (`value === 'x'` and
 * `'x' === value` both match), and under any quote style (a string vs. a
 * no-substitution template literal decode to the identical `.text`, so
 * quote-style support falls out of the AST representation for free — no
 * separate quote-style branch is needed or present). Shared by the
 * workbench `history`-comparison rule (`chainPredicate` always true — ANY
 * other operand counts) and the `app.ts` `sidePanel.value` comparison rule
 * (`chainPredicate` requires the terminal two-segment chain). This is a
 * deliberate STRENGTHENING over today's one-directional, single-quote-only
 * regexes (`/===\s*'history'/`, `/sidePanel\.value\s*===\s*'(saved|history|
 * library)'/`) — not a preservation of an existing bidirectional/
 * multi-quote-style contract, since neither existed before.
 *
 * @param {object} sourceFile
 * @param {string} filename
 * @param {string} rule
 * @param {readonly string[]} literalTargets
 * @param {(expr: object) => boolean} chainPredicate
 * @param {(literalText: string) => string} detailFor
 * @returns {object[]}
 */
function strictEqualityLiteralViolations(sourceFile, filename, rule, literalTargets, chainPredicate, detailFor) {
  const targets = new Set(literalTargets);
  const violations = [];
  walkTree(sourceFile, (node) => {
    if (node.kind !== SyntaxKind.BinaryExpression || node.operatorToken.kind !== SyntaxKind.EqualsEqualsEqualsToken) return;
    let literalSide = null;
    let otherSide = null;
    if (exactLiteralMatch(node.left, targets)) {
      literalSide = node.left;
      otherSide = node.right;
    } else if (exactLiteralMatch(node.right, targets)) {
      literalSide = node.right;
      otherSide = node.left;
    } else {
      return;
    }
    if (!chainPredicate(otherSide)) return;
    violations.push(makeViolation(rule, filename, node.getStart(sourceFile), detailFor(literalSide.text)));
  });
  return violations;
}

/** Every node in `EXACT_LITERAL_KINDS` whose complete value is exactly one of
 *  `targetsArr` is a violation of `rule` — the shared implementation behind
 *  the app-preferences/state/app-shell-panel-id exact-value rules (#643
 *  mandatory addition 1: because this is an UNSCOPED tree walk, it matches a
 *  type-position literal, e.g. `type Pref = 'library'`, on exactly the same
 *  terms as an expression-position one, e.g. `const id = "library"` — see
 *  `exactLiteralMatch`'s own doc comment). Deliberately does NOT flag a
 *  longer literal merely CONTAINING one of `targetsArr` as a substring
 *  (`"pick 'library' now"` stays clean) — the precision change every one of
 *  these rules' plan sections documents relative to today's raw
 *  single-quoted substring regexes. */
function exactLiteralRuleViolations(sourceFile, filename, rule, targetsArr) {
  const targets = new Set(targetsArr);
  const violations = [];
  walkTree(sourceFile, (node) => {
    if (exactLiteralMatch(node, targets)) {
      violations.push(makeViolation(rule, filename, node.getStart(sourceFile), `protected literal value "${node.text}"`));
    }
  });
  return violations;
}

/** Every node that is either an exact-value identifier OR an exact-value
 *  literal spelling one of `targetsArr` is a violation of `rule` — the
 *  app-shell panel-DEFINITION rule ("a real identifier or parser-recognized
 *  literal token spelling the concrete symbol remains a violation"), unlike
 *  the literal-only exact-value rule above. */
function exactIdentifierOrLiteralRuleViolations(sourceFile, filename, rule, targetsArr) {
  const targets = new Set(targetsArr);
  const violations = [];
  walkTree(sourceFile, (node) => {
    if (exactIdentifierMatch(node, targets) || exactLiteralMatch(node, targets)) {
      violations.push(makeViolation(rule, filename, node.getStart(sourceFile), `concrete symbol "${node.text}" referenced in real code`));
    }
  });
  return violations;
}

/** `app-shell.ts`'s concrete-host rule — `databasesHost`/`dashboardsHost`
 *  must never be named. Combines three independent shapes into one rule
 *  (plan §"concrete hosts"): (1) an exact-value identifier — covers dot
 *  access (`host.databasesHost`), optional access (`host?.dashboardsHost`),
 *  and destructuring (`const { databasesHost } = hosts`), since all three
 *  are the SAME AST node kind (a plain `Identifier`) to an unscoped walk;
 *  (2) an `ElementAccessExpression` whose argument is an exact-value
 *  string/no-substitution-template literal — `host['dashboardsHost']` /
 *  `` host[`databasesHost`] ``, the two forms `findNamedIdentifierViolations`
 *  intentionally does not cover (this rule extends coverage for exactly
 *  these two names, without changing that shared helper globally — plan
 *  ruling); (3) preserving today's broad CONTIGUOUS `.databasesHost`/
 *  `.dashboardsHost` literal-code substring behavior, but now scoped to an
 *  actual literal TOKEN rather than the whole raw file text — a string/
 *  template literal whose value happens to contain the dotted spelling
 *  (e.g. prose mentioning `.databasesHost`) still trips this rule, exactly
 *  as today's substring regex would, while a comment saying the same thing
 *  does not (trivia). Dynamic construction (`host[prefix + 'Host']`) stays
 *  provably out of scope: it is neither an exact-value identifier nor an
 *  `ElementAccessExpression` with a literal argument, and no constant
 *  folding is attempted. */
function appShellHostAccessorViolations(sourceFile, filename) {
  const targets = new Set(SIDE_PANEL_APP_SHELL_HOSTS);
  const violations = [];
  walkTree(sourceFile, (node) => {
    if (exactIdentifierMatch(node, targets)) {
      violations.push(makeViolation(
        'app-shell-host-accessor', filename, node.getStart(sourceFile),
        `concrete host accessor "${node.text}" named directly`,
      ));
      return;
    }
    if (node.kind === SyntaxKind.ElementAccessExpression && exactLiteralMatch(node.argumentExpression, targets)) {
      violations.push(makeViolation(
        'app-shell-host-accessor', filename, node.getStart(sourceFile),
        `concrete host accessor "${node.argumentExpression.text}" named via computed element access`,
      ));
      return;
    }
    if (TEXTUAL_LEAF_KINDS.has(node.kind) && typeof node.text === 'string') {
      for (const name of targets) {
        if (node.text.includes(`.${name}`)) {
          violations.push(makeViolation(
            'app-shell-host-accessor', filename, node.getStart(sourceFile),
            `literal token spells the contiguous accessor ".${name}"`,
          ));
          break;
        }
      }
    }
  });
  return violations;
}

/** `side-panels.ts`'s type-alias rule: walk actual `TypeAliasDeclaration`
 *  nodes (never the retired type-alias-extraction regex). Requires at least
 *  one alias to exist at all (a total-removal regression — deleting every
 *  derived pane-id type alias — must not silently read as "zero violations
 *  found"), and flags any protected literal panel id sitting anywhere in an
 *  alias's `.type` subtree OR its `.typeParameters` subtree (each type
 *  parameter's own `extends`/default clause) — deliberately scoped to those
 *  two subtrees, not the whole file, because the file's real, authoritative
 *  `SIDE_PANELS` manifest array legitimately spells these exact literals
 *  (`{ id: 'databases', pane: 'upper' }`) outside any type alias, and must
 *  stay clean. A defaulted generic type parameter (`type Probe<T =
 *  SidePanelId> = T | 'databases';`) does not exempt the alias from either
 *  check, and neither does a literal sitting ONLY inside a type parameter's
 *  own constraint/default and never in `.type` at all (`type Probe<T extends
 *  'databases'> = T;`) — pass-2 finding: the original walk covered `.type`
 *  but never `.typeParameters`, so a constraint-only literal was invisible. */
function sidePanelsTypeAliasViolations(sourceFile, filename) {
  const targets = new Set(SIDE_PANEL_TYPE_ALIAS_IDS);
  const violations = [];
  let aliasCount = 0;
  const scanSubtree = (root, aliasName) => {
    if (!root) return;
    walkTree(root, (inner) => {
      if (exactLiteralMatch(inner, targets)) {
        violations.push(makeViolation(
          'side-panels-type-alias', filename, inner.getStart(sourceFile),
          `type alias "${aliasName}" contains protected literal panel id "${inner.text}"`,
        ));
      }
    });
  };
  walkTree(sourceFile, (node) => {
    if (node.kind !== SyntaxKind.TypeAliasDeclaration) return;
    aliasCount += 1;
    const aliasName = node.name.text;
    scanSubtree(node.type, aliasName);
    if (node.typeParameters) {
      for (const typeParam of node.typeParameters) {
        scanSubtree(typeParam, aliasName);
      }
    }
  });
  if (aliasCount === 0) {
    violations.push(makeViolation(
      'side-panels-type-alias', filename, 0,
      'no type alias declarations found at all — the derived pane-id unions must stay derived from the manifest',
    ));
  }
  return violations;
}

/** Terminal two-segment chain predicate for the `app.ts` comparison rule:
 *  the receiver expression's own last two identifier segments must be
 *  exactly `sidePanel`, then `value` — `sidePanel.value`,
 *  `app.shell.sidePanel.value`, etc. all match; a shorter or differently
 *  named chain does not. */
function isSidePanelValueChain(expr) {
  const names = terminalNames(expr, 2);
  return names.length === 2 && names[0] === 'sidePanel' && names[1] === 'value';
}

const SIDE_PANEL_RULE_DISPATCH = Object.freeze({
  [WORKBENCH_SESSION_FILE]: (sourceFile, filename) => [
    ...workbenchSidePanelMentionViolations(sourceFile, filename),
    ...strictEqualityLiteralViolations(
      sourceFile, filename, 'workbench-history-compare', ['history'], () => true,
      (value) => `strict equality against literal "${value}"`,
    ),
  ],
  [APP_PREFERENCES_FILE]: (sourceFile, filename) =>
    exactLiteralRuleViolations(sourceFile, filename, 'app-preferences-panel-id', SIDE_PANEL_APP_PREFERENCES_IDS),
  [STATE_FILE]: (sourceFile, filename) =>
    exactLiteralRuleViolations(sourceFile, filename, 'state-panel-label', SIDE_PANEL_STATE_LABELS),
  [APP_FILE]: (sourceFile, filename) => strictEqualityLiteralViolations(
    sourceFile, filename, 'app-side-panel-comparison', SIDE_PANEL_APP_COMPARISON_VALUES, isSidePanelValueChain,
    (value) => `sidePanel.value strictly compared against literal "${value}"`,
  ),
  [APP_SHELL_FILE]: (sourceFile, filename) => [
    ...exactIdentifierOrLiteralRuleViolations(sourceFile, filename, 'app-shell-panel-def', SIDE_PANEL_APP_SHELL_DEFS),
    ...exactLiteralRuleViolations(sourceFile, filename, 'app-shell-panel-id', SIDE_PANEL_APP_SHELL_IDS),
    ...appShellHostAccessorViolations(sourceFile, filename),
  ],
  [SIDE_PANELS_CORE_FILE]: (sourceFile, filename) => sidePanelsTypeAliasViolations(sourceFile, filename),
});

/**
 * Issue #643 — the #587 AC5 side-panel source contract, real-parser-backed.
 * `filename` selects which (if any) of the six rule groups above apply — a
 * file outside `SIDE_PANEL_RULE_DISPATCH`'s six keys returns `[]` without
 * even being parsed, matching every other owner-scoped helper in this
 * module (`findNamedIdentifierViolations` et al.). Different rule groups
 * intentionally use different literal semantics (broad contiguous-substring
 * detection vs. exact-value comparison vs. structural chain/identifier
 * matching) — this dispatcher composes them, it does not collapse them into
 * one generic vocabulary matcher.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated
 * @returns {{rule: string, filename: string, pos: number, detail: string}[]}
 */
export function findSidePanelSourceContractViolations(source, filename) {
  const dispatch = SIDE_PANEL_RULE_DISPATCH[filename];
  if (!dispatch) return [];
  return withParsedSource(source, filename, (sourceFile) => dispatch(sourceFile, filename));
}

// ── Surface-lifecycle source contract (#590 invariant (k)) ──────────────────

/** Classify `[start, end)` against `[coordinatorStart, coordinatorEnd)`:
 *  `'inside'` when it lies entirely within, `'outside'` when it lies
 *  entirely outside (on either side), and `'straddle'` for the one shape no
 *  compile-time mechanism can foreclose either — a range that crosses a
 *  marker boundary. A `'straddle'` is always treated as a violation by every
 *  caller below (never silently passed), matching the plan's own
 *  "deterministic boundary violation" wording. */
function coordinatorPlacement(start, end, coordinatorStart, coordinatorEnd) {
  if (start >= coordinatorStart && end <= coordinatorEnd) return 'inside';
  if (end <= coordinatorStart || start >= coordinatorEnd) return 'outside';
  return 'straddle';
}

/** The four coordinator-owned declarations `app.ts` must declare EXACTLY
 *  inside the marked region — both directions enforced (a name missing from
 *  inside is flagged exactly like an occurrence found outside), mirroring
 *  the retired regex test's own two-sided
 *  `toMatch(inside)`/`not.toMatch(outside)` pair: a symbol that disappears
 *  from the file ENTIRELY must not silently read as "zero violations", the
 *  same reasoning `sidePanelsTypeAliasViolations`'s alias-count guard
 *  applies above. Each must ALSO specifically be a `const` (pass-1 finding):
 *  the retired regex test asserted `toMatch(/\bconst\s+disposeShell\s*=/)`
 *  etc. — `const` was part of the invariant, not incidental — so a
 *  `let`/`var` rewrite of any of these four must fail exactly like a wrong
 *  location would. */
const PROTECTED_DECLARATION_NAMES = Object.freeze([
  'disposeShell', 'disposeCurrentSurface', 'committedWorkspaceSignal', 'mainSurfaceSignal',
]);

/** The non-`const` keyword an offending `VariableDeclarationList`'s flags
 *  spell — `NodeFlags.Let` set means `let`, otherwise (no block-scoped flag
 *  at all) it's `var`. Never called for a `const` list. */
function nonConstDeclarationKeyword(declarationListFlags) {
  return (declarationListFlags & NodeFlags.Let) !== 0 ? 'let' : 'var';
}

function protectedDeclarationViolations(appSourceFile, appFile, coordinatorStart, coordinatorEnd) {
  const violations = [];
  const foundInside = new Set();
  walkTree(appSourceFile, (node) => {
    if (node.kind !== SyntaxKind.VariableDeclaration || node.name.kind !== SyntaxKind.Identifier) return;
    const name = node.name.text;
    if (!PROTECTED_DECLARATION_NAMES.includes(name)) return;
    const declarationList = node.parent;
    const hasDeclarationList = declarationList != null && declarationList.kind === SyntaxKind.VariableDeclarationList;
    const isConst = hasDeclarationList && (declarationList.flags & NodeFlags.Const) !== 0;
    // Anchor the checked range at the declaration list's OWN start — which
    // IS the `const`/`let`/`var` keyword's position — never at the
    // `VariableDeclaration` node's own start (the binding identifier, which
    // begins strictly AFTER the keyword): otherwise a straddle whose keyword
    // sits outside the coordinator and whose binding sits inside would
    // misclassify as fully 'inside' (pass-1 finding).
    const start = hasDeclarationList ? declarationList.getStart(appSourceFile) : node.getStart(appSourceFile);
    const end = node.getEnd();
    const placement = coordinatorPlacement(start, end, coordinatorStart, coordinatorEnd);
    if (placement === 'inside' && isConst) {
      foundInside.add(name);
      return;
    }
    const detail = isConst
      ? `"${name}" is declared ${placement} the coordinator region`
      : `"${name}" must be declared "const", not "${
          hasDeclarationList ? nonConstDeclarationKeyword(declarationList.flags) : 'a non-declaration-list binding'
        }"`;
    violations.push(makeViolation('surface-protected-declaration', appFile, start, detail));
  });
  for (const name of PROTECTED_DECLARATION_NAMES) {
    if (!foundInside.has(name)) {
      violations.push(makeViolation(
        'surface-protected-declaration', appFile, 0,
        `"${name}" has no declaration inside the coordinator region`,
      ));
    }
  }
  return violations;
}

/** `app.ts`'s teardown-call rule, outside the coordinator only. A real
 *  `CallExpression` violates when its callee's own terminal ONE segment is
 *  `disposeShell`/`disposeCurrentSurface` (bare or member-prefixed —
 *  `disposeShell()`, `owner.disposeShell()` both match, since
 *  `terminalNames` only inspects the LAST segment) or its terminal TWO
 *  segments are exactly `shell`, `dispose` (`shell.dispose()`,
 *  `app.shell.dispose()`, and — because optional-chained property access is
 *  the SAME `PropertyAccessExpression` AST kind, just with a
 *  `questionDotToken` set — `shell?.dispose()` too, with no separate
 *  branch needed). */
const TEARDOWN_SINGLE_SEGMENT_NAMES = new Set(['disposeShell', 'disposeCurrentSurface']);

function teardownCallViolations(appSourceFile, appFile, coordinatorStart, coordinatorEnd) {
  const violations = [];
  walkTree(appSourceFile, (node) => {
    if (node.kind !== SyntaxKind.CallExpression) return;
    const single = terminalNames(node.expression, 1);
    const double = terminalNames(node.expression, 2);
    const isSingleMatch = single.length === 1 && TEARDOWN_SINGLE_SEGMENT_NAMES.has(single[0]);
    const isShellDisposeMatch = double.length === 2 && double[0] === 'shell' && double[1] === 'dispose';
    if (!isSingleMatch && !isShellDisposeMatch) return;
    const start = node.getStart(appSourceFile);
    const end = node.getEnd();
    const placement = coordinatorPlacement(start, end, coordinatorStart, coordinatorEnd);
    if (placement !== 'inside') {
      violations.push(makeViolation(
        'surface-teardown-call', appFile, start,
        `a teardown call sits ${placement} the coordinator region`,
      ));
    }
  });
  return violations;
}

/** The two private signal identifiers a plain `.value =` write may never
 *  target outside the coordinator, tree-wide (`app.ts` gets the coordinator
 *  exception; every other file never legally names either identifier at
 *  all, since they are not exported). */
const SURFACE_SIGNAL_NAMES = Object.freeze(['committedWorkspaceSignal', 'mainSurfaceSignal']);

function signalWriteViolations(sourceFile, filename, isAppFile, coordinatorStart, coordinatorEnd) {
  const violations = [];
  walkTree(sourceFile, (node) => {
    if (node.kind !== SyntaxKind.BinaryExpression || node.operatorToken.kind !== SyntaxKind.EqualsToken) return;
    const left = node.left;
    if (left.kind !== SyntaxKind.PropertyAccessExpression || left.name.text !== 'value') return;
    const owner = terminalNames(left.expression, 1);
    if (owner.length !== 1 || !SURFACE_SIGNAL_NAMES.includes(owner[0])) return;
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    if (isAppFile && coordinatorPlacement(start, end, coordinatorStart, coordinatorEnd) === 'inside') return;
    violations.push(makeViolation(
      'surface-signal-write', filename, start,
      `"${owner[0]}.value" is written outside the coordinator region`,
    ));
  });
  return violations;
}

/**
 * `currentWorkspace = null` (and every transparent cast/assertion wrapper
 * around the `null`) outside the coordinator, tree-wide (`app.ts` gets the
 * coordinator exception). The left side must be an actual property access
 * ending in `.currentWorkspace` (a bare, receiver-less `currentWorkspace =
 * null` was never in scope for today's `\.currentWorkspace` regex either,
 * and stays out of scope here). `null ?? fallback` is a deliberate,
 * documented exclusion — see `unwrapNullEquivalentWrappers`'s own doc
 * comment for why `??` is not a transparent wrapper.
 */
function currentWorkspaceNullViolations(sourceFile, filename, isAppFile, coordinatorStart, coordinatorEnd) {
  const violations = [];
  walkTree(sourceFile, (node) => {
    if (node.kind !== SyntaxKind.BinaryExpression || node.operatorToken.kind !== SyntaxKind.EqualsToken) return;
    const left = node.left;
    if (left.kind !== SyntaxKind.PropertyAccessExpression || left.name.text !== 'currentWorkspace') return;
    const resolved = unwrapNullEquivalentWrappers(node.right);
    if (!resolved || resolved.kind !== SyntaxKind.NullKeyword) return;
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    if (isAppFile && coordinatorPlacement(start, end, coordinatorStart, coordinatorEnd) === 'inside') return;
    violations.push(makeViolation(
      'surface-current-workspace-null', filename, start,
      '"currentWorkspace" is assigned a null-equivalent value outside the coordinator region',
    ));
  });
  return violations;
}

/** Every function-like AST kind whose `.body` may be a `Block` — including
 *  return-annotated declarations (`function f(): T { ... }`), which the
 *  retired textual opener (`/(?:=>|\))\s*\{/`) could never recognize because
 *  the return-type annotation's text sits between the parameter list's `)`
 *  and the body's `{`. Deliberately excludes concise (non-block) arrow
 *  bodies (`() => expr`) — there is no `Block` there to scope. */
const FUNCTION_LIKE_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
]);

/**
 * Every "ordering scope" in `sourceFile` — a `Block`/`CaseBlock` node whose
 * enclosing construct the plan's own ordering-scope table names: every
 * block-bodied function-like node (see `FUNCTION_LIKE_KINDS`), PLUS exactly
 * the parenthesized control-flow forms the retired `) {` textual opener
 * happened to also treat as independent scopes — `if`'s then-block, a
 * `for`/`for-in`/`for-of`/`while`/`with` body when it is itself a `Block`,
 * a `switch`'s whole `CaseBlock` (one scope for every case together, not
 * one per case — matching the opener's single `switch (...) {` match), and
 * a `catch` block ONLY when it has the parenthesized binding form
 * (`catch (e) { ... }`, never binding-less `catch { ... }`, which the old
 * opener's `)` requirement also never matched). Deliberately does NOT add
 * `else`/`do`/`try`/`finally`/binding-less-`catch`/a bare standalone block as
 * independent scopes — the old opener never recognized those either, and
 * they remain reachable (and checked) only through whichever enclosing
 * scope from this list actually contains them.
 *
 * @param {object} sourceFile
 * @returns {object[]} `Block`/`CaseBlock` nodes, one per ordering scope
 */
function collectOrderingScopes(sourceFile) {
  const scopes = [];
  walkTree(sourceFile, (node) => {
    if (FUNCTION_LIKE_KINDS.has(node.kind) && node.body && node.body.kind === SyntaxKind.Block) {
      scopes.push(node.body);
      return;
    }
    if (node.kind === SyntaxKind.IfStatement && node.thenStatement && node.thenStatement.kind === SyntaxKind.Block) {
      scopes.push(node.thenStatement);
      return;
    }
    if (
      (node.kind === SyntaxKind.ForStatement
        || node.kind === SyntaxKind.ForInStatement
        || node.kind === SyntaxKind.ForOfStatement
        || node.kind === SyntaxKind.WhileStatement
        || node.kind === SyntaxKind.WithStatement)
      && node.statement && node.statement.kind === SyntaxKind.Block
    ) {
      scopes.push(node.statement);
      return;
    }
    if (node.kind === SyntaxKind.SwitchStatement) {
      scopes.push(node.caseBlock);
      return;
    }
    if (node.kind === SyntaxKind.CatchClause && node.variableDeclaration && node.block) {
      scopes.push(node.block);
    }
  });
  return scopes;
}

/** True for a plain `=` write whose left side is a property access ending in
 *  `.mainSurface` or `.currentWorkspace` — the ordering rule's OWN "protected
 *  write" shape, deliberately independent of (broader than in file scope,
 *  narrower in property-name scope than) the tree-wide null/signal rules
 *  above: this fires regardless of the RHS value, matching today's
 *  `/\.(?:mainSurface|currentWorkspace)\s*=(?!=)/` identifier-anchored
 *  regex. */
function isProtectedOrderingWrite(node) {
  return node.kind === SyntaxKind.BinaryExpression
    && node.operatorToken.kind === SyntaxKind.EqualsToken
    && node.left.kind === SyntaxKind.PropertyAccessExpression
    && (node.left.name.text === 'mainSurface' || node.left.name.text === 'currentWorkspace');
}

const RETIRE_CALL_NAME_PATTERN = /^retireTo/;

/** True for a real call whose callee's own terminal (last) identifier
 *  segment matches `retireTo*` — bare or member-prefixed, matching today's
 *  `/\bretireTo\w*\s*\(/` textual pattern's own breadth. */
function isRetirementCall(node) {
  if (node.kind !== SyntaxKind.CallExpression) return false;
  const names = terminalNames(node.expression, 1);
  return names.length === 1 && RETIRE_CALL_NAME_PATTERN.test(names[0]);
}

/** The earliest `getStart(sourceFile)` position, among every descendant of
 *  `scopeNode` (scopeNode itself included) for which `predicate` is true —
 *  or `null` when none match. Deliberately walks the WHOLE subtree
 *  unconditionally (never stopping at a nested scope's own boundary), which
 *  is exactly how "nested descendants remain visible to their enclosing
 *  scope" (today's conservative lexical model) is preserved: a retirement
 *  call three functions deep still counts for every scope that contains it. */
function firstMatchStart(scopeNode, sourceFile, predicate) {
  let best = null;
  walkTree(scopeNode, (node) => {
    if (!predicate(node)) return;
    const pos = node.getStart(sourceFile);
    if (best === null || pos < best) best = pos;
  });
  return best;
}

/**
 * The retirement-ordering rule, tree-wide, unconditional on the coordinator
 * (the plan's own rule-scope matrix names no coordinator carve-out for
 * ordering, matching the retired implementation, which applied
 * `functionBodies`/its regex identically to every scanned file with no
 * app.ts-specific branch at all). For every ordering scope
 * (`collectOrderingScopes`), find the scope's own first protected write and
 * first retirement call (both possibly satisfied by a nested descendant —
 * see `firstMatchStart`) and flag the scope only when a write precedes a
 * retirement call that also exists in that same scope; a scope with a write
 * but no retirement call anywhere within it is clean (today's "retire before
 * write" and "no retire at all" cases were never distinguished, and stay
 * that way).
 *
 * @param {object} sourceFile
 * @param {string} filename
 * @returns {object[]}
 */
function retirementOrderingViolations(sourceFile, filename) {
  const violations = [];
  for (const scope of collectOrderingScopes(sourceFile)) {
    const writeStart = firstMatchStart(scope, sourceFile, isProtectedOrderingWrite);
    if (writeStart === null) continue;
    const retireStart = firstMatchStart(scope, sourceFile, isRetirementCall);
    if (retireStart !== null && writeStart < retireStart) {
      violations.push(makeViolation(
        'surface-retirement-ordering', filename, writeStart,
        `a mainSurface/currentWorkspace write at ${writeStart} precedes a retireTo*() call at ${retireStart} within one ordering scope`,
      ));
    }
  }
  return violations;
}

/**
 * Issue #643 — the #590 invariant (k) surface-lifecycle source contract,
 * real-parser-backed, over the COMPLETE scanned `src/**` source set in one
 * shared parser batch (`withParsedSources`, never one process per file — see
 * that function's own doc comment for why this matters at this tree's
 * file count). `sources` supplies every currently scanned file's raw text
 * unchanged (comments included — the coordinator markers themselves are
 * `//` line comments the caller locates in the SAME raw text before calling
 * this, and their byte offsets align exactly with this function's AST node
 * positions because neither side strips or reconstructs anything).
 * `coordinatorStart`/`coordinatorEnd` are those two raw offsets in
 * `appFile`'s own source; `appFile` must be one of the filenames in
 * `sources`, or this throws (fail loud, matching every other "could not
 * resolve the source I was asked to check" case in this module).
 *
 * @param {readonly {filename: string, source: string}[]} sources
 * @param {{appFile: string, coordinatorStart: number, coordinatorEnd: number}} options
 * @returns {{rule: string, filename: string, pos: number, detail: string}[]}
 */
export function findSurfaceLifecycleSourceContractViolations(sources, { appFile, coordinatorStart, coordinatorEnd }) {
  return withParsedSources(sources, (sourceFiles) => {
    const appSourceFile = sourceFiles.get(appFile);
    if (!appSourceFile) {
      throw new Error(`check-legacy-owners: ${appFile} was not found in the supplied surface-lifecycle source batch`);
    }
    const violations = [
      ...protectedDeclarationViolations(appSourceFile, appFile, coordinatorStart, coordinatorEnd),
      ...teardownCallViolations(appSourceFile, appFile, coordinatorStart, coordinatorEnd),
    ];
    for (const [filename, sourceFile] of sourceFiles) {
      const isAppFile = filename === appFile;
      violations.push(...signalWriteViolations(sourceFile, filename, isAppFile, coordinatorStart, coordinatorEnd));
      violations.push(...currentWorkspaceNullViolations(sourceFile, filename, isAppFile, coordinatorStart, coordinatorEnd));
      violations.push(...retirementOrderingViolations(sourceFile, filename));
    }
    return violations;
  });
}

// ── Issue #592 — shell primitive guardrails ──────────────────────────────────
//
// Lock in what #586 ("one overlay-lifecycle implementation") and #587 ("a
// registry-driven panel model") established, mechanically, so the
// six-copy-pasted-overlays problem #586 fixed cannot silently regrow the same
// way it grew the first time. Three independent guards:
//   1. `shell-body-mount` — a new `Document.body.append`/`.appendChild` call
//      outside the exact frozen #592 baseline snapshot (`SHELL_BODY_MOUNT_
//      POLICY` below), parser-backed (`findShellGuardrailSourceContract
//      Violations`, this section);
//   2. `shell-fixed-position` — a new `position: fixed` CSS declaration in
//      `src/styles.css` outside the exact frozen selector/at-rule snapshot
//      (`SHELL_FIXED_POSITION_POLICY`), a focused CSS lexical scanner (no CSS
//      parser dependency — `scanFixedPositionDeclarations`, below);
//   3. `shell-capture-escape` — a new global capture-phase Escape `keydown`
//      lifecycle outside `SurfaceLifecycle` and the exact frozen exception/
//      non-panel-gesture snapshot (`SHELL_CAPTURE_ESCAPE_POLICY`), sharing the
//      SAME parser batch as guard 1 (`findShellGuardrailSourceContract
//      Violations` runs both over one `withParsedSources` call, never one
//      parser process per rule).
//
// Every fingerprint below was generated by running the analyzers below over
// the CURRENT tree (post-#586/#587, pre-#592) and manually reviewing every
// resulting occurrence — never guessed from the issue body. In particular,
// `src/ui/dashboard-chart-interaction.ts`'s `beginSelection` capture-Escape
// listener (chart range-selection cancellation, not a panel close) and
// `src/ui/toast.ts`/`src/ui/app.ts`'s non-panel body mounts (export progress,
// the temporary download anchor) are real, reviewed occurrences the issue's
// own attachment underestimated — see the plan's "Verified repository
// baseline" section. Deleting an exception below must SHRINK this table, not
// leave the entry present with a stale rationale.
//
// Root-cause circuit breaker (Architecture decision 6, added post-PR-#672):
// three formal code-review passes on the original implementation
// (`570e089`/`ad4f71f`/`e76c8a7`) each found and fixed a real defect in a
// hand-rolled, Map-based scope-resolution layer this section used to carry
// (`scopeOwnerOf`/`scopeChain`/`declarationScopeOwnerOf`/
// `buildGlobalAliasMap`/`buildFunctionDeclMap`/`buildCaptureAliasMap`/a
// body-alias scope map) — flat file-wide maps (pass 1), then same-function
// block shadowing not modeled (pass 2), then `var`/for-loop-header
// declaration-kind-unaware scoping plus object-literal evaluation order (pass
// 3). All three were variants of ONE root cause: re-deriving JavaScript/
// TypeScript binding semantics by hand instead of asking the real TypeScript
// binder. `withParsedSources`'s `Project` (above) already exposes a real
// `checker: Checker` with genuine binder symbol resolution
// (`getSymbolAtLocation`) that answers "what does this identifier resolve
// to" correctly and for free — same-function block shadowing, for-loop-header
// shadowing, sibling-scope non-pollution, and correct reversion to an outer
// binding once a shadow's scope ends are all real TypeScript-binder behavior,
// not something this module needs to model itself. Every place below that
// used to answer that question through the hand-rolled maps now resolves it
// through `checker.getSymbolAtLocation` against the identifier's real
// declaration instead — the maps and their scope-chain-walking machinery are
// deleted outright, not patched again. Candidate discovery (the AST shapes
// for `.appendChild`/`.append`/`addEventListener`/Escape-comparison) and the
// capture-options constant evaluator's own real object-literal evaluation-
// order logic are UNCHANGED — neither is a name-binding question, so neither
// is this addendum's concern.

/** Every transparent cast/assertion wrapper a body-mount/capture-escape
 *  receiver or handler argument may sit behind — reused verbatim from the
 *  #643 null-equivalent unwrap above (`ParenthesizedExpression`/
 *  `AsExpression`/`SatisfiesExpression`/`NonNullExpression`/
 *  `TypeAssertionExpression`): the same "transparent wrapper" concept, not
 *  specific to a null RHS. */
const unwrapCastWrappers = unwrapNullEquivalentWrappers;

/** The scope-name of one `FUNCTION_LIKE_KINDS` node: its own declared name
 *  (`function openMenu() {}`), or — for an anonymous function/arrow — the
 *  name of the binding it is assigned to (`const onKey = (e) => {}`) or the
 *  property it is assigned as (`{ mount: (ctx) => {} }`, `{ mount(ctx) {} }`),
 *  or the literal placeholder `'<anonymous>'` when neither applies (e.g. an
 *  arrow passed directly as a call argument, `withDocument(doc, () => {})`).
 */
function scopeNameFor(fnLikeNode) {
  if (fnLikeNode.name && fnLikeNode.name.kind === SyntaxKind.Identifier) return fnLikeNode.name.text;
  const p = fnLikeNode.parent;
  if (p) {
    if (p.kind === SyntaxKind.VariableDeclaration && p.name && p.name.kind === SyntaxKind.Identifier) return p.name.text;
    if (p.kind === SyntaxKind.PropertyAssignment && p.name) {
      if (p.name.kind === SyntaxKind.Identifier) return p.name.text;
      if (p.name.kind === SyntaxKind.StringLiteral) return p.name.text;
    }
  }
  return '<anonymous>';
}

/** The FULL chain of enclosing named-or-placeholder scopes for `node`, from
 *  outermost to innermost (e.g. `['createApp', 'showExportProgress']`,
 *  `['openPipelineFullscreen', 'mount']`) — a PATH, not just the nearest
 *  name, so two differently-named outer functions that both happen to
 *  contain a same-named inner callback (`mount`, `<anonymous>`) still key
 *  distinctly. This is what keeps a body-mount/capture-escape exception from
 *  becoming filename-wide authorization: the policy tables below match on
 *  (filename, this whole path), never on filename alone. */
function enclosingScopePath(node) {
  const names = [];
  let current = node.parent;
  while (current) {
    if (FUNCTION_LIKE_KINDS.has(current.kind)) names.push(scopeNameFor(current));
    current = current.parent;
  }
  names.reverse();
  return names.length ? names : ['<module>'];
}

/** The nearest enclosing `FUNCTION_LIKE_KINDS` ancestor node itself (not just
 *  its name) — used by the SurfaceLifecycle-composition check, which must
 *  walk that scope's own subtree for a companion `openSurfaceLifecycle(...)`
 *  call. `null` when `node` sits at module top level (no enclosing function
 *  at all — not a real occurrence for either #592 guard today, but handled
 *  rather than assumed impossible). Deliberately FUNCTION-granular, not
 *  block-granular — `bodyMountCandidates`'s `scopeNode` and the
 *  `enclosingScopePath`/`fullScopePathOf`/`declaredScopeKeys` scope-PATH
 *  concept both need "the whole named function" for POLICY matching, never a
 *  narrower nested block; real lexical (block-level) name-BINDING resolution
 *  is a different question, answered by the real TypeScript checker
 *  (`checker.getSymbolAtLocation`, see the #592 addendum section header
 *  comment above and `resolveGlobalKind`/`resolveHandlerNode`/
 *  `resolveCaptureFlag`/`resolvesToDocumentBody` below), not by a hand-rolled
 *  block-scope walk. */
function innermostScopeNode(node) {
  let current = node.parent;
  while (current) {
    if (FUNCTION_LIKE_KINDS.has(current.kind)) return current;
    current = current.parent;
  }
  return null;
}

/** `key.join(' > ')` — the one join convention every #592 scope-path
 *  comparison (candidate generation AND the frozen policy tables) shares, so
 *  a separator mismatch can never silently make a real exception fail to
 *  match its own policy entry. */
function scopeKey(scopePath) {
  return scopePath.join(' > ');
}

/** The full scope-path key for a `FUNCTION_LIKE_KINDS` node ITSELF — its own
 *  enclosing chain (`enclosingScopePath`'s ancestors) PLUS its own name
 *  (`scopeNameFor`) — e.g. `createAnchoredPopovers`'s nested `open` arrow
 *  yields `['createAnchoredPopovers', 'open']`, distinct from
 *  `enclosingScopePath(node)` (which never includes `node` itself, only what
 *  encloses it). Never carries the `<module>` sentinel: `fnLikeNode` is
 *  always itself a real function-like node, so the walk always has at least
 *  one name. */
function fullScopePathOf(fnLikeNode) {
  const names = [scopeNameFor(fnLikeNode)];
  let current = fnLikeNode.parent;
  while (current) {
    if (FUNCTION_LIKE_KINDS.has(current.kind)) names.push(scopeNameFor(current));
    current = current.parent;
  }
  names.reverse();
  return names;
}

/** Every scope-path KEY (`scopeKey(fullScopePathOf(...))`) actually declared
 *  somewhere in `sourceFile` — used only to ask "does this policy scope path
 *  even exist in what was scanned", which is what makes the #672 P1
 *  missing-baseline-entry check (`shellBodyMountViolations`/
 *  `shellCaptureEscapeViolations`'s own SOFTENED reverse pass) safe against
 *  this test suite's own established convention of a MINIMAL synthetic
 *  fixture reproducing just ONE of a real file's several approved scopes
 *  under that file's real name (`shell-guardrails-arch.test.ts`'s own header
 *  comment): a sibling policy entry whose scope was never even part of the
 *  scanned source is correctly treated as "not this call's concern" rather
 *  than "a disappeared baseline occurrence" — the missing-entry check only
 *  fires for a scope that is ACTUALLY PRESENT in the tree (so a genuine drop
 *  from N approved occurrences to fewer, within a scope that still exists,
 *  is still caught).
 *
 *  This deliberate softening means a policy entry whose ENTIRE enclosing
 *  scope (or whole owning FILE) has also been deleted from production code
 *  is, BY DESIGN, invisible to `shellBodyMountViolations`/
 *  `shellCaptureEscapeViolations`'s own softened reverse pass — a real
 *  function-like scope either is or isn't declared in whatever was parsed,
 *  and a genuinely complete file with an approved function deleted is
 *  structurally indistinguishable, by THIS mechanism alone, from a partial
 *  fixture that never declared it. That coarser question — is the batch
 *  handed to this module the COMPLETE scanned tree, so an absent scope/file
 *  really means "deleted" rather than "not this fixture's concern" — is
 *  answered by a deliberately SEPARATE, stricter export instead:
 *  `findShellGuardrailMissingBaselineViolations` (PR #672 review pass 1
 *  follow-up, ChatGPT), which never consults `declaredScopeKeys` at all and
 *  is meaningful only against something the caller already knows is
 *  complete — exactly the same separation `findShellFixedPositionViolations`
 *  and `findShellFixedPositionMissingBaselineViolations` already establish
 *  for the CSS guard, for the identical reason. */
function declaredScopeKeys(sourceFile) {
  const keys = new Set();
  walkTree(sourceFile, (node) => {
    if (FUNCTION_LIKE_KINDS.has(node.kind)) keys.add(scopeKey(fullScopePathOf(node)));
  });
  return keys;
}

/** True for a real call anywhere inside `scopeNode`'s subtree whose callee's
 *  own terminal (last) identifier segment is exactly `name` — e.g.
 *  `hasCallNamed(scope, 'openSurfaceLifecycle')` matches both
 *  `openSurfaceLifecycle(...)` and `x.openSurfaceLifecycle(...)` (the latter
 *  never occurs in practice for this name, but `terminalNames` doesn't care).
 *  Backs the one #592 body-mount exception (`results.ts`'s cell-detail
 *  overlay) whose permission is conditioned on retaining its SurfaceLifecycle
 *  composition, not just its body-mount shape. */
function hasCallNamed(scopeNode, name) {
  if (!scopeNode) return false;
  let found = false;
  walkTree(scopeNode, (node) => {
    if (found) return;
    if (node.kind !== SyntaxKind.CallExpression) return;
    const names = terminalNames(node.expression, 1);
    if (names.length === 1 && names[0] === name) found = true;
  });
  return found;
}

/** Every `TypeReferenceNode` name reachable from `typeNode` through a union/
 *  intersection/parenthesized type — e.g. `Document`, `Document | null`,
 *  `(Document)`. Used only to recognize a parameter/variable declared WITH a
 *  `: Document` / `: Window` annotation (`childDoc: Document`, `mainDoc:
 *  Document`) as a document/window alias — see `classifyGlobalDeclaration`
 *  below. Purely syntactic (reads the type annotation's own AST text), so it
 *  works identically whether or not the checker can fully resolve the named
 *  type — including a `Document`/`Window` ambient global whose OWN
 *  declaration lives in `lib.dom.d.ts` (`resolveGlobalKind` below resolves
 *  the bare identifiers `document`/`window` through the exact same real-
 *  binder-then-inspect-the-declaration path as any local alias, since the
 *  real TypeScript checker resolves them to `declare var document: Document`
 *  / `declare var window: Window & typeof globalThis` either way). */
function typeNamesOf(typeNode) {
  const names = [];
  const walk = (t) => {
    if (!t) return;
    if (t.kind === SyntaxKind.TypeReference && t.typeName && t.typeName.kind === SyntaxKind.Identifier) {
      names.push(t.typeName.text);
    }
    if (t.kind === SyntaxKind.UnionType || t.kind === SyntaxKind.IntersectionType) {
      for (const sub of t.types) walk(sub);
    }
    if (t.kind === SyntaxKind.ParenthesizedType) walk(t.type);
  };
  walk(typeNode);
  return names;
}

/** Every ultimate type NAME `typeNode` structurally resolves to — the same
 *  union/intersection/parenthesized walk `typeNamesOf` performs, PLUS (#592
 *  review, ChatGPT PR #672 pass 1) resolving each `TypeReference` through the
 *  REAL checker (`checker.getSymbolAtLocation` on the type name) to see
 *  whether it names a local `type X = ...` ALIAS declaration — if so, this
 *  recurses into the alias's OWN type annotation instead of stopping at the
 *  alias's bare name, so `type Doc = Document; function f(doc: Doc)`
 *  recognizes `doc` as a `Document` exactly like a direct `: Document`
 *  annotation would. A reference that does NOT resolve to a type alias (an
 *  interface, an ambient global like `Document`/`Window` itself, an
 *  unresolvable name) contributes its own literal name instead — unchanged
 *  from `typeNamesOf`'s behavior. `seen` (keyed by the alias's own
 *  declaration node) guards against infinite recursion on a
 *  self-/mutually-referential alias chain — real TypeScript itself already
 *  rejects a directly circular type alias at compile time, so this is pure
 *  defense-in-depth, never expected to trigger against real, valid source.
 *  Deliberately still NOT general type inference (Architecture decision 6's
 *  own non-goal): this only follows a NAMED alias's own declared type, never
 *  computes a structural/inferred type for an arbitrary expression. */
function resolvedTypeNames(typeNode, checker, seen) {
  const names = [];
  const walk = (t) => {
    if (!t) return;
    if (t.kind === SyntaxKind.UnionType || t.kind === SyntaxKind.IntersectionType) {
      for (const sub of t.types) walk(sub);
      return;
    }
    if (t.kind === SyntaxKind.ParenthesizedType) { walk(t.type); return; }
    if (t.kind !== SyntaxKind.TypeReference || !t.typeName || t.typeName.kind !== SyntaxKind.Identifier) return;
    const symbol = checker.getSymbolAtLocation(t.typeName);
    const handle = symbol?.declarations?.[0];
    const aliasDecl = handle?.resolve?.();
    if (aliasDecl && aliasDecl.kind === SyntaxKind.TypeAliasDeclaration && !seen.has(aliasDecl)) {
      seen.add(aliasDecl);
      walk(aliasDecl.type);
      return;
    }
    names.push(t.typeName.text);
  };
  walk(typeNode);
  return names;
}

/** The SOURCE property name a `BindingElement` destructures — its own
 *  `propertyName`'s literal spelling when present (a rename: a plain
 *  identifier, a string/no-substitution-template literal, or a computed key
 *  resolving to either — mirrors `staticPropertyKeyName`'s object-literal-
 *  member recognition below, applied here to a `BindingElement`'s own
 *  `propertyName` instead), or else the binding's own LOCAL identifier name
 *  when `propertyName` is absent (a NON-renamed destructuring, where the
 *  local name IS the source key). `undefined` only when genuinely
 *  unresolvable (an unresolved computed `propertyName`, or a nested
 *  destructuring pattern as the local name) — never silently treated as "not
 *  a match" for the WRONG reason. #592 review pass (ChatGPT PR #672 pass 1):
 *  the prior check recognized a `propertyName` only when its OWN kind was
 *  `Identifier`, so a QUOTED rename (`const { 'body': host } = document`)
 *  fell through to reading the LOCAL name `host` instead of the real source
 *  key `body` — silently wrong whenever the local name differs from the real
 *  source property, and simply missed the match whenever it doesn't happen
 *  to coincide. */
function bindingElementSourceKeyName(declNode) {
  const propertyName = declNode.propertyName;
  if (propertyName) {
    if (propertyName.kind === SyntaxKind.Identifier) return propertyName.text;
    if (
      propertyName.kind === SyntaxKind.StringLiteral || propertyName.kind === SyntaxKind.NoSubstitutionTemplateLiteral
    ) return propertyName.text;
    if (propertyName.kind === SyntaxKind.ComputedPropertyName) {
      const inner = unwrapCastWrappers(propertyName.expression);
      if (inner && (inner.kind === SyntaxKind.StringLiteral || inner.kind === SyntaxKind.NoSubstitutionTemplateLiteral)) {
        return inner.text;
      }
    }
    return undefined;
  }
  return declNode.name && declNode.name.kind === SyntaxKind.Identifier ? declNode.name.text : undefined;
}

/** `openInDetachedTab`'s `mount()` callback destructures its one parameter —
 *  `({ doc, bar, body, close, closeBtn }: MountCtx) => {...}` — and `doc` is
 *  a real `Document` (`MountCtx.doc`, `src/ui/detached-view.ts`), but it's
 *  bound via PLAIN (non-renamed) destructuring of a parameter whose OWN type
 *  annotation names `MountCtx`, not `Document` directly — a shape
 *  `classifyGlobalDeclaration` below's other rules can't see on their own
 *  (its Parameter/VariableDeclaration rule only looks at a plain-IDENTIFIER
 *  binding's own type; its BindingElement rule only recognizes a RENAMED
 *  `{ document: doc }` form). Resolving `MountCtx`'s OWN member types would
 *  need full type inference across a module graph (`MountCtx` is frequently
 *  imported cross-file — see `explain-graph.ts`/`results.ts`), which this
 *  check deliberately does not attempt (Architecture decision 6's own
 *  non-goal: the checker answers "what does this name resolve to", not
 *  general type checking) — so `MountCtx` is named explicitly here rather
 *  than inferred, the one #592-reviewed real shape, confirmed at its three
 *  real call sites (`explain-graph.ts` ×2, `results.ts` ×1). */
const MOUNT_CTX_TYPE_NAME = 'MountCtx';

/**
 * Classify a real BINDING declaration node (what `checker.getSymbolAtLocation`
 * resolved an identifier reference TO) as denoting a `Document`, a `Window`,
 * or neither — the Architecture-decision-6 replacement for the #592 review
 * passes' hand-rolled `buildGlobalAliasMap`: instead of pre-walking the whole
 * file into a scope-keyed alias table, this inspects ONE already-resolved
 * declaration node directly, purely structurally:
 *   - a destructuring rename whose source key is `document`/`window`
 *     (`const { document: doc } = opts` — `menu.ts`'s real shape; a QUOTED
 *     spelling — `const { 'document': doc } = opts` — is recognized
 *     identically, via `bindingElementSourceKeyName`'s own literal-form
 *     recognition, #592 review pass/ChatGPT PR #672 pass 1);
 *   - a plain (non-renamed) destructuring of a `doc` property from a
 *     parameter/variable whose OWN type annotation names `MountCtx` (see
 *     `MOUNT_CTX_TYPE_NAME` above);
 *   - a `Parameter` or `VariableDeclaration` whose declared TYPE resolves
 *     (`resolvedTypeNames`, following any local `type X = ...` ALIAS chain
 *     through the real checker — #592 review pass/ChatGPT PR #672 pass 1) to
 *     `Document`/`Window` (`childDoc: Document`, `mainDoc: Document`, or
 *     `type Doc = Document; function f(doc: Doc)`) — this ALSO covers the
 *     bare globals `document`/`window` themselves: the real TypeScript
 *     checker resolves each to its own ambient `declare var document:
 *     Document` / `declare var window: Window & typeof globalThis`
 *     declaration in `lib.dom.d.ts`, which has exactly this shape, so no
 *     separate bare-identifier special case is needed;
 *   - a `VariableDeclaration` with NO type annotation: classified through its
 *     own initializer, recursively, via `resolveGlobalKind` below (`const doc
 *     = document.body.ownerDocument` and similar chains).
 * Every one of these is answered by inspecting real AST structure the
 * checker's binder already led us to — no scope-chain walk, alias map, or
 * declaration-kind (`var` vs `let`/`const`) tracking of any kind: the checker
 * already resolved WHICH declaration this identifier means, respecting real
 * block/function scoping, hoisting, and shadowing for free.
 *
 * @param {object} declNode
 * @param {object} checker the file's real TypeScript `Checker` — used for the
 *   type-alias-chain resolution (`resolvedTypeNames`) and the no-type-
 *   annotation initializer branch's recursive call
 * @returns {'document'|'window'|null}
 */
function classifyGlobalDeclaration(declNode, checker) {
  if (declNode.kind === SyntaxKind.BindingElement && declNode.propertyName) {
    const propName = bindingElementSourceKeyName(declNode);
    if (propName === 'document') return 'document';
    if (propName === 'window') return 'window';
  }
  if (
    declNode.kind === SyntaxKind.BindingElement && !declNode.propertyName
    && declNode.name && declNode.name.kind === SyntaxKind.Identifier && declNode.name.text === 'doc'
  ) {
    const pattern = declNode.parent;
    const owner = pattern && pattern.parent;
    if (owner && owner.type && typeNamesOf(owner.type).includes(MOUNT_CTX_TYPE_NAME)) return 'document';
  }
  if ((declNode.kind === SyntaxKind.Parameter || declNode.kind === SyntaxKind.VariableDeclaration) && declNode.type) {
    const names = resolvedTypeNames(declNode.type, checker, new Set());
    if (names.includes('Document')) return 'document';
    if (names.includes('Window')) return 'window';
  }
  if (declNode.kind === SyntaxKind.VariableDeclaration && !declNode.type && declNode.initializer) {
    return resolveGlobalKind(declNode.initializer, checker);
  }
  return null;
}

/**
 * Structurally resolve whether `node` denotes a `Document` (`'document'`), a
 * `Window` (`'window'`), or neither (`null`) — covering, per the plan's own
 * candidate-recognition list: the bare globals `document`/`window` and every
 * simple alias of either (resolved through the REAL TypeScript checker —
 * `checker.getSymbolAtLocation` against the identifier's own declaration,
 * then `classifyGlobalDeclaration` above — never a hand-rolled scope-chain
 * lookup); a member access chain ending in `.document`/`.window` regardless
 * of receiver (`window.document`, `opts.document`, `deps.document`,
 * `env.document` all qualify — the plan is explicit that ANY receiver
 * counts, since the exact `opts.document` shape is what
 * `dashboard-chart-interaction.ts`'s `beginSelection` needs); the
 * bracket-property spelling (`doc['body']['appendChild']`'s own receiver
 * chain uses the SAME check on `doc`, but a literal `x['document']` also
 * resolves here for symmetry); and `||`/`??` (either operand) or `&&` (the
 * right operand only — `a && a.document` evaluates to `a.document`, or a
 * falsy `a`, so only the right side is ever the actual receiver at runtime)
 * short-circuit forms, plus a ternary's either branch. Transparent cast/
 * assertion wrappers are unwrapped first. Every other shape (a call, a
 * non-literal computed member, an unresolvable identifier) returns `null` —
 * the caller treats `null` as "not a recognized global", never as a silent
 * pass for a DIFFERENT reason.
 *
 * @param {object} node
 * @param {object} checker the file's real TypeScript `Checker`
 * @returns {'document'|'window'|null}
 */
function resolveGlobalKind(node, checker) {
  const expr = unwrapCastWrappers(node);
  if (!expr) return null;
  if (expr.kind === SyntaxKind.Identifier) {
    const symbol = checker.getSymbolAtLocation(expr);
    if (!symbol) return null;
    const handle = symbol.valueDeclaration ?? symbol.declarations[0];
    const declNode = handle?.resolve();
    return declNode ? classifyGlobalDeclaration(declNode, checker) : null;
  }
  if (expr.kind === SyntaxKind.PropertyAccessExpression) {
    if (expr.name.text === 'document') return 'document';
    if (expr.name.text === 'window') return 'window';
    return null;
  }
  if (expr.kind === SyntaxKind.ElementAccessExpression) {
    const arg = expr.argumentExpression;
    if (arg && (arg.kind === SyntaxKind.StringLiteral || arg.kind === SyntaxKind.NoSubstitutionTemplateLiteral)) {
      if (arg.text === 'document') return 'document';
      if (arg.text === 'window') return 'window';
    }
    return null;
  }
  if (expr.kind === SyntaxKind.BinaryExpression) {
    const op = expr.operatorToken.kind;
    if (op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) {
      return resolveGlobalKind(expr.left, checker) ?? resolveGlobalKind(expr.right, checker);
    }
    if (op === SyntaxKind.AmpersandAmpersandToken) return resolveGlobalKind(expr.right, checker);
    return null;
  }
  if (expr.kind === SyntaxKind.ConditionalExpression) {
    return resolveGlobalKind(expr.whenTrue, checker) ?? resolveGlobalKind(expr.whenFalse, checker);
  }
  return null;
}

/** True when `declNode` (a `VariableDeclaration`) sits in a genuine `const`
 *  `VariableDeclarationList` — a binding that can never be reassigned after
 *  its own initialization, so trusting that initializer for EVERY later
 *  reference to the same binding is sound. A `let`/`var` binding can be
 *  reassigned anywhere in its scope, so a reference resolved to one is NOT
 *  safely reducible to "whatever its initializer says" (#592 review pass,
 *  ChatGPT PR #672 pass 1): `resolveHandlerNode`/`resolveCaptureFlag` below
 *  previously trusted ANY resolved `VariableDeclaration`'s initializer
 *  regardless of const-ness, so `let opts = { capture: false }; opts = {
 *  capture: true };` (or the analogous bare-boolean/handler-function form)
 *  silently escaped detection — the LATER value, the one actually in effect
 *  at the real `addEventListener` call, was never even considered. Both
 *  callers already have a documented fail-closed contract for "cannot be
 *  resolved" (return `null`, which the caller always treats as a violation
 *  — never as "assume clean"), so refusing to trust a non-`const` alias's
 *  initializer here is a strict IMPROVEMENT in detection, never a
 *  regression: it can only turn a previously-missed case into a correctly
 *  flagged "uncheckable" one, never the reverse. */
function isConstVariableDeclaration(declNode) {
  const list = declNode.parent;
  return !!list && list.kind === SyntaxKind.VariableDeclarationList && (list.flags & NodeFlags.Const) !== 0;
}

/**
 * Resolve an `addEventListener` handler argument to the `FUNCTION_LIKE_KINDS`
 * node it actually runs — an inline arrow/function expression directly, or a
 * plain `Identifier` resolved through the REAL TypeScript checker
 * (`checker.getSymbolAtLocation` against the identifier's own declaration —
 * the Architecture-decision-6 replacement for the #592 review passes'
 * hand-rolled `buildFunctionDeclMap`/lexical-scope-chain lookup): a
 * `FunctionDeclaration` declaration resolves directly; a `VariableDeclaration`
 * whose initializer is an arrow/function expression resolves to that
 * initializer; anything else (a `Parameter`, a `BindingElement`, a
 * `VariableDeclaration` with a non-function initializer, …) is unresolved.
 * `null` for anything else at all (a member access, a call, a conditional, an
 * identifier the checker can't bind, …) — the plan's own fail-closed
 * requirement: "if a global capture keydown handler cannot be statically
 * resolved, report it as uncheckable rather than treating it as non-Escape",
 * so the caller must treat `null` as an unconditional violation, never as
 * "assume clean". Because the checker's own binder resolves EACH reference to
 * its correct governing declaration (respecting real block/function scoping
 * and shadowing), there is no "nearest-preceding-by-source-position" heuristic
 * needed here either — the checker already answers "which declaration does
 * THIS specific reference mean". A `VariableDeclaration` alias must ALSO be a
 * genuine `const` (`isConstVariableDeclaration` above, #592 review pass,
 * ChatGPT PR #672 pass 1) before its initializer is trusted: a `let`
 * reassigned to a DIFFERENT function after its declaration (`let onKey =
 * () => {}; onKey = (e) => { if (e.key === 'Escape') close(); };`) would
 * otherwise resolve to the STALE initial function — exactly the "cannot be
 * statically resolved" case this function's own contract already requires
 * failing closed on, not a silent resolution to the wrong handler.
 *
 * @param {object} handlerArg
 * @param {object} checker the file's real TypeScript `Checker`
 * @returns {object | null}
 */
function resolveHandlerNode(handlerArg, checker) {
  const expr = unwrapCastWrappers(handlerArg);
  if (!expr) return null;
  if (FUNCTION_LIKE_KINDS.has(expr.kind)) return expr;
  if (expr.kind !== SyntaxKind.Identifier) return null;
  const symbol = checker.getSymbolAtLocation(expr);
  if (!symbol) return null;
  const handle = symbol.valueDeclaration ?? symbol.declarations[0];
  const declNode = handle?.resolve();
  if (!declNode) return null;
  if (FUNCTION_LIKE_KINDS.has(declNode.kind)) return declNode;
  if (declNode.kind === SyntaxKind.VariableDeclaration && declNode.initializer && isConstVariableDeclaration(declNode)) {
    const init = unwrapCastWrappers(declNode.initializer);
    if (init && FUNCTION_LIKE_KINDS.has(init.kind)) return init;
  }
  return null;
}

/** Best-effort static name of an object-literal member's key — a plain
 *  `Identifier` (`{ capture: … }`, and — since a `ShorthandPropertyAssignment`'s
 *  `.name` IS both the key AND the value reference — also `{ capture }`), a
 *  string/no-substitution-template-literal key (`{ 'capture': … }`), a
 *  numeric-literal key (never legally spells `capture`, but still a real
 *  static name, not an unresolvable one), or a computed key whose expression
 *  resolves (after unwrapping cast wrappers) to one of those same literal
 *  kinds (`{ ['capture']: … }`). Returns `undefined` — deliberately distinct
 *  from any resolved string — only when the key's own name genuinely cannot
 *  be determined (a computed key with a non-literal expression), so a caller
 *  can fail closed on "this might be the key I'm looking for" instead of
 *  silently treating it as "definitely isn't". */
function staticPropertyKeyName(member) {
  const name = member.name;
  if (!name) return undefined;
  if (name.kind === SyntaxKind.ComputedPropertyName) {
    const inner = unwrapCastWrappers(name.expression);
    if (inner && (inner.kind === SyntaxKind.StringLiteral || inner.kind === SyntaxKind.NoSubstitutionTemplateLiteral)) {
      return inner.text;
    }
    return undefined;
  }
  return typeof name.text === 'string' ? name.text : undefined;
}

/** Resolve an `addEventListener` OPTIONS object literal's own `capture`
 *  member to `true`/`false`, or `null` when unresolvable, respecting REAL
 *  object-literal property EVALUATION ORDER (#592 review pass 3): a real JS
 *  object literal evaluates its properties left to right, and a LATER
 *  property or spread always overrides an EARLIER same-key value — so this
 *  walks `node.properties` in source order and tracks only the LAST
 *  capture-affecting event, never "the first/any explicit `capture` member
 *  found", which is what let a later `SpreadAssignment` or unresolvable key
 *  silently fail to override an earlier explicit `capture: false` (e.g.
 *  `{ capture: false, ...{ capture: true } }`, which really runs
 *  capture-phase). Each property is one of two effects on the running
 *  result: a KNOWN effect (an explicit `capture` member — plain identifier,
 *  string/computed-string-literal key, or `ShorthandPropertyAssignment`
 *  shorthand — resolved recursively through `resolveCaptureFlag`, so a
 *  shorthand `{ capture }` reusing an in-scope boolean alias resolves
 *  exactly like `{ capture: someAlias }` would) that OVERWRITES whatever the
 *  running result was, or an UNKNOWN effect (a `SpreadAssignment`, a
 *  `capture` key whose own static name can't be determined at all —
 *  `staticPropertyKeyName` returns `undefined`, since it MIGHT be the very
 *  `capture` key being looked for — or a `capture` key that exists only as a
 *  method/accessor, never a plain boolean value) that conservatively makes
 *  the running result unresolvable, since its real contents can't be proven
 *  NOT to (re)define `capture`. A property whose static key resolves to
 *  anything OTHER than `capture` has no effect on `capture` at all and is
 *  skipped, exactly like before. The FINAL running result — after the last
 *  property is processed — is this function's answer: no capture-affecting
 *  property/spread was ever seen at all is provably `false` (the DOM
 *  default), matching `addEventListener`'s own spec default; #592 review
 *  pass 2 already fixed the narrower "recognize every `capture` key
 *  spelling" gap this order-aware walk preserves.
 *
 * This evaluation-order logic is UNCHANGED by Architecture decision 6 (#592
 * addendum) — real object-literal property/spread evaluation order is not a
 * name-binding question, so the real TypeScript checker has no bearing on it.
 * Only the recursive `resolveCaptureFlag` call below (for resolving an
 * explicit `capture` VALUE that turns out to itself be an identifier alias)
 * now goes through the checker instead of a hand-rolled alias map.
 *
 * @param {object} node
 * @param {object} checker the file's real TypeScript `Checker`
 * @returns {boolean | null}
 */
function resolveObjectCaptureLiteral(node, checker) {
  let lastKnownValueNode = null; // meaningful only while `lastEventKnown === true`
  let lastEventKnown = null; // null: no capture-affecting property seen yet; true: known; false: unknown/override-capable
  for (const p of node.properties) {
    if (p.kind === SyntaxKind.SpreadAssignment) { lastEventKnown = false; continue; }
    const keyName = staticPropertyKeyName(p);
    if (keyName === undefined) { lastEventKnown = false; continue; }
    if (keyName !== 'capture') continue;
    if (p.kind === SyntaxKind.PropertyAssignment) { lastKnownValueNode = p.initializer; lastEventKnown = true; }
    else if (p.kind === SyntaxKind.ShorthandPropertyAssignment) { lastKnownValueNode = p.name; lastEventKnown = true; }
    else lastEventKnown = false; // a method/get/set named `capture` — never a plain boolean
  }
  if (lastEventKnown === true) return resolveCaptureFlag(lastKnownValueNode, checker);
  return lastEventKnown === false ? null : false;
}

/**
 * Resolve an `addEventListener` THIRD argument to `true` (capture), `false`
 * (non-capture — proven), or `null` (cannot prove non-capture — the plan's
 * own fail-closed requirement: "for a keydown listener whose options cannot
 * be resolved enough to prove it is non-capture, fail closed rather than
 * silently assuming capture: false"). Covers a bare boolean literal, an
 * options object literal (`resolveObjectCaptureLiteral`), and a simple local
 * const alias of either form — resolved through the REAL TypeScript checker
 * (`checker.getSymbolAtLocation` against the identifier's own
 * `VariableDeclaration`, then recursing into its initializer) — the
 * Architecture-decision-6 replacement for the #592 review passes'
 * hand-rolled `buildCaptureAliasMap`/lexical-scope-chain lookup: a same-named
 * alias in an unrelated sibling/nested scope, or a same-named `var`/
 * for-header `let` binding, can never satisfy a lookup for a DIFFERENT real
 * scope's own reference, because the checker's binder already resolved
 * WHICH declaration this specific reference means. Every other shape (a
 * member access, a call, a conditional, an unresolved identifier, a
 * resolved declaration that isn't a plain `VariableDeclaration` with an
 * initializer — e.g. a destructured `BindingElement`, never supported here
 * either — OR (#592 review pass, ChatGPT PR #672 pass 1) a `VariableDeclaration`
 * that is NOT a genuine `const` — `isConstVariableDeclaration` above) is
 * `null`: a `let`/`var` alias CAN be reassigned anywhere in its scope
 * (`let opts = { capture: false }; opts = { capture: true };`), so trusting
 * only its own initializer would silently miss the value actually in effect
 * at the real `addEventListener` call — exactly the "cannot prove
 * non-capture" case this function's own contract already requires failing
 * closed on, never a silent resolution to a stale value.
 *
 * A `ShorthandPropertyAssignment`'s own name node (`{ capture }`'s `capture`)
 * is a special case the real checker itself distinguishes: plain
 * `checker.getSymbolAtLocation` on that identifier resolves to the object
 * LITERAL's own property symbol (an object-literal member named `capture`),
 * not the outer variable it shorthand-references — `checker
 * .getShorthandAssignmentValueSymbol` is the dedicated API for "what value
 * does this shorthand property actually reference", so this function calls
 * that instead whenever `node` is itself a shorthand property's name.
 *
 * @param {object} node
 * @param {object} checker the file's real TypeScript `Checker`
 * @returns {boolean | null}
 */
function resolveCaptureFlag(node, checker) {
  const expr = unwrapCastWrappers(node);
  if (!expr) return null;
  if (expr.kind === SyntaxKind.TrueKeyword) return true;
  if (expr.kind === SyntaxKind.FalseKeyword) return false;
  if (expr.kind === SyntaxKind.ObjectLiteralExpression) return resolveObjectCaptureLiteral(expr, checker);
  if (expr.kind !== SyntaxKind.Identifier) return null;
  const isShorthandName = expr.parent
    && expr.parent.kind === SyntaxKind.ShorthandPropertyAssignment && expr.parent.name === expr;
  const symbol = isShorthandName
    ? checker.getShorthandAssignmentValueSymbol(expr.parent)
    : checker.getSymbolAtLocation(expr);
  if (!symbol) return null;
  const handle = symbol.valueDeclaration ?? symbol.declarations[0];
  const declNode = handle?.resolve();
  if (
    !declNode || declNode.kind !== SyntaxKind.VariableDeclaration || !declNode.initializer
    || !isConstVariableDeclaration(declNode)
  ) return null;
  return resolveCaptureFlag(declNode.initializer, checker);
}

/** The one Escape literal every semantic check below compares against —
 *  `event.key`/`event.code` forms alike (the plan does not distinguish
 *  between the two KeyboardEvent properties, only requires either to be
 *  recognized). */
const ESCAPE_LITERAL_SET = new Set(['Escape']);

/**
 * True when `fnLikeNode`'s body contains real Escape-testing control flow —
 * per the plan's own recognition list: `event.key === 'Escape'` / `'Escape'
 * === event.key` (either operand order, `===` or `!==`, any quote style —
 * `exactLiteralMatch` already normalizes string vs. no-substitution-template
 * literals to the same decoded `.text`), the analogous `event.code` forms, and
 * `switch (event.key) { case 'Escape': … }`. A generic capture keydown
 * handler with NO Escape-specific branch (an activity/highlight listener,
 * e.g. `dashboard.ts`'s `noteInteraction`/`clear`) contains none of these and
 * is correctly classified clean — not governed by the #592 lifecycle rule at
 * all, structurally, before any policy table is even consulted.
 *
 * @param {object} fnLikeNode
 * @returns {boolean}
 */
function containsEscapeSemantics(fnLikeNode) {
  let found = false;
  const scanRoot = fnLikeNode.body ?? fnLikeNode; // a concise arrow body is an expression, not a Block
  walkTree(scanRoot, (node) => {
    if (found) return;
    if (
      node.kind === SyntaxKind.BinaryExpression
      && (node.operatorToken.kind === SyntaxKind.EqualsEqualsEqualsToken
        || node.operatorToken.kind === SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const leftIsEscape = exactLiteralMatch(node.left, ESCAPE_LITERAL_SET);
      const rightIsEscape = exactLiteralMatch(node.right, ESCAPE_LITERAL_SET);
      const other = leftIsEscape ? node.right : (rightIsEscape ? node.left : null);
      if (other) {
        const names = terminalNames(other, 1);
        if (names.length === 1 && (names[0] === 'key' || names[0] === 'code')) found = true;
      }
    }
    if (node.kind === SyntaxKind.SwitchStatement) {
      const names = terminalNames(node.expression, 1);
      if (names.length === 1 && (names[0] === 'key' || names[0] === 'code')) {
        for (const clause of node.caseBlock.clauses) {
          if (clause.kind === SyntaxKind.CaseClause && exactLiteralMatch(clause.expression, ESCAPE_LITERAL_SET)) {
            found = true;
            break;
          }
        }
      }
    }
  });
  return found;
}

// ── Guard 1: `shell-body-mount` ──────────────────────────────────────────────

/**
 * The frozen #592 baseline: every (file, scope-path) that may mount directly
 * onto a recognized `Document.body`, and exactly how many occurrences. Built
 * by running `bodyMountCandidates` over the current tree and reviewing every
 * result (see this section's header comment) — never guessed. `requiresLifecycle:
 * true` additionally requires the SAME scope to retain a companion
 * `openSurfaceLifecycle(...)` call (`hasCallNamed`); losing that call while
 * keeping the body mount fails even though the mount's own shape/count is
 * unchanged (`results.ts`'s cell-detail overlay is the one entry that needs
 * this — it exists ONLY because #586 explicitly keeps this one non-docked
 * overlay branch outside the docked-inspector migration, but still requires
 * it be built on the shared `SurfaceLifecycle` primitive, never a bespoke
 * one).
 */
const SHELL_BODY_MOUNT_POLICY = Object.freeze([
  { filename: 'src/ui/shortcuts.ts', scopePath: ['openShortcuts'], count: 1,
    category: 'existing distinct primitive: shortcuts modal' },
  { filename: 'src/ui/menu.ts', scopePath: ['openMenu'], count: 2,
    category: 'existing menu primitive: overlay + menu' },
  { filename: 'src/ui/dialog-shell.ts', scopePath: ['openDialogShell'], count: 1,
    category: 'explicitly distinct dialog primitive' },
  { filename: 'src/ui/toast.ts', scopePath: ['flashToast'], count: 1,
    category: 'acceptable transient toast' },
  { filename: 'src/ui/popover.ts', scopePath: ['openAnchoredDialog'], count: 2,
    category: 'explicitly distinct popover primitive: anchored-dialog family (overlay + dialog)' },
  { filename: 'src/ui/popover.ts', scopePath: ['createAnchoredPopovers', 'open'], count: 1,
    category: 'explicitly distinct popover primitive: anchored-popover family' },
  { filename: 'src/ui/results.ts', scopePath: ['openCellDetail', '<anonymous>'], count: 1,
    category: 'SurfaceLifecycle-backed: current cell-detail overlay branch', requiresLifecycle: true },
  { filename: 'src/ui/detached-view.ts', scopePath: ['openAsTab', '<anonymous>'], count: 1,
    category: 'detached/fullscreen primitive: real-tab (child-document) mount, outside #586\'s docked-inspector migration' },
  { filename: 'src/ui/detached-view.ts', scopePath: ['openAsOverlay', '<anonymous>'], count: 1,
    category: 'detached/fullscreen primitive: popup-blocked (main-document) fallback, outside #586\'s docked-inspector migration' },
  { filename: 'src/ui/app.ts', scopePath: ['createApp', 'showExportProgress'], count: 1,
    category: 'non-panel utility: existing transient export-progress surface' },
  { filename: 'src/ui/app.ts', scopePath: ['createApp', 'downloadFile'], count: 1,
    category: 'non-panel utility: temporary download anchor, not a shell surface' },
]);

/**
 * Structurally resolve whether `node` denotes a `Document.body` — the
 * Architecture-decision-6 replacement for the #592 review passes'
 * hand-rolled `bodyAliasMap` (a pre-walked, scope-keyed alias table): rather
 * than pre-registering every body alias in the file up front, this resolves
 * ONE receiver expression on demand, recursively, through the REAL
 * TypeScript checker wherever an identifier reference is involved. Covers,
 * per the plan's candidate list: a direct `.body` access on a recognized
 * Document (`document.body`, `doc.body`, `deps.document.body`, …, via
 * `resolveGlobalKind`); the bracket-property spelling (`doc['body']`); a
 * propagated alias — `const body = childDoc.body; body.appendChild(...)` —
 * resolved by looking at the alias's OWN `VariableDeclaration` initializer
 * (found via `checker.getSymbolAtLocation`, never a hand-rolled scope-chain
 * lookup) and recursing; a FURTHER alias of that alias (the same recursion,
 * one more hop); and a destructuring alias of `Document.body` — `const {
 * body } = document;` or the renamed `const { body: host } = document;` —
 * resolved by inspecting the `BindingElement`'s own destructuring pattern
 * and its owning declaration's initializer. Never gated by a raw
 * `source.includes(...)` prefilter — see this section's header comment on
 * why a text prefilter is unsound for this check (the repo's own recorded
 * recurring failure mode).
 *
 * @param {object} node
 * @param {object} checker the file's real TypeScript `Checker`
 * @returns {boolean}
 */
function resolvesToDocumentBody(node, checker) {
  const expr = unwrapCastWrappers(node);
  if (!expr) return false;
  if (expr.kind === SyntaxKind.PropertyAccessExpression && expr.name.text === 'body') {
    return resolveGlobalKind(expr.expression, checker) === 'document';
  }
  if (expr.kind === SyntaxKind.ElementAccessExpression) {
    const arg = expr.argumentExpression;
    if (
      arg && (arg.kind === SyntaxKind.StringLiteral || arg.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
      && arg.text === 'body'
    ) {
      return resolveGlobalKind(expr.expression, checker) === 'document';
    }
    return false;
  }
  if (expr.kind !== SyntaxKind.Identifier) return false;
  const symbol = checker.getSymbolAtLocation(expr);
  if (!symbol) return false;
  const handle = symbol.valueDeclaration ?? symbol.declarations[0];
  const declNode = handle?.resolve();
  if (!declNode) return false;
  if (declNode.kind === SyntaxKind.BindingElement) {
    // #592 review pass/ChatGPT PR #672 pass 1: `bindingElementSourceKeyName`
    // recognizes a QUOTED rename (`const { 'body': host } = document`)
    // identically to the unquoted form — the prior inline check here only
    // recognized a plain-Identifier `propertyName`, so a quoted source key
    // fell through to reading the LOCAL name (`host`) instead.
    const propName = bindingElementSourceKeyName(declNode);
    if (propName !== 'body') return false;
    const pattern = declNode.parent; // ObjectBindingPattern
    const owner = pattern && pattern.parent; // VariableDeclaration
    return !!(owner && owner.initializer && resolveGlobalKind(owner.initializer, checker) === 'document');
  }
  if (declNode.kind === SyntaxKind.VariableDeclaration && declNode.initializer) {
    return resolvesToDocumentBody(declNode.initializer, checker);
  }
  return false;
}

/**
 * Every real `.appendChild(...)`/`.append(...)` call in `sourceFile` whose
 * receiver structurally resolves to a recognized `Document.body`
 * (`resolvesToDocumentBody` above) — syntactic call-shape discovery
 * (unchanged by Architecture decision 6: recognizing `.appendChild`/`.append`
 * call SHAPES is not a name-binding question), receiver CLASSIFICATION
 * delegated entirely to the real checker.
 *
 * @param {object} sourceFile
 * @param {object} checker the file's real TypeScript `Checker`
 * @returns {{node: object, api: 'appendChild'|'append', scopePath: string[], scopeNode: object|null, pos: number}[]}
 */
function bodyMountCandidates(sourceFile, checker) {
  const candidates = [];
  walkTree(sourceFile, (node) => {
    if (node.kind !== SyntaxKind.CallExpression) return;
    const callee = node.expression;
    let apiName = null;
    let receiver = null;
    if (callee.kind === SyntaxKind.PropertyAccessExpression) {
      apiName = callee.name.text;
      receiver = callee.expression;
    } else if (callee.kind === SyntaxKind.ElementAccessExpression) {
      const arg = callee.argumentExpression;
      if (arg && (arg.kind === SyntaxKind.StringLiteral || arg.kind === SyntaxKind.NoSubstitutionTemplateLiteral)) {
        apiName = arg.text;
        receiver = callee.expression;
      }
    }
    if (apiName !== 'appendChild' && apiName !== 'append') return;
    if (!receiver) return;
    if (!resolvesToDocumentBody(receiver, checker)) return;
    candidates.push({
      node, api: apiName, scopePath: enclosingScopePath(node), scopeNode: innermostScopeNode(node),
      pos: node.getStart(sourceFile),
    });
  });
  return candidates;
}

/** Apply `SHELL_BODY_MOUNT_POLICY` to `bodyMountCandidates(sourceFile)`'s
 *  result: group by (filename, scope path), sort each group by source
 *  position, and flag every occurrence beyond the approved count (or every
 *  occurrence at all, for a scope with no policy entry) — plus every
 *  occurrence in an entry whose `requiresLifecycle` composition is missing.
 *  Flagging the EXCESS occurrences specifically (not the whole group) means
 *  the first N approved mounts stay clean while a genuinely new (N+1)th one
 *  is pinpointed. A SECOND pass then walks every `SHELL_BODY_MOUNT_POLICY`
 *  entry for THIS file and flags the ones whose approved count is no longer
 *  matched by the current tree — the reviewed #672 P1: the excess-only loop
 *  above only ever visits a scope that still has at least one candidate, so
 *  a scope whose LAST occurrence disappeared (or whose count dropped below
 *  its frozen baseline) would otherwise produce zero violations, comparing
 *  the policy and the discovered candidates as an exact multiset in only one
 *  direction. */
function shellBodyMountViolations(sourceFile, filename, checker) {
  const byScope = new Map();
  for (const c of bodyMountCandidates(sourceFile, checker)) {
    const key = scopeKey(c.scopePath);
    const list = byScope.get(key) ?? [];
    list.push(c);
    byScope.set(key, list);
  }
  const violations = [];
  for (const [key, list] of byScope) {
    list.sort((a, b) => a.pos - b.pos);
    const entry = SHELL_BODY_MOUNT_POLICY.find((e) => e.filename === filename && scopeKey(e.scopePath) === key);
    const allowedCount = entry ? entry.count : 0;
    const lifecycleOk = !entry?.requiresLifecycle || hasCallNamed(list[0].scopeNode, 'openSurfaceLifecycle');
    for (let idx = 0; idx < list.length; idx++) {
      if (idx < allowedCount && lifecycleOk) continue;
      const reason = !entry
        ? 'no #592 body-mount policy entry exists for this scope'
        : !lifecycleOk
          ? 'its SurfaceLifecycle composition (openSurfaceLifecycle(...)) is missing from this scope'
          : `this scope already has its approved ${allowedCount} occurrence(s)`;
      violations.push(makeViolation(
        'shell-body-mount', filename, list[idx].pos,
        `Document-body .${list[idx].api}(...) in scope "${key}" is not on the approved #592 body-mount snapshot (${reason}) — `
          + 'use the docked inspectorHost + SurfaceLifecycle, an established dialog/popover primitive, or deliberately update the documented exception snapshot',
      ));
    }
  }
  const declaredScopes = declaredScopeKeys(sourceFile);
  for (const entry of SHELL_BODY_MOUNT_POLICY) {
    if (entry.filename !== filename) continue;
    const key = scopeKey(entry.scopePath);
    if (!declaredScopes.has(key)) continue; // scope not part of what was scanned — see declaredScopeKeys
    const actualCount = (byScope.get(key) ?? []).length;
    if (actualCount >= entry.count) continue;
    violations.push(makeViolation(
      'shell-body-mount', filename, 0,
      `the approved #592 body-mount snapshot expects ${entry.count} Document-body mount(s) in scope "${key}" `
        + `(${entry.category}), but only ${actualCount} remain — deliberately update the reviewed baseline if this `
        + 'mount was intentionally removed, or restore it if this is unintended drift',
    ));
  }
  return violations;
}

// ── Guard 3: `shell-capture-escape` ──────────────────────────────────────────

/**
 * The frozen #592 baseline for every global capture-phase `keydown` listener
 * with real Escape semantics: `src/ui/surface-lifecycle.ts`'s
 * `openSurfaceLifecycle` is the canonical shared owner; five further entries
 * are existing, DISTINCT panel/overlay lifecycles #586 deliberately keeps
 * separate (dialog-shell, both popover families, `results.ts`'s Data Pane,
 * both `explain-graph.ts` detail surfaces, `menu.ts`); three further entries
 * are non-panel GESTURE cancellation (`dashboard-tile-gestures.ts`'s grid-
 * resize and tile-drag Escape handlers, `dashboard-chart-interaction.ts`'s
 * chart range-selection cancellation) — a different semantic category from a
 * panel-close lifecycle, kept in the same table only because both need the
 * identical exact-fingerprint/count enforcement shape. None of these
 * categories authorizes a SECOND listener beside it (count-bounded, per
 * scope) or a listener ANYWHERE ELSE in the same file (scope-path-bounded,
 * never filename-bounded).
 */
const SHELL_CAPTURE_ESCAPE_POLICY = Object.freeze([
  { filename: 'src/ui/surface-lifecycle.ts', scopePath: ['openSurfaceLifecycle'], count: 1,
    category: 'canonical shared SurfaceLifecycle owner' },
  { filename: 'src/ui/dialog-shell.ts', scopePath: ['openDialogShell'], count: 1,
    category: 'existing distinct panel/overlay exception: dialog-shell' },
  { filename: 'src/ui/popover.ts', scopePath: ['openAnchoredDialog'], count: 1,
    category: 'existing distinct panel/overlay exception: popover anchored-dialog family' },
  { filename: 'src/ui/popover.ts', scopePath: ['createAnchoredPopovers', 'open'], count: 1,
    category: 'existing distinct panel/overlay exception: popover anchored-popover family' },
  { filename: 'src/ui/results.ts', scopePath: ['expandDataPane', 'mount'], count: 1,
    category: 'existing distinct panel/overlay exception: Data Pane detail path (not consolidated by #586)' },
  { filename: 'src/ui/explain-graph.ts', scopePath: ['openPipelineFullscreen', 'mount'], count: 1,
    category: 'existing distinct panel/overlay exception: EXPLAIN pipeline detail surface' },
  { filename: 'src/ui/explain-graph.ts', scopePath: ['openSchemaView', 'mount'], count: 1,
    category: 'existing distinct panel/overlay exception: schema-lineage detail surface' },
  { filename: 'src/ui/menu.ts', scopePath: ['openMenu'], count: 1,
    category: 'existing distinct panel/overlay exception: menu primitive' },
  { filename: 'src/ui/dashboard-tile-gestures.ts', scopePath: ['createTileGestureController', 'wireGridResize', '<anonymous>'], count: 1,
    category: 'non-panel gesture cancellation: grid-resize Escape cancel' },
  { filename: 'src/ui/dashboard-tile-gestures.ts', scopePath: ['createTileGestureController', 'wireTileDrag', 'onPointerDown'], count: 1,
    category: 'non-panel gesture cancellation: tile-drag reorder Escape cancel' },
  { filename: 'src/ui/dashboard-chart-interaction.ts', scopePath: ['createDashboardChartInteractionController', 'beginSelection'], count: 1,
    category: 'non-panel gesture cancellation: chart range-selection Escape cancel' },
]);

/**
 * Every global capture-phase `keydown` `addEventListener` call in
 * `sourceFile`, classified — per the plan's candidate-listener/Escape-
 * recognition/fail-closed requirements:
 *   - the receiver must resolve to a recognized Document/Window
 *     (`resolveGlobalKind`) — anything else is not a candidate at all;
 *   - a MISSING third argument is provably non-capture (bubble phase) —
 *     not a candidate;
 *   - a third argument that resolves (`resolveCaptureFlag`) to exactly
 *     `false` is provably non-capture — not a candidate;
 *   - a third argument that cannot be resolved enough to PROVE non-capture
 *     (an unrecognized shape) is `'uncheckable-options'` — always a
 *     violation, fail-closed, never silently treated as non-capture;
 *   - once capture is proven `true`, the handler argument must resolve
 *     (`resolveHandlerNode`) to a real function; an unresolved handler is
 *     `'uncheckable-handler'` — always a violation, fail-closed;
 *   - a resolved handler with real Escape semantics (`containsEscapeSemantics`)
 *     is `'escape'`; without any is `'clean'` (a generic capture keydown
 *     activity/highlight listener, e.g. `dashboard.ts`'s
 *     `noteInteraction`/`clear` — structurally excluded here, before any
 *     policy table is consulted, exactly as the plan requires).
 *
 * Receiver/options/handler resolution is delegated entirely to the real
 * TypeScript checker (`resolveGlobalKind`/`resolveCaptureFlag`/
 * `resolveHandlerNode`, Architecture decision 6) — this function's own job
 * stays purely syntactic call-shape discovery (`addEventListener('keydown',
 * …)` call sites) and dispatch, unchanged.
 *
 * @param {object} sourceFile
 * @param {object} checker the file's real TypeScript `Checker`
 * @returns {{kind: 'escape'|'clean'|'uncheckable-handler'|'uncheckable-options', scopePath: string[], pos: number}[]}
 */
function captureEscapeCandidates(sourceFile, checker) {
  const out = [];
  walkTree(sourceFile, (node) => {
    if (node.kind !== SyntaxKind.CallExpression) return;
    const callee = node.expression;
    if (callee.kind !== SyntaxKind.PropertyAccessExpression || callee.name.text !== 'addEventListener') return;
    const args = node.arguments;
    if (args.length < 2) return;
    const evtArg = unwrapCastWrappers(args[0]);
    if (
      !evtArg || (evtArg.kind !== SyntaxKind.StringLiteral && evtArg.kind !== SyntaxKind.NoSubstitutionTemplateLiteral)
      || evtArg.text !== 'keydown'
    ) return;
    if (!resolveGlobalKind(callee.expression, checker)) return; // not Document/Window — not a candidate
    const pos = node.getStart(sourceFile);
    const scopePath = enclosingScopePath(node);
    const third = args[2];
    if (!third) return; // no options at all — provably non-capture (bubble phase)
    const captureFlag = resolveCaptureFlag(third, checker);
    if (captureFlag === false) return; // provably non-capture
    if (captureFlag === null) { out.push({ kind: 'uncheckable-options', scopePath, pos }); return; }
    const handlerNode = resolveHandlerNode(args[1], checker);
    if (!handlerNode) { out.push({ kind: 'uncheckable-handler', scopePath, pos }); return; }
    out.push({ kind: containsEscapeSemantics(handlerNode) ? 'escape' : 'clean', scopePath, pos });
  });
  return out;
}

/** Apply `SHELL_CAPTURE_ESCAPE_POLICY` to `captureEscapeCandidates(sourceFile)`'s
 *  result: every `'uncheckable-*'` candidate is an unconditional violation
 *  (fail-closed, never eligible for a policy match); every `'clean'`
 *  candidate is dropped (no Escape semantics — outside this rule entirely);
 *  every `'escape'` candidate is grouped by scope path and compared against
 *  the frozen policy the same excess-occurrence way `shellBodyMountViolations`
 *  compares body mounts — plus the same SECOND, reverse pass over every
 *  `SHELL_CAPTURE_ESCAPE_POLICY` entry for this file, flagging any whose
 *  approved count is no longer matched (the reviewed #672 P1: a disappeared
 *  frozen Escape listener is exactly as much a drift from the baseline as an
 *  added one, and the excess-only loop below can never see a scope that lost
 *  its last occurrence). */
function shellCaptureEscapeViolations(sourceFile, filename, checker) {
  const byScope = new Map();
  const violations = [];
  for (const c of captureEscapeCandidates(sourceFile, checker)) {
    if (c.kind === 'uncheckable-handler') {
      violations.push(makeViolation(
        'shell-capture-escape', filename, c.pos,
        'a global capture-phase keydown handler could not be statically resolved to a real function — treat as a '
          + 'potential Escape lifecycle: use SurfaceLifecycle, or make the handler statically resolvable',
      ));
      continue;
    }
    if (c.kind === 'uncheckable-options') {
      violations.push(makeViolation(
        'shell-capture-escape', filename, c.pos,
        "a global keydown listener's capture option could not be proven non-capture — treat as a potential Escape "
          + 'lifecycle: use SurfaceLifecycle, or make the options resolvable',
      ));
      continue;
    }
    if (c.kind === 'clean') continue;
    const key = scopeKey(c.scopePath);
    const list = byScope.get(key) ?? [];
    list.push(c);
    byScope.set(key, list);
  }
  for (const [key, list] of byScope) {
    list.sort((a, b) => a.pos - b.pos);
    const entry = SHELL_CAPTURE_ESCAPE_POLICY.find((e) => e.filename === filename && scopeKey(e.scopePath) === key);
    const allowedCount = entry ? entry.count : 0;
    for (let idx = 0; idx < list.length; idx++) {
      if (idx < allowedCount) continue;
      violations.push(makeViolation(
        'shell-capture-escape', filename, list[idx].pos,
        `a global capture-phase Escape keydown listener in scope "${key}" is not on the approved #592 lifecycle/`
          + 'exception snapshot — use SurfaceLifecycle for a shell/panel lifecycle, or deliberately register a '
          + 'narrow documented exception/non-panel gesture exclusion where that is genuinely the architecture',
      ));
    }
  }
  const declaredScopes = declaredScopeKeys(sourceFile);
  for (const entry of SHELL_CAPTURE_ESCAPE_POLICY) {
    if (entry.filename !== filename) continue;
    const key = scopeKey(entry.scopePath);
    if (!declaredScopes.has(key)) continue; // scope not part of what was scanned — see declaredScopeKeys
    const actualCount = (byScope.get(key) ?? []).length;
    if (actualCount >= entry.count) continue;
    violations.push(makeViolation(
      'shell-capture-escape', filename, 0,
      `the approved #592 capture-Escape snapshot expects ${entry.count} listener(s) in scope "${key}" `
        + `(${entry.category}), but only ${actualCount} remain — deliberately update the reviewed baseline if this `
        + 'listener was intentionally removed, or restore it if this is unintended drift',
    ));
  }
  return violations;
}

/**
 * Issue #592 — the batched body-mount + capture-Escape source contract, real-
 * parser-backed, over ONE shared `withParsedSources` batch for the complete
 * `sources` set (never one parser process per rule or per file — Architecture
 * decision 4). Returns `shell-body-mount` and `shell-capture-escape`
 * violations together. Each file's real TypeScript `checker` (also produced
 * by that same one batch — Architecture decision 6, #592 addendum) is handed
 * to both guards so identifier-binding questions ("what does this receiver/
 * handler/options identifier resolve to") are answered by the real binder,
 * never a hand-rolled scope walk.
 *
 * @param {readonly {filename: string, source: string}[]} sources
 * @returns {{rule: string, filename: string, pos: number, detail: string}[]}
 */
export function findShellGuardrailSourceContractViolations(sources) {
  return withParsedSources(sources, (sourceFiles, checkers) => {
    const violations = [];
    for (const [filename, sourceFile] of sourceFiles) {
      const checker = checkers.get(filename);
      violations.push(...shellBodyMountViolations(sourceFile, filename, checker));
      violations.push(...shellCaptureEscapeViolations(sourceFile, filename, checker));
    }
    return violations;
  });
}

/** The STRICT (complete-tree) count of every `SHELL_BODY_MOUNT_POLICY` entry
 *  belonging to `filename`, against `sourceFile`'s real `bodyMountCandidates`
 *  — unlike `shellBodyMountViolations`'s own softened reverse pass, this
 *  NEVER consults `declaredScopeKeys` first: a genuinely deleted approved
 *  function-like scope simply contributes zero occurrences here, exactly
 *  like a real disappeared mount within a still-present scope does, because
 *  this function's only caller (`findShellGuardrailMissingBaselineViolations`)
 *  already guarantees `sourceFile` is the complete real file, never a
 *  partial synthetic fixture. */
function shellBodyMountMissingBaselineViolationsStrict(sourceFile, filename, checker) {
  const counts = new Map();
  for (const c of bodyMountCandidates(sourceFile, checker)) {
    const key = scopeKey(c.scopePath);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const violations = [];
  for (const entry of SHELL_BODY_MOUNT_POLICY) {
    if (entry.filename !== filename) continue;
    const key = scopeKey(entry.scopePath);
    const actualCount = counts.get(key) ?? 0;
    if (actualCount >= entry.count) continue;
    violations.push(makeViolation(
      'shell-body-mount', filename, 0,
      `the approved #592 body-mount snapshot expects ${entry.count} Document-body mount(s) in scope "${key}" `
        + `(${entry.category}), but only ${actualCount} remain in the complete scanned tree — deliberately update `
        + 'the reviewed baseline if this mount was intentionally removed, or restore it if this is unintended drift',
    ));
  }
  return violations;
}

/** `shellBodyMountMissingBaselineViolationsStrict`'s exact counterpart for
 *  `SHELL_CAPTURE_ESCAPE_POLICY` — counts only `'escape'`-classified
 *  candidates (an `'uncheckable-*'`/`'clean'` candidate is a DIFFERENT
 *  question this reverse pass never re-litigates; the forward pass already
 *  owns those). */
function shellCaptureEscapeMissingBaselineViolationsStrict(sourceFile, filename, checker) {
  const counts = new Map();
  for (const c of captureEscapeCandidates(sourceFile, checker)) {
    if (c.kind !== 'escape') continue;
    const key = scopeKey(c.scopePath);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const violations = [];
  for (const entry of SHELL_CAPTURE_ESCAPE_POLICY) {
    if (entry.filename !== filename) continue;
    const key = scopeKey(entry.scopePath);
    const actualCount = counts.get(key) ?? 0;
    if (actualCount >= entry.count) continue;
    violations.push(makeViolation(
      'shell-capture-escape', filename, 0,
      `the approved #592 capture-Escape snapshot expects ${entry.count} listener(s) in scope "${key}" `
        + `(${entry.category}), but only ${actualCount} remain in the complete scanned tree — deliberately update `
        + 'the reviewed baseline if this listener was intentionally removed, or restore it if this is unintended '
        + 'drift',
    ));
  }
  return violations;
}

/**
 * The complete-tree REVERSE half of the #592 shell-guardrail source
 * contract — deliberately SEPARATE from `findShellGuardrailSourceContractViolations`,
 * for the exact reason `findShellFixedPositionMissingBaselineViolations` is
 * a separate export from `findShellFixedPositionViolations` (see that
 * pair's own doc comments): `declaredScopeKeys`'s own softening — "a scope
 * not part of what was scanned is not this call's concern" — exists ONLY to
 * keep the forward check's reverse pass safe for this suite's many minimal
 * single-scope synthetic fixtures (a fixture reproducing just ONE of a real
 * file's several approved scopes, under that file's real name). It CANNOT
 * tell a genuinely complete file with an approved function/scope deleted
 * apart from a fixture that never declared that scope to begin with — both
 * simply lack a function-like node at that scope path — so a real approved
 * function's outright deletion (or an approved FILE's outright deletion)
 * produced zero violations from the forward check's own reverse pass alone
 * (PR #672 review pass 1 follow-up, ChatGPT): the forward check's own
 * per-file loop (`findShellGuardrailSourceContractViolations` above) never
 * even iterates a filename `sources` doesn't contain, and its softened
 * reverse pass skips a scope that no longer parses out of a still-present
 * file exactly like it skips one that was never in scope at all.
 *
 * This export assumes `sources` IS the complete scanned tree (its only real
 * caller is `build/check-boundaries.mjs`'s live `collectFiles(src/)` batch,
 * which reads every file under `src/**` from disk) and reports, WITHOUT
 * that softening:
 *   - every `SHELL_BODY_MOUNT_POLICY`/`SHELL_CAPTURE_ESCAPE_POLICY` entry
 *     whose OWN `filename` has no matching entry in `sources` at all — a
 *     whole approved FILE deleted outright;
 *   - every remaining entry whose approved scope's real occurrence count is
 *     below its frozen baseline — covering BOTH a dropped count within a
 *     still-present function AND an approved function deleted (or renamed)
 *     outright, uniformly: a deleted function-like node simply has no
 *     scope-path key in the real tree at all, so it counts as zero
 *     occurrences exactly like a real disappeared mount/listener, with no
 *     "declared at all" softening asked first.
 *
 * @param {readonly {filename: string, source: string}[]} sources
 * @returns {{rule: string, filename: string, pos: number, detail: string}[]}
 */
export function findShellGuardrailMissingBaselineViolations(sources) {
  const present = new Set(sources.map((s) => s.filename));
  const violations = [];
  for (const entry of SHELL_BODY_MOUNT_POLICY) {
    if (present.has(entry.filename)) continue;
    violations.push(makeViolation(
      'shell-body-mount', entry.filename, 0,
      `the approved #592 body-mount snapshot expects ${entry.count} Document-body mount(s) in scope `
        + `"${scopeKey(entry.scopePath)}" (${entry.category}), but ${entry.filename} is not part of the scanned `
        + 'tree at all — deliberately update the reviewed baseline if this file was intentionally removed, or '
        + 'restore it if this is unintended drift',
    ));
  }
  for (const entry of SHELL_CAPTURE_ESCAPE_POLICY) {
    if (present.has(entry.filename)) continue;
    violations.push(makeViolation(
      'shell-capture-escape', entry.filename, 0,
      `the approved #592 capture-Escape snapshot expects ${entry.count} listener(s) in scope `
        + `"${scopeKey(entry.scopePath)}" (${entry.category}), but ${entry.filename} is not part of the scanned `
        + 'tree at all — deliberately update the reviewed baseline if this file was intentionally removed, or '
        + 'restore it if this is unintended drift',
    ));
  }
  const neededFilenames = new Set([
    ...SHELL_BODY_MOUNT_POLICY.map((e) => e.filename),
    ...SHELL_CAPTURE_ESCAPE_POLICY.map((e) => e.filename),
  ]);
  const toParse = sources.filter((s) => neededFilenames.has(s.filename));
  if (toParse.length === 0) return violations;
  return violations.concat(withParsedSources(toParse, (sourceFiles, checkers) => {
    const out = [];
    for (const [filename, sourceFile] of sourceFiles) {
      const checker = checkers.get(filename);
      out.push(...shellBodyMountMissingBaselineViolationsStrict(sourceFile, filename, checker));
      out.push(...shellCaptureEscapeMissingBaselineViolationsStrict(sourceFile, filename, checker));
    }
    return out;
  }));
}

// ── Guard 2: `shell-fixed-position` (focused CSS lexical scanner) ───────────
//
// No CSS parser dependency (Architecture decision 2) — a small hand-written
// lexer that skips `/* … */` comments, respects quoted strings and escape
// sequences, tracks brace nesting via an explicit frame stack (one frame per
// rule/at-rule, so a `position: fixed` declaration is always associated with
// its OWN enclosing selector list and the FULL chain of enclosing at-rules,
// never a sibling's), and normalizes whitespace/comma-selector-lists deterministically
// so the SAME logical selector always produces the SAME policy key regardless
// of incidental source formatting.

/** Collapse every run of whitespace (including comment text collapsed to a
 *  single space by the scanner below) to one space, and trim. */
function normalizeCssText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** Decode real CSS identifier ESCAPE SEQUENCES (#592 review pass 3) — a
 *  backslash followed by 1-6 hex digits (optionally consuming ONE trailing
 *  whitespace character that terminates the hex run, per the CSS spec) is
 *  that Unicode code point; a backslash followed by any other single
 *  character is that literal character. `scanFixedPositionDeclarations`'s
 *  main scan loop deliberately copies a backslash escape into its buffer
 *  VERBATIM (never decoding it) purely so an escaped delimiter char — `\;`,
 *  `\{`, `\}` — can never be mistaken for real CSS structure; it was never
 *  claiming the escaped TEXT itself was already normalized. Without this
 *  decode step, valid CSS like `\70osition: fixed;` (property) or
 *  `position: \66ixed;` (value) — both real, spec-legal escapes that every
 *  real CSS engine parses as plain `position: fixed` — stayed textually
 *  distinct from `'position'`/`'fixed'` and silently bypassed
 *  `processDeclaration`'s exact string comparisons. Applied ONLY to the
 *  already-colon-split property/value text right before comparison, never
 *  to the raw buffer used for colon/brace/semicolon SPLITTING itself (a
 *  decoded escape could change the text's length, which must never disturb
 *  where a declaration was actually delimited). */
function decodeCssEscapes(text) {
  return text.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_m, hex, literal) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      return Number.isNaN(code) ? '' : String.fromCodePoint(code);
    }
    return literal ?? '';
  });
}

/** `normalizeCssText`, plus deterministic `,`-separated selector-list
 *  spacing (`', '` between each selector) regardless of the source's own
 *  comma spacing — so `.a,.b` and `.a, .b` produce the identical policy key,
 *  and appending a new selector to an existing approved group still changes
 *  the key (the plan's own point: a comma-separated selector list is ONE
 *  exact normalized policy key, so growing the list is a reviewable change). */
function normalizeSelectorList(text) {
  return normalizeCssText(text).replace(/\s*,\s*/g, ', ');
}

/** The offset of the first real (non-whitespace, non-`/* … *\/`-comment)
 *  character at or after `from` in the ORIGINAL `source` text — used to
 *  report an accurate declaration offset even though the scanner's internal
 *  buffer collapses comments to a single space (which would otherwise
 *  misalign a naive "trim the buffered text" offset against the real file). */
function firstMeaningfulCssOffset(source, from) {
  let i = from;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Scan `source` (a complete CSS stylesheet) for every real `position: fixed`
 * (optionally `!important`) declaration, associating each with its own
 * enclosing rule's normalized selector list (`normalizeSelectorList`) and the
 * FULL chain of enclosing at-rules' normalized preludes (`normalizeCssText`),
 * outermost first, joined with `' > '` — or `null` when the declaration sits
 * at the stylesheet's top level with no enclosing at-rule at all (e.g. NOT
 * inside `@media`). #592 review pass 2: the prior implementation stopped at
 * the NEAREST enclosing at-rule only, so wrapping an already-approved rule in
 * an ADDITIONAL outer at-rule (`@supports (display: grid) { @media (...) {
 * .inspector-host { position: fixed; } } }`) produced the identical
 * fingerprint as the unwrapped rule — a real, behavior-changing structural
 * edit (the rule now only applies when `@supports` also matches) was
 * completely invisible to both `findShellFixedPositionViolations` and its
 * missing-baseline reverse pass. A declaration sitting directly inside an
 * at-rule with no intervening rule block (e.g. hypothetical `@page` content)
 * is not reported — this rule only governs SELECTOR-scoped declarations,
 * matching its own "associates a real position: fixed declaration with its
 * rule prelude" contract. Comments/strings/escapes never contribute a
 * phantom brace/semicolon/colon, so lexical trickery can't hide or spoof a
 * declaration (see this section's own header comment) — and (#592 review
 * pass 3) a real CSS identifier escape (`\70osition: fixed;`,
 * `position: \66ixed;`) can't hide one either: `processDeclaration` decodes
 * the property/value text (`decodeCssEscapes`) before comparing, so an
 * escaped spelling that real CSS parses identically to `position`/`fixed`
 * is recognized identically here too. `nested` is `true` when the
 * declaration's own rule sits inside another plain STYLE rule — real CSS
 * nesting (`.wrapper { .auth-host { position: fixed; } }` compiles to the
 * descendant selector `.wrapper .auth-host`, a genuinely different,
 * never-approved selector context) — as opposed to only at-rule ancestors
 * (#592 review pass, ChatGPT PR #672 pass 1): the at-chain builder above only
 * ever recorded 'at'-kind ancestor frames, silently skipping over any
 * enclosing 'rule'-kind frame instead of folding it into the fingerprint or
 * rejecting it, so a nested plain rule fingerprinted identically to its
 * unwrapped, already-approved counterpart.
 *
 * @param {string} source
 * @returns {{selector: string, atRule: string | null, nested: boolean, pos: number}[]}
 */
export function scanFixedPositionDeclarations(source) {
  const n = source.length;
  let i = 0;
  const frames = []; // { kind: 'rule'|'at', prelude: string }
  const results = [];
  let buf = '';
  let segStart = 0;

  function readString(quote) {
    let s = source[i]; i++;
    while (i < n) {
      const c = source[i];
      if (c === '\\') { s += c + (source[i + 1] ?? ''); i += 2; continue; }
      s += c; i++;
      if (c === quote) break;
    }
    return s;
  }

  function processDeclaration(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // Colon-split on the RAW (still-escaped) text — decoding first could
    // shift where the real declaration boundary sits; only the two SIDES
    // are decoded, right before the property-name/value comparisons below.
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) return;
    const prop = decodeCssEscapes(trimmed.slice(0, colonIdx)).trim();
    const value = decodeCssEscapes(trimmed.slice(colonIdx + 1)).trim();
    if (prop.toLowerCase() !== 'position') return;
    if (!/^fixed(\s*!\s*important)?$/i.test(normalizeCssText(value))) return;
    const innermost = frames[frames.length - 1];
    if (!innermost || innermost.kind !== 'rule') return; // no selector context — out of this rule's scope
    const atChain = [];
    let nested = false;
    for (let k = frames.length - 2; k >= 0; k--) {
      if (frames[k].kind === 'at') atChain.push(frames[k].prelude);
      else nested = true; // an enclosing 'rule'-kind frame, at ANY depth — real CSS nesting
    }
    atChain.reverse(); // outermost first
    const atRule = atChain.length ? atChain.join(' > ') : null;
    results.push({ selector: innermost.prelude, atRule, nested, pos: firstMeaningfulCssOffset(source, segStart) });
  }

  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      buf += ' ';
      continue;
    }
    if (c === '"' || c === "'") { buf += readString(c); continue; }
    if (c === '\\') { buf += c + (source[i + 1] ?? ''); i += 2; continue; }
    if (c === '{') {
      const isAt = normalizeCssText(buf).startsWith('@');
      const prelude = isAt ? normalizeCssText(buf) : normalizeSelectorList(buf);
      frames.push({ kind: isAt ? 'at' : 'rule', prelude });
      buf = ''; i++; segStart = i;
      continue;
    }
    if (c === '}') {
      processDeclaration(buf);
      frames.pop();
      buf = ''; i++; segStart = i;
      continue;
    }
    if (c === ';') {
      processDeclaration(buf);
      buf = ''; i++; segStart = i;
      continue;
    }
    buf += c; i++;
  }
  processDeclaration(buf); // a trailing declaration with no closing `;`/`}` (malformed, defensive)
  return results;
}

/** The frozen #592 baseline: the exact current `position: fixed` selector/
 *  at-rule snapshot of `src/styles.css`, generated by running
 *  `scanFixedPositionDeclarations` over the current file and reviewing every
 *  result (never hard-coding the issue attachment's approximate count) —
 *  authentication recovery, both file-menu overlay/dialog rules, the share
 *  toast, the export-progress banner, the shortcuts modal, the fullscreen
 *  pipeline-graph overlay, the whole variable/popover family (the combobox
 *  list + its "clear recent" footer, the multiselect popover, the shared
 *  anchored-dialog overlay, the time-range popover), the cell-detail overlay,
 *  and the narrow-viewport `.inspector-host` rule (deliberate post-#586
 *  mobile behavior, under its own `@media (max-width: 768px)` context). */
const SHELL_FIXED_POSITION_POLICY = Object.freeze([
  { selector: '.auth-host', atRule: null },
  { selector: '.fm-overlay', atRule: null },
  { selector: '.fm-dialog-backdrop', atRule: null },
  { selector: '.share-toast', atRule: null },
  { selector: '.export-progress', atRule: null },
  { selector: '.modal-backdrop', atRule: null },
  { selector: '.graph-overlay', atRule: null },
  { selector: '.var-combo-list', atRule: null },
  { selector: '.var-combo-footer', atRule: null },
  { selector: '.ms-popover', atRule: null },
  { selector: '.popover-overlay', atRule: null },
  { selector: '.trf-popover', atRule: null },
  { selector: '.cell-detail-overlay', atRule: null },
  { selector: '.inspector-host', atRule: '@media (max-width: 768px)' },
]);

/** The one fingerprint convention every `(selector, atRule)` comparison in
 *  this guard shares — `JSON.stringify([selector, atRule])`, so `null`
 *  (no enclosing at-rule) and the empty string are never conflated with each
 *  other, and no separator character or escaping scheme has to be invented
 *  (unlike a hand-joined string key, which risks exactly the kind of
 *  accidental-separator collision this guard exists to rule out). */
function fixedPositionKey(selector, atRule) {
  return JSON.stringify([selector, atRule]);
}

/**
 * The `shell-fixed-position` guard's FORWARD half:
 * `scanFixedPositionDeclarations(cssSource)` grouped by exact
 * `(selector, atRule)` fingerprint, compared against
 * `SHELL_FIXED_POSITION_POLICY` by COUNT, not mere membership — the
 * reviewed #672 P1: the prior implementation was a `.some(...)` membership
 * check with no count at all, so a SECOND declaration reusing an already-
 * approved fingerprint silently passed. Every declaration beyond a
 * fingerprint's approved count (1, today, for every entry — a duplicate of
 * an approved snapshot row is exactly the same un-reviewed regrowth risk a
 * brand-new selector is) is flagged.
 *
 * The REVERSE direction (an approved fingerprint that disappeared from the
 * CSS entirely) is `findShellFixedPositionMissingBaselineViolations` — a
 * deliberately separate export; see its own doc comment for why folding it
 * in here would break this suite's many minimal single-selector fixtures.
 *
 * A `nested` declaration (real CSS nesting under another plain style rule —
 * `scanFixedPositionDeclarations`'s own doc comment) is NEVER compared
 * against `SHELL_FIXED_POSITION_POLICY` by fingerprint at all — it is
 * unconditionally flagged (#592 review pass, ChatGPT PR #672 pass 1): its
 * `(selector, atRule)` fingerprint can otherwise be textually IDENTICAL to
 * an already-approved top-level entry's (`.wrapper { .auth-host { position:
 * fixed; } }` fingerprints as bare `.auth-host`/`atRule: null`, exactly like
 * the approved, unwrapped baseline row), even though the rule's REAL
 * effective selector changed (`.wrapper .auth-host`, a descendant
 * selector) — a genuinely reviewable structural edit a fingerprint
 * comparison alone can never distinguish from the unwrapped baseline.
 *
 * @param {string} cssSource
 * @param {string} filename repo-relative, forward-slash separated (report only)
 * @returns {{rule: string, filename: string, pos: number, detail: string}[]}
 */
export function findShellFixedPositionViolations(cssSource, filename) {
  const violations = [];
  const byKey = new Map(); // fingerprint -> decl[]
  for (const decl of scanFixedPositionDeclarations(cssSource)) {
    if (decl.nested) {
      violations.push(makeViolation(
        'shell-fixed-position', filename, decl.pos,
        `position: fixed on selector "${decl.selector}"${decl.atRule ? ` inside ${decl.atRule}` : ''} is nested `
          + 'inside another plain style rule (real CSS nesting changes its effective selector context, e.g. to a '
          + 'descendant selector) — this is never an approved #592 fixed-position shape; hoist the declaration out '
          + 'to a top-level (or purely at-rule-scoped) rule, or deliberately extend the reviewed fixed-position '
          + 'snapshot for a legitimate nested overlay',
      ));
      continue;
    }
    const key = fixedPositionKey(decl.selector, decl.atRule);
    const list = byKey.get(key) ?? [];
    list.push(decl);
    byKey.set(key, list);
  }
  for (const [key, list] of byKey) {
    const allowedCount = SHELL_FIXED_POSITION_POLICY.filter(
      (p) => fixedPositionKey(p.selector, p.atRule) === key,
    ).length;
    for (let idx = 0; idx < list.length; idx++) {
      if (idx < allowedCount) continue;
      const decl = list[idx];
      const reason = allowedCount === 0
        ? 'is not on the approved #592 fixed-position snapshot'
        : `duplicates an already-approved #592 fixed-position snapshot entry (approved count: ${allowedCount})`;
      violations.push(makeViolation(
        'shell-fixed-position', filename, decl.pos,
        `position: fixed on selector "${decl.selector}"${decl.atRule ? ` inside ${decl.atRule}` : ''} ${reason} — `
          + 'use shell/docked composition where appropriate, or deliberately extend the reviewed fixed-position '
          + 'snapshot for a legitimate overlay',
      ));
    }
  }
  return violations;
}

/**
 * The REVERSE half of the #672 P1 fixed-position fix: every
 * `SHELL_FIXED_POSITION_POLICY` entry with ZERO matching occurrences in
 * `cssSource` — a frozen approved fingerprint that has disappeared entirely,
 * leaving stale permission for its silent, un-reviewed reintroduction.
 *
 * Deliberately a SEPARATE export from `findShellFixedPositionViolations`,
 * unlike the TS body-mount/capture-escape guards' own reverse pass (which
 * can safely stay INSIDE their single exported check, because a real
 * function-like scope either is or isn't declared in whatever was parsed —
 * `declaredScopeKeys` lets that check tell a partial synthetic fixture
 * apart from the real file). CSS carries no equivalent structural signal: a
 * `cssSource` naming only `.auth-host` could be the real, complete
 * `src/styles.css` missing its other 13 entries, or it could be one of this
 * suite's own many deliberately minimal single-selector fixtures — nothing
 * about the string itself distinguishes the two. Folding this check into
 * `findShellFixedPositionViolations` would make EVERY existing minimal CSS
 * fixture in this test suite report 13+ false "missing" violations. This
 * function is therefore meaningful only against something the caller
 * already knows is the complete stylesheet — the real `check:arch` gate
 * (`build/check-boundaries.mjs`) and the live-tree baseline test are its
 * only two real callers, both scanning the actual, complete
 * `src/styles.css`.
 *
 * @param {string} cssSource
 * @param {string} filename repo-relative, forward-slash separated (report only)
 * @returns {{rule: string, filename: string, pos: number, detail: string}[]}
 */
export function findShellFixedPositionMissingBaselineViolations(cssSource, filename) {
  // A `nested` declaration's fingerprint never counts as "still present" for
  // an approved baseline entry (#592 review pass, ChatGPT PR #672 pass 1):
  // `findShellFixedPositionViolations` already unconditionally flags it on
  // its own, and its REAL effective selector is no longer the approved
  // top-level one (a descendant selector under its new enclosing rule) —
  // wrapping the approved rule in a new enclosing style rule must report the
  // ORIGINAL fingerprint missing, exactly like an outright removal would.
  const found = new Set(
    scanFixedPositionDeclarations(cssSource).filter((d) => !d.nested).map((d) => fixedPositionKey(d.selector, d.atRule)),
  );
  const violations = [];
  for (const entry of SHELL_FIXED_POSITION_POLICY) {
    const key = fixedPositionKey(entry.selector, entry.atRule);
    if (found.has(key)) continue;
    violations.push(makeViolation(
      'shell-fixed-position', filename, 0,
      `the approved #592 fixed-position snapshot expects a position: fixed declaration on selector `
        + `"${entry.selector}"${entry.atRule ? ` inside ${entry.atRule}` : ''}, but none remain in ${filename} — `
        + 'deliberately update the reviewed baseline if this was intentionally removed, or restore it if this is '
        + 'unintended drift',
    ));
  }
  return violations;
}
