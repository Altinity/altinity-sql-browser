// Pure application glue for the standalone Dashboard route's view-mode
// session-bundle handoff (#288). Ties together the open-source contract
// (dashboard-open-source.ts), the one-time handoff record shape
// (workspace/handoff-store.types.ts), and the portable-bundle export/codec
// pair (dashboard-export.ts / portable-bundle-codec.ts) into three pure
// functions the coordinator (app.ts/dashboard.ts) calls around its impure
// IndexedDB/crypto/clock seams.
//
// NO DOM, NO globals, NO IndexedDB — those live in the coordinator. This
// module obeys the same import boundary as every other `dashboard/application`
// file: only `src/dashboard/**`, `src/workspace/**` types, `src/core/**`, and
// `src/generated/**`.

import { buildDashboardExportBundle } from '../model/dashboard-export.js';
import { decodePortableBundleJson, encodePortableBundleJson } from '../model/portable-bundle-codec.js';
import { diagnostic } from '../model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../model/workspace-diagnostics.js';
import type { HandoffRecord } from '../../workspace/handoff-store.types.js';
import type { DashboardOpenSource } from './dashboard-open-source.js';
import type {
  DashboardDocumentV1, PortableBundleV1, SavedQueryV2, StoredWorkspaceV1,
} from '../../generated/json-schema.types.js';

export type BuildViewHandoffRecordResult =
  | { ok: true; record: HandoffRecord }
  | { ok: false; diagnostics: WorkspaceDiagnostic[] };

/**
 * Build the one-time handoff record for opening a Dashboard in view mode:
 * snapshot `dashboard` plus its dependency closure (`buildDashboardExportBundle`)
 * into a portable bundle, canonically encode it, and assemble the record the
 * coordinator writes to the handoff store. `nowISO`/`expiresAt`/
 * `detachedWorkspaceId` are all supplied by the caller — every impure source
 * (clock, id generator) lives in app.ts, never here.
 */
export function buildViewHandoffRecord(
  dashboard: DashboardDocumentV1,
  queries: readonly SavedQueryV2[],
  opts: { detachedWorkspaceId: string; expiresAt: number; nowISO: string },
): BuildViewHandoffRecordResult {
  const bundle = buildDashboardExportBundle(dashboard, queries, opts.nowISO);
  const encoded = encodePortableBundleJson({
    queries: bundle.queries, dashboards: bundle.dashboards, nowISO: bundle.exportedAt,
  });
  if (!encoded.ok) return { ok: false, diagnostics: encoded.diagnostics };
  return {
    ok: true,
    record: {
      text: encoded.value,
      dashboardId: dashboard.id,
      detachedWorkspaceId: opts.detachedWorkspaceId,
      expiresAt: opts.expiresAt,
    },
  };
}

export type MaterializeDetachedWorkspaceResult =
  | { ok: true; workspace: StoredWorkspaceV1 }
  | { ok: false; diagnostics: WorkspaceDiagnostic[] };

/**
 * Materialize a consumed handoff record's bundle text into a detached,
 * read-only `StoredWorkspaceV1`. Decodes and validates `text`, selects the
 * Dashboard matching `dashboardId` out of the bundle (failing with a single
 * diagnostic when absent), and assembles the detached workspace under
 * `detachedWorkspaceId`. `name` is the selected Dashboard's title, falling
 * back to `'Dashboard'` when the title is empty.
 */
export function materializeDetachedWorkspace(
  text: string, dashboardId: string, detachedWorkspaceId: string,
): MaterializeDetachedWorkspaceResult {
  const decoded = decodePortableBundleJson(text);
  if (!decoded.ok) return { ok: false, diagnostics: decoded.diagnostics };
  const bundle: PortableBundleV1 = decoded.value;
  const selected = bundle.dashboards.find((candidate) => candidate.id === dashboardId);
  if (!selected) {
    return {
      ok: false,
      diagnostics: [diagnostic(['dashboards'], 'dashboard-not-found', `Dashboard ${dashboardId} not found in bundle`)],
    };
  }
  return {
    ok: true,
    workspace: {
      storageVersion: 1,
      id: detachedWorkspaceId,
      name: selected.title || 'Dashboard',
      queries: bundle.queries,
      dashboard: selected,
    },
  };
}

/** Pure mode resolution result for a parsed `current-workspace` open source. */
export type DashboardModeResolution =
  | { mode: 'edit'; workspace: StoredWorkspaceV1 }
  | { mode: 'view'; workspace: StoredWorkspaceV1 }
  | { mode: 'not-found' };

const matches = (
  workspace: StoredWorkspaceV1 | null, source: Extract<DashboardOpenSource, { kind: 'current-workspace' }>,
): workspace is StoredWorkspaceV1 =>
  !!workspace && workspace.id === source.workspaceId && workspace.dashboard?.id === source.dashboardId;

/**
 * Resolve a parsed `current-workspace` `DashboardOpenSource` against the two
 * candidate workspaces already loaded by the coordinator: `primary` (from the
 * shared `asb-workspace` store) and `detached` (from the `asb-dashboard-views`
 * detached-views store). Both the workspace id AND the Dashboard id must
 * match — a workspace id match with a differing (or missing) Dashboard id is
 * `not-found`, never a silent fall-through to edit mode.
 */
export function resolveDashboardMode(
  source: Extract<DashboardOpenSource, { kind: 'current-workspace' }>,
  primary: StoredWorkspaceV1 | null,
  detached: StoredWorkspaceV1 | null,
): DashboardModeResolution {
  if (matches(primary, source)) return { mode: 'edit', workspace: primary };
  if (matches(detached, source)) return { mode: 'view', workspace: detached };
  return { mode: 'not-found' };
}
