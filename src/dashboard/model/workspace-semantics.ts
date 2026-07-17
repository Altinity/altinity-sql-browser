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
import { scanParamDeclarations } from '../../core/param-scan.js';

export const FLOW_LAYOUT_V1_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/dashboard-layout-flow-v1.schema.json';

/** The layout engines this build can render. flow@1 is the only v1 engine;
 *  anything else must carry a valid flow@1 fallback or fail before execution. */
export const isSupportedLayout = (type: unknown, version: unknown): boolean =>
  type === 'flow' && version === 1;

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

const normalizeParamType = (type: string): string => type.replace(/\s+/g, ' ').trim();

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

/** Dashboards whose integer `documentVersion` is not the supported version 1. */
export function unsupportedDashboardVersionDiagnostics(
  dashboards: readonly unknown[], path: Path = ['dashboards'],
): WorkspaceDiagnostic[] {
  const out: WorkspaceDiagnostic[] = [];
  for (const [index, dashboard] of dashboards.entries()) {
    if (!isObject(dashboard) || !Number.isInteger(dashboard.documentVersion) || dashboard.documentVersion === 1) continue;
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
  if (dashboard.documentVersion !== 1) {
    // Unknown future versions fail closed before any other rule runs.
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
  const declarationsFor = (query: unknown): { name: string; type: string }[] =>
    (isObject(query) && typeof query.sql === 'string' ? scanParamDeclarations(query.sql) : []);

  // --- tiles ---------------------------------------------------------------
  const tiles = asArray(dashboard.tiles);
  if (tiles.length > PORTABLE_LIMITS.maxTilesPerDashboard) {
    emit([...path, 'tiles'], 'limit-tile-count',
      `tiles contains ${tiles.length} items; the maximum is ${PORTABLE_LIMITS.maxTilesPerDashboard}`);
  }
  const tilesById = new Map<string, TileEntry>();
  const tileQueryIds = new Set<string>();
  for (const [index, tile] of tiles.entries()) {
    if (!isObject(tile)) continue;
    const tileId = stringId(tile.id);
    const queryId = stringId(tile.queryId);
    if (queryId !== undefined) tileQueryIds.add(queryId);
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
          `Tile references Setup-role query ${JSON.stringify(queryId)}; Dashboard v1 never executes Setup queries`);
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
    if (isSupportedLayout(layout.type, layout.version)) {
      for (const schemaError of validationService.validate(FLOW_LAYOUT_V1_SCHEMA_ID, layout)) {
        out.push({
          ...schemaError,
          path: [...layoutPath, ...schemaError.path],
          ...(dashboardId === undefined ? {} : { resource: dashboardId }),
        });
      }
    } else {
      const fallback = layout.fallback;
      if (fallback === undefined || fallback === null) {
        emit(layoutPath, 'layout-unsupported-without-fallback',
          `Layout ${JSON.stringify(layout.type)}@${JSON.stringify(layout.version)} is unsupported and has no flow@1 fallback`);
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

  // --- filters ---------------------------------------------------------------
  const filters = asArray(dashboard.filters);
  if (filters.length > PORTABLE_LIMITS.maxFiltersPerDashboard) {
    emit([...path, 'filters'], 'limit-filter-count',
      `filters contains ${filters.length} items; the maximum is ${PORTABLE_LIMITS.maxFiltersPerDashboard}`);
  }
  const filterFirstIndexById = new Map<string, number>();
  for (const [index, filter] of filters.entries()) {
    if (!isObject(filter)) continue;
    const filterPath: Path = [...path, 'filters', index];
    const filterId = stringId(filter.id);
    if (filterId !== undefined) {
      if (filterFirstIndexById.has(filterId)) {
        emit([...filterPath, 'id'], 'dashboard-duplicate-filter-id',
          `Filter id ${JSON.stringify(filterId)} duplicates filters[${filterFirstIndexById.get(filterId)}].id`);
      } else filterFirstIndexById.set(filterId, index);
    }
    const sourceQueryId = stringId(filter.sourceQueryId);
    if (sourceQueryId !== undefined) {
      const source = queriesById.get(sourceQueryId);
      if (source === undefined) {
        emit([...filterPath, 'sourceQueryId'], 'filter-source-missing',
          `Filter references unknown source query ${JSON.stringify(sourceQueryId)}`);
      } else {
        const role = queryDashboardRole(source);
        if (role === 'setup') {
          emit([...filterPath, 'sourceQueryId'], 'dashboard-setup-reference',
            `Filter references Setup-role query ${JSON.stringify(sourceQueryId)}; Dashboard v1 never executes Setup queries`);
        } else if (role !== 'filter') {
          emit([...filterPath, 'sourceQueryId'], 'filter-source-role',
            `Filter source query ${JSON.stringify(sourceQueryId)} has role ${JSON.stringify(role)}; sources require role filter`);
        }
        if (tileQueryIds.has(sourceQueryId)) {
          emit([...filterPath, 'sourceQueryId'], 'filter-source-is-tile',
            `Filter source query ${JSON.stringify(sourceQueryId)} also creates a tile; filter sources never create tiles`);
        }
      }
    }
    const parameter = typeof filter.parameter === 'string' ? filter.parameter : undefined;
    if (Array.isArray(filter.targets)) {
      // Absent targets resolve to every compatible panel tile; explicit
      // targets must each exist and declare the parameter compatibly.
      const declaredTypes = new Map<string, string>();
      for (const [targetIndex, target] of filter.targets.entries()) {
        const targetId = stringId(target);
        const tileEntry = targetId === undefined ? undefined : tilesById.get(targetId);
        if (tileEntry === undefined) {
          emit([...filterPath, 'targets', targetIndex], 'filter-target-missing',
            `Filter target ${JSON.stringify(target)} references no tile`);
          continue;
        }
        if (parameter === undefined || tileEntry.queryId === undefined) continue;
        const targetQuery = queriesById.get(tileEntry.queryId);
        if (targetQuery === undefined) continue; // already reported at the tile
        const declared = declarationsFor(targetQuery).find((entry) => entry.name === parameter);
        if (!declared) {
          emit([...filterPath, 'targets', targetIndex], 'filter-parameter-undeclared',
            `Target tile ${JSON.stringify(targetId)}'s query does not declare parameter ${JSON.stringify(parameter)}`);
        } else declaredTypes.set(tileEntry.queryId, normalizeParamType(declared.type));
      }
      if (new Set(declaredTypes.values()).size > 1) {
        emit([...filterPath, 'parameter'], 'filter-parameter-type-conflict',
          `Parameter ${JSON.stringify(parameter)} is declared with conflicting types across filter targets: ${[...new Set(declaredTypes.values())].sort().join(', ')}`);
      }
    }
    if (Object.hasOwn(filter, 'defaultValue')) {
      const defaultBytes = utf8ByteLength(canonicalJson(filter.defaultValue));
      if (defaultBytes > PORTABLE_LIMITS.maxSerializedFilterDefaultBytes) {
        emit([...filterPath, 'defaultValue'], 'limit-filter-default-bytes',
          `Serialized default value is ${defaultBytes} UTF-8 bytes; the maximum is ${PORTABLE_LIMITS.maxSerializedFilterDefaultBytes}`);
      }
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
