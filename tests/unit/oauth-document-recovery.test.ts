import { describe, expect, it } from 'vitest';
import {
  decodeOAuthDocumentRecovery,
  decodeOAuthDocumentRecoveryValidatedCallback,
  encodeOAuthDocumentRecovery,
  encodeOAuthDocumentRecoveryValidatedCallback,
  minimumNextTabId,
  OAUTH_DOCUMENT_RECOVERY_KEY,
  OAUTH_DOCUMENT_RECOVERY_TTL_MS,
  OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY,
  OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_TTL_MS,
  OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION,
  OAUTH_DOCUMENT_RECOVERY_VERSION,
  rebindOAuthDocumentRecovery,
} from '../../src/core/oauth-document-recovery.js';
import type {
  OAuthDocumentRecoverySnapshot,
  OAuthDocumentRecoveryValidatedCallback,
} from '../../src/core/oauth-document-recovery.js';

const createdAt = 1_700_000_000_000;

const snapshot = (over: Partial<OAuthDocumentRecoverySnapshot> = {}): OAuthDocumentRecoverySnapshot => ({
  version: OAUTH_DOCUMENT_RECOVERY_VERSION,
  createdAt,
  workspaceId: 'workspace-id',
  workspaceKey: 'workspace-key',
  oauthState: 'oauth-state',
  tabs: [{
    id: 't1', doc: { kind: 'query' }, name: 'Draft', sqlDraft: 'SELECT 1',
    specText: '{"name":', specVersion: 1, editorMode: 'spec', dirtySql: true,
    dirtySpec: true, savedId: 'saved-1', lastCommittedQueryToken: '', externalState: 'conflict',
  }],
  activeTabId: 't1',
  nextTabId: 2,
  ...over,
});

const decode = (value: unknown, now = createdAt): ReturnType<typeof decodeOAuthDocumentRecovery> =>
  decodeOAuthDocumentRecovery(typeof value === 'string' || value == null ? value : JSON.stringify(value), now);

const malformed = (mutate: (value: Record<string, unknown>) => void): void => {
  const value = JSON.parse(encodeOAuthDocumentRecovery(snapshot())) as Record<string, unknown>;
  mutate(value);
  expect(decode(value)).toEqual({ kind: 'invalid', reason: 'malformed' });
};

const validatedCallback = (
  over: Partial<OAuthDocumentRecoveryValidatedCallback> = {},
): OAuthDocumentRecoveryValidatedCallback => ({
  version: OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION,
  oauthState: 'oauth-state',
  validatedAt: createdAt,
  ...over,
});

describe('OAuth document recovery codec', () => {
  it('exports the stable storage key/version and round-trips exact authored state including invalid raw Spec', () => {
    expect(OAUTH_DOCUMENT_RECOVERY_KEY).toBe('oauth_document_recovery');
    expect(OAUTH_DOCUMENT_RECOVERY_VERSION).toBe(1);
    const result = decodeOAuthDocumentRecovery(encodeOAuthDocumentRecovery(snapshot()), createdAt);
    expect(result).toEqual({ kind: 'valid', value: snapshot() });
    expect(result.kind === 'valid' && result.value.tabs[0].specText).toBe('{"name":');
  });

  it('preserves dashboard-variable bindings and accepts their SQL-only editor policy', () => {
    const value = snapshot({
      tabs: [{
        id: 't2', doc: { kind: 'dashboard-variable', dashboardId: 'dash', variableName: 'country' },
        name: 'Variable: country', sqlDraft: 'SELECT country', specText: 'not json', specVersion: 9,
        editorMode: 'sql', dirtySql: true, dirtySpec: false, savedId: null, externalState: null,
      }],
      activeTabId: 't2', nextTabId: 3,
    });
    expect(decodeOAuthDocumentRecovery(encodeOAuthDocumentRecovery(value), createdAt)).toEqual({ kind: 'valid', value });
    const wrongMode = JSON.parse(encodeOAuthDocumentRecovery(value));
    wrongMode.tabs[0].editorMode = 'spec';
    expect(decode(wrongMode)).toEqual({ kind: 'invalid', reason: 'malformed' });
  });

  it('serializes only documented fields and omits optional fields when absent', () => {
    const value = snapshot({
      tabs: [{
        ...snapshot().tabs[0], lastCommittedQueryToken: undefined, externalState: undefined,
        result: { rows: ['never'] }, chSession: 'never', lastSuccessfulResultColumns: [{ name: 'never' }],
        specParsed: { never: true }, specDiagnostics: ['never'], running: true,
      } as unknown as OAuthDocumentRecoverySnapshot['tabs'][number]],
      transient: true,
    } as unknown as Partial<OAuthDocumentRecoverySnapshot>);
    const raw = JSON.parse(encodeOAuthDocumentRecovery(value));
    expect(Object.keys(raw)).toEqual([
      'version', 'createdAt', 'workspaceId', 'workspaceKey', 'oauthState', 'tabs', 'activeTabId', 'nextTabId',
    ]);
    expect(raw.tabs[0]).toEqual({
      id: 't1', doc: { kind: 'query' }, name: 'Draft', sqlDraft: 'SELECT 1', specText: '{"name":',
      specVersion: 1, editorMode: 'spec', dirtySql: true, dirtySpec: true, savedId: 'saved-1',
    });
  });

  it('distinguishes missing, malformed, unsupported, exact-expiry, expired, and future payloads', () => {
    expect(decodeOAuthDocumentRecovery(null, createdAt)).toEqual({ kind: 'missing' });
    expect(decodeOAuthDocumentRecovery(undefined, createdAt)).toEqual({ kind: 'missing' });
    expect(decodeOAuthDocumentRecovery('', createdAt)).toEqual({ kind: 'invalid', reason: 'malformed' });
    expect(decode({ ...snapshot(), version: 2 })).toEqual({ kind: 'invalid', reason: 'unsupported' });
    const encoded = encodeOAuthDocumentRecovery(snapshot());
    expect(decodeOAuthDocumentRecovery(encoded, createdAt + OAUTH_DOCUMENT_RECOVERY_TTL_MS)).toMatchObject({ kind: 'valid' });
    expect(decodeOAuthDocumentRecovery(encoded, createdAt + OAUTH_DOCUMENT_RECOVERY_TTL_MS + 1))
      .toEqual({ kind: 'invalid', reason: 'expired' });
    expect(decodeOAuthDocumentRecovery(encoded, createdAt - 1)).toEqual({ kind: 'invalid', reason: 'expired' });
    expect(decodeOAuthDocumentRecovery(encoded, Number.NaN)).toEqual({ kind: 'invalid', reason: 'malformed' });
  });

  it('rejects every root validator failure', () => {
    malformed((value) => { delete value.workspaceId; });
    malformed((value) => { value.extra = true; });
    malformed((value) => { value.version = '1'; });
    malformed((value) => { value.createdAt = 1.5; });
    malformed((value) => { value.workspaceId = '  '; });
    malformed((value) => { value.workspaceKey = ''; });
    malformed((value) => { value.oauthState = '\t'; });
    malformed((value) => { value.tabs = []; });
    malformed((value) => { value.activeTabId = 't01'; });
    malformed((value) => { value.nextTabId = 1.5; });
    malformed((value) => { value.nextTabId = 0; });
  });

  it('rejects every tab/document validator failure and allocation inconsistency', () => {
    const tab = (mutate: (value: Record<string, unknown>) => void) => malformed((value) => mutate(value.tabs as Record<string, unknown>));
    tab((tabs) => { (tabs[0] as Record<string, unknown>).extra = true; });
    tab((tabs) => { delete (tabs[0] as Record<string, unknown>).id; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).id = 'q1'; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).doc = []; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).doc = { kind: 'query', extra: true }; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).doc = { kind: 'dashboard-variable', dashboardId: '', variableName: 'x' }; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).name = 1; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).sqlDraft = null; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).specText = false; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).specVersion = 0; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).editorMode = 'result'; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).dirtySql = 1; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).dirtySpec = null; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).savedId = ''; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).lastCommittedQueryToken = 1; });
    tab((tabs) => { (tabs[0] as Record<string, unknown>).externalState = 'stale'; });
    malformed((value) => {
      const tabs = value.tabs as unknown[];
      value.tabs = [tabs[0], { ...(tabs[0] as object) }];
    });
    malformed((value) => { value.activeTabId = 't2'; });
    malformed((value) => { value.nextTabId = 1; });
  });

  it('computes a noncolliding next id and rejects unsafe or duplicate allocation inputs', () => {
    expect(minimumNextTabId([{ id: 't1' }, { id: 't9' }, { id: 't2' }])).toBe(10);
    expect(minimumNextTabId([])).toBe(1);
    expect(() => minimumNextTabId([{ id: 't01' }])).toThrow('Invalid recovery tab id');
    expect(() => minimumNextTabId([{ id: 't1' }, { id: 't1' }])).toThrow('Invalid recovery tab id');
    expect(() => minimumNextTabId([{ id: 't9007199254740991' }])).toThrow('unsafe');
    expect(decode({ ...snapshot(), nextTabId: 2, tabs: [{ ...snapshot().tabs[0], id: 't9007199254740992' }] }))
      .toEqual({ kind: 'invalid', reason: 'malformed' });
  });

  it('rebinds only the OAuth attempt state and timestamp without mutating authored payload', () => {
    const original = snapshot();
    const rebound = rebindOAuthDocumentRecovery(original, 'retry-state', createdAt + 12);
    expect(rebound).toEqual({ ...original, oauthState: 'retry-state', createdAt: createdAt + 12 });
    expect(original).toEqual(snapshot());
    expect(() => rebindOAuthDocumentRecovery(original, ' ', createdAt)).toThrow('Invalid OAuth recovery rebind');
    expect(() => rebindOAuthDocumentRecovery(original, 'ok', 1.5)).toThrow('Invalid OAuth recovery rebind');
  });

  it('rejects malformed values passed directly to strict encode and rebind', () => {
    expect(() => encodeOAuthDocumentRecovery({ ...snapshot(), nextTabId: 1 })).toThrow('Invalid OAuth document recovery snapshot');
    expect(() => rebindOAuthDocumentRecovery({ ...snapshot(), workspaceId: '' }, 'next', createdAt)).toThrow('malformed');
  });
});

describe('OAuth document recovery validated-callback codec', () => {
  it('exports a separate stable key/version/TTL and round-trips only callback proof fields', () => {
    expect(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)
      .toBe('oauth_document_recovery_validated_callback');
    expect(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION).toBe(1);
    expect(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_TTL_MS)
      .toBeLessThanOrEqual(OAUTH_DOCUMENT_RECOVERY_TTL_MS);
    const input = {
      ...validatedCallback(),
      sql: 'never',
      workspaceId: 'never',
      token: 'never',
      code: 'never',
    } as OAuthDocumentRecoveryValidatedCallback;
    const encoded = encodeOAuthDocumentRecoveryValidatedCallback(input);
    expect(JSON.parse(encoded)).toEqual(validatedCallback());
    expect(decodeOAuthDocumentRecoveryValidatedCallback(encoded, createdAt))
      .toEqual({ kind: 'valid', value: validatedCallback() });
  });

  it('strictly rejects malformed, unsupported, extra, expired, and future markers', () => {
    const decodeMarker = (value: unknown, now = createdAt) =>
      decodeOAuthDocumentRecoveryValidatedCallback(
        typeof value === 'string' || value == null ? value : JSON.stringify(value),
        now,
      );
    expect(decodeMarker(null)).toEqual({ kind: 'missing' });
    expect(decodeMarker(undefined)).toEqual({ kind: 'missing' });
    expect(decodeMarker('{bad')).toEqual({ kind: 'invalid', reason: 'malformed' });
    expect(decodeMarker({ ...validatedCallback(), version: 2 }))
      .toEqual({ kind: 'invalid', reason: 'unsupported' });
    for (const value of [
      { oauthState: 'oauth-state', validatedAt: createdAt },
      { ...validatedCallback(), extra: true },
      { ...validatedCallback(), version: '1' },
      { ...validatedCallback(), oauthState: ' ' },
      { ...validatedCallback(), validatedAt: 1.5 },
    ]) {
      expect(decodeMarker(value)).toEqual({ kind: 'invalid', reason: 'malformed' });
    }
    const encoded = encodeOAuthDocumentRecoveryValidatedCallback(validatedCallback());
    expect(decodeMarker(encoded, createdAt + OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_TTL_MS))
      .toMatchObject({ kind: 'valid' });
    expect(decodeMarker(
      encoded,
      createdAt + OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_TTL_MS + 1,
    )).toEqual({ kind: 'invalid', reason: 'expired' });
    expect(decodeMarker(encoded, createdAt - 1)).toEqual({ kind: 'invalid', reason: 'expired' });
    expect(decodeMarker(encoded, Number.NaN)).toEqual({ kind: 'invalid', reason: 'malformed' });
  });

  it('rejects malformed values passed directly to marker encode', () => {
    expect(() => encodeOAuthDocumentRecoveryValidatedCallback({
      ...validatedCallback(),
      oauthState: '',
    })).toThrow('Invalid OAuth document recovery validated callback');
    expect(() => encodeOAuthDocumentRecoveryValidatedCallback({
      ...validatedCallback(),
      validatedAt: 1.5,
    })).toThrow('malformed');
  });
});
