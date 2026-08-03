import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './cli.mjs';

export function defaultStateDir(env = process.env, platform = process.platform, homedir = os.homedir()) {
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', 'chatgpt-review');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(homedir, 'AppData', 'Local'), 'chatgpt-review');
  return path.join(env.XDG_STATE_HOME ?? path.join(homedir, '.local', 'state'), 'chatgpt-review');
}

export class SessionStore {
  constructor(root = defaultStateDir()) { this.root = root; }
  async initialize() {
    await fs.mkdir(path.join(this.root, 'sessions'), { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
    await fs.chmod(path.join(this.root, 'sessions'), 0o700);
  }
  async create(data) {
    const handle = crypto.randomUUID();
    const now = new Date().toISOString();
    const record = sanitize({ handle, passCount: 0, createdAt: now, updatedAt: now, ...data });
    await this.write(record);
    return record;
  }
  async load(handle) {
    if (!/^[0-9a-f-]{36}$/i.test(handle)) throw new CliError('Invalid session handle');
    try {
      return sanitize(JSON.parse(await fs.readFile(this.sessionPath(handle), 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') throw new CliError(`Unknown session: ${handle}`);
      throw error;
    }
  }
  async write(record) {
    await this.initialize();
    const clean = sanitize({ ...record, updatedAt: new Date().toISOString() });
    const destination = this.sessionPath(clean.handle);
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
    if (clean.targetIdentity) await this.writeIndex(clean.targetIdentity, clean.handle);
    return clean;
  }
  async latestFor(targetIdentity) {
    try {
      const index = JSON.parse(await fs.readFile(path.join(this.root, 'targets.json'), 'utf8'));
      return index[targetIdentity] ? this.load(index[targetIdentity]) : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  sessionPath(handle) { return path.join(this.root, 'sessions', `${handle}.json`); }
  async writeIndex(identity, handle) {
    const filename = path.join(this.root, 'targets.json');
    let current = {};
    try { current = JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    current[identity] = handle;
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
    await fs.chmod(filename, 0o600);
  }
}

function sanitize(record) {
  const allowed = ['handle', 'mode', 'targetIdentity', 'canonicalUrl', 'conversationUrl', 'passCount', 'createdAt', 'updatedAt', 'reportedReviewedSha', 'reportedGithubCommentUrl'];
  return Object.fromEntries(allowed.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}
