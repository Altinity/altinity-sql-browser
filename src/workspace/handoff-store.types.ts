// The injected persistence seam for the one-time dashboard view-mode handoff
// token (#288). A handoff record carries a portable-bundle snapshot's landing
// coordinates (the detached workspace it will materialize into) across a new
// tab's navigation — read exactly once, then gone, so the `?st=` URL is never
// bookmarkable or replayable.
//
// Exactly like `WorkspaceStore`: the consumer depends only on this narrow
// async interface, never on a concrete IndexedDB, so it is unit-testable with
// a plain in-memory fake.
//
// Type-only (ADR-0002 seam contract) — no executable statements, excluded
// from the coverage gate like every other `*.types.ts`.
export interface HandoffRecord {
  /** Opaque payload text (the caller's serialized PortableBundleV1 handoff). */
  text: string;
  /** The dashboard id the handoff is for. */
  dashboardId: string;
  /** The fresh detached workspace id the token will materialize into. */
  detachedWorkspaceId: string;
  /** Absolute epoch-ms expiry; `take` treats an expired record as absent. */
  expiresAt: number;
}

export interface HandoffStore {
  /** Write one token record (readwrite transaction). Overwrites any existing
   *  record under the same token. */
  put(token: string, record: HandoffRecord): Promise<void>;
  /** Atomically get-and-DELETE the record for `token` in ONE readwrite
   *  transaction, then resolve it only if not expired (`expiresAt > nowMs`);
   *  otherwise resolve `null`. The record is deleted whether or not it was
   *  expired, and resolves `null` when no record exists for `token`. */
  take(token: string, nowMs: number): Promise<HandoffRecord | null>;
}
