import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PLAN_BEGIN = '<<<CHATGPT_PLAN_BEGIN>>>';
export const PLAN_END = '<<<CHATGPT_PLAN_END>>>';

export class InvalidPlanResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPlanResponseError';
    this.status = 'invalid_response';
  }
}

export function parsePlanAuthorResponse(text) {
  const normalized = text.trim();
  const statuses = [...normalized.matchAll(/^PLAN_STATUS:\s*(READY|BLOCKED)\s*$/gm)].map((match) => match[1]);
  if (statuses.length !== 1) throw new InvalidPlanResponseError('Expected exactly one PLAN_STATUS: READY or PLAN_STATUS: BLOCKED line');

  const beginCount = normalized.split(PLAN_BEGIN).length - 1;
  const endCount = normalized.split(PLAN_END).length - 1;
  if (statuses[0] === 'BLOCKED') {
    if (beginCount || endCount) throw new InvalidPlanResponseError('A blocked response must not contain plan delimiters');
    const match = normalized.match(/^PLAN_STATUS:\s*BLOCKED\s*\r?\nBLOCKER:\s*(\S.*?)\s*$/);
    if (!match) throw new InvalidPlanResponseError('A blocked response requires exactly one non-empty BLOCKER line and no extra content');
    return { planStatus: 'blocked', plan: null, blocker: match[1].trim() };
  }

  if (beginCount !== 1 || endCount !== 1) throw new InvalidPlanResponseError('A ready response requires exactly one plan delimiter pair');
  // Trailing content after PLAN_END (e.g. a web-search citation footnote ChatGPT appends
  // when it looked something up while authoring — exactly the behavior a "verify the exact
  // npm version" finding asks for) is harmless: the begin/end-count check above already
  // guarantees there is no second delimited plan hiding in it. Only the START is anchored —
  // PLAN_STATUS/BEGIN must still be the very first thing, so a rogue preamble still fails.
  const readyPattern = new RegExp(`^PLAN_STATUS:\\s*READY\\s*\\r?\\n${escapeRegex(PLAN_BEGIN)}\\r?\\n([\\s\\S]*?)\\r?\\n${escapeRegex(PLAN_END)}[\\s\\S]*$`);
  const match = normalized.match(readyPattern);
  if (!match) throw new InvalidPlanResponseError('A ready response must contain only one ordered, line-delimited plan');
  const plan = match[1].trim();
  if (!plan) throw new InvalidPlanResponseError('The delimited plan is empty');
  if (!/^#{1,6}\s+\S/m.test(plan)) throw new InvalidPlanResponseError('The delimited plan is not complete Markdown with a heading');
  return { planStatus: 'ready', plan: `${plan}\n`, blocker: null };
}

export async function replaceFileAtomically(filename, content) {
  const destination = path.resolve(filename);
  const directory = path.dirname(destination);
  await fs.access(directory);
  let mode = 0o600;
  try { mode = (await fs.stat(destination)).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { mode, flag: 'wx' });
    await fs.rename(temporary, destination);
    await fs.chmod(destination, mode);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
