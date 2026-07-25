// The deterministic click arbiter for member trees (#426). Pure: the timer
// functions are injected, so this module has no DOM and no globals.
//
// The schema tree (`ui/schema.ts`) distinguishes single from double clicks
// POST HOC — its single-click action runs immediately and a quick repeat runs the
// double action IN ADDITION. That is harmless there, because the first click's
// action is expansion. It is NOT harmless in the Dashboard tree, where a panel
// row's single action opens a query: the first click would flash the Query
// surface, write a history entry, and only then would the second click open the
// Dashboard. #426 therefore requires arbitration rather than detection — the
// single action is SCHEDULED for the double-click window and cancelled outright
// if a second click arrives.
//
// Neither tree uses the native `dblclick` event: every click re-renders the tree,
// which swaps the row node between a double-click's two clicks, and Firefox
// refuses to fire `dblclick` across that swap (`ui/schema.ts` documents the same
// finding).

/** The double-click window, shared with the schema tree's own post-hoc detector
 *  so the two trees can never disagree about what "a quick repeat" means. */
export const DBLCLICK_MS = 300;

/** What one row press could do. Every field is optional: a panel row whose query
 *  reference is unresolved has no `single`, a group row has no `double`, and only
 *  a Shift-click supplies `immediate`. */
export interface ClickActions {
  /** Runs after the double-click window closes, if no second press arrives. */
  single?: (() => void) | null;
  /** Runs instead, as soon as a second press on the SAME key arrives. */
  double?: (() => void) | null;
  /** Runs now, cancelling any pending single (Shift-click). */
  immediate?: (() => void) | null;
}

export interface ClickArbiterDeps {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  /** Overridable for tests; defaults to `DBLCLICK_MS`. */
  delayMs?: number;
}

export interface ClickArbiter {
  /** Arbitrate one primary press on the row identified by `key`. */
  press(key: string, actions: ClickActions): void;
  /**
   * Drop any pending single action without running it. Called when the tree is
   * disposed and when the workspace or the sidebar role changes — a deferred
   * "open this query" must not fire against a tree that is no longer on screen.
   */
  cancel(): void;
}

export function createClickArbiter(
  { setTimeout: schedule, clearTimeout: unschedule, delayMs = DBLCLICK_MS }: ClickArbiterDeps,
): ClickArbiter {
  let pending: { key: string; handle: number } | null = null;

  const cancel = (): void => {
    if (!pending) return;
    unschedule(pending.handle);
    pending = null;
  };

  return {
    press(key, actions) {
      // Shift is unambiguous, so it never waits — and it must also kill a single
      // that a preceding plain click already scheduled.
      if (actions.immediate) {
        cancel();
        actions.immediate();
        return;
      }
      const repeat = pending !== null && pending.key === key;
      cancel();
      if (repeat) {
        actions.double?.();
        return;
      }
      // The window opens even when there is NO single action to defer: a
      // source-less filter row has query-open disabled but still answers a
      // double-click with Dashboard navigation, so the second press has to be
      // recognisable as a repeat.
      const single = actions.single ?? null;
      pending = {
        key,
        handle: schedule(() => {
          pending = null;
          single?.();
        }, delayMs),
      };
    },
    cancel,
  };
}
