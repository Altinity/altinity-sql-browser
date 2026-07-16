// Pure helper for the credentials login path: turn a user-typed server address
// into a clean origin to POST queries at. No DOM, no globals — unit-testable.

/**
 * Resolve a host:port (or full URL) the user typed into a ClickHouse origin.
 *
 *   ''                       → currentOrigin   (blank = use the serving host)
 *   'ch.example'             → 'https://ch.example:8443'  (default scheme+port)
 *   'ch.example:9000'        → 'https://ch.example:9000'  (explicit port kept)
 *   'http://ch.example:8123' → 'http://ch.example:8123'   (explicit scheme kept)
 *
 * Defaults to HTTPS and ClickHouse's 8443 only for the bare-host case. Anything
 * unparseable falls back to currentOrigin so we never POST somewhere bogus.
 */
export function resolveTarget(hostInput: unknown, currentOrigin: string): string {
  const raw = String(hostInput || '').trim();
  if (!raw) return currentOrigin;
  // With an explicit scheme, trust it as-is; otherwise default to https and
  // append :8443 when no port was given.
  const urlStr = /^https?:\/\//i.test(raw)
    ? raw
    : 'https://' + (raw.includes(':') ? raw : raw + ':8443');
  try {
    return new URL(urlStr).origin;
  } catch {
    return currentOrigin;
  }
}
