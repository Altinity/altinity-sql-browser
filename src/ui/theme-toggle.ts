// The shared theme-toggle DOM composition (#276 Phase 5) — state-flip +
// persist (`prefs.toggleTheme()`) composed with the `data-theme` attribute
// write and the CURRENT theme button's icon swap. Both route shells wire
// their own theme button's `onclick` straight to this one helper:
// `ui/workbench/workbench-shell.ts`'s header theme button (via app.ts's
// `toggleTheme` composition — see below) and `ui/dashboard.ts`'s own
// `dash-icobtn` (directly).
//
// `App.toggleTheme` itself (app.ts) is kept as a thin wrapper around this —
// NOT deleted, even though both route shells could now do without it —
// because `explain-graph.ts`'s detached schema-graph overlay takes
// `app.toggleTheme` itself as an optional callback (only for the MAIN
// document's own view; a detached tab flips its own local copy without
// persisting), and that seam's one call site (app.ts's `expandSchemaGraph`,
// `openSchemaView(app as DetachedGraphApp)`) only ever has the real `app`
// object in hand, not this helper's own deps bag — repointing it isn't a
// mechanical change, so `App.toggleTheme` survives as the flat delegate for
// that one consumer (issue #276 Phase 5 ruling).

import { Icon as IconUntyped } from './icons.js';
import type { AppPreferences } from '../application/app-preferences.js';

// icons.js is unconverted — pin the two icons this helper actually swaps
// between, same convention as dashboard.ts's own typed `Icon` wrapper.
const Icon: { sun(): SVGElement; moon(): SVGElement } = IconUntyped;

export interface ToggleThemeDomDeps {
  prefs: Pick<AppPreferences, 'toggleTheme'>;
  document: Document;
  /** The button whose icon reflects the CURRENT theme, resolved FRESH on
   *  every call (a function, not a snapshotted element) — each route resets
   *  and rebuilds its own theme button on every render, so a caller must
   *  always hand back whichever one is live right now. `undefined` (e.g. a
   *  test with no button mounted) is a no-op for the icon swap; the state
   *  flip + persist + `data-theme` write still happen. */
  themeBtn(): HTMLElement | undefined;
}

/** Flip the theme, persist it, write `data-theme`, and swap the current
 *  theme button's icon. Returns the new theme (light/dark) for a caller
 *  that wants it without re-reading state. */
export function toggleThemeDom(deps: ToggleThemeDomDeps): string {
  const theme = deps.prefs.toggleTheme();
  deps.document.documentElement.setAttribute('data-theme', theme);
  const btn = deps.themeBtn();
  if (btn) btn.replaceChildren(theme === 'dark' ? Icon.sun() : Icon.moon());
  return theme;
}
