# Codex guide — altinity-sql-browser

Codex should read `CLAUDE.md` before making substantive changes in this repo.
`CLAUDE.md` is the full contributor guide and the primary source of truth.

This file is intentionally short so agent tooling can discover the repo rules
quickly, then defer to `CLAUDE.md` for the complete guidance.

## Critical rules

1. **Read `CLAUDE.md` first.** Treat it as required repo context, not optional
   background reading.
2. **Coverage gate is non-negotiable.** `npm test` must pass, and per-file
   coverage expectations described in `CLAUDE.md` still apply.
3. **Keep the layers honest.**
   - pure logic in `src/core/`
   - network in `src/net/` with injected fetch seams
   - DOM/rendering in `src/ui/`
   - environment side effects injected through `createApp(env)`
4. **No secrets in git.** Never commit rendered `config.json`; only keep
   `deploy/config.json.example` in version control.
5. **The shipped app stays a single esbuild-built artifact.** Avoid adding
   runtime dependencies casually; follow the dependency guidance in `CLAUDE.md`.
6. **Chrome remains externally managed.** Never launch or terminate Chrome. The
   reviewed `skills/chatgpt-review/scripts/chatgpt-review.mjs` script may connect
   over CDP to the already-running agent browser; it must not inspect credentials,
   cookies, storage, or headers, and may approve only its exact requested GitHub
   comment action.

## Working rule

When `AGENTS.md` and `CLAUDE.md` differ, update them to match, but follow the
more complete guidance in `CLAUDE.md` for the current task.
