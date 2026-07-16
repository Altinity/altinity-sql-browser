# ADR-0002: Static typing — incremental strict TypeScript, dev-time only

- **Status:** Accepted — 2026-07-16; **phase 0 landed** 2026-07-16 (#262): the
  `tsc --noEmit` gate, and typed seam interfaces for `EditorPort`, the Spec
  editor/CodeViewer factories, `createApp`/`bootstrap`'s `env`, and the `app`
  controller surface as consumed by render modules. No existing module
  converted yet — phase 1+ (leaf-up conversion) is unstarted.
- **Date:** 2026-07-16
- **Context tracking:** roadmap #68; phase 0 #262
- **Related:** ADR-0001 (the slice-by-slice migration playbook this reuses)

## Context

The codebase has grown from a ~50 KB query executor to a ~26 k-LOC (plus ~30
k-LOC of tests) workbench with charts, dashboards, a saved-query Spec, and a
versioned Library codec — and the roadmap aims at Superset/Grafana-scale
dashboarding (ClickHouse-only). Quality is held today by the per-file
100/100/100/100 coverage gate, which is excellent at catching *behavioral*
regressions but blind to *contract drift*: a renamed field on a panel config, a
widened union in `chart-data`, or a changed `EditorPort` method signature only
fails when a test happens to exercise the exact call site. The project has
already felt this pressure and answered it once for *persisted* data — the
canonical JSON-Schema graph (`schemas/*`, ADR-0001 addenda #220/#224) with
build-time-compiled validators. In-memory contracts (the `app` controller,
`state.js` signals, `env` seams, chart/panel/filter config shapes flowing
between `core/` and `ui/`) have no equivalent static layer. Only ~30 of 108
source files carry any JSDoc today.

Two facts make TypeScript unusually cheap here:

- **The build does not change.** esbuild strips TS syntax natively; `src/main.js`
  → `dist/sql.html` stays a single-tool build (hard rule 4). Type *checking* is
  a separate `tsc --noEmit` dev/CI gate, exactly like the Ajv schema compile:
  `typescript` becomes a devDependency; the artifact and its four runtime deps
  are untouched.
- **Imports already use explicit `./x.js` specifiers**, which TypeScript
  resolves to `x.ts` natively — converting a file does not touch its importers.

## Decision

Adopt **TypeScript, strict, incrementally, dev-time only**:

1. **`tsc --noEmit` joins the gate.** A repo `tsconfig.json` with
   `strict: true`, `allowJs: true`, `checkJs: false`, `noEmit: true`,
   `erasableSyntaxOnly: true`, `moduleResolution: "bundler"`. Unconverted `.js`
   files stay unchecked; every converted `.ts` file is strict from day one —
   no `any`-spray, no `@ts-ignore` budget. `npm test` runs the check (like
   `check:schemas`).
2. **Erasable syntax only.** No enums, namespaces, or parameter properties —
   every `.ts` file must be type-strippable (the flag enforces it), so esbuild,
   Node type-stripping, and coverage source maps all stay trivial.
3. **Types for persisted data are generated, not written.** The canonical
   JSON-Schema graph stays the single source of truth; `.d.ts` for
   Library/saved-query/Spec shapes are emitted by the existing
   `build/compile-json-schemas.mjs` pipeline (json-schema-to-typescript,
   devDependency), committed, and staleness-checked like the validators.
4. **Convert seams and contracts first, then leaf-up.** Order of value:
   `EditorPort`/`env`/`CodeViewer` seam interfaces and the `app` controller
   surface (interface files, no behavior change) → `src/state.js` (typed
   signals) → `src/core/` (pure, no DOM — mechanical) → `src/net/` →
   `src/editor/` → `src/ui/`. One file (plus, optionally, its test) per change,
   same monotonic slice-by-slice discipline that carried the signals migration
   (ADR-0001). Conversion piggybacks on feature work — convert what you touch —
   plus a low-priority background track; no big-bang rename, no freeze.
5. **The coverage gate is unchanged in spirit.** `tests/vitest.config.ts`
   coverage `include` widens to `src/**/*.{js,ts}`; vitest runs TS natively and
   v8 coverage maps through source maps, so per-file 100/100/100/100 holds.
   Pure type declaration files (`*.d.ts`, `types.ts` with no runtime code) are
   excluded like `src/generated/`.
6. **Tests may lag.** A converted module's test file can stay `.js` (it still
   type-checks *against* the module's public types at the import boundary once
   converted itself); converting tests is worthwhile but never blocks the
   module.

## Options considered

| Option | Verdict |
|---|---|
| **Incremental strict `.ts`, leaf-up (this ADR)** | **Chosen** — build untouched, strict guarantees on everything converted, one proven migration playbook |
| JSDoc + `checkJs` (typed JS, no rename) | Rejected as the end state — the shapes that matter most here (Spec unions, panel discriminators, seam interfaces) are exactly where JSDoc syntax is worst, and we'd convert twice. Acceptable as a stopgap on hot `.js` files awaiting conversion |
| Big-bang rename (codemod all 108 files) | Rejected — churns every open branch and the entire 30 k-LOC test suite at once; violates the incremental discipline that de-risked ADR-0001 |
| Stay untyped, lean on coverage | Rejected — coverage catches behavior, not contract drift; the JSON-Schema pipeline is the project already admitting types are needed, just only at the persistence boundary |

## Consequences

- `typescript` (and `json-schema-to-typescript`) are devDependencies; runtime
  deps stay four; the artifact is byte-identical in kind (hard rule 4 intact).
- CLAUDE.md rule 1 gains "and `tsc --noEmit` must pass"; rule 2's seam
  descriptions gain their interface names once the seam interfaces land.
- CI adds one fast job (`tsc --noEmit` on the converted set).
- Mixed tree for a while: `.js` and `.ts` coexist indefinitely without
  friction (imports unchanged); progress is measurable (`git ls-files
  'src/**/*.ts' | wc -l`).
- Agents/contributors get machine-checked contracts at edit time — the highest
  leverage in a repo developed heavily by coding agents.
