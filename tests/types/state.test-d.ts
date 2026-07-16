// Compile-time invariants for src/state.ts (ADR-0002 phase 2). This file is
// NEVER executed — vitest's include glob covers only tests/unit/**/*.test.js —
// it is type-checked by `tsc --noEmit` (tsconfig includes tests/types/**/*.ts).
// Positive assertions only: each line fails the gate if the declared
// relationship stops holding.

import type { Signal } from '@preact/signals-core';
import { activeTab, createState, newTabObj, setTabSpecDraft, tabPanel } from '../../src/state.js';
import type {
  AppState, HistoryEntry, PanelSpec, PatchDraftResult, QuerySpecDraft, QueryTab,
} from '../../src/state.js';
import type { SavedQueryV2 } from '../../src/generated/json-schema.types.js';

function assertType<T>(_v: T): void {}

// createState() returns the full AppState (with and without an injected reader).
assertType<AppState>(createState());
const state = createState({ loadJSON: (_key, fallback) => fallback, loadStr: (_key, fallback) => fallback });
assertType<AppState>(state);

// The reactive slices carry their precise value types.
assertType<Signal<QueryTab[]>>(state.tabs);
assertType<Signal<Set<string>>>(state.expanded);
assertType<Signal<'table' | 'json' | 'panel' | 'filter'>>(state.resultView);
assertType<SavedQueryV2[]>(state.savedQueries);
assertType<HistoryEntry[]>(state.history);

// activeTab always yields a tab (first-tab fallback), never `| undefined`.
assertType<QueryTab>(activeTab(state));

// A canonical QuerySpecV1 carrying unknown extension fields is a valid draft
// for setTabSpecDraft (extensions ride in the schema's index signature).
const extendedSpec: QuerySpecDraft = {
  name: 'Extended', favorite: false, futureExtension: { nested: [1, 2, 3] },
};
assertType<QueryTab>(setTabSpecDraft(newTabObj('t1'), extendedSpec));

// The parsed draft is nullable (invalid-JSON state); the panel payload is not.
assertType<QuerySpecDraft | null>(newTabObj('t1').specParsed);
assertType<PanelSpec | null>(tabPanel(newTabObj('t1')));
assertType<PatchDraftResult['ok']>(true as boolean);
