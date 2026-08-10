// Issue #643 — the strict-`.ts` declaration boundary over
// `check-legacy-owners.mjs`'s two source-contract analyzers
// (`findSidePanelSourceContractViolations` /
// `findSurfaceLifecycleSourceContractViolations`), consumed by
// `tests/unit/side-panel-source-contract.test.ts` and
// `tests/unit/surface-lifecycle-arch.test.ts`. Deliberately declares ONLY
// plain-data APIs — no `SourceFile`, no compiler `Node`, no `SyntaxKind`, no
// untyped callback parameter ever crosses this boundary, so a strict `.ts`
// caller never needs `any`/`@ts-ignore`/`@ts-expect-error` to consume it.
// `npm run check:types` proves declaration resolution and caller
// conformance; it does NOT prove this file accurately models the runtime
// `.mjs` shape — the two test files' own synthetic-source assertions are
// what actually exercise the real exports and validate the returned DTOs.
//
// This file intentionally does not declare every export the `.mjs` module
// has (the #630/#642 legacy-owner/package helpers, `manifestDependencyFields`
// et al.) — only the #643 side-panel/surface-lifecycle surface strict `.ts`
// callers need. Every other consumer of this module stays plain `.js`/`.mjs`
// (checkJs:false), so this declaration file never needs to describe them.

/** The #587 AC5 side-panel source-contract rule codes
 * `findSidePanelSourceContractViolations` may report. */
export type SidePanelRule =
  | 'workbench-sidepanel-mention'
  | 'workbench-history-compare'
  | 'app-preferences-panel-id'
  | 'state-panel-label'
  | 'app-side-panel-comparison'
  | 'app-shell-panel-def'
  | 'app-shell-panel-id'
  | 'app-shell-host-accessor'
  | 'side-panels-type-alias';

/** The #590 invariant (k) surface-lifecycle source-contract rule codes
 * `findSurfaceLifecycleSourceContractViolations` may report. */
export type SurfaceLifecycleRule =
  | 'surface-protected-declaration'
  | 'surface-teardown-call'
  | 'surface-signal-write'
  | 'surface-current-workspace-null'
  | 'surface-retirement-ordering';

/** One reported source-contract violation — a plain, JSON-serializable DTO.
 * `pos` is the offending AST node's own `getStart(sourceFile)` (or `0` for a
 * whole-file "the required construct is entirely absent" finding, which
 * names no single node): a stable, deterministic identity, never a
 * line/column and never required in a user-facing diagnostic. */
export interface SourceContractViolation {
  readonly rule: SidePanelRule | SurfaceLifecycleRule;
  readonly filename: string;
  readonly pos: number;
  readonly detail: string;
}

/**
 * The #587 AC5 side-panel source contract, real-TypeScript-parser-backed.
 * `filename` selects which (if any) rule group applies; a `filename` this
 * function does not recognize returns `[]` without parsing `source` at all.
 * Callers may pass either a real guarded file's current contents (with its
 * real repo-relative `filename`) or synthetic probe source under the SAME
 * `filename` to exercise that file's specific rule(s) in isolation.
 */
export function findSidePanelSourceContractViolations(
  source: string,
  filename: string,
): SourceContractViolation[];

/** One (filename, raw source) entry in a surface-lifecycle batch — `source`
 * is the file's complete, unmodified text (comments included; nothing is
 * stripped or reconstructed before parsing). */
export interface SurfaceLifecycleSourceEntry {
  readonly filename: string;
  readonly source: string;
}

/** `appFile` must be one of `sources`' own `filename` values.
 * `coordinatorStart`/`coordinatorEnd` are the raw byte offsets of the
 * `#590-COORDINATOR-BEGIN`/`#590-COORDINATOR-END` marker comments in
 * `appFile`'s OWN raw source (the caller locates them there directly — the
 * markers are themselves `//` comments, so they intentionally stay outside
 * this function's AST-based analysis). */
export interface SurfaceLifecycleOptions {
  readonly appFile: string;
  readonly coordinatorStart: number;
  readonly coordinatorEnd: number;
}

/**
 * The #590 invariant (k) surface-lifecycle source contract, real-
 * TypeScript-parser-backed, over one shared parser batch for the complete
 * `sources` set (never one parse per file). Throws if `options.appFile` is
 * not among `sources`' filenames.
 */
export function findSurfaceLifecycleSourceContractViolations(
  sources: readonly SurfaceLifecycleSourceEntry[],
  options: SurfaceLifecycleOptions,
): SourceContractViolation[];
