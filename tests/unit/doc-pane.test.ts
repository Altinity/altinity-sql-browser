import { describe, it, expect, vi } from 'vitest';
import { openDocEntry, openDocDisambiguation, closeDocPane, isDocPaneOpen } from '../../src/ui/doc-pane.js';
import type { DocPaneApp } from '../../src/ui/doc-pane.js';
import type { DocEntry, DocLookup, DocSummary, DocTarget } from '../../src/core/doc-types.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function fakeViewer() {
  return { setText: vi.fn(), setLanguage: vi.fn(), setWrap: vi.fn(), focus: vi.fn(), destroy: vi.fn() };
}

function makeApp(over: Partial<DocPaneApp> = {}): DocPaneApp & { catalog: { docEntry: ReturnType<typeof vi.fn>; docDisambiguate: ReturnType<typeof vi.fn> } } {
  const docEntry = vi.fn();
  const docDisambiguate = vi.fn();
  return {
    document,
    state: { docPanePx: 420 },
    prefs: { save: vi.fn() },
    catalog: { docEntry, docDisambiguate, refData: { keywords: [], functions: {} } as never },
    CodeViewer: vi.fn(() => fakeViewer()),
    ...over,
  } as DocPaneApp & { catalog: { docEntry: ReturnType<typeof vi.fn>; docDisambiguate: ReturnType<typeof vi.fn> } };
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
  it('isDocPaneOpen tracks open/close — the global Escape shortcut keys off it (#60)', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: entry() });
    expect(isDocPaneOpen(app)).toBe(false);
    openDocEntry(app, T_FN);
    expect(isDocPaneOpen(app)).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    closeDocPane(app);
    expect(isDocPaneOpen(app)).toBe(false);
  });

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

describe('structured fields render through the markdown-subset renderer', () => {
  it('a description containing a link renders a safe anchor (target=_blank, rel=noopener noreferrer)', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found',
      value: entry({ description: 'See [the guide](https://clickhouse.com/docs/x) for details.' }),
    });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    const link = document.querySelector<HTMLAnchorElement>('.docs-md a')!;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('https://clickhouse.com/docs/x');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toBe('the guide');
    closeDocPane(app);
  });

  it('UPGRADE: a `:::tip ... :::` admonition marker now renders as a real admonition <aside>, not literal marker text (owner decision amending #315 — see core/doc-markdown.ts)', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found',
      value: entry({ description: ':::tip\nUseful hint.\n:::' }),
    });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    const aside = document.querySelector('.docs-md aside.docs-md-admonition-tip')!;
    expect(aside).not.toBeNull();
    expect(aside.textContent).toContain('Useful hint.');
    expect(aside.textContent).not.toContain(':::tip');
    closeDocPane(app);
  });

  it('a ```sql fence inside the description mounts a CodeViewer (no Copy button — owner decision), and it is torn down on retarget', async () => {
    const app = makeApp();
    const description = 'Some prose.\n\n```sql\nSELECT 1\n```\n';
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: entry({ description }) });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(app.CodeViewer).toHaveBeenCalledWith(expect.objectContaining({ text: 'SELECT 1', language: 'sql' }));
    expect(document.querySelector('.docs-md-copy')).toBeNull(); // per-block Copy buttons removed at the #320 gate
    const calls = (app.CodeViewer as ReturnType<typeof vi.fn>).mock;
    const mdViewer = calls.results[calls.calls.length - 1].value;

    app.catalog.docEntry.mockResolvedValueOnce({ status: 'missing' });
    openDocEntry(app, { kind: 'function', name: 'other' });
    await Promise.resolve(); await Promise.resolve();
    expect(mdViewer.destroy).toHaveBeenCalled();
    closeDocPane(app);
  });


  it('arguments/parameters/returned value are also rendered through the markdown body (not a plain text div)', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found',
      value: entry({ arguments: 'See [args](https://clickhouse.com/docs/args).' }),
    });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-field-text')).toBeNull();
    expect(document.querySelectorAll('.docs-md').length).toBeGreaterThan(0);
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

describe('examples: markdown-rendered fences (#60 live finding: examples are a markdown doc)', () => {
  it('a ```sql fence mounts the injected CodeViewer with the exact fence text and a ClickHouse language extension', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: entry({ examples: "**Basic**\n\n```sql\nSELECT toDateTime('2024-01-01')\n```" }),
    });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(app.CodeViewer).toHaveBeenCalledWith(expect.objectContaining({
      text: "SELECT toDateTime('2024-01-01')", language: 'sql',
    }));
    const call = (app.CodeViewer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.languageExtension).toBeDefined();
    // The **Basic** section title renders as real bold, not literal markers.
    expect(document.querySelector('.docs-examples strong')!.textContent).toBe('Basic');
    closeDocPane(app);
  });

  it('a non-sql fence (```response) renders as plain preformatted text, not a CodeViewer', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: entry({ examples: '```response\n1 row in set\n```' }),
    });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(app.CodeViewer).not.toHaveBeenCalled();
    expect(document.querySelector('.docs-examples pre')!.textContent).toContain('1 row in set');
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



  it('destroys the previous CodeViewer instance when the pane is retargeted', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: entry({ examples: '```sql\nSELECT 1\n```' }) });
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

// #314 Phase 2 — the four structured kinds' pane rendering + related/back-
// stack navigation.
const T_ENGINE: DocTarget = { kind: 'table-engine', name: 'MergeTree' };

function structuredEntry(over: Partial<DocEntry> = {}): DocEntry {
  return {
    target: T_ENGINE,
    title: 'MergeTree',
    signature: 'ENGINE = MergeTree() ORDER BY ...',
    summary: 'The base MergeTree engine.',
    categories: [],
    ...over,
  };
}

describe('kind labels for the #314 structured kinds', () => {
  it.each([
    ['format', 'format'],
    ['table-engine', 'table engine'],
    ['database-engine', 'database engine'],
    ['data-type', 'data type'],
  ] as const)('%s renders as "%s"', async (kind, label) => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: structuredEntry({ target: { kind, name: 'X' }, title: 'X' }),
    });
    openDocEntry(app, { kind, name: 'X' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-badge-kind')!.textContent).toBe(label);
    closeDocPane(app);
  });
});

describe('#314 syntaxFull / facts / related rendering', () => {
  it('mounts the CodeViewer for syntaxFull, omitted entirely when absent', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: structuredEntry({ syntaxFull: 'ENGINE = MergeTree()\nORDER BY expr' }),
    });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-syntax')).not.toBeNull();
    expect(app.CodeViewer).toHaveBeenCalledWith(expect.objectContaining({
      text: 'ENGINE = MergeTree()\nORDER BY expr', language: 'sql',
    }));
    closeDocPane(app);
  });

  it('omits the syntax block entirely when syntaxFull is absent (e.g. a format entry)', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: structuredEntry() });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-syntax')).toBeNull();
    closeDocPane(app);
  });

  it('renders facts as label:value chips, omitted entirely when empty', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found',
      value: structuredEntry({ facts: [{ label: 'Replication', value: 'yes' }, { label: 'TTL', value: 'no' }] }),
    });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    const chips = [...document.querySelectorAll('.docs-fact')].map((e) => e.textContent);
    expect(chips).toEqual(['Replication: yes', 'TTL: no']);
    closeDocPane(app);
  });

  it('omits the facts row entirely when facts is empty/absent', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: structuredEntry({ facts: [] }) });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-facts')).toBeNull();
    closeDocPane(app);
  });

  it('a related item WITH a target renders as a button that navigates the pane in place', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found',
      value: structuredEntry({ related: [{ label: 'ReplacingMergeTree', target: { kind: 'table-engine', name: 'ReplacingMergeTree' } }] }),
    });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    const link = document.querySelector<HTMLButtonElement>('.docs-related-link')!;
    expect(link.tagName).toBe('BUTTON');
    expect(link.textContent).toBe('ReplacingMergeTree');
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found', value: structuredEntry({ target: { kind: 'table-engine', name: 'ReplacingMergeTree' }, title: 'ReplacingMergeTree' }),
    });
    link.click();
    expect(app.catalog.docEntry).toHaveBeenLastCalledWith({ kind: 'table-engine', name: 'ReplacingMergeTree' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-name')!.textContent).toBe('ReplacingMergeTree');
    closeDocPane(app);
  });

  it('a related item WITHOUT a target renders as an inert text chip (no button)', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: structuredEntry({ related: [{ label: 'just a label' }] }),
    });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-related-link')).toBeNull();
    const chip = document.querySelector('.docs-related-chip')!;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.textContent).toBe('just a label');
    closeDocPane(app);
  });

  it('omits the related section entirely when related is empty/absent', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: structuredEntry({ related: [] }) });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-related')).toBeNull();
    closeDocPane(app);
  });
});

describe('#314 session-local back stack', () => {
  it('no Back button on a fresh open', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: structuredEntry() });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-back')).toBeNull();
    closeDocPane(app);
  });

  it('a related navigation pushes the back stack; Back returns to the prior target', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found',
      value: structuredEntry({ related: [{ label: 'ReplacingMergeTree', target: { kind: 'table-engine', name: 'ReplacingMergeTree' } }] }),
    });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found', value: structuredEntry({ target: { kind: 'table-engine', name: 'ReplacingMergeTree' }, title: 'ReplacingMergeTree' }),
    });
    document.querySelector<HTMLButtonElement>('.docs-related-link')!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-name')!.textContent).toBe('ReplacingMergeTree');
    const back = document.querySelector<HTMLButtonElement>('.docs-back')!;
    expect(back).not.toBeNull();

    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: structuredEntry({ title: 'MergeTree' }) });
    back.click();
    expect(app.catalog.docEntry).toHaveBeenLastCalledWith(T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-name')!.textContent).toBe('MergeTree');
    // popped — back to empty, Back button gone again
    expect(document.querySelector('.docs-back')).toBeNull();
    closeDocPane(app);
  });

  it('alias navigation ALSO pushes the back stack — one unified path', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found',
      value: entry({ target: { kind: 'function', name: 'toUnixTimestamp' }, title: 'toUnixTimestamp', aliasTo: 'toDateTime' }),
    });
    openDocEntry(app, { kind: 'function', name: 'toUnixTimestamp' });
    await Promise.resolve(); await Promise.resolve();
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: entry() });
    document.querySelector<HTMLButtonElement>('.docs-alias-link')!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-back')).not.toBeNull();
    closeDocPane(app);
  });

  it('the back stack is capped at 20 — the oldest hop is dropped, not the most recent', async () => {
    const app = makeApp();
    // Build a chain of 25 related hops, each pointing to the next.
    const chainEntry = (n: number): DocEntry => structuredEntry({
      target: { kind: 'table-engine', name: 'E' + n }, title: 'E' + n,
      related: [{ label: 'E' + (n + 1), target: { kind: 'table-engine', name: 'E' + (n + 1) } }],
    });
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: chainEntry(0) });
    openDocEntry(app, { kind: 'table-engine', name: 'E0' });
    await Promise.resolve(); await Promise.resolve();
    for (let i = 1; i <= 25; i++) {
      app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: chainEntry(i) });
      document.querySelector<HTMLButtonElement>('.docs-related-link')!.click();
      await Promise.resolve(); await Promise.resolve();
    }
    expect(document.querySelector('.docs-name')!.textContent).toBe('E25');
    // Walk all the way back — never more than 20 hops even though 25 were made.
    let steps = 0;
    while (document.querySelector('.docs-back')) {
      app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: structuredEntry({ title: 'popped' + steps }) });
      document.querySelector<HTMLButtonElement>('.docs-back')!.click();
      await Promise.resolve(); await Promise.resolve();
      steps++;
      if (steps > 25) throw new Error('back stack never emptied — cap not enforced');
    }
    expect(steps).toBe(20);
    closeDocPane(app);
  });

  it('a fresh EXTERNAL openDocEntry call clears the back stack from a prior session', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found',
      value: structuredEntry({ related: [{ label: 'ReplacingMergeTree', target: { kind: 'table-engine', name: 'ReplacingMergeTree' } }] }),
    });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found', value: structuredEntry({ target: { kind: 'table-engine', name: 'ReplacingMergeTree' }, title: 'ReplacingMergeTree' }),
    });
    document.querySelector<HTMLButtonElement>('.docs-related-link')!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-back')).not.toBeNull(); // back stack now has one entry

    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: structuredEntry({ title: 'Log' }) });
    openDocEntry(app, { kind: 'table-engine', name: 'Log' }); // a fresh external open — new session
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-back')).toBeNull(); // prior session's back stack is gone
    closeDocPane(app);
  });

  it('closing the pane clears the back stack (a later reopen starts fresh)', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found',
      value: structuredEntry({ related: [{ label: 'ReplacingMergeTree', target: { kind: 'table-engine', name: 'ReplacingMergeTree' } }] }),
    });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found', value: structuredEntry({ target: { kind: 'table-engine', name: 'ReplacingMergeTree' }, title: 'ReplacingMergeTree' }),
    });
    document.querySelector<HTMLButtonElement>('.docs-related-link')!.click();
    await Promise.resolve(); await Promise.resolve();
    closeDocPane(app);

    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: structuredEntry({ title: 'Log' }) });
    openDocEntry(app, { kind: 'table-engine', name: 'Log' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-back')).toBeNull(); // a fresh pane after close — no stale back stack
    closeDocPane(app);
  });

  it('the Back button also appears in missing/unavailable states reached via navigation', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found',
      value: structuredEntry({ related: [{ label: 'GoneTree', target: { kind: 'table-engine', name: 'GoneTree' } }] }),
    });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'missing' });
    document.querySelector<HTMLButtonElement>('.docs-related-link')!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-missing')).not.toBeNull();
    expect(document.querySelector('.docs-back')).not.toBeNull();
    closeDocPane(app);
  });
});

function summaryOf(over: Partial<DocSummary> = {}): DocSummary {
  return {
    target: { kind: 'function', name: 'X' },
    title: 'X',
    signature: 'X()',
    summary: 'A summary.',
    ...over,
  };
}

describe('#315 openDocDisambiguation', () => {
  it('0 matches ("missing") renders the same missing state docEntry uses', async () => {
    const app = makeApp();
    app.catalog.docDisambiguate.mockResolvedValue({ status: 'missing' });
    openDocDisambiguation(app, 'mystery');
    await Promise.resolve(); await Promise.resolve();
    expect(app.catalog.docDisambiguate).toHaveBeenCalledWith('mystery');
    expect(document.querySelector('.docs-missing')!.textContent).toContain('No documentation for mystery.');
    closeDocPane(app);
  });

  it('exactly 1 match navigates straight to that entry — no list is rendered', async () => {
    const app = makeApp();
    app.catalog.docDisambiguate.mockResolvedValue({
      status: 'found', value: [summaryOf({ target: { kind: 'setting', name: 'max_threads' } })],
    });
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: entry({ target: { kind: 'setting', name: 'max_threads' }, title: 'max_threads' }) });
    openDocDisambiguation(app, 'max_threads');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(app.catalog.docEntry).toHaveBeenCalledWith({ kind: 'setting', name: 'max_threads' });
    expect(document.querySelector('.docs-name')!.textContent).toBe('max_threads');
    expect(document.querySelector('.docs-disambiguate-list')).toBeNull();
    closeDocPane(app);
  });

  it('2+ matches render an accessible labelled list of real buttons', async () => {
    const app = makeApp();
    app.catalog.docDisambiguate.mockResolvedValue({
      status: 'found',
      value: [
        summaryOf({ target: { kind: 'setting', name: 'connect' }, title: 'connect', summary: 'A connection setting.' }),
        summaryOf({ target: { kind: 'function', name: 'connect' }, title: 'connect', summary: 'A connection function.' }),
      ],
    });
    openDocDisambiguation(app, 'connect');
    await Promise.resolve(); await Promise.resolve();
    const list = document.querySelector('.docs-disambiguate-list')!;
    expect(list).not.toBeNull();
    expect(list.getAttribute('role')).toBe('list');
    expect(list.getAttribute('aria-label')).toContain('connect');
    const items = document.querySelectorAll<HTMLButtonElement>('.docs-disambiguate-link');
    expect(items).toHaveLength(2);
    // Real, keyboard-reachable <button> elements (native tab order, no
    // custom ARIA wiring needed) — one per candidate, each showing its kind
    // badge, name, and summary.
    expect(items[0].tagName).toBe('BUTTON');
    expect(items[0].type).toBe('button');
    expect(items[0].textContent).toContain('setting');
    expect(items[0].textContent).toContain('connect');
    expect(items[0].textContent).toContain('A connection setting.');
    expect(items[1].textContent).toContain('function');
    expect(items[1].textContent).toContain('A connection function.');
    closeDocPane(app);
  });

  it('selecting a candidate loads it in the pane and pushes the list onto the back stack; Back returns to the list', async () => {
    const app = makeApp();
    app.catalog.docDisambiguate.mockResolvedValue({
      status: 'found',
      value: [
        summaryOf({ target: { kind: 'setting', name: 'connect' }, title: 'connect (setting)' }),
        summaryOf({ target: { kind: 'function', name: 'connect' }, title: 'connect (function)' }),
      ],
    });
    openDocDisambiguation(app, 'connect');
    await Promise.resolve(); await Promise.resolve();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found', value: entry({ target: { kind: 'setting', name: 'connect' }, title: 'connect (setting)' }),
    });
    document.querySelectorAll<HTMLButtonElement>('.docs-disambiguate-link')[0].click();
    await Promise.resolve(); await Promise.resolve();
    expect(app.catalog.docEntry).toHaveBeenCalledWith({ kind: 'setting', name: 'connect' });
    expect(document.querySelector('.docs-name')!.textContent).toBe('connect (setting)');
    const back = document.querySelector<HTMLButtonElement>('.docs-back')!;
    expect(back).not.toBeNull();

    app.catalog.docDisambiguate.mockResolvedValueOnce({
      status: 'found',
      value: [
        summaryOf({ target: { kind: 'setting', name: 'connect' }, title: 'connect (setting)' }),
        summaryOf({ target: { kind: 'function', name: 'connect' }, title: 'connect (function)' }),
      ],
    });
    back.click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-disambiguate-list')).not.toBeNull(); // back to the list, not a target
    closeDocPane(app);
  });

  it('keyboard activation (Enter on a focused candidate button) works the same as a click', async () => {
    const app = makeApp();
    app.catalog.docDisambiguate.mockResolvedValue({
      status: 'found',
      value: [summaryOf({ target: { kind: 'setting', name: 'a' } }), summaryOf({ target: { kind: 'function', name: 'a' } })],
    });
    openDocDisambiguation(app, 'a');
    await Promise.resolve(); await Promise.resolve();
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: entry({ target: { kind: 'setting', name: 'a' }, title: 'a-setting' }) });
    const btn = document.querySelectorAll<HTMLButtonElement>('.docs-disambiguate-link')[0];
    btn.focus();
    expect(document.activeElement).toBe(btn);
    // A native <button> fires its `click` handler for both a real click and
    // an Enter/Space keydown by browser default — no synthetic keydown
    // dispatch needed to prove keyboard reachability; `.click()` IS what a
    // real Enter keypress on a focused button triggers.
    btn.click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-name')!.textContent).toBe('a-setting');
    closeDocPane(app);
  });

  it('unavailable renders the retry state, and Retry re-runs docDisambiguate', async () => {
    const app = makeApp();
    app.catalog.docDisambiguate.mockResolvedValueOnce({ status: 'unavailable' });
    openDocDisambiguation(app, 'x');
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-unavailable')).not.toBeNull();
    app.catalog.docDisambiguate.mockResolvedValueOnce({ status: 'missing' });
    document.querySelector<HTMLButtonElement>('.docs-retry')!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(app.catalog.docDisambiguate).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.docs-missing')).not.toBeNull();
    closeDocPane(app);
  });

  it('a fresh EXTERNAL openDocDisambiguation call clears a prior session\'s back stack', async () => {
    const app = makeApp();
    app.catalog.docDisambiguate.mockResolvedValueOnce({
      status: 'found',
      value: [summaryOf({ target: { kind: 'setting', name: 'connect' } }), summaryOf({ target: { kind: 'function', name: 'connect' } })],
    });
    openDocDisambiguation(app, 'connect');
    await Promise.resolve(); await Promise.resolve();
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: entry({ target: { kind: 'setting', name: 'connect' } }) });
    document.querySelectorAll<HTMLButtonElement>('.docs-disambiguate-link')[0].click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-back')).not.toBeNull();

    app.catalog.docDisambiguate.mockResolvedValueOnce({ status: 'missing' });
    openDocDisambiguation(app, 'other'); // fresh external open — new session
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-back')).toBeNull();
    closeDocPane(app);
  });

  it('openDocEntry (a normal, non-disambiguation open) still clears any prior disambiguation back stack too', async () => {
    const app = makeApp();
    app.catalog.docDisambiguate.mockResolvedValueOnce({
      status: 'found',
      value: [summaryOf({ target: { kind: 'setting', name: 'connect' } }), summaryOf({ target: { kind: 'function', name: 'connect' } })],
    });
    openDocDisambiguation(app, 'connect');
    await Promise.resolve(); await Promise.resolve();
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: entry({ target: { kind: 'setting', name: 'connect' } }) });
    document.querySelectorAll<HTMLButtonElement>('.docs-disambiguate-link')[0].click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-back')).not.toBeNull();

    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: entry({ title: 'toDateTime' }) });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-back')).toBeNull();
    closeDocPane(app);
  });

  it('stale-response safety: retargeting (openDocEntry) before docDisambiguate resolves drops the stale list', async () => {
    const app = makeApp();
    const first = deferred<DocLookup<DocSummary[]>>();
    app.catalog.docDisambiguate.mockReturnValueOnce(first.promise);
    openDocDisambiguation(app, 'connect');
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: entry({ title: 'toDateTime' }) });
    openDocEntry(app, T_FN); // a newer lookup starts before the disambiguation settles
    await Promise.resolve(); await Promise.resolve();
    first.resolve({
      status: 'found',
      value: [summaryOf({ target: { kind: 'setting', name: 'connect' } }), summaryOf({ target: { kind: 'function', name: 'connect' } })],
    }); // resolves AFTER the retarget
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-name')!.textContent).toBe('toDateTime'); // never overwritten by the stale list
    expect(document.querySelector('.docs-disambiguate-list')).toBeNull();
    closeDocPane(app);
  });

  it('closing before docDisambiguate resolves discards the result — no render, no throw', async () => {
    const app = makeApp();
    const { promise, resolve } = deferred<DocLookup<DocSummary[]>>();
    app.catalog.docDisambiguate.mockReturnValue(promise);
    openDocDisambiguation(app, 'connect');
    closeDocPane(app);
    resolve({ status: 'found', value: [summaryOf(), summaryOf({ target: { kind: 'function', name: 'X' } })] });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-panel')).toBeNull();
  });

  it('an unknown-kind candidate shows the literal "unknown" badge, never a misleading generic label', async () => {
    const app = makeApp();
    app.catalog.docDisambiguate.mockResolvedValue({
      status: 'found',
      value: [
        summaryOf({ target: { kind: 'unknown', name: 'weird' } }),
        summaryOf({ target: { kind: 'function', name: 'weird' } }),
      ],
    });
    openDocDisambiguation(app, 'weird');
    await Promise.resolve(); await Promise.resolve();
    const items = document.querySelectorAll<HTMLButtonElement>('.docs-disambiguate-link');
    expect(items[0].textContent).toContain('unknown');
    closeDocPane(app);
  });
});

function markdownEntry(over: Partial<DocEntry> = {}): DocEntry {
  return {
    target: { kind: 'setting', name: 'max_threads' },
    title: 'max_threads',
    signature: 'max_threads',
    summary: 'Max threads.',
    categories: [],
    renderMode: 'markdown-subset',
    markdown: '# max_threads\n\nThe maximum number of threads.',
    serverTypeLabel: 'Setting',
    ...over,
  };
}

describe('#315 markdown-subset entries', () => {
  it('renders the compact head + parsed Markdown body via renderDocMarkdown, not the structured layout', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: markdownEntry() });
    openDocEntry(app, { kind: 'setting', name: 'max_threads' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-name')!.textContent).toBe('max_threads');
    expect(document.querySelector('.docs-badge-kind')!.textContent).toBe('setting');
    expect(document.querySelector('.docs-md')).not.toBeNull();
    expect(document.querySelector('.docs-md-h')!.textContent).toBe('max_threads');
    expect(document.querySelector('.docs-signature')).toBeNull(); // structured-only field never rendered
    closeDocPane(app);
  });

  it('an unknown kind shows the entry\'s own serverTypeLabel as the kind badge', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found',
      value: markdownEntry({ target: { kind: 'unknown', name: 'Something' }, serverTypeLabel: 'Weird New Type' }),
    });
    openDocEntry(app, { kind: 'unknown', name: 'Something' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-badge-kind')!.textContent).toBe('Weird New Type');
    closeDocPane(app);
  });

  it('falls back to "unknown" when an unknown-kind entry has no serverTypeLabel at all', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found',
      value: markdownEntry({ target: { kind: 'unknown', name: 'Something' }, serverTypeLabel: '' }),
    });
    openDocEntry(app, { kind: 'unknown', name: 'Something' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-badge-kind')!.textContent).toBe('unknown');
    closeDocPane(app);
  });

  it('a blank markdown body still renders (empty docs-md container, no throw)', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: markdownEntry({ markdown: '' }) });
    expect(() => openDocEntry(app, { kind: 'setting', name: 'max_threads' })).not.toThrow();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-md')).not.toBeNull();
    closeDocPane(app);
  });

  it('shows the source path as small muted text when present, omitted when absent', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: markdownEntry({ source: 'docs/settings.md' }),
    });
    openDocEntry(app, { kind: 'setting', name: 'max_threads' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-md-source')!.textContent).toBe('docs/settings.md');
    closeDocPane(app);

    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: markdownEntry({ source: undefined }) });
    openDocEntry(app, { kind: 'setting', name: 'max_threads' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-md-source')).toBeNull();
    closeDocPane(app);
  });

  it('oversized entries show a distinct quiet truncation note', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: markdownEntry({ oversized: true }),
    });
    openDocEntry(app, { kind: 'setting', name: 'max_threads' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-md-oversized')!.textContent)
      .toBe('Documentation body truncated (too large).');
    closeDocPane(app);
  });

  it('shows the "View latest on clickhouse.com" link only when confidently derivable from source', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: markdownEntry({ source: 'docs/en/operations/settings/settings.md' }),
    });
    openDocEntry(app, { kind: 'setting', name: 'max_threads' });
    await Promise.resolve(); await Promise.resolve();
    const link = document.querySelector<HTMLAnchorElement>('.docs-md-latest')!;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('https://clickhouse.com/docs/operations/settings/settings');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    closeDocPane(app);
  });

  it('omits the latest-link entirely when the source path is not confidently derivable', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({
      status: 'found', value: markdownEntry({ source: 'some/weird/path.txt' }),
    });
    openDocEntry(app, { kind: 'setting', name: 'max_threads' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-md-latest')).toBeNull();
    closeDocPane(app);
  });

  it('omits the latest-link when source is absent', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: markdownEntry({ source: undefined }) });
    openDocEntry(app, { kind: 'setting', name: 'max_threads' });
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-md-latest')).toBeNull();
    closeDocPane(app);
  });

  it('mounts a SQL-fenced code block through the injected CodeViewer, torn down on retarget', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found',
      value: markdownEntry({ markdown: '```sql\nSELECT 1\n```' }),
    });
    openDocEntry(app, { kind: 'setting', name: 'max_threads' });
    await Promise.resolve(); await Promise.resolve();
    expect(app.CodeViewer).toHaveBeenCalledWith(expect.objectContaining({ text: 'SELECT 1', language: 'sql' }));
    const firstViewer = (app.CodeViewer as ReturnType<typeof vi.fn>).mock.results[0].value;

    app.catalog.docEntry.mockResolvedValueOnce({ status: 'missing' });
    openDocEntry(app, { kind: 'function', name: 'other' });
    await Promise.resolve(); await Promise.resolve();
    expect(firstViewer.destroy).toHaveBeenCalled();
    closeDocPane(app);
  });


  it('the structured render path is unchanged for renderMode-absent entries', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValue({ status: 'found', value: entry() });
    openDocEntry(app, T_FN);
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-signature')!.textContent).toBe('toDateTime(expr[, timezone])');
    // The structured path's own long-text fields (Summary/Description/
    // Arguments/…) now render through the SAME `.docs-md` markdown renderer
    // Fix B introduces — what stays absent is the markdown-subset-ENTRY-only
    // chrome (`renderMarkdownEntry`'s own wrapper class / source line /
    // "View latest" link), which is a distinct render path from `renderFound`.
    expect(document.querySelector('.docs-md-entry')).toBeNull();
    expect(document.querySelector('.docs-md-source')).toBeNull();
    expect(document.querySelector('.docs-md-latest')).toBeNull();
    closeDocPane(app);
  });

  it('the Back button appears when navigating away and back from a markdown entry via structured "related"', async () => {
    const app = makeApp();
    app.catalog.docEntry.mockResolvedValueOnce({
      status: 'found',
      value: structuredEntry({ related: [{ label: 'ToNext', target: { kind: 'table-engine', name: 'ToNext' } }] }),
    });
    openDocEntry(app, T_ENGINE);
    await Promise.resolve(); await Promise.resolve();
    app.catalog.docEntry.mockResolvedValueOnce({ status: 'found', value: markdownEntry() });
    document.querySelector<HTMLButtonElement>('.docs-related-link')!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.docs-md')).not.toBeNull();
    expect(document.querySelector('.docs-back')).not.toBeNull();
    closeDocPane(app);
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
