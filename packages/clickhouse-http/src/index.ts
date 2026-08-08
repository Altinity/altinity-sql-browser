// Issue #630 Phase 2 — the package's public surface. Only "." is exported
// (see `package.json`'s `exports` map): implementation subpaths (`./url`,
// `./client`) are not part of the public contract, and `build/check-
// boundaries.mjs` mechanically forbids any root SQL Browser source from
// deep-importing them. Every re-export below is a relative import, matching
// this package's zero-bare-specifier rule.
//
// Issue #630 Phase 3 — adds the progress-stream read loop and the HTTP
// exception-text/late-exception-frame parser (`progress-stream.ts`,
// `exceptions.ts`), same public-surface-only discipline.
//
// Issue #630 Phase 4 — adds the response classifier/consumers
// (`response.ts`), the minimal `ClickHouseError` (`exceptions.ts`), and the
// convenience query/kill types (`client.ts`), same public-surface-only
// discipline. `StreamCallbacks` continues to be exported under its existing
// name — no duplicate `ProgressStreamCallbacks` alias is introduced.
//
// Issue #630 Phase 5 — adds the ONE SQL-quoting implementation
// (`sql-quote.ts`: `sqlString`/`quoteIdent`/`qualifyIdent`) and the ONE
// generic ClickHouse type-expression grammar (`clickhouse-type.ts`), plus the
// shared lexical scanner (`sql-spans.ts`) their dependency closure requires —
// `scanSpans`/`Span`/`SpanKind` are re-exported here too because surviving
// SQL Browser SQL-analysis modules outside `src/net/**` still need them.
// `quoted-span.ts`'s lower-level `scanDelimited` stays package-private (not
// re-exported): only `sql-spans.ts`/`clickhouse-type.ts` import it, relatively.
// These are PURE LANGUAGE exports — the revised architecture Rule D
// (`build/check-boundaries.mjs`) allows their real SQL Browser consumers to
// import them directly outside `src/net/**`, while the transport/protocol
// surface above (`createClickHouseHttpClient`, `chUrl`, `streamLines`, the
// response consumers, `ClickHouseError`) remains `src/net/**`-only, exactly
// as before — value or type-only. There is no type-only carve-out: a
// type-only reference to a transport/protocol name (`import type`/`export
// type`, or an individual `import { type X }` specifier) is flagged on
// exactly the same terms as a value one, matching `docs/ARCHITECTURE.md` and
// `build/lib/check-legacy-owners.mjs`'s `findPackageImportUsages` — erasure
// before bundling does not exempt a source-level NAME ownership boundary.

export { chUrl } from './url.js';
export { createClickHouseHttpClient } from './client.js';
export { streamLines } from './progress-stream.js';
export { parseExceptionText, findExceptionFrame, ClickHouseError } from './exceptions.js';
export {
  ensureClickHouseSuccess,
  consumeJsonResponse,
  consumeTextResponse,
  consumeProgressResponse,
} from './response.js';
export { sqlString, quoteIdent, qualifyIdent } from './sql-quote.js';
export { scanSpans } from './sql-spans.js';
export {
  parseClickHouseType,
  unwrapNullable,
  unwrapLowCardinality,
  unwrapValueTransparentWrappers,
  analyzeTypeModifiers,
  typeBaseName,
  arrayElement,
  mapTypes,
  namedTupleMembers,
  enumMembers,
  enumValues,
  canonicalType,
} from './clickhouse-type.js';

export type { ChUrlOpts } from './url.js';
export type {
  ClickHouseHttpClientDeps,
  ClickHouseHttpRequest,
  ClickHouseJsonRequest,
  ClickHouseKillQueryRequest,
  ClickHouseHttpClient,
} from './client.js';
export type { ProgressMetaColumn, StreamLine, StreamCallbacks } from './progress-stream.js';
export type { ExceptionFrame } from './exceptions.js';
export type { Span, SpanKind } from './sql-spans.js';
export type {
  LiteralArg,
  TypeArg,
  TypeNode,
  EnumMember,
  TypeModifiers,
} from './clickhouse-type.js';
