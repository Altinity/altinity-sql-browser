// Committing ONE Dashboard variable's option-SQL configuration (#457).
//
// #447 phase 1 put this next to the variable-SQL drawer it was written for, in
// `ui/variable-editor.ts`. #457 deleted that drawer — option SQL is edited in the
// main editor as a `dashboard-variable` tab now — so the write moved out with it,
// split along the layer boundary this repo holds everywhere else:
//
//   - the PURE transform is `workspace/workspace-dashboards.ts`'s
//     `withVariableConfig`, beside `findDashboard`/`replaceDashboard` and the
//     exactly-one-match rule it depends on;
//   - the async `mutateWorkspace` plumbing is here.
//
// Two callers share it: the variable tab's Save (`ui/app.ts`) and the Dashboards
// tree's orphan-delete affordance (`ui/dashboard-tree.ts`), which removes a
// configuration no panel declares any more.
//
// This module is deliberately typed against a structural `MutateWorkspace` rather
// than the `App` contract: `src/application/**` must never import `src/ui/**`
// (build/check-boundaries.mjs), and a real `App` satisfies the narrow shape below
// directly.

import type {
  MutateWorkspace, WorkspaceExternallyChangedInfo, WorkspaceMutationOutcome,
} from '../state.js';
import { withVariableConfig } from '../workspace/workspace-dashboards.js';
import type { VariableConfigInput } from '../workspace/workspace-dashboards.js';

/** Why the transform itself declined, threaded back through `mutateWorkspace`'s
 *  `data` channel. It is the ONE abort this module can explain: every other
 *  `aborted` outcome comes from the primitive (the route moved on, the record
 *  vanished), and at least one of those keeps a durable write — see
 *  `mutateWorkspace`'s own "Keep that durable write" branch. A caller that
 *  collapsed them all into one boolean would report three of them wrongly. */
export type VariableConfigAbort = 'declined';

export type VariableConfigOutcome = WorkspaceMutationOutcome<VariableConfigAbort>;

/** The narrow slice of the app a configuration write needs. */
export interface VariableConfigDeps {
  /** The serialized, read-latest-at-dequeue write primitive every workspace
   *  producer commits through. */
  mutateWorkspace: MutateWorkspace;
  /** "Re-read the committed workspace" (#447 phase 2). A viewer session reads
   *  `variableConfigs` ONCE, at construction — option SQL is not something
   *  `syncDocument` adopts — so without this, storing option SQL (or clearing it
   *  back to direct input, or deleting an orphan) changed the stored document
   *  while the on-screen controls kept running the previous configuration.
   *  `ui/dashboard.ts` binds it while a Dashboard is rendered.
   *
   *  Required, not optional: #447 declared it optional on the drawer's own narrow
   *  app slice and invoked it as `?.()` — with NO argument, against an `App`
   *  member that requires one. That only escaped `tsc` because the drawer was
   *  always reached through the tree's narrower type, and only escaped at runtime
   *  because both real handlers ignore what they are passed. This module is handed
   *  the real `App`, so it honours the contract and reports the commit properly. */
  onWorkspaceExternallyChanged(info: WorkspaceExternallyChangedInfo): void;
}

/**
 * Store (`config`) or remove (`null`) one variable's configuration, re-reading
 * committed truth at dequeue time and aborting — committing nothing — when the
 * workspace is gone or the Dashboard id names no single entry.
 *
 * Resolves the full mutation outcome so the caller can distinguish "this
 * Dashboard no longer resolves" (`aborted`, `data === 'declined'`) from "the app
 * navigated while the write was in flight" (`aborted`, no `data`) from "the
 * aggregate rejected the candidate" (`diagnostics`). Only a real commit pokes
 * `onWorkspaceExternallyChanged`: an aborted transform changed nothing, so there
 * is nothing for a rendered Dashboard to re-read.
 */
export async function commitVariableConfig(
  deps: VariableConfigDeps,
  dashboardId: string,
  name: string,
  config: VariableConfigInput | null,
): Promise<VariableConfigOutcome> {
  const outcome = await deps.mutateWorkspace<VariableConfigAbort>((latest) => {
    if (latest === null) return { candidate: null, data: 'declined' };
    const candidate = withVariableConfig(latest, dashboardId, name, config);
    return candidate === null ? { candidate: null, data: 'declined' } : { candidate };
  });
  // `queriesChanged: false` is a fact, not a default: this write touches exactly
  // one Dashboard's `variableConfigs` and can never add, remove or edit a query.
  if (outcome.ok) {
    deps.onWorkspaceExternallyChanged({ workspace: outcome.workspace, queriesChanged: false });
  }
  return outcome;
}
