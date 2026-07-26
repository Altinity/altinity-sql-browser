// Whole-workspace cross-resource semantic validation (#280 "Cross-resource
// semantic validation") plus the runtime re-checks of security-relevant
// resource limits that JSON Schema cannot express (or that must hold even
// when a caller bypasses schema validation). Operates on already-parsed
// documents; structural schema validation runs first in the codecs, so this
// layer narrows defensively instead of asserting shapes. Pure — the compiled
// schema validation service is injected with a generated default.

import { PORTABLE_LIMITS } from './portable-limits.js';
import { canonicalJson, QUERY_SPEC_SHAPE } from './canonical-json.js';
import { utf8ByteLength } from './json-limits.js';
import { diagnostic, sortDiagnostics } from './workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from './workspace-diagnostics.js';
import { jsonSchemaValidationService, SPEC_CODECS } from '../../core/library-codec.js';
import type { JsonSchemaValidationService } from '../../core/json-schema-validation.js';
import { hasSameTimeRangeParameter } from '../../core/query-time-range.js';
import { buildQueryOwnershipIndex } from './query-ownership.js';
import type { DashboardDocumentV2, SavedQueryV2 } from '../../generated/json-schema.types.js';

export const FLOW_LAYOUT_V1_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/dashboard-layout-flow-v1.schema.json';
export const GRAFANA_GRID_LAYOUT_V1_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/dashboard-layout-grafana-grid-v1.schema.json';

/** Every primary layout engine this build can render, and the compiled schema
 *  that validates its own document shape (#291 adds grafana-grid@1 as a
 *  second engine alongside flow@1). */
const SUPPORTED_LAYOUT_SCHEMAS: Record<string, { versions: readonly number[]; schemaId: string }> = {
  flow: { versions: [1], schemaId: FLOW_LAYOUT_V1_SCHEMA_ID },
  'grafana-grid': { versions: [1], schemaId: GRAFANA_GRID_LAYOUT_V1_SCHEMA_ID },
};

/** True for any registered primary engine at a version this build renders
 *  (flow@1 or grafana-grid@1 in v1). Anything else must carry a valid flow@1
 *  fallback or fail before execution. NOT the right check for "is this
 *  specifically the flow@1 fallback slot" — that stays pinned to flow@1 only
 *  (`isFlowLayout`) and never widens to another engine, even when that engine
 *  is itself supported as a primary. */
export const isSupportedLayout = (type: unknown, version: unknown): boolean =>
  typeof type === 'string' && typeof version === 'number'
  && Object.hasOwn(SUPPORTED_LAYOUT_SCHEMAS, type)
  && SUPPORTED_LAYOUT_SCHEMAS[type].versions.includes(version);

/** flow@1 specifically. Used wherever a value must be THE flow engine itself:
 *  the flow plugin's own item host/render surface (flow-layout.ts), and the
 *  Dashboard layout's `fallback` slot, which is pinned to flow@1 and must
 *  never accept another engine even once that engine is a supported primary
 *  (#291's "do not widen the fallback slot"). */
export const isFlowLayout = (type: unknown, version: unknown): boolean =>
  type === 'flow' && version === 1;

/** The Dashboard document version this build writes and semantically validates
 *  (#447 raised it from 1 when curated filters were removed). */
export const CURRENT_DASHBOARD_DOCUMENT_VERSION = 2;

type Path = (string | number)[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const stringId = (value: unknown): string | undefined =>
  (typeof value === 'string' ? value : undefined);

/** The saved query's effective Dashboard role (`panel` when undeclared). */
export function queryDashboardRole(query: unknown): string {
  if (!isObject(query) || !isObject(query.spec)) return 'panel';
  const dashboard = query.spec.dashboard;
  if (!isObject(dashboard)) return 'panel';
  return typeof dashboard.role === 'string' ? dashboard.role : 'panel';
}

const queryVariants = (query: unknown): Record<string, unknown> | undefined => {
  if (!isObject(query) || !isObject(query.spec) || !isObject(query.spec.dashboard)) return undefined;
  const variants = query.spec.dashboard.variants;
  return isObject(variants) ? variants : undefined;
};

const basePanelType = (spec: unknown): string | undefined => {
  if (!isObject(spec) || !isObject(spec.panel) || !isObject(spec.panel.cfg)) return undefined;
  return typeof spec.panel.cfg.type === 'string' ? spec.panel.cfg.type : undefined;
};

// Static half of the #280 renderer-type rule (a patch may not change
// panel.cfg.type): flag a patch whose cfg.type is a string different from
// the declared base type. Full RFC 7396 resolution lands in Phase 3.
const patchRendererType = (patch: unknown): string | undefined => {
  if (!isObject(patch) || !isObject(patch.cfg)) return undefined;
  return typeof patch.cfg.type === 'string' ? patch.cfg.type : undefined;
};

// --- fail-closed version pre-scans ------------------------------------------
// Unknown future resource versions fail closed with ONE precise diagnostic.
// The codecs run these before structural schema validation and suppress the
// schema branch noise for the same resource index, exactly like
// library-codec's unsupported-specVersion handling.

/** Queries whose integer `specVersion` names no supported Spec codec. */
export function unsupportedSpecVersionDiagnostics(
  queries: readonly unknown[], path: Path = ['queries'],
): WorkspaceDiagnostic[] {
  const out: WorkspaceDiagnostic[] = [];
  for (const [index, query] of queries.entries()) {
    if (!isObject(query) || !Number.isInteger(query.specVersion) || SPEC_CODECS.has(query.specVersion as number)) continue;
    out.push(diagnostic([...path, index, 'specVersion'], 'spec-version-unsupported',
      `queries[${index}] uses unsupported saved-query Spec version ${query.specVersion}`, stringId(query.id)));
  }
  return out;
}

/**
 * Dashboards whose integer `documentVersion` is not the one the CALLER's branch
 * expects.
 *
 * The expected version is a parameter rather than a constant because #447 gave
 * the Dashboard document a second version while the containers that carry it
 * stayed readable at their older versions: a stored-workspace v2/v3/v4 record
 * and a portable-bundle v1 file each legitimately hold document v1, and are
 * migrated forward AFTER their own structural pass. Hardcoding the current
 * version here would reject every legacy record before its migration could
 * ever run.
 */
export function unsupportedDashboardVersionDiagnostics(
  dashboards: readonly unknown[], path: Path = ['dashboards'],
  supported: number = CURRENT_DASHBOARD_DOCUMENT_VERSION,
): WorkspaceDiagnostic[] {
  const out: WorkspaceDiagnostic[] = [];
  for (const [index, dashboard] of dashboards.entries()) {
    if (!isObject(dashboard) || !Number.isInteger(dashboard.documentVersion)
      || dashboard.documentVersion === supported) continue;
    out.push(diagnostic([...path, index, 'documentVersion'], 'dashboard-version-unsupported',
      `Unsupported Dashboard document version ${JSON.stringify(dashboard.documentVersion)}`, stringId(dashboard.id)));
  }
  return out;
}

export interface QueryCollectionOptions {
  path?: Path;
}

/** Query-collection rules shared by bundles and stored workspaces: unique
 *  query IDs, runtime limit re-checks (ID/SQL/name lengths, serialized Spec
 *  bytes, variant count), defaultVariant existence, and the static
 *  renderer-type check for every declared variant patch. */
export function validateQueryCollectionSemantics(
  queries: readonly unknown[], { path = ['queries'] }: QueryCollectionOptions = {},
): WorkspaceDiagnostic[] {
  const out: WorkspaceDiagnostic[] = [];
  if (queries.length > PORTABLE_LIMITS.maxQueries) {
    out.push(diagnostic(path, 'limit-query-count',
      `queries contains ${queries.length} items; the maximum is ${PORTABLE_LIMITS.maxQueries}`));
  }
  const firstIndexById = new Map<string, number>();
  for (const [index, query] of queries.entries()) {
    if (!isObject(query)) continue; // structurally invalid — the schema layer reports it
    const id = stringId(query.id);
    if (id !== undefined) {
      if (firstIndexById.has(id)) {
        out.push(diagnostic([...path, index, 'id'], 'workspace-duplicate-query-id',
          `Saved-query id ${JSON.stringify(id)} duplicates queries[${firstIndexById.get(id)}].id`, id));
      } else firstIndexById.set(id, index);
      if (id.length > PORTABLE_LIMITS.maxIdLength) {
        out.push(diagnostic([...path, index, 'id'], 'limit-id-length',
          `Saved-query id is ${id.length} characters; the maximum is ${PORTABLE_LIMITS.maxIdLength}`, id));
      }
    }
    if (typeof query.sql === 'string' && query.sql.length > PORTABLE_LIMITS.maxSqlLength) {
      out.push(diagnostic([...path, index, 'sql'], 'limit-sql-length',
        `SQL is ${query.sql.length} characters; the maximum is ${PORTABLE_LIMITS.maxSqlLength}`, id));
    }
    const spec = query.spec;
    if (!isObject(spec)) continue;
    if (hasSameTimeRangeParameter(spec)) {
      out.push(diagnostic([...path, index, 'spec', 'timeRanges', 0, 'to'], 'time-range-same-parameter',
        'Time-range From and To parameters must be different.', id));
    }
    if (typeof spec.name === 'string' && spec.name.length > PORTABLE_LIMITS.maxNameLength) {
      out.push(diagnostic([...path, index, 'spec', 'name'], 'limit-name-length',
        `Query name is ${spec.name.length} characters; the maximum is ${PORTABLE_LIMITS.maxNameLength}`, id));
    }
    if (typeof spec.description === 'string' && spec.description.length > PORTABLE_LIMITS.maxDescriptionLength) {
      out.push(diagnostic([...path, index, 'spec', 'description'], 'limit-description-length',
        `Query description is ${spec.description.length} characters; the maximum is ${PORTABLE_LIMITS.maxDescriptionLength}`, id));
    }
    const specBytes = utf8ByteLength(canonicalJson(spec, QUERY_SPEC_SHAPE));
    if (specBytes > PORTABLE_LIMITS.maxSerializedQuerySpecBytes) {
      out.push(diagnostic([...path, index, 'spec'], 'limit-spec-bytes',
        `Serialized Spec is ${specBytes} UTF-8 bytes; the maximum is ${PORTABLE_LIMITS.maxSerializedQuerySpecBytes}`, id));
    }
    const presentation = isObject(spec.dashboard) ? spec.dashboard : undefined;
    if (!presentation) continue;
    const variants = isObject(presentation.variants) ? presentation.variants : undefined;
    const variantNames = variants ? Object.keys(variants) : [];
    if (variantNames.length > PORTABLE_LIMITS.maxVariantsPerQuery) {
      out.push(diagnostic([...path, index, 'spec', 'dashboard', 'variants'], 'limit-variant-count',
        `variants declares ${variantNames.length} entries; the maximum is ${PORTABLE_LIMITS.maxVariantsPerQuery}`, id));
    }
    if (typeof presentation.defaultVariant === 'string'
      && !(variants && Object.hasOwn(variants, presentation.defaultVariant))) {
      out.push(diagnostic([...path, index, 'spec', 'dashboard', 'defaultVariant'], 'query-default-variant-missing',
        `defaultVariant ${JSON.stringify(presentation.defaultVariant)} names no declared variant`, id));
    }
    const baseType = basePanelType(spec);
    for (const name of variantNames) {
      const patchType = patchRendererType(variants![name]);
      if (patchType !== undefined && baseType !== undefined && patchType !== baseType) {
        out.push(diagnostic(
          [...path, index, 'spec', 'dashboard', 'variants', name, 'cfg', 'type'],
          'presentation-renderer-type-change',
          `Variant ${JSON.stringify(name)} changes the renderer type from ${JSON.stringify(baseType)} to ${JSON.stringify(patchType)}`,
          id,
        ));
      }
    }
  }
  return sortDiagnostics(out);
}

export interface DashboardSemanticsOptions {
  queries?: readonly unknown[];
  path?: Path;
  validationService?: JsonSchemaValidationService;
}

interface TileEntry {
  index: number;
  queryId: string | undefined;
}

/** Every #280 per-Dashboard cross-resource rule: unique tile/filter IDs,
 *  tile query resolution and role compatibility, variant existence, the
 *  static renderer-type override check, layout support/fallback/orphan/count
 *  rules (flow@1 re-validated through the compiled schema validator), filter
 *  source/target resolution with role and parameter checks, Setup execution
 *  rejection, and the per-Dashboard runtime limit re-checks. */
export function validateDashboardSemantics(dashboard: unknown, {
  queries = [],
  path = [],
  validationService = jsonSchemaValidationService,
}: DashboardSemanticsOptions = {}): WorkspaceDiagnostic[] {
  if (!isObject(dashboard)) return [];
  const dashboardId = stringId(dashboard.id);
  if (dashboard.documentVersion !== CURRENT_DASHBOARD_DOCUMENT_VERSION) {
    // Unknown versions fail closed before any other rule runs. A legacy
    // document reaches this validator only AFTER its container's migration has
    // brought it to the current version, so "not current" is genuinely
    // unsupported here rather than merely old.
    return [diagnostic([...path, 'documentVersion'], 'dashboard-version-unsupported',
      `Unsupported Dashboard document version ${JSON.stringify(dashboard.documentVersion)}`, dashboardId)];
  }
  const out: WorkspaceDiagnostic[] = [];
  const emit = (at: Path, code: string, message: string): void => {
    out.push(diagnostic(at, code, message, dashboardId));
  };

  const queriesById = new Map<string, unknown>();
  for (const query of queries) {
    if (!isObject(query)) continue;
    const id = stringId(query.id);
    if (id !== undefined && !queriesById.has(id)) queriesById.set(id, query);
  }
  // --- tiles ---------------------------------------------------------------
  const tiles = asArray(dashboard.tiles);
  if (tiles.length > PORTABLE_LIMITS.maxTilesPerDashboard) {
    emit([...path, 'tiles'], 'limit-tile-count',
      `tiles contains ${tiles.length} items; the maximum is ${PORTABLE_LIMITS.maxTilesPerDashboard}`);
  }
  const tilesById = new Map<string, TileEntry>();
  for (const [index, tile] of tiles.entries()) {
    if (!isObject(tile)) continue;
    const tileId = stringId(tile.id);
    const queryId = stringId(tile.queryId);
    if (tileId !== undefined) {
      if (tilesById.has(tileId)) {
        emit([...path, 'tiles', index, 'id'], 'dashboard-duplicate-tile-id',
          `Tile id ${JSON.stringify(tileId)} duplicates tiles[${tilesById.get(tileId)!.index}].id`);
      } else tilesById.set(tileId, { index, queryId });
    }
    const query = queryId === undefined ? undefined : queriesById.get(queryId);
    if (queryId !== undefined && query === undefined) {
      emit([...path, 'tiles', index, 'queryId'], 'dashboard-tile-query-missing',
        `Tile references unknown saved query ${JSON.stringify(queryId)}`);
    }
    if (query !== undefined) {
      const role = queryDashboardRole(query);
      if (role === 'setup') {
        emit([...path, 'tiles', index, 'queryId'], 'dashboard-setup-reference',
          `Tile references Setup-role query ${JSON.stringify(queryId)}; a Dashboard never executes Setup queries`);
      } else if (role !== 'panel') {
        emit([...path, 'tiles', index, 'queryId'], 'dashboard-tile-role-incompatible',
          `Tile references ${JSON.stringify(role)}-role query ${JSON.stringify(queryId)}; tiles require role panel`);
      }
    }
    const presentation = isObject(tile.presentation) ? tile.presentation : undefined;
    if (!presentation) continue;
    if (typeof presentation.variant === 'string' && query !== undefined) {
      const variants = queryVariants(query);
      if (!(variants && Object.hasOwn(variants, presentation.variant))) {
        emit([...path, 'tiles', index, 'presentation', 'variant'], 'dashboard-variant-missing',
          `Selected variant ${JSON.stringify(presentation.variant)} is not declared by query ${JSON.stringify(queryId)}`);
      }
    }
    const overrideType = patchRendererType(presentation.override);
    if (overrideType !== undefined && query !== undefined) {
      const baseType = basePanelType(isObject(query) ? query.spec : undefined);
      if (baseType !== undefined && overrideType !== baseType) {
        emit([...path, 'tiles', index, 'presentation', 'override', 'cfg', 'type'],
          'presentation-renderer-type-change',
          `Tile override changes the renderer type from ${JSON.stringify(baseType)} to ${JSON.stringify(overrideType)}`);
      }
    }
  }

  // --- layout --------------------------------------------------------------
  const layout = isObject(dashboard.layout) ? dashboard.layout : undefined;
  if (layout) {
    const layoutPath: Path = [...path, 'layout'];
    const checkItems = (items: unknown, itemsPath: Path): void => {
      if (!isObject(items)) return;
      const keys = Object.keys(items);
      if (keys.length > PORTABLE_LIMITS.maxLayoutItemsPerDashboard) {
        emit(itemsPath, 'limit-layout-item-count',
          `Layout declares ${keys.length} placements; the maximum is ${PORTABLE_LIMITS.maxLayoutItemsPerDashboard}`);
      }
      if (keys.length > tiles.length) {
        emit(itemsPath, 'layout-items-exceed-tiles',
          `Layout declares ${keys.length} placements for ${tiles.length} tiles`);
      }
      for (const key of keys) {
        if (!tilesById.has(key)) {
          emit([...itemsPath, key], 'layout-orphan-placement',
            `Placement ${JSON.stringify(key)} references no tile`);
        }
      }
    };
    checkItems(layout.items, [...layoutPath, 'items']);
    if (isFlowLayout(layout.type, layout.version)) {
      // flow@1 IS the fallback engine: a flow primary needs no fallback of
      // its own, validated directly against its own schema (unchanged from
      // pre-#291 behavior).
      for (const schemaError of validationService.validate(FLOW_LAYOUT_V1_SCHEMA_ID, layout)) {
        out.push({
          ...schemaError,
          path: [...layoutPath, ...schemaError.path],
          ...(dashboardId === undefined ? {} : { resource: dashboardId }),
        });
      }
    } else {
      // Any other primary — a second known engine (grafana-grid@1) or a
      // truly unsupported/unknown one — always requires its own valid flow@1
      // fallback (#291): the fallback slot is pinned to flow@1 and never
      // widens, so it stays the one universal safety net regardless of which
      // other engine is primary. A known non-flow engine ALSO gets its own
      // items validated against its own schema, in addition to the fallback.
      const primarySchema = isSupportedLayout(layout.type, layout.version)
        ? SUPPORTED_LAYOUT_SCHEMAS[layout.type as string].schemaId : undefined;
      if (primarySchema !== undefined) {
        // Validate only the engine's own declared shape: `fallback`/`config`
        // are envelope-only slots (dashboardLayoutDocumentV1 in
        // dashboard-v1.schema.json), not part of any concrete per-engine
        // schema (flow@1's own schema doesn't declare them either) — passing
        // them through would spuriously fail the engine's closed
        // `additionalProperties: false` schema.
        const primaryOwn = Object.fromEntries(
          Object.entries(layout).filter(([key]) => key !== 'fallback' && key !== 'config'),
        );
        for (const schemaError of validationService.validate(primarySchema, primaryOwn)) {
          out.push({
            ...schemaError,
            path: [...layoutPath, ...schemaError.path],
            ...(dashboardId === undefined ? {} : { resource: dashboardId }),
          });
        }
      }
      const fallback = layout.fallback;
      if (fallback === undefined || fallback === null) {
        emit(layoutPath, 'layout-unsupported-without-fallback',
          primarySchema !== undefined
            ? `Layout ${JSON.stringify(layout.type)}@${JSON.stringify(layout.version)} requires a valid flow@1 fallback`
            : `Layout ${JSON.stringify(layout.type)}@${JSON.stringify(layout.version)} is unsupported and has no flow@1 fallback`);
      } else {
        for (const schemaError of validationService.validate(FLOW_LAYOUT_V1_SCHEMA_ID, fallback)) {
          out.push({
            ...schemaError,
            path: [...layoutPath, 'fallback', ...schemaError.path],
            ...(dashboardId === undefined ? {} : { resource: dashboardId }),
          });
        }
        if (isObject(fallback)) checkItems(fallback.items, [...layoutPath, 'fallback', 'items']);
      }
    }
    if (layout.config !== undefined) {
      const configBytes = utf8ByteLength(canonicalJson(layout.config));
      if (configBytes > PORTABLE_LIMITS.maxSerializedLayoutConfigBytes) {
        emit([...layoutPath, 'config'], 'limit-layout-config-bytes',
          `Serialized layout config is ${configBytes} UTF-8 bytes; the maximum is ${PORTABLE_LIMITS.maxSerializedLayoutConfigBytes}`);
      }
    }
  }


  return sortDiagnostics(out);
}

/**
 * #427 — the Dashboard query OWNERSHIP invariant: no saved query is shared by two
 * panel tiles, or by tiles of different Dashboards. Reported at EVERY owner after
 * the first, so the diagnostics name the references that would have to change
 * rather than the one that got there first.
 *
 * #447 removed the one shape that used to be a legitimate exception. A curated
 * filter referenced an option-source query, and one such source supplied the
 * options for several filters of the same Dashboard, so it was owned per
 * DASHBOARD. Variables carry their optional option SQL on the Dashboard document
 * itself, so a tile is now the only kind of member that references a query and
 * "shared" is unconditionally invalid.
 *
 * Deliberately NOT part of `validateDashboardCollectionSemantics`: that validator
 * also guards portable bundles, and #427 requires a readable legacy bundle with
 * shared references to be NORMALIZED on import rather than rejected. This rule is
 * therefore whole-workspace only, invoked by the current stored-workspace
 * validator — the boundary the migration has already made single-owner.
 *
 * The document has passed structural schema validation before this runs, which is
 * what lets it take a typed workspace instead of narrowing defensively.
 */
export function validateDashboardQueryOwnership(
  workspace: { queries: readonly SavedQueryV2[]; dashboards: readonly DashboardDocumentV2[] },
  path: Path = ['dashboards'],
): WorkspaceDiagnostic[] {
  const out: WorkspaceDiagnostic[] = [];
  const { ownersByQueryId } = buildQueryOwnershipIndex(workspace);
  for (const [dashboardIndex, dashboard] of workspace.dashboards.entries()) {
    for (const [tileIndex, tile] of dashboard.tiles.entries()) {
      const owners = ownersByQueryId.get(tile.queryId) ?? [];
      if (owners.length < 2) continue;
      const first = owners[0];
      if (first.tileId === tile.id && first.dashboardId === dashboard.id) continue;
      out.push(diagnostic([...path, dashboardIndex, 'tiles', tileIndex, 'queryId'],
        'dashboard-query-multiple-owners',
        `Query ${JSON.stringify(tile.queryId)} is owned by ${owners.length} Dashboard members; tile ${JSON.stringify(tile.id)} must reference its own dedicated copy`,
        dashboard.id));
    }
  }
  return sortDiagnostics(out);
}

export interface DashboardCollectionOptions {
  queries?: readonly unknown[];
  path?: Path;
  validationService?: JsonSchemaValidationService;
}

/** Bundle-side Dashboard collection rules: unique Dashboard IDs, the
 *  Dashboard-count limit re-check, and every per-Dashboard rule. */
export function validateDashboardCollectionSemantics(dashboards: readonly unknown[], {
  queries = [],
  path = ['dashboards'],
  validationService = jsonSchemaValidationService,
}: DashboardCollectionOptions = {}): WorkspaceDiagnostic[] {
  const out: WorkspaceDiagnostic[] = [];
  if (dashboards.length > PORTABLE_LIMITS.maxDashboards) {
    out.push(diagnostic(path, 'limit-dashboard-count',
      `dashboards contains ${dashboards.length} items; the maximum is ${PORTABLE_LIMITS.maxDashboards}`));
  }
  const firstIndexById = new Map<string, number>();
  for (const [index, dashboard] of dashboards.entries()) {
    if (isObject(dashboard)) {
      const id = stringId(dashboard.id);
      if (id !== undefined) {
        if (firstIndexById.has(id)) {
          out.push(diagnostic([...path, index, 'id'], 'workspace-duplicate-dashboard-id',
            `Dashboard id ${JSON.stringify(id)} duplicates dashboards[${firstIndexById.get(id)}].id`, id));
        } else firstIndexById.set(id, index);
      }
    }
    out.push(...validateDashboardSemantics(dashboard, { queries, path: [...path, index], validationService }));
  }
  return sortDiagnostics(out);
}
