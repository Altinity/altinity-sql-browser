import { EXIT_CODES } from './cli.mjs';

export function resultDocument(overrides = {}) {
  return {
    status: 'internal_error',
    response_text: '',
    session: null,
    conversation_url: null,
    elapsed_seconds: 0,
    pass_number: null,
    requested_publication: false,
    reported_reviewed_sha: null,
    reported_github_comment_url: null,
    error: null,
    ...overrides,
  };
}

export function renderResult(result, format = 'json') {
  if (format === 'json') return `${JSON.stringify(result)}\n`;
  const lines = [
    `Status: ${result.status}`,
    `Session: ${result.session ?? 'none'}`,
    `Conversation: ${result.conversation_url ?? 'none'}`,
    `Pass: ${result.pass_number ?? 'n/a'}`,
    `Elapsed: ${result.elapsed_seconds}s`,
  ];
  if (result.error) lines.push(`Error: ${result.error}`);
  if (result.response_text) lines.push('', result.response_text);
  return `${lines.join('\n')}\n`;
}

export function exitCode(status) { return EXIT_CODES[status] ?? EXIT_CODES.internal_error; }
