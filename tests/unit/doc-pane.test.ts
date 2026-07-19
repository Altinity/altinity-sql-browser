import { describe, it, expect, vi } from 'vitest';
import { openDocEntry, closeDocPane } from '../../src/ui/doc-pane.js';
import type { DocPaneApp } from '../../src/ui/doc-pane.js';
import type { DocEntry, DocLookup, DocTarget } from '../../src/core/doc-types.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function fakeViewer() {
  return { setText: vi.fn(), setLanguage: vi.fn(), setWrap: vi.fn(), focus: vi.fn(), destroy: vi.fn() };
}

function makeApp(over: Partial<DocPaneApp> = {}): DocPaneApp & { catalog: { docEntry: ReturnType<typeof vi.fn> } } {
  const docEntry = vi.fn();
  return {
    document,
    state: { docPanePx: 420 },
    prefs: { save: vi.fn() },
    catalog: { docEntry, refData: { keywords: [], functions: {} } as never },
    CodeViewer: vi.fn(() => fakeViewer()),
    ...over,
  } as DocPaneApp & { catalog: { docEntry: ReturnType<typeof vi.fn> } };
}

const T_FN: DocTarget = { kind: 'function', name: 'toDateTime' };

function entry(over: Partial<DocEntry> = {}): DocEntry {
  return {
    target: T_FN,
    title: 'toDateTime',
    signature: 'toDateTime(expr[, timezone])',
    summary: 'Converts a value to DateTime.',
    categories: ['Type conversion'],
    ...over,
  };
}

describe('doc-pane lifecycle', () => {
  it('open creates the pane, complementary role + accessible name, no backdrop', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: entry() });
    openDocEntry(app, T_FN);
    const panel = document.querySelector('.docs-panel')!;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('role')).toBe('complementary');
    expect(panel.getAttribute('aria-label')).toBeTruthy();
    expect(document.querySelector('.cd-backdrop')).toBeNull();
    await Promise.resolve(); await Promise.resolve();
    closeDocPane(app);
  });

  it('a second openDocEntry call reuses the SAME pane instance (no second panel)', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: entry() });
    openDocEntry(app, T_FN);
    const first = document.querySelector('.docs-panel');
    openDocEntry(app, { kind: 'function', name: 'now' });
    expect(document.querySelectorAll('.docs-panel')).toHaveLength(1);
    expect(document.querySelector('.docs-panel')).toBe(first);
    await Promise.resolve(); await Promise.resolve();
    closeDocPane(app);
  });

  it('close removes the panel; closeDocPane is a no-op when nothing is open', () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'missing' });
    openDocEntry(app, T_FN);
    expect(document.querySelector('.docs-panel')).not.toBeNull();
    closeDocPane(app);
    expect(document.querySelector('.docs-panel')).toBeNull();
    expect(() => closeDocPane(app)).not.toThrow();
  });

  it('the close (✕) button closes the pane', () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'missing' });
    openDocEntry(app, T_FN);
    const closeBtn = document.querySelector<HTMLButtonElement>('.docs-close')!;
    closeBtn.click();
    expect(document.querySelector('.docs-panel')).toBeNull();
  });
});

describe('states', () => {
  it('loading renders immediately, before the lookup settles', () => {
    const app = makeApp();
    const { promise } = deferred<DocLookup<DocEntry>>();
    app.catalog.docEntry.mockReturnValue(promise);
    openDocEntry(app, T_FN);
    expect(document.querySelector('.docs-loading')).not.toBeNull();
    closeDocPane(app);
  });

  it('found renders title, kind badge, signature, since badge, categories', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found',
      value: entry({ introducedIn: '23.1' }),
    });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-name')!.textContent).toBe('toDateTime');
    expect(document.querySelector('.docs-badge-kind')!.textContent).toBe('function');
    expect(document.querySelector('.docs-signature')!.textContent).toBe('toDateTime(expr[, timezone])');
    expect(document.querySelector('.docs-badge-since')!.textContent).toBe('since 23.1');
    expect(document.querySelector('.docs-chip')!.textContent).toBe('Type conversion');
    closeDocPane(app);
  });

  it('aggregate-function kind renders as "aggregate function"', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found',
      value: entry({ target: { kind: 'aggregate-function', name: 'quantile' } }),
    });
    openDocEntry(app, { kind: 'function', name: 'quantile' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-badge-kind')!.textContent).toBe('aggregate function');
    closeDocPane(app);
  });

  it('missing renders "No documentation for <name>"', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'missing' });
    openDocEntry(app, { kind: 'function', name: 'notAFunction' });
    await Promise.resolve(); await Promise.resolve();
    const el = document.querySelector('.docs-missing')!;
    expect(el.textContent).toContain('No documentation for notAFunction');
    closeDocPane(app);
  });

  it('unavailable renders a quiet message (no toast) with a Retry button', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'unavailable' });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    const el = document.querySelector('.docs-unavailable')!;
    expect(el.textContent).toMatch(/isn't available/);
    expect(document.querySelector('.share-toast.show')).toBeNull();
    expect(document.querySelector('.docs-retry')).not.toBeNull();
    closeDocPane(app);
  });

  it('Retry re-invokes docEntry with the same target', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'unavailable' });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(app.catalog.docEntry).toHaveBeenCalledTimes(1);
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: entry() });
    document.querySelector<HTMLButtonElement>('.docs-retry')!.click();
    expect(app.catalog.docEntry).toHaveBeenCalledTimes(2);
    expect(app.catalog.docEntry).toHaveBeenLastCalledWith(T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-name')).not.toBeNull();
    closeDocPane(app);
  });

  it('deterministic/higher-order badges show only when strictly boolean', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: entry({ deterministic: true, higherOrder: false }),
    });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-badge-on')!.textContent).toBe('Deterministic: yes');
    expect(document.querySelector('.docs-badge-off')!.textContent).toBe('Higher-order: no');
    closeDocPane(app);
  });

  it('omits deterministic/higher-order badges entirely when null/undefined', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: entry({ deterministic: null, higherOrder: undefined }),
    });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-badge-on')).toBeNull();
    expect(document.querySelector('.docs-badge-off')).toBeNull();
    closeDocPane(app);
  });

  it('omits the categories row entirely when categories is empty', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: entry({ categories: [] }) });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-categories')).toBeNull();
    closeDocPane(app);
  });

  it('renders arguments/parameters/returned value only when present', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found',
      value: entry({ arguments: 'expr — a value', returnedValue: 'DateTime' }),
    });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    const labels = [...document.querySelectorAll('.docs-field-label')].map((e) => e.textContent);
    expect(labels).toContain('Arguments');
    expect(labels).toContain('Returned value');
    expect(labels).not.toContain('Parameters');
    closeDocPane(app);
  });
});

describe('alias navigation + cycle guard', () => {
  it('clicking "Alias of X" navigates to the canonical target', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found',
      value: entry({ target: { kind: 'function', name: 'toUnixTimestamp' }, title: 'toUnixTimestamp', aliasTo: 'toDateTime' }),
    });
    openDocEntry(app, { kind: 'function', name: 'toUnixTimestamp' });
    await Promise.resolve(); await Promise.resolve();
    const link = document.querySelector<HTMLButtonElement>('.docs-alias-link')!;
    expect(link.textContent).toBe('toDateTime');
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: entry() });
    link.click();
    expect(app.catalog.docEntry).toHaveBeenLastCalledWith({ kind: 'function', name: 'toDateTime' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-name')!.textContent).toBe('toDateTime');
    closeDocPane(app);
  });

  it('stops after the first repeat: an alias chain that cycles back renders plain text, not a clickable link', async () => {
    const app = makeApp();
    // a -> aliasTo b
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found',
      value: entry({ target: { kind: 'function', name: 'a' }, title: 'a', aliasTo: 'b' }),
    });
    openDocEntry(app, { kind: 'function', name: 'a' });
    await Promise.resolve(); await Promise.resolve();
    // b -> aliasTo a (cycle back to the already-visited 'a')
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found',
      value: entry({ target: { kind: 'function', name: 'b' }, title: 'b', aliasTo: 'a' }),
    });
    document.querySelector<HTMLButtonElement>('.docs-alias-link')!.click();
    await Promise.resolve(); await Promise.resolve();
    // b's render shows "Alias of a" as plain text (cycle detected) — no button.
    expect(document.querySelector('.docs-alias-link')).toBeNull();
    expect(document.querySelector('.docs-alias')!.textContent).toBe('Alias of a');
    closeDocPane(app);
  });
});

describe('examples: CodeViewer + Copy', () => {
  it('mounts the injected CodeViewer with the exact example text and a ClickHouse language extension', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: entry({ examples: "SELECT toDateTime('2024-01-01')" }),
    });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(app.CodeViewer).toHaveBeenCalledWith(expect.objectContaining({
      text: "SELECT toDateTime('2024-01-01')", language: 'sql',
    }));
    const call = (app.CodeViewer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.languageExtension).toBeDefined();
    closeDocPane(app);
  });

  it('omits the examples section entirely when absent', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: entry() });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(app.CodeViewer).not.toHaveBeenCalled();
    expect(document.querySelector('.docs-examples')).toBeNull();
    closeDocPane(app);
  });

  it('Copy shows "Copy not supported" when no clipboard seam is available', async () => {
    const app = makeApp({ navigator: undefined });
    const original = (globalThis as { navigator?: unknown }).navigator;
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: entry({ examples: 'SELECT 1' }) });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    document.querySelector<HTMLButtonElement>('.docs-copy')!.click();
    expect(document.querySelector('.share-toast')!.textContent).toBe('Copy not supported');
    closeDocPane(app);
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
  });

  it('Copy writes the EXACT example text via the clipboard seam', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({ navigator: { clipboard: { writeText } as unknown as Clipboard } });
    const example = "SELECT toDateTime('2024-01-01')  -- exact\n";
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: entry({ examples: example }) });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    document.querySelector<HTMLButtonElement>('.docs-copy')!.click();
    expect(writeText).toHaveBeenCalledWith(example);
    closeDocPane(app);
  });

  it('destroys the previous CodeViewer instance when the pane is retargeted', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: entry({ examples: 'SELECT 1' }) });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    const firstViewer = (app.CodeViewer as ReturnType<typeof vi.fn>).mock.results[0].value;
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'missing' });
    openDocEntry(app, { kind: 'function', name: 'other' });
    await Promise.resolve(); await Promise.resolve();
    expect(firstViewer.destroy).toHaveBeenCalled();
    closeDocPane(app);
  });
});

describe('stale-response discard', () => {
  it('closing before the lookup resolves discards the result — no render, no throw', async () => {
    const app = makeApp();
    const { promise, resolve } = deferred<DocLookup<DocEntry>>();
    app.catalog.docEntry.mockReturnValue(promise);
    openDocEntry(app, T_FN);
    closeDocPane(app);
    resolve({ status: 'found', value: entry() });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-panel')).toBeNull();
  });

  it('retargeting before the first lookup resolves drops the stale result', async () => {
    const app = makeApp();
    const first = deferred<DocLookup<DocEntry>>();
    const second = deferred<DocLookup<DocEntry>>();
    app.catalog.docEntry.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    openDocEntry(app, T_FN);
    openDocEntry(app, { kind: 'function', name: 'other' });
    second.resolve({ status: 'found', value: entry({ title: 'other' }) });
    await Promise.resolve(); await Promise.resolve();
    first.resolve({ status: 'found', value: entry({ title: 'toDateTime' }) }); // resolves AFTER the retarget
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-name')!.textContent).toBe('other'); // never overwritten by the stale first result
    closeDocPane(app);
  });
});

describe('Escape handling', () => {
  it('Escape while focus is inside the pane closes it, preventing default (so the global shortcut handler is skipped)', () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'missing' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    openDocEntry(app, T_FN);
    const closeBtn = document.querySelector<HTMLButtonElement>('.docs-close')!;
    closeBtn.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    closeBtn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.querySelector('.docs-panel')).toBeNull();
    expect(document.activeElement).toBe(input); // focus restored to the initiator
    input.remove();
  });

  it('Escape while focus is OUTSIDE the pane does not close it', () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'missing' });
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    openDocEntry(app, T_FN);
    outside.focus();
    outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.docs-panel')).not.toBeNull();
    closeDocPane(app);
    outside.remove();
  });

  it('a non-Escape key inside the pane is ignored', () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'missing' });
    openDocEntry(app, T_FN);
    const closeBtn = document.querySelector<HTMLButtonElement>('.docs-close')!;
    closeBtn.focus();
    closeBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(document.querySelector('.docs-panel')).not.toBeNull();
    closeDocPane(app);
  });
});

describe('connection change', () => {
  it('closeDocPane (app.ts\'s signOut hook) clears any open pane', () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'missing' });
    openDocEntry(app, T_FN);
    expect(document.querySelector('.docs-panel')).not.toBeNull();
    closeDocPane(app);
    expect(document.querySelector('.docs-panel')).toBeNull();
  });
});

describe('resize uses docPanePx, not cellDrawerPx', () => {
  it('the initial width comes from state.docPanePx', () => {
    const app = makeApp({ state: { docPanePx: 480 } });
    app.catalog.docEntry.mockResolvedValue({ status: 'missing' });
    openDocEntry(app, T_FN);
    const panel = document.querySelector<HTMLElement>('.docs-panel')!;
    expect(panel.style.width).toBe('480px');
    closeDocPane(app);
  });

  it('dragging the handle persists docPanePx via prefs.save', () => {
    const app = makeApp({ state: { docPanePx: 400 } });
    app.catalog.docEntry.mockResolvedValue({ status: 'missing' });
    openDocEntry(app, T_FN);
    const handle = document.querySelector<HTMLElement>('.docs-panel .cd-resize-h')!;
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.prefs.save).toHaveBeenCalledWith('docPanePx', expect.any(Number));
    closeDocPane(app);
  });
});
