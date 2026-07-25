// StoredWorkspaceV3 contract codec, V2→V3 migration, and whole-workspace
// validation (#280 "Internal persistence", phase 1 of #283; the Dashboard
// COLLECTION lands in #424). The atomic WorkspaceRepository itself is Phase 2;
// this module owns the persistence aggregate's validation pipeline (codec
// guards → storageVersion identification, fail closed → structural schema
// validation → whole-workspace cross-resource semantics → sorted diagnostics)
// and the canonical encoding used for persistence snapshots, hashing, and
// equality. Pure.
//
// #424 — two stored contract versions, one in-memory model:
//   * V3 (`dashboards: DashboardDocumentV1[]`) is THE application/repository
//     model. Everything downstream of `decodeStoredWorkspaceJson` sees V3 only;
//     there is deliberately no long-lived `StoredWorkspaceV2 | StoredWorkspaceV3`
//     union in application code.
//   * V2 (`dashboard: DashboardDocumentV1 | null`) stays READABLE for records
//     persisted before #424. It is validated against its own schema and then
//     migrated here, at the decoding boundary. Every WRITE emits V3.
// Unknown future versions fail closed with one precise version diagnostic
// rather than falling through to schema-union noise.

import { PORTABLE_LIMITS } from '../dashboard/model/portable-limits.js';
import { parseJsonWithLimits, utf8ByteLength } from '../dashboard/model/json-limits.js';
import type { JsonLimitOptions } from '../dashboard/model/json-limits.js';
import { canonicalJson, STORED_WORKSPACE_SHAPE } from '../dashboard/model/canonical-json.js';
import { diagnostic, sortDiagnostics } from '../dashboard/model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../dashboard/model/workspace-diagnostics.js';
import {
  unsupportedDashboardVersionDiagnostics,
  unsupportedSpecVersionDiagnostics,
  validateDashboardCollectionSemantics,
  validateQueryCollectionSemantics,
} from '../dashboard/model/workspace-semantics.js';
import { cloneJson } from '../core/saved-query.js';
import { jsonSchemaValidationService } from '../core/library-codec.js';
import type { JsonSchemaValidationService } from '../core/json-schema-validation.js';
import type { StoredWorkspaceV2, StoredWorkspaceV3 } from '../generated/json-schema.types.js';

export const CURRENT_STORED_WORKSPACE_VERSION = 3;
/** Still compiled and registered: the codec decodes legacy records with it. */
export const LEGACY_STORED_WORKSPACE_VERSION = 2;
export const STORED_WORKSPACE_V2_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/stored-workspace-v2.schema.json';
export const STORED_WORKSPACE_V3_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/stored-workspace-v3.schema.json';

export type WorkspaceFailResult = { ok: false; diagnostics: WorkspaceDiagnostic[] };

export interface WorkspaceCodecOptions {
  validationService?: JsonSchemaValidationService;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The one pure, deterministic V2 → V3 migration.
 *
 * `dashboard: null` becomes `dashboards: []`; a present Dashboard becomes the
 * sole array entry. Nothing else moves: no Dashboard/tile/filter/query id is
 * minted, no Dashboard revision is incremented, no tile is generated from or
 * removed because of a favorite flag, nothing is reordered, and unknown
 * forward-compatible fields survive the deep clone verbatim. Idempotent at the
 * repository boundary because it only ever runs on a document the version
 * pre-scan identified as V2.
 */
export function migrateStoredWorkspaceV2ToV3(workspace: StoredWorkspaceV2): StoredWorkspaceV3 {
  return {
    storageVersion: 3,
    id: workspace.id,
    key: workspace.key,
    name: workspace.name,
    queries: cloneJson(workspace.queries),
    dashboards: workspace.dashboard === null ? [] : [cloneJson(workspace.dashboard)],
  };
}

type VersionScan =
  | { ok: true; version: 2 | 3 }
  | { ok: false; diagnostics: WorkspaceDiagnostic[] };

/** Identify the stored contract version BEFORE any branch validation, so an
 *  unknown future version produces one precise diagnostic instead of the union
 *  of every branch's structural complaints. */
function scanStoredWorkspaceVersion(document: unknown, accepted: readonly (2 | 3)[]): VersionScan {
  const fail = (path: (string | number)[], code: string, message: string): VersionScan =>
    ({ ok: false, diagnostics: [diagnostic(path, code, message)] });
  if (!isObject(document)) return fail([], 'workspace-invalid-root', 'Stored workspace must be an object');
  if (!Object.hasOwn(document, 'storageVersion')) {
    return fail(['storageVersion'], 'workspace-version-missing', 'Missing stored-workspace version');
  }
  if (!Number.isInteger(document.storageVersion)) {
    return fail(['storageVersion'], 'workspace-version-invalid', 'Invalid stored-workspace version');
  }
  const version = document.storageVersion as 2 | 3;
  if (!accepted.includes(version)) {
    return fail(['storageVersion'], 'workspace-version-unsupported',
      `Unsupported stored-workspace version ${version}`);
  }
  return { ok: true, version };
}

/** Structural validation of one branch, with the resource-level version
 *  pre-scans running first and suppressing the schema noise they subsume — the
 *  same fail-closed discipline library-codec uses for `specVersion`. */
function structuralDiagnostics(
  document: Record<string, unknown>, schemaId: string, dashboardsKey: 'dashboard' | 'dashboards',
  validationService: JsonSchemaValidationService,
): WorkspaceDiagnostic[] {
  const queries = Array.isArray(document.queries) ? document.queries : [];
  // V3 validates the real array; V2's zero-or-one Dashboard is lifted into a
  // one-element array purely so ONE shared pre-scan covers both branches.
  const dashboards = dashboardsKey === 'dashboards'
    ? (Array.isArray(document.dashboards) ? document.dashboards : [])
    : (document.dashboard == null ? [] : [document.dashboard]);
  const specVersions = unsupportedSpecVersionDiagnostics(queries, ['queries']);
  const dashboardVersions = unsupportedDashboardVersionDiagnostics(dashboards, [dashboardsKey]);
  const skipQueryIndexes = new Set(specVersions.map((item) => item.path[1]));
  // A V2 document's single Dashboard is not an array member: its whole subtree
  // is suppressed as one unit, and the synthesized `dashboard[0]` prefix is
  // rewritten back onto the real `dashboard` path.
  const skipDashboardIndexes = new Set(dashboardVersions.map((item) => item.path[1]));
  const structural = validationService.validate(schemaId, document)
    .filter((item) => !(item.path[0] === 'queries' && skipQueryIndexes.has(item.path[1]))
      && !(item.path[0] === dashboardsKey
        && (dashboardsKey === 'dashboard' ? dashboardVersions.length > 0 : skipDashboardIndexes.has(item.path[1]))));
  return [
    ...specVersions,
    ...dashboardVersions.map((item) => (dashboardsKey === 'dashboards'
      ? item
      : { ...item, path: ['dashboard', ...item.path.slice(2)] })),
    ...structural,
  ];
}

/** Complete deterministic validation of one V3 stored-workspace aggregate —
 *  the same pipeline `WorkspaceRepository.commit` runs before any write, and
 *  the pipeline every candidate builder (import planner, saved-query mutation
 *  planner) validates its candidate through. */
export function validateStoredWorkspaceDocument(
  document: unknown, { validationService = jsonSchemaValidationService }: WorkspaceCodecOptions = {},
): WorkspaceDiagnostic[] {
  const scan = scanStoredWorkspaceVersion(document, [3]);
  if (!scan.ok) return sortDiagnostics(scan.diagnostics);
  const doc = document as Record<string, unknown>;
  const structural = structuralDiagnostics(doc, STORED_WORKSPACE_V3_SCHEMA_ID, 'dashboards', validationService);
  if (structural.length) return sortDiagnostics(structural);
  const queries = doc.queries as unknown[];
  return sortDiagnostics([
    ...validateQueryCollectionSemantics(queries),
    // Every Dashboard is validated INDEPENDENTLY against the one shared query
    // collection, with `dashboards[i]…` diagnostic paths; the collection rule
    // (globally unique Dashboard ids within the workspace + the collection
    // bound) lives in the same shared validator the portable bundle uses.
    ...validateDashboardCollectionSemantics(doc.dashboards as unknown[], {
      queries, path: ['dashboards'], validationService,
    }),
  ]);
}

export type DecodeStoredWorkspaceResult = { ok: true; value: StoredWorkspaceV3 } | WorkspaceFailResult;

/** Parse and fully validate stored-workspace JSON text, returning the canonical
 *  in-memory V3 shape. A persisted V2 record is validated against the V2 schema,
 *  migrated, and then re-validated as V3 — so a migration can never commit a
 *  document the V3 contract rejects. */
export function decodeStoredWorkspaceJson(
  text: unknown, options: WorkspaceCodecOptions & JsonLimitOptions = {},
): DecodeStoredWorkspaceResult {
  const parsed = parseJsonWithLimits(text, options);
  if (!parsed.ok) return parsed;
  const { validationService = jsonSchemaValidationService } = options;
  const scan = scanStoredWorkspaceVersion(parsed.value, [2, 3]);
  if (!scan.ok) return { ok: false, diagnostics: sortDiagnostics(scan.diagnostics) };
  if (scan.version === 3) {
    const diagnostics = validateStoredWorkspaceDocument(parsed.value, options);
    return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: parsed.value as StoredWorkspaceV3 };
  }
  const legacy = parsed.value as Record<string, unknown>;
  const structural = structuralDiagnostics(
    legacy, STORED_WORKSPACE_V2_SCHEMA_ID, 'dashboard', validationService,
  );
  if (structural.length) return { ok: false, diagnostics: sortDiagnostics(structural) };
  const migrated = migrateStoredWorkspaceV2ToV3(legacy as unknown as StoredWorkspaceV2);
  const diagnostics = validateStoredWorkspaceDocument(migrated, options);
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: migrated };
}

export type EncodeStoredWorkspaceResult = { ok: true; value: string } | WorkspaceFailResult;

/** Validate and canonically encode one V3 stored-workspace aggregate — the one
 *  encoder output persistence snapshots, hashing, equality checks, and
 *  snapshot tests all share. V2 is never written. */
export function encodeStoredWorkspaceJson(
  workspace: unknown, options: WorkspaceCodecOptions = {},
): EncodeStoredWorkspaceResult {
  const diagnostics = validateStoredWorkspaceDocument(workspace, options);
  if (diagnostics.length) return { ok: false, diagnostics };
  const encoded = canonicalJson(workspace, STORED_WORKSPACE_SHAPE);
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
