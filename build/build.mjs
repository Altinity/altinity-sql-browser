// Build the single-file SPA: esbuild bundles src/main.ts into one IIFE, which
// is inlined (with the stylesheet) into build/template.html → dist/sql.html.
//
// esbuild is the only build-time tool; the bundled runtime dependencies are
// CodeMirror 6, Chart.js, @dagrejs/dagre, and @preact/signals-core (inlined,
// not fetched). The output is a self-contained HTML file
// that installs into any ClickHouse cluster's user_files and is served by an
// <http_handlers> static rule — it still makes zero third-party requests.

import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
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
  } catch {
    // Not a git checkout (e.g. the Docker build context ships no .git) — use an
    // injected commit if one was passed, so the stamp stays `v<version> (<sha>)`
    // instead of falling back to version-only. $ASB_COMMIT is the full sha;
    // shorten to git's 7-char form.
    if (process.env.ASB_COMMIT) commit = process.env.ASB_COMMIT.trim().slice(0, 7);
  }
  return commit ? `v${version} (${commit})` : `v${version}`;
}

// The esbuild options for the single production entry point. Shared verbatim by
// the release build (`main`) and the bundle-size report (build/size-report.mjs)
// so the report measures the artifact users actually receive. `metafile` is the
// only knob: the report needs esbuild's input→output byte attribution, and it is
// pure metadata that never changes the emitted bytes.
export function esbuildOptions({ metafile = false } = {}) {
  return {
    entryPoints: [resolve(root, 'src/main.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    write: false,
    legalComments: 'none',
    metafile,
  };
}

// Produce the exact bytes that ship in dist/sql.html without writing anything, so
// callers (the release build, the size report) share one source of truth. Returns
// the assembled `html` plus its three inlined parts — `script` (JS bundle, stamp
// substituted), `styles` (minified CSS), `thirdParty` (the notices comment) — and
// the esbuild `metafile` when requested (undefined otherwise). Keeping this the
// single builder is what guarantees the report and the release stay byte-identical.
export async function buildArtifact({ metafile = false } = {}) {
  const result = await build(esbuildOptions({ metafile }));
  // Replace the `__ASB_BUILD__` placeholder (a string literal in src/main.ts)
  // with the build stamp before the bundle is inlined — same token-replace seam
  // as the styles/script splices below. replaceAll is robust to either quote
  // style minify may emit around the literal.
  const script = result.outputFiles[0].text.replaceAll('__ASB_BUILD__', await buildStamp());
  // esbuild's CSS transform (same minifier as the JS path above) — src/styles.css
  // was previously inlined raw, shipping every source comment/indent to the browser.
  const stylesSrc = await readFile(resolve(root, 'src/styles.css'), 'utf8');
  const styles = (await transform(stylesSrc, { loader: 'css', minify: true })).code;
  const template = await readFile(resolve(here, 'template.html'), 'utf8');

  // The runtime deps and generated Ajv/ajv-formats helpers are MIT and inlined into the bundle,
  // so the artifact must carry their notices. esbuild strips legal comments
  // (legalComments: 'none'), so embed THIRD-PARTY-NOTICES.md as a leading HTML
  // comment — sanitized so its text can't close the comment early.
  const notices = (await readFile(resolve(root, 'THIRD-PARTY-NOTICES.md'), 'utf8')).replace(/--+>?/g, '-');
  const thirdParty = '<!--\n' + notices.trim() + '\n-->';

  const html = template
    .replace('<!--__THIRDPARTY__-->', () => thirdParty)
    .replace('/*__STYLES__*/', () => styles)
    .replace('/*__SCRIPT__*/', () => script);

  return { html, script, styles, thirdParty, metafile: result.metafile };
}

async function main() {
  const { html } = await buildArtifact();
  await mkdir(resolve(root, 'dist'), { recursive: true });
  await writeFile(resolve(root, 'dist/sql.html'), html);
  console.log('built dist/sql.html (' + html.length + ' bytes)');
}

// Only run the release build when invoked as a script, not when imported for its
// exports (build/size-report.mjs, tests). Compare *realpaths*: Node sets
// import.meta.url to the symlink-resolved location, so a plain resolve() of
// argv[1] (which doesn't follow symlinks) would miscompare when the checkout sits
// under a symlinked path — silently skipping the release build. realpathSync on
// argv[1] closes that gap.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
