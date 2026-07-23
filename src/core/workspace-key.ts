// Pure workspace URL-key rules (#406). Persisted keys are strict canonical
// ASCII. Name derivation is deliberately lossy and deterministic; user-entered
// keys use validateWorkspaceKey and are never silently rewritten.

export const WORKSPACE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export type WorkspaceKeyValidation =
  | { ok: true; key: string }
  | { ok: false; reason: 'required' | 'invalid' };

/** Normalize a lookup without turning an invalid key into a valid one. */
export function normalizeWorkspaceKeyLookup(value: string): string {
  return value.toLowerCase();
}

/** Strictly validate a user-entered or persisted canonical workspace key. */
export function validateWorkspaceKey(value: unknown): WorkspaceKeyValidation {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: 'required' };
  }
  if (!WORKSPACE_KEY_PATTERN.test(value)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, key: value };
}

export function isValidWorkspaceKey(value: unknown): value is string {
  return validateWorkspaceKey(value).ok;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function derivedBase(name: unknown): string {
  if (typeof name !== 'string') return 'workspace';
  const key = asciiLower(name)
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return key || 'workspace';
}

/**
 * Derive an available canonical key from a display name.
 *
 * Existing keys are compared case-insensitively. A collision keeps the base
 * for the first workspace and appends `_2`, `_3`, ... for later workspaces.
 */
export function deriveWorkspaceKey(
  name: unknown,
  existingKeys: Iterable<string> = [],
): string {
  const base = derivedBase(name);
  const occupied = new Set(Array.from(existingKeys, normalizeWorkspaceKeyLookup));
  if (!occupied.has(base)) return base;
  let suffix = 2;
  while (occupied.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}
