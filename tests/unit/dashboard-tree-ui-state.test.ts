import { describe, expect, it } from 'vitest';
import {
  EMPTY_TREE_UI, clampKeyboardRow, groupStateKey, pruneTreeUi, readTreeUi,
  setDashboardExpanded, setGroupExpanded, setKeyboardRow, setTreeScroll, setTreeSearch,
  toggleDashboardExpanded, toggleGroupExpanded,
  type DashboardTreeUiState,
} from '../../src/core/dashboard-tree-ui-state.js';

describe('readTreeUi', () => {
  it('is the empty state for a workspace with none yet, WITHOUT creating an entry', () => {
    const states = new Map<string, DashboardTreeUiState>();
    expect(readTreeUi(states, 'w1')).toBe(EMPTY_TREE_UI);
    expect(states.size).toBe(0);
  });

  it('keeps each workspace\'s state independent, keyed by workspace id', () => {
    const states = new Map<string, DashboardTreeUiState>([
      ['w1', toggleDashboardExpanded(EMPTY_TREE_UI, 'd1')],
      ['w2', setTreeSearch(EMPTY_TREE_UI, 'sales')],
    ]);
    expect(readTreeUi(states, 'w1').expandedDashboardIds.has('d1')).toBe(true);
    expect(readTreeUi(states, 'w2').expandedDashboardIds.has('d1')).toBe(false);
    expect(readTreeUi(states, 'w2').searchText).toBe('sales');
    expect(readTreeUi(states, 'w1').searchText).toBe('');
  });
});

describe('expansion', () => {
  it('toggles a Dashboard by stable id, copy-on-write', () => {
    const opened = toggleDashboardExpanded(EMPTY_TREE_UI, 'd1');
    expect(opened.expandedDashboardIds.has('d1')).toBe(true);
    // The input is untouched — no in-place Set mutation.
    expect(EMPTY_TREE_UI.expandedDashboardIds.has('d1')).toBe(false);
    expect(toggleDashboardExpanded(opened, 'd1').expandedDashboardIds.has('d1')).toBe(false);
  });

  it('toggles a group by Dashboard id PLUS group name, never by position', () => {
    const opened = toggleGroupExpanded(EMPTY_TREE_UI, 'd1', 'filters');
    expect(opened.expandedGroups.has(groupStateKey('d1', 'filters'))).toBe(true);
    // The two groups of one Dashboard, and the same group of two Dashboards, are
    // all distinct keys.
    expect(opened.expandedGroups.has(groupStateKey('d1', 'panels'))).toBe(false);
    expect(opened.expandedGroups.has(groupStateKey('d2', 'filters'))).toBe(false);
  });

  it('sets expansion explicitly for the keyboard, without toggling', () => {
    // Right on an already-open row must not close it (it moves to the first child).
    const opened = setDashboardExpanded(EMPTY_TREE_UI, 'd1', true);
    expect(setDashboardExpanded(opened, 'd1', true)).toBe(opened);
    expect(setDashboardExpanded(opened, 'd1', false).expandedDashboardIds.has('d1')).toBe(false);
    // Left on an already-collapsed row is likewise a no-op (it moves to the parent).
    expect(setDashboardExpanded(EMPTY_TREE_UI, 'd1', false)).toBe(EMPTY_TREE_UI);
  });

  it('sets group expansion explicitly too', () => {
    const opened = setGroupExpanded(EMPTY_TREE_UI, 'd1', 'panels', true);
    expect(opened.expandedGroups.has(groupStateKey('d1', 'panels'))).toBe(true);
    expect(setGroupExpanded(opened, 'd1', 'panels', true)).toBe(opened);
    expect(setGroupExpanded(EMPTY_TREE_UI, 'd1', 'panels', false)).toBe(EMPTY_TREE_UI);
    expect(setGroupExpanded(opened, 'd1', 'panels', false).expandedGroups.size).toBe(0);
  });
});

describe('groupStateKey', () => {
  it('escapes the Dashboard id so two ids cannot share a group key', () => {
    // `a:panels` as a Dashboard id would otherwise collide with Dashboard `a`'s
    // Panels group.
    expect(groupStateKey('a:panels', 'filters')).not.toBe(groupStateKey('a', 'panels'));
    expect(groupStateKey('a', 'panels')).toBe('a:panels');
  });
});

describe('setTreeSearch', () => {
  it('captures the pre-search scroll position when a search STARTS', () => {
    const scrolled = setTreeScroll(EMPTY_TREE_UI, 420);
    const searching = setTreeSearch(scrolled, 'reg');
    expect(searching.searchText).toBe('reg');
    expect(searching.preSearchScrollTop).toBe(420);
    // The live scroll position is still free to track the filtered list.
    expect(searching.scrollTop).toBe(420);
  });

  it('keeps the captured position while the search text CHANGES', () => {
    const searching = setTreeSearch(setTreeScroll(EMPTY_TREE_UI, 420), 'reg');
    const narrowed = setTreeSearch(setTreeScroll(searching, 0), 'region');
    expect(narrowed.preSearchScrollTop).toBe(420);
    expect(narrowed.scrollTop).toBe(0);
  });

  it('restores the pre-search scroll position when the search CLEARS', () => {
    const searching = setTreeSearch(setTreeScroll(EMPTY_TREE_UI, 420), 'reg');
    const cleared = setTreeSearch(setTreeScroll(searching, 0), '');
    expect(cleared.searchText).toBe('');
    expect(cleared.scrollTop).toBe(420);
    expect(cleared.preSearchScrollTop).toBeNull();
  });

  it('clearing a search that never captured a position lands at the top', () => {
    // Reachable when the tree is first rendered mid-search (a restored session).
    const searching: DashboardTreeUiState = { ...EMPTY_TREE_UI, searchText: 'reg', scrollTop: 90 };
    const cleared = setTreeSearch(searching, '');
    expect(cleared.scrollTop).toBe(0);
    expect(cleared.preSearchScrollTop).toBeNull();
  });

  it('never touches expansion — a search exposes paths at presentation time', () => {
    const opened = toggleDashboardExpanded(EMPTY_TREE_UI, 'd1');
    const searching = setTreeSearch(opened, 'anything');
    expect(searching.expandedDashboardIds).toBe(opened.expandedDashboardIds);
  });
});

describe('setTreeScroll / setKeyboardRow', () => {
  it('return the same state when nothing changes', () => {
    expect(setTreeScroll(EMPTY_TREE_UI, 0)).toBe(EMPTY_TREE_UI);
    expect(setKeyboardRow(EMPTY_TREE_UI, null)).toBe(EMPTY_TREE_UI);
  });

  it('record a new value otherwise', () => {
    expect(setTreeScroll(EMPTY_TREE_UI, 12).scrollTop).toBe(12);
    expect(setKeyboardRow(EMPTY_TREE_UI, 'w:d1').keyboardRowKey).toBe('w:d1');
    expect(setKeyboardRow(setKeyboardRow(EMPTY_TREE_UI, 'w:d1'), null).keyboardRowKey).toBeNull();
  });
});

describe('pruneTreeUi', () => {
  it('drops removed Dashboards and their groups, PRESERVING every survivor', () => {
    let state = EMPTY_TREE_UI;
    for (const id of ['keep', 'gone']) {
      state = toggleDashboardExpanded(state, id);
      state = toggleGroupExpanded(state, id, 'filters');
      state = toggleGroupExpanded(state, id, 'panels');
    }
    const pruned = pruneTreeUi(state, ['keep']);
    expect([...pruned.expandedDashboardIds]).toEqual(['keep']);
    expect([...pruned.expandedGroups]).toEqual([groupStateKey('keep', 'filters'), groupStateKey('keep', 'panels')]);
  });

  it('returns the SAME state when nothing needed pruning', () => {
    const state = toggleGroupExpanded(toggleDashboardExpanded(EMPTY_TREE_UI, 'd1'), 'd1', 'panels');
    // An ordinary mutation (a new tile, a rename) must not collapse the tree.
    expect(pruneTreeUi(state, ['d1', 'd2'])).toBe(state);
  });

  it('resolves a Dashboard id that itself contains the group separator', () => {
    // The id is ESCAPED into the group key, so splitting on the last separator is
    // unambiguous — and a Dashboard called `ops` must not keep `ops:eu`'s group.
    const state = toggleGroupExpanded(EMPTY_TREE_UI, 'ops:eu', 'panels');
    expect(pruneTreeUi(state, ['ops:eu']).expandedGroups.has(groupStateKey('ops:eu', 'panels'))).toBe(true);
    expect(pruneTreeUi(state, ['ops']).expandedGroups.size).toBe(0);
  });

  it('prunes everything for an emptied collection', () => {
    const state = toggleDashboardExpanded(EMPTY_TREE_UI, 'd1');
    expect(pruneTreeUi(state, []).expandedDashboardIds.size).toBe(0);
  });
});

describe('clampKeyboardRow', () => {
  it('keeps a keyboard row that is still visible', () => {
    const state = setKeyboardRow(EMPTY_TREE_UI, 'w:d1:tile:t1');
    expect(clampKeyboardRow(state, ['w:d1', 'w:d1:tile:t1'])).toBe(state);
  });

  it('falls back to the first visible row when the owner is gone', () => {
    // Reachable without any removal at all: collapsing an ancestor or typing a
    // search takes the row out of the visible set.
    const state = setKeyboardRow(EMPTY_TREE_UI, 'w:d1:tile:t1');
    expect(clampKeyboardRow(state, ['w:d2']).keyboardRowKey).toBe('w:d2');
  });

  it('clears the keyboard row when nothing is visible at all', () => {
    const state = setKeyboardRow(EMPTY_TREE_UI, 'w:d1');
    expect(clampKeyboardRow(state, []).keyboardRowKey).toBeNull();
  });

  it('adopts the first row when none was set yet', () => {
    expect(clampKeyboardRow(EMPTY_TREE_UI, ['w:d1', 'w:d2']).keyboardRowKey).toBe('w:d1');
  });
});
