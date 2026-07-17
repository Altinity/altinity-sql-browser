// Pure attribution + formatting for the bundle-size report (issue #275).
//
// No I/O, no compression, no esbuild — the runner (build/size-report.mjs) does the
// build, measures raw/gzip/Brotli on real buffers, and feeds the numbers plus the
// esbuild metafile in here. Everything below is a pure function of its arguments so
// it is unit-tested directly (tests/unit/size-report.test.js), the same way the
// schema-build tooling is tested even though build/ sits outside the src/ coverage
// gate.

export const REPORT_SCHEMA_VERSION = 1;

// A byte figure at three compression levels. Compression is NOT additive across
// modules — gzip/Brotli of the whole is smaller than the sum of the parts — so
// only whole artifacts (html/js/css) ever carry gzip/brotli; per-module figures
// are raw contributed output bytes only.
function triple(raw, gzip, brotli) {
  return { raw, gzip, brotli };
}

// esbuild metafile input keys are repo-relative POSIX paths ('src/main.ts',
// 'node_modules/chart.js/dist/chart.js'), occasionally with a leading './'.
export function normalizeInputPath(p) {
  return p.replace(/^\.\//, '');
}

// Attribute one input file to an ownership bucket per the issue's rules:
//   src/generated/**            -> generated project code
//   src/**  (everything else)   -> hand-written project source
//   node_modules/<pkg>/**       -> external, grouped under <pkg>
//   node_modules/@scope/<pkg>/  -> external, grouped under @scope/<pkg>
// Nested deps (a/node_modules/b) attribute to the *leaf* package (b), which is the
// copy whose bytes actually shipped. Anything else lands in 'other' so it is
// surfaced explicitly rather than hidden.
export function classifyInput(rawPath) {
  const path = normalizeInputPath(rawPath);
  const nm = path.lastIndexOf('node_modules/');
  if (nm !== -1) {
    const rest = path.slice(nm + 'node_modules/'.length);
    const parts = rest.split('/');
    const pkg = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    return { owner: 'external', group: pkg, pkg };
  }
  if (path.startsWith('src/generated/')) return { owner: 'generated', group: 'src/generated' };
  if (path.startsWith('src/')) return { owner: 'project', group: 'src' };
  return { owner: 'other', group: 'other' };
}

// Flatten one esbuild output's `inputs` map into a sorted module list, each tagged
// with its contributed output bytes and ownership. Sorted by bytes desc, then path
// asc, so output is deterministic regardless of metafile key order.
export function attributeModules(output) {
  const modules = Object.entries(output.inputs || {}).map(([path, info]) => ({
    path: normalizeInputPath(path),
    bytes: info.bytesInOutput || 0,
    ...classifyInput(path),
  }));
  modules.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return modules;
}

// Roll a module list up into ownership totals and a per-external-package breakdown.
export function summarize(modules) {
  const totalBytes = modules.reduce((n, m) => n + m.bytes, 0);
  const byOwner = { project: 0, generated: 0, external: 0, other: 0 };
  const pkgBytes = new Map();
  for (const m of modules) {
    byOwner[m.owner] += m.bytes;
    if (m.owner === 'external') pkgBytes.set(m.group, (pkgBytes.get(m.group) || 0) + m.bytes);
  }
  const pct = (n) => (totalBytes ? (n / totalBytes) * 100 : 0);
  const ownership = {};
  for (const [owner, bytes] of Object.entries(byOwner)) ownership[owner] = { bytes, pct: pct(bytes) };
  const packages = [...pkgBytes.entries()]
    .map(([name, bytes]) => ({ name, bytes, pct: pct(bytes) }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return { totalBytes, ownership, packages };
}

// Top N modules by contributed output bytes, each with its percentage of the total.
export function topModules(modules, totalBytes, n = 30) {
  const pct = (b) => (totalBytes ? (b / totalBytes) * 100 : 0);
  return modules.slice(0, n).map((m) => ({
    path: m.path, bytes: m.bytes, pct: pct(m.bytes), owner: m.owner, group: m.group,
  }));
}

// Entry-point / output-chunk totals. The single-file build has exactly one chunk,
// but the report models a list so it stays meaningful if hosted builds ever add
// code splitting or route-level lazy loading (per the issue).
export function entryChunks(metafile) {
  return Object.entries(metafile.outputs || {}).map(([file, out]) => ({
    file, entryPoint: out.entryPoint || null, bytes: out.bytes || 0,
  })).sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
}

// Assemble the full machine-readable report from measured sizes + the metafile.
// `sizes` carries the three whole-artifact measurements; `outputKey` names the JS
// output chunk inside the metafile whose inputs we attribute.
export function buildReport({ sizes, metafile, outputKey }) {
  const output = metafile.outputs[outputKey];
  const modules = attributeModules(output);
  const { totalBytes, ownership, packages } = summarize(modules);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    artifact: triple(sizes.artifact.raw, sizes.artifact.gzip, sizes.artifact.brotli),
    js: triple(sizes.js.raw, sizes.js.gzip, sizes.js.brotli),
    css: triple(sizes.css.raw, sizes.css.gzip, sizes.css.brotli),
    totalOutputBytes: totalBytes,
    entryPoints: entryChunks(metafile),
    ownership,
    packages,
    topModules: topModules(modules, totalBytes, 30),
    notes: [
      'Percentages are of raw contributed output bytes (metafile bytesInOutput); '
        + 'gzip/Brotli are measured per whole artifact only — compression is not additive across modules.',
    ],
  };
}

// A single scalar delta: absolute change and percentage-of-base. base===0 yields a
// null pct (no meaningful ratio) rather than Infinity.
export function computeDelta(current, base) {
  const abs = current - base;
  return { current, base, abs, pct: base ? (abs / base) * 100 : null };
}

// Diff a current report against a base report. Covers the three whole-artifact
// sizes (raw/gzip/Brotli), ownership buckets, and per-package bytes — including
// packages that appeared or disappeared between the two builds.
export function diffReports(current, base) {
  const sizeDelta = (key) => ({
    raw: computeDelta(current[key].raw, base[key].raw),
    gzip: computeDelta(current[key].gzip, base[key].gzip),
    brotli: computeDelta(current[key].brotli, base[key].brotli),
  });
  const ownership = {};
  for (const owner of Object.keys(current.ownership)) {
    ownership[owner] = computeDelta(current.ownership[owner].bytes, base.ownership?.[owner]?.bytes || 0);
  }
  const baseP = new Map((base.packages || []).map((p) => [p.name, p.bytes]));
  const curP = new Map((current.packages || []).map((p) => [p.name, p.bytes]));
  const names = [...new Set([...baseP.keys(), ...curP.keys()])].sort();
  const packages = names.map((name) => ({
    name, ...computeDelta(curP.get(name) || 0, baseP.get(name) || 0),
  })).filter((p) => p.abs !== 0).sort((a, b) => Math.abs(b.abs) - Math.abs(a.abs) || a.name.localeCompare(b.name));
  return {
    artifact: sizeDelta('artifact'),
    js: sizeDelta('js'),
    css: sizeDelta('css'),
    totalOutputBytes: computeDelta(current.totalOutputBytes, base.totalOutputBytes || 0),
    ownership,
    packages,
  };
}

// Human-readable byte size: B up to 1 KiB, then KiB/MiB with one decimal (base 2,
// matching how developers reason about bundle sizes).
export function formatBytes(n) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KiB`;
  return `${sign}${(abs / (1024 * 1024)).toFixed(1)} MiB`;
}

// A signed size with its percentage, for delta cells: '+1.2 KiB (+3.4%)'.
function formatDelta(d) {
  const s = d.abs >= 0 ? '+' : '';
  const pct = d.pct === null ? 'new' : `${d.abs >= 0 ? '+' : ''}${d.pct.toFixed(1)}%`;
  if (d.abs === 0) return '—';
  return `${s}${formatBytes(d.abs)} (${pct})`;
}

function sizeRow(label, t, delta) {
  const cells = [label, formatBytes(t.raw), formatBytes(t.gzip), formatBytes(t.brotli)];
  if (delta) cells.push(formatDelta(delta.gzip));
  return `| ${cells.join(' | ')} |`;
}

// Render the Markdown report. `deltas` (from diffReports) is optional; when present
// a delta column (keyed on gzip transfer size) is added to the size table and a
// per-package change table is appended.
export function renderMarkdown(report, deltas) {
  const L = [];
  L.push('# Bundle size report');
  L.push('');
  L.push(deltas
    ? 'Sizes for the self-contained `dist/sql.html` and its inlined parts, with deltas vs. the PR base.'
    : 'Sizes for the self-contained `dist/sql.html` and its inlined parts.');
  L.push('');
  const head = ['Artifact', 'Raw', 'gzip', 'Brotli'];
  if (deltas) head.push('Δ gzip vs base');
  L.push(`| ${head.join(' | ')} |`);
  L.push(`|${head.map(() => '---').join('|')}|`);
  L.push(sizeRow('`dist/sql.html`', report.artifact, deltas?.artifact));
  L.push(sizeRow('JS bundle', report.js, deltas?.js));
  L.push(sizeRow('CSS (minified)', report.css, deltas?.css));
  L.push('');

  L.push('## Ownership (raw contributed output bytes)');
  L.push('');
  const oHead = ['Owner', 'Bytes', '% of JS output'];
  if (deltas) oHead.push('Δ vs base');
  L.push(`| ${oHead.join(' | ')} |`);
  L.push(`|${oHead.map(() => '---').join('|')}|`);
  for (const [owner, v] of Object.entries(report.ownership)) {
    if (v.bytes === 0 && owner === 'other') continue;
    const cells = [owner, formatBytes(v.bytes), `${v.pct.toFixed(1)}%`];
    if (deltas) cells.push(formatDelta(deltas.ownership[owner]));
    L.push(`| ${cells.join(' | ')} |`);
  }
  L.push('');

  L.push('## External packages');
  L.push('');
  L.push('| Package | Bytes | % of JS output |');
  L.push('|---|---|---|');
  for (const p of report.packages) L.push(`| \`${p.name}\` | ${formatBytes(p.bytes)} | ${p.pct.toFixed(1)}% |`);
  L.push('');

  L.push('## Entry points / chunks');
  L.push('');
  L.push('| Output | Entry point | Bytes |');
  L.push('|---|---|---|');
  for (const c of report.entryPoints) L.push(`| \`${c.file}\` | ${c.entryPoint ? `\`${c.entryPoint}\`` : '—'} | ${formatBytes(c.bytes)} |`);
  L.push('');

  L.push('## Top 30 modules by contributed output bytes');
  L.push('');
  L.push('| Module | Owner | Bytes | % |');
  L.push('|---|---|---|---|');
  for (const m of report.topModules) L.push(`| \`${m.path}\` | ${m.owner} | ${formatBytes(m.bytes)} | ${m.pct.toFixed(1)}% |`);
  L.push('');

  if (deltas && deltas.packages.length) {
    L.push('## Package changes vs base');
    L.push('');
    L.push('| Package | Base | Current | Δ |');
    L.push('|---|---|---|---|');
    for (const p of deltas.packages) {
      L.push(`| \`${p.name}\` | ${formatBytes(p.base)} | ${formatBytes(p.current)} | ${formatDelta(p)} |`);
    }
    L.push('');
  }

  for (const note of report.notes) L.push(`> ${note}`);
  L.push('');
  return L.join('\n');
}
