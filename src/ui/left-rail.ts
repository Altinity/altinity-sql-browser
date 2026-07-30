// #487 phase 3 — the compact icon rail. Four launcher buttons, one per
// `LEFT_NAV_SECTIONS` entry (rail order), built from the section registry
// (`nav-sections.ts`) so a rail tooltip/aria-label can never disagree with the
// wide switchers' own label for the same section.
//
// This module owns DOM + behaviour only: the rail's WIDTH (`LEFT_RAIL_PX`) is
// informational here and is CSS's job in a later step, and the drawer this
// rail's buttons control does not exist as a separate element yet — `showSection`
// keeps living on the section registry, this module just points every button's
// `aria-controls` at whatever single id a later step gives the drawer container.
//
// Reactivity: each button's `aria-expanded` is driven by its own `effect()`
// reading `state.leftNavSection` — a section's drawer is "open" exactly when
// `state.leftNavSection.value === section` (`application/left-nav.ts`'s own
// notion of the focused section). One effect per button, not one for the whole
// rail — all four still subscribe to the same signal and so all four re-run on
// every change (signals have no per-effect diffing that would let only the two
// buttons whose expanded state actually flipped react), but each is a single
// attribute write, so four small effects stay a reasonable design without
// claiming a selectivity the primitive doesn't provide.
//
// A rail click is a TOGGLE (`toggleFocusedSection`), not an idempotent open
// (`openFocusedSection`): clicking the already-open section's icon closes the
// drawer, which is #487's own rail-click semantics and is NOT what the
// drag-hover seam (#428) wants — that seam calls `openFocusedSection` directly,
// bypassing this module entirely.

import { effect } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';
import { h } from './dom.js';
import { LEFT_NAV_SECTIONS } from '../core/left-nav-layout.js';
import type { LeftNavigationSection } from '../core/left-nav-layout.js';
import { toggleFocusedSection } from '../application/left-nav.js';
import type { LeftNavApp } from '../application/left-nav.js';
import type { NavSectionRegistry } from './nav-sections.js';

/** The state slice the rail reads — just enough to know which section (if any)
 *  the focused drawer currently shows. */
export interface LeftRailStateSlice {
  readonly leftNavSection: Signal<LeftNavigationSection | null>;
}

export interface LeftRailDeps {
  /** Reused verbatim from `application/left-nav.ts` — a click routes through
   *  its own `toggleFocusedSection`, never a locally re-implemented write. */
  app: LeftNavApp;
  /** Only metadata lookup is needed — the rail neither renders a section's own
   *  content nor decides which pane exposes it. */
  registry: Pick<NavSectionRegistry, 'entry'>;
  state: LeftRailStateSlice;
  /** The stable DOM id of the (single, content-swapping) focused-drawer
   *  container a later step gives the sidebar element — every launcher's
   *  `aria-controls` points at this same id, since all four buttons control
   *  the one drawer, just with different content. */
  drawerElementId: string;
}

export interface LeftRailHandle {
  readonly el: HTMLElement;
  /** Stop every per-button reactive effect. Idempotent-safe to call once. */
  dispose(): void;
  /**
   * Move focus to `section`'s own launcher button. #487 phase 3 step 4's
   * Escape handler (`app-shell.ts`) calls this to return focus to the rail
   * icon that opened a focused drawer once Escape has closed it — a no-op if
   * `section` somehow has no button (unreachable in practice: every member of
   * `LEFT_NAV_SECTIONS` gets one below).
   */
  focusSection(section: LeftNavigationSection): void;
}

/**
 * Build the rail `<nav>` and its four launcher buttons. Icon-only: no text
 * label, `title` carries the short section name (#487's own "Rail state"
 * table names it `title`), `aria-label` carries the longer "Open … navigation"
 * sentence `NAV_SECTION_META` already defines for exactly this purpose — the
 * two are deliberately different strings, not one value doing double duty.
 *
 * Active-state styling hook: `aria-expanded="true"` on the active section's
 * button IS the active-state selector (`[aria-expanded="true"]`) — no separate
 * `.active` class, since the ARIA attribute already carries that information
 * and a second copy of it would be one more place for the two to drift apart.
 */
export function buildLeftRail(deps: LeftRailDeps): LeftRailHandle {
  const { app, registry, state, drawerElementId } = deps;
  const disposers: (() => void)[] = [];
  // Keyed by section rather than array index, so `focusSection` reads as "the
  // button for THIS section" rather than relying on `LEFT_NAV_SECTIONS` order
  // staying in sync with wherever a caller indexes from.
  const buttonsBySection = new Map<LeftNavigationSection, HTMLButtonElement>();

  const buttons = LEFT_NAV_SECTIONS.map((section) => {
    const entry = registry.entry(section);
    const button = h('button', {
      type: 'button',
      class: 'left-rail-btn',
      title: entry.label,
      'aria-label': entry.accessibleLabel,
      'aria-controls': drawerElementId,
      'aria-expanded': 'false',
      // Explicit `button.focus()`, not left to the browser's native
      // click-focus behaviour: Chromium/Firefox focus a clicked `<button>`
      // automatically, so closing an open drawer by clicking its own icon
      // happens to leave focus on that icon there — matching the Escape path's
      // EXPLICIT `leftRail.focusSection(section)` call in `app-shell.ts`.
      // WebKit/Safari does NOT natively focus a clicked button (a real,
      // long-standing engine difference), so without this call Safari drops
      // focus to `<body>` on close instead of returning it to the rail icon,
      // an inconsistency with the Escape path's cross-browser-reliable
      // behaviour. Ordering relative to `toggleFocusedSection` does not
      // matter — focusing the button does not depend on the section's
      // resulting open/closed state.
      onclick: () => { toggleFocusedSection(app, section); button.focus(); },
    }, entry.icon());
    buttonsBySection.set(section, button);
    disposers.push(effect(() => {
      button.setAttribute('aria-expanded', state.leftNavSection.value === section ? 'true' : 'false');
    }));
    return button;
  });

  const el = h('nav', { class: 'left-rail', 'aria-label': 'Navigation rail' }, ...buttons);

  return {
    el,
    dispose: () => { for (const dispose of disposers) dispose(); },
    focusSection: (section) => { buttonsBySection.get(section)?.focus(); },
  };
}
