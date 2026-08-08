// Issue #630 Phase 4 — status classification and deliberate Response
// consumers, composed on top of the low-level `request()` in `client.ts`.
//
// Scope discipline (plan §4): `ensureClickHouseSuccess` classifies a
// resolved `Response` WITHOUT ever touching a successful body — it returns
// the exact same object by identity, never a clone, and never calls
// `.text()`/`.json()`/`.body` on the 2xx path. Only the non-2xx branch reads
// the error text, exactly once, and throws the minimal `ClickHouseError`
// from `exceptions.ts`. The three consumers below each compose EXACTLY that
// classifier plus one further native operation — no retry, no additional
// try/catch, no re-interpretation of a body/reader failure. A successful
// in-band `{"exception": ...}` progress line remains callback data (see
// `progress-stream.ts`'s `streamLines`, which this file delegates to rather
// than reimplementing); native network/abort/body-reader errors are never
// wrapped as `ClickHouseError` — only an actual non-2xx HTTP response is.

import { ClickHouseError } from './exceptions.js';
import { streamLines } from './progress-stream.js';
import type { StreamCallbacks } from './progress-stream.js';

/**
 * Classify a resolved `Response`. On success (`response.ok`), returns the
 * SAME object by strict identity — never cloned, never body-read — so
 * `bodyUsed` stays `false` and the caller's own consumption is untouched.
 * On a non-2xx status, reads the complete error text exactly once and
 * throws `ClickHouseError(status, responseText)`. A failure reading that
 * error text itself propagates as its own native rejection — no
 * `ClickHouseError` is constructed in that case.
 */
export async function ensureClickHouseSuccess(response: Response): Promise<Response> {
  if (response.ok) return response;

  const responseText = await response.text();
  throw new ClickHouseError(response.status, responseText);
}

/** Classify, then parse the successful body as JSON. A malformed successful
 *  body's native `SyntaxError` propagates unchanged — this performs no
 *  catch/wrap around `.json()`. */
export async function consumeJsonResponse<T>(response: Response): Promise<T> {
  const success = await ensureClickHouseSuccess(response);
  return success.json() as Promise<T>;
}

/** Classify, then read the successful body as text. */
export async function consumeTextResponse(response: Response): Promise<string> {
  const success = await ensureClickHouseSuccess(response);
  return success.text();
}

/** Classify, then drive the successful body through the ONE canonical
 *  progress-stream read loop (`streamLines` — never reimplemented here).
 *  Resolves with the same `Response` `ensureClickHouseSuccess` returned,
 *  after the stream has been fully consumed. A reader rejection (including
 *  an aborted signal's `AbortError`) propagates unmodified, exactly as
 *  `streamLines` itself guarantees. */
export async function consumeProgressResponse(
  response: Response,
  callbacks: StreamCallbacks = {},
): Promise<Response> {
  const success = await ensureClickHouseSuccess(response);
  await streamLines(success.body!, callbacks);
  return success;
}
