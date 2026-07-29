// What a Dashboard panel tile's `⋯` menu offers, as data (#538 follow-up).
//
// #535 put duplicate, widen and expand in the tile head beside the drag grip and
// the delete button, which made five controls compete with the tile title for one
// flex row — and on a tile a single grid column wide there is no row left to
// compete for. Four of the five move into an overflow menu, and this module is
// the decision about what that menu says.
//
// The split mirrors the Dashboards tree's own (`application/dashboard-tree-model.ts`):
// a pure resolver answers WHICH actions exist, what they are called, and why one
// cannot run right now; the render module maps kinds to handlers and builds DOM.
// That is what keeps the branching out of `ui/dashboard.ts`, which is
// integration-tested browser glue held to looser floors.
//
// Two deliberate differences from #535's head buttons:
//
//   - All four kinds are ALWAYS returned, in one fixed order. A menu whose
//     vocabulary changes with the layout style teaches the user nothing, and the
//     row is itself the place to explain why an action is unavailable — the same
//     argument #452 settled for the File menu, and the reason `MenuRow` carries a
//     `reason` slot at all. #535's rule for the head was the opposite ("nothing
//     to open means no control, not a disabled one"), which is right for a bare
//     icon with only a tooltip to explain itself.
//   - Widen's unavailability is a SENTENCE, not an absence. Under `report`/`full`
//     and on a flow KPI band member there genuinely is no width to step, and
//     saying so beats a row that silently vanishes.
//
// Pure — no DOM, no persistence, never reads the clock or a global.

import { canWidenPanel, widenLabel } from './panel-widen.js';
import type { DashboardStyle } from './dashboard-viewer-session.js';
import type { PanelRemovalRefusal } from './dashboard-removal.js';

export type PanelTileActionKind = 'duplicate' | 'widen' | 'open' | 'remove';

export interface PanelTileAction {
  kind: PanelTileActionKind;
  /** The menu row's label. Widen's is dynamic — it names the width the next
   *  press produces — so it is resolved here rather than being a constant. */
  label: string;
  /** Why this action cannot run right now, or `null` when it can. The row is
   *  still LISTED either way. */
  unavailable: string | null;
  /** The question to ask before running it. Non-null only for an AVAILABLE
   *  destructive action: there is nothing to confirm about a refusal. */
  confirm: string | null;
  /** Needs a confirmation and destructive styling, and sorts last behind a
   *  separator. A flag rather than a `kind === 'remove'` test at each use: the
   *  render module should not have to know which kind is the dangerous one. */
  destructive: boolean;
}

export interface PanelTileActionsInput {
  /** The tile's resolved display title — what every label names. */
  title: string;
  /** The owning Dashboard's title, for the removal question. */
  dashboardTitle: string;
  /** The style whose widths a widen press steps through, or `null` when there
   *  are none (`report`, `full`, or flow below the mobile breakpoint). */
  widenStyle: DashboardStyle | null;
  /** The tile's PERSISTED placement — never a render-mode-overridden effective
   *  span, or the label would name a width the next press does not produce. */
  placement: unknown;
  /** A flow KPI band member: the band is a full-width flex stream that ignores
   *  span entirely, so such a tile has no width of its own at any style. */
  kpiBandMember: boolean;
  /** The tile's `queryId` resolves to a document in this workspace. */
  queryResolves: boolean;
  /** The panel is queryless BY CAPABILITY — a text panel, which has a saved
   *  query document but nothing to run in a Workbench tab. */
  queryless: boolean;
  /** What `removeDashboardPanel` would refuse right now (`panelRemovalRefusal`),
   *  or `null` when the removal would go through. */
  removalRefusal: PanelRemovalRefusal | null;
}

/**
 * Why a removal is unavailable, in the PRESENT tense.
 *
 * Deliberately not shared with `dashboardDeleteMessage`, which phrases the same
 * six states in the past tense for a toast ("…so nothing was deleted"): one set
 * explains a control that has not been pressed, the other reports a write that
 * refused. The tree already keeps two such sets for exactly this reason.
 *
 * A `Record` over the union rather than a `switch`, so adding a
 * `PanelRemovalRefusal` arm cannot compile until it is phrased here.
 */
const REMOVAL_REASONS: Record<PanelRemovalRefusal, string> = {
  'dashboard-missing': 'This dashboard is no longer part of the workspace.',
  'dashboard-duplicate': 'Two dashboards share this id, so nothing can be removed safely.',
  'tile-missing': 'This panel is no longer part of the dashboard.',
  'tile-duplicate': 'Two resources share this id, so nothing can be removed safely.',
  'tile-retargeted': 'This panel now shows a different query.',
  'ownership-unproven': 'This panel’s query is shared, missing, or not a panel query.',
};

const NO_WIDTH_BAND = 'A KPI band is one full-width stream, so this panel has no width to change.';
const NO_WIDTH_STYLE = 'This layout has a single column, so there is no width to change.';
const NO_QUERY_TEXT = 'A text panel has no query to open.';
const NO_QUERY_MISSING = 'This panel’s query is not in this workspace.';

/** Double quotes in the app's own typographic style, matching the tree's
 *  confirmation wording so the two surfaces ask the same question. */
const quoted = (value: string): string => '“' + value + '”';

/** Why widen cannot run, or `null`. The band check comes first: a band member
 *  has no width under ANY style, so the style is not the interesting answer. */
function widenUnavailable(input: PanelTileActionsInput): string | null {
  if (input.kpiBandMember) return NO_WIDTH_BAND;
  return input.widenStyle === null ? NO_WIDTH_STYLE : null;
}

/** Widen's label. Falls back to the bare verb when there is no style to read a
 *  destination width from — an unavailable row still needs something to say. */
function widenRowLabel(input: PanelTileActionsInput): string {
  const style = input.widenStyle;
  if (style === null || input.kpiBandMember || !canWidenPanel(style)) return 'Widen';
  return widenLabel({ style, placement: input.placement });
}

/** Why expand cannot run, or `null`. Queryless is checked first because it is a
 *  capability rather than a fault: a text panel is not broken. */
function openUnavailable(input: PanelTileActionsInput): string | null {
  if (input.queryless) return NO_QUERY_TEXT;
  return input.queryResolves ? null : NO_QUERY_MISSING;
}

/**
 * The four actions a panel tile's `⋯` menu offers, in paint order.
 *
 * Order is #535's design order — duplicate, widen, expand — with remove last.
 * The destructive control is the one whose position must not shift as the labels
 * above it change, and it is the only one the render module separates.
 */
export function panelTileActions(input: PanelTileActionsInput): readonly PanelTileAction[] {
  const removalUnavailable = input.removalRefusal === null
    ? null : REMOVAL_REASONS[input.removalRefusal];
  return [
    {
      kind: 'duplicate',
      label: 'Duplicate panel',
      // Duplication has no precondition this surface can check: it mints a new
      // owned query clone, and its own refusals (a vanished source, a workspace
      // that moved on) are commit-time outcomes reported as a toast (#535).
      unavailable: null,
      confirm: null,
      destructive: false,
    },
    {
      kind: 'widen',
      label: widenRowLabel(input),
      unavailable: widenUnavailable(input),
      confirm: null,
      destructive: false,
    },
    {
      kind: 'open',
      label: 'Open in Workbench and run',
      unavailable: openUnavailable(input),
      confirm: null,
      destructive: false,
    },
    {
      kind: 'remove',
      label: 'Remove tile',
      unavailable: removalUnavailable,
      // The question names BOTH resolved titles and says what else goes with the
      // tile: #427 makes the panel the sole owner of a saved-query copy, so a
      // removal that only said "remove this tile" would understate itself.
      confirm: removalUnavailable !== null ? null
        : 'Remove panel ' + quoted(input.title) + ' from ' + quoted(input.dashboardTitle)
          + '? This also deletes its dedicated query copy.',
      destructive: true,
    },
  ];
}
