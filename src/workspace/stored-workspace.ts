// StoredWorkspaceV2 contract codec and whole-workspace validation (#280
// "Internal persistence: StoredWorkspaceV2", phase 1 of #283). The atomic
// WorkspaceRepository itself is Phase 2; this module owns the persistence
// aggregate's validation pipeline (codec guards → storageVersion
// identification, fail closed → structural schema validation → whole-
// workspace cross-resource semantics → sorted diagnostics) and the canonical
// encoding used for persistence snapshots, hashing, and equality. Pure.

import { PORTABLE_LIMITS } from '../dashboard/model/portable-limits.js';
import { parseJsonWithLimits, utf8ByteLength } from '../dashboard/model/json-limits.js';
import type { JsonLimitOptions } from '../dashboard/model/json-limits.js';
import { canonicalJson, STORED_WORKSPACE_SHAPE } from '../dashboard/model/canonical-json.js';
import { diagnostic, sortDiagnostics } from '../dashboard/model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../dashboard/model/workspace-diagnostics.js';
import {
  unsupportedDashboardVersionDiagnostics,
  unsupportedSpecVersionDiagnostics,
  validateDashboardSemantics,
  validateQueryCollectionSemantics,
} from '../dashboard/model/workspace-semantics.js';
import { jsonSchemaValidationService } from '../core/library-codec.js';
import type { JsonSchemaValidationService } from '../core/json-schema-validation.js';
import type { StoredWorkspaceV2 } from '../generated/json-schema.types.js';

export const CURRENT_STORED_WORKSPACE_VERSION = 2;
export const STORED_WORKSPACE_V2_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/stored-workspace-v2.schema.json';

export type WorkspaceFailResult = { ok: false; diagnostics: WorkspaceDiagnostic[] };

export interface WorkspaceCodecOptions {
  validationService?: JsonSchemaValidationService;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function identifyStoredWorkspace(document: unknown): WorkspaceDiagnostic[] {
  if (!isObject(document)) return [diagnostic([], 'workspace-invalid-root', 'Stored workspace must be an object')];
  if (!Object.hasOwn(document, 'storageVersion')) {
    return [diagnostic(['storageVersion'], 'workspace-version-missing', 'Missing stored-workspace version')];
  }
  if (!Number.isInteger(document.storageVersion)) {
    return [diagnostic(['storageVersion'], 'workspace-version-invalid', 'Invalid stored-workspace version')];
  }
  if (document.storageVersion !== CURRENT_STORED_WORKSPACE_VERSION) {
    return [diagnostic(['storageVersion'], 'workspace-version-unsupported',
      `Unsupported stored-workspace version ${document.storageVersion}`)];
  }
  return [];
}

/** Complete deterministic validation of one stored-workspace aggregate —
 *  the same pipeline Phase 2's `WorkspaceRepository.commit` must run before
 *  any write. */
export function validateStoredWorkspaceDocument(
  document: unknown, { validationService = jsonSchemaValidationService }: WorkspaceCodecOptions = {},
): WorkspaceDiagnostic[] {
  const identity = identifyStoredWorkspace(document);
  if (identity.length) return sortDiagnostics(identity);
  const doc = document as Record<string, unknown>;
  const queries = Array.isArray(doc.queries) ? doc.queries : [];
  const dashboard = doc.dashboard ?? null;
  const versionDiagnostics = [
    ...unsupportedSpecVersionDiagnostics(queries, ['queries']),
    ...unsupportedDashboardVersionDiagnostics(dashboard === null ? [] : [dashboard], [])
      .map((item) => ({ ...item, path: ['dashboard', ...item.path.slice(1)] })),
  ];
  const skipQueryIndexes = new Set(versionDiagnostics
    .filter((item) => item.path[0] === 'queries').map((item) => item.path[1]));
  const skipDashboard = versionDiagnostics.some((item) => item.path[0] === 'dashboard');
  const structural = validationService.validate(STORED_WORKSPACE_V2_SCHEMA_ID, document)
    .filter((item) => !(item.path[0] === 'queries' && skipQueryIndexes.has(item.path[1]))
      && !(skipDashboard && item.path[0] === 'dashboard'));
  if (versionDiagnostics.length || structural.length) {
    return sortDiagnostics([...versionDiagnostics, ...structural]);
  }
  return sortDiagnostics([
    ...validateQueryCollectionSemantics(queries),
    ...(dashboard === null ? [] : validateDashboardSemantics(dashboard, {
      queries, path: ['dashboard'], validationService,
    })),
  ]);
}

export type DecodeStoredWorkspaceResult = { ok: true; value: StoredWorkspaceV2 } | WorkspaceFailResult;

/** Parse and fully validate stored-workspace JSON text. */
export function decodeStoredWorkspaceJson(
  text: unknown, options: WorkspaceCodecOptions & JsonLimitOptions = {},
): DecodeStoredWorkspaceResult {
  const parsed = parseJsonWithLimits(text, options);
  if (!parsed.ok) return parsed;
  const diagnostics = validateStoredWorkspaceDocument(parsed.value, options);
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, value: parsed.value as StoredWorkspaceV2 };
}

export type EncodeStoredWorkspaceResult = { ok: true; value: string } | WorkspaceFailResult;

/** Validate and canonically encode one stored-workspace aggregate — the one
 *  encoder output persistence snapshots, hashing, equality checks, and
 *  snapshot tests all share. */
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
