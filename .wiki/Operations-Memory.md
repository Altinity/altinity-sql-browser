# Operations memory

Back to [[Home]]. Related: [[Deployment-and-Security]], [[Development-Workflow]].

This page is the shared durable operational memory for Claude and Codex. Some entries
were imported from Claude's historical per-project memory archive, but this wiki is
the actionable source; do not require access to that archive to use an entry safely.

## Development and verification

- `bash-grep-intercepted`: prefer `rg`; old Claude shell hooks made piped `grep`
  unreliable.
- `playwright-e2e-ci-only`: full Playwright engines may not launch locally; CI is
  authoritative for the three-browser gate.
- `e2e-harness-bare-imports`: raw-ESM harnesses need import maps for bundled deps.
- `extraction-drops-perfile-coverage`: extraction can reveal previously hidden
  uncovered functions; inspect lcov FN/FNDA rather than weakening the gate.
- `local-ui-harness-verify`: a throwaway import-map harness can verify UI without
  ClickHouse; screenshots must stay inside the workspace.
- `local-tailscale-sql-handler`: for manual testing through the gpu-01 Tailscale
  proxy, serve the built app with `SQL_BROWSER_PROBE=0 python3 build/local.py`
  (or `npm run local` when probing is desired), not `python -m http.server`.
  The project handler maps `/sql`, `/sql/dashboard`, and config routes correctly;
  a plain static server exposes only `/sql.html`, so
  `https://gpu-01.cama-barbel.ts.net/sql` returns 404 even though the artifact is
  present. Verify both `http://127.0.0.1:8900/sql` and the Tailscale `/sql` URL
  with GET requests because `build/local.py` intentionally does not implement
  HEAD.
- `node25-localstorage-test-flake`: the historical Node 25 flake was fixed; treat
  new failures as regressions.
- `vitest4-local-node22`: after the Vitest 4 migration, run both dependency
  installation and the gate under Node 22. An `npm ci` launched by system Node
  18 can warn on engines and omit Rolldown's native optional binding; invoking
  only the later test command with Node 22 does not repair that install. Re-run
  `npm ci` itself with Node 22 before diagnosing the resulting native-binding
  startup error as a repository regression.
- `ui-snapshot-capture`: the canonical 30-shot review set is specified by
  `docs/ui-snapshots/CAPTURE-SPEC.md`.
- `safari-zoom-divergence` and `scrollbar-zoom-resolution`: real Safari differs
  from Chromium/Playwright WebKit for CSS zoom; runtime viewport calibration is
  intentional and standard scrollbar styling caused regressions.
- `safari-mcp-selenium-setup`: real-Safari testing uses the `selenium-safari` MCP,
  which only binds in a fresh Claude session (needs `~/.claude.json` entry, warm npx
  cache, `safaridriver --enable`); Chrome/Firefox MCPs load normally.

## Shipping and planning

- `forward-work-tracking-model`: roadmap #68 and GitHub issues own forward work;
  `docs/` is public, not an internal tracker.
- `ship-branch-off-diverged-main`: branch from `origin/main` when local main has
  diverged rather than destructively reconciling it.
- `ship-background-finalization` and `ship-phase-run-learnings`: concurrent ship
  agents can mutate git state; use isolated worktrees, explicit read-only review
  boundaries, and verify diff/log/PR state after every batch.
- `editor-roadmap`: CM6/EditorPort migration is settled; no SQL on keystrokes and
  no second UI framework.
- `dashboard-epic-phase-numbering-and-filter-design`: records the current typed
  parameter, optional-block, panel registry, and dashboard issue dependencies.

## ClickHouse and demos

- `otel-demo-cluster-status` (verified 2026-07-13): the OTEL stack runs in the
  `demo` namespace. `chi otel` is `Completed`; `chi-otel-otel-0-0-0` is `2/2`
  Running. The OpenTelemetry collector, Altinity MCP, Superset, and its PostgreSQL
  pod are ready. Check it with:

  ```sh
  kubectl -n demo get chi otel
  kubectl -n demo get pods | rg 'otel|superset-otel'
  kubectl -n demo get endpointslices \
    -l kubernetes.io/service-name=otel-collector-opentelemetry-collector
  ```

  The collector service intentionally exposes Jaeger UDP (`6831`) alongside TCP
  OTLP/Jaeger/Zipkin ports, but the cluster LoadBalancer implementation rejects
  mixed protocols. Its external address remains pending with
  `SyncLoadBalancerFailed: mixed protocol is not supported for LoadBalancer`.
  In-cluster endpoints are ready, including OTLP gRPC `4317` and OTLP HTTP `8080`.
  Keep internal clients on the ClusterIP service; external ingestion requires
  separate TCP and UDP Services (or another supported exposure method).
- `otel-sql-browser-deploy` (verified 2026-07-13, **STALE as of 2026-07-21 — otel
  is no longer single-host, see the correction below**): the edge proxy advertises
  `otel.demo.altinity.cloud` and `otel.demo.altinity.com` for the TLS service via
  `clickhouse-otel-443` annotations. Stage the verified `dist/sql.html` in `/tmp`,
  retain a timestamped `sql.html.bak-*` backup in `user_files`, then atomically
  rename the staged copy into place. Do not restart ClickHouse for an asset-only
  update. Verify both the on-pod checksum and the `/sql` response checksum.
- **`otel-now-two-replicas` (2026-07-21, supersedes the single-host claim above):**
  otel gained a second replica pod, `chi-otel-otel-0-1-0` (first observed ~10h
  after `chi-otel-otel-0-0-0`'s last restart), and the `clickhouse-otel` /
  `clickhouse-otel-443` Services **load-balance across both pods**. `user_files`
  is per-pod local storage, NOT shared/replicated — a `kubectl cp` to only
  `chi-otel-otel-0-0-0` leaves `chi-otel-otel-0-1-0`'s `user_files/` (and thus
  `/sql`, `/sql/config.json`) missing entirely, so roughly half of live requests
  50x/404 while the other half succeed — a confusing intermittent failure that
  looks like a transient race (a same-second cache-busted retry can "fix" it by
  luck of which pod the LB picked) but is actually a permanent per-replica gap.
  **Always re-check replica count before every otel deploy** (`kubectl get pods
  -n demo -l clickhouse.altinity.com/chi=otel`) and `kubectl cp` (or pod-to-pod
  copy) `sql.html` **and** `sql-config.json` to **every** `chi-otel-otel-0-*-0`
  pod, not just the first one. To backfill a new replica from an existing one
  without ever printing `sql-config.json` (public-by-design but still avoid
  echoing config bytes to the terminal): `kubectl exec -n demo <source-pod> -c
  clickhouse-pod -- cat .../sql-config.json > <scratch-file>` (redirected, not
  printed), then `kubectl cp <scratch-file> demo/<target-pod>:.../sql-config.json
  -c clickhouse-pod`, then delete the scratch file. Verify per-pod via `kubectl
  exec -n demo <pod> -c clickhouse-pod -- sha256sum user_files/sql.html` (compare
  across ALL pods, not just one) and a loopback `wget -qO- http://127.0.0.1:8123/sql`
  from inside each pod, then confirm the public endpoint with several
  cache-busted requests in a row (`?r=1`, `?r=2`, …) to sample both LB backends.
  Re-check the pod name and host count before every deployment:

  ```sh
  kubectl -n demo get chi otel
  kubectl -n demo get pods -l clickhouse.altinity.com/chi=otel
  # Run from a network permitted to reach the edge proxy.
  curl -fsS https://otel.demo.altinity.cloud/sql | shasum -a 256
  ```
- `deploy-sql-browser-demo-clusters`: upload built HTML into `user_files`; known
  demo paths differ by cluster. As of the v0.5.0 release (2026-07-15), all three
  demo clusters are on `v0.5.0`; **github.demo's served file is now the standard
  `sql.html`** (previously `github-play-sql.html`, kept in place but unreferenced)
  — antalya intentionally keeps its own `play-sql.html`. Cut a release by renaming
  `[Unreleased]`→`[x.y.z] - <date>` in `CHANGELOG.md`, bumping `package.json`,
  committing `chore(release): x.y.z`, and pushing an annotated `vX.Y.Z` tag to
  `main` (triggers `release.yml` + `ci.yml`); confirm with the user before the
  push, since a tag push is not easily reversible. Immediately before the
  release commit/tag, fetch and verify `origin/main` contains every intended
  merged PR: a release tag that predates a merge must stay immutable and be
  corrected with a new patch release, not retargeted (v0.6.3 → v0.6.4, #416).
- `sql-browser-dashboard-route-regression`: a demo cluster's `config.d` HTTP
  handler regex must accept `/sql/dashboard`, not just `/sql` — a config
  rollback (e.g. reverting an OAuth provider change) can silently regress this
  even after it was fixed once. If a cluster 404s on `/sql/dashboard` ("There is
  no handle..."), check the live `http_handlers` regex via `GET
  /cluster/{id}/settings` before assuming the app is broken; fix by editing the
  `<url>regex:...</url>` to `^/sql(/dashboard)?/?$` (or with a trailing
  `(\?.*)?` for query strings, as otel uses) via `acmctl` + cluster push, which
  restarts the pod — confirm with the user first on github.demo given
  [[github-demo-sql-browser-and-backup-landmine]].
- `deploy-mechanics-acm-settings`: apply managed `config.d` through ACM settings,
  not Kubernetes ConfigMaps.
- `acmctl-gotchas-and-instability`: bodyless raw calls historically required
  closed stdin; delete-only pushes can be lazy until a real change occurs.
- `cl-wrapper-stdin`: feed local SQL to `~/bin/cl <cluster>` through stdin; a
  local `--queries-file` path does not exist inside the pod.
- `clickhouse-param-path-grammar`: live 26.3 grammar probes are the basis for
  parameter serialization; consult the full memory before parser changes.
- `clickhouse-datalake-catalog-hidden-from-system-tables`: catalog tables need
  `show_data_lake_catalogs_in_system_tables = 1`.
- `library-demo-generator-gotchas`: documents client parameter binding, schema
  key extraction, permissions, and browser upload traps.
- `github-demo-sql-browser-and-backup-landmine`: a revoked backup S3 key can make
  ClickHouse restart fail; inspect this memory before operating github.demo.
- `antalya-two-idp-bearer-plus-basic`: the two-IdP experiment was reverted to
  Google-only, but its username-collision lesson remains valid.
- `antalya-oauth-demo-role-grants`: demo privileges come through replicated roles;
  the shared role includes temporary-table creation for multiquery sessions.

## Design source

`sql-browser-design-source`: the design/product source of truth is now
[`DESIGN.md`](../DESIGN.md) and [`PRODUCT.md`](../PRODUCT.md) at the repo root
(committed on `main`). The former external Claude Design (DesignSync) project is
deprecated and slated for deletion — do not use it as the spec.

Memory is historical and can stale. Re-verify live infrastructure and GitHub state
before mutation, especially pages that include dates, versions, or cluster IDs. Add
new durable learnings here or to the more specific wiki page, following
[[Maintaining-This-Wiki]].
