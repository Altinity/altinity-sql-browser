// #590 §1.9 / invariant (k) — the static-source architecture test backing the
// surface-retirement coordinator's "no lifecycle bypass outside the
// coordinator" claim, at the strength each layer honestly has (pass-7
// narrowing): compile-time elimination is already covered by
// `surface-accessor-contracts.test.ts`'s `@ts-expect-error` fixtures (the
// asymmetric `currentWorkspace` setter, the narrowed structural ports); THIS
// test is the third, weakest layer — a hand-rolled regex scan over `src/**`
// production sources, the same idiom `build/check-boundaries.mjs` (mechanical
// dependency-direction checks) and `typography-contract.test.js` (reading
// `src/styles.css` directly) already use in this repo. It fails the build on:
//   (a) an out-of-coordinator `.value` write naming the private signal
//       identifiers (identifier-anchored, so an alias/non-literal
//       right-hand-side is caught too — pass-7 finding);
//   (b) an out-of-coordinator `currentWorkspace = null` assignment anywhere
//       in `src/**` (a cast-bypassing write would still slip past `tsc`);
//   (c) a `disposeShell(`/`disposeCurrentSurface(`/`shell.dispose(` call
//       outside the coordinator region in `src/ui/app.ts`;
//   (d) any of those three declarations moving outside the marked region;
//   (e) the ADJACENCY hazard no compile-time mechanism can foreclose: a
//       `mainSurface`/`currentWorkspace` assignment lexically preceding a
//       `retireTo*`/retirement-hook call in the SAME function body (the
//       exported `retireTo*` ops are meant to be callable from outside the
//       coordinator by design, so this is the one shape compile scoping
//       cannot reject).
//
// Stays `.js`-idiom-compatible (reads files via `node:fs`) but is `.ts`,
// matching `tests/unit/side-panel-source-contract.test.ts`'s precedent (the
// repo carries no `@types/node`; `tests/types/node-fs-url.d.ts` is the
// minimal ambient shim both files share).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // tests/unit
const root = join(here, '..', '..'); // repo root
const srcDir = join(root, 'src');

const APP_TS = 'src/ui/app.ts';
const BEGIN_MARKER = '// #590-COORDINATOR-BEGIN';
const END_MARKER = '// #590-COORDINATOR-END';

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
}

function listSourceFiles(): string[] {
  return readdirSync(srcDir, { recursive: true })
    .filter((rel) => /\.(ts|js)$/.test(rel))
    // Generated code is never hand-edited and can't legally reference these
    // app.ts-local identifiers anyway — excluded for signal, not correctness.
    .filter((rel) => !rel.startsWith('generated' + '/') && !rel.includes(`${'generated'}/`))
    .map((rel) => 'src/' + rel.split('\\').join('/'));
}

const files = listSourceFiles();
// The markers ARE `//` line comments, so they must be located in the RAW
// (unstripped) text — `stripComments` runs per-slice AFTER the region split
// below, never on the whole file first (that would delete the markers
// before they could be found, silently collapsing the "region" to nothing
// and making every real disposeShell/disposeCurrentSurface call outside it
// look like a violation — caught the hard way while writing this test).
const rawSources = new Map<string, string>(
  files.map((relPath) => [relPath, readFileSync(join(root, relPath), 'utf8')]),
);
const fileSources = new Map<string, string>(
  [...rawSources].map(([relPath, raw]) => [relPath, stripComments(raw)]),
);

const appTsRawFull = rawSources.get(APP_TS);
if (!appTsRawFull) throw new Error(`fixture assumption failed: ${APP_TS} not found by the source walk`);

describe('#590 surface-lifecycle architecture (invariant (k))', () => {
  it('the coordinator markers exist exactly once each, in order, in src/ui/app.ts', () => {
    const beginIndex = appTsRawFull.indexOf(BEGIN_MARKER);
    const endIndex = appTsRawFull.indexOf(END_MARKER);
    expect(beginIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(beginIndex);
    expect(appTsRawFull.indexOf(BEGIN_MARKER, beginIndex + 1)).toBe(-1);
    expect(appTsRawFull.indexOf(END_MARKER, endIndex + 1)).toBe(-1);
  });

  const beginIndex = appTsRawFull.indexOf(BEGIN_MARKER);
  const endIndex = appTsRawFull.indexOf(END_MARKER);
  // Stripped PER SLICE (comments inside the region — which explain the
  // mechanism at length — must not themselves be scanned for forbidden
  // tokens; a comment mentioning `disposeShell(` in prose is not a call).
  const coordinatorRegion = stripComments(appTsRawFull.slice(beginIndex, endIndex));
  const outsideCoordinator = stripComments(
    appTsRawFull.slice(0, beginIndex) + appTsRawFull.slice(endIndex + END_MARKER.length),
  );

  it('the three teardown primitives are declared INSIDE the coordinator region', () => {
    expect(coordinatorRegion).toMatch(/\bconst\s+disposeShell\s*=/);
    expect(coordinatorRegion).toMatch(/\bconst\s+disposeCurrentSurface\s*=/);
    expect(coordinatorRegion).toMatch(/\bconst\s+committedWorkspaceSignal\s*[:=]/);
    expect(coordinatorRegion).toMatch(/\bconst\s+mainSurfaceSignal\s*[:=]/);
    // ...and NOT redeclared a second time outside it (a re-hoist would leave
    // one copy outside even if the marked region also still has one).
    expect(outsideCoordinator).not.toMatch(/\bconst\s+disposeShell\s*=/);
    expect(outsideCoordinator).not.toMatch(/\bconst\s+disposeCurrentSurface\s*=/);
    expect(outsideCoordinator).not.toMatch(/\bconst\s+committedWorkspaceSignal\s*[:=]/);
    expect(outsideCoordinator).not.toMatch(/\bconst\s+mainSurfaceSignal\s*[:=]/);
  });

  it('no out-of-coordinator call to disposeShell(/disposeCurrentSurface(/shell.dispose( exists in app.ts', () => {
    const forbidden = /\bdisposeShell\s*\(|\bdisposeCurrentSurface\s*\(|\bshell\s*\?\.\s*dispose\s*\(|\bshell\.dispose\s*\(/g;
    const hits = outsideCoordinator.match(forbidden) ?? [];
    expect(hits).toEqual([]);
  });

  it('no out-of-coordinator .value write names the private signal identifiers, in ANY src file', () => {
    // Identifier-anchored (pass-7 finding): matches regardless of the
    // right-hand expression, so an alias write
    // (`const next = null; committedWorkspaceSignal.value = next;`) is
    // caught the same as a literal one. Scoped to app.ts's own
    // out-of-coordinator text for app.ts, and to the WHOLE file for every
    // other source (the identifiers cannot legally appear there at all,
    // since they are never exported).
    const pattern = /\b(committedWorkspaceSignal|mainSurfaceSignal)\s*\.\s*value\s*=(?!=)/;
    for (const [relPath, source] of fileSources) {
      const haystack = relPath === APP_TS ? outsideCoordinator : source;
      expect(haystack, `${relPath} must not write the private signal outside the coordinator`).not.toMatch(pattern);
    }
  });

  it('no out-of-coordinator `currentWorkspace = null` assignment exists in ANY src file', () => {
    // A plain `.currentWorkspace = null` (not `===`/`!==`) — cast-bypassing
    // writes (`as never`/`as any`) still match this token, which is exactly
    // the defense-in-depth a pure `tsc` check cannot provide.
    const pattern = /\.currentWorkspace\s*=\s*null\b(?!\s*[=!]=)/;
    for (const [relPath, source] of fileSources) {
      const haystack = relPath === APP_TS ? outsideCoordinator : source;
      expect(haystack, `${relPath} must not assign currentWorkspace = null outside the coordinator`).not.toMatch(pattern);
    }
  });

  // The adjacency hazard (pass-7 finding): no compile-time mechanism can
  // foreclose a two-STATEMENT sequence when the second statement is an
  // exported function meant to be callable from outside the coordinator.
  // Scoped to one function body at a time (bracket-matched from each
  // `=> {`/`) {` opener) — same-function-body precision, matching the
  // plan's own stated residual-risk boundary (a split across HELPER
  // functions is explicitly out of this rule's reach, per §1.9).
  function functionBodies(source: string): string[] {
    const bodies: string[] = [];
    const opener = /(?:=>|\))\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = opener.exec(source))) {
      const start = match.index + match[0].length - 1; // index of the '{'
      let depth = 0;
      let i = start;
      for (; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth === 0) bodies.push(source.slice(start + 1, i));
    }
    return bodies;
  }

  it('no function body writes mainSurface/currentWorkspace lexically before calling a retireTo*/retirement hook', () => {
    const writePattern = /\.(?:mainSurface|currentWorkspace)\s*=(?!=)/;
    const retirePattern = /\bretireTo\w*\s*\(/;
    for (const [relPath, source] of fileSources) {
      for (const body of functionBodies(source)) {
        const writeIndex = body.search(writePattern);
        if (writeIndex === -1) continue;
        const retireIndex = body.search(retirePattern);
        const violates = retireIndex !== -1 && writeIndex < retireIndex;
        expect(violates, `${relPath} has a mainSurface/currentWorkspace write lexically before a retireTo*() call in one function body`).toBe(false);
      }
    }
  });
});
