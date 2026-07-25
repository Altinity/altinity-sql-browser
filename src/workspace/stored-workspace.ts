// StoredWorkspaceV4 contract codec, the V2→V3→V4 migration chain, and
// whole-workspace
// validation (#280 "Internal persistence", phase 1 of #283; the Dashboard
// COLLECTION lands in #424). The atomic WorkspaceRepository itself is Phase 2;
// this module owns the persistence aggregate's validation pipeline (codec
// guards → storageVersion identification, fail closed → structural schema
// validation → whole-workspace cross-resource semantics → sorted diagnostics)
// and the canonical encoding used for persistence snapshots, hashing, and
// equality. Pure.
//
// #424/#427 — three stored contract versions, one in-memory model:
//   * V4 (Dashboard query OWNERSHIP: one dedicated query copy per member) is THE
//     application/repository model. Everything downstream of
//     `decodeStoredWorkspaceJson` sees V4 only; there is deliberately no
//     long-lived union of stored versions in application code.
//   * V3 (`dashboards: DashboardDocumentV1[]`, members may share a Library
//     query) stays READABLE for records persisted before #427.
//   * V2 (`dashboard: DashboardDocumentV1 | null`) stays READABLE for records
//     persisted before #424.
// A legacy record is validated against ITS OWN schema and then migrated forward
// one step at a time at the decoding boundary; only the final V4 form is fully
// validated, because an intermediate V3 form legitimately still shares queries —
// the very thing the next step fixes. Every WRITE emits V4.
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
  validateDashboardQueryOwnership,
  validateQueryCollectionSemantics,
} from '../dashboard/model/workspace-semantics.js';
import { cloneJson } from '../core/saved-query.js';
import { jsonSchemaValidationService } from '../core/library-codec.js';
import type { JsonSchemaValidationService } from '../core/json-schema-validation.js';
import { migrateStoredWorkspaceV3ToV4 } from './stored-workspace-ownership.js';
import type {
  StoredWorkspaceV2, StoredWorkspaceV3, StoredWorkspaceV4,
} from '../generated/json-schema.types.js';

export const CURRENT_STORED_WORKSPACE_VERSION = 4;
/** Still compiled and registered: the codec decodes legacy records with them. */
export const LEGACY_STORED_WORKSPACE_VERSIONS = [2, 3] as const;
export const STORED_WORKSPACE_V2_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/stored-workspace-v2.schema.json';
export const STORED_WORKSPACE_V3_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/stored-workspace-v3.schema.json';
export const STORED_WORKSPACE_V4_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/stored-workspace-v4.schema.json';

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

type StoredVersion = 2 | 3 | 4;

type VersionScan =
  | { ok: true; version: StoredVersion }
  | { ok: false; diagnostics: WorkspaceDiagnostic[] };

/** Identify the stored contract version BEFORE any branch validation, so an
 *  unknown future version produces one precise diagnostic instead of the union
 *  of every branch's structural complaints. */
function scanStoredWorkspaceVersion(document: unknown, accepted: readonly StoredVersion[]): VersionScan {
  const fail = (path: (string | number)[], code: string, message: string): VersionScan =>
    ({ ok: false, diagnostics: [diagnostic(path, code, message)] });
  if (!isObject(document)) return fail([], 'workspace-invalid-root', 'Stored workspace must be an object');
  if (!Object.hasOwn(document, 'storageVersion')) {
    return fail(['storageVersion'], 'workspace-version-missing', 'Missing stored-workspace version');
  }
  if (!Number.isInteger(document.storageVersion)) {
    return fail(['storageVersion'], 'workspace-version-invalid', 'Invalid stored-workspace version');
  }
  const version = document.storageVersion as StoredVersion;
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

/** Complete deterministic validation of one V4 stored-workspace aggregate —
 *  the same pipeline `WorkspaceRepository.commit` runs before any write, and
 *  the pipeline every candidate builder (import planner, saved-query mutation
 *  planner) validates its candidate through. */
export function validateStoredWorkspaceDocument(
  document: unknown, { validationService = jsonSchemaValidationService }: WorkspaceCodecOptions = {},
): WorkspaceDiagnostic[] {
  const scan = scanStoredWorkspaceVersion(document, [4]);
  if (!scan.ok) return sortDiagnostics(scan.diagnostics);
  const doc = document as Record<string, unknown>;
  const structural = structuralDiagnostics(doc, STORED_WORKSPACE_V4_SCHEMA_ID, 'dashboards', validationService);
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
    // #427 — the ownership invariant, workspace-wide. It lives here rather than
    // in the shared collection validator because a portable bundle may still
    // carry legacy shared references, which import NORMALIZES instead of
    // rejecting; a stored V4 record has already been through the migration.
    // Safe to read typed: structural validation above returned clean.
    ...validateDashboardQueryOwnership(document as StoredWorkspaceV4),
  ]);
}

export type DecodeStoredWorkspaceResult = { ok: true; value: StoredWorkspaceV4 } | WorkspaceFailResult;

/** Parse and fully validate stored-workspace JSON text, returning the canonical
 *  in-memory V4 shape. A legacy record is validated against its own schema,
 *  migrated forward, and then validated as V4 — so a migration can never
 *  produce a document the V4 contract rejects. The migration is PURE: owned-copy
 *  ids are derived from the member each copy belongs to, never generated, so this
 *  read (which `WorkspaceRepository.list()` performs on every record without
 *  writing) returns the same document every time, in every tab. */
export function decodeStoredWorkspaceJson(
  text: unknown, options: WorkspaceCodecOptions & JsonLimitOptions = {},
): DecodeStoredWorkspaceResult {
  const parsed = parseJsonWithLimits(text, options);
  if (!parsed.ok) return parsed;
  const { validationService = jsonSchemaValidationService } = options;
  const scan = scanStoredWorkspaceVersion(parsed.value, [2, 3, 4]);
  if (!scan.ok) return { ok: false, diagnostics: sortDiagnostics(scan.diagnostics) };
  if (scan.version === 4) {
    const diagnostics = validateStoredWorkspaceDocument(parsed.value, options);
    return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: parsed.value as StoredWorkspaceV4 };
  }
  const legacy = parsed.value as Record<string, unknown>;
  // Each legacy branch is validated against its OWN schema at its own paths, so
  // a broken v2 record complains about `dashboard`, not `dashboards[0]`.
  const structural = scan.version === 3
    ? structuralDiagnostics(legacy, STORED_WORKSPACE_V3_SCHEMA_ID, 'dashboards', validationService)
    : structuralDiagnostics(legacy, STORED_WORKSPACE_V2_SCHEMA_ID, 'dashboard', validationService);
  if (structural.length) return { ok: false, diagnostics: sortDiagnostics(structural) };
  const asV3 = scan.version === 3
    ? (legacy as unknown as StoredWorkspaceV3)
    : migrateStoredWorkspaceV2ToV3(legacy as unknown as StoredWorkspaceV2);
  const migrated = migrateStoredWorkspaceV3ToV4(asV3);
  const diagnostics = validateStoredWorkspaceDocument(migrated, options);
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: migrated };
}

export type EncodeStoredWorkspaceResult = { ok: true; value: string } | WorkspaceFailResult;

/** Validate and canonically encode one V4 stored-workspace aggregate — the one
 *  encoder output persistence snapshots, hashing, equality checks, and
 *  snapshot tests all share. No legacy version is ever written. */
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
