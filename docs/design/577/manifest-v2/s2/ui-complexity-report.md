# UI complexity report — s2

Schema version 1. Counts run over esbuild-transformed
source (comments stripped, formatting normalized), never raw text.

**Deciding metric owned here:** `ownedProductionCode` — normalized lines by class.
Every other number below is explanatory and must not be voted with:
- `minifiedBytes` — ignores tree shaking, shared helpers, and complexity moved into a dependency
- `lcovBranches` — falls when mechanisms move into Preact — externalized, not eliminated
- `lcovFunctions` — falls when mechanisms move into Preact — externalized, not eliminated
- `lifecycleSites` — hidden/dataset/replaceChildren go syntactically invisible under a vDOM

## Owned production code (deciding)

| Class | Files | Normalized (code) | Physical | Non-code |
|---|---:|---:|---:|---:|
| domain | 4 | **341** | 1367 | 953 |
| plumbing | 9 | **1072** | 2091 | 920 |
| island | 2 | **203** | 603 | 359 |
| **total** | **15** | **1616** | **4061** | **2232** |

Physical LOC overstates code by **2232** non-code lines
(comments plus formatting-only lines). A raw-LOC comparison would have credited
those as complexity — which is the specific error this instrument exists to prevent.

## Explanatory metrics

| File | Class | Code | Minified B | DOM | Listeners | Effects | Disposal | focus() | lcov BRF/FNF |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| `src/application/left-nav.ts` | domain | 48 | 951 | 4 | 0 | 2 | 0 | 0 | _unmatched_ |
| `src/core/left-nav-layout.ts` | domain | 150 | 4836 | 0 | 0 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/app-shell.ts` | plumbing | _absent_ | — | — | — | — | — | — | — |
| `src/ui/drawer.ts` | plumbing | 56 | 993 | 2 | 0 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/left-nav-separator.ts` | island | 157 | 3170 | 12 | 14 | 2 | 4 | 0 | _unmatched_ |
| `src/ui/left-rail.ts` | plumbing | _absent_ | — | — | — | — | — | — | — |
| `src/ui/nav-sections.ts` | domain | 69 | 1464 | 2 | 0 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/right-inspector.ts` | plumbing | _absent_ | — | — | — | — | — | — | — |
| `src/ui/shell/adopt.ts` | plumbing | 17 | 237 | 1 | 0 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/shell/focus-settlement.ts` | plumbing | 21 | 294 | 0 | 0 | 0 | 0 | 1 | _unmatched_ |
| `src/ui/shell/right-inspector-view.ts` | plumbing | 192 | 2884 | 4 | 0 | 0 | 1 | 0 | _unmatched_ |
| `src/ui/shell/shell-context.types.ts` | plumbing | 0 | 0 | 0 | 0 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/shell/shell-host.ts` | plumbing | 391 | 7169 | 21 | 2 | 17 | 23 | 3 | _unmatched_ |
| `src/ui/shell/shell-layout.ts` | plumbing | 39 | 716 | 0 | 0 | 2 | 0 | 0 | _unmatched_ |
| `src/ui/shell/shell-view.ts` | plumbing | 192 | 3682 | 1 | 0 | 0 | 0 | 1 | _unmatched_ |
| `src/ui/sidebar-upper.ts` | domain | 74 | 1733 | 4 | 0 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/splitters.ts` | island | 46 | 1099 | 2 | 4 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/workbench/workbench-shell.ts` | plumbing | 164 | 5772 | 17 | 4 | 2 | 6 | 0 | _unmatched_ |

> 3 manifest file(s) absent in this state — measured against the one canonical
> manifest so every state covers an identical file set (a deletion must show up, not vanish).

> 15 file(s) had no lcov record — reported as unmatched, never as zero branches.

## Environment

- **commit**: `3f611b5e3a2566dd56d73170239b8ff116fc834e`
- **commitDirty**: `clean`
- **node**: `v25.9.0`
- **esbuild**: `0.28.1`
- **platform**: `darwin-arm64`
- **packageLock**: `sha256:5dd460cf3b874b6c`
