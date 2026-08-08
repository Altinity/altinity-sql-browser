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
// framework): exactly the three former production owners of the moved
// progress-stream/exception-parsing primitives, and exactly the identifier/
// property names Phase 3 moved into `@altinity/clickhouse-http`. An AST walk
// flags any Identifier with a moved name — a declaration, an import/export
// specifier, a member reference — and any string-literal property/member
// name (`{ "streamLines": … }`), so a second implementation and a forwarding
// wrapper both fail. Intentionally obfuscated constructs (computed strings,
// dynamically built property names) are outside this check's threat model.
// Comments and JSDoc are trivia to the parser, so prose narrating the move
// can never false-positive.

import path from 'node:path';
import { API } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { SyntaxKind } from 'typescript/unstable/ast';

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

const MOVED = new Set(PHASE3_MOVED_NAMES);

/**
 * Parse `source` with the real TypeScript parser and return the moved names
 * it declares or references (in `PHASE3_MOVED_NAMES` order, deduplicated).
 * `filename` is the repo-relative path the source claims to be; files that
 * are not one of the three legacy owners are out of scope and return `[]`.
 *
 * @param {string} source
 * @param {string} filename repo-relative, forward-slash separated
 * @returns {string[]} the forbidden names found (empty when clean)
 */
export function findLegacyOwnerViolations(source, filename) {
  if (!PHASE3_LEGACY_OWNER_FILES.includes(filename)) return [];
  // The virtual path keeps the real basename so the parser applies the right
  // grammar for the file's extension (.ts here; never .tsx among the owners).
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
    const found = new Set();
    const walk = (node) => {
      if (node.kind === SyntaxKind.Identifier && MOVED.has(node.text)) {
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
          && MOVED.has(nameNode.text)
        ) {
          found.add(nameNode.text);
        }
      }
      node.forEachChild(walk);
    };
    walk(sourceFile);
    return PHASE3_MOVED_NAMES.filter((name) => found.has(name));
  } finally {
    api.close(); // always reap the native child process
  }
}
