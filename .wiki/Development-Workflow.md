# Development workflow

Back to [[Home]]. Related: [[Project-Skills]], [[Operations-Memory]].

## Routine loop

1. Read `CLAUDE.md`, the relevant issue, and its position in roadmap issue #68.
2. Put pure logic in `src/core`, transport in `src/net`, rendering in `src/ui`,
   editor integration behind `EditorPort`, and environment wiring in `main.js`.
3. Add or update the matching `tests/unit/<module>.test.js` in the same change.
4. Run `npm test`, then `npm run build`.
5. For UI-visible work, rely on CI for the full three-engine Playwright gate when
   local engines cannot launch; use a local browser harness for visual checks.
6. Reconcile `CHANGELOG.md`, the affected issue, roadmap #68, and ADR addenda when
   a substantive decision or behavior changes.

## Quality gate

Vitest uses happy-dom and V8 coverage. Thresholds are per-file: statements and
lines 100%, functions at least 95%, branches at least 90%. Most pure/network/state/
DOM/render modules are expected to remain 100/100/100/100; `ui/app.js` is the
documented glue exception. Do not hide weak files behind aggregate coverage.

## Commands

```sh
npm test
npm run build
npm run test:e2e
npm run local
```

CI uses Node 22 and `npm ci --no-audit --no-fund` against the committed
`package-lock.json`. Lockfile v3 records esbuild's platform packages as optional,
so npm installs the runner's binary while preserving one reproducible dependency
graph across Linux CI and macOS development. Playwright imports `/src` as raw ESM,
so a new bare dependency also needs import-map coverage in every affected E2E
harness.

Fresh worktrees have no `node_modules`; run `npm ci` before the test/build loop.
Use `npm install <package>` only for an intentional dependency update and commit
the resulting lockfile change. On older macOS hosts, all locally
installed Playwright engines may exit with `SIGTRAP` before test code runs even
after `npx playwright install chromium firefox webkit`; distinguish that launch
failure from an application test failure and rely on the three-engine CI gate.
When CI is the only executable browser gate, do not report the ship cycle as
complete until that E2E job has finished successfully; a pending check is not
verification.

## Working discipline

- Preserve user-owned dirty-tree changes.
- Track planned work in GitHub issues, not internal files under published `docs/`.
- File high-signal out-of-scope bugs with the `inbox` label.
- In attended `/ship`, ask for explicit merge approval, then the same session may
  merge the PR. In explicit unattended mode, do not ask: auto-merge only after a
  clean third ChatGPT pass at the current head and green required checks.
- Save genuinely surprising environment/test friction as project memory.

Canonical source: [`CLAUDE.md`](../CLAUDE.md),
[`tests/vitest.config.ts`](../tests/vitest.config.ts), and
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
