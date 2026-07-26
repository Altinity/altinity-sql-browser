// Isolated per-dashboard Dashboard-variable persistence (#303 Option B). The
// #280 viewer session initialized every variable's runtime state purely from
// its definition and never read persisted values, so a committed value only
// lived in memory and reset on reload. The fix is ONE localStorage key
// (`state.ts`'s `KEYS.dashFilters`) holding a map of
// `dashboardId -> variableId -> { value, active }` — deliberately isolated from
// the Workbench's `asb:varValues`/`asb:filterActive` keys (a Dashboard variable
// is a distinct persisted concern, not a var-strip mirror).
//
// #459 renamed this module and its exports from "filter" to "variable" but NOT
// the persisted key: `'asb:dashFilters'` is the name real saved data already
// lives under, and moving it would discard every stored selection. See
// `KEYS.dashFilters` in `state.ts` for that decision.
//
// Pure by construction (no DOM, no globals, no storage access of its own):
// the shell (`src/ui/dashboard.ts`) is the only caller that touches
// `core/storage.js`'s `loadJSON`/`saveJSON`; this module only ever receives
// and returns already-parsed JSON values, so it stays testable without a
// storage seam of its own and satisfies the `src/dashboard/model` boundary
// rule (no `state.ts`/`core/storage.js` import here).

/** One variable's persisted runtime state. `value` is a plain string for a
 *  single-selection variable, or a string array for a committed multiselect
 *  (#189) — arrays round-trip through localStorage as arrays rather than
 *  being joined/stringified. */
export interface DashboardVariableEntry {
  value: string | string[];
  active: boolean;
}

/** One dashboard's persisted variable bag, keyed by the variable name. */
export type DashboardVariableBag = Record<string, DashboardVariableEntry>;

/** The whole persisted blob, keyed by `dashboard.id`. */
export type AllDashboardVariables = Record<string, DashboardVariableBag>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const coerceScalar = (value: unknown): string =>
  (typeof value === 'string' ? value : value == null ? '' : String(value));

/** Persisted JSON is untrusted: a scalar coerces via the existing string
 *  rule; an array (a committed multiselect, #189) coerces to a NEW array
 *  containing only its string elements — non-string/nullish elements are
 *  dropped rather than stringified, so one junk element can't corrupt the
 *  rest of an otherwise-valid selection. An empty-string element is a valid
 *  string and is preserved. */
const coerceValue = (value: unknown): string | string[] =>
  (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : coerceScalar(value));

/**
 * Defensively parse an untrusted blob (whatever `loadJSON(KEYS.dashFilters, {})`
 * returned) into one dashboard's variable bag. Tolerates a non-object blob, a
 * missing dashboard entry, and junk per-variable entries (dropped rather than
 * thrown); a present entry has its `value` coerced to a string and its
 * `active` coerced to a boolean. Returns `{}` when nothing valid is found.
 */
export function readDashboardVariableBag(all: unknown, dashboardId: string): DashboardVariableBag {
  if (!isObject(all)) return {};
  const dashboard = all[dashboardId];
  if (!isObject(dashboard)) return {};
  const out: DashboardVariableBag = {};
  for (const [variableId, entry] of Object.entries(dashboard)) {
    if (!isObject(entry)) continue; // junk entry (string/number/array/null) — drop
    out[variableId] = { value: coerceValue(entry.value), active: !!entry.active };
  }
  return out;
}

/** Shallow clone of a bag (defends both `writeDashboardVariableBag`'s input and
 *  its output against later in-place mutation by either side). */
function cloneBag(bag: DashboardVariableBag): DashboardVariableBag {
  const out: DashboardVariableBag = {};
  for (const [variableId, entry] of Object.entries(bag)) {
    out[variableId] = { value: Array.isArray(entry.value) ? [...entry.value] : entry.value, active: entry.active };
  }
  return out;
}

/**
 * Return a NEW all-dashboards map with `dashboardId`'s bag replaced by `bag`,
 * preserving every other dashboard's entry untouched. Never mutates `all` or
 * `bag`. Starts from `{}` when `all` isn't a valid object (first write, or a
 * corrupt blob).
 */
export function writeDashboardVariableBag(
  all: unknown, dashboardId: string, bag: DashboardVariableBag,
): AllDashboardVariables {
  const out: AllDashboardVariables = {};
  if (isObject(all)) {
    for (const [id, value] of Object.entries(all)) {
      if (id !== dashboardId) out[id] = value as DashboardVariableBag;
    }
  }
  out[dashboardId] = cloneBag(bag);
  return out;
}

/** A stable signature for a bag (sorted-key JSON) so a caller can skip a
 *  redundant write when nothing has actually changed since the last publish. */
export function variableBagSignature(bag: DashboardVariableBag): string {
  const ids = Object.keys(bag).sort();
  return JSON.stringify(ids.map((id) => [id, bag[id].value, bag[id].active]));
}
