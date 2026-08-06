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
import { brotliCompress, constants, gzip, zstdCompress } from 'node:zlib';
import { promisify } from 'node:util';
import { buildFontFaces } from './fonts.mjs';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const compressZstd = promisify(zstdCompress);

// Strip characters that could break out of the single/double-quoted string
// literal `__ASB_BUILD__` sits in once spliced verbatim into the minified
// bundle (see buildArtifact below). Git commit hashes and package versions
// never contain these, so this only matters for an explicit `override` (issue
// #585 Phase 0 measurement stamp) — a caller-supplied literal that must not be
// able to inject a syntax break or a multi-line value into the emitted JS.
function sanitizeStamp(value) {
  return value.replace(/[`'"\\\r\n]/g, '');
}

// The build stamp shown in the UI (user menu) and grep-able in dist/sql.html, so
// a bug report can be tied to an exact build: `v<version> (<short-commit>)`, or
// just `v<version>` when this isn't a git checkout (offline tarball, CI export).
// A dirty working tree appends `-dirty` so a hand-built artifact (e.g. a manual
// `kubectl cp dist/sql.html`) is never mistaken for the clean commit it sits on.
// Version source: $ASB_VERSION when set (bundle.sh passes the release tag so the
// stamp and the bundle's VERSION file stay in lockstep), else package.json.
//
// `repoRoot` (default: this script's own repository) is where package.json is
// read and where `git rev-parse`/`git status` run — so a caller measuring a
// DIFFERENT worktree (issue #585 Phase 0's baseline-vs-candidate bundle
// comparison) gets that worktree's own version/commit/dirty state, never this
// script's. `override`, when provided, is returned verbatim (sanitized) instead
// of deriving anything — the Phase 0 stamp-normalized comparison reports use one
// shared literal so commit text and dirty state can't create a false size delta.
// This is measurement-only: `override` must never become a default.
export async function buildStamp({ repoRoot = root, override } = {}) {
  if (override !== undefined) return sanitizeStamp(override);
  const version = process.env.ASB_VERSION
    || JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')).version;
  let commit = '';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim();
    // `git status --porcelain` is empty iff the tree exactly matches HEAD.
    if (execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot }).toString().trim()) commit += '-dirty';
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
// so the report measures the artifact users actually receive.
//
//   repoRoot   - default: this script's own repository. Every esbuild
//                invocation MUST set `absWorkingDir: repoRoot` (issue #585
//                Phase 0) — otherwise esbuild relates metafile input/output/
//                entry-point paths to the *process* working directory, not the
//                repository being measured, and running the report from
//                another shell directory would silently move project files
//                into the metafile's unattributed bucket. This is the one
//                place that knob is set; every caller (normal build, baseline,
//                candidate, unminified-JS measurement) goes through here.
//   entryPoint - default: `<repoRoot>/src/main.ts`. May be absolute or
//                relative to `repoRoot`; either way, with `absWorkingDir` set,
//                esbuild reports it (and every input path) relative to
//                `repoRoot` in the metafile — this function never needs to
//                repair paths after the fact.
//   metafile   - the report needs esbuild's input→output byte attribution; it
//                is pure metadata that never changes the emitted bytes.
//   jsMinify   - default true (the shipped artifact). The size report's
//                supplemental unminified-JS measurement flips only this to
//                `false`, reusing every other option verbatim so the two
//                builds differ in exactly one respect.
export function esbuildOptions({ repoRoot = root, entryPoint, metafile = false, jsMinify = true } = {}) {
  const entry = entryPoint === undefined
    ? resolve(repoRoot, 'src/main.ts')
    : (isAbsolute(entryPoint) ? entryPoint : resolve(repoRoot, entryPoint));
  return {
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: jsMinify,
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
//
// `repoRoot`/`entryPoint`/`metafile`/`jsMinify` pass straight through to
// esbuildOptions() (see there for what each does and why `absWorkingDir` is
// pinned to `repoRoot`). Every OTHER source-relative read below — styles,
// notices, package.json (via buildStamp) — resolves against `repoRoot` too,
// for the same reason: a caller measuring a worktree other than this script's
// own (issue #585 Phase 0's baseline vs. candidate bundle comparison) must get
// THAT worktree's files, not this script's. `build/template.html` is the one
// exception that stays anchored to `here` (this script's own directory) —
// it's the report tool's own template, not repository source under test.
//
// `noticesPath` overrides the default `<repoRoot>/THIRD-PARTY-NOTICES.md`.
// `additionalNotices`, when given, is appended after it — the Phase 0 spike
// uses this to attach a candidate-only notice fragment for a devDependency
// that is bundled ONLY in the isolated candidate artifact, never in the
// normal production build. `buildStampOverride` passes through to
// buildStamp() (see there); omitted, normal stamp derivation is unchanged.
export async function buildArtifact({
  repoRoot = root,
  entryPoint,
  metafile = false,
  jsMinify = true,
  noticesPath,
  additionalNotices,
  buildStampOverride,
} = {}) {
  const result = await build(esbuildOptions({ repoRoot, entryPoint, metafile, jsMinify }));
  // Replace the `__ASB_BUILD__` placeholder (a string literal in src/main.ts)
  // with the build stamp before the bundle is inlined — same token-replace seam
  // as the styles/script splices below. replaceAll is robust to either quote
  // style minify may emit around the literal.
  const stamp = await buildStamp({ repoRoot, override: buildStampOverride });
  const script = result.outputFiles[0].text.replaceAll('__ASB_BUILD__', stamp);
  // esbuild's CSS transform (same minifier as the JS path above) — src/styles.css
  // was previously inlined raw, shipping every source comment/indent to the browser.
  // The `/*__FONTS__*/` token at the top of the stylesheet is replaced first with
  // the base64 @font-face rules (see build/fonts.mjs): the artifact must carry the
  // typefaces DESIGN.md specifies, and it may not fetch them. Splicing pre-minified
  // rules in before the transform keeps the font bytes inside the same single pass.
  const stylesSrc = await readFile(resolve(repoRoot, 'src/styles.css'), 'utf8');
  // NOTE: buildFontFaces() reads node_modules/@fontsource-variable/* relative
  // to build/fonts.mjs's OWN location, not `repoRoot` — it has no repoRoot
  // parameter (out of scope for issue #585 Phase 0's build-tooling change).
  // In practice this only matters when `repoRoot` names a worktree other than
  // this script's own; the pinned exact devDependency versions in a checked-
  // out lockfile mean the font bytes are identical either way.
  const fonts = await buildFontFaces();
  const styles = (await transform(
    stylesSrc.replace('/*__FONTS__*/', () => fonts.css),
    { loader: 'css', minify: true },
  )).code;
  const template = await readFile(resolve(here, 'template.html'), 'utf8');

  // The runtime deps and generated Ajv/ajv-formats helpers are MIT and inlined into the bundle,
  // so the artifact must carry their notices. esbuild strips legal comments
  // (legalComments: 'none'), so embed THIRD-PARTY-NOTICES.md as a leading HTML
  // comment — sanitized so its text can't close the comment early.
  const baseNotices = await readFile(noticesPath ?? resolve(repoRoot, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  const noticesText = additionalNotices ? `${baseNotices.trim()}\n\n${additionalNotices.trim()}` : baseNotices;
  const thirdParty = '<!--\n' + noticesText.replace(/--+>?/g, '-').trim() + '\n-->';

  const html = template
    .replace('<!--__THIRDPARTY__-->', () => thirdParty)
    .replace('/*__STYLES__*/', () => styles)
    .replace('/*__SCRIPT__*/', () => script);

  return { html, script, styles, thirdParty, fonts, metafile: result.metafile };
}

// The ClickHouse and release-bundle delivery paths deliberately continue to
// ship only sql.html. The container image additionally gets these immutable
// sidecars, so Caddy can negotiate Content-Encoding without doing CPU work for
// each request.
//
// `outDir` defaults to `<repoRoot>/dist` (unchanged for every caller that
// omits `repoRoot` too); the rest of the options pass straight through to
// buildArtifact().
export async function writeArtifact({
  repoRoot = root,
  entryPoint,
  jsMinify = true,
  noticesPath,
  additionalNotices,
  buildStampOverride,
  outDir = resolve(repoRoot, 'dist'),
} = {}) {
  const { html, fonts } = await buildArtifact({
    repoRoot, entryPoint, jsMinify, noticesPath, additionalNotices, buildStampOverride,
  });
  const source = Buffer.from(html);
  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outDir, 'sql.html'), source),
    writeFile(resolve(outDir, 'sql.html.br'), await compressBrotli(source, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    })),
    writeFile(resolve(outDir, 'sql.html.zst'), await compressZstd(source, {
      params: { [constants.ZSTD_c_compressionLevel]: 19 },
    })),
    writeFile(resolve(outDir, 'sql.html.gz'), await compressGzip(source, { level: 9 })),
  ]);
  return { html, fonts };
}

async function main() {
  const { html, fonts } = await writeArtifact();
  console.log('built dist/sql.html (' + html.length + ' bytes, '
    + 'incl. ' + fonts.rawBytes + ' bytes of inlined woff2)');
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
