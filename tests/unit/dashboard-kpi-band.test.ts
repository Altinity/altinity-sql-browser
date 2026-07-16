import { describe, expect, it } from 'vitest';
import {
  applyKpiSourceResult, buildKpiBand, buildKpiSourceSlot, refreshBandWarnings,
  setKpiSourceLoading, setKpiSourceUnfilled,
} from '../../src/ui/dashboard-kpi-band.js';
import type { KpiSourceWarning } from '../../src/ui/dashboard-kpi-band.js';
import type { App, ActionsRegistry } from '../../src/ui/app.types.js';
import type { AppState } from '../../src/state.js';
import type { Column } from '../../src/core/panel-cfg.js';
import type { FieldConfig, Panel } from '../../src/generated/json-schema.types.js';

// applyKpiSourceResult reads exactly `app.state.serverVersion` (see
// dashboard-kpi-band.ts) — everything else on the real `App` contract is
// irrelevant to this suite. The stub below fills the rest with inert
// placeholders (never read) so the fixture structurally satisfies `App`
// without an `unknown` bridge; `{} as T` is a valid single-step cast for
// every all-optional or method-only sub-shape here since `T` is always
// assignable to `{}`.
const testApp = (serverVersion?: string): App => ({
  state: { serverVersion } as AppState,
  dom: {},
  root: null,
  document,
  token: null,
  refreshToken: null,
  sqlEditor: {} as App['sqlEditor'],
  specEditor: {} as App['specEditor'],
  CodeViewer: () => ({ setText: () => {}, setLanguage: () => {}, setWrap: () => {}, focus: () => {}, destroy: () => {} }),
  specValidators: { validate: () => [] },
  specCompletionSources: [],
  Chart: undefined,
  cssVar: () => '',
  Dagre: undefined,
  openWindow: () => null,
  stylesText: '',
  faviconHref: '',
  toggleTheme: () => {},
  chart: undefined,
  host: () => '',
  activeTab: () => ({}) as App['activeTab'] extends () => infer T ? T : never,
  isSignedIn: () => true,
  email: () => '',
  chUsername: () => '',
  authMode: 'basic',
  chAuth: 'basic',
  basicUserClaim: 'sub',
  idpId: null,
  hostHint: '',
  basePath: '',
  setTokens: () => {},
  loadConfig: async () => ({}),
  loadIdps: async () => ({ idps: [] }),
  selectIdp: () => {},
  ensureConfig: async () => null,
  ensureFreshToken: async () => true,
  chCtx: {
    fetch, origin: '', authConfirmed: true,
    getToken: async () => null, refresh: async () => false, authHeader: () => '', onSignedOut: () => {},
  },
  showLogin: () => {},
  signOut: () => {},
  receiveAuthHandoff: async () => false,
  canExport: () => false,
  canExportScript: () => false,
  showSaveFilePicker: null,
  showDirectoryPicker: null,
  isSecureContext: true,
  FileReader: globalThis.FileReader,
  saveJSON: () => {},
  saveStr: () => {},
  savePref: () => {},
  saveVarValues: () => {},
  saveFilterActive: () => {},
  saveVarRecent: () => {},
  saveVarRecentDisabled: () => {},
  recordBoundParams: () => {},
  clearVarRecent: () => {},
  clearAllVarRecent: () => {},
  recordHistory: () => {},
  downloadFile: () => {},
  editingLibrary: false,
  loadVersion: async () => {},
  loadSchema: async () => {},
  loadReference: async () => {},
  refData: { functions: {}, keywordDocs: {} },
  completions: {},
  rebuildCompletions: () => {},
  docCache: new Map(),
  entityDoc: async () => null,
  updateBanner: () => {},
  wallNow: () => 0,
  now: () => 0,
  elapsedMs: () => 0,
  tickElapsed: () => {},
  runReadInto: async (result) => result,
  setRunBtn: () => {},
  renderVarStrip: () => {},
  setExportBtn: () => {},
  specBlocked: () => false,
  updateSaveBtn: () => {},
  evaluateSpecDraft: () => ({}),
  revalidateSpecDrafts: () => {},
  revealFirstSpecError: () => {},
  registerSpecValidator: () => () => {},
  activateInvalidSpecDraft: () => {},
  openSavePopover: () => {},
  openUserMenu: () => {},
  renderApp: () => {},
  renderDashboard: () => {},
  openDashboard: () => {},
  actions: {} as ActionsRegistry,
});

const kpiExplicit = (fieldConfig?: FieldConfig): Panel => ({ cfg: { type: 'kpi' }, fieldConfig });
// core/kpi.js's readKpiFields reads a row either positionally
// (`Array.isArray(row) ? row[columnIndex] : row?.[column.name]`) — both are
// real, supported runtime shapes, but core/panel-cfg.ts's `ResultLike.rows`
// (which `KpiSourceResult` inherits from) types rows as `unknown[][]` only,
// with no keyed-object row variant. That's a genuine type-vs-runtime gap in
// an out-of-scope file (panel-cfg.ts/dashboard-kpi-band.ts) — flagged, not
// fixed here. `row` is positional (matching each `columns` fixture's declared
// order) rather than the original keyed object, which the strict type can't
// express; readKpiFields treats the two forms identically, so every
// downstream assertion (KPI items/diagnostics) is unaffected.
const kpiResult = (columns: Column[], row: unknown[]): { columns: Column[]; rows: unknown[][] } => ({ columns, rows: [row] });
const warning = (over: Partial<KpiSourceWarning> & Pick<KpiSourceWarning, 'message' | 'sourceName'>): KpiSourceWarning =>
  ({ severity: 'warning', code: 'w', ...over });

describe('buildKpiBand', () => {
  it('builds an accessible stream and a hidden warning host', () => {
    const band = buildKpiBand();
    expect(band.el.classList.contains('dash-kpi-band')).toBe(true);
    expect(band.stream.classList.contains('dash-kpi-stream')).toBe(true);
    expect(band.stream.getAttribute('role')).toBe('group');
    expect(band.stream.getAttribute('aria-label')).toBe('Key performance indicators');
    expect(band.warningHost.style.display).toBe('none');
    expect(band.sources).toEqual([]);
  });
});

describe('buildKpiSourceSlot', () => {
  it('appends the source host into the band stream in call order and registers it', () => {
    const band = buildKpiBand();
    const a = buildKpiSourceSlot(band, {}, 'Query A');
    const b = buildKpiSourceSlot(band, {}, 'Query B');
    expect(band.stream.children[0]).toBe(a.host);
    expect(band.stream.children[1]).toBe(b.host);
    expect(band.sources).toEqual([a, b]);
    expect(a.kind).toBe('kpi-source');
    expect(a.host.classList.contains('dash-kpi-source')).toBe(true);
  });
});

describe('setKpiSourceLoading', () => {
  it('renders one status card naming the query, with a live progress label', () => {
    const band = buildKpiBand();
    const slot = buildKpiSourceSlot(band, {}, 'Query log health');
    const label = setKpiSourceLoading(slot);
    const card = slot.host.querySelector('.dash-kpi-state-card')!;
    expect(card.getAttribute('role')).toBe('status');
    expect(card.getAttribute('aria-live')).toBe('polite');
    expect(card.getAttribute('aria-label')).toBe('Query log health');
    expect(card.querySelector('.dash-kpi-state-label')!.textContent).toBe('Query log health');
    expect(label.textContent).toBe('Loading…');
    label.textContent = 'Loading… 5 rows';
    expect(card.querySelector('.dash-kpi-state-message')!.textContent).toContain('5 rows');
  });
  it("clears the slot's own warnings but leaves the shared band DOM to the caller's batched refresh", () => {
    // setKpiSourceLoading does NOT call refreshBandWarnings itself (a Refresh
    // wave marks every affected source loading in one synchronous pass — the
    // caller refreshes each touched band exactly once after that pass, not
    // once per source; see dashboard.js's runPlan).
    const band = buildKpiBand();
    const slot = buildKpiSourceSlot(band, {}, 'Query A');
    slot.warnings = [warning({ message: 'stale', sourceName: 'Query A' })];
    refreshBandWarnings(band);
    expect(band.warningHost.style.display).toBe('');
    setKpiSourceLoading(slot);
    expect(slot.warnings).toEqual([]);
    expect(band.warningHost.style.display).toBe(''); // stale until the caller refreshes
    refreshBandWarnings(band);
    expect(band.warningHost.style.display).toBe('none');
  });
});

describe('setKpiSourceUnfilled', () => {
  it('renders a neutral state card naming the missing filter values', () => {
    const band = buildKpiBand();
    const slot = buildKpiSourceSlot(band, {}, 'Query log health');
    setKpiSourceUnfilled(slot, ['from', 'to']);
    const card = slot.host.querySelector('.dash-kpi-state-card')!;
    expect(card.getAttribute('role')).toBe('status');
    expect(card.hasAttribute('aria-live')).toBe(false);
    expect(card.querySelector('.dash-kpi-state-message')!.textContent).toBe('Enter a value for: from, to');
  });
});

describe('applyKpiSourceResult', () => {
  it('renders a transport error as an alert state card', () => {
    const band = buildKpiBand();
    const slot = buildKpiSourceSlot(band, {}, 'Query log health');
    applyKpiSourceResult(testApp(), kpiExplicit(), slot, { error: 'Connection reset' });
    const card = slot.host.querySelector('.dash-kpi-state-card')!;
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.querySelector('.dash-kpi-state-message')!.textContent).toBe('Connection reset');
    expect(slot.status).toBe('error');
  });
  it('renders zero rows as an in-stream no-data state card', () => {
    const band = buildKpiBand();
    const slot = buildKpiSourceSlot(band, {}, 'Query log health');
    applyKpiSourceResult(testApp(), kpiExplicit(), slot, { columns: [], rows: [] });
    const card = slot.host.querySelector('.dash-kpi-state-card')!;
    expect(card.querySelector('.dash-kpi-state-message')!.textContent).toBe('No data');
    expect(slot.status).toBe('error');
  });
  it('renders a multi-row result as an in-stream error state card', () => {
    const band = buildKpiBand();
    const slot = buildKpiSourceSlot(band, {}, 'Query log health');
    applyKpiSourceResult(testApp(), kpiExplicit(), slot, {
      columns: [{ name: 'n', type: 'UInt64' }], rows: [[1], [2]],
    });
    const card = slot.host.querySelector('.dash-kpi-state-card')!;
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.querySelector('.dash-kpi-state-message')!.textContent).toBe('Expected 1 row, got 2');
  });
  it('renders a no-eligible-fields result as an in-stream error state card, keeping every blocking diagnostic (not just one)', () => {
    const band = buildKpiBand();
    const slot = buildKpiSourceSlot(band, {}, 'Query log health');
    applyKpiSourceResult(testApp(), kpiExplicit(), slot, kpiResult([{ name: 'label', type: 'String' }], ['hi']));
    const card = slot.host.querySelector('.dash-kpi-state-card')!;
    expect(card.getAttribute('role')).toBe('alert');
    // readKpiFields also emits a `kpi-unsupported-field` warning for the ineligible
    // column alongside the blocking `kpi-no-eligible-fields` error — both must
    // stay visible (the workbench's renderKpiPanel shows the same full list).
    const lines = [...card.querySelectorAll('.dash-kpi-state-message > div')].map((n) => n.textContent);
    expect(lines).toEqual(['Column label has unsupported KPI type String', 'No eligible KPI fields in this result']);
  });
  it('renders success cards and collects warnings tagged with the source name', () => {
    const band = buildKpiBand();
    const slot = buildKpiSourceSlot(band, {}, 'SELECT health');
    applyKpiSourceResult(testApp(), kpiExplicit(), slot, kpiResult(
      [{ name: 'value', type: 'UInt64' }, { name: 'region', type: 'String' }],
      [591, 'us'],
    ));
    expect(slot.host.querySelectorAll('.kpi-card')).toHaveLength(1);
    expect(slot.status).toBe('panel');
    expect(slot.warnings).toEqual([{
      severity: 'warning', code: 'kpi-unsupported-field',
      message: 'Column region has unsupported KPI type String', columnName: 'region', sourceName: 'SELECT health',
    }]);
    refreshBandWarnings(band);
    const warningEl = band.warningHost.querySelector('.dash-kpi-warning')!;
    expect(warningEl.textContent).toBe('SELECT health: Column region has unsupported KPI type String');
    expect(warningEl.getAttribute('role')).toBe('status');
  });
  it('never removes sibling cards in the same band when one source errors', () => {
    const band = buildKpiBand();
    const good = buildKpiSourceSlot(band, {}, 'Good KPI');
    const bad = buildKpiSourceSlot(band, {}, 'Bad KPI');
    applyKpiSourceResult(testApp(), kpiExplicit(), good, kpiResult([{ name: 'value', type: 'UInt64' }], [7]));
    applyKpiSourceResult(testApp(), kpiExplicit(), bad, { error: 'boom' });
    expect(good.host.querySelectorAll('.kpi-card')).toHaveLength(1);
    expect(bad.host.querySelector('.dash-kpi-state-card')).toBeTruthy();
  });
});

describe('refreshBandWarnings', () => {
  it('orders warnings by source order then diagnostic order, and hides when empty', () => {
    const band = buildKpiBand();
    const a = buildKpiSourceSlot(band, {}, 'A');
    const b = buildKpiSourceSlot(band, {}, 'B');
    a.warnings = [warning({ message: 'first', sourceName: 'A' }), warning({ message: 'second', sourceName: 'A' })];
    b.warnings = [warning({ message: 'third', sourceName: 'B' })];
    refreshBandWarnings(band);
    const texts = [...band.warningHost.querySelectorAll('.dash-kpi-warning')].map((n) => n.textContent);
    expect(texts).toEqual(['A: first', 'A: second', 'B: third']);
    a.warnings = [];
    b.warnings = [];
    refreshBandWarnings(band);
    expect(band.warningHost.style.display).toBe('none');
    expect(band.warningHost.children).toHaveLength(0);
  });
});
