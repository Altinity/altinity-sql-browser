# Project skills

Back to [[Home]]. Related: [[Development-Workflow]], [[Operations-Memory]].

The canonical project skills are tracked under the repo-root **`skills/`**
directory (promoted from `.claude/skills` 2026-07-30, #b4cd83b):

- `ship` — plan, implement, test, review, reconcile, and open a PR for one issue.
  Attended runs ask before merging and may perform the approved merge; unattended
  runs have no merge prompt and auto-merge only after a clean third ChatGPT pass
  at the current head plus green CI. Multi-phase attended work uses one PR per
  phase; the old separate `ship-phase` skill now just forwards to `/ship`.
- `ship-phase` — deprecated alias that forwards to `/ship <issue> unattended`.
- `sql-browser-dashboard` — turns an already-known SQL/result-column
  investigation into a validated `PortableBundleV2` Dashboard bundle and
  publishes it through the `save_dashboard` MCP tool (or leaves it as a
  downloadable JSON file when that tool isn't wired up).
- `chatgpt-review` — connects a blocking, tested Playwright script to the
  already-running authenticated agent Chrome and returns complete ChatGPT
  reviews of PRs, issues, plans, branches, or local diffs. PR fix reviews reuse
  an opaque session handle for up to three auditable passes; callers verify all
  findings locally before acting on them.

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
and build gates, explicit read-only boundaries for review helpers, and reconciliation
of roadmap/ADR/changelog. Automatic merge is limited to explicit unattended runs
that satisfy the three-pass review and current-head CI proof.

## Local-only development skills

Some skills are **vendored dev tools kept local, not committed** to the repo:

- `impeccable` — the design/UI skill used to author [`DESIGN.md`](../DESIGN.md) and
  [`PRODUCT.md`](../PRODUCT.md). Its code and state
  (`skills/impeccable/`, `.impeccable/`) are gitignored; only its two output
  docs are tracked. Install it locally to run `/impeccable`; nothing in CI or
  the shipped artifact depends on it.

Rule: `ship`, `ship-phase`, `chatgpt-review`, and `sql-browser-dashboard`
(project workflow skills) are committed under `skills/`. Large general-purpose
skills like `impeccable` stay local and are documented here. The old global
instruction-only `chatgpt-review` is retained as a recoverable timestamped
backup; the repo copy is canonical and installed through the existing skill
directory symlinks, so there is only one editable copy.
