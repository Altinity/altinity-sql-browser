import { describe, it, expect, vi } from 'vitest';
import {
  buildSidePanelRegistry, buildProductionSidePanelRegistry, renderSidePanelTabs, MOBILE_PANES,
} from '../../src/ui/side-panel-registry.js';
import type { SidePanelDef, MountedSidePanel } from '../../src/ui/side-panel-registry.js';
import { SIDE_PANELS } from '../../src/core/side-panels.js';
import type { SidePanelId, SidePanelPane } from '../../src/core/side-panels.js';
import { makeApp } from '../helpers/fake-app.js';

/** A minimal fake panel: records every lifecycle call, and lets a test push
 *  arbitrary "current data" into its render(). Mirrors the shape a real
 *  panel (Library/History/Databases/Dashboards) implements. */
function fakeDef(over: Omit<Partial<SidePanelDef>, 'id'> & { id: string; pane: SidePanelPane }): SidePanelDef & {
  calls: { mount: number; render: number; activate: number; deactivate: number; dispose: number };
  data: string;
} {
  const calls = { mount: 0, render: 0, activate: 0, deactivate: 0, dispose: 0 };
  const state = { value: 'initial' };
  let list: HTMLElement | null = null;
  const def = {
    label: over.label ?? over.id, icon: over.icon ?? (() => document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
    accessibleLabel: over.accessibleLabel ?? `Open ${over.id}`,
    tabAdornment: over.tabAdornment,
    host: over.host,
    ...over,
    mount(host: HTMLElement): MountedSidePanel {
      calls.mount++;
      list = document.createElement('div');
      list.className = 'fake-list';
      host.appendChild(list);
      return {
        render: () => { calls.render++; list!.textContent = state.value; },
        activate: () => { calls.activate++; },
        deactivate: () => { calls.deactivate++; },
        onRunComplete: over.id === 'history-like' ? () => { list!.textContent = state.value; } : undefined,
        dispose: () => { calls.dispose++; },
      };
    },
  } as SidePanelDef;
  Object.defineProperty(def, 'calls', { value: calls, enumerable: true });
  Object.defineProperty(def, 'data', {
    enumerable: true,
    get: () => state.value,
    set: (v: string) => { state.value = v; },
  });
  return def as SidePanelDef & { calls: typeof calls; data: string };
}

const upperDef = (id: SidePanelId, over: Partial<SidePanelDef> = {}) => fakeDef({ id, pane: 'upper', ...over });
const lowerDef = (id: SidePanelId, over: Partial<SidePanelDef> = {}) => fakeDef({ id, pane: 'lower', ...over });

describe('buildSidePanelRegistry — construction', () => {
  it('mounts every def exactly once, in manifest order, before any activation', () => {
    const a = upperDef('databases' as SidePanelId);
    const b = upperDef('dashboards' as SidePanelId);
    buildSidePanelRegistry([a, b]);
    expect(a.calls.mount).toBe(1);
    expect(b.calls.mount).toBe(1);
    expect(a.calls.render).toBe(0);
    expect(a.calls.activate).toBe(0);
  });

  it('defaults each pane\'s active id to the FIRST entry declared for that pane', () => {
    const reg = buildSidePanelRegistry([
      upperDef('databases' as SidePanelId), upperDef('dashboards' as SidePanelId),
      lowerDef('library' as SidePanelId), lowerDef('history' as SidePanelId),
    ]);
    expect(reg.activeId('upper')).toBe('databases');
    expect(reg.activeId('lower')).toBe('library');
  });

  it('builds a generic host for a def that supplies none, keyed by data-panel', () => {
    const def = lowerDef('library' as SidePanelId);
    const reg = buildSidePanelRegistry([def]);
    const host = reg.entry('library' as SidePanelId).host;
    expect(host.className).toBe('side-panel-host');
    expect(host.getAttribute('data-panel')).toBe('library');
  });

  it('uses a caller-supplied host verbatim instead of building a generic one', () => {
    const customHost = document.createElement('div');
    customHost.className = 'upper-role-host';
    const def = upperDef('databases' as SidePanelId, { host: customHost });
    const reg = buildSidePanelRegistry([def]);
    expect(reg.entry('databases' as SidePanelId).host).toBe(customHost);
  });

  it('throws a clear error for an unknown id rather than returning undefined', () => {
    const reg = buildSidePanelRegistry([lowerDef('library' as SidePanelId)]);
    expect(() => reg.entry('nope' as SidePanelId)).toThrow(/unknown panel id/);
  });
});

// #587 AC5's RUNTIME proof (one of three ways, per R2.10): a definition never
// declared anywhere in production code flows through the exact same generic
// constructor/renderer path as the real four, with no branch anywhere keyed
// on a specific id.
describe('buildSidePanelRegistry — AC5 runtime proof: an injected fake panel', () => {
  it('a fake def not present in SIDE_PANELS is registered, mounted, and shown like any other', () => {
    const fake = lowerDef('totally-invented' as SidePanelId, { label: 'Invented', accessibleLabel: 'Open Invented' });
    const real = lowerDef('library' as SidePanelId);
    const reg = buildSidePanelRegistry([real, fake]);
    expect(reg.entries.map((e) => e.id)).toEqual(['library', 'totally-invented']);
    expect(fake.calls.mount).toBe(1);

    reg.showPanel('totally-invented' as SidePanelId);
    expect(fake.calls.activate).toBe(1);
    expect(fake.calls.render).toBe(1);
    expect(reg.activeId('lower')).toBe('totally-invented');

    const row = document.createElement('div');
    renderSidePanelTabs(row, reg.entries, reg.activeId('lower'), () => {});
    expect(row.textContent).toContain('Invented');
  });
});

describe('showPanel — pane-scoped exposure', () => {
  it('exposes exactly one panel per pane, leaving the OTHER pane untouched', () => {
    const databases = upperDef('databases' as SidePanelId);
    const dashboards = upperDef('dashboards' as SidePanelId);
    const library = lowerDef('library' as SidePanelId);
    const history = lowerDef('history' as SidePanelId);
    const reg = buildSidePanelRegistry([databases, dashboards, library, history]);

    reg.showPanel('dashboards' as SidePanelId);
    expect(reg.entry('databases' as SidePanelId).host.hidden).toBe(true);
    expect(reg.entry('dashboards' as SidePanelId).host.hidden).toBe(false);
    // The lower pane's own active panel is untouched by an upper-pane switch.
    expect(reg.entry('library' as SidePanelId).host.hidden).toBe(false);
    expect(reg.entry('history' as SidePanelId).host.hidden).toBe(true);
    expect(library.calls.deactivate).toBe(0);
  });

  it('a hidden host keeps its DOM (no rebuild) — mount is never called a second time', () => {
    const library = lowerDef('library' as SidePanelId);
    const history = lowerDef('history' as SidePanelId);
    const reg = buildSidePanelRegistry([library, history]);
    reg.showPanel('history' as SidePanelId);
    reg.showPanel('library' as SidePanelId);
    reg.showPanel('history' as SidePanelId);
    expect(library.calls.mount).toBe(1);
    expect(history.calls.mount).toBe(1);
  });

  it('calls deactivate on the panel being hidden, activate+render on the one being shown', () => {
    const library = lowerDef('library' as SidePanelId);
    const history = lowerDef('history' as SidePanelId);
    const reg = buildSidePanelRegistry([library, history]);
    reg.showPanel('history' as SidePanelId);
    expect(library.calls.deactivate).toBe(1);
    expect(history.calls.activate).toBe(1);
    expect(history.calls.render).toBe(1);
  });

  it('re-activating the already-active panel still re-renders it (no transition, but a fresh render)', () => {
    const library = lowerDef('library' as SidePanelId);
    const reg = buildSidePanelRegistry([library]);
    reg.showPanel('library' as SidePanelId);
    reg.showPanel('library' as SidePanelId);
    expect(library.calls.activate).toBe(0); // never transitioned — it was already visible
    expect(library.calls.render).toBe(2); // once at construction-time default read? no: only on showPanel calls
  });
});

// #587 review finding 1: `showPanel` must run every non-target sibling's
// `deactivate` BEFORE the target's `activate`/`render` — regardless of
// whether the target is registered before or after its sibling. A test that
// only counts calls (as `showPanel — pane-scoped exposure` above does) can't
// tell a correctly-ordered single showPanel from an incorrectly-ordered one;
// this records the actual call SEQUENCE and asserts its order.
describe('showPanel — deactivate-before-activate ordering', () => {
  it('deactivates every pane sibling before activating/rendering the target, even when the target is registered FIRST', () => {
    const sequence: string[] = [];
    const orderedDef = (id: SidePanelId): SidePanelDef => ({
      id, pane: 'lower', label: id, icon: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
      accessibleLabel: `Open ${id}`,
      mount: (): MountedSidePanel => ({
        render: () => { sequence.push(`${id}:render`); },
        activate: () => { sequence.push(`${id}:activate`); },
        deactivate: () => { sequence.push(`${id}:deactivate`); },
        dispose: () => {},
      }),
    });
    // `a` is FIRST in the manifest — mirrors the real bug's registration
    // order (library-then-history) where the eventual TARGET of a switch is
    // visited first by a naive single pass over `entries`.
    const a = orderedDef('a' as SidePanelId);
    const b = orderedDef('b' as SidePanelId);
    const reg = buildSidePanelRegistry([a, b]);

    reg.showPanel('b' as SidePanelId); // make `b` the active one, `a` hidden
    sequence.length = 0; // discard this setup transition's own sequence

    reg.showPanel('a' as SidePanelId); // switch back to `a` — the FIRST-registered entry
    // `b`'s deactivate must be fully done before `a` activates/renders — a
    // single pass in manifest order would activate/render `a` FIRST (it is
    // visited first), then deactivate `b` afterward, reversing this order.
    expect(sequence).toEqual(['b:deactivate', 'a:activate', 'a:render']);
  });
});

// #587 R2.4/R2.6 — the persistent-host trap: a HIDDEN host must never show
// stale DOM once activated again, but activity while genuinely hidden must
// not force an unnecessary rebuild either.
describe('activation freshness (#587 R2.6)', () => {
  it('data changed while a panel was hidden is reflected the moment it is activated', () => {
    const library = lowerDef('library' as SidePanelId);
    const history = lowerDef('history' as SidePanelId);
    const reg = buildSidePanelRegistry([library, history]);
    reg.showPanel('history' as SidePanelId); // library now hidden
    library.data = 'a fresh library mutation';
    expect(reg.entry('library' as SidePanelId).host.querySelector('.fake-list')!.textContent)
      .not.toBe('a fresh library mutation'); // not rebuilt while hidden
    reg.showPanel('library' as SidePanelId);
    expect(reg.entry('library' as SidePanelId).host.querySelector('.fake-list')!.textContent)
      .toBe('a fresh library mutation');
  });

  it('mutating the ACTIVE panel and re-showing the one that was already active still reflects it', () => {
    const library = lowerDef('library' as SidePanelId);
    const reg = buildSidePanelRegistry([library]);
    library.data = 'mutated while active';
    reg.showPanel('library' as SidePanelId);
    expect(reg.entry('library' as SidePanelId).host.querySelector('.fake-list')!.textContent)
      .toBe('mutated while active');
  });
});

describe('refreshActiveSidePanels / notifyRunComplete', () => {
  it('refreshActiveSidePanels renders ONLY the active lower panel, never the upper pane', () => {
    const databases = upperDef('databases' as SidePanelId);
    const library = lowerDef('library' as SidePanelId);
    const history = lowerDef('history' as SidePanelId);
    const reg = buildSidePanelRegistry([databases, library, history]);
    reg.refreshActiveSidePanels();
    expect(library.calls.render).toBe(1);
    expect(history.calls.render).toBe(0);
    expect(databases.calls.render).toBe(0);
  });

  it('notifyRunComplete dispatches onRunComplete only to the active lower panel, and only if it defines one', () => {
    const library = lowerDef('library' as SidePanelId); // no onRunComplete
    const history = lowerDef('history-like' as SidePanelId); // defines onRunComplete per fakeDef
    const reg = buildSidePanelRegistry([library, history]);
    reg.showPanel('library' as SidePanelId);
    expect(() => reg.notifyRunComplete()).not.toThrow(); // library has none — silent no-op
    expect(library.calls.render).toBe(1); // only from the explicit showPanel above

    reg.showPanel('history-like' as SidePanelId);
    history.data = 'a fresh run just completed';
    reg.notifyRunComplete();
    // history-like's onRunComplete (per fakeDef) repaints its list directly.
    expect(reg.entry('history-like' as SidePanelId).host.querySelector('.fake-list')!.textContent)
      .toBe('a fresh run just completed');
    // Dispatch never reached the now-inactive library panel.
    expect(library.calls.render).toBe(1);
  });

  it('notifyRunComplete never touches the inactive lower panel even if it defines onRunComplete', () => {
    const historyLike = lowerDef('history-like' as SidePanelId);
    const other = lowerDef('library' as SidePanelId);
    const reg = buildSidePanelRegistry([other, historyLike]);
    reg.showPanel('library' as SidePanelId); // history-like is now inactive
    const list = reg.entry('history-like' as SidePanelId).host.querySelector('.fake-list')!;
    const before = list.textContent;
    reg.notifyRunComplete();
    expect(list.textContent).toBe(before);
  });
});

describe('dispose', () => {
  it('disposes every entry exactly once', () => {
    const a = lowerDef('library' as SidePanelId);
    const b = lowerDef('history' as SidePanelId);
    const reg = buildSidePanelRegistry([a, b]);
    reg.dispose();
    expect(a.calls.dispose).toBe(1);
    expect(b.calls.dispose).toBe(1);
  });
});

describe('renderSidePanelTabs — generic tab row', () => {
  it('renders one button per entry, in order, with label/icon structure, and no aria-label', () => {
    const a = lowerDef('library' as SidePanelId, { label: 'Library', accessibleLabel: 'Open Library navigation' });
    const b = lowerDef('history' as SidePanelId, { label: 'History', accessibleLabel: 'Open query History' });
    const reg = buildSidePanelRegistry([a, b]);
    const row = document.createElement('div');
    renderSidePanelTabs(row, reg.entries, reg.activeId('lower'), () => {});
    const buttons = [...row.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    expect(buttons.map((btn) => btn.textContent)).toEqual(['Library', 'History']);
    expect(buttons[0].classList.contains('active')).toBe(true);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].classList.contains('active')).toBe(false);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');
    // #600 review finding 2 (round 2): a tab button's accessible name must
    // stay content-derived (visible label + any live count) — an explicit
    // `aria-label` here would REPLACE that with `accessibleLabel` alone,
    // silently deleting the count from what a screen reader announces (see
    // the regression test below). `accessibleLabel` is still asserted at
    // the registry-meta level further down — it is a real part of the
    // contract, just never emitted on this DOM.
    expect(buttons[0].hasAttribute('aria-label')).toBe(false);
    expect(buttons[1].hasAttribute('aria-label')).toBe(false);
  });

  // #600 review finding 2 (round 2): this is the guard against a future
  // `renderSidePanelTabs` change re-adding `'aria-label': entry.accessibleLabel`
  // (or any other override that would replace the content-derived accessible
  // name) — it directly asserts the two conditions that together prove the
  // count is still announced: no `aria-label` override, and the button's own
  // text content includes the adornment.
  it('a counted tab exposes no aria-label, and its text content includes the live count', () => {
    const withCount = lowerDef('library' as SidePanelId, {
      label: 'Library',
      accessibleLabel: 'Open Library navigation',
      tabAdornment: () => { const s = document.createElement('span'); s.className = 'side-count'; s.textContent = '· 3'; return s; },
    });
    const reg = buildSidePanelRegistry([withCount]);
    const row = document.createElement('div');
    renderSidePanelTabs(row, reg.entries, reg.activeId('lower'), () => {});
    const button = row.querySelector('button')!;
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(button.textContent).toBe('Library· 3');
  });

  it('mints a fresh icon node per render — the icon is a factory, never a shared element', () => {
    let calls = 0;
    const icon = () => { calls++; return document.createElementNS('http://www.w3.org/2000/svg', 'svg'); };
    const a = lowerDef('library' as SidePanelId, { icon });
    const reg = buildSidePanelRegistry([a]);
    const row = document.createElement('div');
    renderSidePanelTabs(row, reg.entries, reg.activeId('lower'), () => {});
    renderSidePanelTabs(row, reg.entries, reg.activeId('lower'), () => {});
    expect(calls).toBe(2);
  });

  it('renders a tabAdornment when the entry supplies one, and nothing when it does not', () => {
    const withCount = lowerDef('library' as SidePanelId, {
      tabAdornment: () => { const s = document.createElement('span'); s.className = 'side-count'; s.textContent = '· 3'; return s; },
    });
    const withoutCount = lowerDef('history' as SidePanelId);
    const reg = buildSidePanelRegistry([withCount, withoutCount]);
    const row = document.createElement('div');
    renderSidePanelTabs(row, reg.entries, reg.activeId('lower'), () => {});
    const buttons = [...row.querySelectorAll('button')];
    expect(buttons[0].querySelector('.side-count')?.textContent).toBe('· 3');
    expect(buttons[1].querySelector('.side-count')).toBeNull();
  });

  it('clicking a tab invokes onSelect with that entry\'s id, and nothing else', () => {
    const a = lowerDef('library' as SidePanelId);
    const b = lowerDef('history' as SidePanelId);
    const reg = buildSidePanelRegistry([a, b]);
    const row = document.createElement('div');
    const onSelect = vi.fn();
    renderSidePanelTabs(row, reg.entries, reg.activeId('lower'), onSelect);
    (row.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('history');
  });
});

// #600 review finding 1: this is now the ONE place the four real panel defs
// are wired — `app-shell.ts` calls it directly and names no concrete panel
// itself. Proves the factory produces exactly the real four, over the
// caller-supplied upper hosts, through the same generic core every other
// caller (including the fake-panel AC5 proof above) goes through.
describe('buildProductionSidePanelRegistry — the production wiring app-shell.ts calls', () => {
  it('wires the four real panels (Databases/Dashboards/Library/History), in manifest order, over the given upper hosts', () => {
    const app = makeApp();
    const databasesHost = document.createElement('div');
    const dashboardsHost = document.createElement('div');
    const reg = buildProductionSidePanelRegistry(app, { databasesHost, dashboardsHost });
    expect(reg.entries.map((entry) => entry.id)).toEqual(['databases', 'dashboards', 'library', 'history']);
    expect(reg.entry('databases' as SidePanelId).host).toBe(databasesHost);
    expect(reg.entry('dashboards' as SidePanelId).host).toBe(dashboardsHost);
    // Library/History get fresh generic hosts, not the caller-supplied upper ones.
    expect(reg.entry('library' as SidePanelId).host).not.toBe(databasesHost);
    expect(reg.entry('history' as SidePanelId).host).not.toBe(dashboardsHost);
  });

  // #600 review finding 2 (round 2): `accessibleLabel` is real contract
  // surface (#587 AC6) even though `renderSidePanelTabs` never emits it on
  // the DOM (it would delete the live count from the accessible name — see
  // that renderer's own comment) — its real consumer is a future icon-only
  // presentation. Pinned here, at the REGISTRY level, against the exact four
  // strings the production panels declare.
  it('exposes the exact accessibleLabel contract string for each of the four real panels', () => {
    const app = makeApp();
    const reg = buildProductionSidePanelRegistry(app, {
      databasesHost: document.createElement('div'),
      dashboardsHost: document.createElement('div'),
    });
    expect(reg.entry('databases' as SidePanelId).accessibleLabel).toBe('Open Databases navigation');
    expect(reg.entry('dashboards' as SidePanelId).accessibleLabel).toBe('Open Dashboards navigation');
    expect(reg.entry('library' as SidePanelId).accessibleLabel).toBe('Open Library navigation');
    expect(reg.entry('history' as SidePanelId).accessibleLabel).toBe('Open query History');
  });

  // PR #600 review (round 3), finding 1: the exhaustive `Record<SidePanelId, …>`
  // in `side-panel-registry.ts` proves every manifest id HAS a production
  // factory (a compile error otherwise), but not that each factory's def
  // AGREES with its own manifest row — a def could still report the wrong
  // `pane` (defs are independent objects, not derived from the row they were
  // built from). This is the check that would catch that: the registry's
  // full `{id, pane}` sequence, in order, must equal the manifest's own
  // sequence exactly (`toEqual` on arrays fails on any length or ordering
  // difference, not just missing ids).
  //
  // What this does NOT prove (PR #600 review, round 4 — the earlier wording
  // here claimed "no duplicates", which was wrong): a DUPLICATE manifest id
  // appears on both sides of this comparison, so the sequences still match and
  // this test stays green. Manifest id/persistedKey uniqueness is asserted
  // directly in `side-panels.test.ts`, and `buildSidePanelRegistry` now throws
  // on a duplicate def id — see the test immediately below.
  it('the built registry\'s {id, pane} sequence matches SIDE_PANELS exactly, in manifest order', () => {
    const app = makeApp();
    const reg = buildProductionSidePanelRegistry(app, {
      databasesHost: document.createElement('div'),
      dashboardsHost: document.createElement('div'),
    });
    expect(reg.entries.map((entry) => ({ id: entry.id, pane: entry.pane })))
      .toEqual(SIDE_PANELS.map((spec) => ({ id: spec.id, pane: spec.pane })));
  });

  // The uniqueness invariant no type or parity check can express (PR #600
  // review, round 4). Constructing rather than tolerating is deliberate: a
  // duplicate id silently double-renders a pane forever (`byId` keeps the last
  // entry, both hosts start visible, and `showPanel` skips every candidate
  // whose id equals its target, so it can never hide the shadowed one).
  it('throws on a duplicate panel id rather than silently shadowing one entry', () => {
    expect(() => buildSidePanelRegistry([
      fakeDef({ id: 'library', pane: 'lower' }),
      fakeDef({ id: 'library', pane: 'lower' }),
    ])).toThrow(/duplicate panel id "library"/);
  });

  it('accepts two panels that differ only by pane — uniqueness is per id, not per pane', () => {
    const reg = buildSidePanelRegistry([
      fakeDef({ id: 'databases', pane: 'upper' }),
      fakeDef({ id: 'library', pane: 'lower' }),
    ]);
    expect(reg.entries.map((entry) => entry.id)).toEqual(['databases', 'library']);
  });
});

describe('MOBILE_PANES — a separate small table, decoupled from the panel manifest', () => {
  it('names exactly the two panes the mobile segmented control switches between', () => {
    expect(MOBILE_PANES).toEqual([
      { pane: 'upper', seg: 'schema', label: 'Explore' },
      { pane: 'lower', seg: 'library', label: 'Library' },
    ]);
  });
});
