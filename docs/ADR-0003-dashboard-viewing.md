# ADR-0003: Dashboard viewing and unified `/sql` routes

- **Status:** Accepted; detached-snapshot decision superseded by #407 on
  2026-07-23; surface lifecycle amended by #425 and surface NAVIGATION amended by
  #426, both 2026-07-25; the #447 phase-2 compound-type exclusion narrowed by #468
  on 2026-07-26 and its Bool-control decision amended by #530 on 2026-07-29
  (see the addenda)
- **Date:** 2026-07-18; revised 2026-07-23, 2026-07-25, 2026-07-26, 2026-07-29
- **Context tracking:** roadmap #68; #288, #302, #406, #407, #425, #447, #457,
  #468, #530

## Context

The original Dashboard viewing design separated an editable primary workspace
from durable read-only snapshots. Opening a view created a second workspace
record through a one-time IndexedDB handoff and opened a separate
`/sql/dashboard` application tab. That model duplicated local data, required
parallel stores and credential/state transport, and made view mode diverge from
the workspace users were actually editing.

Multi-workspace persistence (#406) established an immutable human-readable
workspace `key` as the canonical URL identity. Unified routing (#407) uses that
identity for both application surfaces and treats View/Edit as presentation
modes over one live workspace.

## Decision

Workbench and Dashboard are surfaces of the same `/sql` application:

```text
/sql?ws=clickhouse_operations
/sql?ws=clickhouse_operations&surface=dashboard
/sql?ws=clickhouse_operations&surface=dashboard&mode=view
```

The pure route contract owns `ws`, `surface`, and `mode`:

- absent or unknown `surface` means Workbench;
- `surface=dashboard` means Dashboard;
- Dashboard edit is the default, so `mode=edit` is accepted but omitted from
  canonical URLs;
- `mode=view` renders the same current workspace dashboard without mutation
  controls;
- unrelated parameters are preserved until their owning flow consumes them.

An explicit `ws` resolves exactly that workspace key. Failure renders
**Workspace not found** and never falls back. An implicit `/sql` open resolves
the last-used workspace, deterministically selects an existing workspace when
needed, or provisions the default workspace, then rewrites the URL with its
canonical key.

Surface changes use same-tab `history.pushState()` so browser Back remains
useful. View/Edit changes use `history.replaceState()` so presentation toggles
do not pollute history. The Dashboard header exposes
`[Workspace | Dashboard] [View | Edit]`.

Each workspace owns zero or one dashboard:

- edit mode shows **Create dashboard** when none exists, but visiting does not
  create one;
- view mode shows **This workspace has no dashboard** and executes no queries;
- view mode registers no reorder, resize, delete, layout-persistence, or other
  authoring paths.

## Superseded implementation

The following original ADR decisions are intentionally retired:

- pathname-based `/sql/dashboard` bootstrapping;
- default new-tab Workbench/Dashboard navigation;
- `DashboardOpenSource` current-workspace/session-bundle discrimination;
- the `st` one-time state transport parameter;
- `asb-dashboard-handoff` and `asb-dashboard-views`;
- detached workspace materialization and retention;
- **Open for viewing…** snapshot creation;
- store-membership-based edit/view discrimination;
- dashboard-specific cross-tab credential handoff.

There is no migration requirement for those development-era URLs or IndexedDB
records.

## Consequences

- Edit and view always observe the same canonical workspace/dashboard data.
- A bookmarked view remains read-only in presentation, not authorization; the
  local user can switch back to edit.
- Workbench and Dashboard share authentication, configuration, workspace
  refresh, import/export, and query execution without parallel bootstrap
  applications.
- Dashboard route resources are disposed when switching surfaces or rebuilding
  the current surface; the Workbench shell likewise disposes signal and media
  listeners before remounting.
- OAuth uses one `/sql` redirect URI. Callback cleanup retains route parameters
  while removing only OAuth callback parameters.

## Addendum (#425, 2026-07-25): surfaces are hosts in one persistent shell

The consequence above — "Dashboard route resources are disposed when switching
surfaces or rebuilding the current surface; the Workbench shell likewise disposes
signal and media listeners before remounting" — described a model where each
surface owned the whole page and every switch was a dispose-and-remount. #425
amends it, because a Dashboard must own the complete editor-plus-results area
*while the left sidebar stays visible*, and returning to the Query surface must
not reconstruct it.

What changes:

- One persistent shell (`ui/app-shell.ts`) owns `#root`: a header slot, the
  sidebar, the mobile nav, and two sibling hosts — the query column
  (`ui/workbench/workbench-shell.ts`) and the Dashboard. Exactly one host is
  exposed; the hidden one keeps its DOM and its state and contributes no layout.
- The query column is mounted once per signed-in workspace. A surface switch no
  longer disposes it and no longer calls `workbench.destroy()` — that aborts the
  in-flight request and issues `KILL QUERY`, and a presentation change must never
  cancel the query in the editor. Real end-of-life events (a workspace switch,
  workspace-not-found/loading, sign-out) still tear everything down, and every
  path that replaces `#root` wholesale must forget the shell handle so the next
  render re-mounts.
- The Dashboard surface is still disposed when left: its viewer session, window
  listeners, and pending focus work go, and its host is emptied — the host
  outlives the surface, so a disposed Dashboard must not leave DOM behind.
- Each surface still builds its own header, now into the shell's slot, so only
  one header is ever mounted.

Selected-Dashboard state (`application/main-surface.ts`) is session state: which
Dashboard, in which mode, with an optional focus target, identified only by
`DashboardDocumentV1.id` and never by collection position. It is not persisted —
`StoredWorkspaceV3` gains no `activeDashboardId`/`defaultDashboardId` — is cleared
on sign-out, and is re-validated against every committed workspace, falling back
to Query mode rather than silently retargeting another Dashboard. It is also the
single writer of the route's `surface`/`mode`, so the URL is always derived from
it. **Routes are unchanged:** the URL still carries only `ws`, `surface`, and
`mode`, which is why Back/Forward inside the Dashboard surface deliberately
preserves the explicit selection instead of re-deriving one from the
compatibility selector.

Two consequences worth recording:

- Edit mode renders the same single filter bar as View, so #425's "focus the
  filter editor/control in Edit mode" collapses to one control per filter — not a
  dropped requirement.
- The schema tree is no longer refetched on a Dashboard→Workbench round trip
  (`catalog.loadSchema()` moved to the shell's one-time mount). The #343
  external-change refresh path still covers staleness.

## Addendum (#426, 2026-07-25): navigation between surfaces moved to the sidebar

#425 left the header's `SQL Browser | Dashboard` pair as the way between surfaces.
That pair could only ever reach ONE Dashboard, so #426 replaces it with the
upper-left `Databases | Dashboards` tree and makes the brand zone
non-interactive. Three lifecycle consequences follow from that move.

- **Surface navigation is no longer header-owned.** The tree is the entry point to
  a Dashboard (by stable id), and a single icon-first **Back to query** control at
  the start of the Dashboard's one compact toolbar is the way out. #437 had removed
  that control precisely because the header pair covered it; with the pair gone it
  has to exist, or a phone — where the mobile rules drop the sidebar and the bottom
  nav for a full-bleed Dashboard — would offer no route back at all.
- **Repeated member navigation does not restart the surface.** #425 treated a
  focus target as a one-shot render request, so delivering one rebuilt the viewer
  session and re-ran the Dashboard. The tree makes that a normal operation, so the
  existing generation-stamped `SurfaceCommandPort` gains
  `focusMember(): 'ok' | 'pending' | 'missing'` and `openDashboard` uses it as a
  same-id/same-mode fast path. `pending` is not a failure — it means "not
  deliverable in place right now" (a curated filter before the opening wave
  settles, a superseded port, or a node the Dashboard's own tile search has
  detached) and the caller falls back to the normal render transition, which
  delivers focus at the deterministic point the node is stable.
- **Selection state distinguishes styling from delivery.** `MainSurfaceState`'s
  Dashboard branch splits #425's single `focus` field into `currentMember` (which
  member the tree marks, retained until another member/Dashboard/query is opened,
  preserved across a View/Edit switch) and `pendingFocus` (a DOM delivery still
  owed, consumed exactly once). Both are re-validated against every committed
  workspace, per member collection, so a removed tile or filter clears its own
  marking without disturbing the other.

Tree UI state (expansion, search, scroll, keyboard row) is session state keyed by
immutable workspace id, never persisted and never part of `StoredWorkspaceV3`, and
is pruned against committed truth on every projection.

## Addendum (#427, 2026-07-25): ownership is a reference, not a flag

#424 through #426 left one query reachable from several places at once, because
the Workbench star WAS Dashboard membership. #427 replaces that with an ownership
invariant: every panel tile and every curated filter references a dedicated
saved-query copy that exactly one member owns, and a query no member references
is a Library query. Four decisions are worth recording.

- **Ownership is derived, never stored.** The only inputs are
  `dashboards[].tiles[].queryId` and `dashboards[].filters[].sourceQueryId`
  (`dashboard/model/query-ownership.ts`). A reverse pointer on the query would be
  a second source of truth that can disagree with the references execution
  actually reads, so there is none — and the Library is a projection of committed
  Dashboard content, repainted from the same revision signal the tree uses.
- **The versioned boundary carries the invariant, not the document shape.**
  `stored-workspace-v4` is structurally v3 with a new `storageVersion` and a
  larger query bound; a two-owner document still SATISFIES the schema and is
  rejected by whole-workspace semantic validation
  (`dashboard-query-multiple-owners`). The version exists so an older build fails
  closed on a record it would otherwise misread as shareable, and so the one-time
  cloning migration has a boundary to run at. That rule deliberately does not
  guard portable bundles: #427 requires a readable legacy bundle with shared
  references to be NORMALIZED on import, not refused.
- **Migration ids are derived, because the migration runs inside a pure read.**
  It executes in `decodeStoredWorkspaceJson`, which `WorkspaceRepository.list()`
  performs on every record without writing. A generated id there would make two
  decodes of identical bytes disagree, so `workspaceToken`/`queryToken` would
  differ on every refresh: the "nothing changed" fast path would never fire, and
  every window focus would detach the open owned-query tab and re-run every tile
  query. Ids are therefore a pure function of the member the copy belongs to,
  with deterministic escalation on collision.
- **A curated filter has a source query; a plain filter is a different kind.**
  #427's text asks for `sourceQueryId` to become required, but a From/To pair and
  a free-text search box have no option list and therefore no lossless source to
  derive — and `core/time-range.ts` only pairs filters that have NO source, so
  requiring one would make an authored time range impossible to persist and would
  invalidate 11 filters across five shipped example bundles. The invariant
  implemented is therefore "curated ⇒ dedicated single-owner source"; plain
  filters remain valid and own nothing. Making them a distinct persisted control
  kind is deferred to its own issue.

## Addendum (#447, 2026-07-26): a Dashboard variable is inferred, not authored

Phase 1 of #447 removes the curated-filter/option-provider model outright rather
than adapting it. The decisions that changed:

- **A variable's identity is its exact name, and nothing is persisted about it.**
  A Dashboard's variables are derived from the `{name:Type}` placeholders in the
  queries its panel tiles own, aggregated by exact, case-sensitive name. There is
  no filter id, no label, no `sourceQueryId`, no `targets` list and no selection
  mode; a variable binds automatically to every panel query on the Dashboard that
  declares that name. The only persisted state is
  `dashboards[].variableConfigs[name] = { sql, lastKnownType? }` — optional
  Dashboard-local option SQL. `lastKnownType` is display-only, so an orphaned
  configuration can still show a type; a live declaration always wins.

- **This supersedes the "curated filter has a source query; a plain filter is a
  different kind" note above.** That note deferred making plain filters a distinct
  persisted control kind. The question is now moot in the other direction: there
  is no persisted control kind at all. `core/time-range.ts` still pairs only
  variables WITHOUT option SQL — the same rule, expressed against the surviving
  concept — and the 11 filters across five shipped example bundles are dropped by
  the read-time migration rather than being made to satisfy a stricter invariant.

- **Ownership loses its one legitimate multi-owner case.** #427 allowed several
  owners when every one was a curated filter of the same Dashboard, because one
  option-source query legitimately supplied several filters and splitting it
  re-created #359's duplicate-provider failure. A variable's option SQL lives on
  the Dashboard document, so a panel tile is now the only member that references a
  query and "shared" is unconditionally invalid.

- **Delete before build, and no compatibility branch.** The provider runtime, the
  `filter` role, array/multiselect controls and the persisted filter model are
  removed in the same change that introduces inference, so no code path can serve
  both models at once. A stored document carrying the removed `filter` role is
  reported unsupported and recreated rather than migrated: the representation was
  experimental, and retaining a decode path for it would be exactly the
  compatibility branch the issue forbids.

- **The Dashboard sidebar now reaches an editor port, which
  `build/check-boundaries.mjs` records an intent against.** That guard's Phase-3
  note says the Dashboard surface must not depend on the editor ports at all. The
  variable SQL editor is opened from the Dashboards TREE, which lives in `src/ui/`
  and is not covered by an active rule, so `check:arch` passes — but the intent is
  now partly spent, and the editor factory is threaded as an injected seam off
  `env` exactly like `Editor`/`SpecEditor`/`CodeViewer` rather than imported
  concretely. If a `src/ui/dashboard/` directory is ever created, that dormant rule
  activates and this decision has to be revisited deliberately.
  *(Superseded by the #457 addendum below: the drawer and its editor seam are
  deleted, so the tree reaches no editor port at all and this intent is unspent.)*

- **Deliberately deferred, not decided here.** Terminology inside the surviving
  runtime still says "filter" (`ViewerFilterState`, `applyFilters`,
  `DashboardTimeRangeGroup.fromFilterId`, `.dash-filters`); those names now denote
  variables. Renaming them buys no semantics and would double an already large
  diff, so it is deferred to its own change.
  *(Deferral spent: #459 did that rename — see the addendum below. The names in
  this bullet are the pre-#459 ones and are kept verbatim as the record of what
  was deferred.)*

## Addendum (#447 phase 2, 2026-07-26): option lists are one generated request, read by position

Phase 2 adds the runtime the inferred-variable model was built for. Two decisions
are worth recording because both contradict something the issue's own text implies.

- **The generated batch names its payload columns; it does not pass the user's
  through.** The issue's snippet is
  `SELECT 'country' AS __variable_name, * FROM ( … )`. That shape cannot be read
  correctly: the streaming transport sends each row as a JSON object keyed by
  column name, so two identically-named columns collapse on parse — and
  `SELECT environment, environment FROM environments`, the option contract's own
  documented example, is exactly that shape. In a `UNION ALL` the result column
  names come from the FIRST branch alone, so one branch with a duplicate name
  silently rewrites a LATER branch's value into its label. Reproduced against
  ClickHouse 26.6.

  The fix takes the user's columns **by position** —
  `tupleElement(tuple(*), 1)` / `tupleElement(tuple(*), 2)` — which is what the
  contract actually specifies ("column position defines meaning; column names do
  not") and yields names that cannot collide.

  A positional *wire format* (`JSONCompactStringsEachRowWithProgress`) was
  implemented first and then reverted: it first shipped in ClickHouse **25.2**, so
  it would have made the whole feature fail on anything older, with no fallback
  available. `tuple`/`tupleElement` date from 20.4, so doing it in SQL needs no
  version gate and leaves the transport untouched.

- **Local rejection makes a variable's control say so; it does not silently
  degrade.** A configured variable whose option SQL cannot run (multiple
  statements, a `{name:Type}` placeholder, an unterminated span, …) stays a select
  and reports its own reason. Falling back to a direct-input text box would be
  indistinguishable from a variable nobody ever configured, which is how stored
  SQL ends up ignored with nothing explaining why. The *batch* keeps one
  Dashboard-level diagnostic for a combined-query failure, per the issue; the two
  never overwrite each other.

- **A configuration write asks a rendered Dashboard to re-read committed truth.**
  The compiled batch and each variable's control kind are fixed at session
  construction, and `syncDocument` deliberately never adopts `variableConfigs`.
  Phase 1 had the same staleness harmlessly (a configuration had no runtime
  consequence yet); phase 2 makes it visible, so `commitVariableConfig` now fires
  the same "workspace changed" hook a cross-tab edit uses.

- **The illustrative control mapping was not followed literally.** The issue lists
  `Date -> date input`, `Bool -> checkbox`, `integer -> numeric input` after the
  words "for example". Date-like types keep the existing relative-time combobox: a
  native picker cannot express `-1d`/`now`, so it would regress #169 presets and
  #335 relative tokens and would reject already-persisted values. A checkbox cannot
  represent UNSET, which three acceptance bullets require, so `Bool` offers
  `true`/`false` suggestions instead; numeric types keep the text field that #170
  already validates. Only the compound-type case is new — and it *adorns* the input
  rather than replacing it, because `param-serialize` binds an array literal typed
  there and removing the field would leave those panels permanently unfillable.
  **Narrowed by the addendum below:** an `Array` of a scalar WITH option SQL now
  renders a multi-select instead; the adornment survives for every other container
  and for an `Array(scalar T)` nobody has configured.

## Addendum (#457, 2026-07-26): a variable's option SQL is a main-editor document

Phase 1's per-variable option-SQL **drawer** is deleted. It was a second SQL
editing surface: its own CodeMirror-shaped seam, its own textarea fallback, its own
lifecycle, its own Test action and result view, in a panel narrower than the editor
the application already has. Four decisions replace it.

- **A tab is not always a query.** `QueryTab` gains
  `doc: {kind:'query'} | {kind:'dashboard-variable', dashboardId, variableName}`.
  A variable is *not* modelled as a saved query with a marker: `savedId` stays
  `null`, no `SavedQueryV2` is created, and Save dispatches on the document kind
  before it reads anything else. Identity is the exact `(dashboardId,
  variableName)` pair, because that is a variable's only identity — it has no id
  of its own, and the same name on two Dashboards is two unrelated documents.
  Tabs are session state, never persisted, so this required no schema change.

- **The write splits along the existing layer boundary.** The pure transform is
  `workspace/workspace-dashboards.ts`'s `withVariableConfig`, beside
  `findDashboard`/`replaceDashboard` and the exactly-one-match rule it depends on;
  the `mutateWorkspace` plumbing is `application/dashboard-variable-config.ts`. The
  async half resolves the full `WorkspaceMutationOutcome`, not a boolean: `aborted`
  covers the transform declining, the route moving on mid-write, and a vanished
  record — and one of those **keeps a durable write**, so collapsing them would
  make the UI report a failure that did not happen.

- **The Phase-3 editor-port intent is now fully spent, not partly.** The previous
  addendum noted the Dashboard sidebar reaching an editor seam and passing
  `check:arch` only because the tree lives in `src/ui/`. That seam is gone: the
  tree routes to `app.openVariableTab` and mounts no editor at all. The dormant
  `src/ui/dashboard/` rule no longer has anything here to catch.

- **Losing Test is accepted, and its replacement is the ordinary Run action.**
  Test locally validated a draft and then checked its result shape, the only place
  the two-`String`-column rule is checkable (a combined `UNION ALL` reports one
  merged column list for every branch). Keeping it would have meant re-inventing a
  run-and-report surface inside the very editor this change deletes. A variable tab
  runs through the main Run action instead; re-hosting the shape check on that
  result is deferred, and the batch-failure diagnostic now points at running one
  variable's SQL on its own rather than at a control that no longer exists.

  One consequence worth recording: `onWorkspaceExternallyChanged` is what tells a
  rendered Dashboard to re-read `variableConfigs` (a viewer session reads them once,
  at construction). A variable-tab Save happens on the **Query** surface, where no
  Dashboard is rendered and the hook is the no-op default — so phase 2's staleness
  guarantee now rides on the surface rebuild that occurs when the user returns to
  the Dashboard, not on that poke. The tree's orphan-delete still fires it for real,
  because the tree is visible while a Dashboard is.

## Addendum (#530, 2026-07-29): Bool uses a tri-state checkbox

The #447 phase-2 addendum deliberately kept `Bool` as a free-text field with
`true`/`false` suggestions, on the assumption that a checkbox could not preserve
the required UNSET state. That trade-off made a Boolean needlessly look like a
three-row select on both Dashboard variable surfaces.

The Dashboard variable bar now renders a native checkbox for any Bool-family
declaration. Its state model is deliberately three-way: an active checked field
commits canonical `true`, an active unchecked field commits canonical `false`,
and an inactive field sets the native `indeterminate` property. The existing
Dashboard Clear all affordance returns the field to that inactive/indeterminate
UNSET state, so no additional third option or per-field reset control is needed.
The checkbox remains inside its visible label, retains native keyboard and focus
semantics, and is selected before any Dashboard-local option SQL control: a Bool
type is the stronger presentation contract. The Workbench variable strip does not
opt into this Dashboard-specific policy and remains a free-text control.

## Addendum (#468, 2026-07-26): an `Array(scalar T)` variable binds a selection

#447 phase 1 removed the curated filter model wholesale, and its non-goals listed
"multiselect or Array-valued variable controls". Phase 2 then classified every
container type as having no inferred control. That left the one type multi-select
exists for — `Array(T)` — as a free-text box, even with a working option list
configured. This addendum records the deliberate reversal for the narrow case, and
restores the #189/PR-#364 control on top of the inferred-variable model.

- **One predicate decides eligibility, and both consumers read it.**
  `multiSelectElementType` (`core/param-type.ts`) answers "is this an `Array` of a
  single scalar, and what is the element type" for `core/variable-options.ts`'s
  batch filter AND for `fieldControlKind`'s control choice. A type whose option SQL
  ran can therefore never be one the bar refuses to render a select for, which is
  the same invariant `variable-bar.ts` already stated for the container verdict.
  `Tuple`/`Map`/`Nested` have no flat element list; `Array(Array(T))` is rejected by
  `param-serialize` outright. All four keep the adorned text field.

- **`fieldControlKind` classifies the TYPE; the bar pairs it with the spec.** The
  pure function has no way to know whether option SQL was configured, and giving it
  one would mean passing UI state into a parameter-analysis helper. `'multi'` means
  "this type can be multi-selected"; `variable-bar.ts` combines that with
  `spec.options !== null`, and an `Array(scalar T)` with no options falls back to
  the same adorned input as before — with wording that names the fix ("add option
  SQL") instead of calling a controllable type uncontrollable.

- **A selection is a real `string[]`, never a stringified literal.**
  `param-serialize.ts` already builds the ClickHouse literal from a JS array, with
  escaping, big integers and empty-string elements covered and tested. Committing a
  pre-serialized string instead would put literal construction in the UI, and would
  make the committed value unparseable back into a selection for the popover to
  re-open on. `dashboard-variable-store.ts` never lost its `string | string[]`
  support, so persistence needed no change at all.

- **The string boundary is `state.varValues`, and it is enforced by its TYPE.**
  Arrays travel: viewer session → `ViewerVariableState.value` (already `unknown`) →
  `VariableFieldSpec.selection` → the control → `onCommitVariableSelection` → back.
  They never enter `VariableBarApp.state.varValues`, which stays
  `Record<string, string>` because the Workbench var-strip owns and persists that
  same bag under `asb:varValues`. Widening it would NOT have been a safeguard —
  TypeScript's property assignability is covariant even for mutable properties, so
  a widened type would still accept the real `AppState` while letting an array
  through. Keeping it narrow is the enforcement.

- **An empty selection is unset, not `[]`.** `param-pipeline`'s `emptyValue()`
  treats a present `[]` as a genuine value, so binding one would run every panel as
  `… IN []` — returning nothing while LOOKING filtered — where a variable's unset
  contract is that its panels wait. `commitValue` reduces it to `UNSET_VALUE`, so
  there is exactly one unset form. This deliberately narrows #189, which could
  express an "active empty array"; with no defaults and no dormant values, no
  control here can author one.

- **Reconciliation returns names; `refresh` runs one wave.** `applyOptions` reports
  which variables a fresh option list actually changed the bound SET for (a pure
  reorder or a label-only change reports nothing), `runOptionBatch` collects them,
  and `refresh` runs a single `commitAndRerun` over the union AFTER both the option
  request and the tile pool have settled. Re-running inside `runOptionBatch` would
  supersede tiles mid-refresh and make the outcome classifier judge tiles that are
  already re-running. One coalesced wave is structural, not a flag to remember.

- **A committed selection is never silently changed** — three separate ways it
  could have been, all found in review and all closed:

  - *Applying before the options arrive.* `renderDashboard` mounts the surface
    BEFORE awaiting `session.start()`, and a configured variable publishes with
    `options: null` and no error, so the control was operable for the entire
    request; a no-change Apply canonicalized a restored selection against the
    empty list and committed a clear. The variable's `loading` status now reaches
    the control, which stays inert until `setOptions` (the only thing that clears
    it) or a batch failure. This is the one piece of #189's status machine with a
    reason to exist that survived the trim.
  - *Re-canonicalizing on refresh.* `reconcileSelection` preserves the COMMITTED
    order and only filters. The array binds as an ORDERED literal and panel SQL
    may read it positionally (`arrayElement`, a positional join) — `{name:Array(T)}`
    promises nothing about membership semantics — so adopting a new option order
    would change what panels bind while reporting no wave, and persist the
    difference. The user's own Apply still canonicalizes: that is a deliberate
    action taken against a list they are looking at.
  - *Pruning against a capped list.* A value can live past the 1,000-option cap,
    so a truncated result is not evidence that anything was removed; reconciliation
    is skipped entirely for one (the warning still publishes). The truncation
    SIGNAL was itself unsound — derived from the KEPT count, it missed a branch
    whose 1,001 rows collapsed under the cap through dedup or blank filtering
    (#461) — and now counts RAW rows against the branch `LIMIT`, which is what
    actually says the server cut the result off. The single-select already kept an
    off-list committed value verbatim; a selection gets the same benefit of the
    doubt.

    **Incompleteness is published, not private.** The session declining to prune
    is undone if the CONTROL's own Apply then canonicalizes the same value away
    against the same partial list — `canonicalizeSelection` drops everything the
    list does not offer, so a no-change Apply committed `([], false)` and a
    single visible pick silently dropped the rest. So `optionsTruncated` rides on
    `ViewerVariableState` down to the control, whose Apply keeps draft values the
    list does not contain, appended in committed order. They are invisible — no
    row exists for them — so the user cannot have deselected one, and the list is
    known to be a prefix, so it cannot be called stale. **Clear** still removes
    them: it empties the whole draft, which is the explicit "remove everything".
    With a COMPLETE list the rule does not apply at all — an off-list value has
    genuinely gone, and the session has already reconciled it out.

- **A latent bug fell out.** `dashboard-viewer-session.ts` marked every `Array(T)`
  variable with valid option SQL as `status: 'error'` via a branch commented
  "unreachable" — true only for the types that genuinely cannot be option-backed.
  Admitting `Array(scalar T)` into the batch made the comment honest, and the
  message now says what is actually wrong.

## Addendum (#459, 2026-07-26): the runtime says "variable"; only the storage key still says "filter"

#447's deferral above is spent. Every surviving runtime type, session method,
module filename and CSS class that said "filter" for something that is now a
Dashboard variable was renamed: `ViewerFilterState`/`ViewerFilterStatus`/
`ViewerFilterOption`/`FilterRuntime` → `ViewerVariableState`/…/`VariableRuntime`,
`setFilter`/`applyFilter`/`applyFilters`/`clearFilter`/`clearAllFilters`/
`resetFilters`/`getFilterField` → the `…Variable(s)` forms,
`DashboardViewState.filters` → `.variableStates`, `.filterDiagnostics` →
`.optionDiagnostics`, `DashboardTimeRangeGroup`/`TimeRangePairCandidate`'s
`fromFilterId`/`toFilterId` → `fromVariableId`/`toVariableId`, `ui/filter-bar.ts` →
`ui/variable-bar.ts`, `ui/filter-option-field.ts` → `ui/variable-option-field.ts`,
`core/filter-width.ts` → `core/variable-width.ts`,
`dashboard/model/dashboard-filter-store.ts` → `dashboard-variable-store.ts`, and
the `.dash-filter*`/`.dash-clear-filters`/`.detached-filter-row`/`.filter-select`/
`.ms-overlay` class family → their `variable`/`popover` equivalents. Behaviour is
unchanged. Three decisions are worth recording.

- **The persisted key keeps its historical name; nothing else does.**
  `KEYS.dashFilters` still resolves to the string `'asb:dashFilters'`. The issue
  offered a migration as the alternative, and it was rejected: the key holds real
  committed variable values on users' machines, so renaming it discards every one
  of them silently on the next load, and a read-old/write-new migration is a
  behaviour change in a change whose whole contract is "no behaviour change". The
  property name deliberately still matches the key string so the two cannot
  drift.

- **`filterActive` stays, and the reason is narrower than "it's the Workbench's".**
  `state.filterActive`/`asb:filterActive`/`saveFilterActive`/
  `effectiveFilterActive` keep their names because what they name is *activation
  of a parameter's optional `/*[ … ]*/` filter block* — `variable-bar.ts`'s
  `app.state.filterActive[p.name] = input.value !== ''` is exactly that — which is
  a live SQL-filter concept that predates the curated Dashboard model and survived
  its removal. The key is persisted besides.

  What that argument does **not** cover, and an earlier draft of this addendum
  wrongly implied it did: `VariableBarApp` — the SHARED port both the Dashboard and
  the detached Data view build the bar through — also declares `state.filterActive`
  and `params.saveFilterActive`, and the Dashboard satisfies it with a purely local
  `draftActive` map and a **no-op** `saveFilterActive`. So one of the port's two
  callers has no Workbench state and nothing persisted behind that name. The
  concept is still optional-block activation in both callers, so this is a leaky
  abstraction rather than a surviving curated-filter name — but naming a shared
  port after one caller's persisted field is worth fixing on its own terms, not
  inside a rename. Deferred to #478 deliberately: `params` is a
  `Pick<WorkbenchParameterSession, …>` (renaming a member stops it being a Pick,
  so the detached caller can no longer pass the app straight through), and the bar
  MUTATES the caller's map in place before calling `saveFilterActive()` — an
  adapter that copies instead of aliasing would silently stop persisting
  activation in the detached view, with no test today that would fail.

- **The rename is unfalsifiable by construction, so two guards were added.** A
  pure rename passes its whole suite whether or not it is correct, and every
  existing persistence test reaches the storage key through the `KEYS` constant —
  so changing the key's VALUE would have left 5600 tests green while orphaning
  real data. `tests/unit/state.test.ts` now pins every `KEYS` literal string, and
  `tests/unit/dashboard.test.ts` pins the two Dashboard group `aria-label`s
  (previously asserted nowhere, which is why the only user-perceivable half of
  this change could have regressed unnoticed). Both were sabotage-checked: each
  fails when the thing it guards is reverted.

- **The user-observable surface moved too, deliberately.** The variable row's
  visible section label ("Filters" → "Variables"), the Dashboard group and
  detached-view accessible names ("Dashboard filters"/"Dashboard time filters"/
  "Query filters" → the "variables" forms), the multi-select trigger's
  `"<name> filter, N selected"`, and two batch-error strings. Leaving the most
  visible instances of the old vocabulary in place while renaming every hidden
  one would have made the inconsistency worse, not smaller — the Dashboards tree
  has said "Variables" since #447 phase 1.

## Addendum (#471, 2026-07-26): leaving a Dashboard is a per-tile act

The `Back to query` control the #426 addendum above restored is removed. It named
no document: generic back-navigation in the primary toolbar, which left the user to
find the corresponding query in the Workbench themselves. Every query-backed tile
carries its own `Open in Workbench` action instead. Four decisions are worth
recording.

- **The tile's `queryId` IS the provenance the feature needs — no new tab model.**
  #471 asks for tab identity by "stable document origin, such as `dashboardId +
  dashboardQueryId`", and #464 proposes a `QueryTabOrigin` union. Neither is
  required here, because the #427 addendum above already made ownership a
  reference: a panel tile points at a dedicated saved-query copy that exactly one
  member owns, so that copy's id already IS a per-Dashboard document identity.
  `loadIntoNewTab` has always deduplicated on `savedId` and `commitSavedQuery`
  resolves its write target by id, so "re-opening selects the existing tab", "two
  same-named copies are two tabs" and "Save targets the Dashboard copy" all hold by
  construction. What #464 still owns is the *visible* half — the collision badges
  and full-origin tooltips that make two identically-named tabs tellable apart. A
  `TabDocument` arm for this would have been a second, redundant identity next to
  `savedId`, which is exactly the "second source of truth" #427 refused.

- **The action is not edit-mode chrome.** The grip, delete and resize handle are all
  `!readOnly`-gated and built only in Edit mode. This one is built unconditionally,
  like the heading: inspecting the query behind a tile is a View-mode act first, and
  the issue requires both modes. That had one consequence nothing else forced — a
  Grid-Tiles KPI tile's head is an absolutely-positioned, `pointer-events: none`
  overlay whose reveal rules were scoped `:not(.is-view)`, correct while every
  control inside it was edit-only. View mode now reveals it and the action opts back
  into pointer events.

- **Nothing to open means no control, not a disabled one.** A `text` panel is
  queryless by capability (`isQuerylessPanel`, the same predicate Save and share
  already use) and an unresolvable `queryId` belongs to a tile already rendering its
  own missing-query error. Both render no action. A disabled button would have
  advertised an affordance that can never work, and pointing it at the Dashboard's
  first query would have opened someone else's document.

- **A flow KPI band member reaches its action through the card, not the host.** Flow
  renders a KPI tile into a `.dash-kpi-member` host that carries no tile chrome of any
  kind — no head, no delete, no grip, no resize — and is `display: contents`, so it
  generates no box at all; that is also why the drag code derives its rect from the
  host's children. Absolutely positioning the action against it put the button in the
  Dashboard toolbar in a real browser, which happy-dom could not see. It is therefore
  anchored INSIDE the member's first card, the same reach-through the `.is-nav-target`
  ring and the `.dash-drop-target` outline already need for this host — which leaves
  the drag geometry untouched, because the button sits inside one of the very child
  boxes those rects are derived from. `renderKpiInto` replaces that card on every
  publish, so the control is MOVED into each repaint rather than rebuilt with it —
  see the #544 addendum below, which is also where the band member finally gained a
  delete. (Giving the band a full chrome surface — grip, resize, title — remains
  #475.)

**Back is now a supported way home, which needed a per-entry memory.** #471's
acceptance criteria lean on ordinary history navigation precisely because the global
control is gone — and that exposed a hole #425 had left tolerable: the URL carries no
Dashboard id (by design, above), the Dashboard DOM is disposed when the Workbench
takes the work area, and `adoptRouteMainSurface` had nothing to consult once the
session said "query". It resolved the *compatibility* Dashboard, so Back out of a tile
opened the collection's FIRST Dashboard, at the top of the page, however many
Dashboards the user had moved through.

The fix keeps the URL exactly as it was and puts the missing facts in
`history.state` instead — `{dash: {workspaceKey, dashboardId, currentMember,
scrollTop}}`, written onto the entry being LEFT (and onto a Dashboard entry as it is
created). Three properties made that the right home rather than a session-wide "last
Dashboard" memo:

- it is **per entry**, so several Back steps across several Dashboards each restore
  their own — a single memo can only ever be right about the most recent one;
- it is **invisible**, so shareable URLs are untouched and #425's "the URL is derived
  from the session surface, never the other way round" still holds;
- it is **discardable**: an entry that carries none (a fresh load, or one written
  before this existed) simply falls back to the old behaviour.

It is validated like any other selection — `restoreDashboardSurface` runs the snapshot
through `reconcileMainSurface`, so a remembered Dashboard that has since been deleted
lands on **Query** rather than retargeting to a different one, and the snapshot is
rejected outright when its `workspaceKey` does not match (a Dashboard id is unique per
workspace, not globally — the #457 addendum's rule).

The offset rides in `MainSurfaceState` as `pendingScrollTop`, a second one-shot
delivery beside `pendingFocus` and consumed with it, so no later repaint can yank a
page the user has since scrolled. Applying it is not a single write: at mount the grid
host is still empty (tiles arrive with the first publish, and grafana-grid's per-tile
px heights with them), so an offset written then clamps silently to `0`. It is
re-attempted after each publish until one sticks — which happy-dom cannot observe at
all, since it stores whatever was assigned.

The mobile consequence is recorded here too, because it reverses part of the #425
addendum. #426 had restored the back button specifically because the mobile rules
drop the sidebar *and* the bottom nav for a full-bleed Dashboard, and a per-tile
action cannot rescue a Dashboard with no tiles. Per the owner decision on #471, the
bottom nav stops hiding itself on this surface and shows only **Editor** — the other
two panel values still say nothing about a Dashboard — and pressing it switches
surface before selecting the panel, the same order `openSavedQuery` and
`openVariableTab` use. Full-bleed was a *width* claim; a bottom bar shortens the
Dashboard without overlapping it.

## Addendum (#428, 2026-07-27): a Library drag carries identity, the editor takes text

One Library row now publishes **two independent `dataTransfer` payloads** on a
single drag: the existing `SUBQUERY_MIME` SQL snapshot (PR #40), and a new
`LIBRARY_QUERY_MIME` identity `{kind, workspaceId, queryId}`. The same gesture
therefore means different things to different targets — the main editor consumes
TEXT and inserts a `( … )` subquery, while a Dashboard row, its Panels group, or
an inferred Variables row consumes IDENTITY and re-resolves it against committed
truth. History rows keep the text payload alone: a history entry has no stable
saved-query identity to re-resolve.

Five decisions are worth recording.

- **Dashboard assignment never trusts `dataTransfer`.** A drag can outlive the
  state it began in: the workspace may have been committed to several times, and
  the source may have been edited, deleted, or become Dashboard-owned. Carrying
  only two ids forces the drop to re-read the aggregate inside `mutateWorkspace`,
  which is the only place that can be authoritative. `workspaceId` rides along so
  a drop landing after a workspace SWITCH is rejected rather than resolving a
  same-looking id in the wrong document. A same-workspace change during the drag
  is explicitly NOT a cancellation — the operation rebases (#343).

- **Eligibility is a row field, not a view branch.** `DashboardTreeRow.dropTarget`
  is resolved in `application/dashboard-tree-model.ts` alongside every other
  structural decision, so the whole "rejected destinations" list is one pure,
  exhaustively-tested rule and `ui/dashboard-tree.ts` holds no targeting branches
  it could not cover. The Variables GROUP rejects (it does not identify which
  variable would receive the SQL) and an ORPHANED variable rejects (a
  configuration no panel declares is not a destination), while a CONFLICTED
  variable accepts — it is inferred and names a real variable, and its type
  conflict is orthogonal to where option SQL is stored.

- **Drag feedback deliberately causes no repaint.** Eligibility is emitted as
  static `data-droptarget` markup on every paint and merely REVEALED by one
  `dash-dragging` class on the tree list; the active target is a class re-applied
  from a module-private row key after any paint. Routing this through an
  `AppState` signal instead would have repainted the tree on drag start and on
  every hover auto-expand — and a repaint calls `replaceChildren()`, which
  destroys the row under the pointer: `dragleave` never fires for a removed node,
  Firefox stops delivering `dragover` until the pointer moves again, and the
  paint can steal focus. There is likewise **no Escape handler**: the browser
  consumes keydown during a native drag and delivers `dragend`, so a key listener
  would be a branch no test could reach.

- **Hover auto-expand is decoupled from eligibility.** A variable row only exists
  once both the Dashboard and the Variables group are expanded, but that group is
  not a valid drop target — so gating the hover timer on eligibility would leave
  variable rows unreachable by drag. Any collapsed expandable row therefore gets
  the bounded timer (a Dashboard row opens both of its groups); only *dropping*
  is restricted. Expansion is UI state: it never navigates and never mutates.

- **The dirty-variable-tab gate runs INSIDE the transform, not before dispatch.**
  A pre-dispatch check is a snapshot, not a gate: `mutateWorkspace` queues behind
  `serializeWrite` and then awaits `workspace.loadById`, so a keystroke in that
  window flips the tab dirty after the check and before the commit. What makes
  that worse than an ordinary race is that nothing downstream would notice — a
  variable tab has `savedId === null`, so #343's linked-tab reconciler skips it
  and there is no external-change marker for a `dashboard-variable` document,
  leaving a diverged draft over freshly-assigned SQL with the next Save silently
  reverting the assignment. `src/application` may import `src/state.ts`, so the
  service re-reads the tabs at dequeue time. A committed assignment then adopts
  into a CLEAN open tab through a new `reconcileVariableTab`, which pokes the tabs
  signal but does not select the tab or focus the editor — `openVariableTab` calls
  `showQuerySurface()`, and a successful drop must not leave the Dashboard.

Panel assignment routes through `applyCommand('add-query-instance')`, the app's
canonical add path, rather than pushing a tile: only that path seeds placement
from the source query's own `spec.dashboard.sizeHints`, which grafana-grid@1
requires of every mutation. `add-query-instance` (not `add-query`) is correct
because repeated drops of one source into one Dashboard are explicitly allowed,
each producing an independent query and tile. Ids come from the injected
`crypto.randomUUID` seam rather than `deriveOwnedQueryId`, whose derived
`q-own-…` form exists to keep migration and import idempotent — a user drag is
neither, and a content-derived id would actively fight repeated drops.

### Addendum to the addendum (2026-07-27, owner): a drop opens what it created

#428's "After success" list says the drop must not switch surfaces. That was
reversed on review of the shipped behaviour: the point of dropping a query onto a
Dashboard is to *work on* the thing you just made, and landing on a Dashboard with
no visible change read as "did anything happen?". So a successful drop now:

- expands down to the created object, makes it the tree's keyboard row, and
  **focuses** that row (`renderDashboardTree` restores focus only when the tree
  already held it, and after a mouse drop it does not — so without an explicit
  focus the row was the arrow-key origin while being off-screen); then
- **opens the assigned document in the editor** — for a panel, the new OWNED COPY
  (never the Library original, editing which would not touch the panel); for a
  variable, its `Variable: <name>` tab.

What did NOT change: the Dashboard itself is still never opened in View/Edit, and
nothing is executed.

**The dirty-draft gate has a second half, because a gate alone cannot be enough.**
The in-transform check closes the queue-and-load window, but `mutateWorkspace` then
awaits `workspace.commit(candidate)`, and a keystroke landing in *that* window
passes every check and diverges anyway — a blocked or slow IndexedDB transaction
widens it materially. No check can close it: the commit is the repository's atomic
write and UI state cannot be held still across it. Refusing to adopt while
reporting a clean success was the actual bug — the write is durable, the draft
survives, they disagree, and the next Save silently reverts the assignment.

So the outcome carries `draftDiverged`, re-read after the commit resolves, and the
drop surfaces it: a toast that does not auto-dismiss (an `action` suppresses the
timer) saying the tab's unsaved changes now differ, with a **Discard draft**
action wired to `discardVariableDraft` — the explicit, user-invoked counterpart to
`reconcileVariableTab`, which still refuses a dirty tab. Nothing discards typing
automatically.

The keyboard-accessible **Add to dashboard…** command (#428 acceptance bullet 9)
landed separately in **#483**. Each Library row now opens a named, two-stage
Dashboard → panel chooser that calls the same `assignLibraryQueryToPanel`
application command as drag/drop; it does not grow a second mutation path or a
target-panel/configuration picker. The original drag addendum remains pointer
specific: mobile is out of scope for the gesture as a whole, no `isMobile`
branches were added, and `draggable` stays unconditional on Library and History
rows so the shipped editor drop is unchanged there.

## Addendum (#515, 2026-07-28): blank Panel creation is one owned aggregate mutation

A Dashboard row now places **Add panel** immediately before its edit and delete
actions. This is not Library assignment: the two-field dialog supplies the new
query's name and optional description, and the command constructs a blank
`spec.dashboard.role: "panel"` query directly. No Library source is resolved,
copied, favorited, or modified.

The pure candidate builder lives in `dashboard/application`, while its
read-latest-at-dequeue wrapper and injected id generation live in
`application`. Query and tile ids are minted once per Add attempt. Inside the
queued transform the command strictly re-resolves the Dashboard, re-checks the
100-tile limit, rejects workspace-wide query-id and Dashboard-local tile-id
collisions, appends the query, and delegates tile creation to
`add-query-instance`. That canonical path remains the sole owner of initial
placement, layout normalization, and grid-fallback regeneration. The target
Dashboard revision advances once; every unrelated query and Dashboard is
retained unchanged. Aggregate validation and persistence see one candidate, so
an orphan query or dangling tile is never published on failure.

Success settlement is deliberately a post-dialog-close callback. The dialog
first tears down and performs its ordinary return-focus step; only then does
the tree reveal the new Panel and call the existing saved-query open path.
The creation service does not invoke the active Dashboard's workspace-refresh
hook before returning: `mutateWorkspace` has already projected the committed
aggregate, while an eager Dashboard rerender would force-close the dialog and
discard that post-close navigation.
That path switches to the Query surface, seeds the linked tab's committed-token
baseline, and focuses the SQL editor, so dialog teardown cannot steal focus back
to the hidden plus trigger. Cancel, Escape, backdrop close, stale targets,
collisions, validation errors, and persistence failures perform no navigation;
failed writes keep the entered values and diagnostic in the open dialog.
An unexpected rejected write is converted to the same recoverable dialog state:
the fields remain, a generic diagnostic is announced, and every dismissal path
is re-enabled. If persistence succeeds only after the route has moved on,
settlement instead closes silently without claiming failure or running the
old route's reveal/open/focus callback.

## Addendum (#465, 2026-07-27): Test's shape check is re-hosted on Run, not re-invented

The #457 addendum above ("Losing Test is accepted...") deferred re-hosting the
two-`String`-column check on the ordinary Run action. Until this addendum, Run on
a `dashboard-variable` tab executed the SQL raw: a wrong column count or type
reported a plain success, and the mistake surfaced only later, as an unattributed
batch-level failure.

- **The preflight lives in `WorkbenchSession`, ahead of every execution choke
  point — not inside `run()` alone.** `runEntry()` dispatches a `dashboard-variable`
  tab straight to `run()`, before `splitStatements` decides between `run()` and
  `runScript()`. Doing the check only inside `run()` would leave a multi-statement
  variable query free to reach `runScript()` unvalidated — the ordinary script
  runner has no concept of this contract at all, so `optionSqlDiagnostics`' own
  statement-count diagnostic is what a multi-statement input must fail with,
  not a script grid. `run()` itself runs the check before its own blank-SQL
  no-op and before the `{name:Type}` unfilled-variable gate, so blank/comment-only
  option SQL is reported explicitly rather than silently doing nothing the way an
  ordinary tab's blank Run does.

- **Execution reuses the batch's own bounded, read-only probe, not a new
  transport.** `compileOptionProbe` — restored alongside `isOptionColumnType`
  and `validateOptionColumns`, the exact three helpers the #457 addendum named
  as Test's own — embeds the SQL through the same `nestBounded` subquery and
  per-branch `LIMIT` the batch compiler uses, so Run can never accept SQL the
  combined batch would reject. It drops the branch tag `compileVariableOptionBatch`
  adds, which is what makes the two-column rule checkable at all: a `UNION ALL`
  reports one merged column list for every branch, but a lone probe's response
  describes only that query's own columns.

  A pre-ship review caught the transport CAPS as a separate, real mismatch: an
  earlier revision passed `state.resultRowLimit` (the user's ordinary display
  cap) and no `params` at all, rather than `VARIABLE_OPTION_CAP + 1` and
  `{readonly: 2, max_result_bytes: VARIABLE_OPTION_BYTE_CAP}` — the exact bound
  and safeguards `dashboard-viewer-session.ts`'s `runOptionBatch` sends, and the
  removed Test path (`app.runOptionQuery`, e75bfc6) sent before it. A display
  cap lower than the batch's own bound could cut the client off before hitting
  the failure the full batch would hit later, and no `max_result_bytes` at all
  left Run able to pull an unbounded response of unusually large String values
  — precisely what "cannot pass SQL the batch would reject" is supposed to
  rule out. Fixed to match both reference points exactly.

- **A shape failure borrows the ordinary run's own success gate, rather than a
  parallel one.** `runVariableSql` (a new function beside `run()`/`runScript()`,
  not a branch inside `run()` — a typed FORMAT clause or a `{name:Type}`
  parameter can never reach here, `optionSqlDiagnostics` rejects both locally,
  and a variable document never carries a panel, so none of `run()`'s KPI/
  FORMAT machinery applies) sets `result.error` to the validation diagnostic
  before any success bookkeeping runs, so a shape-invalid response is never
  mistaken for a successful one. It shares `run()`/`runScript()`'s private
  run-state (`runT0`/`runQueryId`/`runTick`/`abortController`), so `cancel()`
  and a transport error behave identically to an ordinary tab's Run — a
  genuine transport error or cancellation is never overwritten by a shape
  verdict about a response that
  never fully arrived.

- **Only a shape-invalid run loses History/Expand — a genuinely valid one
  keeps them.** This PR's first pushed revision excluded a
  variable tab's Run from History and detached-result `source` capture
  UNCONDITIONALLY, reasoning by analogy to `saveVariableTab`'s exclusion from
  History/Library/favourites/Panels — but Save's exclusion is about never
  creating a `SavedQueryV2` or Library entry, not about a tab's own execution
  history, which an ordinary UNSAVED query tab still records. A second
  pre-ship review finding: #465 only requires that a shape failure not be
  MISTAKEN for success; it never asks for a valid run's existing affordances to
  be removed. Corrected to match `run()` exactly on the success path
  (`result.source` when `result.rows.length > 0`, `hooks.recordHistory`
  unconditionally) and to still skip only the two fields that are provably
  inert for this document kind: bound-parameter recording (option SQL can
  never carry one) and `lastSuccessfulResultColumns` (a variable tab has no
  Spec for dynamic-source completion to read it from).

- **EXPLAIN is refused where it is invoked, not silently swallowed where it
  would land.** `run()` dispatches to `runVariableSql` unconditionally for a
  variable tab, before `opts.explain`/`opts.explainView` are ever read — so
  those flags are simply never consulted there. Left at that, the Explain
  button and its production callers (`app.ts`'s `explainQuery`/
  `setExplainView`, both gated only on `editorMode === 'sql'`, true for a
  variable tab) would have called `workbench.run({explain: true})` and gotten
  an ordinary validation probe back with no sign Explain was ignored — a
  review finding caught before this shipped. `explainVariableBlocked()`
  mirrors the existing `explainMultiBlocked()` toast-on-click pattern (the
  Explain button itself stays visible, same as the multi-statement case) and
  is checked first, since option SQL is always one statement.

## Addendum (#496, 2026-07-29): Run consumes the probe's overflow sentinel

The #465 probe already wrapped authored option SQL with
`LIMIT VARIABLE_OPTION_CAP + 1` and requested the same 1001-row client bound,
but Run validated only response columns. A query returning the sentinel row
could therefore be recorded as a successful run even though the Dashboard
option batch supports at most 1000 options.

- **Raw row count follows successful column-shape validation.**
  `validateOptionRowCount` is a pure companion to `validateOptionColumns`; the
  Workbench applies it to `result.rows.length` only when the response completed
  without a server error or cancellation. Column shape wins when both contracts
  are invalid, and counting happens before any future filtering or
  de-duplication.
- **The authored SQL text is irrelevant to the verdict.** Zero through 1000
  rows pass whether or not the query contains its own `LIMIT`; the bounded
  probe's 1001st row fails with the specific maximum-option diagnostic. The
  batch compiler, its independent per-variable truncation handling, transport
  bounds, and read-only byte cap are unchanged.
- **Overflow uses the existing failure gate.** The diagnostic is assigned
  before the success bookkeeping in `runVariableSql`, so an over-cap response
  creates neither History nor a detached-result source.

## Addendum (#464, 2026-07-29): tab origin is derived, but its presentation is explicit

The #471 addendum above settled query-tab identity: a Dashboard tile's dedicated
query id is already the stable document identity, and `savedId` already drives
tab reuse and Save targeting. This change adds the missing visible and accessible
source context without introducing a reverse origin field.

- **Ownership remains the one source of truth.** Query-tab source is projected
  from `savedId` through `buildQueryOwnershipIndex`; Dashboard-variable tabs use
  their existing `(dashboardId, variableName)` document binding. No
  `QueryTabOrigin`, saved-query back-pointer, or recovery payload field mirrors
  those references. Workspace commits repaint the strip because a Dashboard
  rename can change presentation without changing any tab signal.
- **Badges exist only inside a visible name collision.** Every tab in an exact
  same-name group receives a source label, while unique names reserve no badge
  space. Multi-word Dashboard titles start with their initialism and expand
  words in place; single-word titles start with a three-character prefix.
  Distinct titles expand through their readable full text before the exceptional
  case of identical titles adds the shortest unique Dashboard-id prefix.
- **Full context does not depend on a visible badge.** The selectable surface is
  a native, keyboard-focusable `tab` inside the tab-list, named and titled
  `<Dashboard, Library, or Draft> / <document>`. A roving tab stop supports
  Left/Right/Home/End, and an app-scoped focus handoff survives the strip's
  replacement render after activation or close (including a confirmed dirty
  close). The accessible name appends unsaved/conflict/deleted state rather than
  hiding those visual indicators behind the explicit source label. The close
  button remains a separate sibling control, and source badges precede the
  existing conflict/deleted and dirty indicators.

## Addendum (#544, 2026-07-29): the tile head became a `⋯` menu

#535 added duplicate, widen and expand to the tile head, which left it carrying
five controls beside the tile title. Three decisions in this ADR are revised, and
one of #494's is partly reversed.

- **Four of the five controls moved into an overflow menu, and #494's argument
  survives it.** #494 removed the `⋯` from every Dashboards-TREE row on the
  grounds that nothing a row can do should hide behind a second press. That still
  holds for rows: a tree row is two controls wide in a fixed-width side pane, and
  directness there costs nothing. A tile head is a different surface — five
  controls on a card the grid can render under 100px wide, sharing one flex row
  with a title that ellipsizes to nothing first. Edit mode is now
  *grip · title · widen · ⋯*; View mode keeps its single direct expand icon,
  because a one-row menu is strictly worse than the button it would hide.

- **"Nothing to open means no control, not a disabled one" is reversed FOR THE
  MENU.** That rule (above) is right for a bare icon in a head: a disabled glyph
  with only a tooltip advertises an affordance that can never work. Inside a menu
  the row IS the explanation — the same argument #452 settled for the File menu,
  and the reason `MenuRow` carries a `reason` slot — so all four rows are always
  listed and an unavailable one states why in a sentence. A menu whose vocabulary
  changed with the layout style would teach the user nothing. The inline widen
  keeps the old rule, because it is still a bare icon.

- **A tile's delete stopped being a layout command and became a two-resource
  workspace write.** It was a document-only `remove-tile` dispatch, CSS-scoped to
  `.dash-gg-grid` and click-gated on the active engine — so Report and the two
  column presets had no delete at all, and a flow KPI band member had none under
  any style. Since #427 made a panel tile the sole owner of a saved-query copy,
  that dispatch also left the copy with zero owners, which is exactly what makes a
  query a Library query, so a deleted panel returned as an apparently standalone
  Library entry (#537). It now takes `commitPanelRemoval` — the same confirmed,
  ownership-proven path the Dashboards tree uses — which is engine-independent by
  construction and therefore fixes the availability gap and the orphan together.
  The cost is deliberate and shared with #535's duplicate: a two-resource write
  rebuilds the route from committed truth, re-running every tile's query, and the
  transient Full view render mode does not survive that rebuild.

- **Availability is answered by a DRY RUN of the transform, not a second copy of
  its rules.** `panelRemovalRefusal` calls `removeDashboardPanel` and discards the
  candidate workspace, so a "Remove tile" row can be disabled with a reason
  instead of opening a confirmation that refuses at the end of itself (#494's
  rule) — and the two answers cannot drift, because they are the same function.

- **The narrow rule is a CSS container query, not JS state.** The inline widen is
  a shortcut on top of its menu row, withdrawn below roughly 260px of tile. A
  container query on the tile head reacts live during a #291 corner drag, which a
  span-derived JS predicate would not, and a span is not a width in any case. It
  is invisible to happy-dom, so it is proven by a real-browser test.

- **A flow KPI band member's control is built once and MOVED.** `renderKpiInto`
  replaces the card it lives inside on every publish, including every refresh
  wave, and `openMenu` keys its one-menu-per-trigger registry on the trigger
  element while holding `aria-expanded` there. A rebuilt trigger would strand an
  open menu over a dead node, with focus-restore aimed at it.

## Addendum (follow-up to #538, 2026-07-29): authored styles own independent sizing

The #321/#535 model mixed persisted flow presets, a transient Full render mode,
and Grid dimensions that Widen changed in two axes. That made the Style menu
look like five equivalent choices when only some choices had durable state.
This follow-up replaces that model with one versioned layout-engine contract.

- **`grafana-grid@2` is the canonical authored layout.** Its persisted preset is
  `grid`, `full`, or `report`. Each tile carries independent optional maps:
  Grid `{span,height}` (default 6×2), Full `{height}` (fixed width 12, default
  height 2), and Report `{height}` (centered width 9/12, default height 5).
  Switching styles never copies dimensions between maps. Full and Report resize
  vertically only.
- **2 columns and 3 columns are previews, not authored presets.** Selecting
  either creates a fresh session-local span-1 map and renders every tile at
  exactly 300px. It reads no saved tile dimension and writes no command,
  revision, fallback, or workspace. Widen steps `1→2(→3)→1` only in that map.
  Selecting any other style, rebuilding/navigating, reloading, or switching
  between the previews discards it. The mobile breakpoint normalizes it to one
  column and disables Widen.
- **Widen is horizontal-only.** Grid doubles span up to 12 and then wraps to 1,
  always resending the unchanged height because placement updates replace the
  complete Grid object. Full and Report have fixed widths and expose no Widen
  action. The menu row follows the same availability rule; it no longer lists a
  disabled Widen for fixed-width authored styles.
- **Compatibility lives at codec boundaries.** `grafana-grid@1` becomes v2 Grid
  with its placements preserved. Flow Report becomes v2 Report and converts
  explicit heights; missing heights use Report defaults. Persisted flow
  2/3-column layouts become v2 Grid through the established flow-to-grid
  conversion. Current v2 reads refresh the deterministic style-aware `flow@1`
  fallback. Dashboard and workspace document versions do not change.
- **All authored styles use the grid renderer.** This retires flow KPI bands for
  canonical current workspaces: KPI panels are ordinary grid tiles under Grid,
  Full, and Report, sharing the same reorder, action, and resize lifecycle.

## Alternatives considered

- **Durable detached snapshots:** rejected because they silently diverge from
  the live workspace and require duplicate persistence and transport.
- **New-tab navigation by default:** rejected because it encourages concurrent
  editing and makes Back navigation ineffective.
- **Path-segment routes:** rejected because workspace, surface, and mode are
  independent application state and query parameters preserve the single SPA
  handler and OAuth redirect.
- **View as authorization:** out of scope. View mode is a local presentation
  choice, not an access-control boundary.
