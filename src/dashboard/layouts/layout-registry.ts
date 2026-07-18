// The Dashboard layout registry (#280 "Dashboard layout registry and
// fallback"). Compile-time-registered, lazy-loadable layout modules — never
// arbitrary remote JavaScript plugins. A registration names one layout `id`,
// the contract `versions` it can load, and an async `load(version)` that
// resolves the concrete plugin (so a rarely-used engine's code can split out of
// the initial artifact without changing this contract).
//
// Fallback contract: `DashboardLayoutFallbackV1 = FlowLayoutV1`. When the
// primary layout cannot load (unknown engine, unsupported version, or a
// `load()` that throws), a consumer validates and renders the layout's flow@1
// fallback instead. An unsupported primary WITHOUT a valid flow@1 fallback
// fails before any execution. Fallback placement keys resolve against the same
// `dashboard.tiles[]`, so the caller simply computes the flow model from the
// same layout document (see `computeFlowLayout`, which reads a fallback host).
// Pure application logic — no DOM, no network.

import { diagnostic } from '../model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../model/workspace-diagnostics.js';
import { isFlowLayout } from '../model/workspace-semantics.js';
import { flowLayoutPlugin } from './flow-layout.js';
import type { DashboardLayoutPlugin } from './flow-layout.js';
import { grafanaGridLayoutPlugin } from './grafana-grid-layout.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** One compile-time layout registration (#280). `load` is async so an engine's
 *  implementation can be code-split; it must reject/throw only for a genuine
 *  load failure (a caller then falls back). */
export interface DashboardLayoutRegistration {
  id: string;
  versions: readonly number[];
  load(version: number): Promise<DashboardLayoutPlugin>;
}

/** The outcome of resolving a layout document against the registry. `plugin` is
 *  always a loaded plugin; `usedFallback` is true when the primary engine could
 *  not load and the flow@1 fallback was resolved instead. */
export type ResolveLayoutResult =
  | { ok: true; plugin: DashboardLayoutPlugin; usedFallback: boolean }
  | { ok: false; diagnostics: WorkspaceDiagnostic[] };

export interface DashboardLayoutRegistry {
  /** True when some registration can load `id` at `version`. */
  supports(id: unknown, version: unknown): boolean;
  /** Load one plugin by id+version, or `null` when unsupported or `load` threw. */
  load(id: string, version: number): Promise<DashboardLayoutPlugin | null>;
  /** Resolve a layout document: the primary engine when supported and loadable,
   *  else a valid flow@1 fallback, else a `dashboard-layout-load-failed`
   *  failure (#280 "unsupported primary layout without a valid flow@1 fallback
   *  fails before execution"). */
  resolve(layout: unknown, path?: (string | number)[]): Promise<ResolveLayoutResult>;
}

/** The built-in engines with synchronous, already-constructed plugin
 *  instances (#291 review F6) — the SINGLE source of truth both
 *  `resolveLayoutPluginSync` (below) and `defaultLayoutRegistry`'s
 *  registrations derive their dispatch from, so a third built-in engine is
 *  added in exactly one place instead of two independent, driftable lists
 *  (a hardcoded `if (type === 'grafana-grid')` alongside a separately
 *  maintained registration array used to silently default an unhandled new
 *  engine to flow in the sync path). `load` is registration-time-lazy only
 *  for every entry, matching flow's original contract — the plugin modules
 *  are still inlined in the one bundle (CLAUDE.md hard rule 4 forbids network
 *  code-splitting); a plugin is simply not CONSTRUCTED/imported by a caller
 *  until a Dashboard document actually requests its `type`. */
const BUILTIN_SYNC_PLUGINS: readonly DashboardLayoutPlugin[] = [flowLayoutPlugin, grafanaGridLayoutPlugin];

/** One registration for a built-in sync plugin — `load` needs no async work
 *  since the instance already exists. */
function syncRegistration(plugin: DashboardLayoutPlugin): DashboardLayoutRegistration {
  return { id: plugin.type, versions: [plugin.version], load: () => Promise.resolve(plugin) };
}

/** The always-available flow@1 registration — its `load` returns the shared,
 *  stateless plugin instance (no code-splitting needed for the built-in). */
export const flowLayoutRegistration: DashboardLayoutRegistration = syncRegistration(flowLayoutPlugin);

/** The grafana-grid@1 registration (#291): a second built-in engine. */
export const grafanaGridLayoutRegistration: DashboardLayoutRegistration = syncRegistration(grafanaGridLayoutPlugin);

/** Build a registry from a set of registrations. flow@1 is always present (a
 *  passed `flow` registration is ignored in favour of the built-in, so the
 *  fallback engine can never be shadowed). */
export function createLayoutRegistry(
  registrations: readonly DashboardLayoutRegistration[] = [],
): DashboardLayoutRegistry {
  const byId = new Map<string, DashboardLayoutRegistration>();
  byId.set('flow', flowLayoutRegistration);
  for (const registration of registrations) {
    if (registration.id !== 'flow' && !byId.has(registration.id)) byId.set(registration.id, registration);
  }

  const supports = (id: unknown, version: unknown): boolean => {
    if (typeof id !== 'string' || typeof version !== 'number') return false;
    const registration = byId.get(id);
    return !!registration && registration.versions.includes(version);
  };

  const load = async (id: string, version: number): Promise<DashboardLayoutPlugin | null> => {
    if (!supports(id, version)) return null;
    try {
      // `!`: supports() confirmed the registration exists.
      return await byId.get(id)!.load(version);
    } catch {
      // A load failure is a fallback trigger, never a thrown error to the caller.
      return null;
    }
  };

  const flowFallbackPlugin = async (layout: Record<string, unknown>): Promise<DashboardLayoutPlugin | null> => {
    const fallback = layout.fallback;
    if (isObject(fallback) && isFlowLayout(fallback.type, fallback.version)) {
      return load('flow', 1);
    }
    return null;
  };

  const resolve = async (layout: unknown, path: (string | number)[] = ['layout']): Promise<ResolveLayoutResult> => {
    if (isObject(layout)) {
      const primary = supports(layout.type, layout.version) ? await load(layout.type as string, layout.version as number) : null;
      if (primary) return { ok: true, plugin: primary, usedFallback: false };
      const fallback = await flowFallbackPlugin(layout);
      if (fallback) return { ok: true, plugin: fallback, usedFallback: true };
    }
    return {
      ok: false,
      diagnostics: [diagnostic(path, 'dashboard-layout-load-failed',
        'Dashboard layout cannot be loaded and has no valid flow@1 fallback')],
    };
  };

  return { supports, load, resolve };
}

/** The default registry: every `BUILTIN_SYNC_PLUGINS` entry, registered —
 *  flow@1 plus grafana-grid@1 (#291), the first second-engine consumer of
 *  this registry. Derived from the same table `resolveLayoutPluginSync`
 *  reads (#291 review F6), rather than a separately maintained array. */
export const defaultLayoutRegistry: DashboardLayoutRegistry =
  createLayoutRegistry(BUILTIN_SYNC_PLUGINS.map(syncRegistration));

/** Synchronous plugin resolution for pure call sites that mutate a Dashboard
 *  document but cannot await the async registry (`tile-membership.ts`,
 *  `saved-query-mutation.ts` — #291): looked up in `BUILTIN_SYNC_PLUGINS` by
 *  exact `{type, version}` match, else the flow@1 plugin. Both built-in
 *  plugins are stateless, already-constructed values (`load()` never truly
 *  defers for either — see the module doc comment above), so no async is
 *  needed to pick between them. Falling back to the flow plugin for any
 *  OTHER primary (unknown/unsupported, or a genuine flow@1 primary) matches
 *  `resolve()`'s own fallback behavior: `flowLayoutPlugin.normalize` already
 *  knows how to operate against a `fallback` when the primary isn't flow@1
 *  itself (`flowItemsHost`/`flowSurface` in flow-layout.ts). */
export function resolveLayoutPluginSync(layout: unknown): DashboardLayoutPlugin {
  if (isObject(layout)) {
    const match = BUILTIN_SYNC_PLUGINS.find((plugin) => plugin.type === layout.type && plugin.version === layout.version);
    if (match) return match;
  }
  return flowLayoutPlugin;
}
