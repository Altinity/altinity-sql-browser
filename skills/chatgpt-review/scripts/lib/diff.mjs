import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from './cli.mjs';

const execFileAsync = promisify(execFile);
const SENSITIVE = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;

export function isSensitivePath(filename) { return SENSITIVE.test(filename.replaceAll('\\', '/')); }

export async function collectLocalDiff({ repo = process.cwd(), base, workingTree = false, includeUntracked = false }, runGit = git) {
  const root = (await runGit(repo, ['rev-parse', '--show-toplevel'])).trim();
  const selectedBase = base ?? await discoverBase(root, runGit);
  const sections = [];
  const trackedNames = new Set();
  const add = async (label, args, nameArgs) => {
    const names = (await runGit(root, nameArgs)).split('\n').filter(Boolean);
    for (const name of names) {
      if (isSensitivePath(name)) throw new CliError(`Refusing to upload likely sensitive file: ${name}`);
      trackedNames.add(name);
    }
    const content = await runGit(root, args);
    if (content.trim()) sections.push(`## ${label}\n\n${stripBinaryPatches(content)}`);
  };
  await add(`Committed branch changes from ${selectedBase}`, ['diff', '--no-ext-diff', '--no-color', '--no-textconv', `${selectedBase}...HEAD`], ['diff', '--name-only', `${selectedBase}...HEAD`]);
  await add('Index changes', ['diff', '--cached', '--no-ext-diff', '--no-color', '--no-textconv'], ['diff', '--cached', '--name-only']);
  if (workingTree) await add('Working-tree changes', ['diff', '--no-ext-diff', '--no-color', '--no-textconv'], ['diff', '--name-only']);
  if (includeUntracked) {
    const names = (await runGit(root, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
    const chunks = [];
    for (const name of names) {
      if (isSensitivePath(name)) throw new CliError(`Refusing to upload likely sensitive file: ${name}`);
      const full = path.join(root, name);
      const buffer = await fs.readFile(full);
      if (buffer.includes(0)) chunks.push(`### ${name}\n[binary content excluded]`);
      else chunks.push(`### ${name}\n${buffer.toString('utf8')}`);
    }
    if (chunks.length) sections.push(`## Untracked files\n\n${chunks.join('\n\n')}`);
  }
  if (!sections.length) throw new CliError('No local changes found for the selected inputs');
  return { root, text: `# Local review material\n\n${sections.join('\n\n')}`, paths: [...trackedNames] };
}

async function discoverBase(root, runGit) {
  try {
    const remoteHead = (await runGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (remoteHead) return remoteHead;
  } catch {}
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    try { await runGit(root, ['rev-parse', '--verify', candidate]); return candidate; } catch {}
  }
  return 'HEAD';
}

export async function writePrivateTempFile(name, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-review-'));
  await fs.chmod(dir, 0o700);
  const filename = path.join(dir, name);
  await fs.writeFile(filename, content, { mode: 0o600 });
  return { filename, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

export function stripBinaryPatches(diff) {
  return diff.replace(/GIT binary patch\n(?:[\s\S]*?)(?=^diff --git |$(?![\s\S]))/gm, '[binary patch excluded]\n');
}

async function git(cwd, args) {
  try { return (await execFileAsync('git', args, { cwd, maxBuffer: 100 * 1024 * 1024 })).stdout; }
  catch (error) { throw new CliError(`git ${args[0]} failed: ${error.stderr?.trim() || error.message}`); }
}
