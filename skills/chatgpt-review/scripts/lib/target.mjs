import { CliError } from './cli.mjs';

export function normalizeGithubTarget(input, expectedKind) {
  let url;
  try { url = new URL(input); } catch { throw new CliError(`Invalid GitHub URL: ${input}`); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new CliError('Target must be an https://github.com URL');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 4) throw new CliError('Target must identify a GitHub pull request or issue');
  const [owner, repo, segment, number] = parts;
  const kind = segment === 'pull' ? 'pr' : segment === 'issues' ? 'issue' : null;
  if (!kind || !/^\d+$/.test(number) || parts.length !== 4) throw new CliError('Target must be a canonical pull request or issue URL');
  if (kind !== expectedKind) throw new CliError(`Expected a GitHub ${expectedKind}, received ${kind}`);
  const canonicalUrl = `https://github.com/${owner}/${repo}/${segment}/${Number(number)}`;
  return { kind, owner, repo, number: Number(number), canonicalUrl, identity: `${owner}/${repo}#${Number(number)}` };
}
