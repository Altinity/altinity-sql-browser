# `@clickhouse/client-web` validation spike — issue #585 Phase 0

This directory is a **test-owned comparison harness** (plan §7 "Phase 0
architecture"), not the Phase 1 production transport contract. It compares
the current custom ClickHouse transport (`src/net/ch-client.ts` and friends)
against the official `@clickhouse/client-web@1.23.1` package, running both
through the exact same scenario/request shape and diffing the normalized
result. Nothing under `src/` imports anything in this directory, and nothing
here changes production behavior — see `docs/ADR-0005-clickhouse-web-client.md`
(once it exists — see "Current status" below) for the evidence-based
Accepted/Rejected decision this harness feeds.

`@clickhouse/client-web` is pinned as an exact, dev-only dependency
(`package.json`'s `devDependencies`, no range) for the lifetime of Phase 0.
It is never imported by the normal production graph (`src/main.ts` and
everything it imports) — the only file in this repository that imports it is
`official-adapter.ts`, plus the compile-time probe `format-type-probe.ts` and
the deterministic test suite `parity.test.ts`.
`tests/unit/client-web-spike-policy.test.js` (part of the normal, coverage-
gated `npm test` run) enforces all of this mechanically — see "Policy
enforcement" below.

## Current status

Not every file this README describes exists yet — this harness is being
built incrementally, sub-task by sub-task, on
`wip/585-phase0-clickhouse-web-client-spike`. As of this writing:

* **Present**: `types.ts`, `normalize.ts`, `expected-values.ts`,
  `scenarios.ts`, `precision-corpus.ts`, `format-type-probe.ts`,
  `current-adapter.ts`, `official-adapter.ts`, `progress-bridge.ts`,
  `guarded-fetch.ts`, `auth-fixtures.ts`, `parity.test.ts`,
  `fault-server.mjs`, `vitest.config.mjs`, `candidate-entry.ts`,
  `candidate-third-party-notices.md`, this `README.md`.
* **Not yet present** (deferred to later Phase 0 sub-tasks per the plan's
  execution order, §34.F/G/H): `spike-server.mjs`, `clickhouse-containers.mjs`,
  `run-matrix.mjs`, `validate-evidence.mjs`, `playwright.config.js`,
  `browser-harness.html`, `browser-harness.ts`, `browser.spec.js`,
  `matrix.json`, and everything under `docs/evidence/585/`. The package
  scripts below that shell out to these files (`test:client-spike:matrix`,
  `test:client-spike:browser`, `check:client-spike:evidence`) will fail with
  a plain "file not found" until those sub-tasks land — that is expected,
  not a regression.
* `docs/ADR-0005-clickhouse-web-client.md` does not exist yet. Until it
  does, `.wiki/Decisions-and-Roadmap.md` correctly still frames #585/ADR-0005
  as a pending spike, not a settled decision — see "ADR/wiki consistency"
  below.

## Layout

| File | Role |
| --- | --- |
| `types.ts` | The test-owned comparison interface (plan §7): `SpikeRequest`/`SpikeOutcome`/`ExpectedOutcome`/`ParityResult`. Nothing under `src/` may import it. |
| `normalize.ts` | Pure comparison/normalization helpers (`emptyOutcome`, `IncrementalSha256`, diffing). No fetch, no DOM. |
| `expected-values.ts` | Independently-authored precision literals (plan §17) — never derived from either adapter's output, so a match can't just mean "both share the same bug." |
| `scenarios.ts` | The deterministic subset of the plan §18 parity scenario matrix, each entry naming its `fault-server.mjs` fixture and the invariant-map row(s) it proves. Live-server-only rows (sessions, `SESSION_IS_LOCKED` against a real server, `KILL QUERY`, the full precision corpus) are `run-matrix.mjs`'s job, not this file's. |
| `precision-corpus.ts` | Runs every `expected-values.ts` case through both adapters against a **real** ClickHouse server (`ASB_SPIKE_CH_URL`). No fixture can safely stand in for a real server's exact numeric/date/decimal serialization. |
| `format-type-probe.ts` | The compile-time proof for plan §16: an uncast `JSONStringsEachRowWithProgress` call is rejected by installed 1.23.1's public types (`@ts-expect-error`), with a positive `JSONEachRowWithProgress` control. Type-checked automatically by `npm run check:types` via the `tsconfig.json` include below. |
| `current-adapter.ts` | Wraps the **real** production `runQuery`/`exportQuery`/`killQuery`/`createQueryExecutionService` — never a reimplemented replica (plan §7 "Current-side adapter"). |
| `official-adapter.ts` | The **only** module that imports `@clickhouse/client-web`. Constructs one client per connection config, injects fetch, supplies per-request auth via the vendor client's own `auth` field, and exposes only the test-owned `SpikeOutcome` — the vendor's own result/error types never escape this file. |
| `progress-bridge.ts` | The narrow `exec()`-based NDJSON progress bridge plan §16 allows (only because `query()` doesn't publicly support `JSONStringsEachRowWithProgress`) — incremental decode only, no normalization, no second general client. |
| `guarded-fetch.ts` | Plan §21's immediate pre-fetch epoch-fencing experiment: an injected-fetch checkpoint that rejects a stale-epoch request immediately before the real delegate fetch fires. |
| `auth-fixtures.ts` | Non-secret credential fixtures (Basic/Bearer/JWT-as-Basic/invalid) shared by the deterministic suite, the (future) local-Docker matrix, and the (future) browser harness. Inert by construction — safe to commit. |
| `fault-server.mjs` | A dependency-free Node `http` server exposing named, fully deterministic fixture routes (delayed headers, scheduled chunks, malformed/truncated lines, mid-stream resets, 401/403 sequences, tagged/legacy late exceptions, invalid UTF-8, request inspection). Never asserts — `scenarios.ts` and `parity.test.ts` do that. |
| `parity.test.ts` | The deterministic parity/precision/auth/epoch/retry suite, run under the dedicated Vitest config below. Every test proves at least one plan §11 invariant-map row. |
| `candidate-entry.ts` | The candidate build's esbuild entry point — imports the real production entry plus the official adapter, retains the latter through a non-executing global registration so esbuild's tree-shaker can't drop it. Never used by normal `npm run build`. |
| `candidate-third-party-notices.md` | The Apache-2.0 notice fragment appended **only** to the candidate artifact's embedded third-party notices (`build/build.mjs`'s `additionalNotices` option) — never to the normal `THIRD-PARTY-NOTICES.md` or the normal artifact. |
| `vitest.config.mjs` | The dedicated Vitest config the spike scripts use (`environment: 'node'`, `singleThread: true`, no coverage) — deliberately separate from `tests/vitest.config.ts` so `npm test` never discovers this suite. |

## Type checking

`tsconfig.json`'s root `include` already lists
`tests/spike/clickhouse-client/**/*.ts`, so every `.ts` file in this
directory — including `candidate-entry.ts` and `format-type-probe.ts` — is
checked automatically by:

```sh
npm run check:types
```

No separate command is needed. A future upstream type-surface change (e.g.
`JSONStringsEachRowWithProgress` becoming publicly supported) will make this
fail until `format-type-probe.ts` and the ADR evidence are reconciled — that
is intentional (plan §8).

## Running the harness

```sh
# Deterministic fault-server-backed parity/auth/epoch/retry suite (no live
# ClickHouse, no Docker, no browser required). Uses its OWN Vitest config —
# npm test does not discover these tests.
npm run test:client-spike

# Live-server support-minimum/precision/session/cancellation matrix.
# NOT YET IMPLEMENTED (see "Current status" above) — run-matrix.mjs doesn't
# exist yet.
npm run test:client-spike:matrix

# Chromium/WebKit browser harness (same-origin + cross-origin CORS).
# NOT YET IMPLEMENTED — playwright.config.js/browser-harness.* don't exist yet.
npm run test:client-spike:browser -- --project=chromium
npm run test:client-spike:browser -- --project=webkit

# Evidence completeness/consistency validator (docs/evidence/585/).
# NOT YET IMPLEMENTED — validate-evidence.mjs doesn't exist yet.
npm run check:client-spike:evidence
```

`test:client-spike` sets `TZ=America/New_York` (matching `npm test`'s own
convention) and points explicitly at this directory's `vitest.config.mjs` —
a bare `npx vitest run` from the repo root would not reliably inherit either
config's `environment`/`include`, so every spike script names its config
explicitly rather than relying on Vitest's default discovery.

## Measuring the candidate artifact

The candidate build is a **measurement-only** artifact: it bundles the real
production entry (`src/main.ts`) plus `candidate-entry.ts`'s non-executing
registration of the official adapter, proving `@clickhouse/client-web` CAN be
included in one self-contained HTML file without becoming a permanent
runtime dependency. It is produced by calling the shared build helpers
(`build/build.mjs`) with a non-default `entryPoint` and `additionalNotices` —
there is no dedicated npm script for this because it is evidence-generation
infrastructure (`docs/evidence/585/candidate/`), not a repeatable developer
command:

```js
import { buildArtifact } from '../../../build/build.mjs';

const { html, metafile } = await buildArtifact({
  entryPoint: 'tests/spike/clickhouse-client/candidate-entry.ts',
  metafile: true,
  additionalNotices: await readFile(
    'tests/spike/clickhouse-client/candidate-third-party-notices.md', 'utf8',
  ),
});
```

`tests/unit/client-web-spike-policy.test.js` runs exactly this shape (with
its output written under `$TMPDIR`, never into the repository's own `dist/`)
and asserts the resulting metafile includes
`node_modules/@clickhouse/client-web/...`, while a normal
`buildArtifact({ metafile: true })` call (the same one `npm run build`/
`npm run size-report` use) excludes it entirely.

## Policy enforcement

`tests/unit/client-web-spike-policy.test.js` — part of the normal,
coverage-gated `npm test` run — mechanically enforces:

* `@clickhouse/client-web` is pinned to the exact version `1.23.1` and lives
  only in `devDependencies`, never `dependencies`;
* a normal production build's metafile never contains the package;
* a candidate build's metafile does contain it;
* no file under this directory imports a CDN/remote URL (an import
  specifier, a dynamic `import()`, or an HTML `<script src>` pointing at
  `http(s)://` or a protocol-relative URL) — loopback URL strings
  `fault-server.mjs` constructs for its own local server (e.g.
  `http://127.0.0.1:<port>`) are not import specifiers and are not flagged;
* `docs/ADR-0005-clickhouse-web-client.md` and
  `.wiki/Decisions-and-Roadmap.md` never disagree: if the ADR exists, its
  `Status:` (Accepted/Rejected) must appear, **unquoted**, near the wiki's
  ADR-0005/#585 mentions, and the wiki must link the ADR file; if the ADR
  does not exist yet, the wiki must not make an unquoted Accepted/Rejected
  claim near those same mentions (today's wording — `a "Rejected" outcome
  still completes the phase` — is deliberately quoted/hypothetical, so it
  passes without claiming a settled decision).

## Non-goals

This harness does not, and must not:

* route production requests through `@clickhouse/client-web`;
* introduce the Phase 1 production transport contract;
* alter `src/net/ch-client.ts` or any other production module;
* claim production-path or E2E acceptance.

See `docs/ADR-0005-clickhouse-web-client.md` (once reconciled) for the full
decision record, and the Phase 0 implementation plan for the complete
architecture, invariant map, and sabotage checks this directory exists to
satisfy.
