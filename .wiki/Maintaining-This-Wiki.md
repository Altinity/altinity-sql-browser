# Maintaining this wiki

Back to [[Home]]. Related: [[Operations-Memory]], [[Development-Workflow]].

This wiki is the **canonical shared durable memory** for the project — the first
thing to read at session start and where durable learnings are recorded for both
Claude and Codex.

**Since 2026-08-03 it is `.wiki/` inside the main repository** (`Altinity/altinity-sql-browser`),
not a separate `repo.wiki.git` checkout. It is versioned with the code: it is
cloned, diffed, and committed exactly like `src/` or `docs/`, and it ships in the
same PRs/commits as the changes it documents rather than being updated out of band
afterward.

The project previously used the GitHub wiki feature (`repo.wiki.git`, cloned to
`.wiki/` and gitignored there) as a separate remote. That model is retired: the
old wiki remote (`https://github.com/Altinity/altinity-sql-browser.wiki.git`) is
a **frozen archive** — its `Home.md` points here and it should not be edited.

## How to use it

1. Start at [[Home]]; follow `[[WikiLinks]]` to the topic you need.
2. For exact, current facts, follow each page's "Canonical source" links to
   `CLAUDE.md`, `docs/*`, and GitHub issues — the wiki is a map, not the source of
   truth.
3. Treat anything with a date, version, or cluster ID as possibly stale; re-verify
   live infrastructure and GitHub state before mutating anything.

## Where new knowledge goes

- **A change that stales a wiki page** (behavior, schema, decision, roadmap state)
  → fix the affected page **in the same commit/PR** as the change, the same way
  `CLAUDE.md`'s "Reconcile forward work after a substantive change" discipline
  already requires for the roadmap issue, ADR addenda, and `CHANGELOG.md`.
- **Durable project or operational learning** → append it to the most relevant
  existing page (usually [[Operations-Memory]], [[Deployment-and-Security]], or
  [[Development-Workflow]]). Keep entries short, actionable, and sufficient for an
  agent that cannot access any local Claude memory; link the supporting detail.
- **Large runbooks / verbatim grammar probes** → store the durable summary, usage
  conditions, and canonical-source link in the wiki. A Claude native memory archive
  may retain supplementary historical detail, but it is not a required source and
  must never be the only record of actionable knowledge.
- **Settled architecture or decision** → [[Decisions-and-Roadmap]] and the relevant
  ADR under `docs/`.
- Do not delete history to reconcile a page — rephrase stale claims as history
  with dates (e.g. "shipped 2026-07-30, rolled back from `main` 2026-08-03,
  salvage branch: …") rather than erasing the record.

## Keeping it honest

- Every page ends with a "Canonical source" pointer; keep those accurate.
- When a supplementary native archive gains or loses useful detail, update its
  corresponding wiki summary and source link; do not require agents to access the
  archive to act safely.
- `.wiki/` is a normal tracked directory now: edit it with the same tools and in
  the same commit as the code/doc change it reflects, and push to `origin` like
  any other change to this repo — never to the old wiki remote.
