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

/** The #592 shell-primitive-guardrail rule codes
 * `findShellGuardrailSourceContractViolations` (`shell-body-mount` /
 * `shell-capture-escape`) and `findShellFixedPositionViolations`
 * (`shell-fixed-position`) may report. */
export type ShellGuardrailRule =
  | 'shell-body-mount'
  | 'shell-capture-escape'
  | 'shell-fixed-position';

/** One reported source-contract violation — a plain, JSON-serializable DTO.
 * `pos` is the offending AST node's own `getStart(sourceFile)` (or `0` for a
 * whole-file "the required construct is entirely absent" finding, which
 * names no single node): a stable, deterministic identity, never a
 * line/column and never required in a user-facing diagnostic. */
export interface SourceContractViolation {
  readonly rule: SidePanelRule | SurfaceLifecycleRule | ShellGuardrailRule;
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

/** One (filename, raw source) entry in a #592 shell-guardrail batch —
 * structurally identical to `SurfaceLifecycleSourceEntry` (both are just
 * "a repo-relative filename plus that file's complete, unmodified text"),
 * named separately so `findShellGuardrailSourceContractViolations`'s own
 * signature documents its own #592 contract rather than borrowing a #590-
 * named type. */
export interface ShellGuardrailSourceEntry {
  readonly filename: string;
  readonly source: string;
}

/**
 * The #592 shell-primitive-guardrail source contract (`shell-body-mount` +
 * `shell-capture-escape`), real-TypeScript-parser-backed, over ONE shared
 * parser batch for the complete `sources` set (never one parser process per
 * rule or per file).
 */
export function findShellGuardrailSourceContractViolations(
  sources: readonly ShellGuardrailSourceEntry[],
): SourceContractViolation[];

/** One `position: fixed` (optionally `!important`) CSS declaration found by
 * `scanFixedPositionDeclarations` — `selector` is the enclosing rule's own
 * normalized (whitespace-collapsed, comma-list-normalized) prelude; `atRule`
 * is the nearest enclosing at-rule's normalized prelude (e.g.
 * `'@media (max-width: 768px)'`), or `null` when the declaration sits at the
 * stylesheet's top level; `pos` is the declaration's own offset into the
 * scanned CSS text (the first non-whitespace, non-comment character). */
export interface FixedPositionDeclaration {
  readonly selector: string;
  readonly atRule: string | null;
  readonly pos: number;
}

/**
 * The focused CSS lexical scanner (Architecture decision 2, #592) — no CSS
 * parser dependency. Skips CSS block comments, respects quoted strings and
 * escapes, tracks brace nesting, and normalizes whitespace/comma-selector-
 * lists deterministically; see the `.mjs` implementation's own doc comment
 * for the full contract.
 */
export function scanFixedPositionDeclarations(source: string): FixedPositionDeclaration[];

/**
 * The `shell-fixed-position` guard's FORWARD half: every
 * `scanFixedPositionDeclarations` result in `cssSource` beyond its exact
 * `(selector, atRule)` fingerprint's approved COUNT (never a mere membership
 * check — a duplicate of an approved fingerprint is flagged too, PR #672
 * review pass 1).
 */
export function findShellFixedPositionViolations(
  cssSource: string,
  filename: string,
): SourceContractViolation[];

/**
 * The `shell-fixed-position` guard's REVERSE half (PR #672 review pass 1):
 * every frozen `SHELL_FIXED_POSITION_POLICY` fingerprint with ZERO matching
 * occurrences in `cssSource` — meaningful only against the real, complete
 * `src/styles.css` (see the `.mjs` implementation's own doc comment for why
 * this is a separate export from `findShellFixedPositionViolations` rather
 * than folded into it).
 */
export function findShellFixedPositionMissingBaselineViolations(
  cssSource: string,
  filename: string,
): SourceContractViolation[];
