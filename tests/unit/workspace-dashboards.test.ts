import { describe, expect, it } from 'vitest';
import {
  findDashboard, findDashboardStrict, renameDashboard, replaceDashboard, resolveCompatibilityDashboard,
  withCompatibilityDashboard, withVariableConfig,
} from '../../src/workspace/workspace-dashboards.js';
import type { DashboardDocumentV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const dash = (id: string, over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id, title: id.toUpperCase(), revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [], ...over,
});
const ws = (dashboards: DashboardDocumentV2[]): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards,
});

describe('resolveCompatibilityDashboard', () => {
  it('resolves nothing, the sole entry, or the FIRST of several', () => {
    expect(resolveCompatibilityDashboard(ws([]))).toEqual({ selectedId: null, dashboard: null });

    const only = dash('d1');
    expect(resolveCompatibilityDashboard(ws([only]))).toEqual({ selectedId: 'd1', dashboard: only });

    // Several Dashboards: the current UI deterministically shows the first.
    const first = dash('exec');
    const second = dash('sales');
    expect(resolveCompatibilityDashboard(ws([first, second])))
      .toEqual({ selectedId: 'exec', dashboard: first });
    // …and the resolution follows ARRAY ORDER, not id ordering.
    expect(resolveCompatibilityDashboard(ws([second, first])).selectedId).toBe('sales');
  });

  it('accepts any workspace-shaped value carrying a Dashboard collection', () => {
    expect(resolveCompatibilityDashboard({ dashboards: [dash('d1')] }).selectedId).toBe('d1');
  });
});

describe('findDashboard', () => {
  it('resolves by stable id independent of position, and reports absence', () => {
    const workspace = ws([dash('a'), dash('b')]);
    expect(findDashboard(workspace, 'b')!.id).toBe('b');
    expect(findDashboard(workspace, 'gone')).toBeNull();
    expect(findDashboard(ws([]), 'a')).toBeNull();
  });
});

describe('findDashboardStrict', () => {
  it('resolves a unique id, independent of position', () => {
    const workspace = ws([dash('a'), dash('b')]);
    expect(findDashboardStrict(workspace, 'b'))
      .toEqual({ status: 'ok', dashboard: workspace.dashboards[1] });
  });

  it('separates a deleted entry from an ambiguous one', () => {
    expect(findDashboardStrict(ws([dash('a')]), 'gone')).toEqual({ status: 'missing' });
    expect(findDashboardStrict(ws([]), 'a')).toEqual({ status: 'missing' });
    expect(findDashboardStrict(ws([dash('a'), dash('a')]), 'a')).toEqual({ status: 'duplicate' });
  });

  it('accepts any workspace-shaped value carrying a Dashboard collection', () => {
    expect(findDashboardStrict({ dashboards: [dash('d1')] }, 'd1').status).toBe('ok');
  });
});

describe('replaceDashboard', () => {
  it('replaces exactly one entry and preserves every other, in order', () => {
    const workspace = ws([dash('a'), dash('b'), dash('c')]);
    const next = replaceDashboard(workspace, 'b', dash('b', { revision: 9, title: 'B2' }))!;
    expect(next.dashboards.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(next.dashboards[1].revision).toBe(9);
    // The untargeted entries come through byte-identical, revisions included.
    expect(next.dashboards[0]).toBe(workspace.dashboards[0]);
    expect(next.dashboards[2]).toBe(workspace.dashboards[2]);
    // The envelope is preserved and the input is never mutated.
    expect(next.id).toBe('w1');
    expect(workspace.dashboards[1].revision).toBe(1);
  });

  it('replaces under a DIFFERENT document id when addressed by the old one', () => {
    const next = replaceDashboard(ws([dash('a'), dash('b')]), 'a', dash('imported'))!;
    expect(next.dashboards.map((d) => d.id)).toEqual(['imported', 'b']);
  });

  it('fails — committing nothing — when the id is missing or ambiguous', () => {
    expect(replaceDashboard(ws([dash('a')]), 'gone', dash('gone'))).toBeNull();
    expect(replaceDashboard(ws([]), 'a', dash('a'))).toBeNull();
    // A duplicate-id workspace must never be "repaired" by an ambiguous write.
    expect(replaceDashboard(ws([dash('a'), dash('a')]), 'a', dash('a'))).toBeNull();
  });
});

describe('withCompatibilityDashboard', () => {
  it('appends into an empty collection', () => {
    expect(withCompatibilityDashboard(ws([]), dash('d1')).dashboards.map((d) => d.id)).toEqual(['d1']);
  });

  it('replaces the compatibility SLOT and preserves every later Dashboard', () => {
    const workspace = ws([dash('a'), dash('b'), dash('c')]);
    const next = withCompatibilityDashboard(workspace, dash('imported'));
    expect(next.dashboards.map((d) => d.id)).toEqual(['imported', 'b', 'c']);
    expect(next.dashboards[1]).toBe(workspace.dashboards[1]);
    expect(next.dashboards[2]).toBe(workspace.dashboards[2]);
  });

  it('drops ONLY the compatibility entry for a null document', () => {
    // The reachable case: there was no Dashboard, and there still is none.
    expect(withCompatibilityDashboard(ws([]), null).dashboards).toEqual([]);
    // Explicitly clearing the visible Dashboard never touches the others.
    expect(withCompatibilityDashboard(ws([dash('a'), dash('b')]), null).dashboards.map((d) => d.id))
      .toEqual(['b']);
  });

  it('never mutates its input', () => {
    const workspace = ws([dash('a')]);
    withCompatibilityDashboard(workspace, dash('b'));
    expect(workspace.dashboards.map((d) => d.id)).toEqual(['a']);
  });
});

// #457 — the pure half of committing one variable's option SQL. It moved here from
// the deleted variable-SQL drawer (`ui/variable-editor.ts`) because it is exactly
// the same kind of id-addressed, exactly-one-match Dashboard write the functions
// above are, and it must never depend on a UI surface to be correct.
describe('withVariableConfig', () => {
  const configured = (over: Partial<DashboardDocumentV2> = {}): StoredWorkspaceV5 =>
    ws([dash('sales', { variableConfigs: { zone: { sql: 'SELECT z, z FROM zones' } }, ...over }), dash('ops')]);

  it('stores a configuration under the exact name, bumping only that Dashboard', () => {
    const workspace = configured();
    const next = withVariableConfig(workspace, 'sales', 'country', { sql: 'SELECT c, c FROM t' })!;
    expect(next.dashboards[0].variableConfigs).toEqual({
      zone: { sql: 'SELECT z, z FROM zones' },
      country: { sql: 'SELECT c, c FROM t' },
    });
    expect(next.dashboards[0].revision).toBe(2);
    // Every other Dashboard is untouched, by identity — not merely by value.
    expect(next.dashboards[1]).toBe(workspace.dashboards[1]);
  });

  it('records lastKnownType alongside the SQL when the caller has one', () => {
    const next = withVariableConfig(ws([dash('sales')]), 'sales', 'zone',
      { sql: 'SELECT z, z FROM zones', lastKnownType: 'String' })!;
    expect(next.dashboards[0].variableConfigs!.zone)
      .toEqual({ sql: 'SELECT z, z FROM zones', lastKnownType: 'String' });
  });

  it('replaces an existing configuration for the same name rather than merging it', () => {
    const next = withVariableConfig(
      ws([dash('sales', { variableConfigs: { zone: { sql: 'OLD', lastKnownType: 'String' } } })]),
      'sales', 'zone', { sql: 'NEW' },
    )!;
    // `lastKnownType` is NOT carried over: the caller decides the whole record.
    expect(next.dashboards[0].variableConfigs!.zone).toEqual({ sql: 'NEW' });
  });

  it('removes the key entirely for a null config', () => {
    const next = withVariableConfig(
      ws([dash('sales', { variableConfigs: { zone: { sql: 'Z' }, country: { sql: 'C' } } })]),
      'sales', 'zone', null,
    )!;
    expect(next.dashboards[0].variableConfigs).toEqual({ country: { sql: 'C' } });
  });

  it('drops variableConfigs altogether once it would be empty', () => {
    // A Dashboard that configured and then removed a variable must be
    // byte-identical to one that never configured one.
    const next = withVariableConfig(configured(), 'sales', 'zone', null)!;
    expect('variableConfigs' in next.dashboards[0]).toBe(false);
  });

  it('starts a variableConfigs map for a Dashboard that has none', () => {
    const next = withVariableConfig(ws([dash('sales')]), 'sales', 'zone', { sql: 'Z' })!;
    expect(next.dashboards[0].variableConfigs).toEqual({ zone: { sql: 'Z' } });
  });

  it('commits NOTHING for an id that names no Dashboard', () => {
    expect(withVariableConfig(configured(), 'gone', 'zone', { sql: 'Z' })).toBeNull();
  });

  it('commits NOTHING for an AMBIGUOUS id rather than picking one', () => {
    // `findDashboard` happily answers the first match; the write must not.
    // Overwriting one of two identical ids by a guess is unrecoverable.
    expect(withVariableConfig(ws([dash('dup'), dash('dup')]), 'dup', 'zone', { sql: 'Z' })).toBeNull();
  });

  it('never mutates its input, including the Dashboard it rewrites', () => {
    const workspace = configured();
    withVariableConfig(workspace, 'sales', 'country', { sql: 'C' });
    expect(workspace.dashboards[0].variableConfigs).toEqual({ zone: { sql: 'SELECT z, z FROM zones' } });
    expect(workspace.dashboards[0].revision).toBe(1);
  });

  it('touches no panel query — a variable name and type live in the panel SQL', () => {
    const workspace = ws([dash('sales', { tiles: [{ id: 't1', queryId: 'q1' }] })]);
    const next = withVariableConfig(workspace, 'sales', 'zone', { sql: 'Z' })!;
    expect(next.queries).toBe(workspace.queries);
    expect(next.dashboards[0].tiles).toEqual(workspace.dashboards[0].tiles);
  });
});

// #429 phase 3 — the pure half of the Dashboard-row rename pencil. Modeled on
// `withVariableConfig` above: find → build the next document → delegate the
// write to `replaceDashboard`.
describe('renameDashboard', () => {
  it('renames the title and bumps only that Dashboard\'s revision', () => {
    const workspace = ws([dash('sales'), dash('ops')]);
    const next = renameDashboard(workspace, 'sales', 'Sales revenue')!;
    expect(next.dashboards[0].title).toBe('Sales revenue');
    expect(next.dashboards[0].revision).toBe(2);
    // Every other Dashboard is untouched, by identity.
    expect(next.dashboards[1]).toBe(workspace.dashboards[1]);
  });

  it('sets a description when one is given', () => {
    const next = renameDashboard(ws([dash('sales')]), 'sales', 'Sales', 'Quarterly revenue')!;
    expect(next.dashboards[0].description).toBe('Quarterly revenue');
  });

  it('replaces an existing description rather than merging it', () => {
    const next = renameDashboard(
      ws([dash('sales', { description: 'Old note' })]), 'sales', 'Sales', 'New note',
    )!;
    expect(next.dashboards[0].description).toBe('New note');
  });

  it('omits description entirely when given an empty/whitespace-only string', () => {
    const next = renameDashboard(
      ws([dash('sales', { description: 'Old note' })]), 'sales', 'Sales', '   ',
    )!;
    expect('description' in next.dashboards[0]).toBe(false);
  });

  it('leaves an existing description untouched when none is given', () => {
    const next = renameDashboard(ws([dash('sales', { description: 'Kept' })]), 'sales', 'Sales')!;
    expect(next.dashboards[0].description).toBe('Kept');
  });

  it('trims the title before storing it', () => {
    const next = renameDashboard(ws([dash('sales')]), 'sales', '  Sales revenue  ')!;
    expect(next.dashboards[0].title).toBe('Sales revenue');
  });

  it('trims a leading/trailing-whitespace description too', () => {
    const next = renameDashboard(ws([dash('sales')]), 'sales', 'Sales', '  note  ')!;
    expect(next.dashboards[0].description).toBe('note');
  });

  it('REFUSES a whitespace-only title — the same "blank means blank" rule as the read side', () => {
    const workspace = ws([dash('sales')]);
    expect(renameDashboard(workspace, 'sales', '   ')).toBeNull();
    expect(renameDashboard(workspace, 'sales', '')).toBeNull();
    // Nothing committed: the stored title is untouched.
    expect(workspace.dashboards[0].title).toBe('SALES');
  });

  it('commits NOTHING for an id that names no Dashboard', () => {
    expect(renameDashboard(ws([dash('sales')]), 'gone', 'New title')).toBeNull();
  });

  it('commits NOTHING for an AMBIGUOUS id rather than picking one', () => {
    expect(renameDashboard(ws([dash('dup'), dash('dup')]), 'dup', 'New title')).toBeNull();
  });

  it('preserves layout, tiles, variableConfigs and unknown fields', () => {
    const workspace = ws([dash('sales', {
      tiles: [{ id: 't1', queryId: 'q1' }],
      variableConfigs: { zone: { sql: 'Z' } },
    })]);
    const next = renameDashboard(workspace, 'sales', 'Renamed')!;
    expect(next.dashboards[0].tiles).toEqual(workspace.dashboards[0].tiles);
    expect(next.dashboards[0].variableConfigs).toEqual(workspace.dashboards[0].variableConfigs);
    expect(next.dashboards[0].layout).toEqual(workspace.dashboards[0].layout);
    expect(next.dashboards[0].id).toBe('sales');
  });

  it('never mutates its input', () => {
    const workspace = ws([dash('sales')]);
    renameDashboard(workspace, 'sales', 'Renamed');
    expect(workspace.dashboards[0].title).toBe('SALES');
    expect(workspace.dashboards[0].revision).toBe(1);
  });
});
