import { describe, it, expect } from 'vitest';
import {
  buildExportDoc, parseImportDoc, mergeSaved, buildMarkdownDoc, buildSqlDoc, upgradeSavedEntry,
} from '../../src/core/saved-io.js';

const FORMAT = 'altinity-sql-browser/saved-queries';
const SCHEMA = 'https://altinity.com/schemas/altinity-sql-browser/library-v2.schema.json';
const NOW = '2026-07-13T00:00:00.000Z';
const v2 = (id, sql, spec = {}) => ({ id, sql, specVersion: 1, spec });
const envelope = (version, queries, over = {}) => JSON.stringify({ format: FORMAT, version, queries, ...over });
const CHART = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'k' };

describe('buildExportDoc', () => {
  it('writes only the canonical v2 envelope and preserves the complete Spec', () => {
    const extension = { nested: [{ x: 1 }] };
    const doc = buildExportDoc([v2('s1', 'SELECT 1', {
      name: 'A', favorite: true, panel: { cfg: { type: 'table' }, fieldConfig: { defaults: {} } }, extension,
    })], '2026-07-13T00:00:00.000Z');
    expect(doc).toEqual({
      $schema: SCHEMA, format: FORMAT, version: 2, exportedAt: NOW,
      queries: [v2('s1', 'SELECT 1', {
        name: 'A', favorite: true, panel: { cfg: { type: 'table' }, fieldConfig: { defaults: {} } }, extension,
      })],
    });
    expect(doc.queries[0].spec.extension).not.toBe(extension);
    expect('name' in doc.queries[0]).toBe(false);
    expect('panel' in doc.queries[0]).toBe(false);
    expect('chart' in doc.queries[0]).toBe(false);
  });

  it('upgrades defensive v1 input on export and handles an empty list', () => {
    const doc = buildExportDoc([{ id: 'old', name: 'Old', sql: '1', chart: CHART }], NOW);
    expect(doc.version).toBe(2);
    expect(doc.queries[0]).toEqual(v2('old', '1', { name: 'Old', favorite: false, panel: CHART }));
    expect(buildExportDoc([], NOW).queries).toEqual([]);
  });
});

describe('parseImportDoc — v1 migration', () => {
  it('upgrades supported flat entries, defaults a missing name, and skips malformed rows', () => {
    const { queries } = parseImportDoc(envelope(1, [
      { id: 's1', name: 'A', sql: 'SELECT 1', favorite: 1, extra: 'drop' },
      { sql: 'SELECT 2' },
      { name: 'bad', sql: 5 },
      null,
    ]));
    expect(queries).toEqual([
      v2('s1', 'SELECT 1', { name: 'A', favorite: true }),
      v2('legacy-2', 'SELECT 2', { name: 'Untitled', favorite: false }),
    ]);
  });

  it('preserves panel precedence, dashboard metadata, SQL-less Text, and chart compatibility input', () => {
    const { queries } = parseImportDoc(envelope(1, [
      { id: 'panel', name: 'P', sql: '1', panel: { cfg: { type: 'logs', future: [1] } }, chart: CHART,
        dashboard: { role: 'panel', layout: { x: 1 } } },
      { id: 'table', name: 'T', sql: '2', chart: CHART, view: 'table' },
      { id: 'chart', name: 'C', sql: '3', chart: CHART, view: 'chart' },
      { id: 'text', name: 'N', sql: '', panel: { cfg: { type: 'text', content: '# hi' } } },
    ]));
    expect(queries[0].spec).toEqual({ name: 'P', favorite: false,
      panel: { cfg: { type: 'logs', future: [1] } }, dashboard: { role: 'panel', layout: { x: 1 } } });
    expect(queries[1].spec.panel).toEqual({ cfg: { type: 'table', chart: { ...CHART.cfg, key: 'k' } } });
    expect(queries[1].spec.view).toBe('table');
    expect(queries[2].spec.panel).toEqual(CHART);
    expect(queries[2].spec.view).toBe('panel');
    expect(queries[3].sql).toBe('');
    expect('chart' in queries[2]).toBe(false);
  });

  it('keeps v1 optional-field behavior for malformed panel/view/description/dashboard', () => {
    const { queries } = parseImportDoc(envelope(1, [
      { name: 'A', sql: '1', panel: { cfg: 'bad' }, chart: 'bad', view: 'wat', description: 1, dashboard: [] },
      { name: 'B', sql: '2', description: '  note  ' },
    ]));
    expect(queries[0].spec).toEqual({ name: 'A', favorite: false });
    expect(queries[1].spec.description).toBe('note');
  });
});

describe('parseImportDoc — v2 validation', () => {
  it('accepts supported v2 and deep-clones unknown Spec fields', () => {
    const source = v2('s1', 'SELECT 1', { name: 'A', extension: { objects: [{ a: 1 }] } });
    const { queries } = parseImportDoc(envelope(2, [source]));
    expect(queries).toEqual([source]);
    expect(queries[0].spec.extension).not.toBe(source.spec.extension);
  });

  it('rejects malformed v2 rows with an index and reason', () => {
    const cases = [
      [null, 'queries[1] must be object'],
      [{ id: '', sql: '', specVersion: 1, spec: {} }, 'queries[1].id has an invalid string value'],
      [{ id: 'x', sql: 1, specVersion: 1, spec: {} }, 'queries[1].sql must be string'],
      [{ id: 'x', sql: '', specVersion: '1', spec: {} }, 'queries[1].specVersion must be integer'],
      [{ id: 'x', sql: '', specVersion: 2, spec: {} }, 'queries[1].specVersion uses unsupported saved-query Spec version 2'],
      [{ id: 'x', sql: '', specVersion: 1, spec: [] }, 'queries[1].spec must be object'],
    ];
    for (const [query, reason] of cases) {
      expect(() => parseImportDoc(envelope(2, [v2('ok', '', {}), query])))
        .toThrow(reason);
    }
  });

  it('rejects schema-invalid supported Specs with query identity and an exact path', () => {
    expect(() => parseImportDoc(envelope(2, [
      v2('ok', '', { panel: { cfg: { type: 'table' } } }),
      v2('latency-kpi', '', { panel: { fieldConfig: { columns: { latency: { decimals: '2' } } } } }),
    ]))).toThrow('queries[1].spec.panel.fieldConfig.columns.latency.decimals must be integer');
    expect(() => parseImportDoc(envelope(1, [
      { sql: 'SELECT 1', name: 'Legacy', chart: { cfg: { type: 'pie', x: 0, y: [1, 2] } } },
    ]))).toThrow('queries[0].spec.panel.cfg.y must contain at most 1 item');
    expect(() => parseImportDoc(envelope(1, [
      null,
      { sql: 'SELECT 1', name: 'Legacy', chart: { cfg: { type: 'pie', x: 0, y: [1, 2] } } },
    ]))).toThrow('queries[0].spec.panel.cfg.y must contain at most 1 item');
  });

  it('runs the injected feature service after structural upgrade', () => {
    const validationService = { validate: (spec) => spec.forbidden
      ? [{ path: ['forbidden'], severity: 'error', message: 'forbidden is unavailable' }]
      : [] };
    expect(() => parseImportDoc(envelope(2, [v2('feature', '', { forbidden: true })]), validationService))
      .toThrow('Query "feature": forbidden is unavailable.');
    expect(parseImportDoc(envelope(2, [v2('allowed', '', {})]), validationService).queries[0].id)
      .toBe('allowed');
  });

  it('throws clear envelope errors', () => {
    expect(() => parseImportDoc('{bad')).toThrow('Not a valid JSON file');
    expect(() => parseImportDoc('null')).toThrow('Unrecognized file format');
    expect(() => parseImportDoc(JSON.stringify({ format: 'other' }))).toThrow('Unrecognized file format');
    expect(() => parseImportDoc(envelope(0, []))).toThrow('Unsupported Library version 0');
    expect(() => parseImportDoc(envelope(3, []))).toThrow('Unsupported Library version 3');
    expect(() => parseImportDoc(JSON.stringify({ format: FORMAT, version: 2, queries: 'x' }))).toThrow('queries must be array');
    expect(() => parseImportDoc(envelope(2, Array.from({ length: 1001 }, (_, i) => v2(String(i), '', {})))))
      .toThrow('queries must contain at most 1000 items');
  });
});

describe('mergeSaved', () => {
  const generator = () => { let n = 0; return () => 'gen' + (++n); };

  it('adds, updates by id, generates unique ids, and skips complete-Spec duplicates', () => {
    const existing = [v2('s1', '1', { name: 'A', favorite: false, extension: { b: 2, a: 1 } })];
    const incoming = [
      v2('different-id', '1', { extension: { a: 1, b: 2 }, favorite: false, name: 'A' }),
      v2('s1', '1b', { name: 'A2', favorite: true, extension: { incoming: [1] } }),
      { name: 'B', sql: '2' },
      v2('s2', '3', { name: 'C', favorite: false }),
    ];
    const result = mergeSaved(existing, incoming, generator());
    expect(result).toMatchObject({ added: 2, updated: 1, skipped: 1 });
    expect(result.merged.map((q) => q.id)).toEqual(['s1', 'gen1', 's2']);
    expect(result.merged[0].spec).toEqual({ name: 'A2', favorite: true, extension: { incoming: [1] } });
    expect(existing[0].spec.name).toBe('A');
  });

  it('replaces the complete incoming Spec by id, including extension removal/addition', () => {
    const existing = [v2('s1', '1', { name: 'A', oldExtension: { keep: false } })];
    const incoming = [v2('s1', '1', { name: 'A', newExtension: { nested: [1, 2] } })];
    const result = mergeSaved(existing, incoming, () => 'unused');
    expect(result.updated).toBe(1);
    expect(result.merged[0].spec).toEqual(incoming[0].spec);
    expect(result.merged[0].spec).not.toBe(incoming[0].spec);
  });

  it('upgrades v1 input, preserves array-order semantics, and avoids duplicate incoming ids', () => {
    const existing = [v2('taken', 'x', { name: 'X', list: [1, 2] })];
    const incoming = [
      { id: 'old', name: 'Old', sql: '1', chart: CHART },
      v2('taken', 'x', { name: 'X', list: [2, 1] }),
      v2('old', '2', { name: 'Other' }),
    ];
    const result = mergeSaved(existing, incoming, generator());
    expect(result).toMatchObject({ added: 1, updated: 2, skipped: 0 });
    expect(result.merged.find((q) => q.id === 'old').sql).toBe('2');
    expect(upgradeSavedEntry({ name: 'Alias', sql: 'a' }).spec.name).toBe('Alias');
  });

  it('dedups a v1 null-key chart against its live key-less twin (no spurious duplicate)', () => {
    // Live editing stores a null schema key by OMITTING it: {cfg}. A v1 file
    // (or legacy share) carrying the same chart with an absent/null key must
    // upgrade to the same key-less shape, so a different-id import is skipped
    // as an exact duplicate rather than added as a second row.
    const live = v2('live1', 'SELECT 1', { name: 'Chart Q', favorite: false, panel: { cfg: { type: 'bar', x: 'x', y: 'y' } } });
    const v1file = { id: 'other', name: 'Chart Q', sql: 'SELECT 1', favorite: false, chart: { cfg: { type: 'bar', x: 'x', y: 'y' } } };
    const result = mergeSaved([live], [v1file], () => 'unused');
    expect(result).toMatchObject({ added: 0, updated: 0, skipped: 1 });
    expect(result.merged).toHaveLength(1);
  });
});

describe('one-way Markdown/SQL exports', () => {
  it('renders names/descriptions from Spec and protects Markdown fences', () => {
    const out = buildMarkdownDoc([
      v2('a', 'SELECT ```x```', { name: 'A\nline', description: 'does A' }),
      v2('b', 'SELECT 2', { name: 'B' }),
    ]);
    expect(out).toContain('### A line\n\ndoes A\n\n````sql');
    expect(out).toContain('SELECT ```x```\n````');
    expect(out).toContain('### B\n\n```sql\nSELECT 2\n```');
  });

  it('emits Text panel Markdown and omits an empty SQL block', () => {
    const out = buildMarkdownDoc([
      v2('note', '', { name: 'Note', panel: { cfg: { type: 'text', content: '# Hello' } } }),
      v2('both', 'SELECT 1', { name: 'Both', panel: { cfg: { type: 'text', content: 'intro' } } }),
    ]);
    expect(out).toContain('### Note\n\n# Hello');
    expect(out).not.toContain('```sql\n\n```');
    expect(out).toContain('intro\n\n```sql\nSELECT 1\n```');
  });

  it('builds a runnable SQL script, defangs comments, and skips SQL-less entries', () => {
    const out = buildSqlDoc([
      v2('a', 'SELECT 1;; ', { name: 'A */ name', description: 'does A' }),
      v2('note', '', { name: 'Note', panel: { cfg: { type: 'text', content: 'x' } } }),
      { name: 'Legacy', sql: 'SELECT 2' },
    ]);
    expect(out).toContain('/* A * / name\ndoes A */\nSELECT 1;');
    expect(out).toContain('/* Legacy */\nSELECT 2;');
    expect(out).not.toContain('Note');
    expect(out).not.toContain(';;');
  });
});
