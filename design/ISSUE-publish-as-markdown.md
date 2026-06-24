# Feature: "Publish" — export all saved queries as a Markdown cookbook

## Summary

Add a one-way **Markdown export** ("Publish" / "Copy as Markdown") that turns the
user's saved queries into a single human-readable Markdown document they can paste
into other tools (GitHub, GitLab, Notion, Obsidian, wikis, PRs, Slack) or download
as a `.md` file.

This complements — does **not** replace — the existing **JSON export/import**:

| | JSON export | Markdown publish |
|---|---|---|
| Purpose | Backup / transfer / re-import | Share / document / paste elsewhere |
| Round-trips back in? | ✅ lossless | ❌ one-way (metadata not recoverable) |
| Human-readable | meh | ✅ great |

**Markdown is strictly export-only.** Do not attempt to re-import it — `starred`,
timestamps, and ids do not survive. JSON remains the canonical round-trip format.

## Output format

Each saved query becomes a heading + a fenced `sql` block (the fence gives free
syntax highlighting wherever it's pasted). Group **starred first**, then the rest,
and include a linked table of contents once there are more than ~10 queries
(headings auto-anchor on GitHub).

```markdown
# Saved queries
_42 queries · exported from Altinity SQL Browser · 2026-06-21_

## ⭐ Starred

### Worst-delay carriers (2023)
​```sql
SELECT Reporting_Airline, avg(DepDelayMinutes) AS avg_delay
FROM airline.ontime
WHERE Year = 2023 AND Cancelled = 0
GROUP BY Reporting_Airline
ORDER BY avg_delay DESC
LIMIT 15
​```

## All queries

### Busiest origin airports
​```sql
SELECT Origin, count() AS flights FROM airline.ontime ...
​```
```

## UX

- Primary action: **Copy to clipboard** (the stated use case is "cut it and use
  elsewhere").
- Secondary: **Download `.md`**.
- Show a **preview modal** with the generated Markdown in a scrollable `<pre>` so
  the user can eyeball it before copying — Markdown is reviewed-before-paste,
  unlike the fire-and-forget JSON backup.
- Sits alongside the existing Export / Import controls at the bottom of the Saved
  panel.

## Open decisions

1. **Scope** — publish *all* saved queries, or let the user pick (starred-only, or
   multi-select)?
2. **Naming** — "Copy as Markdown" (honest about what it does) vs keep "Publish"
   and eventually make it *actually* publish (create a GitHub Gist or a shareable
   read-only URL, with copy/download as offline fallbacks).
3. **`description` field (recommended)** — saved queries are currently `name` +
   `sql` only. A published cookbook is far more useful if each query carries a
   one-line description, rendered as prose under its heading. Consider adding an
   optional `description` field to the saved-query schema as part of this work.

## Implementation notes

- **Fence safety**: SQL almost never contains a literal triple-backtick, but scan
  each query and bump to a 4-backtick fence if one is present.
- Clipboard via `navigator.clipboard.writeText`; download via
  `Blob` + `URL.createObjectURL` (same pattern as the JSON export).
- Suggested filename: `sql-browser-queries-YYYY-MM-DD.md`.

## Context

Discussed during the design handoff. Deferred from the current design round for
more thought before committing. See the handoff README's "Export / Import saved
queries" section for the JSON counterpart this builds on.
