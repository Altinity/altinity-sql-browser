// Bundle-size report runner (issue #275).
//
// Builds the production artifact once (via build/build.mjs's shared buildArtifact,
// so the report measures the exact bytes users receive), measures raw/gzip/Brotli
// with deterministic compression, attributes the JS output to input modules and npm
// packages via the esbuild metafile, and emits a machine-readable JSON report, a
// human-readable Markdown report, and the raw esbuild metafile. Given a base report
// (`--base`), it appends absolute + percentage deltas.
//
// Usage: node build/size-report.mjs [--out <dir>] [--base <report.json>]
//   --out   output directory (default: bundle-report/)
//   --base  a prior bundle-size-report.json to diff against (deltas when present)
//
// Reporting only — it never alters production loading semantics. metafile:true is
// pure metadata; the emitted bytes are identical to `npm run build`.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildArtifact } from './build.mjs';
import { buildReport, diffReports, renderMarkdown, formatBytes } from './size-report-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// Deterministic compression settings so the same bytes always report the same
// sizes across machines and CI runs: gzip at max level, Brotli at max quality.
function sizes(text) {
  const buf = Buffer.from(text, 'utf8');
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

function parseArgs(argv) {
  const args = { out: 'bundle-report', base: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--base') args.base = argv[++i];
  }
  return args;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(root, args.out);

  const { html, script, styles, metafile } = await buildArtifact({ metafile: true });

  // The JS output chunk is the one esbuild marks with an entryPoint; fall back to
  // the sole output if none is marked (keeps working under future config changes).
  const outputEntry = Object.entries(metafile.outputs).find(([, o]) => o.entryPoint)
    || Object.entries(metafile.outputs)[0];
  const outputKey = outputEntry[0];

  const report = buildReport({
    metafile,
    outputKey,
    sizes: { artifact: sizes(html), js: sizes(script), css: sizes(styles) },
  });

  const base = args.base ? await readJson(resolve(process.cwd(), args.base)) : null;
  const deltas = base ? diffReports(report, base) : null;

  await mkdir(outDir, { recursive: true });
  // Also (re)write the real artifact so `dist/sql.html` exists and its on-disk size
  // matches the report even when the report job runs without a separate build step.
  await mkdir(resolve(root, 'dist'), { recursive: true });
  await writeFile(resolve(root, 'dist/sql.html'), html);
  await writeFile(resolve(outDir, 'esbuild-meta.json'), JSON.stringify(metafile, null, 2));
  await writeFile(resolve(outDir, 'bundle-size-report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(outDir, 'bundle-size-report.md'), renderMarkdown(report, deltas));

  const a = report.artifact;
  console.log(`bundle-size report -> ${args.out}/`);
  console.log(`  dist/sql.html: ${formatBytes(a.raw)} raw, ${formatBytes(a.gzip)} gzip, ${formatBytes(a.brotli)} brotli`);
  console.log(`  JS: ${formatBytes(report.js.raw)} raw / ${formatBytes(report.js.gzip)} gzip`
    + `   CSS: ${formatBytes(report.css.raw)} raw / ${formatBytes(report.css.gzip)} gzip`);
  if (deltas) console.log(`  Δ artifact gzip vs base: ${formatBytes(deltas.artifact.gzip.abs)}`);
  else console.log('  (no base report — deltas omitted)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
