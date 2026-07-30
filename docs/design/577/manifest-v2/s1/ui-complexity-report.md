# UI complexity report — s1

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
| plumbing | 5 | **742** | 1766 | 949 |
| island | 2 | **203** | 603 | 359 |
| **total** | **11** | **1286** | **3736** | **2261** |

Physical LOC overstates code by **2261** non-code lines
(comments plus formatting-only lines). A raw-LOC comparison would have credited
those as complexity — which is the specific error this instrument exists to prevent.

## Explanatory metrics

| File | Class | Code | Minified B | DOM | Listeners | Effects | Disposal | focus() | lcov BRF/FNF |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| `src/application/left-nav.ts` | domain | 48 | 951 | 4 | 0 | 2 | 0 | 0 | _unmatched_ |
| `src/core/left-nav-layout.ts` | domain | 150 | 4836 | 0 | 0 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/app-shell.ts` | plumbing | 340 | 7856 | 41 | 3 | 14 | 23 | 4 | _unmatched_ |
| `src/ui/drawer.ts` | plumbing | 56 | 993 | 2 | 0 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/left-nav-separator.ts` | island | 157 | 3170 | 12 | 14 | 2 | 4 | 0 | _unmatched_ |
| `src/ui/left-rail.ts` | plumbing | 51 | 775 | 2 | 0 | 1 | 6 | 3 | _unmatched_ |
| `src/ui/nav-sections.ts` | domain | 69 | 1464 | 2 | 0 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/right-inspector.ts` | plumbing | 131 | 2048 | 10 | 0 | 0 | 1 | 1 | _unmatched_ |
| `src/ui/shell/adopt.ts` | plumbing | _absent_ | — | — | — | — | — | — | — |
| `src/ui/shell/focus-settlement.ts` | plumbing | _absent_ | — | — | — | — | — | — | — |
| `src/ui/shell/right-inspector-view.ts` | plumbing | _absent_ | — | — | — | — | — | — | — |
| `src/ui/shell/shell-context.types.ts` | plumbing | _absent_ | — | — | — | — | — | — | — |
| `src/ui/shell/shell-host.ts` | plumbing | _absent_ | — | — | — | — | — | — | — |
| `src/ui/shell/shell-layout.ts` | plumbing | _absent_ | — | — | — | — | — | — | — |
| `src/ui/shell/shell-view.ts` | plumbing | _absent_ | — | — | — | — | — | — | — |
| `src/ui/sidebar-upper.ts` | domain | 74 | 1733 | 4 | 0 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/splitters.ts` | island | 46 | 1099 | 2 | 4 | 0 | 0 | 0 | _unmatched_ |
| `src/ui/workbench/workbench-shell.ts` | plumbing | 164 | 5772 | 17 | 4 | 2 | 6 | 0 | _unmatched_ |

> 7 manifest file(s) absent in this state — measured against the one canonical
> manifest so every state covers an identical file set (a deletion must show up, not vanish).

> 11 file(s) had no lcov record — reported as unmatched, never as zero branches.

## Environment

- **commit**: `7e7c8c4b6d8c5853d4e59dc599c5705f8e9cacab`
- **commitDirty**: `clean`
- **node**: `v25.9.0`
- **esbuild**: `0.28.1`
- **platform**: `darwin-arm64`
- **packageLock**: `sha256:9042ec0421903e38`
