import { describe, it, expect } from 'vitest';
import { EXPLAIN_VIEWS, parseExplain, detectExplainView, buildExplainQuery } from '../../src/core/explain.js';

describe('EXPLAIN_VIEWS', () => {
  it('lists the five views with a renderer kind and a ClickHouse format', () => {
    expect(EXPLAIN_VIEWS.map((v) => v.id)).toEqual(['explain', 'indexes', 'projections', 'pipeline', 'estimate']);
    const byId = Object.fromEntries(EXPLAIN_VIEWS.map((v) => [v.id, v]));
    expect(byId.pipeline.kind).toBe('graph');
    expect(byId.estimate.kind).toBe('table');
    expect(byId.estimate.chFormat).toBe('Table');
    expect(byId.explain.chFormat).toBe('TabSeparatedRaw');
  });
});

describe('parseExplain', () => {
  it('returns null for non-EXPLAIN statements', () => {
    expect(parseExplain('SELECT 1')).toBeNull();
    expect(parseExplain('SELECT explain FROM t')).toBeNull();
    expect(parseExplain('')).toBeNull();
    expect(parseExplain(null)).toBeNull();
  });
  it('parses a bare EXPLAIN (= PLAN) with no settings', () => {
    expect(parseExplain('EXPLAIN SELECT 1')).toEqual({ kind: 'PLAN', settings: {}, inner: 'SELECT 1' });
    expect(parseExplain('  explain  SELECT 1 ')).toEqual({ kind: 'PLAN', settings: {}, inner: 'SELECT 1' });
  });
  it('parses an explicit PLAN keyword and a WITH/CTE inner', () => {
    expect(parseExplain('EXPLAIN PLAN WITH x AS (SELECT 1) SELECT * FROM x'))
      .toEqual({ kind: 'PLAN', settings: {}, inner: 'WITH x AS (SELECT 1) SELECT * FROM x' });
  });
  it('parses form keywords (PIPELINE / ESTIMATE / AST / multi-word)', () => {
    expect(parseExplain('EXPLAIN PIPELINE SELECT 1').kind).toBe('PIPELINE');
    expect(parseExplain('EXPLAIN ESTIMATE SELECT 1').kind).toBe('ESTIMATE');
    expect(parseExplain('EXPLAIN AST SELECT 1').kind).toBe('AST');
    expect(parseExplain('EXPLAIN QUERY TREE SELECT 1').kind).toBe('QUERY TREE');
  });
  it('captures a single setting and the inner statement', () => {
    expect(parseExplain('EXPLAIN indexes = 1 SELECT 1')).toEqual({ kind: 'PLAN', settings: { indexes: '1' }, inner: 'SELECT 1' });
    expect(parseExplain('EXPLAIN PIPELINE graph = 1 SELECT 1')).toEqual({ kind: 'PIPELINE', settings: { graph: '1' }, inner: 'SELECT 1' });
  });
  it('captures multiple comma- or space-separated settings', () => {
    expect(parseExplain('EXPLAIN indexes = 1, actions = 1 SELECT 1').settings).toEqual({ indexes: '1', actions: '1' });
    expect(parseExplain("EXPLAIN PIPELINE graph = 1 compact = 0 SELECT 1").settings).toEqual({ graph: '1', compact: '0' });
  });
  it('unquotes string setting values', () => {
    expect(parseExplain("EXPLAIN description = 'x' SELECT 1").settings).toEqual({ description: 'x' });
  });
});

describe('detectExplainView', () => {
  it('returns null for nullish input', () => {
    expect(detectExplainView(null)).toBeNull();
  });
  it('maps an exact single defining setting/kind to its rich view', () => {
    expect(detectExplainView(parseExplain('EXPLAIN indexes = 1 SELECT 1'))).toBe('indexes');
    expect(detectExplainView(parseExplain('EXPLAIN projections = 1 SELECT 1'))).toBe('projections');
    expect(detectExplainView(parseExplain('EXPLAIN PIPELINE graph = 1 SELECT 1'))).toBe('pipeline');
    expect(detectExplainView(parseExplain('EXPLAIN PIPELINE graph = 1 compact = 0 SELECT 1'))).toBe('pipeline');
    expect(detectExplainView(parseExplain('EXPLAIN ESTIMATE SELECT 1'))).toBe('estimate');
  });
  it('returns null for plain EXPLAIN, extra settings, or unmanaged kinds', () => {
    expect(detectExplainView(parseExplain('EXPLAIN SELECT 1'))).toBeNull();
    expect(detectExplainView(parseExplain('EXPLAIN indexes = 1, actions = 1 SELECT 1'))).toBeNull();
    expect(detectExplainView(parseExplain('EXPLAIN indexes = 0 SELECT 1'))).toBeNull();
    expect(detectExplainView(parseExplain('EXPLAIN PIPELINE graph = 1 header = 1 SELECT 1'))).toBeNull();
    expect(detectExplainView(parseExplain('EXPLAIN ESTIMATE indexes = 1 SELECT 1'))).toBeNull();
    expect(detectExplainView(parseExplain('EXPLAIN AST SELECT 1'))).toBeNull();
    expect(detectExplainView(parseExplain('EXPLAIN PIPELINE SELECT 1'))).toBeNull();
  });
});

describe('buildExplainQuery', () => {
  it('builds the derived query for each rich view', () => {
    expect(buildExplainQuery('SELECT 1', 'indexes')).toBe('EXPLAIN indexes = 1 SELECT 1');
    expect(buildExplainQuery('SELECT 1', 'projections')).toBe('EXPLAIN projections = 1 SELECT 1');
    expect(buildExplainQuery('SELECT 1', 'pipeline')).toBe('EXPLAIN PIPELINE graph = 1 SELECT 1');
    expect(buildExplainQuery('SELECT 1', 'estimate')).toBe('EXPLAIN ESTIMATE SELECT 1');
  });
  it('falls back to a plain EXPLAIN for explain/unknown ids', () => {
    expect(buildExplainQuery('SELECT 1', 'explain')).toBe('EXPLAIN SELECT 1');
    expect(buildExplainQuery('SELECT 1', 'bogus')).toBe('EXPLAIN SELECT 1');
    expect(buildExplainQuery(null, 'explain')).toBe('EXPLAIN ');
  });
});
