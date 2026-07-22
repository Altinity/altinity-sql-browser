import { describe, it, expect } from 'vitest';
import { analyzeParameterizedSources } from '../../src/core/param-pipeline.js';
import type { ParameterAnalysis } from '../../src/core/param-pipeline.js';
import {
  resolveFilterSelection,
  gatherExecutableConsumers,
  sameSelection,
  canonicalizeSelection,
  reconcileSelection,
} from '../../src/core/filter-selection.js';
import type { FilterSelectionFilterDef } from '../../src/core/filter-selection.js';

// Fixtures are round-tripped through the real `analyzeParameterizedSources`
// (the repo's convention — see `tests/unit/filter-bar.test.ts`'s `paramsFor`
// helper) rather than hand-crafted `ParameterAnalysis` shapes, so this suite
// exercises the real per-source declaration bookkeeping `resolveFilterSelection`
// consumes.
const analysisFor = (sources: { id: string; sql: string }[]): ParameterAnalysis =>
  analyzeParameterizedSources(sources.map((s) => ({ id: s.id, kind: 'tab', sql: s.sql, bindPolicy: 'row-returning' })));

const filterDef = (over: Partial<FilterSelectionFilterDef> = {}): FilterSelectionFilterDef => ({
  id: 'f1',
  parameter: 'x',
  ...over,
});

const codesOf = (diags: { code: string }[]): string[] => diags.map((d) => d.code);

describe('resolveFilterSelection — mode table', () => {
  it('omitted mode + scalar contract → single', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' },
      { id: 'b', sql: 'SELECT * FROM u WHERE x = {x:UInt8}' },
    ]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a', 'b']));
    expect(r.diagnostics).toEqual([]);
    expect(r.contract).toEqual({ array: false, type: expect.objectContaining({ base: 'UInt8', isArray: false }) });
    expect(r.mode).toBe('single');
  });

  it('omitted mode + Array(T) contract → multiple', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x IN {x:Array(UInt8)}' },
    ]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a']));
    expect(r.diagnostics).toEqual([]);
    expect(r.contract).toEqual({ array: true, type: expect.objectContaining({ base: 'UInt8' }) });
    expect(r.mode).toBe('multiple');
  });

  it('"single" + scalar contract → single', () => {
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE x = {x:String}' }]);
    const r = resolveFilterSelection(filterDef({ selection: { mode: 'single' } }), analysis, new Set(['a']));
    expect(r.diagnostics).toEqual([]);
    expect(r.mode).toBe('single');
    expect(r.contract!.array).toBe(false);
  });

  it('"single" + Array(T) contract → single (UI is responsible for committing [value])', () => {
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE x IN {x:Array(String)}' }]);
    const r = resolveFilterSelection(filterDef({ selection: { mode: 'single' } }), analysis, new Set(['a']));
    expect(r.diagnostics).toEqual([]);
    expect(r.mode).toBe('single');
    expect(r.contract).toEqual({ array: true, type: expect.objectContaining({ base: 'String' }) });
  });

  it('"multiple" + Array(T) contract → multiple', () => {
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE x IN {x:Array(UInt64)}' }]);
    const r = resolveFilterSelection(filterDef({ selection: { mode: 'multiple' } }), analysis, new Set(['a']));
    expect(r.diagnostics).toEqual([]);
    expect(r.mode).toBe('multiple');
  });

  it('"multiple" + scalar contract → INVALID: filter-selection-mode-requires-array, never silently downgraded', () => {
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' }]);
    const r = resolveFilterSelection(filterDef({ selection: { mode: 'multiple' } }), analysis, new Set(['a']));
    expect(r.mode).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-mode-requires-array']);
    // Contract is still surfaced (informational) even though mode fails.
    expect(r.contract).toEqual({ array: false, type: expect.objectContaining({ base: 'UInt8' }) });
    expect(r.diagnostics[0].message).toContain('f1');
    expect(r.diagnostics[0].message).toContain('multiple');
  });

  it('unknown non-empty mode string → filter-selection-unknown-mode, fallback', () => {
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE x = {x:String}' }]);
    const r = resolveFilterSelection(filterDef({ selection: { mode: 'bogus' } }), analysis, new Set(['a']));
    expect(r.mode).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-unknown-mode']);
    expect(r.diagnostics[0].message).toContain('bogus');
  });

  it('any/omitted mode + no agreed contract → fallback, no extra mode-table diagnostic on top', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' },
      { id: 'b', sql: 'SELECT * FROM u WHERE x = {x:String}' },
    ]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a', 'b']));
    expect(r.mode).toBeNull();
    expect(r.contract).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-type-conflict']);
  });
});

describe('resolveFilterSelection — consumer resolution', () => {
  it('derives consumers from every executable tile with a bound declaration when targets is absent', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' },
      { id: 'b', sql: 'SELECT * FROM u WHERE x = {x:UInt8}' },
      { id: 'c', sql: 'SELECT 1' }, // does not declare x at all
    ]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a', 'b', 'c']));
    expect(r.diagnostics).toEqual([]);
    expect(r.mode).toBe('single');
  });

  it('a non-executable tile\'s declaration is excluded — no conflict from a tile that cannot run', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' },
      { id: 'b', sql: 'SELECT * FROM u WHERE x = {x:String}' }, // conflicting type, but not executable
    ]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a']));
    expect(r.diagnostics).toEqual([]);
    expect(r.contract).toEqual({ array: false, type: expect.objectContaining({ base: 'UInt8' }) });
  });

  it('explicit targets: only targeted tiles feed the contract, non-targeted conflicting tiles are ignored', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' },
      { id: 'b', sql: 'SELECT * FROM u WHERE x = {x:String}' },
    ]);
    const r = resolveFilterSelection(filterDef({ targets: ['a'] }), analysis, new Set(['a', 'b']));
    expect(r.diagnostics).toEqual([]);
    expect(r.contract).toEqual({ array: false, type: expect.objectContaining({ base: 'UInt8' }) });
  });

  it('explicit target that is not an executable tile → filter-selection-target-not-executable, fail-closed', () => {
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' }]);
    const r = resolveFilterSelection(filterDef({ targets: ['missing'] }), analysis, new Set(['a']));
    expect(r.mode).toBeNull();
    expect(r.contract).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-target-not-executable']);
    expect(r.diagnostics[0].message).toContain('missing');
    // No redundant generic "no consumers" diagnostic piled on top.
    expect(r.diagnostics).toHaveLength(1);
  });

  it('explicit target executable but not declaring the parameter → filter-selection-target-missing-declaration', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' },
      { id: 'b', sql: 'SELECT 1' },
    ]);
    const r = resolveFilterSelection(filterDef({ targets: ['b'] }), analysis, new Set(['a', 'b']));
    expect(r.mode).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-target-missing-declaration']);
    expect(r.diagnostics[0].message).toContain('b');
    expect(r.diagnostics[0].message).toContain('x');
  });

  it('multiple simultaneous target problems each produce their own diagnostic', () => {
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT 1' }]);
    const r = resolveFilterSelection(filterDef({ targets: ['missing', 'a'] }), analysis, new Set(['a']));
    expect(codesOf(r.diagnostics).sort()).toEqual([
      'filter-selection-target-missing-declaration',
      'filter-selection-target-not-executable',
    ]);
    expect(r.mode).toBeNull();
  });

  it('target-less config with zero executable consumers → filter-selection-no-consumers', () => {
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT 1' }]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a']));
    expect(r.mode).toBeNull();
    expect(r.contract).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-no-consumers']);
  });

  // #360's single-layer cascading rule: a Filter source that itself depends on
  // a SOURCE-BACKED parameter is cascading-invalid and never executes, and
  // only source-backed filters get a selection contract — so a non-tile
  // executable consumer of a contract-bearing parameter cannot exist. A
  // Filter source's own declaration of the parameter therefore NEVER
  // influences the contract, even when it conflicts: it simply isn't in
  // `executableTileIds` (a Filter source is not a tile), so
  // `gatherExecutableConsumers` never picks it up, agreeing or not.
  it('a Filter source\'s own declaration of the parameter — even a conflicting one — never influences the contract', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' },
      { id: 'dep1', sql: 'SELECT * FROM u WHERE x = {x:String}' }, // a Filter source's own analyzed declaration
    ]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a']));
    expect(r.diagnostics).toEqual([]);
    expect(r.contract).toEqual({ array: false, type: expect.objectContaining({ base: 'UInt8' }) });
    expect(r.mode).toBe('single');
  });

  it('a Filter-source-only declaration (no executable tile declares the parameter) resolves no consumers', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT 1' },
      { id: 'dep1', sql: 'SELECT * FROM u WHERE x = {x:String}' },
    ]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a']));
    expect(r.mode).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-no-consumers']);
  });
});

describe('gatherExecutableConsumers', () => {
  it('is the shared gathering step resolveFilterSelection calls internally — same entries/diagnostics either way', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' },
      { id: 'b', sql: 'SELECT 1' },
    ]);
    const r = gatherExecutableConsumers(filterDef({ targets: ['a', 'b'] }), analysis, new Set(['a', 'b']));
    expect(r.entries).toEqual([{ sourceId: 'a', type: 'UInt8' }]);
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-target-missing-declaration']);
    expect(r.targetProblem).toBe(true);
  });

  it('no-targets form gathers every executable tile with a bound declaration, no diagnostics', () => {
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' }]);
    const r = gatherExecutableConsumers(filterDef(), analysis, new Set(['a']));
    expect(r.entries).toEqual([{ sourceId: 'a', type: 'UInt8' }]);
    expect(r.diagnostics).toEqual([]);
    expect(r.targetProblem).toBe(false);
  });
});

describe('resolveFilterSelection — arity and conflict diagnostics', () => {
  it('mixed scalar and Array(...) declarations → filter-selection-mixed-arity', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' },
      { id: 'b', sql: 'SELECT * FROM u WHERE x IN {x:Array(UInt8)}' },
    ]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a', 'b']));
    expect(r.mode).toBeNull();
    expect(r.contract).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-mixed-arity']);
  });

  it('conflicting Array element types → filter-selection-array-element-conflict', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x IN {x:Array(UInt8)}' },
      { id: 'b', sql: 'SELECT * FROM u WHERE x IN {x:Array(String)}' },
    ]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a', 'b']));
    expect(r.mode).toBeNull();
    expect(r.contract).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-array-element-conflict']);
    expect(r.diagnostics[0].message).toContain('UInt8');
    expect(r.diagnostics[0].message).toContain('String');
  });

  it('nested arrays are unsupported → filter-selection-nested-array', () => {
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE x IN {x:Array(Array(String))}' }]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a']));
    expect(r.mode).toBeNull();
    expect(r.contract).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-nested-array']);
    expect(r.diagnostics[0].message).toContain('a');
  });

  // `conflictingTypes` (param-type.ts) compares by `canonicalType()`, which is
  // wrapper-SENSITIVE (whitespace-insensitive outside quotes, but does not
  // unwrap `Nullable(...)`/`LowCardinality(...)`) — so a bare scalar and its
  // `Nullable`/`LowCardinality`-wrapped form are DIFFERENT declarations, never
  // silently unified, for both a scalar contract and an Array(...) contract's
  // element types. This module reuses that identity as-is rather than
  // inventing its own transparency rule — documented here since it is easy to
  // assume the opposite (value-level transparency, which IS how `param-type.ts`
  // treats these wrappers for serialization/validation, just not for identity).
  it('Nullable(T) is NOT transparent to conflictingTypes — scalar contract', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x = {x:UInt8}' },
      { id: 'b', sql: 'SELECT * FROM u WHERE x = {x:Nullable(UInt8)}' },
    ]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a', 'b']));
    expect(r.mode).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-type-conflict']);
  });

  it('LowCardinality(T) is NOT transparent to conflictingTypes — Array(...) element contract', () => {
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE x IN {x:Array(String)}' },
      { id: 'b', sql: 'SELECT * FROM u WHERE x IN {x:Array(LowCardinality(String))}' },
    ]);
    const r = resolveFilterSelection(filterDef(), analysis, new Set(['a', 'b']));
    expect(r.mode).toBeNull();
    expect(codesOf(r.diagnostics)).toEqual(['filter-selection-array-element-conflict']);
  });
});

describe('sameSelection', () => {
  it('two equal string arrays (element-wise, order matters)', () => {
    expect(sameSelection(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameSelection(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('different lengths are unequal', () => {
    expect(sameSelection(['a'], ['a', 'b'])).toBe(false);
  });

  it('two equal strings compare as strings', () => {
    expect(sameSelection('a', 'a')).toBe(true);
    expect(sameSelection('a', 'b')).toBe(false);
  });

  it('an array never equals a string, even with matching contents', () => {
    expect(sameSelection(['a'], 'a')).toBe(false);
    expect(sameSelection('a', ['a'])).toBe(false);
  });

  it('empty string is a valid element, not a sentinel', () => {
    expect(sameSelection(['', 'a'], ['', 'a'])).toBe(true);
    expect(sameSelection('', '')).toBe(true);
  });

  it('falls back to === for other shapes (null/undefined)', () => {
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(undefined, null)).toBe(false);
  });
});

describe('canonicalizeSelection', () => {
  const options = [{ value: 'b' }, { value: 'a' }, { value: '' }];

  it('dedupes and orders by option order, never values order', () => {
    expect(canonicalizeSelection(['a', 'b', 'a'], options)).toEqual(['b', 'a']);
  });

  it('drops values with no matching option', () => {
    expect(canonicalizeSelection(['a', 'zzz'], options)).toEqual(['a']);
  });

  it('empty string is a valid option value, kept and ordered like any other', () => {
    expect(canonicalizeSelection(['', 'a'], options)).toEqual(['a', '']);
  });

  it('never introduces a value that was not already present', () => {
    expect(canonicalizeSelection([], options)).toEqual([]);
  });
});

describe('reconcileSelection', () => {
  it('pure reorder/label change (every committed value still present) → waveNeeded: false', () => {
    const r = reconcileSelection(['b', 'a'], [{ value: 'a' }, { value: 'b' }]);
    expect(r.value).toEqual(['a', 'b']);
    expect(r.waveNeeded).toBe(false);
    expect(r.deactivate).toBe(false);
  });

  it('a committed value removed from options → waveNeeded: true, canonical order kept', () => {
    const r = reconcileSelection(['a', 'b'], [{ value: 'a' }]);
    expect(r.value).toEqual(['a']);
    expect(r.waveNeeded).toBe(true);
    expect(r.deactivate).toBe(false);
  });

  it('every committed value removed → deactivate: true', () => {
    const r = reconcileSelection(['a', 'b'], []);
    expect(r.value).toEqual([]);
    expect(r.deactivate).toBe(true);
    expect(r.waveNeeded).toBe(true);
  });

  it('nothing committed → no-op, never deactivates or needs a wave', () => {
    const r = reconcileSelection([], [{ value: 'a' }]);
    expect(r.value).toEqual([]);
    expect(r.deactivate).toBe(false);
    expect(r.waveNeeded).toBe(false);
  });

  it('never auto-selects a value that was not previously committed', () => {
    const r = reconcileSelection(['a'], [{ value: 'a' }, { value: 'new' }]);
    expect(r.value).toEqual(['a']);
  });

  it('duplicate committed values are deduped', () => {
    const r = reconcileSelection(['a', 'a', 'b'], [{ value: 'a' }, { value: 'b' }]);
    expect(r.value).toEqual(['a', 'b']);
    expect(r.waveNeeded).toBe(false);
  });

  it('empty string is a valid committed value and option', () => {
    const r = reconcileSelection(['', 'a'], [{ value: 'a' }, { value: '' }]);
    expect(r.value).toEqual(['a', '']);
    expect(r.waveNeeded).toBe(false);
    expect(r.deactivate).toBe(false);
  });
});
