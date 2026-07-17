// The injected persistence seam the WorkspaceRepository (Phase 2 of #280,
// issue #284) sits behind. Exactly like the fetch/crypto/storage seams: the
// repository logic depends only on this narrow async interface, never on a
// concrete IndexedDB, so it is unit-testable with a plain in-memory fake.
//
// The aggregate is ONE record — the whole StoredWorkspaceV1 serialized as its
// canonical JSON text. `write` is an atomic full-record replacement (one
// IndexedDB readwrite transaction in the real adapter), which is what gives
// the repository genuine last-commit-wins semantics: a commit can never leave
// a half-mixed aggregate, because there is no read-modify-write across two
// transactions — one `write` replaces the entire record or nothing at all.
//
// Type-only (ADR-0002 seam contract) — no executable statements, excluded from
// the coverage gate like every other `*.types.ts`.
export interface WorkspaceStore {
  /** Read the single persisted aggregate record's canonical JSON text, or
   *  `null` when no record exists. A rejected promise means the read failed
   *  (storage unavailable); it is distinct from a resolved `null` (no record),
   *  and the migration marker keys on record existence via this method. */
  read(): Promise<string | null>;
  /** Atomically replace the single aggregate record with `text` in one
   *  transaction. Rejects when persistence fails; on rejection the previously
   *  stored record is left intact. */
  write(text: string): Promise<void>;
  /** Delete the aggregate record (idempotent — clearing an absent record
   *  resolves). */
  clear(): Promise<void>;
}
