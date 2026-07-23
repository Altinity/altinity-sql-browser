# ADR-0003: Dashboard viewing and unified `/sql` routes

- **Status:** Accepted; detached-snapshot decision superseded by #407 on
  2026-07-23
- **Date:** 2026-07-18; revised 2026-07-23
- **Context tracking:** roadmap #68; #288, #302, #406, #407

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
