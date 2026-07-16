// ADR-0002 phase 1 — hand-written, type-level contract assertions for the
// generated src/generated/json-schema.types.ts artifact. No runtime code:
// everything here erases (`erasableSyntaxOnly`); the file is compiled by the
// `check:types` gate (`tsc --noEmit`) and excluded from coverage like every
// other *.types.ts. Positive assertions only — if the emitter ever produces a
// shape that breaks one of these contracts, the gate fails loudly.

import type {
  BarPanelCfg,
  LibraryV2,
  PanelCfg,
  QuerySpecV1,
  SavedQueryV2,
} from './generated/json-schema.types.js';

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;

// QuerySpecV1 is forward-open: unknown extension keys are storable.
export type QuerySpecV1IsOpen = Assert<Extends<string, keyof QuerySpecV1>>;

// LibraryV2 and SavedQueryV2 are closed envelopes (no index signature).
export type LibraryV2IsClosed = Assert<Not<Extends<string, keyof LibraryV2>>>;
export type SavedQueryV2IsClosed = Assert<Not<Extends<string, keyof SavedQueryV2>>>;

// The single saved-query variant pins specVersion to the literal 1.
export type SpecVersionIsLiteralOne = Assert<Extends<SavedQueryV2['specVersion'], 1>>;

// The panelCfg discriminated union is usable: Extract selects the exact
// branch, and every branch is a member of the union.
export type ExtractBarPanelIsExact = Assert<Extends<Extract<PanelCfg, { type: 'bar' }>, BarPanelCfg>>;
export type BarPanelIsInUnion = Assert<Extends<BarPanelCfg, PanelCfg>>;

// A Spec carrying unknown renderer extensions stays assignable (openness in
// practice, not just via keyof).
export type SpecWithExtensionsIsAssignable = Assert<Extends<{
  name: string;
  view: 'table';
  futureFeature: { nested: number[] };
}, QuerySpecV1>>;

// A complete, valid Library / saved-query / Spec example type-checks
// end-to-end (type-level construction only; annotated runtime consts would
// not erase under erasableSyntaxOnly).
type ExampleSpec = {
  name: 'Revenue by country';
  view: 'panel';
  panel: { cfg: { type: 'bar'; x: 0; y: [1] } };
};
type ExampleQuery = { id: 'q1'; sql: 'SELECT 1'; specVersion: 1; spec: ExampleSpec };
type ExampleLibrary = {
  format: 'altinity-sql-browser/saved-queries';
  version: 2;
  exportedAt: '2026-07-16T00:00:00.000Z';
  queries: [ExampleQuery];
};
export type ExampleSpecIsValid = Assert<Extends<ExampleSpec, QuerySpecV1>>;
export type ExampleQueryIsValid = Assert<Extends<ExampleQuery, SavedQueryV2>>;
export type ExampleLibraryIsValid = Assert<Extends<ExampleLibrary, LibraryV2>>;
