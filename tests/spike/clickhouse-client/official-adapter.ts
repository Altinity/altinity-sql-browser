// Phase 0 / issue #585 — the "official-side spike adapter" (plan §7): the
// ONLY module in this repository that imports `@clickhouse/client-web`.
// Constructs one client per connection configuration (never per request or
// refresh — plan's "One official client per connection config" invariant),
// injects fetch, supplies complete per-request authentication via
// `http_headers` (never a client-level default), and exposes only the
// test-owned normalized `SpikeOutcome` — the official result/error types
// (`ClickHouseError`, `ExecResult`, …) never escape this file.
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
import { credentialAuthHeader } from './current-adapter.js';

export interface OfficialConnection {
  client: ClickHouseClient;
  constructorCalls: number;
  fetchCalls: number;
}

/** Construct ONE official client for `baseUrl`, with `realFetch` injected and
 * fetch-call counting wired in. The client-level `auth`/`http_headers` are
 * left at a non-secret, deliberately-invalid default (plan §21 "Per-request
 * auth": "Construct one official client with a non-secret invalid default
 * credential") — every real request supplies its own `http_headers`
 * override, so the default is never authoritative. */
export function createOfficialConnection(baseUrl: string, realFetch: typeof fetch): OfficialConnection {
  let fetchCalls = 0;
  const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls += 1;
    return realFetch(input, init);
  }) as typeof fetch;
  const client = createClient({
    url: baseUrl,
    username: 'asb-spike-default-invalid',
    password: 'asb-spike-default-invalid',
    fetch: countingFetch,
  });
  return {
    client,
    get constructorCalls() { return 1; },
    get fetchCalls() { return fetchCalls; },
  };
}

function httpHeadersFor(credential: SpikeCredential): Record<string, string> {
  return { Authorization: credentialAuthHeader(credential) };
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
  const t0 = Date.now();
  const http_headers = httpHeadersFor(request.credential);
  const fetchCallsBefore = conn.fetchCalls;

  try {
    if (request.consume === 'raw' || request.format !== 'Table' && request.format !== 'KPI') {
      // Raw/explicit-format path: exec() with the fully-authored SQL
      // (including its own FORMAT clause), byte-hashed straight off .stream —
      // never .text()/TextDecoder/JSON-parsed (plan §24's raw-decoding ban).
      const fullSql = /\bFORMAT\s+\S+\s*;?\s*$/i.test(request.sql)
        ? request.sql
        : `${request.sql}\nFORMAT ${request.format}`;
      const res = await conn.client.exec({
        query: fullSql,
        query_id: request.queryId,
        session_id: request.sessionId,
        role: request.role,
        abort_signal: request.signal,
        http_headers,
        use_multipart_params: request.multipart,
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
        http_headers,
        use_multipart_params: request.multipart,
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
        http_headers,
        use_multipart_params: request.multipart,
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

// ── QueryExecutionService shim ──────────────────────────────────────────────
// Plan §23 "Overlap two requests in one session and feed official-spike
// outcomes through existing QueryExecutionService" / invariant map's "Retry
// safety remains unchanged — official outcomes feed existing execution
// policy". This shim satisfies `typeof runQuery` from `src/net/ch-client.ts`
// exactly (same signature, same `RunQueryResult` shape) so the REAL,
// unmodified `createQueryExecutionService` (src/application/
// query-execution-service.ts) can run its real retry/classification logic
// against the official client — never a reimplementation of that policy.

import type { ChCtx, RunQueryOptions, RunQueryResult } from '../../../src/net/ch-client.js';

/** Faithfully mirrors `runQuery`'s own throw/return contract (plan's "Retry
 * safety remains unchanged" invariant needs this EXACTLY, not an
 * approximation): a ClickHouse-level query error (non-2xx with a parseable
 * exception, or an in-band `{"exception"}` line) RETURNS `{ error }`; a
 * network-level failure (rejected fetch, mid-stream reset) THROWS, exactly
 * like production's `runQuery` does when `authedFetch`/the streaming read
 * loop rejects — so `QueryExecutionService`'s real `attemptStatement`
 * (`e instanceof TypeError` -> `transient`) classifies it identically
 * regardless of which client produced the exception. */
export function makeOfficialRunQueryShim(conn: OfficialConnection, credentialFor: (ctx: ChCtx) => SpikeCredential) {
  return async function officialRunQueryShim(ctx: ChCtx, sql: string, o: RunQueryOptions = {}): Promise<RunQueryResult> {
    const fmt = o.format || 'Table';
    const http_headers = { Authorization: credentialAuthHeader(credentialFor(ctx)) };
    const common = { query_id: o.queryId, abort_signal: o.signal, http_headers, query_params: o.params };

    if (fmt === 'Table') {
      const fullSql = `${sql}\nFORMAT JSONStringsEachRowWithProgress`;
      let res;
      try {
        res = await conn.client.exec({ query: fullSql, ...common });
      } catch (e) {
        if (e instanceof ClickHouseError) return { error: e.message };
        throw e; // network-level — propagate for attemptStatement's own classification
      }
      let sawException: string | null = null;
      await bridgeNdjsonProgress(res.stream, (line) => {
        if (line.exception) sawException = line.exception;
        o.onLine?.(line);
      });
      if (sawException) return { error: sawException };
      return { streamed: true };
    }

    if (fmt === 'KPI') {
      let rs;
      try {
        rs = await conn.client.query({ query: sql, format: 'JSONEachRowWithProgress', ...common });
      } catch (e) {
        if (e instanceof ClickHouseError) return { error: e.message };
        throw e;
      }
      let sawException: string | null = null;
      const stream = rs.stream<Record<string, unknown>>();
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const wrapped of value) {
          const row = wrapped.json() as unknown;
          if (row && typeof row === 'object' && 'exception' in (row as object)) {
            sawException = String((row as { exception: unknown }).exception);
          } else if (isRow<Record<string, unknown>>(row)) {
            o.onLine?.({ row: row.row });
          } else if (isProgressRow(row)) {
            o.onLine?.({ progress: { read_rows: row.progress.read_rows, read_bytes: row.progress.read_bytes, total_rows_to_read: row.progress.total_rows_to_read, elapsed_ns: row.progress.elapsed_ns } });
          }
        }
      }
      if (sawException) return { error: sawException };
      return { streamed: true };
    }

    // Raw/explicit-format, no-output-of-interest (INSERT/DDL/command) path —
    // `command()` per plan §7 "use command() only when discarding output is
    // intentional".
    try {
      await conn.client.command({ query: sql, ...common });
      return { raw: '' };
    } catch (e) {
      if (e instanceof ClickHouseError) return { error: e.message };
      throw e;
    }
  };
}

function flattenHeaders(h: Record<string, string | string[] | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
