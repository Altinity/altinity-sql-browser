// Phase 0 / issue #585 — the candidate build entry point (plan §9 "Candidate
// entry"; measured by `build/build.mjs`'s `entryPoint` option and asserted
// by `tests/unit/client-web-spike-policy.test.js`).
//
// This file is NEVER used by normal `npm run build`, which always points
// `entryPoint` at its default, `src/main.ts` (see build/build.mjs's
// `esbuildOptions()`/`buildArtifact()`) — nothing in the normal production
// graph imports this file or anything it imports, and no normal build ever
// names it as an entry point. It exists solely so a MEASUREMENT-ONLY
// candidate build —
//
//   buildArtifact({ entryPoint: 'tests/spike/clickhouse-client/candidate-entry.ts', ... })
//
// — can prove, through esbuild's own metafile, that `@clickhouse/client-web`
// and the spike's official-side adapter CAN be bundled into one self-
// contained, CSP-compatible artifact, without that artifact ever reaching a
// real user or the normal production graph. It contains no endpoint and no
// credential, and it never constructs a client, calls fetch, or otherwise
// executes anything at module-load time beyond the non-executing
// registration below.
//
// It:
//   * imports the REAL production entry (`src/main.ts`) unmodified, so the
//     candidate artifact stays a strict superset of the normal one, never a
//     divergent replica (plan §9: "import the normal production entry");
//   * imports the official spike adapter — the ONLY module in this
//     repository that imports `@clickhouse/client-web` (see
//     official-adapter.ts's own header comment);
//   * "retains" the adapter's exports through a spike-only, NON-EXECUTING
//     global registration (plan §9: "retain the adapter through a spike-
//     only, non-executing global registration so it cannot be tree-
//     shaken"): assigning the imported function REFERENCES to a
//     `globalThis` slot is enough to make esbuild's tree-shaker treat them
//     as used — and therefore keep them, and the vendor package, in the
//     bundle — without ever CALLING any of them. No client is constructed,
//     no fetch runs, no network request is made anywhere in this file.
//
// This module executes ONLY when explicitly selected as the esbuild entry
// point for a measurement/CSP candidate build. It is not reachable from
// `src/main.ts`, and importing `src/main.ts` from here does not create an
// import cycle back into this file — the dependency direction is one-way
// (candidate entry -> production entry), never the reverse.
import '../../../src/main.js';
import {
  createOfficialConnection,
  officialAuthFor,
  runOfficial,
  runOfficialRefreshThenRetry,
  makeOfficialQueryExecutionAdapter,
} from './official-adapter.js';

declare global {
  // eslint-disable-next-line no-var
  var __ASB_SPIKE_CANDIDATE_CLIENT_WEB__: unknown;
}

// Non-executing: stores function REFERENCES only, never invokes any of
// them. This assignment is the "spike-only, non-executing global
// registration" plan §9 requires — its only purpose is to keep esbuild's
// tree-shaker from discarding the official-adapter import (and therefore
// `@clickhouse/client-web` itself) as dead code, so the candidate metafile
// can prove the package was actually bundled.
globalThis.__ASB_SPIKE_CANDIDATE_CLIENT_WEB__ = {
  createOfficialConnection,
  officialAuthFor,
  runOfficial,
  runOfficialRefreshThenRetry,
  makeOfficialQueryExecutionAdapter,
};
