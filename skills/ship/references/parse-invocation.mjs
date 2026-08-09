export function parseShipInvocation(input) {
  const tokens = String(input).trim().replace(/^\/ship(?:\s+|$)/, '').split(/\s+/).filter(Boolean);
  let planner = 'chatgpt';
  let scope = null;
  let plannerSeen = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'unattended') continue;
    if (token === '--planner') {
      if (plannerSeen) throw new Error('--planner may be specified only once');
      const value = tokens[++index];
      if (!['fable', 'chatgpt'].includes(value)) throw new Error('--planner must be fable or chatgpt');
      planner = value;
      plannerSeen = true;
      continue;
    }
    if (token.startsWith('--')) throw new Error(`Unknown /ship option: ${token}`);
    if (scope) throw new Error('/ship accepts exactly one scope expression');
    scope = token;
  }
  if (!scope || !/^(?:\d+\.\d+|\d+(?:,\d+)*)$/.test(scope)) {
    throw new Error('/ship requires ISSUE, ISSUE.PHASE, or a comma-separated issue list');
  }
  return { scope, planner };
}
