// Pure helpers for the one-time cross-tab auth handoff (#149 D1). No DOM.
//
// "Open as dashboard" opens a new same-origin tab whose sessionStorage starts
// empty. Rather than force a second sign-in, the opener grants its live
// credentials once via postMessage: the child requests them, the opener replies
// with a snapshot of its auth session keys, and the child restores them into its
// own (per-tab) sessionStorage. Everything here is pure — the postMessage wiring
// + origin/source checks live in the app controller (over injected window seams);
// these are the message contract, the key set, and the origin/source predicates,
// kept here so they are trivially 100% testable.

/** A sessionStorage-like object: only the two methods this module uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A snapshot of the present auth keys (only those that were set). */
export type AuthSnapshot = Partial<Record<string, string>>;

/** The sessionStorage keys that carry a live auth session (OAuth or basic). */
export const AUTH_SS_KEYS: string[] = [
  'oauth_id_token', 'oauth_refresh_token', 'oauth_idp', 'oauth_origin',
  'ch_basic_auth', 'ch_basic_user', 'ch_basic_origin',
];

/** postMessage `data.type` values for the handoff handshake. */
export const AUTH_REQUEST = 'asb-auth-request';
export const AUTH_GRANT = 'asb-auth-grant';

/** Read the present auth keys out of a sessionStorage-like object. */
export function snapshotAuth(ss: StorageLike): AuthSnapshot {
  const snap: AuthSnapshot = {};
  for (const k of AUTH_SS_KEYS) {
    const v = ss.getItem(k);
    if (v != null) snap[k] = v;
  }
  return snap;
}

/** Write a snapshot's auth keys into a sessionStorage-like object. */
export function restoreAuth(ss: StorageLike, snap: AuthSnapshot | null | undefined): void {
  for (const k of AUTH_SS_KEYS) {
    if (snap && snap[k] != null) ss.setItem(k, snap[k]);
  }
}

/** Does a snapshot carry usable credentials (an OAuth token or basic creds)? */
export function hasAuth(snap: AuthSnapshot | null | undefined): boolean {
  return !!(snap && (snap.oauth_id_token || snap.ch_basic_auth));
}

/** The subset of a MessageEvent this module's predicates read. */
export interface AuthMessageEvent {
  origin: string;
  source: unknown;
  data?: { type?: string } | null;
}

/** A well-formed credential *request* from the expected origin + source window. */
export function isAuthRequest(e: AuthMessageEvent | null | undefined, origin: string, source: unknown): boolean {
  return !!e && e.origin === origin && e.source === source
    && !!e.data && e.data.type === AUTH_REQUEST;
}

/** A well-formed credential *grant* from the expected origin + source window. */
export function isAuthGrant(e: AuthMessageEvent | null | undefined, origin: string, source: unknown): boolean {
  return !!e && e.origin === origin && e.source === source
    && !!e.data && e.data.type === AUTH_GRANT;
}
