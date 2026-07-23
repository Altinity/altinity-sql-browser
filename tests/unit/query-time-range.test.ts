import { describe, expect, it } from 'vitest';
import {
  analyzeQueryTimeRangeSql, inferQueryTimeRange, materializeQueryTimeRange,
} from '../../src/core/query-time-range.js';
import type { QuerySpecV1 } from '../../src/generated/json-schema.types.js';

describe('saved-query time-range inference', () => {
  it('distinguishes absent, explicit opt-out, and authoritative metadata', () => {
    const sql = 'SELECT {from:DateTime}, {to:DateTime}';
    expect(materializeQueryTimeRange({}, sql)).toMatchObject({
      inferred: true, spec: { timeRanges: [{ from: 'from', to: 'to' }] },
    });
    expect(materializeQueryTimeRange({ timeRanges: [] }, sql)).toEqual({ spec: { timeRanges: [] }, inferred: false, diagnostics: [] });
    const authored: QuerySpecV1 = { timeRanges: [{ from: 'lower', to: 'upper' }] };
    expect(materializeQueryTimeRange(authored, sql).spec).toBe(authored);
  });

  it.each([
    ['from', 'to'], ['from_time', 'to_time'], ['start', 'end'], ['start_time', 'end_time'],
  ])('recognizes %s/%s case-insensitively and preserves spelling', (from, to) => {
    const f = from.toUpperCase();
    const t = `${to[0].toUpperCase()}${to.slice(1)}`;
    expect(materializeQueryTimeRange({}, `SELECT {${f}:Date32}, {${t}:DateTime64(3, 'UTC')}`).spec.timeRanges)
      .toEqual([{ from: f, to: t }]);
  });

  it('does not infer start/stop, unsupported types, arrays, conflicts, or malformed date types', () => {
    expect(materializeQueryTimeRange({}, 'SELECT {start:DateTime}, {stop:DateTime}').inferred).toBe(false);
    expect(materializeQueryTimeRange({}, 'SELECT {from:String}, {to:DateTime}').inferred).toBe(false);
    expect(materializeQueryTimeRange({}, 'SELECT {from:Array(Date)}, {to:Date}').inferred).toBe(false);
    expect(materializeQueryTimeRange({}, 'SELECT {from:DateTime}, {from:Date}, {to:DateTime}').inferred).toBe(false);
    expect(materializeQueryTimeRange({}, 'SELECT {from:DateTime64(20)}, {to:DateTime}').inferred).toBe(false);
  });

  it('uses parsed declarations, ignoring comments/literals, and accepts repeated agreeing declarations', () => {
    const sql = "SELECT '{from:DateTime}', {from:DateTime}, {from:DateTime}, {to:DateTime} -- {start:Date}\n";
    expect(materializeQueryTimeRange({}, sql).spec.timeRanges).toEqual([{ from: 'from', to: 'to' }]);
  });

  it('surfaces ambiguity before type filtering and does not mutate the Spec or analysis', () => {
    const spec = { name: 'Q' };
    const analysis = analyzeQueryTimeRangeSql('SELECT {from:DateTime}, {to:DateTime}, {start:String}, {end:String}');
    const before = JSON.stringify(analysis);
    const result = inferQueryTimeRange(spec, analysis);
    expect(result.spec).toBe(spec);
    expect(result.inferred).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'time-range-inference-ambiguous' });
    expect(JSON.stringify(analysis)).toBe(before);
  });

  it('treats case-colliding declarations as ambiguous', () => {
    const result = materializeQueryTimeRange({}, 'SELECT {From:DateTime}, {from:DateTime}, {to:DateTime}');
    expect(result.inferred).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
  });

  it('fails closed when the shared analyzer reports a malformed source', () => {
    const result = materializeQueryTimeRange({}, 'SELECT {from:DateTime}, {to:DateTime} /*[ broken');
    expect(result).toMatchObject({ inferred: false, spec: {} });
  });
});
