// Canonical PortableBundleV1 parsing, validation, decoding, and encoding
// (#280 "PortableBundleV1"). Validation order matches the #280 pipeline:
// codec resource guards (bytes/depth) → format/version identification (fail
// closed with one precise diagnostic) → structural schema validation →
// whole-bundle cross-resource semantics → sorted diagnostics. Encoding uses
// the one canonical encoder and re-checks the normalized serialized size.
// Pure: the compiled validation service is injected with a generated default.

import { PORTABLE_LIMITS } from './portable-limits.js';
import { parseJsonWithLimits, utf8ByteLength } from './json-limits.js';
import type { JsonLimitOptions } from './json-limits.js';
import { canonicalJson, PORTABLE_BUNDLE_SHAPE } from './canonical-json.js';
import { diagnostic, sortDiagnostics } from './workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from './workspace-diagnostics.js';
import {
  unsupportedDashboardVersionDiagnostics,
  unsupportedSpecVersionDiagnostics,
  validateDashboardCollectionSemantics,
  validateQueryCollectionSemantics,
} from './workspace-semantics.js';
import { jsonSchemaValidationService } from '../../core/library-codec.js';
import type { JsonSchemaValidationService } from '../../core/json-schema-validation.js';
import type { PortableBundleV1 } from '../../generated/json-schema.types.js';

export const PORTABLE_BUNDLE_FORMAT = 'altinity-sql-browser/portable-bundle';
export const CURRENT_PORTABLE_BUNDLE_VERSION = 1;
export const PORTABLE_BUNDLE_V1_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/portable-bundle-v1.schema.json';

export type BundleFailResult = { ok: false; diagnostics: WorkspaceDiagnostic[] };

export interface BundleCodecOptions {
  validationService?: JsonSchemaValidationService;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function identifyPortableBundle(document: unknown): WorkspaceDiagnostic[] {
  if (!isObject(document)) return [diagnostic([], 'bundle-invalid-root', 'Unrecognized file format')];
  if (document.format !== PORTABLE_BUNDLE_FORMAT) {
    return [diagnostic(['format'], 'bundle-invalid-format', 'Unrecognized file format')];
  }
  if (!Object.hasOwn(document, 'version')) {
    return [diagnostic(['version'], 'bundle-version-missing', 'Missing portable bundle version')];
  }
  if (!Number.isInteger(document.version)) {
    return [diagnostic(['version'], 'bundle-version-invalid', 'Invalid portable bundle version')];
  }
  if (document.version !== CURRENT_PORTABLE_BUNDLE_VERSION) {
    return [diagnostic(['version'], 'bundle-version-unsupported',
      `Unsupported portable bundle version ${document.version}`)];
  }
  return [];
}

/** Complete deterministic validation of one parsed portable bundle document. */
export function validatePortableBundleDocument(
  document: unknown, { validationService = jsonSchemaValidationService }: BundleCodecOptions = {},
): WorkspaceDiagnostic[] {
  const identity = identifyPortableBundle(document);
  if (identity.length) return sortDiagnostics(identity);
  const doc = document as Record<string, unknown>;
  const queries = Array.isArray(doc.queries) ? doc.queries : [];
  const dashboards = Array.isArray(doc.dashboards) ? doc.dashboards : [];
  const versionDiagnostics = [
    ...unsupportedSpecVersionDiagnostics(queries, ['queries']),
    ...unsupportedDashboardVersionDiagnostics(dashboards, ['dashboards']),
  ];
  const skip = new Set(versionDiagnostics.map((item) => JSON.stringify([item.path[0], item.path[1]])));
  const structural = validationService.validate(PORTABLE_BUNDLE_V1_SCHEMA_ID, document)
    .filter((item) => !skip.has(JSON.stringify([item.path[0], item.path[1]])));
  if (versionDiagnostics.length || structural.length) {
    return sortDiagnostics([...versionDiagnostics, ...structural]);
  }
  return sortDiagnostics([
    ...validateQueryCollectionSemantics(queries),
    ...validateDashboardCollectionSemantics(dashboards, { queries, validationService }),
  ]);
}

export type DecodePortableBundleResult = { ok: true; value: PortableBundleV1 } | BundleFailResult;

/** Parse and fully validate untrusted portable-bundle JSON text. */
export function decodePortableBundleJson(
  text: unknown, options: BundleCodecOptions & JsonLimitOptions = {},
): DecodePortableBundleResult {
  const parsed = parseJsonWithLimits(text, options);
  if (!parsed.ok) return parsed;
  const diagnostics = validatePortableBundleDocument(parsed.value, options);
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, value: parsed.value as PortableBundleV1 };
}

export interface EncodePortableBundleInput {
  queries: unknown;
  dashboards: unknown;
  metadata?: unknown;
  nowISO?: string;
  includeSchemaHint?: boolean;
}

export type EncodePortableBundleResult = { ok: true; value: string } | BundleFailResult;

/** Build, validate, and canonically encode one portable bundle. Callers own
 *  resource arrangement (bundle-order.ts); arrays are encoded in the given
 *  semantic order. Export never mutates workspace identity or revision. */
export function encodePortableBundleJson({
  queries, dashboards, metadata, nowISO, includeSchemaHint = true,
}: EncodePortableBundleInput, options: BundleCodecOptions = {}): EncodePortableBundleResult {
  if (!Array.isArray(queries)) {
    return { ok: false, diagnostics: [diagnostic(['queries'], 'schema-invalid-type', 'queries must be array')] };
  }
  if (!Array.isArray(dashboards)) {
    return { ok: false, diagnostics: [diagnostic(['dashboards'], 'schema-invalid-type', 'dashboards must be array')] };
  }
  if (typeof nowISO !== 'string' || !nowISO) {
    return { ok: false, diagnostics: [diagnostic(['exportedAt'], 'schema-required', 'exportedAt is required for new exports')] };
  }
  const document: Record<string, unknown> = {
    ...(includeSchemaHint ? { $schema: PORTABLE_BUNDLE_V1_SCHEMA_ID } : {}),
    format: PORTABLE_BUNDLE_FORMAT,
    version: CURRENT_PORTABLE_BUNDLE_VERSION,
    exportedAt: nowISO,
    ...(metadata === undefined ? {} : { metadata }),
    queries,
    dashboards,
  };
  const diagnostics = validatePortableBundleDocument(document, options);
  if (diagnostics.length) return { ok: false, diagnostics };
  const encoded = canonicalJson(document, PORTABLE_BUNDLE_SHAPE);
  const bytes = utf8ByteLength(encoded);
  if (bytes > PORTABLE_LIMITS.maxDecodedJsonBytes) {
    return {
      ok: false,
      diagnostics: [diagnostic([], 'limit-json-bytes',
        `Encoded document is ${bytes} UTF-8 bytes; the maximum is ${PORTABLE_LIMITS.maxDecodedJsonBytes}`)],
    };
  }
  return { ok: true, value: encoded };
}
