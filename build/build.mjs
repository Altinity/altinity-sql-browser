// Build the single-file SPA: esbuild bundles src/main.js into one IIFE, which
// is inlined (with the stylesheet) into build/template.html → dist/sql.html.
//
// esbuild is the only build-time tool; the sole bundled runtime dependency is
// Chart.js (inlined, not fetched). The output is a self-contained HTML file
// that installs into any ClickHouse cluster's user_files and is served by an
// <http_handlers> static rule — it still makes zero third-party requests.

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

async function main() {
  const result = await build({
    entryPoints: [resolve(root, 'src/main.js')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    write: false,
    legalComments: 'none',
  });
  const script = result.outputFiles[0].text;
  const styles = await readFile(resolve(root, 'src/styles.css'), 'utf8');
  const template = await readFile(resolve(here, 'template.html'), 'utf8');

  const html = template
    .replace('/*__STYLES__*/', () => styles)
    .replace('/*__SCRIPT__*/', () => script);

  await mkdir(resolve(root, 'dist'), { recursive: true });
  await writeFile(resolve(root, 'dist/sql.html'), html);
  console.log('built dist/sql.html (' + html.length + ' bytes)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
