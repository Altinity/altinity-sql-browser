# Project skills

Back to [[Home]]. Related: [[Development-Workflow]], [[Operations-Memory]].

The canonical project skills are tracked under the repo-root **`skills/`**
directory (promoted from `.claude/skills` 2026-07-30, #b4cd83b):

- `ship` — autonomously deliver one or more issues/phases: a coordinator spawns a
  fresh worker per unit, iterates each unit's plan through a ChatGPT review loop
  to approval (max 5 passes), integrates the implementation onto one branch,
  opens one PR, and iterates a ChatGPT code review loop to certification (max 3
  passes). It auto-merges without asking when every proof condition holds
  (certified head at the exact PR SHA, green required checks, branch protection
  permits) and stops for a human decision only when a review loop exhausts its
  passes or a merge proof fails. The old attended/unattended split and the
  separate `ship-phase` alias were removed 2026-08-05.
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
symlinks with copies. `ship` can mutate git/GitHub and is only to be invoked
when explicitly requested.

The skill instructions also require isolation for concurrent shipping, full unit
and build gates, explicit read-only boundaries for review helpers, and reconciliation
of roadmap/ADR/changelog. `/ship` merges automatically only when a certified
ChatGPT review exists at the exact PR head with required checks green; any
failed proof condition halts for a human decision instead.

## Local-only development skills

Some skills are **vendored dev tools kept local, not committed** to the repo:

- `impeccable` — the design/UI skill used to author [`DESIGN.md`](../DESIGN.md) and
  [`PRODUCT.md`](../PRODUCT.md). Its code and state
  (`skills/impeccable/`, `.impeccable/`) are gitignored; only its two output
  docs are tracked. Install it locally to run `/impeccable`; nothing in CI or
  the shipped artifact depends on it.

Rule: `ship`, `chatgpt-review`, and `sql-browser-dashboard`
(project workflow skills) are committed under `skills/`. Large general-purpose
skills like `impeccable` stay local and are documented here. The old global
instruction-only `chatgpt-review` is retained as a recoverable timestamped
backup; the repo copy is canonical and installed through the existing skill
directory symlinks, so there is only one editable copy.
