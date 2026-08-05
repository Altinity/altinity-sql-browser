---
name: chatgpt-review
description: Get a critical second opinion from ChatGPT on a GitHub pull request or issue, a written implementation plan, a branch, or a working-tree diff, or privately have ChatGPT author and revise a standalone implementation plan, by driving an already-running authenticated Chrome over CDP. Use when asked to have ChatGPT review work, author a plan, obtain an independent ChatGPT/GPT review, review fixes in the same conversation, or cross-check a PR, issue, plan, branch, or local changes before shipping.
---

# ChatGPT review

Use the blocking Node script for all browser interaction. Never drive ChatGPT manually, launch or terminate Chrome, inspect Chrome credentials, or relay unverified claims.
Leave ChatGPT's predefined model and effort unchanged; the script must not open or modify those controls.

1. Identify one target: canonical GitHub PR/issue URL, complete plan file, or local repository state.
2. Put focused project and acceptance context in a temporary question file. For plan review, put the complete plan in its own file.
3. From this skill directory, run `npm ci` once after installation, then invoke:

   ```sh
   node scripts/chatgpt-review.mjs doctor
   node scripts/chatgpt-review.mjs pr <url> --question-file <path>
   node scripts/chatgpt-review.mjs issue <url> --question-file <path>
   node scripts/chatgpt-review.mjs plan <plan-file> --question-file <path>
   node scripts/chatgpt-review.mjs plan-author <issue-url> --output-file <absolute-plan-path> --question-file <path>
   node scripts/chatgpt-review.mjs local --repo <path> --base <ref> --working-tree
   ```

   PR review publishes a new comment by default; add `--no-publish` for a private smoke review. Issue review is private unless `--publish` is present. Plan, plan-author, and local modes never publish. Add `--format text` only for interactive use; agents should consume the default JSON.
4. Treat any non-`completed` status as incomplete. A timeout may contain partial text, but do not present it as a completed review. Surface typed failures and ask for intervention only when the result says it is required.
5. Verify every substantive finding against the actual repository, target SHA, history, and focused tests. Report findings as confirmed, rejected, or uncertain. Include the returned public comment URL when present.

For a PR fix review, retain the returned `session` handle and invoke the same PR with `--session <handle>`. The script reuses that conversation and permits at most three total passes. Ask it only after accepted findings have been fixed and pushed.

If a run ends after submission with an incomplete typed status, retry with its returned `session` handle. The script resumes an active or already-finished uncollected response instead of sending the prompt twice.

For `plan-author`, use the canonical issue URL and keep the absolute output path
unchanged for the entire conversation. The initial call asks ChatGPT to browse the
issue, repository, `CLAUDE.md`, and ship references. Revisions reuse `--session` and
upload a pass-numbered copy of the current canonical plan. Only a valid
`PLAN_STATUS: READY` response atomically replaces the output file; `BLOCKED`, malformed,
empty, or incomplete responses leave it untouched. This command is private and never
accepts publication flags.

Use `--include-untracked` only when the user intends untracked text files to leave the machine. The script rejects likely secret-bearing paths and excludes binary content. Diagnostic capture is opt-in through `--diagnostics-dir`; inspect it before sharing because it describes the active page.
