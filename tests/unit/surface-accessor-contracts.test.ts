// #590 decisions 14/16 — compile-time claims get compile-time fixtures.
// Plain `tsc --noEmit` cannot detect a forbidden assignment becoming legal
// again when no such assignment exists anywhere in the tree, so every "fails
// to compile" claim this issue's plan makes is backed by an ACTUAL attempted
// write, guarded by `@ts-expect-error` (uncalled-function pattern —
// `tests/unit/app-preferences.test.ts:48-81` precedent) — the directive
// itself becomes a compile error under `check:types` if the guarded write
// ever turns legal again (widening a `ReadonlySignal` back to `Signal`,
// re-adding `null` to the `currentWorkspace` setter, or stripping `readonly`
// from any one of the four structural ports).
//
// Every fixture imports the REAL production type from its defining module —
// never a re-created local equivalent, which would keep passing after the
// production type regressed. `SurfaceStatePort`/`DashboardApp`/`TabsApp`/
// `DashboardTreeApp` are four INDEPENDENTLY declared structural interfaces
// (none extends another), so a single port's fixture cannot prove another
// port's `readonly` — decision 16's own finding, and the reason there are
// four port fixtures here, not one shared one (`DashboardTreeApp` is the
// plan's own grep-miss — see its own doc comment in dashboard-tree.ts).

import { describe, it } from 'vitest';
import type { App } from '../../src/ui/app.types.js';
import type { SurfaceStatePort } from '../../src/application/surface-navigation.js';
import type { DashboardApp } from '../../src/ui/dashboard.js';
import type { TabsApp } from '../../src/ui/tabs.js';
import type { DashboardTreeApp } from '../../src/ui/dashboard-tree.js';
import type { StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

describe('#590 invariants (a)/(k) — compile-time-only fixtures (never executed)', () => {
  it('app.committedWorkspace.value is not writable through the public App type', () => {
    const neverCalled = (app: App): void => {
      // @ts-expect-error — `committedWorkspace` is a `ReadonlySignal`; a public
      // mutable `Signal` would let any caller bypass the `currentWorkspace`
      // setter (`app.committedWorkspace.value = x`), foreclosing the setter
      // ever growing more logic (#590 §1.1/decision 2).
      app.committedWorkspace.value = null;
    };
    void neverCalled;
  });

  it('app.treeNavigation.value is not writable through the public App type', () => {
    const neverCalled = (app: App): void => {
      // @ts-expect-error — `treeNavigation` is a `ReadonlySignal<string>`; the
      // tree effect's ONE tracked read must not also be a public write path
      // (#590 §1.4a/decision 5).
      app.treeNavigation.value = 'k';
    };
    void neverCalled;
  });

  it('app.currentWorkspace = null does not compile through the public App type', () => {
    const neverCalled = (app: App): void => {
      // @ts-expect-error — the setter's write type excludes `null` (#590
      // §1.2, decision 14): a transitional null publication is a named
      // departure operation owned by app.ts's surface-retirement
      // coordinator, not part of the general writable port.
      app.currentWorkspace = null;
    };
    void neverCalled;
  });

  it('a non-null StoredWorkspaceV5 still assigns through the public setter (the setter is not sealed shut)', () => {
    const neverCalled = (app: App, workspace: StoredWorkspaceV5): void => {
      app.currentWorkspace = workspace; // must compile — no @ts-expect-error
    };
    void neverCalled;
  });
});

describe('#590 decision 16 — the four narrowed structural ports each carry their OWN fixture', () => {
  it('SurfaceStatePort.currentWorkspace is readonly', () => {
    const neverCalled = (port: SurfaceStatePort): void => {
      // @ts-expect-error transitional null publication is lifecycle-owned —
      // this module's own writes to `currentWorkspace`/`workspaceRouteStatus`
      // are gone (routed through the app-side retirement coordinator's named
      // ops), so the port keeps only the capabilities nav still uses.
      port.currentWorkspace = null;
    };
    void neverCalled;
  });

  it('SurfaceStatePort.workspaceRouteStatus is readonly', () => {
    const neverCalled = (port: SurfaceStatePort): void => {
      // @ts-expect-error same reasoning as currentWorkspace above.
      port.workspaceRouteStatus = 'ready';
    };
    void neverCalled;
  });

  it('DashboardApp.currentWorkspace is readonly', () => {
    const neverCalled = (app: DashboardApp): void => {
      // @ts-expect-error transitional null publication is lifecycle-owned —
      // zero writes exist through this port (grep-verified).
      app.currentWorkspace = null;
    };
    void neverCalled;
  });

  it('TabsApp.currentWorkspace is readonly', () => {
    const neverCalled = (app: TabsApp): void => {
      // @ts-expect-error transitional null publication is lifecycle-owned —
      // zero writes exist through this port (grep-verified).
      app.currentWorkspace = null;
    };
    void neverCalled;
  });

  it('DashboardTreeApp.currentWorkspace is readonly (the plan\'s own grep miss, closed here)', () => {
    const neverCalled = (app: DashboardTreeApp): void => {
      // @ts-expect-error transitional null publication is lifecycle-owned —
      // documented "Read-only" in prose before #590 but not TYPE readonly; a
      // fourth structural re-declaration decision 16's own grep missed.
      app.currentWorkspace = null;
    };
    void neverCalled;
  });
});
