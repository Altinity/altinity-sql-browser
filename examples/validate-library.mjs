// Shared assertion for checked-in Library generators. Validation happens
// immediately before a generator writes output, so generated examples cannot
// drift from the canonical query.spec schema.

import { parseImportDoc } from '../src/core/saved-io.js';

export function assertValidLibraryDocument(document) {
  return parseImportDoc(JSON.stringify(document)).queries;
}
