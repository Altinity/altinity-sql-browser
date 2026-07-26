import { describe, it, expect } from 'vitest';
import {
  inferDashboardVariables, bindableVariables, variableTileIds, normalizeVariableSql,
} from '../../src/core/dashboard-variables.js';
import type { InferDashboardVariablesInput } from '../../src/core/dashboard-variables.js';

const infer = (input: Partial<InferDashboardVariablesInput> = {}) => inferDashboardVariables({
  tiles: [], queries: [], ...input,
});

const names = (input: Partial<InferDashboardVariablesInput>) => infer(input).map((v) => v.name);

describe('inferDashboardVariables', () => {
  it('creates one row per distinct name with its inferred type', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }],
      queries: [{ id: 'q1', sql: 'SELECT 1 WHERE country = {country:String}' }],
    });
    expect(variables).toHaveLength(1);
    expect(variables[0]).toMatchObject({
      name: 'country', status: 'active', type: 'String', types: ['String'], sql: null, diagnostic: null,
    });
    expect(variables[0].declarations).toEqual([
      { name: 'country', type: 'String', tileId: 't1', queryId: 'q1' },
    ]);
  });

  it('collapses the same name declared by several panels into one row', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      queries: [
        { id: 'q1', sql: 'SELECT 1 WHERE country = {country:String}' },
        { id: 'q2', sql: 'SELECT 2 WHERE billing_country = {country:String}' },
      ],
    });
    expect(variables).toHaveLength(1);
    expect(variables[0].status).toBe('active');
    expect(variables[0].types).toEqual(['String']);
    expect(variables[0].declarations.map((d) => d.tileId)).toEqual(['t1', 't2']);
  });

  it('keeps exact names distinct — country and Country are two variables', () => {
    expect(names({
      tiles: [{ id: 't1', queryId: 'q1' }],
      queries: [{ id: 'q1', sql: 'SELECT {country:String}, {Country:String}' }],
    })).toEqual(['country', 'Country']);
  });

  it('agrees on a type across whitespace differences rather than reporting a conflict', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      queries: [
        { id: 'q1', sql: 'SELECT {c:Nullable(String)}' },
        { id: 'q2', sql: 'SELECT {c:Nullable( String )}' },
      ],
    });
    expect(variables[0].status).toBe('active');
    expect(variables[0].types).toEqual(['Nullable(String)']);
  });

  it('reports one conflicted row carrying every distinct type and usage', () => {
    const variables = infer({
      tiles: [{ id: 'orders', queryId: 'q1' }, { id: 'revenue', queryId: 'q2' }],
      queries: [
        { id: 'q1', sql: 'SELECT 1 WHERE customer_id = {customer_id:UInt64}' },
        { id: 'q2', sql: 'SELECT 2 WHERE customer_id = {customer_id:String}' },
      ],
      tileLabels: { orders: 'Orders panel', revenue: 'Revenue panel' },
    });
    expect(variables).toHaveLength(1);
    expect(variables[0]).toMatchObject({ name: 'customer_id', status: 'conflicted', type: null });
    expect(variables[0].types).toEqual(['UInt64', 'String']);
    expect(variables[0].diagnostic).toBe(
      'Variable “customer_id” has incompatible types:\n\n'
      + 'Orders panel: {customer_id:UInt64}\n'
      + 'Revenue panel: {customer_id:String}',
    );
  });

  it('names a conflicting panel by tile id when no label is supplied', () => {
    const variables = infer({
      tiles: [{ id: 'orders', queryId: 'q1' }, { id: 'revenue', queryId: 'q2' }],
      queries: [
        { id: 'q1', sql: 'SELECT {c:UInt64}' },
        { id: 'q2', sql: 'SELECT {c:String}' },
      ],
    });
    expect(variables[0].diagnostic).toContain('orders: {c:UInt64}');
    expect(variables[0].diagnostic).toContain('revenue: {c:String}');
  });

  it('clears a conflict automatically once the panel declarations agree', () => {
    const tiles = [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }];
    const conflicted = infer({
      tiles,
      queries: [{ id: 'q1', sql: 'SELECT {c:UInt64}' }, { id: 'q2', sql: 'SELECT {c:String}' }],
    });
    expect(conflicted[0].status).toBe('conflicted');
    const resolved = infer({
      tiles,
      queries: [{ id: 'q1', sql: 'SELECT {c:String}' }, { id: 'q2', sql: 'SELECT {c:String}' }],
    });
    expect(resolved[0]).toMatchObject({ status: 'active', type: 'String', diagnostic: null });
  });

  it('orders inferred variables by first declaration, then orphans by name', () => {
    expect(names({
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      queries: [
        { id: 'q1', sql: 'SELECT {zebra:String}, {apple:String}' },
        { id: 'q2', sql: 'SELECT {mango:String}' },
      ],
      variableConfigs: {
        region: { sql: 'SELECT 1, 1' },
        area: { sql: 'SELECT 2, 2' },
      },
    })).toEqual(['zebra', 'apple', 'mango', 'area', 'region']);
  });

  it('attaches stored option SQL to an inferred variable', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }],
      queries: [{ id: 'q1', sql: 'SELECT {country:String}' }],
      variableConfigs: { country: { sql: 'SELECT c, c FROM countries' } },
    });
    expect(variables[0]).toMatchObject({ status: 'active', sql: 'SELECT c, c FROM countries' });
  });

  it('turns a configured variable into an orphan when its last usage disappears', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }],
      queries: [{ id: 'q1', sql: 'SELECT 1' }],
      variableConfigs: { region: { sql: 'SELECT r, r FROM regions', lastKnownType: 'String' } },
    });
    expect(variables).toHaveLength(1);
    expect(variables[0]).toMatchObject({
      name: 'region', status: 'orphaned', type: 'String', sql: 'SELECT r, r FROM regions',
    });
    expect(variables[0].declarations).toEqual([]);
    expect(variables[0].diagnostic).toBe(
      'Variable “region” is not referenced by any Dashboard panel.\n'
      + 'Its option SQL is preserved but will not be executed.',
    );
  });

  it('shows an orphan with no lastKnownType as a name with no type', () => {
    const variables = infer({ variableConfigs: { region: { sql: 'SELECT r, r' } } });
    expect(variables[0]).toMatchObject({ status: 'orphaned', type: null });
    expect(variables[0].types).toEqual([]);
  });

  it('removes the row entirely when an UNconfigured variable loses its last usage', () => {
    expect(names({
      tiles: [{ id: 't1', queryId: 'q1' }],
      queries: [{ id: 'q1', sql: 'SELECT 1' }],
    })).toEqual([]);
  });

  it('prefers a live declaration over a stored lastKnownType', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }],
      queries: [{ id: 'q1', sql: 'SELECT {region:UInt8}' }],
      variableConfigs: { region: { sql: 'SELECT r, r', lastKnownType: 'String' } },
    });
    expect(variables[0]).toMatchObject({ status: 'active', type: 'UInt8' });
  });

  it('ignores a tile whose query is not in the collection', () => {
    expect(names({
      tiles: [{ id: 't1', queryId: 'missing' }],
      queries: [{ id: 'q1', sql: 'SELECT {country:String}' }],
    })).toEqual([]);
  });

  it('treats a query with no SQL as declaring nothing', () => {
    expect(names({ tiles: [{ id: 't1', queryId: 'q1' }], queries: [{ id: 'q1' }] })).toEqual([]);
  });

  it('reads the FIRST query when the collection repeats an id', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }],
      queries: [{ id: 'q1', sql: 'SELECT {a:String}' }, { id: 'q1', sql: 'SELECT {b:String}' }],
    });
    expect(variables.map((v) => v.name)).toEqual(['a']);
  });

  it('infers a variable declared ONLY inside an optional block (#165)', () => {
    // A raw lexical scan sees `/*[ … ]*/` as a block comment, so scanning the raw
    // SQL would infer nothing here and the block could never be activated from
    // the Dashboard, because no control would ever render for it.
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }],
      queries: [{ id: 'q1', sql: 'SELECT 1 /*[ AND city = {city:String} ]*/' }],
    });
    expect(variables).toHaveLength(1);
    expect(variables[0]).toMatchObject({ name: 'city', status: 'active', type: 'String' });
  });

  it('agrees a type declared inside an optional block with one declared outside it', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      queries: [
        { id: 'q1', sql: 'SELECT 1 WHERE c = {c:String}' },
        { id: 'q2', sql: 'SELECT 2 /*[ WHERE c = {c:String} ]*/' },
      ],
    });
    expect(variables).toHaveLength(1);
    expect(variables[0].status).toBe('active');
    expect(variables[0].declarations.map((d) => d.tileId)).toEqual(['t1', 't2']);
  });

  it('reports a conflict between an optional-block declaration and a plain one', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      queries: [
        { id: 'q1', sql: 'SELECT {c:UInt64}' },
        { id: 'q2', sql: 'SELECT 2 /*[ WHERE c = {c:String} ]*/' },
      ],
    });
    expect(variables[0]).toMatchObject({ status: 'conflicted', type: null });
    expect(variables[0].types).toEqual(['UInt64', 'String']);
  });

  it('does not see placeholders inside string literals or ordinary comments', () => {
    expect(names({
      tiles: [{ id: 't1', queryId: 'q1' }],
      queries: [{ id: 'q1', sql: "SELECT '{a:String}' -- {b:String}\nWHERE x = {c:String}" }],
    })).toEqual(['c']);
  });

  it('records every declaration of a name repeated within one query', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }],
      queries: [{ id: 'q1', sql: 'SELECT {a:String} WHERE b = {a:String}' }],
    });
    expect(variables).toHaveLength(1);
    expect(variables[0].declarations).toHaveLength(2);
  });
});

describe('bindableVariables', () => {
  it('keeps only active variables — conflicted and orphaned render no control', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      queries: [
        { id: 'q1', sql: 'SELECT {ok:String}, {bad:UInt64}' },
        { id: 'q2', sql: 'SELECT {bad:String}' },
      ],
      variableConfigs: { gone: { sql: 'SELECT g, g' } },
    });
    expect(variables.map((v) => v.status)).toEqual(['active', 'conflicted', 'orphaned']);
    expect(bindableVariables(variables).map((v) => v.name)).toEqual(['ok']);
  });
});

describe('variableTileIds', () => {
  it('binds to every panel declaring the name, each listed once', () => {
    const variables = infer({
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      queries: [
        { id: 'q1', sql: 'SELECT {a:String} WHERE b = {a:String}' },
        { id: 'q2', sql: 'SELECT {a:String}' },
      ],
    });
    expect(variableTileIds(variables[0])).toEqual(['t1', 't2']);
  });

  it('is empty for an orphan', () => {
    expect(variableTileIds(infer({ variableConfigs: { r: { sql: 'SELECT r, r' } } })[0])).toEqual([]);
  });
});

describe('normalizeVariableSql', () => {
  it('removes the configuration for blank or whitespace-only SQL', () => {
    expect(normalizeVariableSql('')).toBeNull();
    expect(normalizeVariableSql('   \n\t ')).toBeNull();
  });

  it('stores real SQL verbatim, including surrounding whitespace', () => {
    expect(normalizeVariableSql('  SELECT a, b  ')).toBe('  SELECT a, b  ');
  });
});
