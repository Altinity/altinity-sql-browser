---
name: ship-phase
description: Deprecated alias — the multi-issue/multi-phase coordinator now lives in /ship. Invoke `/ship <issue> unattended` or `/ship <a>,<b>,<c> unattended` instead. Invoking this simply forwards to /ship.
---

# /ship-phase — moved into /ship

This skill has been folded into `/ship` so the per-issue cycle has exactly one definition.
It used to duplicate `/ship`'s steps 1–5 by reference, and the two drifted.

Translate the invocation and continue there:

| Old | New |
|---|---|
| `/ship-phase 7` (a phase of one issue) | `/ship <issue> unattended` |
| `/ship-phase 424,425,426` (several issues) | `/ship 424,425,426 unattended` |

Invoke the `ship` skill with the translated argument now, and follow it — in particular
`references/unattended.md`, which holds the coordinator and wave rules that used to live here.

Note the behaviour change worth knowing: `/ship <issue>` **without** `unattended` no longer
ships the whole issue in one go. It ships the next unshipped **phase**, opens one PR, and stops
at a human merge gate — one session per phase. That is the default now.
