// #587 — the side-panel manifest. Pure, no DOM, no globals: the ONE table both
// panes' registries (`ui/side-panel-registry.ts`) and the persisted-key load
// boundary (`state.ts`) read ids/panes/persisted keys FROM, rather than each
// hand-listing its own copy (the duplication #587 exists to remove).
//
// Two independent panes sit in the wide sidebar SIMULTANEOUSLY (a splitter
// between them, not a tab switcher over one): 'upper' (Databases | Dashboards,
// #426) and 'lower' (Library | History). Exactly one panel is active PER PANE
// — never "exactly one of four" globally, which would blank half the sidebar.
//
// Only the 'lower' pane persists its active panel (`asb:sidePanel`,
// unchanged key — #459). 'upper' is deliberately session-only (state.ts
// documents why: a persisted role would break "default to Databases on a
// fresh session"). So only 'lower' entries carry a `persistedKey`.

/** Which pane a panel lives in — a splitter-separated region of the wide
 *  sidebar, NOT `AppState.mobileTab`'s narrow-viewport axis (a separate,
 *  session-only choice that selects between these same two panes; see
 *  `ui/side-panel-registry.ts`'s own small `MOBILE_PANES` table). */
export type SidePanelPane = 'upper' | 'lower';

interface SidePanelModel {
  readonly id: string;
  readonly pane: SidePanelPane;
  /** The value written to `localStorage` under `KEYS.sidePanel` (`asb:sidePanel`)
   *  for this panel — present ONLY for 'lower' entries. `'library'` persists as
   *  `'saved'`: #427 renamed the visible label, not the stored string, since
   *  migrating it would discard every user's persisted lower-pane choice for no
   *  behavioural gain. */
  readonly persistedKey?: string;
}

/**
 * THE manifest — the one place `id`, `pane`, and the persisted-key mapping are
 * declared. Every id/pane/key type below is DERIVED from this array via
 * `typeof`, not hand-written beside it (#587 AC1/AC4: one authority, not two
 * that can drift).
 */
export const SIDE_PANELS = [
  { id: 'databases', pane: 'upper' },
  { id: 'dashboards', pane: 'upper' },
  { id: 'library', pane: 'lower', persistedKey: 'saved' },
  { id: 'history', pane: 'lower', persistedKey: 'history' },
] as const satisfies readonly SidePanelModel[];

// A `SidePanelModel[]`-typed VIEW of the same array, used by every lookup
// below — `SIDE_PANELS` itself keeps its precise `as const` literal type so
// `typeof SIDE_PANELS` can derive the id/key unions; indexing into the union
// of literal element types directly (e.g. `SIDE_PANELS.find(...).persistedKey`)
// would not type-check, since not every element has that property.
const PANELS: readonly SidePanelModel[] = SIDE_PANELS;

export type SidePanelId = (typeof SIDE_PANELS)[number]['id'];
// `UpperPanelId`/`LowerPanelId` used to be hand-written literal unions
// (`Extract<SidePanelId, 'databases' | 'dashboards'>` etc.) — a SECOND
// authority listing the same ids by hand, so adding a manifest row above
// silently failed to extend either (PR #600 review, #587 finding 2: no test
// caught it, because the "extended manifest" tests only exercise runtime
// helpers over copied arrays, never these two TYPES). Both are now derived
// from the manifest's own `pane` column: `PanelSpec` is the precise
// element-union type `SIDE_PANELS` carries, and `PanelIdInPane<P>` extracts
// the `id` of every element whose `pane` is `P` — so a new row's pane
// assignment is the only thing that decides which union it joins, with no
// second list to fall out of sync.
//
// `tests/types/side-panels.test-d.ts` pins coverage and disjointness of the
// two derived unions AGAINST TODAY'S MANIFEST — not against a silent revert
// to hand-written literals in isolation (PR #600 review, #587 finding 3): for
// the current four-row manifest, hand-written `Extract<SidePanelId,
// 'databases' | 'dashboards'>` literals and this derivation produce
// IDENTICAL types, so that type-level test alone stays green either way. It
// only goes red once a manifest row is added without extending whichever
// union it should have joined — proving detection-after-expansion, not
// detection-of-removal. Catching a plain revert with no accompanying
// manifest change is `side-panel-source-contract.test.ts`'s job instead — its
// "no literal panel-id allowlist in a type alias" check is a source-level,
// best-effort regex over this file, not a type-level proof.
type PanelSpec = (typeof SIDE_PANELS)[number];
type PanelIdInPane<P extends SidePanelPane> = Extract<PanelSpec, { pane: P }>['id'];
export type UpperPanelId = PanelIdInPane<'upper'>;
export type LowerPanelId = PanelIdInPane<'lower'>;
/** The `asb:sidePanel` persisted-value vocabulary — DERIVED from the manifest's
 *  `persistedKey` column, not a second hand-written `'saved' | 'history'`
 *  union declared beside it. `Extract` (rather than indexing the whole
 *  element union directly) narrows to only the rows that HAVE a
 *  `persistedKey` first — the upper two rows' literal types don't carry that
 *  property at all, so indexing the unfiltered union would not type-check. */
export type SidePanelKey = Extract<(typeof SIDE_PANELS)[number], { persistedKey: string }>['persistedKey'];

/** The lower pane's panel ids, in manifest order — DERIVED by filtering
 *  `specs` (default: the live manifest) rather than hand-listed a second time.
 *  Exported as a function (not only a precomputed constant) so a test can
 *  prove the derivation by feeding it a manifest with an extra panel and
 *  observing the output grow (#587 AC4's falsifiability requirement) without
 *  mutating the real, frozen `SIDE_PANELS`. */
export function lowerPanelIdsOf(specs: readonly SidePanelModel[] = PANELS): string[] {
  return specs.filter((spec) => spec.pane === 'lower').map((spec) => spec.id);
}

/** The `asb:sidePanel` persisted-value vocabulary, DERIVED from `specs` (same
 *  derivation contract as `lowerPanelIdsOf`). */
export function sidePanelKeysOf(specs: readonly SidePanelModel[] = PANELS): string[] {
  return specs.filter((spec) => spec.persistedKey !== undefined).map((spec) => spec.persistedKey as string);
}

export const LOWER_PANEL_IDS: readonly LowerPanelId[] = lowerPanelIdsOf() as readonly LowerPanelId[];
export const SIDE_PANEL_KEYS: readonly SidePanelKey[] = sidePanelKeysOf() as readonly SidePanelKey[];
export const UPPER_PANEL_IDS: readonly UpperPanelId[] =
  PANELS.filter((spec) => spec.pane === 'upper').map((spec) => spec.id) as readonly UpperPanelId[];

/** Lower panel id -> its persisted value. The reverse of `decodeSidePanelKey`. */
export function sidePanelKeyFor(id: LowerPanelId): SidePanelKey {
  // `!`: every member of `LOWER_PANEL_IDS` (the only values `LowerPanelId`
  // admits) has a manifest row with a `persistedKey`, by construction of the
  // manifest above.
  return PANELS.find((spec) => spec.id === id)!.persistedKey as SidePanelKey;
}

/**
 * Fail-closed decode of the persisted `asb:sidePanel` raw value, applied ONCE
 * at the state-load boundary (`state.ts`): anything other than a recognized
 * `persistedKey` — missing, corrupt, or an obsolete/future value — resolves to
 * `'saved'` (Library), the documented default, rather than propagating an
 * unrecognized string for every consumer to compare against independently.
 *
 * Returns a `SidePanelKey`, not a `LowerPanelId` — `state.sidePanel` holds the
 * PERSISTED vocabulary directly (so a write is `prefs.save('sidePanel', v)`
 * with no re-encoding step), matching today's shape. Downgrade-safety (#587
 * R2.9): the registry id `'library'` is never assigned to `state.sidePanel`
 * or written to storage — only `'saved'`/`'history'` ever are, so a reverted
 * build reads back a value it already understood.
 */
export function decodeSidePanelKey(raw: unknown): SidePanelKey {
  const spec = PANELS.find((s) => s.pane === 'lower' && s.persistedKey === raw);
  return spec ? (spec.persistedKey as SidePanelKey) : 'saved';
}

/** Persisted value -> lower panel id (the registry's own vocabulary). */
export function lowerIdForKey(key: SidePanelKey): LowerPanelId {
  // `!`: every `SidePanelKey` value originates from a manifest `persistedKey`
  // (see the type derivation above), so the reverse lookup always finds a row.
  return PANELS.find((spec) => spec.persistedKey === key)!.id as LowerPanelId;
}
