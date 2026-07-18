# ADR-0003: Dashboard viewing — edit vs view modes, and the one-time cross-tab state handoff

- **Status:** Accepted — 2026-07-18 (#288 + #302, Dashboard v1 phase 6, the final
  phase of epic #280). Implemented on branch `feat/dashboard-viewing-288`.
- **Date:** 2026-07-18
- **Context tracking:** roadmap #68 (Dashboard track); epic #280; closes #153.
- **Related:** #149 (original standalone-dashboard route + postMessage credential
  handoff — its *state*-transport decision is superseded here), #284 (IndexedDB
  `StoredWorkspaceV1` persistence, whose adapter pattern this reuses), #287
  (portable bundle codecs + transactional import planner this builds on).

## Context

Phases 1–5 of #280 made the Dashboard a first-class module: an explicit
`StoredWorkspaceV1` aggregate persisted atomically to IndexedDB (#284), an
independent read-only `DashboardViewerSession` + `flow@1` layout (#286), and a
canonical `PortableBundleV1` with a transactional import planner (#287). Phase 6
(#288) is the viewing surface: how a Dashboard is *opened* — bookmarkably for the
current workspace, and in a detached read-only tab — without the read-only path
dragging in Workbench or editor construction. In parallel, #302 asked to move
Dashboard navigation and Dashboard-scoped file operations out of the (overloaded)
Workbench File menu and next to the Dashboard resource itself.

The original #288 spec framed the second open kind as a *temporary, one-time,
non-bookmarkable* "session-bundle" for full-screen preview and external-bundle
viewing. During planning the owner refined this into a cleaner, more durable
product model, which this ADR records.

## Decision

### Two explicit viewing modes

| | **Edit mode** | **View mode** |
|---|---|---|
| Entry | Workbench header `Dashboard →` control | Dashboard header **File → "Open for viewing…"** |
| Tab | new tab | new tab |
| Open source | `current-workspace` (`?ws=&dash=`) | detached snapshot of the current dashboard |
| Storage | **shared** primary workspace store (`asb-workspace`) | its **own** detached store (`asb-dashboard-views`), fresh id |
| Editable | yes — drag reorder + layout preset persist to the shared aggregate | **read-only** |
| Auth | existing postMessage credential handoff (#149) | same |
| Survives relogin / reload | yes (shared store) | yes (own persisted record) |

`Dashboard →` opens a **new tab** (an owner override of #302's "current tab"
wording), keeping the Workbench tab available and reusing the existing new-tab
credential handoff.

### The `DashboardOpenSource` contract

```ts
type DashboardOpenSource =
  | { kind: 'current-workspace'; workspaceId: string; dashboardId: string }
  | { kind: 'session-bundle';   token: string;        dashboardId: string };
```

Encoded as **query params on `/dashboard`** — never path segments — so the
pathname stays exactly `/dashboard` and `isDashboardRoute`/`configBase`/the OAuth
`redirect_uri` (all keyed on the `/dashboard` suffix) are untouched, and the
params survive `bootstrap`'s OAuth-param strip automatically. `?ws=&dash=` is
current-workspace; `?st=&dash=` is session-bundle.

> **Critical constraint:** the session token param is **`st`**, never `state`.
> `bootstrap` (`src/main.ts`) reads `?state` as the OAuth CSRF value; a token
> there would raise "OAuth state mismatch".

**Mode is discriminated by which store the `ws` id resolves in**, not by a
spoofable URL flag: the id present in the primary workspace store → edit mode;
present in the detached views store → view mode; in neither → a not-found panel
that executes nothing (never silently opens a different dashboard).

### The one-time cross-tab state handoff

"Open for viewing…" hands the dashboard *state* (not credentials) to the new tab
through a one-time IndexedDB token, then materializes a durable detached copy:

1. Snapshot the current dashboard's dependency closure into a `PortableBundleV1`
   (`buildDashboardExportBundle`).
2. Generate an unguessable 256-bit token (`crypto.getRandomValues`); write a
   record `{ text: bundleJSON, dashboardId, detachedWorkspaceId, expiresAt }` to
   a dedicated IndexedDB database (`asb-dashboard-handoff`) **before** opening the
   tab.
3. `window.open('/dashboard?st=<token>&dash=<id>')` and grant the credential
   handoff.
4. The new tab **atomically consumes + deletes** the record in one readwrite
   transaction (`take` = get+delete, then reject if expired), and strips `st`
   from the URL via `history.replaceState`.
5. It **materializes** the bundle into the detached store under
   `detachedWorkspaceId`, rewrites the URL to `?ws=<detachedWorkspaceId>&dash=`,
   and renders read-only.

Auth is orthogonal and unchanged: the new tab still restores credentials via the
#149 postMessage handoff, falling back to a normal OAuth relogin (which the
detached `?ws=` URL survives).

## Consequences / deliberate evolutions of #288

- **"session-bundle is not bookmarkable" is refined, not violated.** The `?st=`
  token URL is genuinely one-time and dead after consumption — not bookmarkable.
  The *detached view it produces* (`?ws=<detachedId>`) is persistent and
  bookmarkable/relogin-surviving. This is the intended product behavior: a
  view-mode tab you can leave open, reload, and re-authenticate into.
- **External-file *viewing* + the untrusted-bundle "Run Dashboard on `<host>`"
  trust preflight are descoped.** External `.json` files go through #302's
  transactional **Import Dashboard…** (validate + commit via the planner).
  "Open for viewing…" detaches the workspace's *own*, already-trusted dashboard,
  so there is no untrusted external SQL to gate. The viewer's existing safety
  limits (row/byte caps, bounded concurrency, per-tile cancellation, stale-wave
  protection, no Setup execution) still apply.
- **A new IndexedDB store family.** Two dedicated databases join `asb-workspace`:
  `asb-dashboard-handoff` (one-time tokens) and `asb-dashboard-views`
  (multi-record detached snapshots, keyed by workspace id, with a small retention
  cap so abandoned views don't grow unbounded). Both reuse the #284 adapter
  pattern (lazy cached open, single readwrite-txn atomicity) behind injected
  seams, so the pure/seam logic stays 100%-covered and tests use in-memory fakes.
- **Read-only path stays clean.** The viewer path constructs no Workbench/editor
  modules; the `check:arch` boundary guard + `dashboard-boundaries.test.js` are
  extended to the new `dashboard/application` + `workspace` modules.
- **File-menu ownership clarified (#302).** The Workbench File menu owns
  workspace/query operations only; Dashboard navigation moves to a Workbench
  header `Dashboard →` control, and Dashboard import/export + "Open for viewing…"
  move to a resource-scoped File menu on the Dashboard header.

## Alternatives considered

- **Same-tab navigation for `Dashboard →`** (#302 as literally written): rejected
  by the owner in favor of a new tab, to keep the Workbench visible.
- **Ephemeral one-time view (strict original #288):** the view would not survive
  relogin/close. Rejected — the owner wants a durable, detached view surface;
  the token remains the *transport*, persistence is layered on top.
- **Path-segment routes (`/dashboard/ws/<id>`):** rejected — breaks
  `isDashboardRoute`/`configBase`/OAuth-redirect, all keyed on the `/dashboard`
  suffix.
- **A `?view=1` mode flag:** rejected in favor of store-membership discrimination
  (not spoofable, and naturally yields the not-found case).
