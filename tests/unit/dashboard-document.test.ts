import { describe, expect, it } from 'vitest';
import {
  dropCuratedFilters, upgradeDashboardLayout,
} from '../../src/dashboard/model/dashboard-document.js';
import type {
  DashboardDocumentV1, DashboardDocumentV2,
} from '../../src/generated/json-schema.types.js';

const tiles = [
  { id: 'a', queryId: 'qa' },
  { id: 'b', queryId: 'qb' },
];

describe('upgradeDashboardLayout', () => {
  it('preserves grafana-grid@1 placements as v2 Grid state and regenerates fallback', () => {
    const source = {
      documentVersion: 2, id: 'd', title: 'D', revision: 7, tiles,
      layout: {
        type: 'grafana-grid', version: 1,
        items: { a: { span: 4, height: 'compact' }, b: { span: 12, height: 4 } },
      },
    } as DashboardDocumentV2;
    const before = structuredClone(source);
    const result = upgradeDashboardLayout(source);
    expect(result.layout).toEqual({
      type: 'grafana-grid', version: 2, preset: 'grid',
      items: {
        a: { grid: { span: 4, height: 1 } },
        b: { grid: { span: 12, height: 4 } },
      },
      fallback: {
        type: 'flow', version: 1, preset: 'columns-2',
        items: {
          a: { span: 1, height: 'compact' },
          b: { span: 3, height: 'large' },
        },
      },
    });
    expect(source).toEqual(before);
  });

  it('converts only explicit flow Report heights and uses Report defaults otherwise', () => {
    const source = {
      documentVersion: 2, id: 'd', title: 'D', revision: 1, tiles,
      layout: {
        type: 'flow', version: 1, preset: 'report',
        items: { a: { height: 'large' }, b: {} },
      },
    } as DashboardDocumentV2;
    expect(upgradeDashboardLayout(source).layout).toEqual({
      type: 'grafana-grid', version: 2, preset: 'report',
      items: { a: { report: { height: 3 } } },
      fallback: {
        type: 'flow', version: 1, preset: 'report',
        items: {
          a: { span: 1, height: 'large' },
          b: { span: 1, height: 'large' },
        },
      },
    });
  });

  it('converts persisted flow columns to Grid with deterministic defaults', () => {
    const source = {
      documentVersion: 2, id: 'd', title: 'D', revision: 1, tiles,
      layout: {
        type: 'flow', version: 1, preset: 'columns-3',
        items: { a: { span: 2, height: 'compact' }, b: { span: 3, height: 'large' } },
      },
    } as DashboardDocumentV2;
    const result = upgradeDashboardLayout(source);
    expect(result.layout).toMatchObject({
      type: 'grafana-grid', version: 2, preset: 'grid',
      items: {
        a: { grid: { span: 6, height: 1 } },
        b: { grid: { span: 12, height: 3 } },
      },
    });
  });

  it('refreshes v2 fallbacks for each authored style and leaves unknown layouts readable', () => {
    const base = {
      documentVersion: 2, id: 'd', title: 'D', revision: 1, tiles,
      layout: {
        type: 'grafana-grid', version: 2, preset: 'full',
        items: { a: { full: { height: 4 } }, b: { report: { height: 7 } } },
      },
    } as DashboardDocumentV2;
    expect(upgradeDashboardLayout(base).layout.fallback).toEqual({
      type: 'flow', version: 1, preset: 'columns-2',
      items: {
        a: { span: 2, height: 'large' },
        b: { span: 2, height: 'medium' },
      },
    });
    const report = structuredClone(base);
    report.layout.preset = 'report';
    expect(upgradeDashboardLayout(report).layout.fallback).toEqual({
      type: 'flow', version: 1, preset: 'report',
      items: {
        a: { span: 1, height: 'large' },
        b: { span: 1, height: 'large' },
      },
    });
    const foreign = { ...base, layout: { type: 'future', version: 9 } } as unknown as DashboardDocumentV2;
    expect(upgradeDashboardLayout(foreign)).toEqual(foreign);
  });
});

describe('dropCuratedFilters', () => {
  it('drops filters while applying the same deterministic layout upgrade', () => {
    const source = {
      documentVersion: 1, id: 'd', title: 'D', revision: 1, tiles,
      filters: [{ id: 'country', parameter: 'country' }],
      layout: { type: 'flow', version: 1, preset: 'columns-2', items: {} },
    } as DashboardDocumentV1;
    const result = dropCuratedFilters(source);
    expect(result.documentVersion).toBe(2);
    expect(result).not.toHaveProperty('filters');
    expect(result.layout).toMatchObject({ type: 'grafana-grid', version: 2, preset: 'grid' });
  });
});
