import { describe, it, expect } from 'vitest';
import {
  encodeLibraryQueryPayload, decodeLibraryQueryPayload,
  type LibraryQueryDragPayload,
} from '../../src/core/library-drag.js';

const payload: LibraryQueryDragPayload = { kind: 'library-query', workspaceId: 'w1', queryId: 'q1' };

describe('encodeLibraryQueryPayload / decodeLibraryQueryPayload', () => {
  it('round-trips the identity a Dashboard target re-resolves from', () => {
    expect(decodeLibraryQueryPayload(encodeLibraryQueryPayload(payload))).toEqual(payload);
  });

  it('carries nothing but the identity — no SQL, no saved query', () => {
    // The whole point of the second payload: a drop must not be able to write
    // anything it read off `dataTransfer`.
    expect(JSON.parse(encodeLibraryQueryPayload(payload))).toEqual({
      kind: 'library-query', workspaceId: 'w1', queryId: 'q1',
    });
  });

  it('rejects an absent payload — `getData` answers "" for a type that is not there', () => {
    expect(decodeLibraryQueryPayload('')).toBeNull();
    expect(decodeLibraryQueryPayload(null)).toBeNull();
    expect(decodeLibraryQueryPayload(undefined)).toBeNull();
  });

  it('rejects bytes that are not JSON at all (a drag from another application)', () => {
    expect(decodeLibraryQueryPayload('not json')).toBeNull();
    expect(decodeLibraryQueryPayload('{"unterminated":')).toBeNull();
  });

  it('rejects well-formed JSON that is not an object', () => {
    expect(decodeLibraryQueryPayload('"a string"')).toBeNull();
    expect(decodeLibraryQueryPayload('42')).toBeNull();
    expect(decodeLibraryQueryPayload('null')).toBeNull();
  });

  it('rejects a foreign payload on our MIME type — the `kind` tag is checked, not assumed', () => {
    expect(decodeLibraryQueryPayload('{"workspaceId":"w1","queryId":"q1"}')).toBeNull();
    expect(decodeLibraryQueryPayload(
      '{"kind":"schema-graph","workspaceId":"w1","queryId":"q1"}',
    )).toBeNull();
  });

  it('rejects a missing, blank, or non-string workspaceId', () => {
    expect(decodeLibraryQueryPayload('{"kind":"library-query","queryId":"q1"}')).toBeNull();
    expect(decodeLibraryQueryPayload(
      '{"kind":"library-query","workspaceId":"","queryId":"q1"}',
    )).toBeNull();
    expect(decodeLibraryQueryPayload(
      '{"kind":"library-query","workspaceId":7,"queryId":"q1"}',
    )).toBeNull();
  });

  it('rejects a missing, blank, or non-string queryId', () => {
    expect(decodeLibraryQueryPayload('{"kind":"library-query","workspaceId":"w1"}')).toBeNull();
    expect(decodeLibraryQueryPayload(
      '{"kind":"library-query","workspaceId":"w1","queryId":""}',
    )).toBeNull();
    expect(decodeLibraryQueryPayload(
      '{"kind":"library-query","workspaceId":"w1","queryId":{}}',
    )).toBeNull();
  });

  it('drops unknown extra fields rather than passing them through', () => {
    // A decoded payload is handed to a mutation command; it must be exactly the
    // three known fields whatever arrived alongside them.
    expect(decodeLibraryQueryPayload(
      '{"kind":"library-query","workspaceId":"w1","queryId":"q1","sql":"DROP TABLE t"}',
    )).toEqual(payload);
  });
});
