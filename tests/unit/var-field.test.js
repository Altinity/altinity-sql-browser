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

  // Review finding #4 (#174 §1): aria-describedby wires to a real element —
  // whichever inline error/preview element the caller passes (today:
  // relative-time-field.js's previewEl, shared by the workbench var-strip and
  // the dashboard filter bar) — when it has something to say, and unwires
  // when it doesn't. No `descEl` (the plain scalar `<input>` case) leaves
  // today's title-only affordance untouched.
  describe('aria-describedby wiring (descEl)', () => {
    function makeDesc(text) {
      const d = document.createElement('div');
      d.id = 'desc-1';
      d.textContent = text || '';
      return d;
    }
    it('no descEl: no aria-describedby is ever set, regardless of state', () => {
      const el = makeInput();
      applyFieldState(el, { state: 'invalid', reason: 'bad' }, 'n: UInt8');
      expect(el.hasAttribute('aria-describedby')).toBe(false);
    });
    it('descEl with content: aria-describedby points at its id', () => {
      const el = makeInput();
      const desc = makeDesc('-1h → 2026-07-11 08:23:45 (your time)');
      applyFieldState(el, { state: 'ok' }, 'n: DateTime', desc);
      expect(el.getAttribute('aria-describedby')).toBe('desc-1');
    });
    it('descEl empty (nothing to describe): aria-describedby is not set', () => {
      const el = makeInput();
      const desc = makeDesc('');
      applyFieldState(el, { state: 'ok' }, 'n: DateTime', desc);
      expect(el.hasAttribute('aria-describedby')).toBe(false);
    });
    it('descEl content clears (e.g. the preview empties out): aria-describedby is removed', () => {
      const el = makeInput();
      const desc = makeDesc('now → 2026-07-11 09:23:45 (your time)');
      applyFieldState(el, { state: 'ok' }, 'n: DateTime', desc);
      expect(el.hasAttribute('aria-describedby')).toBe(true);
      desc.textContent = '';
      applyFieldState(el, { state: 'ok' }, 'n: DateTime', desc);
      expect(el.hasAttribute('aria-describedby')).toBe(false);
    });
    it('invalid state with a descEl carrying the error text: aria-describedby still points at it', () => {
      const el = makeInput();
      const desc = makeDesc('Not a valid relative time expression: "now/q"');
      applyFieldState(el, { state: 'invalid', reason: 'Not a valid relative time expression: "now/q"' }, 'n: DateTime', desc);
      expect(el.getAttribute('aria-describedby')).toBe('desc-1');
      expect(el.getAttribute('aria-invalid')).toBe('true');
    });
  });
});
