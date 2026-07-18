// Isolated per-dashboard Dashboard-filter persistence (#303 Option B). The
// #280 viewer session initializes every filter's runtime state purely from
// `def.defaultValue`/`defaultActive` and never reads persisted values, so a
// committed filter value only lived in memory and reset to defaults on
// reload. The fix is ONE localStorage key (`state.ts`'s `KEYS.dashFilters`)
// holding a map of `dashboardId -> filterId -> { value, active }` — deliberately
// isolated from the Workbench's `asb:varValues`/`asb:filterActive` keys (a
// Dashboard filter is a distinct persisted concern, not a var-strip mirror).
//
// Pure by construction (no DOM, no globals, no storage access of its own):
// the shell (`src/ui/dashboard.ts`) is the only caller that touches
// `core/storage.js`'s `loadJSON`/`saveJSON`; this module only ever receives
// and returns already-parsed JSON values, so it stays testable without a
// storage seam of its own and satisfies the `src/dashboard/model` boundary
// rule (no `state.ts`/`core/storage.js` import here).

/** One filter's persisted runtime state. */
export interface DashboardFilterEntry {
  value: string;
  active: boolean;
}

/** One dashboard's persisted filter bag, keyed by filter `def.id`. */
export type DashboardFilterBag = Record<string, DashboardFilterEntry>;

/** The whole persisted blob, keyed by `dashboard.id`. */
export type AllDashboardFilters = Record<string, DashboardFilterBag>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const coerceValue = (value: unknown): string =>
  (typeof value === 'string' ? value : value == null ? '' : String(value));

/**
 * Defensively parse an untrusted blob (whatever `loadJSON(KEYS.dashFilters, {})`
 * returned) into one dashboard's filter bag. Tolerates a non-object blob, a
 * missing dashboard entry, and junk per-filter entries (dropped rather than
 * thrown); a present entry has its `value` coerced to a string and its
 * `active` coerced to a boolean. Returns `{}` when nothing valid is found.
 */
export function readDashboardFilterBag(all: unknown, dashboardId: string): DashboardFilterBag {
  if (!isObject(all)) return {};
  const dashboard = all[dashboardId];
  if (!isObject(dashboard)) return {};
  const out: DashboardFilterBag = {};
  for (const [filterId, entry] of Object.entries(dashboard)) {
    if (!isObject(entry)) continue; // junk entry (string/number/array/null) — drop
    out[filterId] = { value: coerceValue(entry.value), active: !!entry.active };
  }
  return out;
}

/** Shallow clone of a bag (defends both `writeDashboardFilterBag`'s input and
 *  its output against later in-place mutation by either side). */
function cloneBag(bag: DashboardFilterBag): DashboardFilterBag {
  const out: DashboardFilterBag = {};
  for (const [filterId, entry] of Object.entries(bag)) out[filterId] = { value: entry.value, active: entry.active };
  return out;
}

/**
 * Return a NEW all-dashboards map with `dashboardId`'s bag replaced by `bag`,
 * preserving every other dashboard's entry untouched. Never mutates `all` or
 * `bag`. Starts from `{}` when `all` isn't a valid object (first write, or a
 * corrupt blob).
 */
export function writeDashboardFilterBag(
  all: unknown, dashboardId: string, bag: DashboardFilterBag,
): AllDashboardFilters {
  const out: AllDashboardFilters = {};
  if (isObject(all)) {
    for (const [id, value] of Object.entries(all)) {
      if (id !== dashboardId) out[id] = value as DashboardFilterBag;
    }
  }
  out[dashboardId] = cloneBag(bag);
  return out;
}

/** A stable signature for a bag (sorted-key JSON) so a caller can skip a
 *  redundant write when nothing has actually changed since the last publish. */
export function filterBagSignature(bag: DashboardFilterBag): string {
  const ids = Object.keys(bag).sort();
  return JSON.stringify(ids.map((id) => [id, bag[id].value, bag[id].active]));
}
