// #343 §8 — the linked-tab conflict resolution chooser. Pure DOM: the two
// actions and the explicit-confirm gate on "Keep my draft".

import { describe, it, expect, vi } from 'vitest';
import { buildConflictChooser } from '../../src/ui/conflict-resolution.js';

const click = (el: Element | null): void => { el!.dispatchEvent(new Event('click', { bubbles: true })); };
const qs = (root: Element, sel: string): HTMLElement | null => root.querySelector(sel);

describe('buildConflictChooser (#343)', () => {
  it('shows the query name and the two initial actions', () => {
    const node = buildConflictChooser({ queryName: 'Sales q', onReloadSaved: vi.fn(), onKeepDraft: vi.fn() });
    expect(qs(node, '.cf-title')!.textContent).toBe('Query changed in another tab');
    expect(qs(node, '.cf-desc')!.textContent).toContain('Sales q');
    expect(qs(node, '.cf-reload')).not.toBeNull();
    expect(qs(node, '.cf-keep')).not.toBeNull();
    // The confirmation controls aren't shown until "Keep my draft" is chosen.
    expect(qs(node, '.cf-overwrite')).toBeNull();
  });

  it('"Reload saved version" fires onReloadSaved immediately (no confirm)', () => {
    const onReloadSaved = vi.fn();
    const onKeepDraft = vi.fn();
    const node = buildConflictChooser({ queryName: 'q', onReloadSaved, onKeepDraft });
    click(qs(node, '.cf-reload'));
    expect(onReloadSaved).toHaveBeenCalledTimes(1);
    expect(onKeepDraft).not.toHaveBeenCalled();
  });

  it('"Keep my draft" requires an explicit confirmation before onKeepDraft fires', () => {
    const onKeepDraft = vi.fn();
    const node = buildConflictChooser({ queryName: 'q', onReloadSaved: vi.fn(), onKeepDraft });
    click(qs(node, '.cf-keep'));
    // Now in the confirm stage: onKeepDraft not yet called; Overwrite/Cancel shown.
    expect(onKeepDraft).not.toHaveBeenCalled();
    expect(qs(node, '.cf-confirm')).not.toBeNull();
    expect(qs(node, '.cf-overwrite')).not.toBeNull();
    click(qs(node, '.cf-overwrite'));
    expect(onKeepDraft).toHaveBeenCalledTimes(1);
  });

  it('the confirm stage can be cancelled back to the two initial actions', () => {
    const onKeepDraft = vi.fn();
    const node = buildConflictChooser({ queryName: 'q', onReloadSaved: vi.fn(), onKeepDraft });
    click(qs(node, '.cf-keep'));
    click(qs(node, '.cf-cancel'));
    // Back to the initial actions; nothing committed.
    expect(qs(node, '.cf-reload')).not.toBeNull();
    expect(qs(node, '.cf-overwrite')).toBeNull();
    expect(onKeepDraft).not.toHaveBeenCalled();
  });
});
