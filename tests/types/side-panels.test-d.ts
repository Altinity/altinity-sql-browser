// Compile-time invariants for src/core/side-panels.ts's derived pane unions
// (PR #600 review, #587 finding 2). Like tests/types/state.test-d.ts (this
// file's own precedent — see ITS header comment), this file is NEVER
// executed: vitest's include glob is `tests/unit/**/*.test.{js,ts}`, which
// does not reach `tests/types/`. It IS type-checked, though — `tsconfig.json`
// `include` names `tests/types/**/*.ts` explicitly, and `npm run check:types`
// (`tsc --noEmit`, wired into `pretest`) walks every file `include` names.
// Confirmed by hand for this change: reverting `UpperPanelId`/`LowerPanelId`
// to their old hand-written literals, plus adding a fifth manifest row,
// makes `tsc --noEmit` fail on the two assertions below (see the phase
// report's sabotage-check section).
//
// `UpperPanelId`/`LowerPanelId` are DERIVED from `SIDE_PANELS`'s `pane`
// column now, not hand-listed a second time — but a derivation can still
// silently stop covering every id (e.g. a manifest row whose `pane` typos to
// a value not covered by either) or stop being disjoint (e.g. a row present
// in both `Extract` results). Two positive assertions below pin both
// invariants directly against the LIVE manifest type, via a never-CALLED
// function each — TypeScript type-checks a function's body regardless of
// whether anything calls it, so the `void` reference below (just to avoid an
// "unused" complaint from a future linter; nothing in this repo's current
// toolchain actually requires it) is enough to make each assertion live.

import type { LowerPanelId, SidePanelId, UpperPanelId } from '../../src/core/side-panels.js';

// Coverage: every `SidePanelId` the live manifest can produce must be
// assignable to `UpperPanelId | LowerPanelId` — i.e. the two pane unions
// TOGETHER cover every manifest id, with none left stranded in neither.
// If a manifest row's pane were ever mis-derived (or the unions reverted to
// a hand-written literal list that fell behind a new row), some member of
// `SidePanelId` would not be assignable to the narrower union below and this
// function would fail to compile.
function assertPaneUnionsCoverEveryManifestId(id: SidePanelId): UpperPanelId | LowerPanelId {
  return id;
}
void assertPaneUnionsCoverEveryManifestId;

// Disjointness: no id can be a member of BOTH `UpperPanelId` and
// `LowerPanelId` — i.e. neither pane union admits an id that belongs to the
// other pane. `Extract<UpperPanelId, LowerPanelId>` is the set of ids the two
// unions share; it must be exactly `never`. If it were not, the parameter
// below would carry that (non-`never`) shared-id type, and returning it
// where `never` is declared would fail to compile.
function assertPaneUnionsAreDisjoint(sharedId: Extract<UpperPanelId, LowerPanelId>): never {
  return sharedId;
}
void assertPaneUnionsAreDisjoint;
