// The Docker image serves these bytes directly; this test keeps the static
// encoding sidecars tied exactly to the ClickHouse/release sql.html artifact.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompress, gunzip, zstdDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import { writeArtifact } from '../../build/build.mjs';

const decompressBrotli = promisify(brotliDecompress);
const decompressGzip = promisify(gunzip);
const decompressZstd = promisify(zstdDecompress);
const tempDirs = [];

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
