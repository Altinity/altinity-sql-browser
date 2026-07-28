// OAuth redirect recovery storage/state coordinator (#512 Phase 3). This is
// deliberately below the application shell: it knows no UI, editor, OAuth
// transport, or workspace persistence. The shell decides when to prepare a
// redirect and when a successful callback is safe to restore.

import {
  OAUTH_DOCUMENT_RECOVERY_KEY,
  OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY,
  OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION,
  OAUTH_DOCUMENT_RECOVERY_VERSION,
  decodeOAuthDocumentRecovery,
  decodeOAuthDocumentRecoveryValidatedCallback,
  encodeOAuthDocumentRecovery,
  encodeOAuthDocumentRecoveryValidatedCallback,
  rebindOAuthDocumentRecovery,
  type OAuthDocumentRecoverySnapshot,
  type OAuthDocumentRecoveryTab,
  type OAuthDocumentRecoveryValidatedCallback,
} from '../core/oauth-document-recovery.js';
import {
  newTabObj,
  reconcileLinkedTabsToLatest,
  tabSaveDirty,
  type AppState,
  type QueryTab,
  type SpecValidationService,
} from '../state.js';
import type { StoredWorkspaceV5 } from '../generated/json-schema.types.js';
import { signal } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';

/** The deliberately narrow subset of sessionStorage used by this coordinator. */
export interface OAuthDocumentRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Only document-session fields which recovery may observe or replace. */
export type OAuthDocumentRecoveryState = Pick<
  AppState,
  'tabs' | 'activeTabId' | 'nextTabId' | 'workspaceId' | 'workspaceKey'
>;

export interface OAuthDocumentRecoverySessionDeps {
  storage: OAuthDocumentRecoveryStorage;
  /** Injected rather than read from Date, so TTL behavior is deterministic. */
  now(): number;
  state: OAuthDocumentRecoveryState;
  /** Used only by linked-tab reconciliation after a successful restore. */
  specValidators: SpecValidationService;
}

export type OAuthDocumentRecoveryRestoreResult =
  | { kind: 'absent' }
  /** A callback for an earlier OAuth attempt; its payload must remain retryable. */
  | { kind: 'callback-mismatch' }
  | { kind: 'invalid-cleared'; reason: 'malformed' | 'unsupported' | 'expired' }
  /** Workspace loading is temporarily unavailable; retain the valid payload. */
  | { kind: 'workspace-unavailable-retained' }
  /** Pending callback authority could not be retired safely before publication. */
  | { kind: 'retry-deferred-retained' }
  | { kind: 'workspace-mismatch-cleared' }
  /** The snapshot deliberately remains until the shell has installed its guard. */
  | { kind: 'restored' };

export interface OAuthDocumentRecoverySession {
  /**
   * Persist a fresh dirty-session checkpoint, or bind an already-valid retained
   * checkpoint to a retry's OAuth state. Storage/serialization failures are
   * intentionally allowed to throw: ConnectionSession must then abort redirect.
   */
  prepare(oauthState: string): boolean;
  /**
   * Restore only after OAuth callback validation and workspace loading. A
   * restored payload is not consumed automatically; call consume once the
   * shell has revalidated Specs and installed the ordinary dirty-tab guard.
   */
  restore(callbackState: string, workspace: StoredWorkspaceV5 | null): OAuthDocumentRecoveryRestoreResult;
  /**
   * Retry a workspace-unavailable restore only when this session still owns
   * fresh in-memory callback authority or a strict persisted callback marker.
   * A checkpoint by itself is never authority and produces `kind: 'absent'`.
   */
  retryPending(workspace: StoredWorkspaceV5 | null): OAuthDocumentRecoveryRestoreResult;
  /** Remove the payload after the caller's post-restore work succeeded. */
  consume(): void;
  /** Explicit logout/end-session cleanup. */
  clear(): void;
}

function authoredTab(tab: QueryTab): OAuthDocumentRecoveryTab {
  return {
    id: tab.id,
    doc: tab.doc.kind === 'query'
      ? { kind: 'query' }
      : { kind: 'dashboard-variable', dashboardId: tab.doc.dashboardId, variableName: tab.doc.variableName },
    name: tab.name,
    sqlDraft: tab.sqlDraft,
    specText: tab.specText,
    specVersion: tab.specVersion,
    editorMode: tab.editorMode,
    dirtySql: tab.dirtySql,
    dirtySpec: tab.dirtySpec,
    savedId: tab.savedId,
    ...(tab.lastCommittedQueryToken === undefined ? {} : { lastCommittedQueryToken: tab.lastCommittedQueryToken }),
    ...(tab.externalState === undefined ? {} : { externalState: tab.externalState }),
  };
}

function freshTab(tab: OAuthDocumentRecoveryTab): QueryTab {
  // Start from the application's single canonical constructor. In particular,
  // this keeps result/chSession/column metadata and Spec diagnostics transient.
  const restored = newTabObj(tab.id);
  restored.doc = tab.doc.kind === 'query'
    ? { kind: 'query' }
    : { kind: 'dashboard-variable', dashboardId: tab.doc.dashboardId, variableName: tab.doc.variableName };
  restored.name = tab.name;
  restored.sqlDraft = tab.sqlDraft;
  restored.specText = tab.specText;
  restored.specVersion = tab.specVersion;
  restored.editorMode = tab.editorMode;
  restored.dirtySql = tab.dirtySql;
  restored.dirtySpec = tab.dirtySpec;
  restored.savedId = tab.savedId;
  if (tab.lastCommittedQueryToken !== undefined) {
    restored.lastCommittedQueryToken = tab.lastCommittedQueryToken;
  }
  if (tab.externalState !== undefined) restored.externalState = tab.externalState;
  return restored;
}

function snapshotFor(state: OAuthDocumentRecoveryState, oauthState: string, createdAt: number): OAuthDocumentRecoverySnapshot {
  return {
    version: OAUTH_DOCUMENT_RECOVERY_VERSION,
    createdAt,
    workspaceId: state.workspaceId,
    workspaceKey: state.workspaceKey,
    oauthState,
    tabs: state.tabs.value.map(authoredTab),
    activeTabId: state.activeTabId.value,
    nextTabId: state.nextTabId,
  };
}

/** Construct a storage-backed OAuth document recovery transaction. */
export function createOAuthDocumentRecoverySession(
  deps: OAuthDocumentRecoverySessionDeps,
): OAuthDocumentRecoverySession {
  let pendingValidatedCallback: OAuthDocumentRecoveryValidatedCallback | null = null;
  type PendingCallbackLookup =
    | { kind: 'absent' }
    | { kind: 'available'; value: OAuthDocumentRecoveryValidatedCallback }
    | { kind: 'deferred' };

  const clearPendingBestEffort = (): void => {
    pendingValidatedCallback = null;
    try {
      deps.storage.removeItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY);
    } catch {
      // An orphan marker has no authority without a matching, valid checkpoint.
      // Automatic result cleanup must not turn a published restore into a throw.
    }
  };

  const rememberValidatedCallback = (oauthState: string, validatedAt: number): void => {
    const marker: OAuthDocumentRecoveryValidatedCallback = {
      version: OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION,
      oauthState,
      validatedAt,
    };
    pendingValidatedCallback = marker;
    try {
      deps.storage.setItem(
        OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY,
        encodeOAuthDocumentRecoveryValidatedCallback(marker),
      );
    } catch {
      // Same-tab retry still has the in-memory authority. Persistence is
      // best-effort because a completed sign-in must not become a failed one.
    }
  };

  const pendingCallback = (now: number): PendingCallbackLookup => {
    if (pendingValidatedCallback !== null) {
      const decoded = decodeOAuthDocumentRecoveryValidatedCallback(
        encodeOAuthDocumentRecoveryValidatedCallback(pendingValidatedCallback),
        now,
      );
      if (decoded.kind === 'valid') return { kind: 'available', value: decoded.value };
      clearPendingBestEffort();
      return { kind: 'absent' };
    }
    let serialized: string | null;
    try {
      serialized = deps.storage.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY);
    } catch {
      // Without a trustworthy read, a checkpoint must never bootstrap its own
      // authority. Keep all document state untouched for a later retry.
      return { kind: 'deferred' };
    }
    const decoded = decodeOAuthDocumentRecoveryValidatedCallback(serialized, now);
    if (decoded.kind === 'valid') {
      return { kind: 'available', value: decoded.value };
    }
    if (decoded.kind === 'invalid') clearPendingBestEffort();
    return { kind: 'absent' };
  };

  const retirePendingBeforePublish = (
    marker: OAuthDocumentRecoveryValidatedCallback,
  ): boolean => {
    // Retire memory first, then prove persisted authority is absent. If either
    // the presence read, removal, or verification read fails, restore memory
    // and leave the checkpoint/private candidate untouched for a later retry.
    pendingValidatedCallback = null;
    try {
      const persisted = deps.storage.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY);
      if (persisted !== null) {
        deps.storage.removeItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY);
      }
      if (deps.storage.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY) !== null) {
        pendingValidatedCallback = marker;
        return false;
      }
      return true;
    } catch {
      pendingValidatedCallback = marker;
      return false;
    }
  };

  const consume = (): void => {
    // Order is deliberate: if checkpoint removal fails, its callback authority
    // remains available too. A marker orphaned by the second removal failing is
    // harmless and is pruned when retryPending observes the absent checkpoint.
    deps.storage.removeItem(OAUTH_DOCUMENT_RECOVERY_KEY);
    pendingValidatedCallback = null;
    deps.storage.removeItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY);
  };

  const clear = (): void => {
    pendingValidatedCallback = null;
    let failed = false;
    let primaryError: unknown;
    try {
      deps.storage.removeItem(OAUTH_DOCUMENT_RECOVERY_KEY);
    } catch (error) {
      failed = true;
      primaryError = error;
    }
    try {
      deps.storage.removeItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY);
    } catch (error) {
      if (!failed) {
        failed = true;
        primaryError = error;
      }
    }
    if (failed) throw primaryError;
  };

  const invalidatePendingAfterWrite = (): void => {
    pendingValidatedCallback = null;
    // Unlike result cleanup, failure is visible here: ConnectionSession must
    // abort redirect if it cannot invalidate authority for an older callback.
    deps.storage.removeItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY);
  };

  function prepare(oauthState: string): boolean {
    const now = deps.now();
    if (deps.state.tabs.value.some(tabSaveDirty)) {
      // Encode before replacing storage. If encoding throws, an earlier retry
      // payload stays intact and navigation is not allowed to continue.
      deps.storage.setItem(
        OAUTH_DOCUMENT_RECOVERY_KEY,
        encodeOAuthDocumentRecovery(snapshotFor(deps.state, oauthState, now)),
      );
      invalidatePendingAfterWrite();
      return true;
    }

    const decoded = decodeOAuthDocumentRecovery(deps.storage.getItem(OAUTH_DOCUMENT_RECOVERY_KEY), now);
    if (decoded.kind === 'missing') return false;
    if (decoded.kind === 'invalid') {
      clear();
      return false;
    }
    // Retrying a failed callback preserves every authored field; only the
    // attempt binding and freshness timestamp change.
    deps.storage.setItem(
      OAUTH_DOCUMENT_RECOVERY_KEY,
      encodeOAuthDocumentRecovery(rebindOAuthDocumentRecovery(decoded.value, oauthState, now)),
    );
    invalidatePendingAfterWrite();
    return true;
  }

  function restoreCheckpoint(
    callbackState: string,
    workspace: StoredWorkspaceV5 | null,
    now: number,
    beforePublish?: () => boolean,
  ): OAuthDocumentRecoveryRestoreResult {
    let serialized: string | null;
    try {
      serialized = deps.storage.getItem(OAUTH_DOCUMENT_RECOVERY_KEY);
    } catch {
      // Checkpoint access is pre-publication work. A fresh validated callback
      // must retain authority so storage recovery can be retried safely.
      return { kind: 'retry-deferred-retained' };
    }
    const decoded = decodeOAuthDocumentRecovery(serialized, now);
    if (decoded.kind === 'missing') return { kind: 'absent' };
    if (decoded.kind === 'invalid') {
      deps.storage.removeItem(OAUTH_DOCUMENT_RECOVERY_KEY);
      return { kind: 'invalid-cleared', reason: decoded.reason };
    }
    if (decoded.value.oauthState !== callbackState) return { kind: 'callback-mismatch' };
    if (workspace === null) return { kind: 'workspace-unavailable-retained' };
    if (decoded.value.workspaceId !== workspace.id
      || decoded.value.workspaceKey !== workspace.key) {
      deps.storage.removeItem(OAUTH_DOCUMENT_RECOVERY_KEY);
      return { kind: 'workspace-mismatch-cleared' };
    }

    let candidate: Signal<QueryTab[]>;
    try {
      // Build every tab before touching live state. A strict decode has already
      // proven ids/order/allocation valid; this step intentionally does not parse
      // Spec text, so invalid in-progress JSON survives byte-for-byte for the
      // document session to revalidate before first render.
      const tabs = decoded.value.tabs.map(freshTab);

      // Run reconciliation against a private signal first. Besides keeping the
      // restore transaction atomic, this means an injected validator failure
      // cannot publish a partly restored document session. Its tab objects are
      // exactly the ones published below; reconciliation never writes workspace.
      candidate = signal(tabs);
      reconcileLinkedTabsToLatest({ tabs: candidate }, workspace, deps.specValidators);
    } catch {
      // Candidate construction/reconciliation is pre-publication work. Keep the
      // checkpoint and callback authority retryable rather than leaking a raw
      // validator/constructor exception through bootstrap.
      return { kind: 'retry-deferred-retained' };
    }
    if (beforePublish && !beforePublish()) return { kind: 'retry-deferred-retained' };

    // Publish the three coordinated document-session fields only after every
    // tab has been built and reconciliation has succeeded.
    deps.state.tabs.value = candidate.value;
    deps.state.activeTabId.value = decoded.value.activeTabId;
    deps.state.nextTabId = decoded.value.nextTabId;
    return { kind: 'restored' };
  }

  function restore(
    callbackState: string,
    workspace: StoredWorkspaceV5 | null,
  ): OAuthDocumentRecoveryRestoreResult {
    const now = deps.now();
    const result = restoreCheckpoint(callbackState, workspace, now);
    if (result.kind === 'workspace-unavailable-retained'
      || result.kind === 'retry-deferred-retained') {
      rememberValidatedCallback(callbackState, now);
    } else {
      // A fresh validated callback supersedes any earlier pending authority.
      // Publication, absence, invalidity, and proven mismatch are all terminal.
      clearPendingBestEffort();
    }
    return result;
  }

  function retryPending(
    workspace: StoredWorkspaceV5 | null,
  ): OAuthDocumentRecoveryRestoreResult {
    const now = deps.now();
    const pending = pendingCallback(now);
    if (pending.kind === 'absent') return { kind: 'absent' };
    if (pending.kind === 'deferred') return { kind: 'retry-deferred-retained' };
    // Never let an automatic retry replace save-relevant work authored in RAM
    // after the callback was deferred. This gate precedes checkpoint access,
    // candidate construction, reconciliation, and authority retirement.
    if (deps.state.tabs.value.some(tabSaveDirty)) {
      return { kind: 'retry-deferred-retained' };
    }
    const marker = pending.value;
    const result = restoreCheckpoint(
      marker.oauthState,
      workspace,
      now,
      () => retirePendingBeforePublish(marker),
    );
    if (result.kind !== 'workspace-unavailable-retained'
      && result.kind !== 'retry-deferred-retained'
      && result.kind !== 'restored') {
      clearPendingBestEffort();
    }
    return result;
  }

  return { prepare, restore, retryPending, consume, clear };
}
