# `@clickhouse/client-web` validation spike — issue #585 Phase 0

This directory is a **test-owned comparison harness** (plan §7 "Phase 0
architecture"), not the Phase 1 production transport contract. It compares
the current custom ClickHouse transport (`src/net/ch-client.ts` and friends)
against the official `@clickhouse/client-web@1.23.1` package, running both
through the exact same scenario/request shape and diffing the normalized
result. Nothing under `src/` imports anything in this directory, and nothing
here changes production behavior — see `docs/ADR-0005-clickhouse-web-client.md`
for the evidence-based decision this harness feeds: **Rejected** (three
independently-verified failing hard gates — see the ADR for the exact root
causes; the current custom transport remains authoritative and no production
cutover occurred).

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

The harness is complete: every file this README describes is present, the
full evidence set under `docs/evidence/585/` has been generated and
validated, `docs/ADR-0005-clickhouse-web-client.md` records the
evidence-based decision (**Rejected**), and `.wiki/Decisions-and-Roadmap.md`
reflects the same status.

* **Deterministic harness**: `types.ts`, `normalize.ts`, `expected-values.ts`,
  `scenarios.ts`, `precision-corpus.ts`, `format-type-probe.ts`,
  `current-adapter.ts`, `official-adapter.ts`, `progress-bridge.ts`,
  `guarded-fetch.ts`, `auth-fixtures.ts`, `parity.test.ts`, `fault-server.mjs`,
  `vitest.config.mjs`, `candidate-entry.ts`, `candidate-third-party-notices.md`.
* **Live-server harness**: `clickhouse-containers.mjs` (Docker orchestration),
  `matrix.json` (the resolved, digest-pinned server matrix), `live-parity.test.ts`,
  `live-precision.test.ts`, `live-sessions.test.ts`.
* **Evidence orchestration**: `run-matrix.mjs` (generates
  `docs/evidence/585/`), `validate-evidence.mjs` (validates it).
* **Browser harness**: `spike-server.mjs`, `playwright.config.js`,
  `browser-harness.html`, `browser-harness.ts`, `browser.spec.js`.

See "Layout" below for what each file does.

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
| `clickhouse-containers.mjs` | Dependency-free Docker orchestrator (plan §12/§13): pulls and boots one real ClickHouse server (OSS or Altinity Stable, resolved via `matrix.json`) for the live-server specs below, with every bind mount asserted under `$TMPDIR`/`$SPIKE_TMP` (never `/tmp`), unique run-labeled containers, and a `stop()`/orphan-sweep that removes only containers carrying this run's label. |
| `matrix.json` | The exact, digest-pinned ClickHouse server images the live matrix boots (proposed-oldest OSS/Altinity Stable, current-stable OSS, current Altinity Stable, plus a conditional Cloud row) — resolved by hand against the registry at implementation time, never an unqualified `latest` tag. |
| `live-parity.test.ts` | Live-server progressive timing, mid-stream exception, raw/export byte-hash, and `KILL QUERY`/`system.processes` cancellation proofs (plan §19/§20/§22/§24) against a **real** ClickHouse server (`ASB_SPIKE_CH_URL`, set by `clickhouse-containers.mjs`/`run-matrix.mjs`). Skips cleanly when the env var is unset. |
| `live-precision.test.ts` | Runs every `expected-values.ts` precision case (plan §17) through both adapters against a real server — no fixture can safely stand in for a real server's exact numeric/date/decimal serialization. Skips cleanly without `ASB_SPIKE_CH_URL`. |
| `live-sessions.test.ts` | Live-server logical-session, `SESSION_IS_LOCKED` retry, and connection-reset retry-safety proofs (plan §23) fed through the REAL, unmodified `QueryExecutionService`. Skips cleanly without `ASB_SPIKE_CH_URL`. |
| `run-matrix.mjs` | The evidence-generation orchestrator (plan §29/§34): runs the deterministic suite, the support-minimum derivation, the live server/browser matrix, the build/size-report measurements, and writes the complete `docs/evidence/585/` tree. `main()` runs unconditionally on import — only ever run as a script (`node run-matrix.mjs`), never imported. |
| `validate-evidence.mjs` | The evidence completeness/consistency validator (plan §29's exhaustive failure-rule list) — checked against the committed `docs/evidence/585/` by default. Exit 0 with no findings, exit 1 with an itemized list otherwise; never mutates anything, never prints a credential value. |
| `spike-server.mjs` | A dedicated Node HTTP server for the Playwright browser matrix (plan §14/§26): a streaming same-origin reverse proxy, the static browser-harness page, and a local esbuild-bundled ESM wrapper around the verified installed `@clickhouse/client-web` entry (no CDN). |
| `playwright.config.js` | A dedicated Playwright config scoped to `browser.spec.js` only (Chromium + WebKit — Firefox is explicitly excluded per plan §14, matching this sandbox's local e2e limitation) — the repository's root `playwright.config.js`/`npm run test:e2e` is untouched. |
| `browser-harness.html` / `browser-harness.ts` | The browser-facing static harness page and its module — the second (and only other) module in this repository that imports `@clickhouse/client-web`, this time from a real browser engine rather than Node, proving the same production decisions (exec()+bridge Table path, per-call `auth`, `query_id`, response headers) survive unmodified in Chromium/WebKit. |
| `browser.spec.js` | The actual Chromium/WebKit coverage (plan §25): client construction, ordinary query, progressive first row, request-local Basic auth, cancellation during streaming, response headers, query ID, raw bytes, and a network recorder proving no external runtime import, per required server/origin row. |

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

# Full evidence-generation run: the deterministic suite, the support-minimum
# derivation, the live Docker server matrix + live-*.test.ts, the Playwright
# browser matrix, and the build/size-report measurements — writes the
# complete docs/evidence/585/ tree. Every flag below narrows this for
# iteration/smoke-testing only; a narrowed invocation is never the "real"
# evidence run (see run-matrix.mjs's own header for the full flag list):
#   --rows <comma-list|all|none>      matrix.json rows to boot via Docker
#   --browsers <comma-list|all|none>  Playwright projects to run
#   --skip-baseline-gate              skip the baseline worktree's full local
#                                      gate (the baseline size-report
#                                      self-check still always runs)
npm run test:client-spike:matrix

# Chromium/WebKit browser harness (same-origin + cross-origin CORS).
npm run test:client-spike:browser -- --project=chromium
npm run test:client-spike:browser -- --project=webkit

# Evidence completeness/consistency validator (docs/evidence/585/).
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
  `.wiki/Decisions-and-Roadmap.md` never disagree: since the ADR exists, its
  `Status:` (**Rejected**) must appear, **unquoted**, near the wiki's
  ADR-0005/#585 mentions, and the wiki must link the ADR file. (Before the
  ADR existed, the test instead required the wiki to avoid an unquoted
  Accepted/Rejected claim near those same mentions — that branch of the
  policy test still exists and is exercised by its own fixture, but no longer
  describes this repository's current state.)

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
