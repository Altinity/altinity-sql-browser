import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  authenticatedRequest, authenticatedResponse, authenticatedJson, authenticatedText, authenticatedProgress,
} from '../../src/net/authenticated-clickhouse-request.js';
import type { AuthenticatedRequestCtx } from '../../src/net/authenticated-clickhouse-request.js';
import { ClickHouseError } from '@altinity/clickhouse-http';

// Issue #630 Phase 6 — this file is the new sole owner of the low-level
// auth/epoch/refresh/lifecycle request tests that used to live in
// ch-client.test.ts's `authedFetch` describe block (moved verbatim,
// retargeted onto `authenticatedRequest`, not copied — the old describe
// block no longer exists in ch-client.test.ts), plus new composition tests
// proving `authenticatedJson`/`authenticatedText`/`authenticatedProgress`
// each go through this SAME auth loop and exactly one matching package
// response consumer. `ch-client.test.ts` keeps only CALLER-level proofs
// (its exported `queryJson`/`runQuery`/`exportQuery` still reach this module
// correctly) so the new module is never tested only in isolation.

// --- Response stubs (mirrors ch-client.test.ts's own, since this module's
// contract is the same fetch-consuming shape `ch-client.ts` used before the
// move) --------------------------------------------------------------------

interface FakeResponse {
  ok: boolean;
  status: number;
  json?(): Promise<unknown>;
  text(): Promise<string>;
  clone(): FakeResponse;
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
}
function jsonResp(body: unknown, ok = true, status = ok ? 200 : 500): FakeResponse {
  return {
    ok, status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    clone() { return this; },
  };
}
function textResp(text: string, ok = true, status = ok ? 200 : 500): FakeResponse {
  return { ok, status, text: async () => text, clone() { return this; } };
}
function streamResp(lines: string[], ok = true): FakeResponse {
  let i = 0;
  return {
    ok, status: ok ? 200 : 500,
    text: async () => lines.join(''),
    clone() { return this; },
    body: {
      getReader: () => ({
        read: async () =>
          i < lines.length
            ? { done: false, value: new TextEncoder().encode(lines[i++]) }
            : { done: true },
      }),
    },
  };
}

interface FetchInit {
  method: string;
  body: string;
  headers: { Authorization: string };
  signal?: AbortSignal;
}
type FetchImpl = (url: string, init: FetchInit) => FakeResponse | Promise<FakeResponse>;

const asFetch = (v: object): typeof fetch => v as typeof fetch;

function ctxWith(fetchImpl: FetchImpl, over: Partial<AuthenticatedRequestCtx> = {}) {
  const fetchMock = vi.fn(fetchImpl);
  return {
    fetch: asFetch(fetchMock),
    fetchMock,
    origin: 'https://ch.example',
    getToken: vi.fn(async (): Promise<string | null> => 'tok'),
    refresh: vi.fn(async () => false),
    onSignedOut: vi.fn(),
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('authenticatedRequest', () => {
  it('throws + signals out when no token', async () => {
    const ctx = ctxWith(() => jsonResp({}), { getToken: async () => null });
    await expect(authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' })).rejects.toThrow('not signed in');
    expect(ctx.onSignedOut).toHaveBeenCalled();
  });
  it('cancels without signaling auth loss when a missing-token request becomes stale', async () => {
    let epoch = 1;
    const token = deferred<string | null>();
    const ctx = ctxWith(() => jsonResp({}), { currentEpoch: () => epoch, getToken: () => token.promise });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    epoch = 2;
    token.resolve(null);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
  });
  it('does not fetch a replacement credential when the initial token lookup crosses an epoch', async () => {
    let epoch = 1;
    const token = deferred<string | null>();
    const onTransportConnected = vi.fn();
    const onTransportOffline = vi.fn();
    const ctx = ctxWith(() => jsonResp({}), {
      currentEpoch: () => epoch,
      getToken: () => token.promise,
      onTransportConnected,
      onTransportOffline,
    });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    epoch = 2;
    token.resolve('replacement-token');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(ctx.fetchMock).not.toHaveBeenCalled();
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
    expect(onTransportConnected).not.toHaveBeenCalled();
    expect(onTransportOffline).not.toHaveBeenCalled();
  });
  it('rechecks the epoch after constructing authorization and immediately before fetch', async () => {
    let epoch = 1;
    const ctx = ctxWith(() => jsonResp({}), {
      currentEpoch: () => epoch,
      authHeader: (token) => {
        epoch = 2;
        return 'Bearer replacement-' + token;
      },
    });
    await expect(authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(ctx.fetchMock).not.toHaveBeenCalled();
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
  });
  it('returns the response on success', async () => {
    const ctx = ctxWith(async () => jsonResp({ ok: 1 }));
    const r = await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    expect(r.ok).toBe(true);
    expect(ctx.fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });
  it('reports a successful current transport connection when lifecycle hooks are supplied', async () => {
    const onTransportConnected = vi.fn();
    const ctx = ctxWith(async () => jsonResp({ ok: 1 }), { currentEpoch: () => 4, onTransportConnected });
    await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    expect(onTransportConnected).toHaveBeenCalledTimes(1);
  });
  it('does not report a non-2xx response as a connected transport', async () => {
    const onTransportConnected = vi.fn();
    const ctx = ctxWith(async () => textResp('bad', false, 400), { onTransportConnected });
    await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    expect(onTransportConnected).not.toHaveBeenCalled();
    expect(ctx.authConfirmed).toBeUndefined();
  });
  it('reports a non-abort fetch rejection as transport-offline', async () => {
    const failure = new Error('network unavailable');
    const onTransportOffline = vi.fn();
    const ctx = ctxWith(async () => { throw failure; }, { currentEpoch: () => 4, onTransportOffline });
    await expect(authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' })).rejects.toBe(failure);
    expect(onTransportOffline).toHaveBeenCalledWith(failure);
  });
  it('does not report a stale fetch rejection as transport-offline', async () => {
    let epoch = 1;
    const failure = new Error('network unavailable');
    const rejectedFetch = deferred<FakeResponse>();
    const fetchStarted = deferred<void>();
    const onTransportOffline = vi.fn();
    const ctx = ctxWith(async () => {
      fetchStarted.resolve();
      return rejectedFetch.promise;
    }, { currentEpoch: () => epoch, onTransportOffline });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    await fetchStarted.promise;
    epoch = 2;
    rejectedFetch.reject(failure);
    await expect(pending).rejects.toBe(failure);
    expect(onTransportOffline).not.toHaveBeenCalled();
  });
  it('does not report HTTP failures or caller cancellation as transport-offline', async () => {
    const onTransportOffline = vi.fn();
    const httpCtx = ctxWith(async () => textResp('server error', false, 500), { onTransportOffline });
    await authenticatedRequest(httpCtx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    const controller = new AbortController();
    controller.abort();
    const abortCtx = ctxWith(async () => { throw new Error('cancelled request'); }, { onTransportOffline });
    await expect(authenticatedRequest(abortCtx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress', signal: controller.signal })).rejects.toThrow('cancelled request');
    expect(onTransportOffline).not.toHaveBeenCalled();
  });
  it('does not report an AbortError rejection as transport-offline', async () => {
    const onTransportOffline = vi.fn();
    const abortError = Object.assign(new Error('cancelled request'), { name: 'AbortError' });
    const ctx = ctxWith(async () => { throw abortError; }, { onTransportOffline });
    await expect(authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' })).rejects.toBe(abortError);
    expect(onTransportOffline).not.toHaveBeenCalled();
  });
  it('rejects a malformed URL param synchronously without a token read, a fetch, or an offline signal', async () => {
    const onTransportOffline = vi.fn();
    const ctx = ctxWith(async () => jsonResp({ ok: 1 }), { onTransportOffline });
    // A lone UTF-16 surrogate makes `chUrl`'s `encodeURIComponent` throw a
    // URIError — request-preparation failure, not a network failure.
    await expect(
      authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress', params: { x: '\ud800' } }),
    ).rejects.toBeInstanceOf(URIError);
    expect(ctx.getToken).not.toHaveBeenCalled();
    expect(ctx.fetchMock).not.toHaveBeenCalled();
    expect(onTransportOffline).not.toHaveBeenCalled();
  });
  it('refreshes once on 401 then retries', async () => {
    let n = 0;
    const ctx = ctxWith(async () => (n++ === 0 ? jsonResp({}, false, 401) : jsonResp({ ok: 1 })), {
      refresh: vi.fn(async () => true),
      getToken: vi.fn(async () => (n === 0 ? 'old' : 'new')),
    });
    const r = await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    expect(r.ok).toBe(true);
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
  });
  it('computes a fresh, complete Authorization on the retried attempt, distinct from the first', async () => {
    let fetchN = 0;
    let tokenN = 0;
    const ctx = ctxWith(async () => (fetchN++ === 0 ? jsonResp({}, false, 401) : jsonResp({ ok: 1 })), {
      refresh: vi.fn(async () => true),
      getToken: vi.fn(async () => (tokenN++ === 0 ? 'old-token' : 'new-token')),
    });
    await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
    const first = ctx.fetchMock.mock.calls[0][1].headers.Authorization;
    const second = ctx.fetchMock.mock.calls[1][1].headers.Authorization;
    expect(first).toBe('Bearer old-token');
    expect(second).toBe('Bearer new-token');
  });
  it('does not attempt a second refresh when the retried request also fails authentication', async () => {
    const ctx = ctxWith(async () => textResp('Code: 516. DB::Exception: Authentication failed', false, 401), {
      refresh: vi.fn(async () => true),
    });
    await expect(authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' })).rejects.toThrow('signed out');
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.onSignedOut).toHaveBeenCalledTimes(1);
  });
  it('signs out with an authorization message + server reason when CH rejects a valid token (403)', async () => {
    const ctx = ctxWith(
      async () => textResp('Code: 516. DB::Exception: Authentication failed', false, 403),
      { refresh: async () => false },
    );
    await expect(authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' })).rejects.toThrow('signed out');
    expect(ctx.onSignedOut).toHaveBeenCalledTimes(1);
    const msg = (ctx.onSignedOut as Mock).mock.calls[0][0];
    expect(msg).toContain('HTTP 403');
    expect(msg).toContain('not authorizing you');
    expect(msg).toContain('Server: Code: 516. DB::Exception: Authentication failed');
  });
  it('signals a credential-denial sign-out tagged with the epoch captured at entry', async () => {
    const ctx = ctxWith(async () => textResp('Code: 516. DB::Exception: Authentication failed', false, 403), {
      currentEpoch: () => 3, refresh: async () => false,
    });
    await expect(authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' })).rejects.toThrow('signed out');
    expect((ctx.onSignedOut as Mock).mock.calls[0][1]).toBe(3);
  });
  it('signals auth loss tagged with the epoch captured at entry, not a later current epoch', async () => {
    const ctx = ctxWith(() => jsonResp({}), { currentEpoch: () => 7, getToken: async () => null });
    await expect(authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' })).rejects.toThrow('not signed in');
    expect(ctx.onSignedOut).toHaveBeenCalledWith(undefined, 7);
  });
  it('marks the ctx authenticated on a successful response', async () => {
    const ctx = ctxWith(async () => jsonResp({ ok: 1 }));
    await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    expect(ctx.authConfirmed).toBe(true);
  });
  it('fences a stale successful response from lifecycle and authentication state', async () => {
    let epoch = 1;
    const response = deferred<FakeResponse>();
    const fetchStarted = deferred<void>();
    const onTransportConnected = vi.fn();
    const ctx = ctxWith(async () => {
      fetchStarted.resolve();
      return response.promise;
    }, { currentEpoch: () => epoch, onTransportConnected });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    await fetchStarted.promise;
    epoch = 2;
    response.resolve(jsonResp({ ok: 1 }));
    expect((await pending).ok).toBe(true);
    expect(ctx.authConfirmed).toBeUndefined();
    expect(onTransportConnected).not.toHaveBeenCalled();
  });
  it('fences a stale auth-failure response from refresh and sign-out', async () => {
    let epoch = 1;
    const onTransportOffline = vi.fn();
    const response = deferred<FakeResponse>();
    const fetchStarted = deferred<void>();
    const ctx = ctxWith(async () => {
      fetchStarted.resolve();
      return response.promise;
    }, {
      currentEpoch: () => epoch,
      refresh: vi.fn(async () => true),
      onTransportOffline,
    });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    await fetchStarted.promise;
    epoch = 2;
    response.resolve(jsonResp({}, false, 401));
    expect((await pending).status).toBe(401);
    expect(ctx.refresh).not.toHaveBeenCalled();
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
    expect(onTransportOffline).not.toHaveBeenCalled();
  });
  it('does not refresh a replacement epoch after delayed body classification', async () => {
    let epoch = 1;
    const body = deferred<string>();
    const bodyStarted = deferred<void>();
    const response: FakeResponse = {
      ok: false,
      status: 500,
      text: async () => {
        bodyStarted.resolve();
        return body.promise;
      },
      clone() { return this; },
    };
    const ctx = ctxWith(async () => response, {
      currentEpoch: () => epoch,
      refresh: vi.fn(async () => true),
    });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    await bodyStarted.promise;
    epoch = 2;
    body.resolve('jwt::token_verification_exception');

    expect((await pending).status).toBe(500);
    expect(ctx.refresh).not.toHaveBeenCalled();
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
  });
  it('does not retry or sign out when refresh settles after its request becomes stale', async () => {
    let epoch = 1;
    const refresh = deferred<boolean>();
    const refreshStarted = deferred<void>();
    const ctx = ctxWith(async () => jsonResp({}, false, 401), {
      currentEpoch: () => epoch,
      refresh: vi.fn(async () => {
        refreshStarted.resolve();
        return refresh.promise;
      }),
    });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    await refreshStarted.promise;
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    epoch = 2;
    refresh.resolve(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
  });
  it('does not retry when the post-refresh token lookup becomes stale', async () => {
    let epoch = 1;
    let tokenCalls = 0;
    const freshToken = deferred<string | null>();
    const freshTokenStarted = deferred<void>();
    const ctx = ctxWith(async () => textResp('expired', false, 401), {
      currentEpoch: () => epoch,
      refresh: vi.fn(async () => true),
      getToken: vi.fn(async () => {
        tokenCalls += 1;
        if (tokenCalls === 1) return 'old';
        freshTokenStarted.resolve();
        return freshToken.promise;
      }),
    });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    await freshTokenStarted.promise;
    epoch = 2;
    freshToken.resolve('new');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
  });
  it('does not sign out when an unsuccessful refresh becomes stale', async () => {
    let epoch = 1;
    const refresh = deferred<boolean>();
    const refreshStarted = deferred<void>();
    const ctx = ctxWith(async () => textResp('expired', false, 401), {
      currentEpoch: () => epoch,
      refresh: vi.fn(async () => {
        refreshStarted.resolve();
        return refresh.promise;
      }),
    });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    await refreshStarted.promise;
    epoch = 2;
    refresh.resolve(false);
    expect((await pending).status).toBe(401);
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
  });
  it('does not sign out when parsing the denial reason crosses an epoch', async () => {
    let epoch = 1;
    const denialText = deferred<string>();
    const textStarted = deferred<void>();
    const response: FakeResponse = {
      ok: false,
      status: 403,
      text: async () => {
        textStarted.resolve();
        return denialText.promise;
      },
      clone() { return this; },
    };
    const ctx = ctxWith(async () => response, {
      currentEpoch: () => epoch,
      refresh: vi.fn(async () => false),
    });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    await textStarted.promise;
    epoch = 2;
    denialText.resolve('Code: 516. Authentication failed');
    expect((await pending).status).toBe(403);
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
  });
  it('once authenticated, a later 403 is returned as a query error (no sign-out)', async () => {
    // e.g. SHOW CREATE USER <missing> → HTTP 403 / UNKNOWN_USER, mid-session.
    const ctx = ctxWith(async () => textResp('Code: 192. DB::Exception: There is no user x', false, 403),
      { authConfirmed: true });
    const resp = await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    expect(resp.status).toBe(403);
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
    expect(ctx.refresh).not.toHaveBeenCalled();
  });
  it('once authenticated, a later 401 is returned as a query error (no sign-out) — the 403 counterpart', async () => {
    const ctx = ctxWith(async () => textResp('Code: 291. DB::Exception: Access denied', false, 401), { authConfirmed: true });
    const resp = await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    expect(resp.status).toBe(401);
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
    expect(ctx.refresh).not.toHaveBeenCalled();
  });
  it('treats a token_verification body as auth-expired', async () => {
    let n = 0;
    const ctx = ctxWith(
      async () => (n++ === 0 ? textResp('jwt::token_verification_exception', false, 500) : jsonResp({ ok: 1 })),
      { refresh: vi.fn(async () => true) },
    );
    const r = await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    expect(r.ok).toBe(true);
  });
  it('returns a non-auth error response unchanged', async () => {
    const ctx = ctxWith(async () => textResp('syntax error', false, 400));
    const r = await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    expect(r.status).toBe(400);
  });
  it('uses a provided authHeader (e.g. Basic) instead of Bearer', async () => {
    const ctx = ctxWith(async () => jsonResp({ ok: 1 }), {
      authHeader: (t) => 'Basic ' + t.toUpperCase(),
    });
    await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress' });
    expect(ctx.fetchMock.mock.calls[0][1].headers.Authorization).toBe('Basic TOK');
  });
  it('passes the caller-supplied AbortSignal to fetch unchanged, by identity', async () => {
    const controller = new AbortController();
    const ctx = ctxWith(async () => jsonResp({ ok: 1 }));
    await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress', signal: controller.signal });
    expect(ctx.fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
  it('snapshots settings/params synchronously at entry — a caller mutating its live objects while the token await is pending cannot reach the initial or retried request', async () => {
    let n = 0;
    const settings: Record<string, string | number> = { readonly: 2 };
    const params: Record<string, string | number> = { param_id: '1' };
    const refreshStarted = deferred<void>();
    const refresh = deferred<boolean>();
    const ctx = ctxWith(async () => (n++ === 0 ? jsonResp({}, false, 401) : jsonResp({ ok: 1 })), {
      refresh: vi.fn(async () => {
        refreshStarted.resolve();
        return refresh.promise;
      }),
    });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSONStringsEachRowWithProgress', settings, params });
    await refreshStarted.promise;
    settings.readonly = 999;
    params.param_id = 'mutated';
    refresh.resolve(true);
    await pending;
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
    for (const url of [ctx.fetchMock.mock.calls[0][0], ctx.fetchMock.mock.calls[1][0]]) {
      expect(url).toContain('readonly=2');
      expect(url).toContain('param_id=1');
      expect(url).not.toContain('readonly=999');
      expect(url).not.toContain('mutated');
    }
  });
});

// Issue #585 Phase 1, Adaptation A5 — the package client's `origin()`
// accessor is read live per request, never snapshotted; the live, mutable
// `ctx.origin` (mutated in place on sign-in — `connection-session.ts`) stays
// authoritative across `authenticatedRequest`'s own retry cycle, not just in
// the package client's isolated unit tests.
describe('authenticatedRequest — live origin authority across retry (Adaptation A5)', () => {
  it('reads ctx.origin live per request across two independent authenticatedRequest calls', async () => {
    const ctx = ctxWith(async () => jsonResp({ ok: 1 }));
    await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSON' });
    ctx.origin = 'https://new-cluster.example';
    await authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSON' });
    expect(ctx.fetchMock.mock.calls[0][0]).toContain('https://ch.example');
    expect(ctx.fetchMock.mock.calls[1][0]).toContain('https://new-cluster.example');
  });

  // The case above reconstructs a package client per authenticatedRequest
  // call, so it can't by itself distinguish a live-read `origin()` from one
  // snapshotted at client-construction time. This one uses the SAME
  // authenticatedRequest invocation across its one-refresh retry loop (the
  // package client is built once per invocation, before the retry loop) to
  // prove the origin read is live per SEND, not per construction.
  it('reads ctx.origin live per send within one authenticatedRequest retry cycle, not once at client construction', async () => {
    let n = 0;
    const refreshStarted = deferred<void>();
    const refresh = deferred<boolean>();
    const ctx = ctxWith(async () => (n++ === 0 ? jsonResp({}, false, 401) : jsonResp({ ok: 1 })), {
      refresh: vi.fn(async () => {
        refreshStarted.resolve();
        return refresh.promise;
      }),
    });
    const pending = authenticatedRequest(ctx, { sql: 'sql', defaultFormat: 'JSON' });
    await refreshStarted.promise;
    ctx.origin = 'https://new-cluster.example';
    refresh.resolve(true);
    await pending;
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.fetchMock.mock.calls[0][0]).toContain('https://ch.example');
    expect(ctx.fetchMock.mock.calls[1][0]).toContain('https://new-cluster.example');
  });
});

// Issue #630 Phase 7 §5/§23 — `authenticatedResponse` composes
// `authenticatedRequest` with exactly the package's `ensureClickHouseSuccess`
// classifier (no consumer, unlike `authenticatedJson`/`authenticatedText`/
// `authenticatedProgress` below): it hands the caller back the exact
// successful native `Response`, untouched, so a caller that must own its own
// byte-stream consumption (raw export) can read the body itself. Only ONE
// package classification happens after settlement; `authenticatedRequest`
// remains the sole owner of auth/epoch/refresh/lifecycle, and this adds no
// retry and no second Fetch.
describe('authenticatedResponse — package classification composition', () => {
  it('resolves the exact successful native Response by identity, with its body left completely unread', async () => {
    const textSpy = vi.fn(async () => 'unused');
    const response: FakeResponse = { ok: true, status: 200, text: textSpy, clone() { return response; } };
    const ctx = ctxWith(async () => response);
    const resp = await authenticatedResponse(ctx, { sql: 'SELECT 1', defaultFormat: 'TSV' });
    expect(resp).toBe(response);
    expect(textSpy).not.toHaveBeenCalled();
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });
  it('throws the package ClickHouseError on a resolved non-2xx response, performing no second Fetch for classification', async () => {
    const ctx = ctxWith(async () => textResp('Code: 999. DB::Exception: boom', false, 500), { authConfirmed: true });
    const err: unknown = await authenticatedResponse(ctx, { sql: 'bad', defaultFormat: 'TSV' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClickHouseError);
    expect((err as ClickHouseError).message).toBe('Code: 999. DB::Exception: boom');
    expect((err as ClickHouseError).status).toBe(500);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });
  it('never starts non-2xx classification when the request itself was superseded (abort), and never wraps that rejection', async () => {
    const abortError = Object.assign(new Error('cancelled request'), { name: 'AbortError' });
    const ctx = ctxWith(async () => { throw abortError; });
    await expect(authenticatedResponse(ctx, { sql: 'SELECT 1', defaultFormat: 'TSV' })).rejects.toBe(abortError);
  });
  it('propagates a native fetch network TypeError rejection by identity, never wrapped as ClickHouseError', async () => {
    const networkError = new TypeError('Failed to fetch');
    const ctx = ctxWith(async () => { throw networkError; });
    await expect(authenticatedResponse(ctx, { sql: 'SELECT 1', defaultFormat: 'TSV' })).rejects.toBe(networkError);
  });
  it('still refreshes exactly once on 401 before classifying the retried response — unchanged refresh bounds', async () => {
    let n = 0;
    const ctx = ctxWith(async () => (n++ === 0 ? jsonResp({}, false, 401) : jsonResp({ ok: 1 })), {
      refresh: vi.fn(async () => true),
    });
    const resp = await authenticatedResponse(ctx, { sql: 'SELECT 1', defaultFormat: 'JSON' });
    expect(resp.ok).toBe(true);
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
  });
});

// Package-consumer composition (plan §10 "Package-consumer composition
// tests"): `authenticatedJson`/`authenticatedText`/`authenticatedProgress`
// each compose `authenticatedRequest` with exactly one matching package
// response consumer — no second Fetch, no re-derivation of the auth loop.
// Exhaustive consumer semantics (malformed JSON, empty body, etc.) already
// live in the package's own `response.ts` unit tests; these prove only the
// authenticated composition edge.
describe('authenticatedJson / authenticatedText / authenticatedProgress — package-consumer composition', () => {
  it('authenticatedJson goes through the auth loop and the package JSON consumer, parsing a successful body', async () => {
    const ctx = ctxWith(async () => jsonResp({ data: [{ a: 1 }] }));
    const result = await authenticatedJson<{ data: { a: number }[] }>(ctx, { sql: 'SELECT 1', defaultFormat: 'JSON' });
    expect(result).toEqual({ data: [{ a: 1 }] });
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.authConfirmed).toBe(true);
  });
  it('authenticatedJson still refreshes once on 401 before consuming the retried body', async () => {
    let n = 0;
    const ctx = ctxWith(async () => (n++ === 0 ? jsonResp({}, false, 401) : jsonResp({ data: [] })), {
      refresh: vi.fn(async () => true),
    });
    const result = await authenticatedJson(ctx, { sql: 'SELECT 1', defaultFormat: 'JSON' });
    expect(result).toEqual({ data: [] });
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
  });
  it('authenticatedJson throws the package ClickHouseError on a resolved non-2xx response, with no additional Fetch', async () => {
    const ctx = ctxWith(async () => textResp('{"exception":"DB::Exception: bad query"}', false, 500), { authConfirmed: true });
    const err: unknown = await authenticatedJson(ctx, { sql: 'bad', defaultFormat: 'JSON' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClickHouseError);
    expect((err as ClickHouseError).message).toBe('DB::Exception: bad query');
    expect((err as ClickHouseError).status).toBe(500);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });
  it('authenticatedText goes through the auth loop and the package text consumer', async () => {
    const ctx = ctxWith(async () => textResp('a\tb\n1\t2\n'));
    const result = await authenticatedText(ctx, { sql: 'SELECT 1', defaultFormat: 'TSV' });
    expect(result).toBe('a\tb\n1\t2\n');
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });
  it('authenticatedText preserves a native body-read error unwrapped (never ClickHouseError)', async () => {
    const bodyFailure = new Error('body stream errored');
    const brokenBody: FakeResponse = {
      ok: true,
      status: 200,
      text: async () => { throw bodyFailure; },
      clone() { return brokenBody; },
    };
    const ctx = ctxWith(async () => brokenBody);
    await expect(authenticatedText(ctx, { sql: 'SELECT 1', defaultFormat: 'TSV' })).rejects.toBe(bodyFailure);
  });
  it('authenticatedText throws the package ClickHouseError on a resolved non-2xx response', async () => {
    const ctx = ctxWith(async () => textResp('Code: 999. DB::Exception: boom', false, 500), { authConfirmed: true });
    const err: unknown = await authenticatedText(ctx, { sql: 'bad', defaultFormat: 'TSV' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClickHouseError);
    expect((err as ClickHouseError).message).toBe('Code: 999. DB::Exception: boom');
  });
  it('authenticatedProgress drives the package progress-stream consumer over the authenticated response, with the original signal reaching fetch', async () => {
    const controller = new AbortController();
    const ctx = ctxWith(async () => streamResp(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']));
    const lines: unknown[] = [];
    const resp = await authenticatedProgress(
      ctx,
      { sql: 'SELECT 1', defaultFormat: 'JSONStringsEachRowWithProgress', signal: controller.signal },
      { onLine: (l) => lines.push(l) },
    );
    expect(resp.ok).toBe(true);
    expect(lines).toEqual([{ meta: [{ name: 'a', type: 'UInt8' }] }, { row: { a: '1' } }]);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
  it('authenticatedProgress still refreshes once on 401 before streaming the retried body', async () => {
    let n = 0;
    const ctx = ctxWith(async () => (n++ === 0 ? jsonResp({}, false, 401) : streamResp(['{"row":{"a":"1"}}\n'])), {
      refresh: vi.fn(async () => true),
    });
    const lines: unknown[] = [];
    await authenticatedProgress(ctx, { sql: 'SELECT 1', defaultFormat: 'JSONStringsEachRowWithProgress' }, { onLine: (l) => lines.push(l) });
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([{ row: { a: '1' } }]);
  });
  it('authenticatedProgress throws the package ClickHouseError on a resolved non-2xx response, never starting the stream loop', async () => {
    const ctx = ctxWith(async () => textResp('Code: 999. DB::Exception: boom', false, 500), { authConfirmed: true });
    const onLine = vi.fn();
    const err = await authenticatedProgress(ctx, { sql: 'bad', defaultFormat: 'JSONStringsEachRowWithProgress' }, { onLine }).catch((e) => e);
    expect(err).toBeInstanceOf(ClickHouseError);
    expect(onLine).not.toHaveBeenCalled();
  });
});
