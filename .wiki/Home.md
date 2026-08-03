# Altinity SQL Browser knowledge base

This wiki is the fast orientation layer and shared durable memory for maintainers
and coding agents. It distills repository documentation, source layout, and
historical agent learnings. Since 2026-08-03 it lives **in this repository** as
`.wiki/`, versioned with the code — see [[Maintaining-This-Wiki]] for what that
means in practice. Follow the linked source documents when exact details matter.

It is the project's **primary knowledge base**: read [[Home]] first, and record durable
learnings here — see [[Maintaining-This-Wiki]].

## Start here

- [[Architecture]] — dependency direction, seams, state, query execution, build.
- [[Product-and-Features]] — the user-facing surface and where each feature lives.
- [[Development-Workflow]] — tests, coverage, build, review, and release discipline.
- [[Decisions-and-Roadmap]] — settled architecture (including ADR-0004's Preact
  rejection) and current forward-work model (V1 roadmap #68, V2 roadmap #582,
  the #593 refactor-umbrella track).
- [[Deployment-and-Security]] — artifact, OAuth modes, cluster installation, secrets.
- [[Operations-Memory]] — shared durable operational lessons.
- [[Project-Skills]] — local `/ship` workflows and Codex compatibility links.
- [[Source-Map]] — high-value entry points and documentation.
- [[Maintaining-This-Wiki]] — how to use and update this knowledge base.

## Non-negotiable invariants

1. Read [`CLAUDE.md`](../CLAUDE.md) before substantive changes; it is the primary
   contributor guide.
2. Preserve layer direction: UI → net/state/core, net → core, core → nothing.
3. Inject environment side effects and third-party imperative adapters.
4. Run `npm test` and `npm run build`; coverage is per file, not aggregate.
5. Keep the shipped browser a single esbuild-generated `dist/sql.html` artifact.
6. Never commit rendered `deploy/config.json` or other credentials.
7. Contracts specify final-state invariants, not frame-by-frame gesture
   behavior, unless a user-visible bug forces otherwise (ADR-0004 retrospective).

## Key architecture/decision documents

- [`docs/ADR-0001-reactivity.md`](../docs/ADR-0001-reactivity.md) — signals, no
  UI framework.
- [`docs/ADR-0002-static-typing.md`](../docs/ADR-0002-static-typing.md) —
  incremental strict TypeScript.
- [`docs/ADR-0003-dashboard-viewing.md`](../docs/ADR-0003-dashboard-viewing.md)
  — dashboard viewing model.
- [`docs/ADR-0004-ui-shell.md`](../docs/ADR-0004-ui-shell.md) — the #577 Preact
  evaluation: **retain vanilla rendering, reject the migration** (2026-08-03);
  the #593 refactor umbrella (#586/#587/#588/#589/#590/#591/#592/#585) is the
  follow-through.
- [`docs/V2-UX-HANDOVER.md`](../docs/V2-UX-HANDOVER.md) — shipped-UX + committed
  product-contract inventory feeding the V2 redesign roadmap, #582.

## Current checkout context

This wiki was originally distilled 2026-07-12 and reconciled 2026-08-03 when it
moved in-repo. Treat anything with a date, version, or cluster ID as possibly
stale; re-verify live infrastructure and GitHub state before acting on it.

Source: [`AGENTS.md`](../AGENTS.md), [`CLAUDE.md`](../CLAUDE.md), repository tree,
and historical agent memory.
