import { describe, it, expect } from 'vitest';
import {
  buildExportDoc, parseImportDoc, mergeSaved, buildMarkdownDoc, buildSqlDoc,
  upgradeSavedEntry, withChartMirror,
} from '../../src/core/saved-io.js';

const CHART = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'k' };

describe('upgradeSavedEntry', () => {
  it('upgrades a bare legacy chart to a chart-family panel, keeping the chart as the mirror', () => {
    const src = { id: 's1', name: 'A', sql: '1', chart: CHART };
    const up = upgradeSavedEntry(src);
    expect(up.panel).toEqual({ cfg: CHART.cfg, key: 'k' });
    expect(up.chart).toEqual(CHART); // dual-write mirror stays
    expect(src.panel).toBeUndefined(); // input not mutated
  });
  it("view:'table' + latent chart migrates losslessly: table panel with the chart roles stashed", () => {
    const up = upgradeSavedEntry({ name: 'A', sql: '1', chart: CHART, view: 'table' });
    // The stash is nested (NOT spread — a flat spread would collide on `type`),
    // riding through the table arm as an unknown, preserved field (#166 Q6).
    expect(up.panel).toEqual({ cfg: { type: 'table', chart: { ...CHART.cfg, key: 'k' } } });
    expect(up.view).toBe('table');
    expect('chart' in up).toBe(false); // no mirror for a non-chart panel
  });
  it("maps the remembered view 'chart' → 'panel' (drawer tab rename)", () => {
    expect(upgradeSavedEntry({ name: 'A', sql: '1', view: 'chart' }).view).toBe('panel');
    expect(upgradeSavedEntry({ name: 'A', sql: '1', view: 'json' }).view).toBe('json');
  });
  it('is idempotent: an already-upgraded entry passes through unchanged', () => {
    const entry = { name: 'A', sql: '1', panel: { cfg: { type: 'logs' } }, chart: CHART };
    const up = upgradeSavedEntry(entry);
    expect(up.panel).toEqual({ cfg: { type: 'logs' } }); // panel wins over the stale mirror
    expect(upgradeSavedEntry(up)).toEqual(up);
  });
  it('leaves an entry with neither chart nor panel untouched (plus a malformed chart)', () => {
    expect(upgradeSavedEntry({ name: 'A', sql: '1' }).panel).toBeUndefined();
    expect(upgradeSavedEntry({ name: 'A', sql: '1', chart: 'nope' }).panel).toBeUndefined();
  });
});

describe('withChartMirror', () => {
  it('derives the legacy chart mirror from a chart-family panel; deletes it otherwise', () => {
    const e = { panel: { cfg: { type: 'line', x: 0, y: [1], series: null }, key: 'k' } };
    withChartMirror(e);
    expect(e.chart).toEqual({ cfg: e.panel.cfg, key: 'k' });
    e.panel = { cfg: { type: 'text', content: 'x' } };
    withChartMirror(e);
    expect('chart' in e).toBe(false); // leaving the family deletes the stale mirror
    delete e.panel;
    withChartMirror({ ...e, chart: CHART });
    expect(withChartMirror({ chart: CHART }).chart).toBeUndefined(); // no panel → no mirror
  });
});

describe('buildExportDoc', () => {
  it('wraps queries in the envelope, keeps only id/name/sql/favorite, coerces favorite', () => {
    const doc = buildExportDoc([{ id: 's1', name: 'A', sql: 'SELECT 1', favorite: 1, extra: 'x' }], '2026-06-21T00:00:00.000Z');
    expect(doc).toEqual({
      format: 'altinity-sql-browser/saved-queries',
      version: 1,
      exportedAt: '2026-06-21T00:00:00.000Z',
      queries: [{ id: 's1', name: 'A', sql: 'SELECT 1', favorite: true }],
    });
  });
  it('handles an empty list', () => {
    expect(buildExportDoc([], 'T').queries).toEqual([]);
  });
  it('upgrades a legacy chart entry on export: panel + chart mirror + view mapped (version stays 1)', () => {
    const doc = buildExportDoc([
      { id: 's1', name: 'A', sql: '1', favorite: false, chart: CHART, view: 'chart' },
      { id: 's2', name: 'B', sql: '2', favorite: false, view: 'bogus' }, // invalid view dropped
      { id: 's3', name: 'C', sql: '3', favorite: false },
    ], 'T');
    expect(doc.version).toBe(1); // additive change — bumping would break older builds
    expect(doc.queries[0].panel).toEqual({ cfg: CHART.cfg, key: 'k' });
    expect(doc.queries[0].chart).toEqual(CHART); // dual-write mirror in the file
    expect(doc.queries[0].view).toBe('panel');
    expect('view' in doc.queries[1]).toBe(false);
    expect('chart' in doc.queries[2]).toBe(false);
    expect('panel' in doc.queries[2]).toBe(false);
    expect('view' in doc.queries[2]).toBe(false);
  });
  it('a non-chart panel exports without a chart mirror', () => {
    const doc = buildExportDoc([
      { id: 's1', name: 'N', sql: '', favorite: false, panel: { cfg: { type: 'text', content: 'hi' } } },
    ], 'T');
    expect(doc.queries[0].panel).toEqual({ cfg: { type: 'text', content: 'hi' } });
    expect('chart' in doc.queries[0]).toBe(false);
    expect(doc.queries[0].sql).toBe(''); // text panels legitimately carry no SQL
  });
  it('carries a description when present, omits it when absent', () => {
    const doc = buildExportDoc([
      { id: 's1', name: 'A', sql: '1', favorite: false, description: 'note' },
      { id: 's2', name: 'B', sql: '2', favorite: false },
    ], 'T');
    expect(doc.queries[0].description).toBe('note');
    expect('description' in doc.queries[1]).toBe(false);
  });
});

describe('parseImportDoc', () => {
  const env = (over) => JSON.stringify({ format: 'altinity-sql-browser/saved-queries', version: 1, queries: [], ...over });
  it('parses a valid doc and normalizes entries (drops invalid ones)', () => {
    const { queries } = parseImportDoc(env({ queries: [
      { id: 's1', name: 'A', sql: 'SELECT 1', favorite: 1 },
      { name: 'B', sql: 'SELECT 2' },        // no id → id undefined
      { name: 'bad', sql: 5 },               // non-string sql → dropped
      { sql: 'no name' },                    // no name → dropped
    ] }));
    expect(queries).toEqual([
      expect.objectContaining({ id: 's1', name: 'A', sql: 'SELECT 1', favorite: true }),
      expect.objectContaining({ id: undefined, name: 'B', sql: 'SELECT 2', favorite: false }),
    ]);
  });
  it('upgrades a legacy chart payload to a panel and drops a malformed one', () => {
    const chart = { cfg: { type: 'bar', x: 0, y: [1], series: null }, key: 'k' };
    const { queries } = parseImportDoc(env({ queries: [
      { name: 'A', sql: '1', chart },
      { name: 'B', sql: '2', chart: { nope: true } }, // no cfg → dropped
      { name: 'C', sql: '3', chart: 'x' },            // non-object → dropped
    ] }));
    expect(queries[0].panel).toEqual({ cfg: chart.cfg, key: 'k' });
    expect(queries[0].chart).toEqual(chart); // mirror kept
    expect(queries[1].panel).toBeUndefined();
    expect(queries[2].panel).toBeUndefined();
  });
  it('accepts a panel-format entry, preserving unknown types and extra cfg fields', () => {
    const { queries } = parseImportDoc(env({ queries: [
      { name: 'L', sql: '1', panel: { cfg: { type: 'logs', msg: 'body' } }, view: 'panel' },
      { name: 'T', sql: '', panel: { cfg: { type: 'text', content: '# n' } } }, // sql '' allowed
      { name: 'G', sql: '2', panel: { cfg: { type: 'gauge', max: 9 } } },       // unknown type preserved
      { name: 'X', sql: '3', panel: { cfg: 'nope' } },                          // malformed → dropped
    ] }));
    expect(queries[0].panel).toEqual({ cfg: { type: 'logs', msg: 'body' } });
    expect(queries[0].view).toBe('panel');
    expect(queries[1].sql).toBe('');
    expect(queries[2].panel).toEqual({ cfg: { type: 'gauge', max: 9 } }); // nothing silently stripped
    expect(queries[3].panel).toBeUndefined();
  });
  it("keeps a known view (mapping legacy 'chart' → 'panel' AFTER cleaning) and drops an unknown one", () => {
    const { queries } = parseImportDoc(env({ queries: [
      { name: 'A', sql: '1', view: 'json' },
      { name: 'B', sql: '2', view: 'wat' },  // not a known view → dropped
      { name: 'C', sql: '3', view: 'chart' }, // legacy → mapped, NOT dropped (order matters)
    ] }));
    expect(queries[0].view).toBe('json');
    expect(queries[1].view).toBeUndefined();
    expect(queries[2].view).toBe('panel');
  });
  it('trims a string description, dropping a whitespace-only or non-string one', () => {
    const { queries } = parseImportDoc(env({ queries: [
      { name: 'A', sql: '1', description: '  a note  ' }, // trimmed
      { name: 'B', sql: '2', description: 123 },          // non-string → dropped
      { name: 'C', sql: '3', description: '   ' },        // whitespace-only → dropped (#1 review)
    ] }));
    expect(queries[0].description).toBe('a note');
    expect(queries[1].description).toBeUndefined();
    expect(queries[2].description).toBeUndefined();
  });
  it('throws a user message for each invalid envelope', () => {
    expect(() => parseImportDoc('{not json')).toThrow('Not a valid JSON file');
    expect(() => parseImportDoc(JSON.stringify({ format: 'other' }))).toThrow('Unrecognized file format');
    expect(() => parseImportDoc(env({ version: 2 }))).toThrow('Unsupported file version');
    expect(() => parseImportDoc(env({ version: 'x' }))).toThrow('Unsupported file version');
    expect(() => parseImportDoc(env({ queries: 'nope' }))).toThrow('No queries in file');
    expect(() => parseImportDoc(env({ queries: Array.from({ length: 1001 }, () => ({ name: 'n', sql: 's' })) }))).toThrow('Too many queries');
    expect(() => parseImportDoc('null')).toThrow('Unrecognized file format'); // doc falsy
  });
});

describe('mergeSaved', () => {
  const gen = (() => { let n = 0; return () => 'gen' + (++n); });
  it('adds new, skips content dup, updates by id, generates id when missing', () => {
    const existing = [{ id: 's1', name: 'A', sql: '1', favorite: false }];
    const incoming = [
      { id: 's1', name: 'A', sql: '1', favorite: false }, // identical → skip (content)
      { id: 's1', name: 'A2', sql: '1b', favorite: true }, // same id, differs → update
      { name: 'B', sql: '2', favorite: false },            // no id → genId, add
      { id: 's2', name: 'C', sql: '3', favorite: false },  // new id → add (keeps id)
    ];
    const r = mergeSaved(existing, incoming, gen());
    expect(r).toMatchObject({ skipped: 1, updated: 1, added: 2 });
    expect(r.merged.find((q) => q.id === 's1')).toMatchObject({ name: 'A2', sql: '1b', favorite: true });
    expect(r.merged.find((q) => q.name === 'B').id).toBe('gen1'); // genId for the id-less entry
    expect(r.merged.find((q) => q.name === 'C').id).toBe('s2');   // given id kept
    expect(r.merged.map((q) => q.name)).toEqual(['A2', 'B', 'C']);
    expect(existing[0]).toEqual({ id: 's1', name: 'A', sql: '1', favorite: false }); // not mutated
  });
  it('upgrades incoming legacy charts; by-id updates rewrite panel AND mirror together (no drift)', () => {
    const chart2 = { cfg: { type: 'line', x: 0, y: [1], series: null }, key: 'k' };
    const existing = [
      { id: 's1', name: 'A', sql: '1', favorite: false, panel: { cfg: CHART.cfg, key: 'k' }, chart: CHART },
      { id: 's2', name: 'B', sql: '2', favorite: false, panel: { cfg: CHART.cfg, key: 'k' }, chart: CHART },
      { id: 's3', name: 'D', sql: '4', favorite: false, panel: { cfg: CHART.cfg, key: 'k' }, chart: CHART },
    ];
    const incoming = [
      { id: 's1', name: 'A2', sql: '1b', favorite: false },                              // no panel → both dropped
      { id: 's2', name: 'B2', sql: '2b', favorite: false, chart: chart2, view: 'json' }, // legacy → upgraded, replaces
      { id: 's3', name: 'D2', sql: '4b', favorite: false, panel: { cfg: { type: 'logs' } } }, // non-chart → mirror deleted
      { name: 'C', sql: '3', favorite: false, chart: CHART, view: 'chart' },             // add with legacy chart
    ];
    const r = mergeSaved(existing, incoming, () => 'g');
    const s1 = r.merged.find((q) => q.id === 's1');
    expect(s1.panel).toBeUndefined();
    expect(s1.chart).toBeUndefined(); // stale mirror can't linger
    expect(s1.view).toBeUndefined();
    const s2 = r.merged.find((q) => q.id === 's2');
    expect(s2.panel).toEqual({ cfg: chart2.cfg, key: 'k' });
    expect(s2.chart).toEqual(chart2);
    expect(s2.view).toBe('json');
    const s3 = r.merged.find((q) => q.id === 's3');
    expect(s3.panel).toEqual({ cfg: { type: 'logs' } });
    expect(s3.chart).toBeUndefined(); // incoming non-chart panel deletes the old mirror
    const c = r.merged.find((q) => q.name === 'C');
    expect(c.panel).toEqual({ cfg: CHART.cfg, key: 'k' });
    expect(c.chart).toEqual({ cfg: CHART.cfg, key: 'k' });
    expect(c.view).toBe('panel'); // legacy 'chart' view mapped
  });
  it('treats panel config as content and updates same-id text/chart edits even when name+sql are unchanged', () => {
    const existing = [{
      id: 'note', name: 'Note', sql: '', favorite: true,
      panel: { cfg: { type: 'text', content: 'old' } }, view: 'panel',
    }];
    const changed = [{
      id: 'note', name: 'Note', sql: '', favorite: true,
      panel: { cfg: { type: 'text', content: 'new' } }, view: 'panel',
    }];
    const r = mergeSaved(existing, changed, () => 'unused');
    expect(r).toMatchObject({ updated: 1, skipped: 0, added: 0 });
    expect(r.merged[0].panel.cfg.content).toBe('new');
    expect(existing[0].panel.cfg.content).toBe('old');
  });
  it('carries description on add, replaces it by id, and drops it when an update omits it', () => {
    const existing = [
      { id: 's1', name: 'A', sql: '1', favorite: false, description: 'old' },
      { id: 's2', name: 'B', sql: '2', favorite: false, description: 'old2' },
    ];
    const incoming = [
      { id: 's1', name: 'A2', sql: '1b', favorite: false },                       // no description → drop
      { id: 's2', name: 'B2', sql: '2b', favorite: false, description: 'new' },    // replace
      { name: 'C', sql: '3', favorite: false, description: 'added' },              // add with description
    ];
    const r = mergeSaved(existing, incoming, () => 'g');
    expect('description' in r.merged.find((q) => q.id === 's1')).toBe(false);
    expect(r.merged.find((q) => q.id === 's2').description).toBe('new');
    expect(r.merged.find((q) => q.name === 'C').description).toBe('added');
  });
});

describe('buildMarkdownDoc', () => {
  it('renders a ### heading, an optional description paragraph, and a fenced sql block', () => {
    const md = buildMarkdownDoc([
      { name: 'A', sql: 'SELECT 1', description: 'does A' },
      { name: 'B', sql: 'SELECT 2' },
    ]);
    expect(md).toContain('### A');
    expect(md).toContain('does A');
    expect(md).toContain('```sql\nSELECT 1\n```');
    expect(md).toMatch(/### B\n\n```sql/); // B has no description paragraph
  });
  it('widens the fence to four backticks when the sql contains a triple backtick', () => {
    const md = buildMarkdownDoc([{ name: 'C', sql: 'SELECT ```x```' }]);
    expect(md).toContain('````sql\n');
    expect(md).toContain('\n````');
  });
  it('a text panel emits its content as the body; the sql block only when SQL exists (#166)', () => {
    const md = buildMarkdownDoc([
      { name: 'Note', sql: '', panel: { cfg: { type: 'text', content: '# Hello\n\nworld' } } },
      { name: 'Both', sql: 'SELECT 1', panel: { cfg: { type: 'text', content: 'intro' } } },
    ]);
    expect(md).toContain('### Note\n\n# Hello\n\nworld');
    expect(md).not.toContain('```sql\n\n```'); // no empty fenced block
    expect(md).toContain('intro\n\n```sql\nSELECT 1\n```'); // content + real SQL both emitted
  });
});

describe('buildSqlDoc', () => {
  it('renders a /* name + description */ comment then the statement, ;-terminated (trailing ; trimmed)', () => {
    const out = buildSqlDoc([
      { name: 'A', sql: 'SELECT 1;;  ', description: 'does A' },
      { name: 'B', sql: 'SELECT 2' },
    ]);
    expect(out).toContain('/* A\ndoes A */\nSELECT 1;');
    expect(out).toContain('/* B */\nSELECT 2;');
    expect(out).not.toContain(';;');
  });
  it('defangs a */ sequence inside the comment so the block cannot close early', () => {
    const out = buildSqlDoc([{ name: 'edge */ name', sql: 'SELECT 1' }]);
    expect(out).toContain('/* edge * / name */');
  });
  it('skips sql-less entries (text panels) — no bare `;` in the runnable batch (#166)', () => {
    const out = buildSqlDoc([
      { name: 'Note', sql: '', panel: { cfg: { type: 'text', content: 'x' } } },
      { name: 'B', sql: 'SELECT 2' },
    ]);
    expect(out).not.toContain('Note');
    expect(out).toContain('/* B */\nSELECT 2;');
  });
});
