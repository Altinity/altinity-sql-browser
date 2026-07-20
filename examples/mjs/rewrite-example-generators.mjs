// One-time source migration used by the rework-examples workflow. It updates
// generators, validation, tests, and documentation before normalizing the
// checked-in artifacts. The workflow removes this file after it runs.

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pathOf = (path) => resolve(root, path);
const read = (path) => readFileSync(pathOf(path), 'utf8');
const write = (path, content) => writeFileSync(pathOf(path), content);

function replace(path, before, after) {
  const source = read(path);
  if (!source.includes(before)) throw new Error(`${path}: expected source fragment was not found`);
  write(path, source.replace(before, after));
}

function replaceRegex(path, pattern, after) {
  const source = read(path);
  if (!pattern.test(source)) throw new Error(`${path}: expected source pattern was not found`);
  write(path, source.replace(pattern, after));
}

// On-time gallery: every query is deliberately represented as a Dashboard tile.
replace('examples/mjs/build-ontime-charts.mjs',
  "import { assertValidLibraryDocument } from './validate-library.mjs';",
  "import { buildDashboard, writeExampleBundle } from './example-bundle.mjs';");
replaceRegex('examples/mjs/build-ontime-charts.mjs',
  /const doc = \{[\s\S]*?assertValidLibraryDocument\(doc\);\n\nconst outPath = resolve\(here, 'ontime-charts\.json'\);\nwriteFileSync\(outPath, JSON\.stringify\(doc, null, 2\) \+ '\\n'\);/,
  `const dashboard = buildDashboard({
  id: 'ontime-chart-gallery',
  title: 'On-time chart gallery',
  description: 'Chart gallery over the public ontime flight dataset.',
  queries,
  tileQueryIds: queries.map((query) => query.id),
  preset: 'columns-2',
});

const outPath = resolve(here, 'ontime-charts.json');
writeExampleBundle(outPath, {
  exportedAt: new Date().toISOString(),
  metadata: { name: dashboard.title, description: dashboard.description },
  queries,
  dashboards: [dashboard],
});`);
replace('examples/mjs/build-ontime-charts.mjs', "import { writeFileSync } from 'node:fs';\n", '');

// System explorer: chartable favorites are the explicit Dashboard membership.
replace('examples/mjs/build-system-explorer-charts.mjs',
  "import { assertValidLibraryDocument } from './validate-library.mjs';",
  "import { buildDashboard, writeExampleBundle } from './example-bundle.mjs';");
replaceRegex('examples/mjs/build-system-explorer-charts.mjs',
  /const doc = \{[\s\S]*?assertValidLibraryDocument\(doc\);\n\nconst outPath = resolve\(here, 'system-explorer-charts\.json'\);\nwriteFileSync\(outPath, JSON\.stringify\(doc, null, 2\) \+ '\\n'\);/,
  `const dashboard = buildDashboard({
  id: 'system-explorer',
  title: 'ClickHouse system explorer',
  description: 'Operational views over ClickHouse system tables.',
  queries,
  tileQueryIds: queries.filter((query) => query.spec.favorite).map((query) => query.id),
  preset: 'columns-2',
});

const outPath = resolve(here, 'system-explorer-charts.json');
writeExampleBundle(outPath, {
  exportedAt: new Date().toISOString(),
  metadata: { name: dashboard.title, description: dashboard.description },
  queries,
  dashboards: [dashboard],
});`);
replace('examples/mjs/build-system-explorer-charts.mjs', "import { writeFileSync } from 'node:fs';\n", '');

// Iceberg persona dashboards: explicit tile membership and catalog/time filters.
replace('examples/mjs/build-iceberg-dashboards.mjs',
  "import { assertValidLibraryDocument } from './validate-library.mjs';",
  "import { buildDashboard, writeExampleBundle } from './example-bundle.mjs';");
replaceRegex('examples/mjs/build-iceberg-dashboards.mjs',
  /const stamp = new Date\(\)\.toISOString\(\);[\s\S]*?console\.log\(`wrote \$\{out\} \(\$\{queries\.length\} entries, \$\{queries\.filter\(\(q\) => q\.spec\.favorite\)\.length\} on the dashboard\)`\);\n\}/,
  `const stamp = new Date().toISOString();
for (const [file, specs, prefix, dashboardMeta] of [
  ['iceberg-catalog-dashboard.json', BI, 'iceb', {
    id: 'iceberg-catalog-explorer', title: 'Iceberg catalog explorer — BI',
    description: 'Business intelligence view of Iceberg catalog metadata.',
  }],
  ['iceberg-dba-dashboard.json', DBA, 'iced', {
    id: 'iceberg-dba-explorer', title: 'Iceberg catalog explorer — DBA',
    description: 'Maintenance and health view of Iceberg catalog metadata.',
  }],
]) {
  const queries = buildEntries(specs, prefix);
  const dashboard = buildDashboard({
    ...dashboardMeta,
    queries,
    tileQueryIds: queries.filter((query) => query.spec.favorite).map((query) => query.id),
    preset: 'columns-2',
  });
  const out = resolve(here, file);
  writeExampleBundle(out, {
    exportedAt: stamp,
    metadata: { name: dashboard.title, description: dashboard.description },
    queries,
    dashboards: [dashboard],
  });
  console.log(\`wrote \${out} (\${queries.length} entries, \${dashboard.tiles.length} on the dashboard)\`);
}`);
replace('examples/mjs/build-iceberg-dashboards.mjs', "import { writeFileSync } from 'node:fs';\n", '');

// Iceberg installer remains a query-only portable bundle.
replace('examples/mjs/build-iceberg-install.mjs',
  "import { assertValidLibraryDocument } from './validate-library.mjs';",
  "import { writeExampleBundle } from './example-bundle.mjs';");
replaceRegex('examples/mjs/build-iceberg-install.mjs',
  /const doc = \{[\s\S]*?assertValidLibraryDocument\(doc\);\n\nconst out = resolve\(here, 'iceberg-install\.json'\);\nwriteFileSync\(out, JSON\.stringify\(doc, null, 2\) \+ '\\n'\);/,
  `const normalizedQueries = queries.map(({ id, sql, name, favorite, description, panel, view }) => ({
  id,
  sql,
  specVersion: 1,
  spec: {
    name,
    favorite,
    ...(description ? { description } : {}),
    ...(panel ? { panel } : {}),
    ...(view ? { view } : {}),
  },
}));

const out = resolve(here, 'iceberg-install.json');
writeExampleBundle(out, {
  exportedAt: new Date().toISOString(),
  metadata: {
    name: 'Iceberg Catalog Explorer installer',
    description: 'Administrative setup and generation queries for the Iceberg examples.',
  },
  queries: normalizedQueries,
  dashboards: [],
});`);
replace('examples/mjs/build-iceberg-install.mjs',
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "import { readFileSync } from 'node:fs';");

// Keep the old module path as a fail-closed compatibility alias for external
// maintenance scripts; all in-repo generators now import example-bundle.mjs.
write('examples/mjs/validate-library.mjs', `// Deprecated compatibility alias. Checked-in examples are portable bundles.\nexport { assertValidExampleBundle as assertValidLibraryDocument } from './example-bundle.mjs';\n`);

write('examples/mjs/README.md', `# Example Bundles and Generators

The checked-in JSON files under \`examples/\` are canonical **portable bundle
v1** documents. Query definitions use saved-query **Spec v1** and every
Dashboard example includes an explicit **Dashboard document v1** with tile
membership, flow-layout placement, and filter definitions.

Legacy Library v1/v2 JSON remains importable for compatibility, but it is not an
authoring format for new or regenerated examples.

## Maintenance commands

- \`node examples/mjs/normalize-examples.mjs --check\` verifies that every
  checked-in example and the Iceberg drill-down template use the canonical
  envelope and explicit Dashboard model.
- \`node examples/mjs/normalize-examples.mjs\` migrates/normalizes existing
  checked-in artifacts without changing their SQL or panel schema keys.

## Generators

- \`build-ontime-charts.mjs\` regenerates \`ontime-charts.json\`.
- \`build-system-explorer-charts.mjs\` regenerates
  \`system-explorer-charts.json\`.
- \`build-iceberg-install.mjs\` regenerates \`iceberg-install.json\`.
- \`build-iceberg-dashboards.mjs\` regenerates
  \`iceberg-catalog-dashboard.json\` and \`iceberg-dba-dashboard.json\`.
- \`example-bundle.mjs\` owns the shared portable-bundle and Dashboard authoring
  helpers used by those generators.

The dashboard generators that derive live result schema keys require an
appropriately privileged ClickHouse client connection. The install generator
uses the templates in \`examples/iceberg-templates/\`.
`);

write('tests/unit/spec-examples.test.js', `import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidExampleBundle } from '../../examples/mjs/example-bundle.mjs';
import { decodePortableBundleJson } from '../../src/dashboard/model/portable-bundle-codec.js';
import { querySpecSchemaService } from '../../src/core/spec-schema.js';
import { filterExecution } from '../../src/core/filter-execution.js';
import { effectiveDashboardRole } from '../../src/core/result-choice.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function decodeExample(text, name) {
  const result = decodePortableBundleJson(text);
  expect(result.ok, result.ok ? name : \`${name}: \${result.diagnostics.map((d) => d.message).join('; ')}\`).toBe(true);
  if (!result.ok) throw new Error(name);
  return result.value;
}

describe('schema artifacts and examples', () => {
  it('keeps generated schema artifacts deterministic and current', () => {
    expect(() => execFileSync(process.execPath, ['build/compile-json-schemas.mjs', '--check'], {
      cwd: root, stdio: 'pipe',
    })).not.toThrow();
  });

  it('keeps every checked-in JSON example on portable bundle v1 with explicit Dashboard v1 documents', () => {
    const examples = resolve(root, 'examples');
    for (const name of readdirSync(examples).filter((item) => item.endsWith('.json'))) {
      const text = readFileSync(resolve(examples, name), 'utf8');
      const bundle = decodeExample(text, name);
      expect(bundle.format, name).toBe('altinity-sql-browser/portable-bundle');
      expect(bundle.version, name).toBe(1);
      expect(bundle.queries.length, name).toBeGreaterThan(0);
      expect(() => assertValidExampleBundle(bundle), name).not.toThrow();
      for (const dashboard of bundle.dashboards) {
        expect(dashboard.documentVersion, name).toBe(1);
        expect(dashboard.layout.type, name).toBe('flow');
        expect(dashboard.tiles.length, name).toBeGreaterThan(0);
      }
    }
    expect(() => execFileSync(process.execPath, ['examples/mjs/normalize-examples.mjs', '--check'], {
      cwd: root, stdio: 'pipe',
    })).not.toThrow();
  });

  it('validates the generated Iceberg drilldown portable-bundle template', () => {
    const template = readFileSync(resolve(root, 'examples/iceberg-templates/ice_meta_drilldown.json.tmpl'), 'utf8')
      .replaceAll('__CATALOG__', 'demo');
    const bundle = decodeExample(template, 'ice_meta_drilldown.json.tmpl');
    expect(bundle.dashboards).toHaveLength(1);
    expect(bundle.dashboards[0].tiles.length).toBeGreaterThan(0);
  });

  it('every Filter-role example query is a valid Filter source', () => {
    const examples = resolve(root, 'examples');
    for (const name of readdirSync(examples).filter((item) => item.endsWith('.json'))) {
      const bundle = decodeExample(readFileSync(resolve(examples, name), 'utf8'), name);
      for (const query of bundle.queries) {
        if (effectiveDashboardRole(query.spec) !== 'filter') continue;
        expect(filterExecution(query.sql).diagnostics, \`${name}:\${query.id}\`).toEqual([]);
      }
    }
  });

  it('validates every JSON Spec example used by the authoring documentation', () => {
    for (const name of ['saved-query-spec-json-schema.md', 'visualization-spec-authoring-guide.md']) {
      const source = readFileSync(resolve(root, 'docs/drafts', name), 'utf8');
      const snippets = [...source.matchAll(/\`\`\`json\n([\s\S]*?)\`\`\`/g)].map((match) => JSON.parse(match[1]));
      expect(snippets.length, name).toBeGreaterThan(0);
      for (const spec of snippets) expect(querySpecSchemaService.validate(spec), name).toEqual([]);
    }
  });

  it('makes example validation fail before an invalid document can be written', () => {
    const valid = {
      $schema: 'https://altinity.com/schemas/altinity-sql-browser/portable-bundle-v1.schema.json',
      format: 'altinity-sql-browser/portable-bundle', version: 1,
      exportedAt: '2026-07-14T00:00:00.000Z', dashboards: [],
      queries: [{ id: 'q', sql: 'SELECT 1', specVersion: 1, spec: { panel: { cfg: { type: 'table' } } } }],
    };
    expect(assertValidExampleBundle(valid).queries).toHaveLength(1);
    valid.queries[0].spec.panel = {};
    expect(() => assertValidExampleBundle(valid)).toThrow('panel requires cfg.type');
  });
});
`);

// Remove this one-time script from the resulting commit.
unlinkSync(fileURLToPath(import.meta.url));
