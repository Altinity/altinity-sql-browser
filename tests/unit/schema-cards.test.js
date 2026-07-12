import { describe, it, expect } from 'vitest';
import { buildCardModel, cardSize, columnRoles, buildCardGraph, CARD } from '../../src/core/schema-cards.js';

describe('columnRoles', () => {
  it('maps every key-role flag, in display order', () => {
    expect(columnRoles({
      is_in_primary_key: 1, is_in_sorting_key: 1, is_in_partition_key: 1, is_in_sampling_key: 1,
    })).toEqual(['PK', 'SK', 'PARTITION', 'SAMPLING']);
  });
  it('returns [] when no flag is set', () => {
    expect(columnRoles({ name: 'x' })).toEqual([]);
    expect(columnRoles()).toEqual([]);
  });
  it('treats string "1" and boolean true as set (JSON vs JSONStrings formats)', () => {
    expect(columnRoles({ is_in_sorting_key: '1' })).toEqual(['SK']);
    expect(columnRoles({ is_in_primary_key: true })).toEqual(['PK']);
    expect(columnRoles({ is_in_partition_key: '0' })).toEqual([]); // string zero → not set
  });
});

describe('buildCardModel', () => {
  it('builds the engine/rows/bytes summary, top-16 columns + overflow, and a skip line', () => {
    const cols = Array.from({ length: 17 }, (_, i) => ({ name: 'c' + i, type: 'UInt64', position: i }));
    cols[0].is_in_primary_key = 1;
    const m = buildCardModel(
      { label: 'db.t', kind: 'mv' },
      { engine: 'MaterializedView', total_rows: 1500000, total_bytes: 2048 },
      cols,
      [{ name: 'idx_a', type: 'minmax' }],
    );
    expect(m.title).toBe('db.t');
    expect(m.kind).toBe('mv');
    expect(m.summary).toBe('MaterializedView · 1.5M rows · 2.0 KB');
    expect(m.cols).toHaveLength(CARD.MAX_COLS);
    expect(m.cols[0]).toEqual({ name: 'c0', type: 'UInt64', fullType: 'UInt64', roles: ['PK'] });
    expect(m.overflow).toBe(1);
    expect(m.skipLine).toBe('idx: idx_a (minmax)');
  });
  it('caps the skip-index line at MAX_IDX with a "+N more" suffix (no dedicated overflow row)', () => {
    const idx = Array.from({ length: CARD.MAX_IDX + 2 }, (_, i) => ({ name: 'idx_' + i, type: 'bloom_filter' }));
    const m = buildCardModel({ label: 'db.t', kind: 'table' }, {}, [], idx);
    const shown = idx.slice(0, CARD.MAX_IDX).map((i) => i.name + ' (bloom_filter)').join(', ');
    expect(m.skipLine).toBe('idx: ' + shown + ', +2 more');
  });
  it('does not append an overflow suffix when the index count is within MAX_IDX', () => {
    const idx = Array.from({ length: CARD.MAX_IDX }, (_, i) => ({ name: 'idx_' + i, type: 'set' }));
    const m = buildCardModel({ label: 'db.t', kind: 'table' }, {}, [], idx);
    expect(m.skipLine).not.toContain('more');
    expect(m.skipLine.match(/idx_/g)).toHaveLength(CARD.MAX_IDX);
  });
  it('degrades to a header-only card for a leaf with no row/columns/indices', () => {
    const leaf = buildCardModel({ id: 'ext:mysql', label: 'mysql', kind: 'external' });
    expect(leaf.summary).toBe('external · — rows · —'); // engine falls back to kind
    expect(leaf.cols).toEqual([]);
    expect(leaf.overflow).toBe(0);
    expect(leaf.skipLine).toBe('');
    expect(leaf.comment).toBe('');
  });
  it('trims the table comment, untruncated (it\'s a hover-only tooltip on the card, never a drawn row)', () => {
    const m = buildCardModel({ label: 'db.t' }, { comment: '  raw events, ingested by the OTel collector  ' });
    expect(m.comment).toBe('raw events, ingested by the OTel collector');
    const long = buildCardModel({ label: 'db.t' }, { comment: 'x'.repeat(200) });
    expect(long.comment).toHaveLength(200); // no cap — nothing renders it inline
  });
  it('has no comment when the table row carries none', () => {
    expect(buildCardModel({ label: 'db.t' }, {}).comment).toBe('');
    expect(buildCardModel({ label: 'db.t' }, { comment: '   ' }).comment).toBe('');
  });
  it('falls back through label → id → "" for the title, and kind → "table" for the engine', () => {
    expect(buildCardModel({ label: 'a.b' }).title).toBe('a.b');
    expect(buildCardModel({ id: 'a.b' }).title).toBe('a.b'); // no label → id
    expect(buildCardModel(null).title).toBe(''); // no node at all
    expect(buildCardModel(null).summary).toBe('table · — rows · —'); // kind → 'table'
  });
  it('compacts an over-long column type so a giant Enum can’t blow out the card width (#177)', () => {
    const enumType = "Enum8('started' = 1, 'running' = 2, 'done' = 3, 'failed' = 4)";
    const m = buildCardModel({ label: 't', kind: 'table' }, {}, [{ name: 'state', type: enumType }]);
    // Semantic compaction, not a partial-member character cut.
    expect(m.cols[0].type).toBe('Enum8(4 values)');
    expect(m.cols[0].type.length).toBeLessThanOrEqual(CARD.MAX_TYPE);
    // The full declared type always rides along for the renderer's hover title
    // (same contract as completion items — the consumer compares type vs fullType).
    expect(m.cols[0].fullType).toBe(enumType);
    // a short type is left untouched — fullType and type agree (nothing hidden)
    const short = buildCardModel({ label: 't' }, {}, [{ name: 'id', type: 'UInt64' }]);
    expect(short.cols[0].type).toBe('UInt64');
    expect(short.cols[0].fullType).toBe('UInt64');
    // the compaction bounds the card width (vs the full ~60-char enum)
    const wide = cardSize({ title: 't', summary: '', cols: [{ name: 'state', type: enumType, roles: [] }], overflow: 0, skipLine: '' });
    const clamped = cardSize(m);
    expect(clamped.w).toBeLessThan(wide.w);
  });
});

describe('cardSize', () => {
  it('height = header + one row per shown column / overflow / skip row', () => {
    const m = { title: 't', summary: 's', cols: [{ name: 'a', type: 'Int', roles: [] }], overflow: 3, skipLine: 'idx: x (set)' };
    expect(cardSize(m, { rowH: 10, headerH: 20 }).h).toBe(20 + 3 * 10); // 1 col + overflow + skip = 3 rows
  });
  it('defaults to the CARD constants, and a tiny / empty model floors to MIN_W', () => {
    expect(cardSize().h).toBe(CARD.HEADER_H); // no model → no rows
    expect(cardSize().w).toBe(CARD.MIN_W);
    expect(cardSize({ title: '', summary: '', cols: [], overflow: 0, skipLine: '' }).w).toBe(CARD.MIN_W);
  });
  it('grows with the widest line and counts role badges into the width', () => {
    const long = (roles) => ({ title: 't', summary: 's', cols: [{ name: 'x'.repeat(40), type: 'String', roles }], overflow: 0, skipLine: '' });
    expect(cardSize(long([])).w).toBeGreaterThan(CARD.MIN_W);
    expect(cardSize(long(['PK', 'SK'])).w).toBeGreaterThan(cardSize(long([])).w); // badges add width
  });
  it('honors a wide overflow / skip line in the width', () => {
    const m = { title: 't', summary: 's', cols: [], overflow: 999, skipLine: 'idx: ' + 'z'.repeat(60) + ' (minmax)' };
    expect(cardSize(m).w).toBeGreaterThan(CARD.MIN_W);
  });
  it('a comment never affects height or width — it\'s a hover-only tooltip, not a row', () => {
    const base = { title: 't', summary: 's', comment: '', cols: [], overflow: 0, skipLine: '' };
    const withComment = { ...base, comment: 'a table comment ' + 'z'.repeat(200) };
    expect(cardSize(withComment, { rowH: 10, headerH: 20 })).toEqual(cardSize(base, { rowH: 10, headerH: 20 }));
  });
});

describe('buildCardGraph', () => {
  it('attaches a card to each node, looking row/columns up by db.table id', () => {
    const graph = {
      nodes: [{ id: 'lin.a', label: 'a', kind: 'table' }, { id: 'lin.x', label: 'x', kind: 'view' }],
      edges: [{ from: 'lin.a', to: 'lin.x', kind: 'feeds' }],
    };
    const data = {
      tables: [{ database: 'lin', name: 'a', engine: 'MergeTree', total_rows: 5, total_bytes: 0 }],
      columnsByKey: { 'lin.a': [{ name: 'id', type: 'UInt64', is_in_primary_key: 1, position: 1 }] },
      skipByKey: {},
    };
    const out = buildCardGraph(graph, data);
    expect(out.nodes[0].card.summary).toMatch(/^MergeTree/);
    expect(out.nodes[0].card.cols[0].roles).toEqual(['PK']);
    // 'lin.x' has no matching table row / columns → header-only card via kind fallback
    expect(out.nodes[1].card.summary).toBe('view · — rows · —');
    expect(out.edges).toEqual(graph.edges);
  });
  it('tolerates a null graph and a missing data bag', () => {
    expect(buildCardGraph(null)).toEqual({ nodes: [], edges: [] });
    const out = buildCardGraph({ nodes: [{ id: 'a.b', label: 'b', kind: 'table' }] });
    expect(out.edges).toEqual([]);
    expect(out.nodes[0].card.summary).toBe('table · — rows · —');
  });
});
