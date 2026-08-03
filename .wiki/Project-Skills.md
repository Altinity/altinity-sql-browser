# Project skills

Back to [[Home]]. Related: [[Development-Workflow]], [[Operations-Memory]].

The canonical project skills are tracked under the repo-root **`skills/`**
directory (promoted from `.claude/skills` 2026-07-30, #b4cd83b):

- `ship` — plan, implement, test, review, reconcile, and open a PR for one issue;
  always stops at the human merge gate. Multi-phase issues ship one PR per
  phase; also handles `/ship <issue> unattended` and multi-issue coordination
  (the old separate `ship-phase` skill now just forwards to `/ship`).
- `ship-phase` — deprecated alias that forwards to `/ship <issue> unattended`.
- `sql-browser-dashboard` — turns an already-known SQL/result-column
  investigation into a validated `PortableBundleV2` Dashboard bundle and
  publishes it through the `save_dashboard` MCP tool (or leaves it as a
  downloadable JSON file when that tool isn't wired up).

`.claude/skills`, `.codex/skills`, and `.agents/skills` are **symlinks** to
`skills/` (`.claude/skills -> ../skills`, etc.), so Claude Code, the Codex CLI,
and generic agent tooling share one source of truth instead of separate
copies:

```text
.claude/skills -> ../skills
.codex/skills  -> ../skills
.agents/skills -> ../skills
```

Keep `skills/` canonical. Edit each skill once there; do not replace the
symlinks with copies. `ship`/`ship-phase` can mutate git/GitHub and are only to
be invoked when explicitly requested.

The skill instructions also require isolation for concurrent shipping, full unit
and build gates, explicit read-only boundaries for review helpers, reconciliation
of roadmap/ADR/changelog, and no automatic merge.

## Local-only development skills

Some skills are **vendored dev tools kept local, not committed** to the repo:

- `impeccable` — the design/UI skill used to author [`DESIGN.md`](../DESIGN.md) and
  [`PRODUCT.md`](../PRODUCT.md). Its code and state
  (`skills/impeccable/`, `.impeccable/`) are gitignored; only its two output
  docs are tracked. Install it locally to run `/impeccable`; nothing in CI or
  the shipped artifact depends on it.

Rule: `ship`, `ship-phase`, and `sql-browser-dashboard` (bespoke, project-specific)
are committed under `skills/`. Large general-purpose skills like `impeccable`
stay local and are documented here.
