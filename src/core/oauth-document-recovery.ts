// Versioned, storage-agnostic OAuth redirect recovery wire codec (#512).
// This module deliberately knows nothing about AppState, storage, or OAuth
// transport. Callers provide the serialized value and their notion of `now`.

export const OAUTH_DOCUMENT_RECOVERY_KEY = 'oauth_document_recovery';
export const OAUTH_DOCUMENT_RECOVERY_VERSION = 1;
export const OAUTH_DOCUMENT_RECOVERY_TTL_MS = 15 * 60 * 1000;
export const OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY =
  'oauth_document_recovery_validated_callback';
export const OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION = 1;
export const OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_TTL_MS =
  OAUTH_DOCUMENT_RECOVERY_TTL_MS;

export type OAuthDocumentRecoveryDocument =
  | { kind: 'query' }
  | { kind: 'dashboard-variable'; dashboardId: string; variableName: string };

/** The intentionally authored-only wire subset of a QueryTab. */
export interface OAuthDocumentRecoveryTab {
  id: string;
  doc: OAuthDocumentRecoveryDocument;
  name: string;
  sqlDraft: string;
  specText: string;
  specVersion: number;
  editorMode: 'sql' | 'spec';
  dirtySql: boolean;
  dirtySpec: boolean;
  savedId: string | null;
  lastCommittedQueryToken?: string;
  externalState?: 'conflict' | 'deleted' | null;
}

export interface OAuthDocumentRecoverySnapshot {
  version: typeof OAUTH_DOCUMENT_RECOVERY_VERSION;
  createdAt: number;
  workspaceId: string;
  workspaceKey: string;
  oauthState: string;
  tabs: OAuthDocumentRecoveryTab[];
  activeTabId: string;
  nextTabId: number;
}

/**
 * Proof that this tab completed one exact OAuth callback whose checkpoint could
 * not yet be workspace-bound. It intentionally carries no authored content,
 * workspace identity, credential, authorization code, or PKCE material.
 */
export interface OAuthDocumentRecoveryValidatedCallback {
  version: typeof OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION;
  oauthState: string;
  validatedAt: number;
}

export type OAuthDocumentRecoveryInvalidReason = 'malformed' | 'unsupported' | 'expired';

export type OAuthDocumentRecoveryDecodeResult =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: OAuthDocumentRecoveryInvalidReason }
  | { kind: 'valid'; value: OAuthDocumentRecoverySnapshot };

export type OAuthDocumentRecoveryValidatedCallbackDecodeResult =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: OAuthDocumentRecoveryInvalidReason }
  | { kind: 'valid'; value: OAuthDocumentRecoveryValidatedCallback };

type ShapeResult =
  | { kind: 'invalid'; reason: 'malformed' | 'unsupported' }
  | { kind: 'valid'; value: OAuthDocumentRecoverySnapshot };

type ValidatedCallbackShapeResult =
  | { kind: 'invalid'; reason: 'malformed' | 'unsupported' }
  | { kind: 'valid'; value: OAuthDocumentRecoveryValidatedCallback };

const ROOT_KEYS = [
  'version', 'createdAt', 'workspaceId', 'workspaceKey', 'oauthState', 'tabs', 'activeTabId', 'nextTabId',
];
const VALIDATED_CALLBACK_KEYS = ['version', 'oauthState', 'validatedAt'];
const TAB_KEYS = [
  'id', 'doc', 'name', 'sqlDraft', 'specText', 'specVersion', 'editorMode', 'dirtySql', 'dirtySpec', 'savedId',
];
const OPTIONAL_TAB_KEYS = ['lastCommittedQueryToken', 'externalState'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const has = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const finiteInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = [], strict = true): boolean {
  if (!required.every((key) => has(value, key))) return false;
  return !strict || Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

/** A canonical tab id that can safely participate in numeric id allocation. */
function tabOrdinal(id: unknown): number | null {
  if (typeof id !== 'string' || !/^t[1-9]\d*$/.test(id)) return null;
  const ordinal = Number(id.slice(1));
  return Number.isSafeInteger(ordinal) ? ordinal : null;
}

function validDocument(value: unknown, strict = true): value is OAuthDocumentRecoveryDocument {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'query') return exactKeys(value, ['kind'], [], strict);
  return value.kind === 'dashboard-variable'
    && exactKeys(value, ['kind', 'dashboardId', 'variableName'], [], strict)
    && nonBlank(value.dashboardId)
    && nonBlank(value.variableName);
}

function validTab(value: unknown, strict = true): value is OAuthDocumentRecoveryTab {
  if (!isRecord(value) || !exactKeys(value, TAB_KEYS, OPTIONAL_TAB_KEYS, strict)) return false;
  if (tabOrdinal(value.id) === null || !validDocument(value.doc, strict)
    || typeof value.name !== 'string' || typeof value.sqlDraft !== 'string' || typeof value.specText !== 'string'
    || !finiteInteger(value.specVersion) || value.specVersion < 1
    || (value.editorMode !== 'sql' && value.editorMode !== 'spec')
    || typeof value.dirtySql !== 'boolean' || typeof value.dirtySpec !== 'boolean'
    || (value.savedId !== null && !nonBlank(value.savedId))) return false;
  if (value.doc.kind === 'dashboard-variable' && value.editorMode !== 'sql') return false;
  if (has(value, 'lastCommittedQueryToken') && value.lastCommittedQueryToken !== undefined
    && typeof value.lastCommittedQueryToken !== 'string') return false;
  return !has(value, 'externalState') || (!strict && value.externalState === undefined)
    || value.externalState === null || value.externalState === 'conflict' || value.externalState === 'deleted';
}

function readShape(value: unknown, strict = true): ShapeResult {
  if (!isRecord(value) || !exactKeys(value, ROOT_KEYS, [], strict)) return { kind: 'invalid', reason: 'malformed' };
  if (!finiteInteger(value.version)) return { kind: 'invalid', reason: 'malformed' };
  if (value.version !== OAUTH_DOCUMENT_RECOVERY_VERSION) return { kind: 'invalid', reason: 'unsupported' };
  const { createdAt, workspaceId, workspaceKey, oauthState, tabs, activeTabId, nextTabId } = value;
  if (!finiteInteger(createdAt) || !nonBlank(workspaceId) || !nonBlank(workspaceKey)
    || !nonBlank(oauthState) || !Array.isArray(tabs) || tabs.length === 0
    || !nonBlank(activeTabId) || tabOrdinal(activeTabId) === null
    || !finiteInteger(nextTabId) || !Number.isSafeInteger(nextTabId) || nextTabId < 1) {
    return { kind: 'invalid', reason: 'malformed' };
  }
  if (!tabs.every((tab) => validTab(tab, strict))) return { kind: 'invalid', reason: 'malformed' };
  const recoveredTabs = tabs as OAuthDocumentRecoveryTab[];
  const ids = new Set<string>();
  let maxTabId = 0;
  for (const tab of recoveredTabs) {
    const ordinal = tabOrdinal(tab.id);
    // validTab already established this; retaining the guard makes the invariant
    // local if the validator changes later.
    if (ordinal === null || ids.has(tab.id)) return { kind: 'invalid', reason: 'malformed' };
    ids.add(tab.id);
    maxTabId = Math.max(maxTabId, ordinal);
  }
  if (!ids.has(activeTabId) || nextTabId <= maxTabId) {
    return { kind: 'invalid', reason: 'malformed' };
  }
  return {
    kind: 'valid',
    value: {
      version: OAUTH_DOCUMENT_RECOVERY_VERSION, createdAt, workspaceId, workspaceKey, oauthState,
      tabs: recoveredTabs, activeTabId, nextTabId,
    },
  };
}

function readValidatedCallbackShape(
  value: unknown,
  strict = true,
): ValidatedCallbackShapeResult {
  if (!isRecord(value) || !exactKeys(value, VALIDATED_CALLBACK_KEYS, [], strict)) {
    return { kind: 'invalid', reason: 'malformed' };
  }
  if (!finiteInteger(value.version)) return { kind: 'invalid', reason: 'malformed' };
  if (value.version !== OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION) {
    return { kind: 'invalid', reason: 'unsupported' };
  }
  if (!nonBlank(value.oauthState) || !finiteInteger(value.validatedAt)) {
    return { kind: 'invalid', reason: 'malformed' };
  }
  return {
    kind: 'valid',
    value: {
      version: OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION,
      oauthState: value.oauthState,
      validatedAt: value.validatedAt,
    },
  };
}

/**
 * The smallest allocation cursor that cannot collide with the supplied tabs.
 * Invalid, duplicate, or numerically unsafe ids are programmer errors here;
 * untrusted payloads should use decodeOAuthDocumentRecovery instead.
 */
export function minimumNextTabId(tabs: readonly Pick<OAuthDocumentRecoveryTab, 'id'>[]): number {
  const ids = new Set<string>();
  let maxTabId = 0;
  for (const tab of tabs) {
    const ordinal = tabOrdinal(tab?.id);
    if (ordinal === null || ids.has(tab.id)) throw new TypeError('Invalid recovery tab id');
    ids.add(tab.id);
    maxTabId = Math.max(maxTabId, ordinal);
  }
  if (maxTabId >= Number.MAX_SAFE_INTEGER) throw new RangeError('Recovery tab id allocation is unsafe');
  return maxTabId + 1;
}

function assertShape(value: unknown): OAuthDocumentRecoverySnapshot {
  const result = readShape(value, false);
  if (result.kind !== 'valid') throw new TypeError(`Invalid OAuth document recovery snapshot: ${result.reason}`);
  return result.value;
}

function assertValidatedCallbackShape(
  value: unknown,
): OAuthDocumentRecoveryValidatedCallback {
  const result = readValidatedCallbackShape(value, false);
  if (result.kind !== 'valid') {
    throw new TypeError(`Invalid OAuth document recovery validated callback: ${result.reason}`);
  }
  return result.value;
}

function canonicalSnapshot(value: OAuthDocumentRecoverySnapshot): OAuthDocumentRecoverySnapshot {
  return {
    version: value.version,
    createdAt: value.createdAt,
    workspaceId: value.workspaceId,
    workspaceKey: value.workspaceKey,
    oauthState: value.oauthState,
    tabs: value.tabs.map((tab) => ({
      id: tab.id,
      doc: tab.doc.kind === 'query'
        ? { kind: 'query' as const }
        : { kind: 'dashboard-variable' as const, dashboardId: tab.doc.dashboardId, variableName: tab.doc.variableName },
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
    })),
    activeTabId: value.activeTabId,
    nextTabId: value.nextTabId,
  };
}

/** Serialize only the documented authored-state wire fields. */
export function encodeOAuthDocumentRecovery(snapshot: OAuthDocumentRecoverySnapshot): string {
  return JSON.stringify(canonicalSnapshot(assertShape(snapshot)));
}

/** Decode a sessionStorage value without accessing storage or the clock itself. */
export function decodeOAuthDocumentRecovery(
  serialized: string | null | undefined,
  now: number,
): OAuthDocumentRecoveryDecodeResult {
  if (serialized === null || serialized === undefined) return { kind: 'missing' };
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { return { kind: 'invalid', reason: 'malformed' }; }
  const shape = readShape(parsed);
  if (shape.kind !== 'valid') return shape;
  if (!finiteInteger(now)) return { kind: 'invalid', reason: 'malformed' };
  if (shape.value.createdAt > now || now - shape.value.createdAt > OAUTH_DOCUMENT_RECOVERY_TTL_MS) {
    return { kind: 'invalid', reason: 'expired' };
  }
  return shape;
}

/** Serialize only the callback proof's version, OAuth state, and validation time. */
export function encodeOAuthDocumentRecoveryValidatedCallback(
  marker: OAuthDocumentRecoveryValidatedCallback,
): string {
  const value = assertValidatedCallbackShape(marker);
  return JSON.stringify({
    version: value.version,
    oauthState: value.oauthState,
    validatedAt: value.validatedAt,
  });
}

/**
 * Strictly decode a same-tab callback proof. Its independent TTL never extends
 * the checkpoint TTL; retry callers must validate both records.
 */
export function decodeOAuthDocumentRecoveryValidatedCallback(
  serialized: string | null | undefined,
  now: number,
): OAuthDocumentRecoveryValidatedCallbackDecodeResult {
  if (serialized === null || serialized === undefined) return { kind: 'missing' };
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { return { kind: 'invalid', reason: 'malformed' }; }
  const shape = readValidatedCallbackShape(parsed);
  if (shape.kind !== 'valid') return shape;
  if (!finiteInteger(now)) return { kind: 'invalid', reason: 'malformed' };
  if (shape.value.validatedAt > now
    || now - shape.value.validatedAt > OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_TTL_MS) {
    return { kind: 'invalid', reason: 'expired' };
  }
  return shape;
}

/** Reuse authored payload across an OAuth retry, changing only its attempt binding. */
export function rebindOAuthDocumentRecovery(
  snapshot: OAuthDocumentRecoverySnapshot,
  oauthState: string,
  createdAt: number,
): OAuthDocumentRecoverySnapshot {
  const value = assertShape(snapshot);
  if (!nonBlank(oauthState) || !finiteInteger(createdAt)) throw new TypeError('Invalid OAuth recovery rebind');
  return { ...canonicalSnapshot(value), oauthState, createdAt };
}
