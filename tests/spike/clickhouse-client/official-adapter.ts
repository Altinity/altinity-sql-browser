// Phase 0 / issue #585 — the "official-side spike adapter" (plan §7): the
// ONLY module in this repository that imports `@clickhouse/client-web`.
// Constructs one client per connection configuration (never per request or
// refresh — plan's "One official client per connection config" invariant),
// injects fetch, supplies complete per-request authentication via the
// vendor client's own per-call `auth` field (never a client-level default),
// and exposes only the test-owned normalized `SpikeOutcome` — the official
// result/error types (`ClickHouseError`, `ExecResult`, …) never escape this
// file.
//
// EMPIRICAL FINDING (recorded in docs/evidence/585/critical-questions.md):
// per-request `http_headers.Authorization` does NOT override the credential
// in installed 1.23.1. `WebConnection#defaultHeadersWithOverride` spreads
// `http_headers` first, then unconditionally sets `Authorization:
// authHeader` LAST — where `authHeader` is derived from `params.auth` (or
// the client-level default when `params.auth` is absent), clobbering
// whatever `Authorization` a caller supplied via `http_headers`. The correct
// per-request override is the `auth` field
// (`{username,password}`/`{access_token}`), which THIS file uses
// (`officialAuthFor`, below) — `http_headers` remains available for
// genuinely EXTRA headers, never for Authorization.
//
// Format decision (plan §16, proven in `format-type-probe.ts`):
//   * KPI            -> `query({ format: 'JSONEachRowWithProgress' })` — the
//                        one progress format installed 1.23.1 publicly
//                        supports; consumed via `.stream()`.
//   * Table          -> `exec()` with the full literal SQL + explicit
//                        `FORMAT JSONStringsEachRowWithProgress`, decoded by
//                        the narrow `progress-bridge.ts` (exec() exposes raw,
//                        undecoded response bytes, so this needs no text
//                        decoding beyond the bridge's own incremental UTF-8
//                        JSON line parse).
//   * raw/explicit   -> `exec()` with the full literal SQL + its FORMAT
//                        clause, byte-hashed straight off `.stream`, exactly
//                        mirroring `exportQuery`'s raw path.

import { createClient, ClickHouseError, type ClickHouseClient } from '@clickhouse/client-web';
import { isProgressRow, isRow } from '@clickhouse/client-web';
import type { AdapterRunResult, SpikeCredential, SpikeRequest, SpikeOutcome } from './types.js';
import { emptyOutcome, IncrementalSha256 } from './normalize.js';
import { bridgeNdjsonProgress } from './progress-bridge.js';
import { withTrailingFormat } from '../../../src/core/format.js';

export interface OfficialConnection {
  client: ClickHouseClient;
  constructorCalls: number;
  fetchCalls: number;
}

/** Construct ONE official client for `baseUrl`, with `realFetch` injected and
 * fetch-call counting wired in. The client-level `auth` is left at a
 * non-secret, deliberately-invalid default (plan §21 "Per-request auth":
 * "Construct one official client with a non-secret invalid default
 * credential") — every real request supplies its own per-call `auth`
 * override (see `officialAuthFor`), so the default is never authoritative.
 * `requestTimeoutMs`
 * (optional) sets the vendor client's own `request_timeout` (default 30s) —
 * used by the "timeout" scenario to prove the official client's connection-
 * level timeout produces a distinct `Error("Timeout error.")`, never an
 * `AbortError`, unlike a caller-driven `abort_signal`.
 *
 * `constructorCalls` is a REAL count, not a literal: `.client` is exposed as
 * a getter/setter pair backed by `constructorCallCount`, and the ONLY writer
 * to that setter is the single `setClient()` call below, at construction.
 * Nothing else in this file (or in `runOfficial`/`runOfficialRefreshThenRetry`
 * /`makeOfficialRunQueryShim`) ever assigns `conn.client` again — they only
 * read it — so this mechanically enforces the plan's "one official client per
 * connection config, no reconstruction after refresh" invariant: if a FUTURE
 * change (e.g. a refresh-retry path) were to reassign `conn.client` to a
 * freshly `createClient()`-ed instance instead of reusing this one, the
 * setter would increment the count past 1 and every `constructorCalls === 1`
 * assertion (parity.test.ts / live-*.test.ts) would correctly fail. */
export function createOfficialConnection(baseUrl: string, realFetch: typeof fetch, requestTimeoutMs?: number): OfficialConnection {
  let fetchCalls = 0;
  const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls += 1;
    return realFetch(input, init);
  }) as typeof fetch;
  let constructorCallCount = 0;
  let currentClient!: ClickHouseClient;
  function setClient(c: ClickHouseClient): void {
    constructorCallCount += 1;
    currentClient = c;
  }
  setClient(createClient({
    url: baseUrl,
    username: 'asb-spike-default-invalid',
    password: 'asb-spike-default-invalid',
    fetch: countingFetch,
    ...(requestTimeoutMs !== undefined ? { request_timeout: requestTimeoutMs } : {}),
  }));
  return {
    get client() { return currentClient; },
    set client(c: ClickHouseClient) { setClient(c); },
    get constructorCalls() { return constructorCallCount; },
    get fetchCalls() { return fetchCalls; },
  };
}

/** The vendor client's own per-call credential-override shape (`BaseQueryParams.auth`)
 * for one `SpikeCredential` — see this file's header comment for why this,
 * and not `http_headers`, is the correct per-request override in installed
 * 1.23.1. `'jwt-as-basic'` maps to `{username,password}` with the JWT AS the
 * password (Basic scheme) — matching the app's own JWT-as-Basic-password
 * pattern (`ch-client.ts`'s `authHeader` seam), never `access_token` (which
 * is Bearer-scheme only). `'invalid'` maps to a non-secret, deliberately
 * wrong credential distinct from the connection's own default, so a test can
 * tell "the override was honored" apart from "the default leaked through". */
export function officialAuthFor(credential: SpikeCredential): { username: string; password: string } | { access_token: string } {
  switch (credential.kind) {
    case 'basic':
      return { username: credential.username, password: credential.password };
    case 'bearer':
      return { access_token: credential.token };
    case 'jwt-as-basic':
      return { username: credential.username, password: credential.jwt };
    case 'invalid':
    default:
      return { username: 'asb-spike-per-request-invalid', password: 'asb-spike-per-request-invalid' };
  }
}

function classifyError(e: unknown, outcome: SpikeOutcome, signal?: AbortSignal): void {
  if (e instanceof Error && e.name === 'AbortError') { outcome.cancelled = true; return; }
  if (signal?.aborted) { outcome.cancelled = true; return; }
  if (e instanceof ClickHouseError) {
    outcome.chCode = Number(e.code) || null;
    outcome.chMessage = e.message;
    outcome.error = e.message;
    return;
  }
  outcome.error = e instanceof Error ? e.message : String(e);
}

/** Run one `SpikeRequest` through the official client, folding the result
 * into the normalized `SpikeOutcome` vocabulary. `conn` is shared across many
 * calls (the "one client per connection config" invariant) — this function
 * itself performs zero client construction. */
export async function runOfficial(conn: OfficialConnection, request: SpikeRequest): Promise<AdapterRunResult> {
  const outcome: SpikeOutcome = emptyOutcome();
  // Pre-flight abort guard (plan §22 "pre-aborted before request: no fetch
  // side effect") — EMPIRICALLY VERIFIED (see docs/evidence/585/
  // critical-questions.md): installed 1.23.1's exec()/query()/command() do
  // NOT check `abort_signal.aborted` up front; `web_connection.js`'s
  // `request()` only reacts to a FUTURE 'abort' EVENT via
  // `params.abort_signal.onabort = ...`, so an ALREADY-aborted signal is
  // silently ignored and the request reaches the network unchanged (proven:
  // a pre-aborted `exec()` against a real server resolves normally and the
  // server records the hit). This adapter-side guard is the narrow fix a
  // real Phase 1 adapter would also need — the same shape as the epoch
  // fence's own adapter-side checkpoint #1 in `guarded-fetch.ts`.
  if (request.signal?.aborted) {
    outcome.cancelled = true;
    return { outcome, constructorCalls: conn.constructorCalls, fetchCalls: 0 };
  }
  const t0 = Date.now();
  const auth = officialAuthFor(request.credential);
  const fetchCallsBefore = conn.fetchCalls;

  try {
    if (request.consume === 'raw' || request.format !== 'Table' && request.format !== 'KPI') {
      // Raw/explicit-format path: exec() with the fully-authored SQL
      // (including its own FORMAT clause), byte-hashed straight off .stream —
      // never .text()/TextDecoder/JSON-parsed (plan §24's raw-decoding ban).
      // Existing-FORMAT-clause detection reuses the SAME comment/string-aware
      // scanner production's own export path uses (`prepareExportSql` calls
      // this identical function — src/application/export-service.ts), rather
      // than reimplementing a terminal regex here (plan §7 "do not
      // reimplement current behavior"): a prior ad hoc
      // `/\bFORMAT\s+\S+\s*;?\s*$/i` terminal regex missed an existing
      // trailing FORMAT clause followed by a line/block comment (the regex
      // requires the clause to be the literal string end), silently
      // double-appending a second FORMAT clause on any such SQL — found by
      // review during issue #585 Phase 0 (see docs/evidence/585 review
      // notes). `withTrailingFormat` also correctly does NOT treat FORMAT-
      // shaped text inside a string literal or comment as an existing
      // clause, so the real format is still appended in that case.
      const fullSql = withTrailingFormat(request.sql, request.format).sql;
      const res = await conn.client.exec({
        query: fullSql,
        query_id: request.queryId,
        session_id: request.sessionId,
        role: request.role,
        abort_signal: request.signal,
        auth,
        clickhouse_settings: request.settings,
        // NOTE (plan §18 "forced multipart"/"automatic multipart"): installed
        // 1.23.1's `exec()`/`command()` never honor `use_multipart_params(_auto)`
        // at all — only `query()` does (verified against
        // `dist/connection/web_connection.js`'s `runExec` vs. `query`). These
        // two fields are still threaded through here for parameter-shape
        // parity with `query()` below, but they are a documented no-op on
        // this branch — the multipart scenarios in `parity.test.ts` exercise
        // `query()` directly for exactly this reason.
        use_multipart_params: request.multipart,
        use_multipart_params_auto: request.multipartAuto,
        query_params: request.params,
      });
      outcome.queryId = res.query_id;
      outcome.responseHeaders = flattenHeaders(res.response_headers);
      outcome.httpStatus = res.http_status_code ?? null;
      outcome.summary = res.summary ?? null;
      const hash = new IncrementalSha256();
      const reader = res.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
      }
      outcome.rawByteCount = hash.totalBytes;
      outcome.rawSha256 = await hash.digestHex();
      outcome.completedAtMs = Date.now() - t0;
    } else if (request.format === 'KPI') {
      // Publicly-supported progress path.
      const rs = await conn.client.query({
        query: request.sql,
        format: 'JSONEachRowWithProgress',
        query_id: request.queryId,
        session_id: request.sessionId,
        role: request.role,
        abort_signal: request.signal,
        auth,
        clickhouse_settings: request.settings,
        // Only `query()` (this branch) honors multipart promotion in
        // installed 1.23.1 — see the `exec()` branch's note above.
        use_multipart_params: request.multipart,
        use_multipart_params_auto: request.multipartAuto,
        query_params: request.params,
      });
      outcome.queryId = rs.query_id;
      outcome.responseHeaders = flattenHeaders(rs.response_headers);
      let firstRow = false;
      const stream = rs.stream<Record<string, unknown>>();
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const wrapped of value) {
          const row = wrapped.json();
          if (isProgressRow(row)) {
            outcome.progress = {
              rows: Number(row.progress.read_rows) || 0,
              bytes: Number(row.progress.read_bytes) || 0,
              totalRows: Number(row.progress.total_rows_to_read) || undefined,
            };
          } else if (isRow(row)) {
            if (!firstRow) { firstRow = true; outcome.firstRowAtMs = Date.now() - t0; }
            outcome.rows.push(Object.values(row.row as Record<string, unknown>));
            outcome.partialRowCount += 1;
          } else if (row && typeof row === 'object' && 'exception' in (row as object)) {
            outcome.error = String((row as { exception: unknown }).exception);
            outcome.chMessage = outcome.error;
          }
        }
      }
      outcome.completedAtMs = Date.now() - t0;
    } else {
      // Table -> narrow exec()-based bridge (plan §16's chosen path).
      const fullSql = `${request.sql}\nFORMAT JSONStringsEachRowWithProgress`;
      const res = await conn.client.exec({
        query: fullSql,
        query_id: request.queryId,
        session_id: request.sessionId,
        role: request.role,
        abort_signal: request.signal,
        auth,
        clickhouse_settings: request.settings,
        // Documented no-op on exec() in installed 1.23.1 — see the raw
        // branch's note above.
        use_multipart_params: request.multipart,
        use_multipart_params_auto: request.multipartAuto,
        query_params: request.params,
      });
      outcome.queryId = res.query_id;
      outcome.responseHeaders = flattenHeaders(res.response_headers);
      outcome.httpStatus = res.http_status_code ?? null;
      outcome.summary = res.summary ?? null;
      let firstRow = false;
      await bridgeNdjsonProgress(res.stream, (line) => {
        if (line.meta) {
          outcome.columns = line.meta.map((m) => ({ name: m.name, type: m.type }));
        } else if (line.row) {
          if (!firstRow) { firstRow = true; outcome.firstRowAtMs = Date.now() - t0; }
          outcome.rows.push(outcome.columns.map((c) => (line.row as Record<string, unknown>)[c.name]));
          outcome.partialRowCount += 1;
        } else if (line.progress) {
          outcome.progress = {
            rows: Number(line.progress.read_rows) || 0,
            bytes: Number(line.progress.read_bytes) || 0,
            totalRows: Number(line.progress.total_rows_to_read) || undefined,
          };
        } else if (line.exception) {
          outcome.error = line.exception;
          outcome.chMessage = line.exception;
        }
      });
      outcome.completedAtMs = Date.now() - t0;
    }
  } catch (e) {
    classifyError(e, outcome, request.signal);
  }
  return {
    outcome,
    constructorCalls: conn.constructorCalls,
    fetchCalls: conn.fetchCalls - fetchCallsBefore,
  };
}

// ── Spike-only official-side refresh driver ─────────────────────────────────
// Plan §21 "refresh then retry" / "stale during refresh": the vendor client
// has NO refresh policy of its own (per-request `auth` is the whole
// auth surface — see `runOfficial` above), so a comparable "one refresh, one
// replay" policy has to be driven by the CALLER, exactly like production's
// own auth request path drives it around the injected `fetch` seam — at the
// time this spike was written, `ch-client.ts`'s `authedFetch`; since #630
// Phase 6, `authenticated-clickhouse-request.ts`'s `authenticatedRequest`,
// unchanged in shape. This is SPIKE-ONLY experiment code (plan §21's "If
// [it] becomes a second general request implementation, fail auth/epoch
// parity" — this narrow, single-retry driver is not that: it is the Phase 1
// candidate shape for this one policy, not a second transport). Never
// adopted as-is; a future Phase 1 adapter would fold an equivalent policy
// into its own request path.

export interface RefreshDrivenResult {
  outcome: SpikeOutcome;
  /** How many times the official client's method was actually invoked. */
  attempts: number;
  /** How many times `refresh()` was called. */
  refreshCalls: number;
}

/** Run `request` once; on a classified authentication failure (the fault
 * server's `AUTHENTICATION_FAILED`/code 516, matching `401-then-success`'s
 * fixture body), call `refresh()` exactly once and — if it yields a
 * replacement credential — replay the SAME request with that credential,
 * exactly once, mirroring production's own `attempt === 0` bound (at the
 * time this spike was written, `authedFetch`'s; since #630 Phase 6,
 * `authenticated-clickhouse-request.ts`'s `authenticatedRequest`,
 * unchanged in shape). If `isCurrentEpoch()` returns false immediately
 * after `refresh()` resolves (the "stale during refresh" race), the
 * replacement credential is NEVER read or replayed — this proves the same
 * "no replacement credential or lifecycle mutation" invariant production's
 * own `staleEpochAbort` guards, on the official adapter's own retry path. */
export async function runOfficialRefreshThenRetry(
  conn: OfficialConnection,
  request: SpikeRequest,
  refresh: () => Promise<SpikeCredential | null>,
  isCurrentEpoch: () => boolean,
): Promise<RefreshDrivenResult> {
  let attempts = 0;
  let refreshCalls = 0;
  let credential = request.credential;
  for (;;) {
    attempts += 1;
    const attemptResult = await runOfficial(conn, { ...request, credential });
    const authFailure = attemptResult.outcome.chCode === 516;
    if (!authFailure || attempts > 1) {
      return { outcome: attemptResult.outcome, attempts, refreshCalls };
    }
    refreshCalls += 1;
    const next = await refresh();
    if (!isCurrentEpoch()) {
      const stale = emptyOutcome();
      stale.cancelled = true;
      return { outcome: stale, attempts, refreshCalls };
    }
    if (!next) return { outcome: attemptResult.outcome, attempts, refreshCalls };
    credential = next;
  }
}

// ── QueryExecutionService adapter (post-#630 Phase 7) ───────────────────────
// Plan §19/§2.4 (Checkpoint 2C's spike portion) — replaces the retired
// `makeOfficialRunQueryShim`, which satisfied `typeof runQuery` from
// `src/net/ch-client.ts` (`RunQueryOptions`/`RunQueryResult` — both retiring,
// #630 Phase 7). This adapter instead satisfies `QueryExecutionService`'s OWN
// narrow `QueryExecutionDeps['runProgress' | 'runText']` shape
// (`src/application/query-execution-service.ts`) directly — never a
// reimplementation of that service's retry/classification policy, which
// still runs, real and unmodified, against whichever client (current or
// official) is injected (plan §23 "official outcomes feed existing execution
// policy").
//
// `runProgress` mirrors the retired shim's 'Table'/'KPI' branches
// (exec()+bridgeNdjsonProgress / query()+stream reading respectively),
// dispatching on `request.defaultFormat` (QES's own wire-format names)
// instead of a SQL-Browser format string. An in-band `{"exception"}` line is
// delivered through `callbacks.onLine`, exactly like the real authenticated
// progress path (`core/stream.ts`'s `applyStreamLine` turns it into
// `result.error`) — never a thrown/returned `{error}` shape: only a
// pre-header rejection (a `ClickHouseError` thrown by `exec()`/`query()`
// itself) or a mid-stream network failure throws, matching the new "package
// consumers throw" contract `QueryExecutionDeps.runProgress`'s own doc
// requires (#630 Phase 7 §6.5).
//
// `runText` mirrors the retired shim's ELSE/raw branch exactly: EVERY
// `executeScript` statement this spike suite ever drives through it (row-
// returning or effect alike) used that branch — `serviceFor()`'s
// `QueryExecutionRequest.defaultFormat` is always 'JSONCompact' or
// 'TabSeparatedWithNamesAndTypes', neither of which is 'Table'/'KPI' — so
// `runText` keeps using `command()` verbatim on `request.sql` UNCHANGED (no
// FORMAT clause appended: installed 1.23.1 hard SYNTAX_ERRORs on `SET .../
// INSERT ... VALUES (...)` with one appended — see `live-sessions.test.ts`'s
// own `runOfficialCommand` docstring for the same finding), per plan §7 "use
// command() only when discarding output is intentional", always resolving
// `''`. No spike test routed through `runText` has ever needed the real row/
// effect body text back (only attempt-count/status/message classification) —
// this is a mechanical reshape of the retired shim's existing behavior, not a
// redesign of the vendor side (plan §19 "do not redesign the vendor side
// beyond compilation and existing test intent").
import type { QueryExecutionRequest, QueryProgressCallbacks } from '../../../src/application/query-execution-service.js';

export interface OfficialQueryExecutionAdapter {
  runProgress(request: QueryExecutionRequest, callbacks: QueryProgressCallbacks): Promise<void>;
  runText(request: QueryExecutionRequest): Promise<string>;
}

/** Build a `QueryExecutionDeps`-shaped `{runProgress, runText}` pair bound to
 * one official-client connection and credential — the direct replacement for
 * the retired `makeOfficialRunQueryShim`. `credentialFor` takes no `ChCtx`
 * argument (that type is retiring too): every existing call site already
 * ignored it (`() => BASIC_USER_A`), so dropping it is a mechanical signature
 * narrowing, not a behavior change. */
export function makeOfficialQueryExecutionAdapter(
  conn: OfficialConnection,
  credentialFor: () => SpikeCredential,
): OfficialQueryExecutionAdapter {
  async function runProgress(request: QueryExecutionRequest, callbacks: QueryProgressCallbacks): Promise<void> {
    const { query_id: queryId, ...nativeParams } = request.params || {};
    const auth = officialAuthFor(credentialFor());
    const common = {
      query_id: queryId != null ? String(queryId) : undefined,
      abort_signal: request.signal,
      auth,
      clickhouse_settings: request.settings,
      query_params: nativeParams,
    };

    if (request.defaultFormat === 'JSONEachRowWithProgress') {
      const rs = await conn.client.query({ query: request.sql, format: 'JSONEachRowWithProgress', ...common });
      const stream = rs.stream<Record<string, unknown>>();
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const wrapped of value) {
          const row = wrapped.json() as unknown;
          if (row && typeof row === 'object' && 'exception' in (row as object)) {
            callbacks.onLine?.({ exception: String((row as { exception: unknown }).exception) });
          } else if (isRow<Record<string, unknown>>(row)) {
            callbacks.onLine?.({ row: row.row });
          } else if (isProgressRow(row)) {
            callbacks.onLine?.({ progress: { read_rows: row.progress.read_rows, read_bytes: row.progress.read_bytes, total_rows_to_read: row.progress.total_rows_to_read, elapsed_ns: row.progress.elapsed_ns } });
          }
          callbacks.onChunk?.();
        }
      }
      return;
    }

    // Table streaming (QES's `defaultFormat: 'JSONStringsEachRowWithProgress'`).
    const fullSql = `${request.sql}\nFORMAT ${request.defaultFormat}`;
    const res = await conn.client.exec({ query: fullSql, ...common });
    await bridgeNdjsonProgress(res.stream, (line) => {
      callbacks.onLine?.(line);
      callbacks.onChunk?.();
    });
  }

  async function runText(request: QueryExecutionRequest): Promise<string> {
    const { query_id: queryId, ...nativeParams } = request.params || {};
    await conn.client.command({
      query: request.sql,
      query_id: queryId != null ? String(queryId) : undefined,
      abort_signal: request.signal,
      auth: officialAuthFor(credentialFor()),
      clickhouse_settings: request.settings,
      query_params: nativeParams,
    });
    return '';
  }

  return { runProgress, runText };
}

function flattenHeaders(h: Record<string, string | string[] | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
