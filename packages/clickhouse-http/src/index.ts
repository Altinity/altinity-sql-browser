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
