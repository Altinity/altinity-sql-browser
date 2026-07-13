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
  it('builds the engine/rows/bytes summary, top-16 columns + overflow', () => {
    const cols = Array.from({ length: 17 }, (_, i) => ({ name: 'c' + i, type: 'UInt64', position: i }));
    cols[0].is_in_primary_key = 1;
    const m = buildCardModel(
      { label: 'db.t', kind: 'mv' },
      { engine: 'MaterializedView', total_rows: 1500000, total_bytes: 2048 },
      cols,
    );
    expect(m.title).toBe('db.t');
    expect(m.kind).toBe('mv');
    expect(m.summary).toBe('MaterializedView · 1.5M rows · 2.0 KB');
    expect(m.cols).toHaveLength(CARD.MAX_COLS);
    expect(m.cols[0]).toEqual({ name: 'c0', type: 'UInt64', fullType: 'UInt64', roles: ['PK'] });
    expect(m.overflow).toBe(1);
  });
  it('never carries a data-skipping-index line — indexes live in the detail drawer, not the card (#179)', () => {
    const cols = [{ name: 'id', type: 'UInt64', position: 1 }];
    const bare = buildCardModel({ label: 'db.t', kind: 'table' }, {}, cols);
    expect(bare.skipLine).toBeUndefined();
    // Passing legacy skip-index rows (a heavily-indexed table) is ignored: the
    // model — and therefore the card geometry — is byte-identical either way.
    const idx = Array.from({ length: 20 }, (_, i) => ({ name: 'a_very_long_skip_index_name_' + i, type: 'bloom_filter(0.01)' }));
    const withIdx = buildCardModel({ label: 'db.t', kind: 'table' }, {}, cols, idx);
    expect(withIdx.skipLine).toBeUndefined();
    expect(withIdx).toEqual(bare);
    expect(cardSize(withIdx)).toEqual(cardSize(bare));
  });
  it('degrades to a header-only card for a leaf with no row/columns', () => {
    const leaf = buildCardModel({ id: 'ext:mysql', label: 'mysql', kind: 'external' });
    expect(leaf.summary).toBe('external · — rows · —'); // engine falls back to kind
    expect(leaf.cols).toEqual([]);
    expect(leaf.overflow).toBe(0);
    expect(leaf.skipLine).toBeUndefined();
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
    const wide = cardSize({ title: 't', summary: '', cols: [{ name: 'state', type: enumType, roles: [] }], overflow: 0 });
    const clamped = cardSize(m);
    expect(clamped.w).toBeLessThan(wide.w);
  });
});

describe('cardSize', () => {
  it('height = header + one row per shown column + an overflow row (no index row — #179)', () => {
    const m = { title: 't', summary: 's', cols: [{ name: 'a', type: 'Int', roles: [] }], overflow: 3 };
    expect(cardSize(m, { rowH: 10, headerH: 20 }).h).toBe(20 + 2 * 10); // 1 col + overflow = 2 rows
  });
  it('defaults to the CARD constants, and a tiny / empty model floors to MIN_W', () => {
    expect(cardSize().h).toBe(CARD.HEADER_H); // no model → no rows
    expect(cardSize().w).toBe(CARD.MIN_W);
    expect(cardSize({ title: '', summary: '', cols: [], overflow: 0 }).w).toBe(CARD.MIN_W);
  });
  it('grows with the widest line and counts role badges into the width', () => {
    const long = (roles) => ({ title: 't', summary: 's', cols: [{ name: 'x'.repeat(40), type: 'String', roles }], overflow: 0 });
    expect(cardSize(long([])).w).toBeGreaterThan(CARD.MIN_W);
    expect(cardSize(long(['PK', 'SK'])).w).toBeGreaterThan(cardSize(long([])).w); // badges add width
  });
  it('counts the overflow row toward the width when it is the widest line', () => {
    // Force the "+N more" line to be the widest by shrinking MIN_W via a narrow
    // charW so the floor doesn't dominate — proves the overflow branch feeds maxLine.
    const base = { title: '', summary: '', cols: [], overflow: 0 };
    const withOverflow = { ...base, overflow: 999 };
    expect(cardSize(withOverflow, { charW: 100 }).w).toBeGreaterThan(cardSize(base, { charW: 100 }).w);
  });
  it('an ignored legacy skipLine field can neither add height nor width (#179)', () => {
    const base = { title: 't', summary: 's', cols: [{ name: 'a', type: 'Int', roles: [] }], overflow: 0 };
    const withSkip = { ...base, skipLine: 'idx: ' + 'z'.repeat(80) + ' (minmax)' };
    expect(cardSize(withSkip, { rowH: 10, headerH: 20 })).toEqual(cardSize(base, { rowH: 10, headerH: 20 }));
  });
  it('a comment never affects height or width — it\'s a hover-only tooltip, not a row', () => {
    const base = { title: 't', summary: 's', comment: '', cols: [], overflow: 0 };
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
