// Phase 0 / issue #585, plan §21 "Immediate pre-fetch epoch fencing" —
// experiment infrastructure for whether a credential-epoch race (the
// replacement happening AFTER a request is prepared but BEFORE its real
// fetch fires) can still reach the network with a stale/replaced credential
// when the official client owns request construction internally.
//
// Two checkpoints, both required by the plan:
//   1. adapter-side: immediately before invoking the official API method
//      (`register` below refuses to register — and the caller must not call
//      the client at all — when the epoch has already turned).
//   2. injected-fetch boundary: `guardedFetch` re-checks the CURRENT epoch
//      against the epoch that was current when the query_id was registered,
//      immediately before delegating to the real fetch. This is the
//      checkpoint that actually closes the race the plan describes, since
//      the official client's internal work between "call the method" and
//      "invoke injected fetch" is exactly the unguarded window.
//
// This is spike-only experiment code: if it becomes a second general request
// implementation (the plan's own failure condition), the ADR must fail
// auth/epoch parity rather than adopt it as-is.

export interface EpochFence {
  /** Adapter-side checkpoint #1. Call immediately before invoking the
   *  official client method. Returns false (and registers nothing) when the
   *  epoch has already turned — the caller must treat this exactly like a
   *  stale-epoch abort and never invoke the official API. */
  register(queryId: string, expectedEpoch: number): boolean;
  /** Removes a query_id's registration once its call has settled. */
  unregister(queryId: string): void;
  /** Injected-fetch checkpoint #2 — pass as `fetch` to `createClient`. */
  guardedFetch: typeof fetch;
  /** How many times the real fetch was actually delegated to — the
   *  "no stale credential reaches fetch" invariant's proof. */
  readonly delegatedCalls: number;
  /** How many times a request was rejected at the fetch boundary for being
   *  stale — the epoch-flip race's proof of effect. */
  readonly staleRejections: number;
}

/** Extract `query_id` from a ClickHouse HTTP request URL's query string —
 * the official client always sends it there (matching the production
 * `ch-client.ts` URL shape), so this needs no test-only header. */
function extractQueryId(input: RequestInfo | URL): string | null {
  try {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL((input as Request).url);
    return url.searchParams.get('query_id');
  } catch {
    return null;
  }
}

class StaleEpochError extends Error {
  constructor() {
    super('request superseded by a newer authentication session (epoch fence)');
    this.name = 'AbortError';
  }
}

/** Build one `EpochFence` bound to `getCurrentEpoch()` and a real delegate
 * fetch. `registered` is removed in `finally` by the caller once its call
 * settles (register/unregister is caller-driven, not fetch-driven, since a
 * query_id may legitimately appear in more than one request — e.g. KILL
 * QUERY reusing the same id is out of scope for this fence). */
export function createEpochFence(getCurrentEpoch: () => number, realFetch: typeof fetch): EpochFence {
  const registered = new Map<string, number>();
  let delegatedCalls = 0;
  let staleRejections = 0;

  function register(queryId: string, expectedEpoch: number): boolean {
    if (getCurrentEpoch() !== expectedEpoch) return false;
    registered.set(queryId, expectedEpoch);
    return true;
  }

  const guardedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const queryId = extractQueryId(input);
    const expectedEpoch = queryId != null ? registered.get(queryId) : undefined;
    if (expectedEpoch !== undefined && getCurrentEpoch() !== expectedEpoch) {
      staleRejections += 1;
      throw new StaleEpochError();
    }
    delegatedCalls += 1;
    return realFetch(input, init);
  }) as typeof fetch;

  return {
    register,
    unregister(queryId: string) { registered.delete(queryId); },
    guardedFetch,
    get delegatedCalls() { return delegatedCalls; },
    get staleRejections() { return staleRejections; },
  };
}
