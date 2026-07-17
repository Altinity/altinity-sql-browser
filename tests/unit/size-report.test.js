import { describe, expect, it } from 'vitest';
import {
  REPORT_SCHEMA_VERSION,
  normalizeInputPath,
  classifyInput,
  attributeModules,
  summarize,
  topModules,
  entryChunks,
  buildReport,
  computeDelta,
  diffReports,
  formatBytes,
  renderMarkdown,
} from '../../build/size-report-lib.mjs';

// A minimal esbuild-metafile shape covering every ownership bucket the report
// distinguishes: hand-written src, generated src, a plain external package, and a
// scoped external package.
const OUTPUT = {
  bytes: 300,
  entryPoint: 'src/main.ts',
  inputs: {
    'src/main.ts': { bytesInOutput: 100 },
    'src/generated/json-schema-validators.js': { bytesInOutput: 60 },
    'node_modules/chart.js/dist/chart.js': { bytesInOutput: 80 },
    'node_modules/@codemirror/view/dist/index.js': { bytesInOutput: 40 },
    './node_modules/chart.js/dist/helpers.js': { bytesInOutput: 20 },
  },
};
const METAFILE = { outputs: { 'main.js': OUTPUT } };
const SIZES = {
  artifact: { raw: 1000, gzip: 400, brotli: 350 },
  js: { raw: 900, gzip: 360, brotli: 300 },
  css: { raw: 100, gzip: 40, brotli: 35 },
};

describe('classifyInput', () => {
  it('normalizes a leading ./', () => {
    expect(normalizeInputPath('./src/main.ts')).toBe('src/main.ts');
    expect(normalizeInputPath('src/main.ts')).toBe('src/main.ts');
  });

  it('separates generated from hand-written project source', () => {
    expect(classifyInput('src/main.ts')).toEqual({ owner: 'project', group: 'src' });
    expect(classifyInput('src/generated/json-schemas.js'))
      .toEqual({ owner: 'generated', group: 'src/generated' });
  });

  it('groups a plain external package under its name', () => {
    expect(classifyInput('node_modules/chart.js/dist/chart.js'))
      .toEqual({ owner: 'external', group: 'chart.js', pkg: 'chart.js' });
  });

  it('groups a scoped external package under @scope/name', () => {
    expect(classifyInput('node_modules/@codemirror/view/dist/index.js'))
      .toEqual({ owner: 'external', group: '@codemirror/view', pkg: '@codemirror/view' });
  });

  it('attributes a nested dependency to its leaf package', () => {
    expect(classifyInput('node_modules/a/node_modules/@scope/b/index.js'))
      .toEqual({ owner: 'external', group: '@scope/b', pkg: '@scope/b' });
  });

  it('falls back to other for an unrecognized path', () => {
    expect(classifyInput('build/template.html')).toEqual({ owner: 'other', group: 'other' });
  });
});

describe('attributeModules', () => {
  it('flattens, tags, and sorts modules by bytes desc then path asc', () => {
    const mods = attributeModules(OUTPUT);
    expect(mods.map((m) => m.bytes)).toEqual([100, 80, 60, 40, 20]);
    expect(mods[0]).toEqual({ path: 'src/main.ts', bytes: 100, owner: 'project', group: 'src' });
    // The './'-prefixed input is normalized in the reported path.
    expect(mods.find((m) => m.bytes === 20).path).toBe('node_modules/chart.js/dist/helpers.js');
  });

  it('tolerates an output with no inputs', () => {
    expect(attributeModules({ bytes: 0 })).toEqual([]);
  });
});

describe('summarize', () => {
  it('rolls up ownership totals and per-package external bytes', () => {
    const { totalBytes, ownership, packages } = summarize(attributeModules(OUTPUT));
    expect(totalBytes).toBe(300);
    expect(ownership.project.bytes).toBe(100);
    expect(ownership.generated.bytes).toBe(60);
    expect(ownership.external.bytes).toBe(140);
    expect(ownership.project.pct).toBeCloseTo(33.33, 1);
    // chart.js aggregates its two files (80 + 20); sorted desc.
    expect(packages).toEqual([
      { name: 'chart.js', bytes: 100, pct: 100 / 300 * 100 },
      { name: '@codemirror/view', bytes: 40, pct: 40 / 300 * 100 },
    ]);
  });

  it('reports zero percentages rather than dividing by zero', () => {
    const { totalBytes, ownership } = summarize([]);
    expect(totalBytes).toBe(0);
    expect(ownership.project.pct).toBe(0);
  });
});

describe('topModules', () => {
  it('truncates to N and attaches percentages', () => {
    const mods = attributeModules(OUTPUT);
    const top = topModules(mods, 300, 2);
    expect(top).toHaveLength(2);
    expect(top[0]).toEqual({
      path: 'src/main.ts', bytes: 100, pct: 100 / 300 * 100, owner: 'project', group: 'src',
    });
  });

  it('defaults to the top 30', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      path: `src/m${i}.ts`, bytes: 40 - i, owner: 'project', group: 'src',
    }));
    expect(topModules(many, 1000)).toHaveLength(30);
  });
});

describe('entryChunks', () => {
  it('lists each output with its entry point and bytes, sorted by size', () => {
    const chunks = entryChunks({
      outputs: {
        'a.js': { bytes: 10, entryPoint: 'src/a.ts' },
        'b.js': { bytes: 20 },
      },
    });
    expect(chunks).toEqual([
      { file: 'b.js', entryPoint: null, bytes: 20 },
      { file: 'a.js', entryPoint: 'src/a.ts', bytes: 10 },
    ]);
  });

  it('tolerates a metafile with no outputs', () => {
    expect(entryChunks({})).toEqual([]);
  });
});

describe('buildReport', () => {
  it('assembles a complete, versioned report', () => {
    const r = buildReport({ sizes: SIZES, metafile: METAFILE, outputKey: 'main.js' });
    expect(r.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(r.artifact).toEqual(SIZES.artifact);
    expect(r.js).toEqual(SIZES.js);
    expect(r.css).toEqual(SIZES.css);
    expect(r.totalOutputBytes).toBe(300);
    expect(r.entryPoints).toEqual([{ file: 'main.js', entryPoint: 'src/main.ts', bytes: 300 }]);
    expect(r.ownership.external.bytes).toBe(140);
    expect(r.packages[0].name).toBe('chart.js');
    expect(r.topModules).toHaveLength(5);
    expect(r.notes[0]).toMatch(/not additive/);
  });
});

describe('computeDelta', () => {
  it('computes absolute change and percentage of base', () => {
    expect(computeDelta(120, 100)).toEqual({ current: 120, base: 100, abs: 20, pct: 20 });
    expect(computeDelta(80, 100)).toEqual({ current: 80, base: 100, abs: -20, pct: -20 });
  });

  it('returns a null percentage when the base is zero', () => {
    expect(computeDelta(50, 0)).toEqual({ current: 50, base: 0, abs: 50, pct: null });
  });
});

describe('diffReports', () => {
  const current = buildReport({ sizes: SIZES, metafile: METAFILE, outputKey: 'main.js' });

  it('diffs sizes, ownership, and per-package bytes including added/removed packages', () => {
    const base = JSON.parse(JSON.stringify(current));
    base.artifact.gzip = 380;
    base.packages = [
      { name: 'chart.js', bytes: 90, pct: 30 },
      { name: 'gone-pkg', bytes: 15, pct: 5 },
    ];
    const d = diffReports(current, base);
    expect(d.artifact.gzip).toEqual({ current: 400, base: 380, abs: 20, pct: 20 / 380 * 100 });
    // chart.js grew 90->100; @codemirror/view is new (0 base); gone-pkg removed (0 current).
    const byName = Object.fromEntries(d.packages.map((p) => [p.name, p.abs]));
    expect(byName['chart.js']).toBe(10);
    expect(byName['@codemirror/view']).toBe(40);
    expect(byName['gone-pkg']).toBe(-15);
    // Unchanged packages are dropped from the delta list.
    expect(d.packages.every((p) => p.abs !== 0)).toBe(true);
  });

  it('treats a missing base ownership bucket as zero', () => {
    const base = JSON.parse(JSON.stringify(current));
    delete base.ownership.generated;
    const d = diffReports(current, base);
    expect(d.ownership.generated).toEqual({ current: 60, base: 0, abs: 60, pct: null });
  });
});

describe('formatBytes', () => {
  it('renders B / KiB / MiB with a sign', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MiB');
    expect(formatBytes(-2048)).toBe('-2.0 KiB');
  });
});

describe('renderMarkdown', () => {
  const report = buildReport({ sizes: SIZES, metafile: METAFILE, outputKey: 'main.js' });

  it('renders every section without a delta column when no base is given', () => {
    const md = renderMarkdown(report);
    expect(md).toContain('# Bundle size report');
    expect(md).toContain('| `dist/sql.html` |');
    expect(md).toContain('## Ownership');
    expect(md).toContain('## External packages');
    expect(md).toContain('| `chart.js` |');
    expect(md).toContain('## Entry points / chunks');
    expect(md).toContain('## Top 30 modules by contributed output bytes');
    expect(md).not.toContain('Δ gzip vs base');
    expect(md).not.toContain('## Package changes vs base');
    expect(md).toMatch(/not additive/);
  });

  it('adds delta columns and a package-changes table when a base is given', () => {
    const base = JSON.parse(JSON.stringify(report));
    base.artifact.gzip = 380;
    base.packages = [{ name: 'chart.js', bytes: 90, pct: 30 }];
    const md = renderMarkdown(report, diffReports(report, base));
    expect(md).toContain('Δ gzip vs base');
    expect(md).toContain('deltas vs. the PR base');
    expect(md).toContain('## Package changes vs base');
    // A grown package shows a signed delta with percentage.
    expect(md).toMatch(/\+\d/);
  });

  it('omits the package-changes table when nothing changed', () => {
    const md = renderMarkdown(report, diffReports(report, report));
    expect(md).toContain('Δ gzip vs base');
    expect(md).not.toContain('## Package changes vs base');
    // A zero delta renders as an em dash.
    expect(md).toContain('| — |');
  });

  it('hides an all-zero other bucket but keeps real ownership rows', () => {
    const md = renderMarkdown(report);
    expect(md).toContain('| project |');
    expect(md).not.toMatch(/\| other \|/);
  });
});
