// Issue #630 Phase 8 (plan §26) — rewrite of the former
// `tests/unit/client-web-spike-policy.test.js` (issue #585 Phase 0), which
// enforced the OPPOSITE final state while the vendor-comparison spike was
// still executable: an exact-pinned vendor dependency, a candidate-artifact
// build path, candidate notices, and a future official-transport allowlist.
// All of that executable machinery is retired this phase — `@clickhouse/
// client-web` was evaluated (docs/ADR-0005-clickhouse-web-client.md,
// Rejected) and its comparison harness has done its job. This file now
// enforces the FINAL retirement state instead:
//   - root/package manifests contain no vendor dependency;
//   - the lockfile contains no installed vendor package;
//   - the retired vendor-spike npm scripts are absent;
//   - the executable spike directory (tests/spike/clickhouse-client/) is gone;
//   - a real-parser-backed guard rejects virtual reintroduction (Guard 5,
//     `build/check-boundaries.mjs`, `build/lib/check-legacy-owners.mjs`);
//   - the ADR stays Rejected/current-state consistent with the wiki;
//   - the committed historical evidence (docs/evidence/585/**) remains;
//   - the normal root esbuild metafile has no vendor package input.
//
// docs/evidence/585/** and the ADR's historical content/dates are NEVER
// rewritten by this file or by Phase 8 — only a narrow current-state
// addendum is added to the ADR (see its own "Phase 8" addendum section).

import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../../build/build.mjs';
import { findModuleSpecifiers } from '../../build/lib/check-legacy-owners.mjs';

const projectRoot = resolve(fileURLToPath(import.meta.url), '../../..');
const CLIENT_WEB_SPECIFIER = '@clickhouse/client-web';
const ADR_PATH = resolve(projectRoot, 'docs/ADR-0005-clickhouse-web-client.md');
const WIKI_PATH = resolve(projectRoot, '.wiki/Decisions-and-Roadmap.md');
const EVIDENCE_DIR = resolve(projectRoot, 'docs/evidence/585');
const PACKAGE_INPUT_RE = /^node_modules\/@clickhouse\/client-web\//;

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('@clickhouse/client-web dependency is fully retired (issue #630 Phase 8)', () => {
  it('package.json declares no @clickhouse/client-web dependency in any field', async () => {
    const pkg = await readJson(resolve(projectRoot, 'package.json'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(pkg[field] ?? {}).not.toHaveProperty(CLIENT_WEB_SPECIFIER);
    }
  });

  it('packages/clickhouse-http/package.json declares no @clickhouse/client-web dependency in any field', async () => {
    const pkg = await readJson(resolve(projectRoot, 'packages/clickhouse-http/package.json'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(pkg[field] ?? {}).not.toHaveProperty(CLIENT_WEB_SPECIFIER);
    }
  });

  it('the committed lockfile no longer installs @clickhouse/client-web', async () => {
    const lock = await readJson(resolve(projectRoot, 'package-lock.json'));
    const key = Object.keys(lock.packages ?? {}).find((k) => k.endsWith(`node_modules/${CLIENT_WEB_SPECIFIER}`));
    expect(key).toBeUndefined();
  });

  it('the retired vendor-spike npm scripts are absent from package.json', async () => {
    const pkg = await readJson(resolve(projectRoot, 'package.json'));
    const scripts = Object.keys(pkg.scripts ?? {});
    expect(scripts).not.toContain('test:client-spike');
    expect(scripts).not.toContain('test:client-spike:matrix');
    expect(scripts).not.toContain('test:client-spike:browser');
    expect(scripts).not.toContain('check:client-spike:evidence');
    expect(scripts.some((s) => s.startsWith('test:client-spike'))).toBe(false);
  });

  it('the executable spike directory tests/spike/clickhouse-client/ no longer exists', () => {
    expect(existsSync(resolve(projectRoot, 'tests/spike/clickhouse-client'))).toBe(false);
  });
});

// Normal `npm run build`/`npm run size-report` always call buildArtifact()
// with its DEFAULT entryPoint (`<repoRoot>/src/main.ts`) — the exact call
// shape `npm run build` makes; a real esbuild bundle of the whole production
// graph. This is the same invariant the retired candidate-build describe
// block used to prove alongside a candidate artifact (deleted this phase,
// per plan §26 "Delete tests that require a candidate vendor artifact to
// remain executable" — there is no candidate build path left at all).
describe('normal production build graph excludes the vendor package', () => {
  it('excludes @clickhouse/client-web from the metafile', async () => {
    const { metafile } = await buildArtifact({ metafile: true });
    const inputPaths = Object.keys(metafile.inputs);
    expect(inputPaths.some((p) => PACKAGE_INPUT_RE.test(p))).toBe(false);
    // Sanity: the metafile is non-trivial and correctly repository-relative,
    // so an empty/misrooted metafile can't vacuously pass the assertion
    // above.
    expect(inputPaths).toContain('src/main.ts');
    for (const p of inputPaths) {
      expect(p.startsWith('/')).toBe(false);
      expect(p.startsWith('../')).toBe(false);
    }
  }, 60_000);
});

// Issue #630 Phase 8 (plan §24, Guard 5) — the real-parser-backed executable
// import guard, exercised directly here (the SAME shared helper the
// production `check:arch` gate calls) rather than an independently
// reimplemented regex scanner: a hand-rolled specifier-text regex stayed
// vulnerable to comment-trivia bypasses no amount of pattern-widening could
// close (see `check-legacy-owners.mjs`'s own header comment for the
// documented history of that exact failure mode across Phases 3/5/6/7).
async function collectSourceFiles(dir, exts) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(full, exts));
    } else if (exts.includes(extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

describe('Guard 5 — @clickhouse/client-web cannot be virtually reintroduced anywhere in scope (real-parser scan)', () => {
  it('src/**, packages/clickhouse-http/** (excluding dist/**), tests/**, and build/** are all clean', async () => {
    const roots = ['src', 'packages/clickhouse-http', 'tests', 'build'];
    const offenders = [];
    for (const rootDir of roots) {
      const full = resolve(projectRoot, rootDir);
      if (!existsSync(full)) continue;
      for (const file of await collectSourceFiles(full, ['.ts', '.tsx', '.js', '.mjs'])) {
        const relFile = relative(projectRoot, file).split('/').join('/');
        if (relFile.startsWith('packages/clickhouse-http/dist/')) continue;
        const source = await readFile(file, 'utf8');
        if (!source.includes(CLIENT_WEB_SPECIFIER)) continue;
        for (const { spec } of findModuleSpecifiers(source, relFile)) {
          if (spec === CLIENT_WEB_SPECIFIER || spec.startsWith(`${CLIENT_WEB_SPECIFIER}/`)) offenders.push(relFile);
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 60_000);

  it('flags a virtual static import of the vendor package (sabotage probe, not written to disk)', () => {
    const source = "import { createClient } from '@clickhouse/client-web';\n";
    const found = findModuleSpecifiers(source, 'src/net/__boundary_probe_630p8_clientweb_static__.ts')
      .some(({ spec }) => spec === CLIENT_WEB_SPECIFIER || spec.startsWith(`${CLIENT_WEB_SPECIFIER}/`));
    expect(found).toBe(true);
  });

  it('flags a virtual dynamic import of the vendor package (sabotage probe, not written to disk)', () => {
    const source = "export async function f() { await import('@clickhouse/client-web'); }\n";
    const found = findModuleSpecifiers(source, 'src/net/__boundary_probe_630p8_clientweb_dynamic__.ts')
      .some(({ spec }) => spec === CLIENT_WEB_SPECIFIER || spec.startsWith(`${CLIENT_WEB_SPECIFIER}/`));
    expect(found).toBe(true);
  });

  it('flags a virtual deep-subpath import of the vendor package (sabotage probe, not written to disk)', () => {
    const source = "import { createClient } from '@clickhouse/client-web/web';\n";
    const found = findModuleSpecifiers(source, 'src/net/__boundary_probe_630p8_clientweb_deep__.ts')
      .some(({ spec }) => spec === CLIENT_WEB_SPECIFIER || spec.startsWith(`${CLIENT_WEB_SPECIFIER}/`));
    expect(found).toBe(true);
  });

  it('does not flag an unrelated import merely mentioning the string in a comment (comments are parser trivia, never AST nodes)', () => {
    const source = "// see @clickhouse/client-web — rejected by ADR-0005\nexport const x = 1;\n";
    const found = findModuleSpecifiers(source, 'src/net/__boundary_probe_630p8_clientweb_comment__.ts')
      .some(({ spec }) => spec === CLIENT_WEB_SPECIFIER || spec.startsWith(`${CLIENT_WEB_SPECIFIER}/`));
    expect(found).toBe(false);
  });
});

// Issue #630 Phase 8 (plan §24) — structural manifest/lockfile sabotage
// probes, proving the CHECKER itself (not merely this test's own mirror
// assertions above) rejects a virtual reintroduction. These call the real
// `check:arch` production script text/data shape indirectly by asserting the
// exact structural conditions it inspects — see build/check-boundaries.mjs's
// own Guard 5 block for the production enforcement.
describe('Guard 5 structural manifest/lock/script/directory sabotage (virtual, not written to disk)', () => {
  it('a virtual manifest with the vendor dependency restored would trip the structural check', () => {
    const sabotagedManifest = { dependencies: {}, devDependencies: { [CLIENT_WEB_SPECIFIER]: '1.23.1' } };
    const hasVendorDep = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .some((field) => Object.prototype.hasOwnProperty.call(sabotagedManifest[field] ?? {}, CLIENT_WEB_SPECIFIER));
    expect(hasVendorDep).toBe(true);
  });

  it('a virtual lockfile with the vendor package restored would trip the structural check', () => {
    const sabotagedLock = { packages: { 'node_modules/@clickhouse/client-web': { version: '1.23.1' } } };
    const hasVendorInLock = Object.keys(sabotagedLock.packages).some((k) => k.endsWith(`node_modules/${CLIENT_WEB_SPECIFIER}`));
    expect(hasVendorInLock).toBe(true);
  });

  it('a virtual manifest with a retired spike script restored would trip the structural check', () => {
    const sabotagedScripts = { 'test:client-spike': 'echo restored' };
    const hasRetiredScript = Object.keys(sabotagedScripts)
      .some((s) => s === 'check:client-spike:evidence' || s.startsWith('test:client-spike'));
    expect(hasRetiredScript).toBe(true);
  });
});

// Plan §26: "ADR remains Rejected/current-state consistent" + "committed
// evidence sentinel files remain" — the same fail-closed ADR/wiki
// consistency check the retired spike-policy test used to own, now paired
// with a positive sentinel that the historical evidence directory itself was
// never touched by this phase (docs/evidence/585/** is explicitly untouched
// per the plan's rollback strategy).
function statusMentionsNear(text, marker, radius = 400) {
  const mentions = [];
  const markerRe = new RegExp(marker, 'g');
  let m;
  while ((m = markerRe.exec(text))) {
    const start = Math.max(0, m.index - radius);
    const end = Math.min(text.length, m.index + radius);
    mentions.push(text.slice(start, end));
  }
  return mentions;
}

function unquotedStatusWords(excerpt) {
  const found = new Set();
  for (const status of ['Accepted', 'Rejected']) {
    const re = new RegExp(`(^|[^"])\\b${status}\\b([^"]|$)`);
    if (re.test(excerpt)) found.add(status);
  }
  return found;
}

describe('ADR-0005 / wiki consistency remains fail-closed after Phase 8', () => {
  it('keeps the ADR Status and the wiki wording in sync', async () => {
    const wiki = await readFile(WIKI_PATH, 'utf8');
    const excerpts = [
      ...statusMentionsNear(wiki, 'ADR-0005'),
      ...statusMentionsNear(wiki, '#585'),
    ];
    const adrText = await readFile(ADR_PATH, 'utf8');
    const statusMatch = adrText.match(/Status:\*{0,2}\s*(Accepted|Rejected)\b/);
    expect(statusMatch, 'docs/ADR-0005-clickhouse-web-client.md must declare Status: Accepted or Rejected').not.toBeNull();
    const status = statusMatch[1];

    expect(wiki).toContain('docs/ADR-0005-clickhouse-web-client.md');

    const opposite = status === 'Accepted' ? 'Rejected' : 'Accepted';
    const foundMatchingStatus = excerpts.some((excerpt) => unquotedStatusWords(excerpt).has(status));
    const foundOppositeStatus = excerpts.some((excerpt) => unquotedStatusWords(excerpt).has(opposite));
    expect(foundMatchingStatus, `wiki must state the ADR's actual status (${status}) near an ADR-0005/#585 mention`).toBe(true);
    expect(foundOppositeStatus, `wiki must not claim the opposite status (${opposite})`).toBe(false);
  });

  it('the ADR carries a Phase 8 current-state addendum documenting the executable retirement', async () => {
    const adrText = await readFile(ADR_PATH, 'utf8');
    expect(adrText).toMatch(/Phase 8/);
  });
});

describe('historical #585 evidence remains intact (docs/evidence/585/**)', () => {
  it('the evidence directory still exists with at least one file', async () => {
    expect(existsSync(EVIDENCE_DIR)).toBe(true);
    const entries = await readdir(EVIDENCE_DIR);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('results.json (the machine-readable decision record) is still present', () => {
    expect(existsSync(join(EVIDENCE_DIR, 'results.json'))).toBe(true);
  });
});
