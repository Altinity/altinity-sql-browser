import { describe, it, expect } from 'vitest';
import {
  SIDE_PANELS, LOWER_PANEL_IDS, SIDE_PANEL_KEYS, UPPER_PANEL_IDS,
  lowerPanelIdsOf, sidePanelKeysOf, sidePanelKeyFor, decodeSidePanelKey, lowerIdForKey,
} from '../../src/core/side-panels.js';

describe('SIDE_PANELS manifest', () => {
  it('lists all four panels, in order, with exactly the lower two carrying a persistedKey', () => {
    expect(SIDE_PANELS).toEqual([
      { id: 'databases', pane: 'upper' },
      { id: 'dashboards', pane: 'upper' },
      { id: 'library', pane: 'lower', persistedKey: 'saved' },
      { id: 'history', pane: 'lower', persistedKey: 'history' },
    ]);
  });

  it('derives LOWER_PANEL_IDS/UPPER_PANEL_IDS/SIDE_PANEL_KEYS from the manifest, in manifest order', () => {
    expect(LOWER_PANEL_IDS).toEqual(['library', 'history']);
    expect(UPPER_PANEL_IDS).toEqual(['databases', 'dashboards']);
    expect(SIDE_PANEL_KEYS).toEqual(['saved', 'history']);
  });
});

// #587 AC4's falsifiability requirement: the derivation functions, called with
// an EXTENDED manifest, must reflect the addition without any second, hand-
// maintained list anywhere picking it up independently — proven by feeding a
// fake extra panel to the pure derivation directly (the frozen `SIDE_PANELS`
// itself is never mutated).
describe('lowerPanelIdsOf / sidePanelKeysOf — derivation, not hand-listing', () => {
  it('a panel added to the manifest changes the derived lower-panel id list', () => {
    const extended = [...SIDE_PANELS, { id: 'fake', pane: 'lower' as const, persistedKey: 'fake-key' }];
    expect(lowerPanelIdsOf(extended)).toEqual(['library', 'history', 'fake']);
    expect(lowerPanelIdsOf()).toEqual(['library', 'history']); // the real manifest is untouched
  });

  it('a panel added to the manifest changes the derived persisted-key list', () => {
    const extended = [...SIDE_PANELS, { id: 'fake', pane: 'lower' as const, persistedKey: 'fake-key' }];
    expect(sidePanelKeysOf(extended)).toEqual(['saved', 'history', 'fake-key']);
    expect(sidePanelKeysOf()).toEqual(['saved', 'history']);
  });

  it('an upper-pane addition never appears in the lower-panel/persisted-key derivations', () => {
    const extended = [...SIDE_PANELS, { id: 'fake-upper', pane: 'upper' as const }];
    expect(lowerPanelIdsOf(extended)).toEqual(['library', 'history']);
    expect(sidePanelKeysOf(extended)).toEqual(['saved', 'history']);
  });
});

describe('sidePanelKeyFor — id -> persisted value', () => {
  it('maps library to the legacy "saved" string, and history to itself', () => {
    expect(sidePanelKeyFor('library')).toBe('saved');
    expect(sidePanelKeyFor('history')).toBe('history');
  });
});

describe('lowerIdForKey — persisted value -> id (the reverse mapping)', () => {
  it('round-trips both directions', () => {
    expect(lowerIdForKey('saved')).toBe('library');
    expect(lowerIdForKey('history')).toBe('history');
    for (const id of LOWER_PANEL_IDS) expect(lowerIdForKey(sidePanelKeyFor(id))).toBe(id);
  });
});

// #587 §0.2 / R2.9: on `main` before this phase there was NO bridge at all —
// `state.ts` read the raw stored string with no validation, and consumers
// compared `=== 'saved'` directly, so an unrecognized value fell through to
// the History branch (neither the default nor the value's own meaning). This
// decoder is the fix: fail CLOSED to 'saved' (Library), the documented
// default, for anything that isn't exactly a known persisted key.
describe('decodeSidePanelKey — fail-closed load-boundary decode', () => {
  it('recognizes exactly the two persisted values', () => {
    expect(decodeSidePanelKey('saved')).toBe('saved');
    expect(decodeSidePanelKey('history')).toBe('history');
  });

  it('fails closed to "saved" for every unrecognized input, including the registry id itself', () => {
    for (const bad of ['', 'saved ', 'library', 'nope', null, undefined, 0, {}, [], 'History']) {
      expect(decodeSidePanelKey(bad)).toBe('saved');
    }
  });

  it('never decodes to the registry id "library" — only ever to a persisted value', () => {
    // #587 R2.9 downgrade-safety: `'library'` (the registry's OWN id) must
    // never come out of this decoder — a reverted build reading this value
    // back must recognize it as a value it always understood.
    expect(decodeSidePanelKey('library')).not.toBe('library');
    expect(decodeSidePanelKey('library')).toBe('saved');
  });
});
