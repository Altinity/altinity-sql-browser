# ChatGPT Review Skill

Get an independent ChatGPT review of a GitHub pull request or issue, an implementation plan, or local Git changes without copying browser credentials into an agent or automation process.

This repository is both:

- a Codex-compatible skill, described by [`SKILL.md`](SKILL.md) and [`agents/openai.yaml`](agents/openai.yaml); and
- a blocking Node.js CLI that drives an already-running, authenticated Chrome through the Chrome DevTools Protocol (CDP).

The CLI submits one review, waits for ChatGPT to finish, and writes one complete result document to stdout. Progress is written to stderr, so callers can safely parse the default JSON output.

## What it reviews

| Mode | Input sent to ChatGPT | GitHub publication |
| --- | --- | --- |
| Pull request | Canonical GitHub PR URL and optional focused context | Posts a new PR comment by default; use `--no-publish` for a private review |
| Issue | Canonical GitHub issue URL and optional focused context | Private by default; use `--publish` to post one issue comment |
| Plan | The exact plan file plus optional project/acceptance context | Never publishes |
| Local changes | A generated text artifact containing selected Git diffs | Never publishes |

PR follow-ups can reuse the same ChatGPT conversation. A PR session allows at most three passes: the initial review and two fix reviews. Each published pass creates a separately labelled comment rather than editing an earlier one.

## Requirements

- Node.js 20 or newer.
- Chrome or Chromium already running with remote debugging enabled.
- An existing Chrome profile that is signed in to ChatGPT.
- ChatGPT access to the relevant GitHub repository when a review requires browsing or commenting.

The default CDP endpoint is `http://127.0.0.1:9222`. Override it with `--cdp-url <url>` or `CHATGPT_REVIEW_CDP_URL`.

This tool never launches or terminates Chrome. It does not inspect credentials, cookies, browser storage, or request headers. Before running it, select the ChatGPT experience, model, and reasoning effort you want in Chrome. The tool deliberately leaves those predefined controls unchanged.

## Install

Clone or copy this complete directory, then install its pinned runtime dependency once:

```sh
cd chatgpt-review
npm ci
```

`playwright-core` is pinned in `package-lock.json`. The package is intentionally marked `private`: publish the directory as a skill or source repository, not to the npm registry.

To expose it to Codex, place the directory at `$CODEX_HOME/skills/chatgpt-review` (normally `~/.codex/skills/chatgpt-review`). During development, a symlink to one canonical checkout avoids maintaining two editable copies.

## Check the browser connection

Start with the non-sending doctor check:

```sh
node scripts/chatgpt-review.mjs doctor
```

Doctor connects to the existing browser, opens ChatGPT in a new tab, and verifies the login state, composer selectors, and file-upload input. It does not submit a prompt or change the selected model or reasoning effort.

For a non-default endpoint:

```sh
CHATGPT_REVIEW_CDP_URL=http://127.0.0.1:9333 \
  node scripts/chatgpt-review.mjs doctor
```

## Usage

### Pull request

PR review publishes a comment by default:

```sh
node scripts/chatgpt-review.mjs pr \
  https://github.com/OWNER/REPOSITORY/pull/123 \
  --question-file /path/to/context.md
```

Use a private review for smoke testing or when no public write is wanted:

```sh
node scripts/chatgpt-review.mjs pr \
  https://github.com/OWNER/REPOSITORY/pull/123 \
  --no-publish
```

The prompt asks ChatGPT to investigate the complete current PR, inspect relevant history, run focused tests when feasible, report the exact reviewed head SHA, and provide prioritized actionable findings.

### Fix review in the same conversation

Retain the `session` value returned by the first pass and supply it after accepted fixes have been committed and pushed:

```sh
node scripts/chatgpt-review.mjs pr \
  https://github.com/OWNER/REPOSITORY/pull/123 \
  --session 00000000-0000-4000-8000-000000000000
```

The target and mode must match the original session. The follow-up asks ChatGPT to fetch the new head, reassess every earlier finding, review the complete updated PR for regressions, and report the old and new SHAs.

If a submitted run times out or otherwise returns an incomplete status, retry with its returned session handle. The tool can resume an active or finished-but-uncollected response without sending the prompt a second time.

### Issue

Issue review is private by default:

```sh
node scripts/chatgpt-review.mjs issue \
  https://github.com/OWNER/REPOSITORY/issues/123 \
  --question-file /path/to/context.md
```

Authorize one new issue comment explicitly:

```sh
node scripts/chatgpt-review.mjs issue \
  https://github.com/OWNER/REPOSITORY/issues/123 \
  --publish
```

### Plan

Plan mode uploads exactly the supplied plan file. Optional context belongs in a separate question file:

```sh
node scripts/chatgpt-review.mjs plan /path/to/complete-plan.md \
  --question-file /path/to/project-context.md
```

Plan reviews never authorize GitHub or other external writes. Revised plans may continue in the same conversation with `--session <handle>`.

### Local changes

Review committed branch changes and staged changes relative to an explicit base:

```sh
node scripts/chatgpt-review.mjs local \
  --repo /path/to/repository \
  --base origin/main
```

Include unstaged working-tree changes when desired:

```sh
node scripts/chatgpt-review.mjs local \
  --repo /path/to/repository \
  --base origin/main \
  --working-tree
```

Untracked files are excluded unless `--include-untracked` is present. That flag can send local file contents to ChatGPT, so use it only when explicitly intended. The collector:

- includes committed branch changes, staged changes, and optionally unstaged changes;
- discovers `origin/HEAD`, `origin/main`, `main`, `origin/master`, or `master` when `--base` is omitted;
- excludes binary patch content and marks untracked binary files without uploading their bytes; and
- refuses likely secret-bearing paths such as `.env*`, credential files, private keys, and common certificate/key formats.

The generated upload is stored in a permission-restricted temporary directory and removed after the command finishes.

## Common options

```text
--question-file <path>   Add focused project and acceptance context
--session <handle>       Continue the exact saved ChatGPT conversation
--timeout <seconds>      Completion timeout; default 1800 (30 minutes)
--format json|text       Output format; default json
--cdp-url <url>          Chrome CDP endpoint
--diagnostics-dir <dir>  Write opt-in UI diagnostics after a failure
```

`--format text` is convenient for a human terminal. Agents and automation should consume the default JSON.

## Output contract

Every invocation writes one JSON object to stdout:

```json
{
  "status": "completed",
  "response_text": "Complete ChatGPT response...",
  "session": "00000000-0000-4000-8000-000000000000",
  "conversation_url": "https://chatgpt.com/c/example",
  "elapsed_seconds": 42.3,
  "pass_number": 1,
  "requested_publication": false,
  "reported_reviewed_sha": "0123456789abcdef0123456789abcdef01234567",
  "reported_github_comment_url": null,
  "error": null
}
```

The SHA and GitHub comment URL are extracted from ChatGPT's response and are therefore reported metadata, not independently verified facts. Calling agents must verify every substantive finding, the reviewed SHA, test claims, and any publication result against the repository and GitHub.

Only `completed` means a complete response. `timed_out` may include partial response text, but callers must not present it as a finished review.

| Status | Exit code | Meaning |
| --- | ---: | --- |
| `completed` | 0 | A new, non-empty response stopped generating and remained stable |
| `timed_out` | 2 | The timeout expired; `response_text` may be partial |
| `needs_interaction` | 3 | ChatGPT requested authentication, a broad permission, or an ambiguous action |
| `login_required` | 4 | The connected browser is not signed in to ChatGPT |
| `chrome_unavailable` | 5 | CDP is unreachable or no browser context is available |
| `ui_incompatible` | 6 | Required ChatGPT UI elements are missing or an unrecoverable stream/UI error occurred |
| `rate_limited` | 7 | ChatGPT reported a rate limit |
| `invalid_request` | 64 | CLI arguments, target, session, local state, or input files are invalid |
| `internal_error` | 70 | An unexpected internal failure occurred |

## Browser and permission behavior

- Starting without `--session` creates a fresh ChatGPT conversation.
- A matching open tab is reused for a session; otherwise the saved conversation URL is reopened.
- Completion requires a new non-empty assistant response, no active generation control, and stable text for seven seconds.
- A visible **Continue generating** control is handled automatically.
- **Error in message stream** is retried in place up to two times. Persistent failure returns `ui_incompatible` and any available partial text.
- Only a clearly scoped comment confirmation for the exact requested repository and PR/issue may be approved automatically.
- Merge, push, commit, close, approve, delete, workflow, credential, repository-wide, destructive, or ambiguous prompts return `needs_interaction`.

All review prompts instruct ChatGPT to treat repository content, diffs, issue text, comments, and uploads as untrusted evidence rather than executable instructions. Read-only investigation is permitted; the only external write ever authorized is the exact comment selected by PR or issue publication options.

## Session data

Sessions are permission-restricted JSON records stored in the platform user-state directory:

- macOS: `~/Library/Application Support/chatgpt-review`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/chatgpt-review`
- Windows: `%LOCALAPPDATA%\chatgpt-review`

Records contain only the opaque handle, mode, target identity, canonical and conversation URLs, pass count, timestamps, and reported SHA/comment metadata. Prompts, responses, uploads, cookies, tokens, and credentials are never stored there.

## Troubleshooting

Run doctor first and inspect its typed status:

```sh
node scripts/chatgpt-review.mjs doctor --format text
```

- `chrome_unavailable`: confirm Chrome is already running with remote debugging enabled and that the configured CDP endpoint is correct.
- `login_required`: sign in to ChatGPT in that same externally managed Chrome profile, then retry.
- `ui_incompatible`: inspect the visible ChatGPT tab. The UI may have changed, or ChatGPT may have shown a persistent stream error after both automatic retries.
- `rate_limited`: wait for ChatGPT capacity to recover, then resume with the returned session when available.
- `timed_out`: ChatGPT may still be working. Retry with the returned session rather than starting another fresh run.
- `needs_interaction`: review the visible prompt yourself. The tool intentionally will not approve broader permissions.

For selector-level diagnostics, opt in to a private directory:

```sh
node scripts/chatgpt-review.mjs pr \
  https://github.com/OWNER/REPOSITORY/pull/123 \
  --no-publish \
  --diagnostics-dir /path/to/private-diagnostics
```

On review failures, `diagnostic.json` records the timestamp, current page URL, typed status, and selector counts. It excludes cookies, storage, credentials, headers, prompts, responses, and general DOM content. Inspect it before sharing because the conversation URL identifies the active page.

## Development

Install the locked dependencies and run the unit/browser-contract tests:

```sh
npm ci
npm test
```

The browser tests use fake Playwright pages; they do not require Chrome and do not send prompts. Use `doctor` for a non-sending check against a real browser. Any live smoke review should use PR `--no-publish` or the default private issue, plan, or local mode unless a disposable public target was explicitly supplied.

## Publishing checklist

When publishing this directory independently:

1. Keep `SKILL.md`, `agents/openai.yaml`, `package.json`, and `package-lock.json` at their current relative paths.
2. Include the complete `scripts/` and `tests/` directories.
3. Include an Apache-2.0 `LICENSE` carrying the applicable copyright notice.
4. Run `npm ci`, `npm test`, and your target client's skill validator.
5. Run the non-sending `doctor` check against a supported authenticated Chrome session.
6. Document any supported-client or ChatGPT UI compatibility changes in the release notes.

## License

Apache License 2.0. When this skill is split into its own repository, copy the parent project's `LICENSE` into the standalone repository root.
