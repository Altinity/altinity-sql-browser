# @altinity/clickhouse-http

Fetch-native ClickHouse HTTP primitives for browsers.

## Purpose

This package is the ONE implementation of the low-level, product-agnostic
mechanics an Altinity SQL Browser-style client needs to talk to ClickHouse's
HTTP interface from a browser: URL/query-string serialization, the raw
`fetch()`-based request, the progress-stream (`JSONStringsEachRowWithProgress`)
read loop, HTTP exception-text and late-exception-frame parsing, response
success/error classification and JSON/text/progress consumers, ClickHouse SQL
string-literal/identifier quoting, and a generic ClickHouse type-expression
grammar (parser, canonicalizer, and enum/wrapper helpers) with the shared
lexical scanner that grammar depends on.

It was extracted from [Altinity SQL Browser](https://github.com/Altinity/altinity-sql-browser)
(issue #630) as a standalone, independently buildable/publishable unit
(issue #630 Phase 8). It currently lives inside that repository as an npm
workspace package; issue #639 covers moving it to its own repository and
publishing it, without changing its source, public API, or build/test
architecture.

## Ownership and non-goals

This package owns transport/protocol MECHANICS only. It deliberately does
**not** own:

- OAuth or any other credential lifecycle (acquisition, refresh, storage);
- automatic retry — every request this package makes is exactly one `fetch()`
  call, with no internal retry loop;
- a product's query registry, result-shape policy, or row-count/format
  decisions;
- an ORM or query-builder API — this package quotes/serializes; it never
  constructs SQL for you;
- any UI, rendering, or framework integration.

Those responsibilities belong to the application consuming this package (in
Altinity SQL Browser's case, `src/net/**` and `src/application/**`).

## Browser/Fetch assumptions

Every function here is written against the standard `fetch()`/`Response`/
`ReadableStream` Web APIs, injected rather than imported (no ambient global
reference to `fetch`, `window`, or `document`). This means the package runs
equally well in a real browser or in any Fetch-API-compatible runtime (e.g.
Node's own built-in `fetch`) — it makes no environment assumption beyond that
API surface.

## Zero runtime dependencies

This package declares no `dependencies` and ships none. Every dev dependency
(`esbuild`, `typescript`, `vitest`, `@playwright/test`, `@vitest/coverage-v8`)
is build/test tooling only — none of it is bundled into `dist/**`.

## Public contract: ESM, one export

The package exposes exactly one public entry point, `"."`, resolving to
`dist/index.js` (runtime) and `dist/index.d.ts` (types). There is no other
public subpath — importing `@altinity/clickhouse-http/client` or any other
internal module path is unsupported and, in the consuming SQL Browser
repository, mechanically forbidden (`build/check-boundaries.mjs`).

## Public API groups

- **Transport/protocol** — `createClickHouseHttpClient`, `chUrl`,
  `streamLines`, `parseExceptionText`, `findExceptionFrame`,
  `ClickHouseError`, `ensureClickHouseSuccess`, `consumeJsonResponse`,
  `consumeTextResponse`, `consumeProgressResponse`, plus their request/result
  types (`ClickHouseHttpClientDeps`, `ClickHouseHttpRequest`,
  `ClickHouseJsonRequest`, `ClickHouseKillQueryRequest`,
  `ClickHouseHttpClient`, `ChUrlOpts`, `StreamLine`, `StreamCallbacks`,
  `ProgressMetaColumn`, `ExceptionFrame`).
- **ClickHouse SQL language** — `sqlString`, `quoteIdent`, `qualifyIdent`,
  `scanSpans` (`Span`/`SpanKind`), `parseClickHouseType` and its
  wrapper/enum/canonicalization helpers (`unwrapNullable`,
  `unwrapLowCardinality`, `unwrapValueTransparentWrappers`,
  `analyzeTypeModifiers`, `typeBaseName`, `arrayElement`, `mapTypes`,
  `namedTupleMembers`, `enumMembers`, `enumValues`, `canonicalType`, and their
  types `LiteralArg`/`TypeArg`/`TypeNode`/`EnumMember`/`TypeModifiers`).

## `dist/**` shape

`npm run build` produces unbundled, browser-first ESM: one `.js` file per
source module under `dist/`, mirroring `src/**` exactly (`bundle: false`), plus
a matching `.d.ts` declaration file per module. Nothing under `dist/**` is
minified or tree-shaken — a consumer's own bundler (in Altinity SQL Browser's
case, the root `esbuild` build) does that.

## Package-local commands

Run these from this directory, or with `--workspace @altinity/clickhouse-http`
from the SQL Browser repository root:

```sh
npm run build         # esbuild -> dist/**/*.js, then tsc -> dist/**/*.d.ts
npm run check:types    # strict package-local typecheck (no emit)
npm test              # package-local unit tests + coverage (100/95/90/100 per file)
npm run test:pack      # build, npm pack, install the tarball outside this repo, prove
                       # it resolves/typechecks with no source fallback
npm run test:browser   # Chromium + WebKit regression suite against the built dist/**
```

## Publication state

This package is currently `"private": true` at version `"0.0.0"`. It has
never been published to any npm registry. `npm run test:pack` proves the
package is publication-SHAPED (packs into a tarball containing only
`dist/**`, `README.md`, `LICENSE`, and `package.json`, installs cleanly
outside this repository, and resolves/typechecks with no fallback into this
repository's source) — it does not publish anything, and choosing the first
externally released version is deliberately out of this scope (issue #639).

## Import examples

These examples describe the package's shape; they do not imply it is
available from any public registry yet.

```js
import { createClickHouseHttpClient, chUrl } from '@altinity/clickhouse-http';

const client = createClickHouseHttpClient({
  fetch: () => fetch,
  origin: () => 'https://your-clickhouse-host',
});

const response = await client.request({
  sql: 'SELECT 1',
  defaultFormat: 'JSON',
  authorization: 'Bearer <token>',
});
```

```ts
import { parseClickHouseType, sqlString } from '@altinity/clickhouse-http';

const type = parseClickHouseType('Nullable(LowCardinality(String))');
const literal = sqlString("O'Brien"); // "'O''Brien'"
```
