# Capture notes — g6410a06

- **App**: `v0.2.0 (6410a06)` (post-release main; the CM6 editor cutover #145 + FROM-aware
  autocompletion #84 are both merged here). Target `antalya.demo.altinity.cloud`,
  ClickHouse `26.3.10.20001.altinityantalya`.
- **Theme**: the app persists its own theme in `localStorage` and overrides
  `prefers-color-scheme`; on this profile it defaulted to **light**. All canonical shots
  were taken after toggling to **dark** (`data-theme="dark"`); `01`/`02` were re-shot in dark.

## Per-shot notes

- **05 run-streaming** — a normal query returns faster than the screenshot round-trip, so the
  streaming state was forced with `SELECT number, sleepEachRow(0.05) FROM numbers(300)
  SETTINGS max_block_size=10` (~15 s of block-by-block streaming, each block under the 3 s
  `sleep` cap). Shot shows "Running…", the live `ms / rows / Cancel` header, rows arriving.
- **14 graph-inline / 15 graph-fullscreen** — reached by **clicking a database** in the schema
  tree (draws the whole-DB data-flow graph) rather than dragging a single table row; the view
  is the same. `ontime` was used (sparse lineage: only `dim_airports_bts_full → dim_airports`).
  **Expand opens a detached browser window** (the #100 detached-tab primitive), not an in-page
  overlay — `15` is that window, fitted, showing the rich node cards (engine/rows/bytes +
  PK/SK/PARTITION column badges).
- **12 explain-pipeline-fullscreen** — same detached-window behavior as the schema graph.
- **07 cell-drawer** — clicking a blob cell (`create_table_query`) opens the right-side
  `.cd-*` detail drawer with the value pretty-printed; backdrop dims the workbench.
- **21 header-longversion** — **SKIPPED / not applicable on this deployment.** The antalya
  header shows a short version chip (`ClickHouse 26.3.10`) and a short username
  (`btyshkevich`, not the full email), so the header does not crowd. Nothing to capture.
- **34 mobile-header** — on this build the editor action toolbar **scrolls horizontally
  instead of clipping** (the #127 mobile fix): `Share` is not truncated to "S." — it renders
  in full once the toolbar is scrolled to its end. Shot shows the toolbar scrolled to reveal
  `… Save · Export · Share`. The earlier "S." truncation case appears resolved.
- **01b login-credentials** — not captured here (antalya is SSO-only, `basic_login:false`).
  The github.demo deployment shows the username/password form if that shot is needed later.

## Changed vs prior versions
First versioned capture in this folder scheme — no prior version to diff against yet.
The headline change since the last design pass is the **CodeMirror 6 editor** (real syntax
highlighting, the scope-aware autocomplete dropdown in `04`).
