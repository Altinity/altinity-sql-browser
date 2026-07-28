import type { AuthenticatedCancellationLease } from '../net/ch-client.js';

export type { AuthenticatedCancellationLease } from '../net/ch-client.js';

// Per-authenticated-session coordination for cancellable work.  Operation
// owners retain their own AbortControllers and query lifecycle; this scope only
// provides the common epoch fence and invokes an injected network cancellation
// seam with the credentials that were valid when closing began.

/** Network-owned, best-effort KILL QUERY seam. */
export type CancelRemoteQuery = (
  lease: AuthenticatedCancellationLease,
  queryId: string,
) => Promise<void> | void;

/** A caller-owned unit of authenticated work. */
export interface AuthenticatedExecutionOperation {
  /** Diagnostic identity only; useful to an owner when retaining its handle. */
  readonly name: string;
  /** Must stop local work synchronously (normally AbortController.abort()). */
  abort(): void;
  /** Reads the operation's current server query id, if it has one. */
  getQueryId?(): string | null | undefined;
}

/** A registration is current only while its scope remains open and retained. */
export interface AuthenticatedExecutionRegistration {
  readonly name: string;
  release(): void;
  isCurrent(): boolean;
}

export interface AuthenticatedExecutionScope {
  readonly epoch: number;
  readonly closed: boolean;
  isOpen(): boolean;
  isCurrent(registration: AuthenticatedExecutionRegistration): boolean;
  register(operation: AuthenticatedExecutionOperation): AuthenticatedExecutionRegistration;
  /** Idempotently closes the epoch, aborting local work before remote cleanup. */
  close(lease?: AuthenticatedCancellationLease | null): void;
}

export interface AuthenticatedExecutionScopeDeps {
  /** Connection epoch this scope fences. Refresh stays within this epoch. */
  readonly epoch: number;
  readonly cancelRemote: CancelRemoteQuery;
}

interface RegisteredOperation {
  readonly id: number;
  readonly operation: AuthenticatedExecutionOperation;
}

function hasQueryId(queryId: string | null | undefined): queryId is string {
  return queryId !== null && queryId !== undefined && queryId !== '';
}

/**
 * Creates one disposable scope for a single authenticated connection epoch.
 * `close` sets the closed latch before it invokes any owner code, so an abort
 * callback that reports authentication loss or calls `close` again cannot
 * restart disposal or make stale completion code current.
 */
export function createAuthenticatedExecutionScope(
  deps: AuthenticatedExecutionScopeDeps,
): AuthenticatedExecutionScope {
  let closed = false;
  let closeLease: AuthenticatedCancellationLease | null = null;
  let nextOperationId = 0;
  const operations = new Map<number, RegisteredOperation>();
  const registrations = new Set<AuthenticatedExecutionRegistration>();

  function isCurrent(registration: AuthenticatedExecutionRegistration): boolean {
    return !closed && registrations.has(registration) && registration.isCurrent();
  }

  function cancelRemote(lease: AuthenticatedCancellationLease, queryId: string): void {
    // Both a synchronous seam failure and its eventual rejection are explicitly
    // non-fatal. Cancellation has already stopped the local owner, and neither
    // case may trigger refresh/retry/auth callbacks from this coordination layer.
    try {
      void Promise.resolve(deps.cancelRemote(lease, queryId)).catch(() => {});
    } catch { /* best-effort remote cancellation */ }
  }

  function stop(entry: RegisteredOperation, lease: AuthenticatedCancellationLease | null): void {
    // Capture before abort: several owners clear their query id while stopping.
    let queryId: string | null | undefined;
    try {
      queryId = entry.operation.getQueryId?.();
    } catch { /* an owner that cannot report its id is still locally aborted */ }

    try {
      entry.operation.abort();
    } catch { /* one faulty owner cannot prevent other session cleanup */ }

    if (lease && hasQueryId(queryId)) cancelRemote(lease, queryId);
  }

  function register(operation: AuthenticatedExecutionOperation): AuthenticatedExecutionRegistration {
    const entry: RegisteredOperation = { id: nextOperationId++, operation };
    let released = false;
    const registration: AuthenticatedExecutionRegistration = {
      name: operation.name,
      release() {
        if (released) return;
        released = true;
        operations.delete(entry.id);
        registrations.delete(registration);
      },
      isCurrent() {
        return !released && !closed && operations.get(entry.id) === entry;
      },
    };

    if (closed) {
      // A race-free caller may still finish setup just as auth is lost. It must
      // not escape cancellation merely because registration was late.
      released = true;
      stop(entry, closeLease);
    } else {
      operations.set(entry.id, entry);
      registrations.add(registration);
    }
    return registration;
  }

  function close(lease?: AuthenticatedCancellationLease | null): void {
    if (closed) return;
    // This assignment is intentionally first: owner abort callbacks may be
    // re-entrant, but can only observe an already-stale, closed scope.
    closed = true;
    // The caller obtains this just before credentials are cleared. A refresh
    // remains in the same epoch, so close—not scope construction—must retain
    // the latest credential. A foreign epoch is never authorized to clean up
    // this scope, though its local operations still need immediate abortion.
    closeLease = lease?.epoch === deps.epoch ? lease : null;
    const active = [...operations.values()];
    operations.clear();
    registrations.clear();
    for (const entry of active) stop(entry, closeLease);
  }

  return {
    epoch: deps.epoch,
    get closed() { return closed; },
    isOpen: () => !closed,
    isCurrent,
    register,
    close,
  };
}
