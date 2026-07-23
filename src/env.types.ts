// Phase-0 typed contract for the injected environments `createApp(env)`
// (src/ui/app.js) and `bootstrap(app, env)` (src/main.js) consume. Two
// distinct shapes — bootstrap's `env` is not the same object as createApp's,
// has no fallbacks, and is fully required. No behavior change: the runtime
// modules stay untouched `.js`; this only describes what they already read.

import type { App } from './ui/app.types.js';
import type { EditorPort } from './editor/editor-port.types.js';
import type { SpecEditorPort } from './editor/spec-editor.types.js';
import type { CodeViewerFactory } from './editor/code-viewer.types.js';
import type { DynamicSources } from './core/spec-completion.js';

/** The minimal cross-tab notification port `createApp` addresses (#343 §5) —
 * `BroadcastChannel` structurally satisfies it, so the real-browser default
 * casts to it without an `unknown` bridge, and a test fake implements just
 * these three members. The body carried is always an opaque invalidation
 * signal, never the workspace itself, so `postMessage`/`onmessage` are typed
 * `unknown`. */
export interface BroadcastChannelPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/** The env param of `createApp(env = {})`. Every field is optional — each has
 * a real-browser fallback (`win.*`) inside createApp. */
export interface CreateAppEnv {
  document?: Document;
  window?: Window;
  location?: Location;
  fetch?: typeof fetch;
  crypto?: Crypto;
  sessionStorage?: Storage;
  /** IndexedDB factory seam (#280 Phase 2 / #284) — injected like crypto/
   * sessionStorage so the atomic `WorkspaceRepository` (app.workspace) has a
   * real backing store in the browser and an in-memory fake in tests.
   * Resolves to `win.indexedDB` when omitted; may be absent entirely on a
   * platform without IndexedDB, in which case workspace operations reject
   * (caught by the repository) rather than throwing at construction. */
  indexedDB?: IDBFactory;
  root?: Element | null;
  Chart?: unknown; // Chart.js constructor — new app.Chart(canvas, cfg)
  cssVar?: (name: string) => string;
  Dagre?: unknown; // @dagrejs/dagre module ({graphlib, layout})
  openWindow?: (url?: string, target?: string, features?: string) => Window | null;
  stylesText?: string;
  faviconHref?: string;
  showSaveFilePicker?: ((opts?: unknown) => Promise<unknown>) | null;
  showDirectoryPicker?: ((opts?: unknown) => Promise<unknown>) | null;
  isSecureContext?: boolean;
  build?: string;
  matchMedia?: ((query: string) => MediaQueryList) | null;
  /** #343 §5: cross-tab invalidation channel factory — mirrors the matchMedia/
   *  showSaveFilePicker "capability or null" precedent. Defaults to a real
   *  `new BroadcastChannel(name)` when the platform has it, else `null` (the
   *  focus/visibility fallback still provides consistency). Tests inject a fake
   *  bus so two `createApp()` instances can exchange invalidation signals
   *  deterministically. */
  broadcastChannel?: (name: string) => BroadcastChannelPort | null;
  /** #343 §6: reads whether this tab is currently visible — the state a
   *  focus/visibility refresh consults before reloading. Defaults to
   *  `doc.visibilityState !== 'hidden'` (a getter in happy-dom, hence the seam
   *  so tests can toggle it). */
  documentVisible?: () => boolean;
  FileReader?: typeof FileReader;
  Editor?: (app: App) => EditorPort;
  SpecEditor?: (app: App) => SpecEditorPort;
  specValidators?: unknown; // {validate, register} — see core/spec-draft.js
  specCompletionSources?: DynamicSources; // CM6 completion sources
  CodeViewer?: CodeViewerFactory;
  now?: () => number;
  wallNow?: () => number;
  retryMs?: number;
  /** `unknown`'s only real reader (app.ts's share()/copySnapshot()) always
   * narrows to `.clipboard.writeText` — typed as the real `Clipboard` shape so
   * that narrowing needs no cast; every test fixture already supplies
   * `{ clipboard: { writeText } }` or omits the field entirely. */
  navigator?: { clipboard?: Clipboard } & Record<string, unknown>;
  download?: (filename: string, mime: string, content: BlobPart) => void;
}

/** The env param of `bootstrap(app, env)` — a distinct, fully-required shape
 * (no fallbacks; main.js's own logic depends on every field). */
export interface BootstrapEnv {
  location: Location;
  sessionStorage: Storage;
  history: History;
  fetch: typeof fetch;
}
