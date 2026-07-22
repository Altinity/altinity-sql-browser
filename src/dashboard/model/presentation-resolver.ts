// The one canonical presentation resolver (#280 "Presentation variants and
// tile overrides"). Shared by Workbench authoring preview, the Dashboard
// viewer, import validation, tests, and future AI/MCP callers — every consumer
// resolves a tile's effective panel through THIS function so the RFC 7396
// rules live in exactly one place. Pure: the Spec schema service is injected
// with the generated default.
//
// Resolution order is exact (#280):
//   SavedQuery base panel
//     -> apply selected named variant patch
//     -> apply tile-local override patch
//     -> validate final resolved panel (structural, plus result-column role
//        validation WHEN result metadata is available).
//
// Normative rules enforced here: arrays replace atomically and `null` deletes
// (both from `applyMergePatch`); deleting a REQUIRED property fails final
// validation; neither a variant nor an override may change `panel.cfg.type`;
// a selected variant NAME must exist (no silent fallback); a MISSING selected
// variant uses `defaultVariant` when valid, else the base panel only.

import { applyMergePatch } from './json-merge-patch.js';
import { queryDashboardRole } from './workspace-semantics.js';
import { diagnostic, sortDiagnostics } from './workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from './workspace-diagnostics.js';
import { cloneJson } from '../../core/saved-query.js';
import { querySpecSchemaService } from '../../core/spec-schema.js';
import type { SpecSchemaService } from '../../core/spec-schema.js';
import { panelCfgValid } from '../../core/panel-cfg.js';
import type { Column } from '../../core/panel-cfg.js';

type Path = (string | number)[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const cfgType = (panel: unknown): string | undefined => {
  if (!isObject(panel) || !isObject(panel.cfg)) return undefined;
  return typeof panel.cfg.type === 'string' ? panel.cfg.type : undefined;
};

/** `resolvePresentation`'s input. `resultColumns` enables the semantic
 *  result-column role check; omit it (authoring without a live result) for a
 *  structural-only validation. `path` prefixes the diagnostics so a caller can
 *  place them inside a larger document (e.g. `['dashboard','tiles',3]`). */
export interface ResolvePresentationInput {
  query: unknown;
  tile: unknown;
  resultColumns?: Column[] | null;
  schemaService?: SpecSchemaService;
  path?: Path;
}

export type ResolvePresentationResult =
  | { ok: true; panel: Record<string, unknown> }
  | { ok: false; diagnostics: WorkspaceDiagnostic[] };

/** Resolve one tile's effective panel from its saved query, or return the
 *  sorted diagnostics that make the resolution invalid. */
export function resolvePresentation(input: ResolvePresentationInput): ResolvePresentationResult {
  const { query, tile, resultColumns, path = [] } = input;
  const schemaService = input.schemaService ?? querySpecSchemaService;
  const resource = isObject(tile) && typeof tile.id === 'string' ? tile.id : undefined;
  const fail = (diagnostics: WorkspaceDiagnostic[]): ResolvePresentationResult =>
    ({ ok: false, diagnostics: sortDiagnostics(diagnostics) });

  const spec = isObject(query) ? query.spec : undefined;
  // `view: 'table'` predates the first-class panel form but is still an
  // explicit saved presentation choice. Preserve it as a Table base before
  // deriving any runtime panel: otherwise resolvePanel() sees no renderer and
  // correctly auto-detects a chart, KPI, or Logs panel instead. A panel object
  // without its own `cfg` is metadata, not an explicit renderer, so retain
  // that metadata while supplying the compatibility Table cfg. An existing
  // cfg (including a malformed/null one) remains authoritative and is left to
  // normal validation rather than silently repaired.
  const persistedPanel = isObject(spec) && isObject(spec.panel)
    ? cloneJson(spec.panel)
    : {};
  const hasExplicitCfg = isObject(spec) && isObject(spec.panel) && Object.hasOwn(spec.panel, 'cfg');
  const basePanel = isObject(spec) && spec.view === 'table' && !hasExplicitCfg
    ? { ...persistedPanel, cfg: { type: 'table' } }
    : persistedPanel;
  const baseType = cfgType(basePanel);
  const dashboard = isObject(spec) && isObject(spec.dashboard) ? spec.dashboard : undefined;
  const variants = dashboard && isObject(dashboard.variants) ? dashboard.variants : undefined;

  const presentation = isObject(tile) && isObject(tile.presentation) ? tile.presentation : undefined;
  const selectedVariant = presentation && typeof presentation.variant === 'string' ? presentation.variant : undefined;

  let variantPatch: unknown;
  if (selectedVariant !== undefined) {
    // A persisted variant name that no longer exists FAILS — no silent fallback.
    if (!(variants && Object.hasOwn(variants, selectedVariant))) {
      return fail([diagnostic([...path, 'presentation', 'variant'], 'presentation-variant-missing',
        `Selected variant ${JSON.stringify(selectedVariant)} is not declared by the query`, resource)]);
    }
    variantPatch = variants[selectedVariant];
  } else {
    // No variant selected: use defaultVariant when it names a real variant.
    const defaultVariant = dashboard && typeof dashboard.defaultVariant === 'string' ? dashboard.defaultVariant : undefined;
    if (defaultVariant !== undefined && variants && Object.hasOwn(variants, defaultVariant)) {
      variantPatch = variants[defaultVariant];
    }
  }

  let resolved: unknown = basePanel;
  if (variantPatch !== undefined) resolved = applyMergePatch(resolved, variantPatch);
  if (presentation && Object.hasOwn(presentation, 'override')) {
    resolved = applyMergePatch(resolved, presentation.override);
  }

  // Neither a variant nor an override may change the base renderer type. A
  // patch that set a different `cfg.type` — or deleted it — fails here.
  const resolvedType = cfgType(resolved);
  if (baseType !== undefined && resolvedType !== baseType) {
    return fail([diagnostic([...path, 'presentation', 'cfg', 'type'], 'presentation-renderer-type-change',
      `Resolved panel changes the renderer type from ${JSON.stringify(baseType)} to ${JSON.stringify(resolvedType)}`, resource)]);
  }

  // Final resolved-panel validation — the same structural check a normal
  // saved-query panel gets. Only the `panel.*` diagnostics are relevant.
  const structural = schemaService.validate({ panel: resolved })
    .filter((error) => error.path[0] === 'panel')
    .map((error): WorkspaceDiagnostic => ({
      path: [...path, 'presentation', 'resolved', ...error.path],
      severity: 'error', code: error.code, message: error.message,
      ...(resource === undefined ? {} : { resource }),
    }));
  if (structural.length) return fail(structural);

  // Result-column role validation, only when result metadata is available.
  if (resultColumns && isObject(resolved) && isObject(resolved.cfg)
    && !panelCfgValid(resolved.cfg, resultColumns, schemaService)) {
    return fail([diagnostic([...path, 'presentation', 'resolved', 'cfg'], 'presentation-resolved-invalid-roles',
      'Resolved panel roles are not valid for the available result columns', resource)]);
  }

  return { ok: true, panel: resolved as Record<string, unknown> };
}

/** `resolveDashboardPresentations`'s input. */
export interface ResolveDashboardPresentationsInput {
  dashboard: unknown;
  queries: readonly unknown[];
  schemaService?: SpecSchemaService;
  path?: Path;
  resultColumnsByTileId?: Record<string, Column[] | null | undefined>;
}

/** Resolve and validate every panel tile's presentation, returning the sorted
 *  diagnostics (empty when all resolve). Non-panel tiles and tiles whose query
 *  does not resolve are skipped — those are reported by structural/reference
 *  validation, not here. */
export function resolveDashboardPresentations(
  input: ResolveDashboardPresentationsInput,
): WorkspaceDiagnostic[] {
  const { dashboard, queries, schemaService, path = [], resultColumnsByTileId } = input;
  if (!isObject(dashboard)) return [];
  const byId = new Map<string, unknown>();
  for (const query of queries) {
    if (isObject(query) && typeof query.id === 'string' && !byId.has(query.id)) byId.set(query.id, query);
  }
  const tiles = Array.isArray(dashboard.tiles) ? dashboard.tiles : [];
  const out: WorkspaceDiagnostic[] = [];
  tiles.forEach((tile, index) => {
    if (!isObject(tile) || typeof tile.queryId !== 'string') return;
    const query = byId.get(tile.queryId);
    if (!isObject(query) || queryDashboardRole(query) !== 'panel') return;
    const result = resolvePresentation({
      query, tile, schemaService, path: [...path, 'tiles', index],
      resultColumns: typeof tile.id === 'string' ? resultColumnsByTileId?.[tile.id] : undefined,
    });
    if (!result.ok) out.push(...result.diagnostics);
  });
  return sortDiagnostics(out);
}
