# UI Snapshot Capture Spec — Altinity SQL Browser

**For:** Claude Code (with a Chrome-driving MCP server)
**Purpose:** Capture a consistent, versioned set of screenshots of the shipped app so the UI
can be design-reviewed and diffed across releases over time.
**Consumer:** the screenshots are handed back to the design agent to pin annotations onto.

---

## 0. Prerequisites

Use a browser-automation MCP. Either works:
- **`chrome-devtools`** (recommended — real Chrome, real OAuth session), or
- **`@playwright/mcp`** (launch **non-headless** so a human can complete OAuth once).

Requirements for every capture:
- **deviceScaleFactor: 2** (retina) — crisp text.
- **Desktop viewport: 1440 × 900.** **Mobile viewport: 390 × 844.**
- **Theme: dark is canonical.** Also capture the two light-theme parity shots noted below.
- Do **not** resize columns, reorder, rename, or edit anything unless a step says so. Capture
  **default** states.
- Wait for network idle + any chart/graph animation to settle (~600 ms) before each shot.

---

## 1. Where to save — versioned in the repo

Save into this folder keyed by the **app release tag** (fall back to the short commit SHA,
prefixed `g`, if HEAD isn't tagged):

```
docs/ui-snapshots/
  <tag-or-shortsha>/          e.g.  v0.4.2/   or   g6410a06/
    meta.json
    notes.md
    desktop/   01-login.png … 23-light-multiquery.png
    mobile/    30-mobile-tables.png … 34-mobile-header.png
  README.md                   (index of all captured versions)
  CAPTURE-SPEC.md             (this file)
```

Derive the folder name:
```bash
git describe --tags --exact-match 2>/dev/null || echo "g$(git rev-parse --short HEAD)"
```
If a folder for this version already exists, **overwrite** it — don't append.

### `meta.json` (write this first, in the version folder)
```json
{
  "app_tag": "v0.4.2",
  "app_commit": "6a64f4483701...",
  "app_build_stamp": "v0.2.0 (6410a06)",
  "captured_at": "2026-07-03T12:00:00Z",
  "captured_by": "claude-code + chrome-devtools-mcp",
  "target_host": "antalya.demo.altinity.cloud",
  "clickhouse_version": "26.3.10",
  "browser": "Chrome (agent, localhost:9222)",
  "desktop_viewport": "1440x900@2x",
  "mobile_viewport": "390x844@2x"
}
```
Fill `app_tag`/`app_commit` from git; read `clickhouse_version` from the header chip in the
running app; the rest from your environment.

---

## 2. Auth
1. Navigate to `https://antalya.demo.altinity.cloud/sql`.
2. If it lands on the login screen, **capture `01-login.png` first** (before signing in) —
   this is the SSO state we want.
3. Complete OAuth. On the agent Chrome profile Google SSO completes **silently**
   (`prompt=none`, altinity.com Workspace session). Then drive the authenticated session.

If a deployment shows **username/password** on login (e.g. github.demo), also grab
`01b-login-credentials.png`.

---

## 3. Desktop shot list (viewport 1440×900, dark theme)

| File | State & how to reach it |
|---|---|
| `01-login.png` | Login screen, **SSO button visible** (capture before signing in, in dark). |
| `02-workbench-empty.png` | Fresh **Untitled** tab: empty editor over empty results. Do nothing after load. |
| `03-schema-expanded.png` | Expand one database + one table so tables + a few columns show. |
| `04-autocomplete.png` | Type `SELECT * FROM ev` so the autocomplete dropdown is open. |
| `05-run-streaming.png` | Run a slow query, capture **mid-flight** — streaming counters + Cancel visible. |
| `06-results-table.png` | A completed multi-column result with a **long/blob text column** + **NULLs**. |
| `07-cell-drawer.png` | Click a blob cell to open the right-side cell-detail drawer. |
| `08-error.png` | Run `SELECT * FROM nope` and capture the error banner. |
| `09-chart-bar.png` | `SELECT Month AS month, count() AS flights … WHERE Year=2023 GROUP BY month`, → **Chart** (config bar visible). |
| `10-chart-pie.png` | A ≤6-category result, Chart view, **Type = Pie**. |
| `11-explain-pipeline.png` | Run/Explain a query, results → **Pipeline** sub-tab. |
| `12-explain-pipeline-fullscreen.png` | Same, then **Expand** (opens a detached window). |
| `13-explain-estimate.png` | EXPLAIN → **Estimate** sub-tab (table form). |
| `14-graph-inline.png` | Data-flow graph in the results pane (drag a table row, or click a DB). |
| `15-graph-fullscreen.png` | Same graph, **Expand** (detached window, rich cards). |
| `16-library-menu.png` | Click header **File ▾** so the menu is open. |
| `17-library-save.png` | With a query in the editor, **Save** → the name+description dialog. |
| `18-multiquery.png` | Run a `;`-separated multi-statement script → the Statement/Result/Time table. |
| `19-user-menu.png` | Open the header user/avatar menu (identity + Log out + build stamp). |
| `20-shortcuts.png` | Open the keyboard-shortcuts modal (`?` or the header button). |
| `21-header-longversion.png` | **Only if** this deployment shows a full version string / full email crowding the header. Skip + note otherwise. |

### Light-theme parity (toggle theme, then)
| File | State |
|---|---|
| `22-light-workbench.png` | Workbench with a **table** result, light theme. |
| `23-light-multiquery.png` | Multi-statement script result, light theme. |

---

## 4. Mobile shot list (viewport 390×844, dark theme)
Reload at the mobile viewport so it enters the bottom-tab layout (Tables / Editor / Results).

| File | State |
|---|---|
| `30-mobile-tables.png` | **Tables** tab: schema tree, with the Schema\|Queries toggle visible. |
| `31-mobile-library.png` | Tables tab switched to **Queries** (Library saved-queries list). |
| `32-mobile-editor.png` | **Editor** tab with a query typed in (scroll editor to line start). |
| `33-mobile-results.png` | **Results** tab after running, table view + row-count badge. |
| `34-mobile-header.png` | The top bar / editor toolbar (watch the Share label behavior). |

---

## 5–6. Index + notes
- Add/refresh a row in [`README.md`](README.md) so versions are followable over time.
- Write `notes.md` per version: shots **skipped** and why, states that **changed** vs the
  previous version, anything **flaky** (e.g. the streaming shot took several tries).

---

## 7. Runbook — what actually works with the `chrome-devtools` MCP (2026-07 build)

These are the concrete techniques that made this repeatable; reuse them next time.

- **Viewport/theme**: `emulate({viewport:"1440x900x2", colorScheme:"dark"})` for desktop,
  `"390x844x2,mobile,touch"` for mobile. Re-apply `emulate` **after every `select_page`** —
  it's per-page.
- **Theme override**: the app persists its own theme in `localStorage` and ignores
  `prefers-color-scheme`. After load, check
  `document.documentElement.getAttribute('data-theme')`; if it's not `dark`, click the
  **Toggle theme** button. It persists, so `01`/`02` may need re-shooting once dark is set.
- **Screenshots must save inside the repo/workspace root** — the MCP rejects paths outside it
  (e.g. the scratchpad). Write straight to `docs/ui-snapshots/<ver>/…`.
- **Typing into the CM6 editor**: `evaluate_script` → `document.querySelector('.cm-content').focus()`,
  then `type_text`. Clear with `press_key "Meta+a"` then `type_text` (or Backspace).
  After typing, `press_key "Escape"` to dismiss the autocomplete tooltip **before**
  `press_key "Meta+Enter"` to run.
- **Reading editor state**: `document.querySelector('.cm-content').innerText`.
- **Clicking chrome that isn't worth a full snapshot**: `evaluate_script` finding a button by
  text, e.g. `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chart').click()`.
  (Full `take_snapshot` is huge when the schema tree is expanded — avoid it; it can exceed the
  token limit. Query the DOM instead.)
- **Streaming shot (`05`)**: a real query completes before the screenshot round-trips. Force a
  long stream that stays under ClickHouse's 3 s-per-block `sleep` cap:
  `SELECT number, sleepEachRow(0.05) AS s FROM numbers(300) SETTINGS max_block_size=10`
  (~15 s, rows arrive block by block). `sleepEachRow(0.4) FROM numbers(30)` errors TOO_SLOW —
  too much sleep per block.
- **Cell drawer (`07`)**: a dispatched `MouseEvent('click')` on a `td.cell` DOES open it; the
  drawer is `.cd-panel` / `.cd-body` / `.cd-pre` (not `[class*="drawer"]` — don't be fooled
  into thinking it failed). Close with Escape.
- **Chart type/rows are native `<select>`s**: set `.value` + dispatch `change`. Type options
  are `hbar | bar | line | area | pie`.
- **`Expand` opens a DETACHED WINDOW, not an overlay** — for both the schema data-flow graph
  and the EXPLAIN pipeline (the #100 detached-tab primitive). After clicking Expand:
  `list_pages` → find the new `Schema:…` / `Pipeline` tab → `select_page` → re-`emulate` →
  click **Fit** → screenshot → `close_page` the extra tabs → `select_page` back to the app tab.
- **Mobile**: after a query runs, the app auto-switches to the **Results** bottom tab and shows
  a scanned-rows badge (e.g. `6.8M`) on it. The editor action toolbar **scrolls** horizontally
  rather than clipping (so `Share` isn't truncated to "S." on this build).
- **Never launch Chrome yourself** — drive the agent Chrome on `localhost:9222`.

---

## 8. Handing back to the design reviewer
The design agent can't read the repo working tree — give it the actual PNGs:
- drag-and-drop the PNGs into the design chat, or
- point it at the raw GitHub URLs for `docs/ui-snapshots/<version>/…`.

The reviewer re-pins annotations onto the current UI and diffs against the prior version.
