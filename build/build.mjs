// Build the single-file SPA: esbuild bundles src/main.js into one IIFE, which
// is inlined (with the stylesheet) into build/template.html → dist/sql.html.
//
// esbuild is the only build-time tool; the bundled runtime dependencies are
// Chart.js, @dagrejs/dagre, and @preact/signals-core (inlined, not fetched). The output is a self-contained HTML file
// that installs into any ClickHouse cluster's user_files and is served by an
// <http_handlers> static rule — it still makes zero third-party requests.

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// The build stamp shown in the UI (user menu) and grep-able in dist/sql.html, so
// a bug report can be tied to an exact build: `v<version> (<short-commit>)`, or
// just `v<version>` when this isn't a git checkout (offline tarball, CI export).
// A dirty working tree appends `-dirty` so a hand-built artifact (e.g. a manual
// `kubectl cp dist/sql.html`) is never mistaken for the clean commit it sits on.
// Version source: $ASB_VERSION when set (bundle.sh passes the release tag so the
// stamp and the bundle's VERSION file stay in lockstep), else package.json.
async function buildStamp() {
  const version = process.env.ASB_VERSION
    || JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
  let commit = '';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
    // `git status --porcelain` is empty iff the tree exactly matches HEAD.
    if (execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim()) commit += '-dirty';
  } catch { /* not a git checkout — fall back to version only */ }
  return commit ? `v${version} (${commit})` : `v${version}`;
}

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
  // Replace the `__ASB_BUILD__` placeholder (a string literal in src/main.js)
  // with the build stamp before the bundle is inlined — same token-replace seam
  // as the styles/script splices below. replaceAll is robust to either quote
  // style minify may emit around the literal.
  const script = result.outputFiles[0].text.replaceAll('__ASB_BUILD__', await buildStamp());
  const styles = await readFile(resolve(root, 'src/styles.css'), 'utf8');
  const template = await readFile(resolve(here, 'template.html'), 'utf8');

  // The runtime deps (Chart.js, dagre, @preact/signals-core) are MIT and inlined
  // into the bundle, so the artifact must carry their notices. esbuild strips legal comments
  // (legalComments: 'none'), so embed THIRD-PARTY-NOTICES.md as a leading HTML
  // comment — sanitized so its text can't close the comment early.
  const notices = (await readFile(resolve(root, 'THIRD-PARTY-NOTICES.md'), 'utf8')).replace(/--+>?/g, '-');
  const thirdParty = '<!--\n' + notices.trim() + '\n-->';

  const html = template
    .replace('<!--__THIRDPARTY__-->', () => thirdParty)
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
