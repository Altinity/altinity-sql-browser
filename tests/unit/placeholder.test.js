import { describe, it, expect } from 'vitest';
import { loadingPlaceholder } from '../../src/ui/placeholder.js';

describe('loadingPlaceholder', () => {
  it('builds a spinner placeholder with the given message', () => {
    const el = loadingPlaceholder('Loading table…');
    expect(el.className).toBe('placeholder starting');
    expect(el.querySelector('.spin svg')).not.toBeNull();
    expect(el.textContent).toContain('Loading table…');
  });
});
