// The ONE narrow Dashboard selection/access seam over a StoredWorkspaceV4
// Dashboard collection (#424). Pure — no DOM, no persistence.
//
// V3 stores `dashboards: DashboardDocumentV1[]`, but the current UI still
// exposes exactly one Dashboard surface with no selector. Rather than
// scattering `workspace.dashboards[0]` across the application, every call site
// resolves the visible document through `resolveCompatibilityDashboard` and
// writes back through `replaceDashboard`/`withCompatibilityDashboard`. The next
// product step replaces the compatibility rule here with real selected-Dashboard
// state without touching those call sites.
//
// The compatibility rule is deliberately TEMPORARY application behavior, not a
// persisted field: V3 carries no `activeDashboardId`/`defaultDashboardId`.

import type { DashboardDocumentV1, StoredWorkspaceV4 } from '../generated/json-schema.types.js';

/** Enough of a workspace to resolve a Dashboard from — the readers below never
 *  need the identity envelope, so an in-flight candidate satisfies them too. */
export type WorkspaceDashboards = Pick<StoredWorkspaceV4, 'dashboards'>;

/** Which Dashboard the current single-surface UI renders and edits, with its
 *  stable identity so downstream commands can address their write BY ID rather
 *  than by array position. */
export interface WorkspaceDashboardSelection {
  selectedId: string | null;
  dashboard: DashboardDocumentV1 | null;
}

/** The compatibility Dashboard: the FIRST entry, or none when the collection is
 *  empty. Every additional Dashboard stays fully persisted and validated — it
 *  is simply not reachable from this phase's UI. */
export function resolveCompatibilityDashboard(
  workspace: WorkspaceDashboards,
): WorkspaceDashboardSelection {
  const dashboard = workspace.dashboards[0] ?? null;
  return { selectedId: dashboard === null ? null : dashboard.id, dashboard };
}

/** The Dashboard with this id, or `null` when the workspace has no such entry.
 *  A route that pinned an id at open time uses this to re-read committed truth
 *  without depending on the entry's position. */
export function findDashboard(
  workspace: WorkspaceDashboards, dashboardId: string,
): DashboardDocumentV1 | null {
  return workspace.dashboards.find((dashboard) => dashboard.id === dashboardId) ?? null;
}

/** Why an id-addressed resolution failed, kept distinct because the two
 *  outcomes mean different things to a caller: `missing` is an entry that was
 *  deleted (fall back), `duplicate` is a workspace whose ids are ambiguous and
 *  which therefore must never be written through a guess. */
export type DashboardLookup =
  | { status: 'ok'; dashboard: DashboardDocumentV1 }
  | { status: 'missing' }
  | { status: 'duplicate' };

/**
 * The Dashboard with this id under the exactly-one-match rule — the single
 * definition of that data-integrity invariant, shared by every id-addressed
 * reader and writer (`replaceDashboard` below, and the selected-surface
 * resolution in `application/main-surface.ts`) so it can never drift into two
 * copies that disagree.
 */
export function findDashboardStrict(
  workspace: WorkspaceDashboards, dashboardId: string,
): DashboardLookup {
  const matches = workspace.dashboards.filter((dashboard) => dashboard.id === dashboardId);
  if (matches.length === 1) return { status: 'ok', dashboard: matches[0] };
  return { status: matches.length === 0 ? 'missing' : 'duplicate' };
}

/**
 * Replace EXACTLY ONE Dashboard, addressed by its stable id, preserving every
 * other entry and the collection's order. Returns `null` — committing nothing —
 * when `dashboardId` names no entry (it was deleted concurrently) or names more
 * than one (a duplicate-id workspace must never be "repaired" by an ambiguous
 * write). Never mutates `workspace`.
 */
export function replaceDashboard(
  workspace: StoredWorkspaceV4, dashboardId: string, next: DashboardDocumentV1,
): StoredWorkspaceV4 | null {
  if (findDashboardStrict(workspace, dashboardId).status !== 'ok') return null;
  return {
    ...workspace,
    dashboards: workspace.dashboards.map((dashboard) => (dashboard.id === dashboardId ? next : dashboard)),
  };
}

/**
 * Write back the compatibility SLOT — the position the current UI edits — while
 * preserving every later Dashboard:
 *   - a document + a non-empty collection → replaces entry 0 (the imported
 *     document legitimately carries a different id than the one it replaces);
 *   - a document + an empty collection    → becomes the sole entry;
 *   - `null`                              → drops entry 0 only.
 * Never mutates `workspace`.
 */
export function withCompatibilityDashboard(
  workspace: StoredWorkspaceV4, next: DashboardDocumentV1 | null,
): StoredWorkspaceV4 {
  const rest = workspace.dashboards.slice(1);
  return { ...workspace, dashboards: next === null ? rest : [next, ...rest] };
}
