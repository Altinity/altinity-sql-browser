// The Docker image serves these bytes directly; this test keeps the static
// encoding sidecars tied exactly to the ClickHouse/release sql.html artifact.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompress, gunzip, zstdDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import {
  buildArtifact, buildStamp, esbuildOptions, writeArtifact,
} from '../../build/build.mjs';

const decompressBrotli = promisify(brotliDecompress);
const decompressGzip = promisify(gunzip);
const decompressZstd = promisify(zstdDecompress);
const tempDirs = [];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('container static-compression artifacts', () => {
  it('writes every negotiated encoding as an exact sql.html sidecar', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'asb-artifact-'));
    tempDirs.push(outDir);
    const { html } = await writeArtifact({ outDir });
    const raw = Buffer.from(html);

    await expect(readFile(join(outDir, 'sql.html'))).resolves.toEqual(raw);
    await expect(readFile(join(outDir, 'sql.html.br')).then(decompressBrotli)).resolves.toEqual(raw);
    await expect(readFile(join(outDir, 'sql.html.zst')).then(decompressZstd)).resolves.toEqual(raw);
    await expect(readFile(join(outDir, 'sql.html.gz')).then(decompressGzip)).resolves.toEqual(raw);
  // Brotli quality 11 and zstd level 19 are intentionally expensive; under the
  // full four-worker coverage suite, a hosted runner can take longer than 30s.
  }, 90_000);
});

// Issue #585 Phase 0's build-tooling refactor: every exported function accepts
// an optional repoRoot (plus entry/minify/notices/stamp) so a caller can measure
// a worktree other than this script's own — e.g. a baseline `origin/main`
// worktree vs. the Phase 0 candidate — without any of the reads or the esbuild
// `absWorkingDir` silently falling back to this script's own repository.
async function makeFakeRepoRoot(version = '9.9.9') {
  const dir = await mkdtemp(join(tmpdir(), 'asb-reporoot-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version }));
  // A real (non-git) file tree so `git rev-parse`/`git status` reliably fail
  // (ENOTDIR/"not a git repository") rather than walking up into whatever
  // git repository happens to contain the OS temp dir.
  await writeFile(join(dir, 'src/main.ts'), "console.log('__ASB_BUILD__');\n");
  await writeFile(join(dir, 'src/styles.css'), 'body{color:red}\n');
  await writeFile(join(dir, 'THIRD-PARTY-NOTICES.md'), '## fake-pkg\n\nApache-2.0\n');
  return dir;
}

describe('esbuildOptions repoRoot ownership', () => {
  it('pins absWorkingDir to the supplied repoRoot and defaults the entry under it', () => {
    const opts = esbuildOptions({ repoRoot: '/fake/root' });
    expect(opts.absWorkingDir).toBe('/fake/root');
    expect(opts.entryPoints).toEqual([resolve('/fake/root', 'src/main.ts')]);
    expect(opts.minify).toBe(true);
  });

  it('resolves a relative entryPoint against repoRoot, and passes an absolute one through unchanged', () => {
    const rel = esbuildOptions({ repoRoot: '/fake/root', entryPoint: 'tests/spike/candidate-entry.ts' });
    expect(rel.entryPoints).toEqual([resolve('/fake/root', 'tests/spike/candidate-entry.ts')]);
    const abs = esbuildOptions({ repoRoot: '/fake/root', entryPoint: '/abs/other-entry.ts' });
    expect(abs.entryPoints).toEqual(['/abs/other-entry.ts']);
  });

  it('flips only jsMinify for the unminified-JS measurement, leaving every other option identical', () => {
    const minified = esbuildOptions({ repoRoot: '/fake/root' });
    const unminified = esbuildOptions({ repoRoot: '/fake/root', jsMinify: false });
    expect(unminified).toEqual({ ...minified, minify: false });
  });

  it('defaults repoRoot to this repository when omitted', () => {
    const opts = esbuildOptions();
    expect(opts.absWorkingDir).toBe(projectRoot);
    expect(opts.entryPoints).toEqual([resolve(projectRoot, 'src/main.ts')]);
  });
});

describe('buildStamp', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = { ASB_VERSION: process.env.ASB_VERSION, ASB_COMMIT: process.env.ASB_COMMIT };
    delete process.env.ASB_VERSION;
    delete process.env.ASB_COMMIT;
  });
  afterEach(() => {
    if (savedEnv.ASB_VERSION === undefined) delete process.env.ASB_VERSION;
    else process.env.ASB_VERSION = savedEnv.ASB_VERSION;
    if (savedEnv.ASB_COMMIT === undefined) delete process.env.ASB_COMMIT;
    else process.env.ASB_COMMIT = savedEnv.ASB_COMMIT;
  });

  it("derives the version from the supplied repoRoot's own package.json, not this script's", async () => {
    const dir = await makeFakeRepoRoot('9.9.9');
    const stamp = await buildStamp({ repoRoot: dir });
    // A bare temp dir has no .git, so no commit suffix — version only.
    expect(stamp).toBe('v9.9.9');
  });

  it('returns the override verbatim (sanitized) without reading repoRoot at all', async () => {
    const stamp = await buildStamp({ repoRoot: '/does/not/exist', override: 'v0.0.0-measurement (0000000)' });
    expect(stamp).toBe('v0.0.0-measurement (0000000)');
  });

  it('strips characters that could break out of the spliced string literal', async () => {
    const stamp = await buildStamp({ override: 'bad`\'"\\\r\nvalue' });
    expect(stamp).toBe('badvalue');
  });

  it('an override on one call never leaks into a later call that omits it', async () => {
    const dir = await makeFakeRepoRoot('1.2.3');
    const overridden = await buildStamp({ repoRoot: dir, override: 'CUSTOM-STAMP' });
    const normal = await buildStamp({ repoRoot: dir });
    expect(overridden).toBe('CUSTOM-STAMP');
    expect(normal).toBe('v1.2.3');
  });

  it('defaults repoRoot to this repository and produces the real v<version>(<commit>) shape', async () => {
    const stamp = await buildStamp();
    expect(stamp).toMatch(/^v\d+\.\d+\.\d+( \([0-9a-f]{7}(-dirty)?\))?$/);
  });
});

describe('buildArtifact against an alternate repoRoot', () => {
  it("builds from the supplied repoRoot's own sources with repository-relative metafile paths", async () => {
    const dir = await makeFakeRepoRoot('9.9.9');
    const { script, thirdParty, metafile } = await buildArtifact({ repoRoot: dir, metafile: true });
    expect(script).toContain('v9.9.9');
    expect(thirdParty).toContain('fake-pkg');
    // absWorkingDir: repoRoot means metafile keys are repo-relative, never
    // absolute and never escaping the root with a leading '../'.
    const inputPaths = Object.keys(metafile.inputs);
    expect(inputPaths).toContain('src/main.ts');
    for (const p of inputPaths) {
      expect(p.startsWith('/')).toBe(false);
      expect(p.startsWith('../')).toBe(false);
    }
  });

  it('reads notices from an explicit noticesPath instead of <repoRoot>/THIRD-PARTY-NOTICES.md', async () => {
    const dir = await makeFakeRepoRoot('9.9.9');
    const altNotices = join(dir, 'candidate-notices.md');
    await writeFile(altNotices, '## only-in-alt-notices\n\nApache-2.0\n');
    const { thirdParty } = await buildArtifact({ repoRoot: dir, noticesPath: altNotices });
    expect(thirdParty).toContain('only-in-alt-notices');
    expect(thirdParty).not.toContain('fake-pkg');
  });

  it('honors buildStampOverride end-to-end', async () => {
    const dir = await makeFakeRepoRoot('9.9.9');
    const { script } = await buildArtifact({ repoRoot: dir, buildStampOverride: 'v0.0.0 (frozen)' });
    expect(script).toContain('v0.0.0 (frozen)');
    expect(script).not.toContain('v9.9.9');
  });
});

describe('writeArtifact outDir default follows repoRoot', () => {
  it('defaults outDir to <repoRoot>/dist when repoRoot is supplied without an explicit outDir', async () => {
    const dir = await makeFakeRepoRoot('9.9.9');
    await writeArtifact({ repoRoot: dir });
    await expect(readFile(join(dir, 'dist', 'sql.html'), 'utf8')).resolves.toContain('v9.9.9');
  });
});
