// Canonical PortableBundleV2 parsing, validation, decoding, and encoding
// (#280 "PortableBundleV2"). Validation order matches the #280 pipeline:
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
import { dropCuratedFilters } from './dashboard-document.js';
import type {
  DashboardDocumentV1, PortableBundleV1, PortableBundleV2,
} from '../../generated/json-schema.types.js';

export const PORTABLE_BUNDLE_FORMAT = 'altinity-sql-browser/portable-bundle';
export const CURRENT_PORTABLE_BUNDLE_VERSION = 2;
/** Still compiled and registered: the codec decodes legacy v1 files with it. */
export const LEGACY_PORTABLE_BUNDLE_VERSIONS = [1] as const;
export const PORTABLE_BUNDLE_V1_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/portable-bundle-v1.schema.json';
export const PORTABLE_BUNDLE_V2_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/portable-bundle-v2.schema.json';

/** The Dashboard `documentVersion` each bundle version legitimately carries. */
const DASHBOARD_VERSION_BY_BUNDLE_VERSION: Record<1 | 2, number> = { 1: 1, 2: 2 };
const SCHEMA_ID_BY_BUNDLE_VERSION: Record<1 | 2, string> = {
  1: PORTABLE_BUNDLE_V1_SCHEMA_ID,
  2: PORTABLE_BUNDLE_V2_SCHEMA_ID,
};

/**
 * The one pure, deterministic v1 -> v2 bundle migration: every Dashboard sheds
 * its curated filters and becomes document v2. Queries are carried through
 * untouched — a query a dropped filter used as its option source is preserved, so
 * importing the bundle still brings its SQL in and the user can paste it into a
 * variable's option editor by hand.
 */
export function migratePortableBundleV1ToV2(bundle: PortableBundleV1): PortableBundleV2 {
  const { $schema: _schema, ...rest } = bundle;
  return {
    ...rest,
    $schema: PORTABLE_BUNDLE_V2_SCHEMA_ID as PortableBundleV2['$schema'],
    version: 2,
    dashboards: bundle.dashboards.map(
      (dashboard) => dropCuratedFilters(dashboard as DashboardDocumentV1),
    ),
  };
}

export type BundleFailResult = { ok: false; diagnostics: WorkspaceDiagnostic[] };

export interface BundleCodecOptions {
  validationService?: JsonSchemaValidationService;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function identifyPortableBundle(
  document: unknown, accepted: readonly number[] = [CURRENT_PORTABLE_BUNDLE_VERSION],
): WorkspaceDiagnostic[] {
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
  if (!accepted.includes(document.version as number)) {
    return [diagnostic(['version'], 'bundle-version-unsupported',
      `Unsupported portable bundle version ${document.version}`)];
  }
  return [];
}

/** Structural validation of one bundle version's own branch, at ITS OWN Dashboard
 *  document version — so a v1 file's document-v1 Dashboards are not rejected for
 *  being one version behind, before the migration that fixes them can run. */
function structuralBundleDiagnostics(
  document: unknown, bundleVersion: 1 | 2, validationService: JsonSchemaValidationService,
): WorkspaceDiagnostic[] {
  const doc = document as Record<string, unknown>;
  const queries = Array.isArray(doc.queries) ? doc.queries : [];
  const dashboards = Array.isArray(doc.dashboards) ? doc.dashboards : [];
  const versionDiagnostics = [
    ...unsupportedSpecVersionDiagnostics(queries, ['queries']),
    ...unsupportedDashboardVersionDiagnostics(dashboards, ['dashboards'],
      DASHBOARD_VERSION_BY_BUNDLE_VERSION[bundleVersion]),
  ];
  const skip = new Set(versionDiagnostics.map((item) => JSON.stringify([item.path[0], item.path[1]])));
  const structural = validationService.validate(SCHEMA_ID_BY_BUNDLE_VERSION[bundleVersion], document)
    .filter((item) => !skip.has(JSON.stringify([item.path[0], item.path[1]])));
  return [...versionDiagnostics, ...structural];
}

/** Complete deterministic validation of one parsed CURRENT (v2) portable bundle
 *  document. A legacy v1 file is validated against its own branch and migrated by
 *  `decodePortableBundleJson` before it ever reaches this. */
export function validatePortableBundleDocument(
  document: unknown, { validationService = jsonSchemaValidationService }: BundleCodecOptions = {},
): WorkspaceDiagnostic[] {
  const identity = identifyPortableBundle(document);
  if (identity.length) return sortDiagnostics(identity);
  const doc = document as Record<string, unknown>;
  const queries = Array.isArray(doc.queries) ? doc.queries : [];
  const dashboards = Array.isArray(doc.dashboards) ? doc.dashboards : [];
  const structural = structuralBundleDiagnostics(document, CURRENT_PORTABLE_BUNDLE_VERSION, validationService);
  if (structural.length) return sortDiagnostics(structural);
  return sortDiagnostics([
    ...validateQueryCollectionSemantics(queries),
    ...validateDashboardCollectionSemantics(dashboards, { queries, validationService }),
  ]);
}

export type DecodePortableBundleResult = { ok: true; value: PortableBundleV2 } | BundleFailResult;

/** Parse and fully validate untrusted portable-bundle JSON text, returning the
 *  canonical in-memory v2 shape. A v1 file is validated against its own schema at
 *  document version 1, migrated forward, and then validated as v2 — so a migration
 *  can never produce a bundle the v2 contract rejects. */
export function decodePortableBundleJson(
  text: unknown, options: BundleCodecOptions & JsonLimitOptions = {},
): DecodePortableBundleResult {
  const parsed = parseJsonWithLimits(text, options);
  if (!parsed.ok) return parsed;
  const { validationService = jsonSchemaValidationService } = options;
  const identity = identifyPortableBundle(parsed.value,
    [...LEGACY_PORTABLE_BUNDLE_VERSIONS, CURRENT_PORTABLE_BUNDLE_VERSION]);
  if (identity.length) return { ok: false, diagnostics: sortDiagnostics(identity) };
  const version = (parsed.value as Record<string, unknown>).version as 1 | 2;
  if (version === CURRENT_PORTABLE_BUNDLE_VERSION) {
    const diagnostics = validatePortableBundleDocument(parsed.value, options);
    return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: parsed.value as PortableBundleV2 };
  }
  const structural = structuralBundleDiagnostics(parsed.value, 1, validationService);
  if (structural.length) return { ok: false, diagnostics: sortDiagnostics(structural) };
  const migrated = migratePortableBundleV1ToV2(parsed.value as PortableBundleV1);
  const diagnostics = validatePortableBundleDocument(migrated, options);
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: migrated };
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
    ...(includeSchemaHint ? { $schema: PORTABLE_BUNDLE_V2_SCHEMA_ID } : {}),
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
