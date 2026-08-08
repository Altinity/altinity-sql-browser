import path from 'node:path';

export const EXIT_CODES = Object.freeze({
  completed: 0,
  timed_out: 2,
  needs_interaction: 3,
  login_required: 4,
  chrome_unavailable: 5,
  ui_incompatible: 6,
  rate_limited: 7,
  invalid_response: 8,
  invalid_request: 64,
  internal_error: 70,
});

const VALUE_FLAGS = new Set([
  '--question-file', '--session', '--seed-from-session', '--timeout', '--format', '--repo', '--base',
  '--cdp-url', '--diagnostics-dir', '--output-file',
]);
const BOOL_FLAGS = new Set(['--publish', '--no-publish', '--working-tree', '--include-untracked']);

export function usage() {
  return `Usage:
  chatgpt-review.mjs doctor [--cdp-url <url>] [--format json|text]
  chatgpt-review.mjs pr <url> [--question-file <path>] [--session <handle>|--seed-from-session <handle>] [--no-publish] [--timeout 1800]
  chatgpt-review.mjs issue <url> [--question-file <path>] [--session <handle>|--seed-from-session <handle>] [--publish] [--timeout 1800]
  chatgpt-review.mjs plan <plan-file> [--question-file <path>] [--session <handle>|--seed-from-session <handle>] [--timeout 1800]
  chatgpt-review.mjs plan-author <issue-url> --output-file <absolute-plan-path> --question-file <path> [--session <handle>|--seed-from-session <handle>] [--timeout 1800]
  chatgpt-review.mjs local [--repo <path>] [--base <ref>] [--working-tree] [--include-untracked] [--question-file <path>] [--session <handle>|--seed-from-session <handle>] [--timeout 1800]

  --session <handle>: resume THIS exact mode+target's own prior session (same conversation, same pass counter).
  --seed-from-session <handle>: start a NEW session for this mode+target, but continue an EXISTING
  ChatGPT conversation from a prior session of a DIFFERENT mode (e.g. thread a plan-author
  conversation into this PR's own pr-mode review) instead of opening a fresh chat. The new
  session gets its own pass counter; only one of --session/--seed-from-session may be given.`;
}

export function parseArgs(argv, env = process.env) {
  const [mode, ...rest] = argv;
  if (!['doctor', 'pr', 'issue', 'plan', 'plan-author', 'local'].includes(mode)) {
    throw new CliError(`Unknown or missing command: ${mode ?? '(none)'}`);
  }
  const positional = [];
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (VALUE_FLAGS.has(arg)) {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new CliError(`${arg} requires a value`);
      options[toKey(arg)] = rest[++i];
    } else if (BOOL_FLAGS.has(arg)) {
      options[toKey(arg)] = true;
    } else if (arg.startsWith('--')) {
      throw new CliError(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (options.publish && options.noPublish) throw new CliError('Use only one of --publish and --no-publish');
  if (options.session && options.seedFromSession) throw new CliError('Use only one of --session and --seed-from-session');
  if (options.format && !['json', 'text'].includes(options.format)) throw new CliError('--format must be json or text');
  const timeout = Number(options.timeout ?? 1800);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new CliError('--timeout must be a positive number of seconds');
  if (mode === 'doctor' && positional.length) throw new CliError('doctor takes no target');
  if (['pr', 'issue', 'plan', 'plan-author'].includes(mode) && positional.length !== 1) throw new CliError(`${mode} requires exactly one target`);
  if (mode === 'local' && positional.length) throw new CliError('local takes options, not a positional target');
  if (mode === 'plan-author') {
    if (!options.outputFile || !path.isAbsolute(options.outputFile)) throw new CliError('plan-author requires --output-file with an absolute path');
    if (!options.questionFile) throw new CliError('plan-author requires --question-file');
    if (options.publish || options.noPublish) throw new CliError('plan-author never accepts publication options');
  }
  return {
    mode,
    target: positional[0] ? (mode === 'plan' ? path.resolve(positional[0]) : positional[0]) : undefined,
    ...options,
    timeoutMs: timeout * 1000,
    format: options.format ?? 'json',
    cdpUrl: options.cdpUrl ?? env.CHATGPT_REVIEW_CDP_URL ?? 'http://127.0.0.1:9222',
    requestedPublication: mode === 'pr' ? !options.noPublish : mode === 'issue' ? Boolean(options.publish) : false,
  };
}

function toKey(flag) {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
    this.status = 'invalid_request';
  }
}
