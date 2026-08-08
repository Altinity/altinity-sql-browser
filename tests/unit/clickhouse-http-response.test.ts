import { describe, expect, it, vi } from 'vitest';
import {
  ensureClickHouseSuccess,
  consumeJsonResponse,
  consumeTextResponse,
  consumeProgressResponse,
  ClickHouseError,
} from '@altinity/clickhouse-http';
import type { StreamLine } from '@altinity/clickhouse-http';

// Issue #630 Phase 4 — direct spec for the package's response classifier +
// consumers, consumed exclusively through the public export (contract A4).
// Every fixture here is a plain, native `Response`/`ReadableStream` — no
// fault-server fixture is needed for these narrow structured/error-body
// cases (plan §13).

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

/** Override `.text()` on an existing `Response` so a test can prove
 *  something either DID or DID NOT read the body, or that a body read
 *  itself fails with a specific sentinel. */
function withTextOverride(response: Response, impl: () => Promise<string>): Response {
  Object.defineProperty(response, 'text', { value: impl });
  return response;
}

function withJsonOverride(response: Response, impl: () => Promise<unknown>): Response {
  Object.defineProperty(response, 'json', { value: impl });
  return response;
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

function stringStream(chunks: string[]): ReadableStream<Uint8Array> {
  return byteStream(chunks.map((c) => new TextEncoder().encode(c)));
}

function streamResponse(chunks: string[], status = 200): Response {
  return new Response(stringStream(chunks), { status });
}

describe('ensureClickHouseSuccess — successful classification never consumes', () => {
  it('returns the exact same Response by identity', async () => {
    const response = textResponse('ok');
    const result = await ensureClickHouseSuccess(response);
    expect(result).toBe(response);
  });

  it('leaves bodyUsed === false', async () => {
    const response = textResponse('ok');
    const result = await ensureClickHouseSuccess(response);
    expect(result.bodyUsed).toBe(false);
  });

  it('the body can subsequently be consumed normally', async () => {
    const response = textResponse('hello world');
    const result = await ensureClickHouseSuccess(response);
    await expect(result.text()).resolves.toBe('hello world');
  });

  it('never reads a body designed to fail if read, during classification itself', async () => {
    let textCalled = false;
    const response = withTextOverride(textResponse('should never be read'), () => {
      textCalled = true;
      return Promise.reject(new Error('should not be called'));
    });
    const result = await ensureClickHouseSuccess(response);
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    expect(textCalled).toBe(false);
  });

  it('never clones the response — cloning-and-reading-the-clone would leave the ORIGINAL bodyUsed false too, so this must be checked independently of the bodyUsed assertion above', async () => {
    // A `response.clone().text()` sabotage never touches the original
    // response's own `bodyUsed` flag (each clone gets its own independent
    // body stream) — a `bodyUsed === false` assertion alone cannot catch
    // it. Overriding `.clone()` itself is the only way to prove classifying
    // a successful response never even attempts to duplicate its body.
    let cloneCalled = false;
    const response = textResponse('should never be cloned');
    Object.defineProperty(response, 'clone', {
      value: () => {
        cloneCalled = true;
        throw new Error('clone() should not be called on a successful response');
      },
    });
    const result = await ensureClickHouseSuccess(response);
    expect(result).toBe(response);
    expect(cloneCalled).toBe(false);
  });
});

describe('ensureClickHouseSuccess — non-2xx classification', () => {
  it('throws ClickHouseError for realistic plain ClickHouse error text', async () => {
    const response = textResponse('Code: 60. DB::Exception: Table default.missing does not exist. (UNKNOWN_TABLE)', 404);
    await expect(ensureClickHouseSuccess(response)).rejects.toBeInstanceOf(ClickHouseError);
  });

  it('the thrown error is instanceof both ClickHouseError and Error', async () => {
    const response = textResponse('boom', 500);
    try {
      await ensureClickHouseSuccess(response);
      throw new Error('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(ClickHouseError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('name is exactly ClickHouseError', async () => {
    const response = textResponse('boom', 500);
    await ensureClickHouseSuccess(response).catch((e: ClickHouseError) => {
      expect(e.name).toBe('ClickHouseError');
    });
  });

  it('carries the exact status', async () => {
    const response = textResponse('boom', 403);
    await ensureClickHouseSuccess(response).catch((e: ClickHouseError) => {
      expect(e.status).toBe(403);
    });
  });

  it('carries the exact responseText', async () => {
    const body = 'Code: 497. DB::Exception: Not enough privileges. (ACCESS_DENIED)';
    const response = textResponse(body, 403);
    await ensureClickHouseSuccess(response).catch((e: ClickHouseError) => {
      expect(e.responseText).toBe(body);
    });
  });

  it('message is the parsed/raw text per parseExceptionText', async () => {
    const response = textResponse('plain unstructured failure text', 500);
    await ensureClickHouseSuccess(response).catch((e: ClickHouseError) => {
      expect(e.message).toBe('plain unstructured failure text');
    });
  });

  it('calls response.text() exactly once', async () => {
    const response = textResponse('boom', 500);
    const spy = vi.spyOn(response, 'text');
    await ensureClickHouseSuccess(response).catch(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves the failed response consumed', async () => {
    const response = textResponse('boom', 500);
    await ensureClickHouseSuccess(response).catch(() => {});
    expect(response.bodyUsed).toBe(true);
  });
});

describe('ensureClickHouseSuccess — structured parser reuse', () => {
  it('a body with a valid {"exception":...} line: message is the parsed exception, responseText is the complete original body', async () => {
    const body = '{"meta":1}\n{"exception":"DB::Exception: Memory limit exceeded"}';
    const response = textResponse(body, 500);
    await ensureClickHouseSuccess(response).catch((e: ClickHouseError) => {
      expect(e.message).toBe('DB::Exception: Memory limit exceeded');
      expect(e.responseText).toBe(body);
    });
  });

  it('malformed/unrecognized input falls back to the exact raw text', async () => {
    const body = '{"exception": not valid json';
    const response = textResponse(body, 500);
    await ensureClickHouseSuccess(response).catch((e: ClickHouseError) => {
      expect(e.message).toBe(body);
      expect(e.responseText).toBe(body);
    });
  });
});

describe('ensureClickHouseSuccess — failed non-2xx body read', () => {
  it('a rejecting error-body read propagates by exact identity, never becoming ClickHouseError', async () => {
    const sentinel = new Error('sentinel body-read failure');
    const response = withTextOverride(textResponse('unused', 500), () => Promise.reject(sentinel));
    await expect(ensureClickHouseSuccess(response)).rejects.toBe(sentinel);
  });
});

describe('consumeJsonResponse', () => {
  it('parses a successful JSON body', async () => {
    const response = textResponse(JSON.stringify({ a: 1 }), 200);
    await expect(consumeJsonResponse<{ a: number }>(response)).resolves.toEqual({ a: 1 });
  });

  it('leaves the successful response consumed', async () => {
    const response = textResponse(JSON.stringify({ a: 1 }), 200);
    await consumeJsonResponse(response);
    expect(response.bodyUsed).toBe(true);
  });

  it('throws ClickHouseError on non-2xx', async () => {
    const response = textResponse('Code: 999. DB::Exception: boom', 500);
    await expect(consumeJsonResponse(response)).rejects.toBeInstanceOf(ClickHouseError);
  });

  it('a malformed successful JSON body keeps its native parse failure', async () => {
    const response = textResponse('not json', 200);
    const rejection = await consumeJsonResponse(response).catch((e) => e);
    expect(rejection).not.toBeInstanceOf(ClickHouseError);
    expect(rejection).toBeInstanceOf(Error);
  });

  it('an arbitrary successful-body read failure keeps exact rejection identity', async () => {
    const sentinel = new Error('sentinel json-read failure');
    const response = withJsonOverride(textResponse('irrelevant', 200), () => Promise.reject(sentinel));
    await expect(consumeJsonResponse(response)).rejects.toBe(sentinel);
  });
});

describe('consumeTextResponse', () => {
  it('resolves with the exact success text', async () => {
    const response = textResponse('exact text body', 200);
    await expect(consumeTextResponse(response)).resolves.toBe('exact text body');
  });

  it('leaves the successful response consumed', async () => {
    const response = textResponse('exact text body', 200);
    await consumeTextResponse(response);
    expect(response.bodyUsed).toBe(true);
  });

  it('throws ClickHouseError via the shared classifier on non-2xx', async () => {
    const response = textResponse('Code: 999. DB::Exception: boom', 500);
    await expect(consumeTextResponse(response)).rejects.toBeInstanceOf(ClickHouseError);
  });

  it('an arbitrary successful-body read failure is unchanged', async () => {
    const sentinel = new Error('sentinel text-read failure');
    const response = withTextOverride(textResponse('irrelevant', 200), () => Promise.reject(sentinel));
    await expect(consumeTextResponse(response)).rejects.toBe(sentinel);
  });
});

describe('consumeProgressResponse', () => {
  it('drives callbacks and returns the same Response after successful consumption', async () => {
    const response = streamResponse(['{"row":{"a":"1"}}\n', '{"row":{"a":"2"}}\n']);
    const lines: StreamLine[] = [];
    const result = await consumeProgressResponse(response, { onLine: (l) => lines.push(l) });
    expect(result).toBe(response);
    expect(lines).toEqual([{ row: { a: '1' } }, { row: { a: '2' } }]);
  });

  it('leaves the stream consumed (locked) after successful consumption', async () => {
    // `streamLines` drains the body through `body.getReader()` directly
    // (never `.text()`/`.json()`) — a real Fetch implementation flips
    // `bodyUsed` for that path too (the stream becomes "disturbed"), but
    // this test environment's `Response.bodyUsed` only tracks its own
    // higher-level consumption methods, not a caller draining `.body`
    // directly. `.body.locked` is the portable proof available here that
    // the stream was actually consumed, not left untouched.
    const response = streamResponse(['{"row":{"a":"1"}}\n']);
    expect(response.body!.locked).toBe(false);
    await consumeProgressResponse(response);
    expect(response.body!.locked).toBe(true);
  });

  it('omitted callbacks work', async () => {
    const response = streamResponse(['{"row":{"a":"1"}}\n']);
    await expect(consumeProgressResponse(response)).resolves.toBe(response);
  });

  it('an in-band {exception: ...} line arrives through onLine, not as a thrown ClickHouseError', async () => {
    const response = streamResponse(['{"exception":"DB::Exception: boom (in-band)"}\n']);
    const lines: StreamLine[] = [];
    await expect(consumeProgressResponse(response, { onLine: (l) => lines.push(l) })).resolves.toBe(response);
    expect(lines).toEqual([{ exception: 'DB::Exception: boom (in-band)' }]);
  });

  it('a non-2xx response rejects with ClickHouseError before any progress callback fires', async () => {
    const response = textResponse('Code: 999. DB::Exception: boom', 500);
    const onLine = vi.fn();
    await expect(consumeProgressResponse(response, { onLine })).rejects.toBeInstanceOf(ClickHouseError);
    expect(onLine).not.toHaveBeenCalled();
  });

  it('a reader failure propagates by exact identity', async () => {
    const sentinel = Object.assign(new Error('sentinel reader failure'), { name: 'AbortError' });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(sentinel); },
    });
    const response = new Response(stream, { status: 200 });
    await expect(consumeProgressResponse(response)).rejects.toBe(sentinel);
  });
});
