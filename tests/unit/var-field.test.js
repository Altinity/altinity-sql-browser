import { describe, it, expect } from 'vitest';
import { applyFieldState } from '../../src/ui/var-field.js';

function makeInput() {
  return document.createElement('input');
}

describe('applyFieldState', () => {
  it('no field state: neutral, base title', () => {
    const el = makeInput();
    applyFieldState(el, undefined, 'n: UInt8');
    expect(el.classList.contains('is-invalid')).toBe(false);
    expect(el.hasAttribute('aria-invalid')).toBe(false);
    expect(el.title).toBe('n: UInt8');
  });
  it("state 'ok'/'incomplete'/'missing'/'inactive': neutral, base title (incomplete stays quiet while focused)", () => {
    const el = makeInput();
    for (const state of ['ok', 'incomplete', 'missing', 'inactive']) {
      applyFieldState(el, { state }, 'n: UInt8');
      expect(el.classList.contains('is-invalid')).toBe(false);
      expect(el.hasAttribute('aria-invalid')).toBe(false);
      expect(el.title).toBe('n: UInt8');
    }
  });
  it("state 'invalid' with a reason: error affordance, reason as the tooltip", () => {
    const el = makeInput();
    applyFieldState(el, { state: 'invalid', reason: 'Expected UInt8 from 0 to 255' }, 'n: UInt8');
    expect(el.classList.contains('is-invalid')).toBe(true);
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(el.title).toBe('Expected UInt8 from 0 to 255');
  });
  it("state 'invalid' with no reason: error affordance, falls back to the base title", () => {
    const el = makeInput();
    applyFieldState(el, { state: 'invalid' }, 'n: UInt8');
    expect(el.classList.contains('is-invalid')).toBe(true);
    expect(el.title).toBe('n: UInt8');
  });
  it('correcting the value clears the affordance and restores the base title', () => {
    const el = makeInput();
    applyFieldState(el, { state: 'invalid', reason: 'bad' }, 'n: UInt8');
    applyFieldState(el, { state: 'ok' }, 'n: UInt8');
    expect(el.classList.contains('is-invalid')).toBe(false);
    expect(el.hasAttribute('aria-invalid')).toBe(false);
    expect(el.title).toBe('n: UInt8');
  });
});
