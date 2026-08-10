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
// Scope stays deliberately narrow (this is NOT a generic static-analysis
// framework): exactly the former production owners of moved
// progress-stream/exception-parsing/quoting primitives, and exactly the
// identifier/property names each phase moved into `@altinity/clickhouse-http`
// (plus, for Rule D, exactly which of the package's OWN export names are
// pure-language vs. transport/protocol). An AST walk flags any Identifier
// with a moved name — a declaration, an import/export specifier, a member
// reference — and any string-literal property/member name (`{ "streamLines":
// … }`), so a second implementation and a forwarding wrapper both fail.
// Intentionally obfuscated constructs (computed strings, dynamically built
// property names) are outside this check's threat model. Comments and JSDoc
// are trivia to the parser, so prose narrating the move can never
// false-positive.
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
import { SyntaxKind } from 'typescript/unstable/ast';
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

// Parse `source` (claiming to be the repo-relative `filename`) with the real
// TypeScript parser and hand back its root AST node. Always used inside a
// try/finally that calls `api.close()` — the native child process must
// always be reaped, on every return path including a thrown parse failure.
function withParsedSource(source, filename, fn) {
  // The virtual path keeps the real basename so the parser applies the right
  // grammar for the file's extension (.ts here; never .tsx among any of the
  // owner files or import-usage callers below).
  const virtualPath = `/legacy-owner-check/${path.posix.basename(filename)}`;
  const api = new API({ fs: createVirtualFileSystem({ [virtualPath]: source }) });
  try {
    const snapshot = api.updateSnapshot({ openFiles: [virtualPath] });
    const sourceFile = snapshot
      .getDefaultProjectForFile(virtualPath)
      ?.program.getSourceFile(virtualPath);
    if (!sourceFile) {
      // Fail loud, never silently-clean: an unparseable probe must not read
      // as "no violations".
      throw new Error(`check-legacy-owners: could not parse ${filename}`);
    }
    return fn(sourceFile);
  } finally {
    api.close(); // always reap the native child process
  }
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
// dynamic-import call expression, so nothing is ever silently dropped: a
// `{ kind: 'static', spec }` where the caller's existing resolution logic can
// treat `spec` exactly like an ordinary import, and a `{ kind: 'uncheckable'
// }` that must always become a violation in a generic-guarded file,
// regardless of what its argument might eventually resolve to. A concatenated
// expression such as `import('../' + name)` is `uncheckable` in full — never
// reduced to the quoted `'../'` prefix, since that half alone proves nothing
// about the complete runtime specifier.
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
 * Classify every dynamic `import(...)` call expression in `source` — a real
 * TypeScript parse, never a specifier-text regex. Every call expression whose
 * callee is the bare `import` keyword contributes exactly one result; there
 * is no `if (spec !== null) push(...)` shape here that could silently drop an
 * unsupported argument (contrast `findModuleSpecifiers` above, whose whole
 * point is the opposite: silently skip what it cannot resolve, because ITS
 * callers have no fail-closed contract to uphold).
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated (used only
 *   for the virtual-file basename/grammar selection)
 * @returns {({kind: 'static', spec: string, pos: number} | {kind: 'uncheckable', pos: number})[]}
 *   `pos` is the call expression's own start offset (`node.getStart(sourceFile)`)
 *   — a stable identity a caller MAY use to de-duplicate the same occurrence
 *   across overlapping guarded-directory rules; it is not a line/column and
 *   is not required in any user-facing diagnostic.
 */
export function findDynamicImportUsages(source, filename) {
  return withParsedSource(source, filename, (sourceFile) => {
    const found = [];
    const walk = (node) => {
      if (
        is.isCallExpression(node)
        && node.expression
        && node.expression.kind === SyntaxKind.ImportKeyword
      ) {
        const pos = node.getStart(sourceFile);
        const arg = node.arguments[0];
        if (
          arg
          && (arg.kind === SyntaxKind.StringLiteral || arg.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
        ) {
          found.push({ kind: 'static', spec: arg.text, pos });
        } else {
          // Every other shape — a missing argument, an Identifier, a
          // template literal WITH a substitution, a binary concatenation, a
          // call, a conditional, a parenthesized/computed expression, or any
          // future shape this list does not name — is uncheckable. There is
          // deliberately no partial extraction attempt (e.g. reading a
          // template literal's first quasi span): that is precisely the class
          // of bug this issue exists to close (`import('../' + name)` must
          // never be treated as `'../'`).
          found.push({ kind: 'uncheckable', pos });
        }
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
