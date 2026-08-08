# `@altinity/clickhouse-http` repository extraction handoff

Written by issue #630 Phase 8, for issue #639 ("extract `packages/clickhouse-http`
into its own repository and publish it"). Phase 8 stabilizes the package
in-tree so it can be moved unchanged; #639 creates/moves/releases externally.

## 1. Scope

Issue #630 (this repository, SQL Browser) made `packages/clickhouse-http`
independently buildable, testable, and packable, with a publication-shaped
manifest, while it still physically lives inside this repository as an npm
workspace. It deliberately does **not**:

- create `Altinity/clickhouse-http` (or any external repository);
- publish an npm release;
- choose the first externally released semver;
- change SQL Browser's dependency on the package from a workspace
  dependency to an externally released one;
- delete the workspace package from this repository;
- add external-repository CI/release automation;
- redesign the package's source, public API, build, or test architecture.

Issue #639 owns every item above. At the point Phase 8 completed, issue #630
itself is closed.

## 2. Package tree that moves unchanged

```
packages/clickhouse-http/
  .gitignore
  LICENSE
  README.md
  package.json
  build.mjs
  tsconfig.json
  tsconfig.build.json
  vitest.config.ts
  src/**
  test/**
```

Generated `dist/`, `coverage/`, `test-results/`, and `playwright-report/`
(all gitignored) are excluded — a fresh `npm run build`/`npm test`/
`npm run test:pack`/`npm run test:browser` regenerates them in the new
location exactly as it does here.

## 3. Mechanical extraction

Conceptual operation:

```sh
cp -a packages/clickhouse-http/. <new-repository-root>/
```

or an equivalent history-preserving move (`git subtree split`, `git filter-repo`,
etc.) owned by #639's own implementation. No package source, public API, or
test-path rewrite should be required — the package's own build/test
tooling already resolves everything relative to its own directory (see
`build.mjs`/`vitest.config.ts`/`playwright.config.js`'s own `here`-relative
paths), and its manifest declares its own complete `devDependencies` even
though npm hoists most of them in this workspace today (`build/lib/
check-legacy-owners.mjs`-backed architecture Guard 1 is what keeps this
true: a package tool/test importing an undeclared root-hoisted dependency
fails `check:arch`).

## 4. Commands actually tested in Phase 8

Every command below was run for real as part of this phase's own acceptance
— see §5 for what `test:pack` specifically proves. "Tested" here means
Phase 8's own acceptance actually executed the command, not that it is
merely documented.

Inside the package directory:

```sh
npm run check:types
npm run build
npm test
npm run test:pack
npm run test:browser
```

Monorepo equivalents, run from the SQL Browser repository root (what root
`npm run check:types`/`build`/`test`/`test:clickhouse-http:pack`/
`test:clickhouse-http:browser` actually invoke):

```sh
npm run check:types --workspace @altinity/clickhouse-http
npm run build --workspace @altinity/clickhouse-http
npm run test --workspace @altinity/clickhouse-http
npm run test:pack --workspace @altinity/clickhouse-http
npm run test:browser --workspace @altinity/clickhouse-http
```

## 5. What `test:pack` proves

`packages/clickhouse-http/test/isolated-package.mjs` (invoked by
`npm run test:pack`, which builds the package first) runs this exact
sequence:

1. **Build prerequisites** — asserts `dist/index.js`, `dist/index.d.ts`,
   `README.md`, and `LICENSE` exist, and that the manifest's `main`/
   `types`/`exports["."]` all target `dist/**`.
2. **Real `npm pack`** — `npm pack --json --ignore-scripts --pack-destination
   <temp-dir>` from the package directory, into an OS-temp directory
   outside this repository. Parses npm's own JSON output for the real
   tarball filename (never assumed).
3. **Tarball inventory** — extracts the real tarball and asserts it contains
   exactly `package.json`, `README.md`, `LICENSE`, and `dist/**` (only
   `.js`/`.d.ts` files under `dist/`) — no `src/**`, `test/**`, `build.mjs`,
   `tsconfig*.json`, `vitest.config.*`, or `coverage/**`. Asserts the packed
   manifest exposes only `"."`, targets built files, and carries no runtime
   dependency map.
4. **Isolated install** — creates a second OS-temp fixture outside this
   repository (`{ "private": true, "type": "module" }`), then runs
   `npm install --offline --ignore-scripts --no-audit --no-fund
   --no-package-lock --no-save <absolute-tarball-path>` with `NODE_PATH`
   cleared. Asserts the installed package directory contains no `src/`.
5. **ESM proof** — a `consumer.mjs` in the fixture imports `chUrl`,
   `createClickHouseHttpClient`, and `parseClickHouseType` from
   `@altinity/clickhouse-http` and runs under Node. Asserts
   `import.meta.resolve('@altinity/clickhouse-http')` terminates at
   `<fixture>/node_modules/@altinity/clickhouse-http/dist/index.js` and
   never reaches this repository.
6. **TypeScript declaration proof** — a `consumer.ts` in the fixture imports
   both runtime and type exports and compiles with `module`/
   `moduleResolution: NodeNext`, `noEmit: true`, no `paths`/project
   references/workspace mappings. Runs `tsc --traceResolution` and asserts
   resolution terminates at
   `<fixture>/node_modules/@altinity/clickhouse-http/dist/index.d.ts`, never
   reaching `packages/clickhouse-http/src/**` or this repository's own
   `src/**`.
7. **Cleanup** — every temporary directory is deleted in a `finally` block,
   on every path including a mid-sequence failure.

This is a genuinely running, isolated proof, not prose — CI's `test` job
runs `npm run test:clickhouse-http:pack` on every applicable push/PR.

## 6. SQL Browser consumer references for #639

When the workspace package is eventually removed from this repository,
these are every SQL Browser-side reference #639 needs to retarget onto the
externally released package (all deliberately intentional composition
today, not migration debt):

- **Root workspace dependency** (`package.json`'s `workspaces` array and its
  `dependencies["@altinity/clickhouse-http"]`) → a released semver range.
- **Raw-ESM import maps** currently pointing at the workspace package
  SOURCE (`"@altinity/clickhouse-http": "/packages/clickhouse-http/src/index.js"`)
  in root Playwright e2e harnesses that load `/src/**` unbundled
  (`tests/e2e/authenticated-clickhouse-request.html` is the one that still
  needs this after Phase 8; grep `tests/e2e/*.html` for the same import-map
  entry to find any others) → either a published package's own resolution
  (no import map needed at all once it is a real installed dependency) or a
  path into the externally released package's own build output, per
  whatever #639's release format is.
- **Root e2e imports of the package-owned test fixture**
  (`tests/e2e/authenticated-clickhouse-request.spec.js` and
  `tests/e2e/export-post-header-cancel.spec.js`, both importing
  `packages/clickhouse-http/test/browser/fault-server.mjs` directly) → once
  the workspace tree is gone, either vendor a copy of this fixture into SQL
  Browser's own e2e helpers, or depend on it being re-exported by the
  released package's own test-utilities surface (a new decision #639 makes,
  not implied by anything in Phase 8).
- **Root architecture guard entries** naming `packages/clickhouse-http/**`
  by path (`build/check-boundaries.mjs`'s Rules A/B/C and the Phase-8 Guard
  1/2 blocks) → once the workspace directory is gone, these rules become
  inert (the existing "directory not born yet — rule activates with it"
  convention already handles this gracefully) and can be deleted as dead
  code in the same change that deletes the workspace.
- **Workspace declaration** (`package.json`'s `workspaces` array) → removed.
- **Workspace deletion** (`packages/clickhouse-http/` itself) → deleted only
  after the external repository/release has been integrated and this
  repository's own e2e/unit suite passes against the released dependency.

## 7. #639's own release work (explicitly out of Phase 8's scope)

- Create the external repository (`Altinity/clickhouse-http` or equivalent).
- External repository's own lockfile, CI, and release automation.
- Flip `version`/`private` in the package manifest for the first real
  release (Phase 8 deliberately keeps `"version": "0.0.0"`,
  `"private": true` — proving publication SHAPE, not publishing anything).
- Publish to whatever registry #639 selects.
- Retarget SQL Browser's dependency onto the released package (§6 above).
- Re-run SQL Browser's integration/e2e suite against the released
  dependency instead of the workspace.
- Remove the workspace from this repository once the above is verified.

## 8. Rollback

A copied-but-not-cut-over external repository can be abandoned at any point
without reversing this package's in-tree architecture — the workspace
package keeps working exactly as it does today regardless of whether an
external copy exists, was published, or was abandoned. Nothing in Phase 8's
own architecture depends on the external repository existing.
