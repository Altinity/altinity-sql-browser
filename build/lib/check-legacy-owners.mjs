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
 *     `export * from 'pkg'` (bypasses ever binding an import at all).
 * `import type`/`export type` declarations and individual type-only
 * specifiers (`import { type X }`) are never reported — they are erased
 * before this package's bare specifier would ever reach a browser or the
 * bundled artifact (see `build/e2e-serve.mjs`'s type-stripping, and esbuild's
 * own `import type` elision), so they carry no real package access.
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
        } else if (!clause.isTypeOnly) {
          if (clause.name) found.push({ kind: 'default' });
          const bindings = clause.namedBindings;
          if (bindings && is.isNamespaceImport(bindings)) {
            found.push({ kind: 'namespace' });
          } else if (bindings && is.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              if (el.isTypeOnly) continue;
              found.push({ kind: 'named', name: (el.propertyName ?? el.name).text });
            }
          }
        }
      }
      if (is.isExportDeclaration(node) && isTargetSpecifier(node.moduleSpecifier) && !node.isTypeOnly) {
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
      node.forEachChild(walk);
    };
    walk(sourceFile);
    return found;
  });
}
