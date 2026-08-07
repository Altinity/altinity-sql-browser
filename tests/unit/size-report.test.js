import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { buildArtifact } from '../../build/build.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sizeReportScript = resolve(projectRoot, 'build/size-report.mjs');

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

  // Issue #630 Phase 2: the in-repository npm workspace is first-party
  // project source, not a third-party runtime dependency — even though
  // esbuild resolves its bare `@altinity/clickhouse-http` specifier through
  // node_modules (a workspace symlink), the metafile's real (symlink-
  // resolved) input path is under packages/**, which must classify as
  // project code, not 'other'.
  it('classifies packages/** workspace source as first-party project code', () => {
    expect(classifyInput('packages/clickhouse-http/src/client.ts'))
      .toEqual({ owner: 'project', group: 'packages' });
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

// Issue #585 Phase 0's supplemental unminified-JS measurement (--include-
// unminified-js). buildReport() must add this field only when asked, and must
// never alter any other field when it isn't.
describe('buildReport unminifiedJs (issue #585 Phase 0)', () => {
  it('omits unminifiedJs entirely when unminifiedJsBytes is not given', () => {
    const r = buildReport({ sizes: SIZES, metafile: METAFILE, outputKey: 'main.js' });
    expect(r.unminifiedJs).toBeUndefined();
    expect(Object.keys(r)).not.toContain('unminifiedJs');
  });

  it('records unminifiedJs.raw when given, without changing any other field', () => {
    const withOpt = buildReport({
      sizes: SIZES, metafile: METAFILE, outputKey: 'main.js', unminifiedJsBytes: 12345,
    });
    const without = buildReport({ sizes: SIZES, metafile: METAFILE, outputKey: 'main.js' });
    expect(withOpt.unminifiedJs).toEqual({ raw: 12345 });
    const { unminifiedJs, ...rest } = withOpt;
    expect(rest).toEqual(without);
  });
});

// Issue #585 Phase 0 (plan §9, "Metafile path invariant"): running the reporter
// CLI from a process cwd OUTSIDE the repository, with `--root` pointing at it,
// must produce the exact same attribution as running it from inside the
// repository — esbuild's `absWorkingDir: repoRoot` (set by every esbuildOptions()
// call, never the invoking shell's cwd) is what makes that true. Each run gets
// its own --out/--artifact-out under $TMPDIR so neither touches this repo's
// real dist/ or bundle-report/ directories, and neither run ever calls
// process.chdir() — the child process's cwd is independent of the parent test
// process's, which this test asserts stayed put.
describe('size-report.mjs CLI attribution is independent of process cwd', () => {
  it('reproduces byte-identical reports whether launched from repoRoot or a foreign cwd with --root', async () => {
    const cwdBefore = process.cwd();
    const dirs = await Promise.all([
      mkdtemp(resolve(tmpdir(), 'asb-report-a-')),
      mkdtemp(resolve(tmpdir(), 'asb-artifact-a-')),
      mkdtemp(resolve(tmpdir(), 'asb-report-b-')),
      mkdtemp(resolve(tmpdir(), 'asb-artifact-b-')),
      mkdtemp(resolve(tmpdir(), 'asb-foreign-cwd-')),
    ]);
    const [outA, artifactA, outB, artifactB, foreignCwd] = dirs;
    try {
      // Run A: launched with cwd = repoRoot itself, no --root (default
      // resolution — this is exactly what `npm run size-report` does).
      execFileSync(process.execPath, [
        sizeReportScript, '--out', outA, '--artifact-out', artifactA,
      ], { cwd: projectRoot, stdio: 'pipe' });

      // Run B: launched with cwd OUTSIDE the repository entirely, --root
      // pointing back at it explicitly.
      execFileSync(process.execPath, [
        sizeReportScript, '--root', projectRoot, '--out', outB, '--artifact-out', artifactB,
      ], { cwd: foreignCwd, stdio: 'pipe' });

      const reportA = JSON.parse(await readFile(resolve(outA, 'bundle-size-report.json'), 'utf8'));
      const reportB = JSON.parse(await readFile(resolve(outB, 'bundle-size-report.json'), 'utf8'));

      for (const report of [reportA, reportB]) {
        // Project code and dependencies are attributed under their normal
        // repository-relative buckets...
        expect(report.topModules.some((m) => m.path.startsWith('src/'))).toBe(true);
        expect(report.topModules.some((m) => m.path.startsWith('node_modules/'))).toBe(true);
        // ...and no metafile input or entry point is ever absolute or escapes
        // the root with a leading '../', regardless of which cwd launched it.
        for (const m of report.topModules) {
          expect(m.path.startsWith('/')).toBe(false);
          expect(m.path.startsWith('../')).toBe(false);
        }
        for (const e of report.entryPoints) {
          if (e.entryPoint === null) continue;
          expect(e.entryPoint.startsWith('/')).toBe(false);
          expect(e.entryPoint.startsWith('../')).toBe(false);
        }
        expect(report.entryPoints.some((e) => e.entryPoint === 'src/main.ts')).toBe(true);
      }

      // Ownership, package attribution, top modules, and entry-point summaries
      // are identical between the two runs — and since both target the same
      // repoRoot at the same commit with no override, the whole report
      // (including compressed sizes) is byte-for-byte identical too.
      expect(reportB).toEqual(reportA);
    } finally {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    }
    // Spawning a child process with an explicit `cwd` option never touches the
    // parent test process's own working directory.
    expect(process.cwd()).toBe(cwdBefore);
  }, 180_000);
});

// Issue #630 Phase 2 — the real production esbuild metafile, not a
// synthetic fixture, must show the workspace package's source physically
// bundled and attributed as first-party project code. This is the
// "production esbuild artifact" proof the plan requires (§17/§30): the
// workspace is not externalized, and every packages/clickhouse-http/src/**
// input classifies as { owner: 'project', group: 'packages' }.
describe('production metafile attributes the clickhouse-http workspace package (issue #630 Phase 2)', () => {
  it('bundles packages/clickhouse-http/src/** into the real artifact, classified as first-party project code', async () => {
    const { metafile } = await buildArtifact({ metafile: true });
    const output = Object.values(metafile.outputs)[0];
    const modules = attributeModules(output);
    const packageModules = modules.filter((m) => m.path.startsWith('packages/clickhouse-http/src/'));
    // At least the package's client/url/index modules are physically present
    // in the bundle — proving the public package import resolved into the
    // workspace source and was bundled as ordinary first-party source, not
    // externalized.
    expect(packageModules.length).toBeGreaterThan(0);
    for (const m of packageModules) {
      expect(m.owner).toBe('project');
      expect(m.group).toBe('packages');
    }
  }, 60_000);
});
