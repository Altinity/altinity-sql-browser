// Creating ONE Dashboard document — the single command behind every entry
// point that mints one (#481, #495 review 3).
//
// #481 asked for one `createDashboard` action, and #429 phase 3 delivered half
// of it: the File menu and the empty-workspace placeholder came to share a
// dialog and the pure `appendDashboard` transform, but kept two separate
// commands around them. They disagreed about the thing that matters least
// often and hurts most when it happens — the File menu toasted a rejected
// persistence/validation outcome, the placeholder silently did nothing — and
// nothing stopped a third rule diverging later.
//
// So the MINT + APPEND + report decision lives here, once. What each caller
// still owns is its REVEAL policy, which is genuinely different: the File menu
// opens the new Dashboard in Edit mode and swaps the sidebar to the Dashboards
// tree, while the placeholder selects it in whichever mode the surface is
// already showing. Those are navigation choices about where the user was, not
// creation rules.
//
// Typed against a structural deps bag rather than `App`: `src/application/**`
// must never import `src/ui/**` (build/check-boundaries.mjs), and both the real
// `App` and `ui/dashboard.ts`'s narrower `DashboardApp` satisfy it directly.

import { createEmptyDashboard } from '../dashboard/application/empty-dashboard.js';
import { appendDashboard } from '../workspace/workspace-operations.js';
import type { MutateWorkspace, WorkspaceMutationOutcome } from '../state.js';
import type { StoredWorkspaceV5 } from '../generated/json-schema.types.js';

/** The created Dashboard's id, threaded back through `mutateWorkspace`'s
 *  `data` channel so a caller can navigate to exactly what was committed
 *  without reading it back out of the aggregate. */
export type DashboardCreateOutcome = WorkspaceMutationOutcome<string>;

export interface DashboardCreateDeps {
  /** The serialized, read-latest-at-dequeue write primitive every workspace
   *  producer commits through. */
  mutateWorkspace: MutateWorkspace;
  /** Mints the new document's id through the injected `crypto.randomUUID`
   *  seam, like every other producer. */
  genId(): string;
  /**
   * What to append onto when NOTHING is persisted yet — `mutateWorkspace`
   * hands the transform `null` for a workspace that has never been committed,
   * and the very first Dashboard of a fresh workspace is created exactly
   * there. Each caller answers with the freshest baseline it has (the File
   * menu folds its live in-memory Dashboard in; the Dashboard surface hands
   * over its projected aggregate), and `null` — no workspace at all — aborts,
   * committing nothing.
   */
  baseline(): StoredWorkspaceV5 | null;
}

/**
 * Append one empty Dashboard named `name`, and answer what happened.
 *
 * The document is minted BEFORE the commit is queued, and deliberately: an
 * empty Dashboard's content does not depend on the baseline — only the APPEND
 * does, and that runs inside the transform against dequeue-time truth. That is
 * what lets a caller navigate to `outcome.data` without re-reading the
 * aggregate.
 *
 * Additive by construction: `appendDashboard` preserves every existing
 * Dashboard and query in place, so this can never reach `dashboards[0]` or the
 * compatibility slot. It aborts — committing nothing — only when neither a
 * persisted aggregate nor a caller baseline exists.
 */
export async function createDashboard(
  deps: DashboardCreateDeps, name: string,
): Promise<DashboardCreateOutcome> {
  const created = createEmptyDashboard(deps.genId(), name);
  return deps.mutateWorkspace<string>((latest) => {
    const base = latest ?? deps.baseline();
    return base === null ? null : { candidate: appendDashboard(base, created), data: created.id };
  });
}

/**
 * What to tell the user about a creation attempt — the same sentence from
 * whichever entry point ran it (#495 review 3). `null` means say nothing.
 *
 * Modeled on `library-assignment-service.ts`'s `libraryAssignmentMessage`: the
 * pure message mapping lives beside the command, in the layer that knows the
 * outcome shape, while the toast itself stays with the UI — `src/application/**`
 * cannot reach `ui/toast.ts`.
 *
 * An abort is silent on purpose: nothing was committed and nothing was lost —
 * the only reachable abort is "no workspace loaded", which is not a failure the
 * user caused or can act on.
 */
export function dashboardCreateMessage(outcome: DashboardCreateOutcome): string | null {
  if (outcome.ok) return 'Created dashboard';
  if (outcome.aborted) return null;
  return '✕ ' + (outcome.diagnostics[0]?.message || 'Could not save workspace');
}
