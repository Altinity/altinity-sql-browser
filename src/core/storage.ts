// Thin, fail-safe wrappers over a Web Storage area (localStorage by default).
// The store is injectable so tests run without a real localStorage and so the
// app degrades gracefully when storage is unavailable (private mode, quota).

// The read half of a storage area — only what `loadJSON`/`loadStr` call.
interface ReadableStore {
  getItem(key: string): string | null;
}
// The write half of a storage area — only what `saveJSON`/`saveStr` call.
interface WritableStore {
  setItem(key: string, value: string): void;
}
type StorageArea = ReadableStore & WritableStore;

function defaultStore(): StorageArea | null {
  try {
    const ls = globalThis.localStorage;
    return ls && typeof ls.getItem === 'function' ? ls : null;
  } catch {
    return null;
  }
}

/** Read + JSON.parse `key`; return `fallback` on miss or parse error. */
export function loadJSON(key: string, fallback: unknown, store: ReadableStore | null = defaultStore()): unknown {
  if (!store) return fallback;
  try {
    const v = store.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

/** JSON.stringify + write `value` at `key`. No-op if storage is unavailable. */
export function saveJSON(key: string, value: unknown, store: WritableStore | null = defaultStore()): void {
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** Read a raw string at `key`, or `fallback`. */
export function loadStr(key: string, fallback: string, store: ReadableStore | null = defaultStore()): string {
  if (!store) return fallback;
  const v = store.getItem(key);
  return v == null ? fallback : v;
}

/** Write a raw string. No-op if storage is unavailable. */
export function saveStr(key: string, value: string, store: WritableStore | null = defaultStore()): void {
  if (!store) return;
  try {
    store.setItem(key, value);
  } catch {
    /* ignore */
  }
}
