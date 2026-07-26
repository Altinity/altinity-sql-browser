# ADR-0003: Dashboard viewing and unified `/sql` routes

- **Status:** Accepted; detached-snapshot decision superseded by #407 on
  2026-07-23; surface lifecycle amended by #425 and surface NAVIGATION amended by
  #426, both 2026-07-25 (see the addenda)
- **Date:** 2026-07-18; revised 2026-07-23, 2026-07-25
- **Context tracking:** roadmap #68; #288, #302, #406, #407, #425

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

- **Deliberately deferred, not decided here.** Terminology inside the surviving
  runtime still says "filter" (`ViewerFilterState`, `applyFilters`,
  `DashboardTimeRangeGroup.fromFilterId`, `.dash-filters`); those names now denote
  variables. Renaming them buys no semantics and would double an already large
  diff, so it is deferred to its own change.

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
