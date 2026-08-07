// Issue #630 Phase 2 — the authoritative ClickHouse HTTP URL serializer.
// Moved mechanically (behaviorally unchanged) from
// `src/net/clickhouse-http-transport.ts` — see that file's Phase 2 comment.
// This is the ONE `chUrl()` implementation in the repository (contract A5);
// every other importer (the root SQL Browser `src/net/**` layer) reaches it
// only through this package's public `.` export, never by relative/deep
// import (enforced by `build/check-boundaries.mjs`).
//
// Zero bare-specifier imports: this file (and every file under
// `packages/clickhouse-http/src/**`) may only use relative imports — see
// this package's `README`-equivalent rule in the Phase 2 plan §5. There is
// nothing to import here, so that constraint is trivially satisfied, but the
// architecture checker still scans this file for the sabotage regression.

/** `chUrl`'s query-string options. */
export interface ChUrlOpts {
  format?: string;
  extra?: Record<string, string | number>;
  params?: Record<string, string | number>;
}

/** Build a ClickHouse HTTP URL with query-string options. Pure. Synchronous:
 * a caller-supplied `extra`/`params` value that `encodeURIComponent` cannot
 * encode (e.g. a lone UTF-16 surrogate) throws a `URIError` directly out of
 * this call — `client.ts`'s `request()` wraps that in its own async
 * settlement so the low-level API's promise rejects instead of throwing. */
export function chUrl(origin: string, opts: ChUrlOpts = {}): string {
  const format = opts.format || 'JSONStringsEachRowWithProgress';
  let url = origin + '?default_format=' + format + '&enable_http_compression=1';
  for (const [k, v] of Object.entries(opts.extra || {})) {
    url += '&' + k + '=' + encodeURIComponent(v);
  }
  for (const [k, v] of Object.entries(opts.params || {})) {
    url += '&' + k + '=' + encodeURIComponent(v);
  }
  return url;
}
