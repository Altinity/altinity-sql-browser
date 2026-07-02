import { describe, it, expect, vi } from 'vitest';
import { loadingPlaceholder } from '../../src/ui/placeholder.js';

describe('loadingPlaceholder', () => {
  it('builds a spinner placeholder with the given message', () => {
    const el = loadingPlaceholder('Loading table…');
    expect(el.className).toBe('placeholder starting');
    expect(el.querySelector('.spin svg')).not.toBeNull();
    expect(el.textContent).toContain('Loading table…');
  });
  it('omits the Cancel button when no onCancel is given', () => {
    const el = loadingPlaceholder('Loading table…');
    expect(el.querySelector('.exp-cancel')).toBeNull();
  });
  it('adds a working Cancel button when onCancel is given (#124)', () => {
    const onCancel = vi.fn();
    const el = loadingPlaceholder('Loading data flow…', onCancel);
    const btn = el.querySelector('.exp-cancel');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain('Cancel');
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
