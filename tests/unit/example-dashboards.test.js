import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadEntry, loadExampleDashboards, loadManifest,
} from '../../build/compile-example-dashboards.mjs';
import { EXAMPLE_DASHBOARDS } from '../../src/generated/example-dashboards.js';
import { decodePortableBundleJson } from '../../src/dashboard/model/portable-bundle-codec.js';

// #506: the checked-in manifest (`examples/dashboard-manifest.json`) is the
// maintained source of truth; the generated `EXAMPLE_DASHBOARDS` array is what
// the running app actually imports. These two must never drift — a stale
// generated artifact is caught by `npm run check:examples` (wired into
// `pretest`), and this suite covers the layer that check can't: does every
// entry actually decode as a real, importable Dashboard?

describe('example-dashboard catalogue — manifest + generated artifact agree', () => {
  it('the generated artifact has one entry per manifest entry, same order, same file/name', async () => {
    const manifest = await loadManifest();
    expect(EXAMPLE_DASHBOARDS.map((e) => [e.file, e.name])).toEqual(manifest.map((e) => [e.file, e.name]));
  });

  it('ships exactly the three flagship examples the issue names, in order', async () => {
    expect(EXAMPLE_DASHBOARDS.map((e) => e.file)).toEqual([
      'clickhouse-operations.json', 'shop-charts.json', 'ontime-charts.json',
    ]);
    expect(EXAMPLE_DASHBOARDS.map((e) => e.name)).toEqual([
      'ClickHouse Operations', 'Shop Charts', 'OnTime Charts',
    ]);
  });

  // The UI must show the manifest's stored name, never the bundle's own
  // `metadata.name` or a name derived from the filename — this is the specific
  // case the issue calls out ("Shop Charts" the manifest's name, versus "Shop
  // analytics", the bundle's own metadata.name).
  it('the stored manifest name can differ from the bundle document\'s own metadata.name', () => {
    const shop = EXAMPLE_DASHBOARDS.find((e) => e.file === 'shop-charts.json');
    const decoded = decodePortableBundleJson(shop.json);
    expect(decoded.ok).toBe(true);
    expect(decoded.value.metadata?.name).not.toBe(shop.name);
    expect(shop.name).toBe('Shop Charts');
  });
});

describe('example-dashboard catalogue — every embedded example is a real, importable Dashboard', () => {
  it.each(EXAMPLE_DASHBOARDS.map((e) => [e.file, e]))('%s decodes as a valid portable bundle with exactly one Dashboard', (_file, entry) => {
    const decoded = decodePortableBundleJson(entry.json);
    expect(decoded.ok).toBe(true);
    expect(decoded.value.dashboards).toHaveLength(1);
    expect(decoded.value.dashboards[0].tiles.length).toBeGreaterThan(0);
  });
});

describe('compile-example-dashboards — manifest/example validation', () => {
  async function tempManifest(content) {
    const dir = await mkdtemp(join(tmpdir(), 'asb-examples-'));
    const path = join(dir, 'manifest.json');
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
    return { dir, path };
  }

  it('rejects malformed manifest JSON', async () => {
    const { path } = await tempManifest('not json');
    await expect(loadManifest(path)).rejects.toThrow('malformed manifest JSON');
  });

  it('rejects a manifest that is not a non-empty array', async () => {
    const { path: emptyPath } = await tempManifest([]);
    await expect(loadManifest(emptyPath)).rejects.toThrow('non-empty array');
    const { path: objPath } = await tempManifest({ file: 'a.json', name: 'A' });
    await expect(loadManifest(objPath)).rejects.toThrow('non-empty array');
  });

  it('rejects an entry missing file/name, with unknown keys, or a duplicate file', async () => {
    const { path: noFile } = await tempManifest([{ name: 'A' }]);
    await expect(loadManifest(noFile)).rejects.toThrow('non-empty "file"');
    const { path: noName } = await tempManifest([{ file: 'a.json' }]);
    await expect(loadManifest(noName)).rejects.toThrow('non-empty "name"');
    const { path: unknownKey } = await tempManifest([{ file: 'a.json', name: 'A', extra: true }]);
    await expect(loadManifest(unknownKey)).rejects.toThrow('unknown keys');
    const { path: dup } = await tempManifest([{ file: 'a.json', name: 'A' }, { file: 'a.json', name: 'B' }]);
    await expect(loadManifest(dup)).rejects.toThrow('duplicate manifest file entry');
  });

  it('rejects a missing example file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asb-examples-'));
    await expect(loadEntry({ file: 'nope.json', name: 'Nope' }, dir)).rejects.toThrow('example file missing');
  });

  it('rejects a malformed (non-JSON) example file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asb-examples-'));
    await writeFile(join(dir, 'bad.json'), 'not json');
    await expect(loadEntry({ file: 'bad.json', name: 'Bad' }, dir)).rejects.toThrow('not valid JSON');
  });

  it('rejects an example with no dashboards, or no queries array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asb-examples-'));
    await writeFile(join(dir, 'no-dash.json'), JSON.stringify({ queries: [], dashboards: [] }));
    await expect(loadEntry({ file: 'no-dash.json', name: 'X' }, dir)).rejects.toThrow('no dashboards array');
    await writeFile(join(dir, 'no-queries.json'), JSON.stringify({ dashboards: [{ id: 'd' }] }));
    await expect(loadEntry({ file: 'no-queries.json', name: 'X' }, dir)).rejects.toThrow('no queries array');
  });

  it('loads a well-formed manifest + examples end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asb-examples-'));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify([{ file: 'ok.json', name: 'OK' }]));
    await writeFile(join(dir, 'ok.json'), JSON.stringify({ queries: [], dashboards: [{ id: 'd' }] }));
    const entries = await loadExampleDashboards({ manifestPath: join(dir, 'manifest.json'), examplesDir: dir });
    expect(entries).toEqual([{ file: 'ok.json', name: 'OK', json: JSON.stringify({ queries: [], dashboards: [{ id: 'd' }] }) }]);
  });
});
