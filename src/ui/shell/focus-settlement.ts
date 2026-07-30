// #577 state S2 (Preact treatment) — focus across a structural transition.
//
// THE PROBLEM, RESTATED FROM #577. A presentation change can remove the element
// that currently has focus: a wide sidebar folds to a bare rail, a drawer
// closes, a phone switches panel, an inspector folds. The requirement is fixed
// and identical for both arms:
//
//   capture user intent BEFORE the transition can remove the focused source;
//   do not restore during intermediate drag frames;
//   settle AFTER the destination is rendered;
//   cancel stale work; never steal a NEWER user focus;
//   never leave focus on `<body>` merely because chrome folded.
//
// WHY THIS CANNOT BE A HOOK. Preact offers no "before the DOM changes" hook:
// `useLayoutEffect` cleanups run after the diff has already been applied, so by
// the time any component-owned code runs, the element that held focus may
// already be inside a hidden subtree and the browser is already dropping focus
// to `<body>` on its own (verified against a real Chromium instance — see
// `app-shell.ts`'s own comment on the same fact in the vanilla arm). The
// component model therefore does NOT delete this category of work. It only
// moves where it can legally live.
//
// So capture happens at the COMMAND boundary — the rail click, the Escape, the
// separator's commit, the bottom-nav tap, `showHost`, the mobile crossing —
// which is also literally what #577 asks for ("capture user intent before a
// structural transition can remove the focused source"). Settlement happens
// from a layout effect once the destination exists. The two halves are this
// module; the policy for WHICH destination is the caller's, because only the
// caller knows what a given transition means.
//
// This module is the honest test of the evaluation's flagged weak premise ("one
// owner per subtree deletes the focus-rescue category"). It does not. What
// changes is that the capture/settle protocol is stated once and reused, rather
// than re-derived inline at each of the vanilla arm's four rescue sites — and
// the report must claim exactly that much and no more.

/** The `document` surface this module reads. Narrowed so a plain fixture
 *  satisfies it and so nothing here can reach for anything else. */
export interface FocusDocument {
  readonly activeElement: Element | null;
  readonly body: Element | null;
}

/** A focus destination. `null`/`undefined` means "this transition has no
 *  semantic destination" — the settler then leaves focus exactly where the
 *  browser left it rather than inventing a landing spot. */
export type FocusDestination = HTMLElement | null | undefined;

export interface FocusSettler {
  /**
   * Record where focus is, if it is inside `container`, immediately BEFORE a
   * command that may re-present or hide that container. Outside `container`
   * (or nowhere) there is nothing this transition can destroy, so nothing is
   * captured and the matching `settle` is a no-op — that is what keeps a
   * transition from stealing focus a user put somewhere else entirely.
   *
   * A second capture before the first settles REPLACES it: the newer intent is
   * the live one, and the older is cancelled rather than queued.
   */
  capture(container: Element | null): void;
  /**
   * Settle a captured intent onto `resolve`'s destination, after the
   * destination has been rendered. A no-op when nothing was captured.
   *
   * Refuses to move focus when something else already holds it — if
   * `activeElement` is neither the captured element nor `body`/null, a newer
   * focus won the race and this transition must not fight it. That is the
   * "never steal a newer user focus" rule, and it is also why the captured
   * element itself counts as settleable: a browser that has not yet dropped
   * focus out of the now-hidden subtree still reports it as active.
   *
   * Single-shot: the intent is consumed whether or not a destination was
   * found, so a later unrelated render cannot resurrect it.
   */
  settle(resolve: (intent: Element) => FocusDestination): void;
  /** True while an intent is captured and unsettled — the caller uses this to
   *  skip settlement during intermediate frames of a live gesture. */
  pending(): boolean;
  /** Drop any captured intent without settling it. Used when the transition
   *  that captured it was abandoned (a cancelled resize session, a teardown). */
  cancel(): void;
}

/**
 * Build a settler over `doc`.
 *
 * One per shell mount. Deliberately NOT a module-level singleton: two mounts in
 * one page (a test, or a second window) must not share an intent, and a
 * disposed shell's pending intent must die with it.
 */
export function createFocusSettler(doc: FocusDocument): FocusSettler {
  // The element that held focus when the command was issued, or null when this
  // transition captured nothing. `undefined` is deliberately not used as a
  // sentinel here — `captured === null` after a real capture is impossible,
  // because capture only records an Element it has already proven is inside the
  // container.
  let captured: Element | null = null;

  return {
    capture: (container) => {
      const active = doc.activeElement;
      captured = container !== null && active !== null && container.contains(active) ? active : null;
    },
    settle: (resolve) => {
      if (captured === null) return;
      const intent = captured;
      captured = null;
      // Focus already gone (the browser dropped it out of a hidden subtree), or
      // still on the very element we captured — either is ours to settle.
      // Anything else means a newer focus won the race.
      const active = doc.activeElement;
      if (active !== null && active !== doc.body && active !== intent) return;
      // The intent is handed to the resolver because some destinations can only
      // be derived from WHERE focus was — a wide sidebar folding to rail has no
      // tracked `focusedSection` to fall back on (the coherence invariant keeps
      // it null throughout 'wide'), so the captured element's own
      // `[data-section]` ancestor is the only thing that names the section.
      resolve(intent)?.focus();
    },
    pending: () => captured !== null,
    cancel: () => { captured = null; },
  };
}
