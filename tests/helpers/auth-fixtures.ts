// Shared auth test fixtures (#276 Phase 2). `jwt()` and `memStorage()` were
// being hand-copied per spec file (app.test.ts / dashboard.test.ts still carry
// their own older embedded variants — consolidate them here opportunistically
// when those files are next touched); new specs import from here instead of
// adding another copy.

/** A valid-looking JWT (base64url header.payload.sig). `decodeJwtPayload`
 *  only ever reads segment [1]; the signature is never verified client-side. */
export function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown): string => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b({ alg: 'RS256' })}.${b(payload)}.sig`;
}

/** A Map-backed sessionStorage fake — the three methods the auth code uses,
 *  plus the backing `_map` for direct assertions. Structurally satisfies
 *  `connection-session.ts`'s `SessionStorageLike` (and the narrower
 *  `core/auth-handoff.js` `StorageLike`). */
export interface MemStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  _map: Map<string, string>;
}

export function memStorage(initial: Record<string, string> = {}): MemStorage {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}
