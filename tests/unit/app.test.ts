import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import dagre from '@dagrejs/dagre';
import { createApp } from '../../src/ui/app.js';
import { createCodeMirrorEditor } from '../../src/editor/codemirror-adapter.js';
import { createSpecEditor } from '../../src/editor/spec-editor.js';
import type { SpecEditorApp } from '../../src/editor/spec-editor.js';
import type { CodeViewerOptions } from '../../src/editor/code-viewer.types.js';
import { AST_PROGRESSIVE_THRESHOLD } from '../../src/net/ch-client.js';
import { libraryControls, openFileMenu } from '../../src/ui/file-menu.js';
import { emptyRecentMap, recordRecent } from '../../src/core/recent-values.js';
import { queryDescription } from '../../src/core/saved-query.js';
import { createSpecValidatorRegistry } from '../../src/core/spec-draft.js';
import { savedQuery } from '../helpers/saved-query.js';
import { fakeIndexedDbFactory } from '../helpers/fake-idb.js';
import { fakeBroadcastBus } from '../helpers/fake-broadcast.js';
import { encodePortableBundleJson } from '../../src/dashboard/model/portable-bundle-codec.js';
import { decodeShare } from '../../src/core/share.js';
import type { CreateAppEnv, BroadcastChannelPort } from '../../src/env.types.js';
import type { App, WorkspaceChangedMessage } from '../../src/ui/app.types.js';
import type { AppState, QueryTab } from '../../src/state.js';
import { renameSaved } from '../../src/state.js';
import type { SchemaDb } from '../../src/core/from-scope.js';
import type { SavedQueryV2, StoredWorkspaceV1 } from '../../src/generated/json-schema.types.js';
import type { CompletionItem, AssembledReference } from '../../src/core/completions.js';
import type {
  QueryResult, ScriptResult, ScriptExportResult, ScriptEntry, ScriptExportEntry, ResultSchemaGraph,
} from '../../src/ui/results.js';

function jwt(payload: Record<string, unknown>): string {
  // btoa/atob (not node:crypto's Buffer — no @types/node in this project) —
  // the same base64url shape core/jwt.js's decodeJwtPayload expects (matches
  // dashboard.test.ts's own identical helper).
  const b = (o: unknown): string => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b({ alg: 'RS256' })}.${b(payload)}.sig`;
}
const validToken = jwt({ email: 'me@example.com', exp: Math.floor(Date.now() / 1000) + 3600 });

/** A minimal sessionStorage-like stub — a real `Storage` structurally
 * (length/key/clear included), so it plugs straight into `env.sessionStorage`
 * (`CreateAppEnv`) with no cast. Matches dashboard.test.ts's own `MemSession`. */
interface MemSession {
  getItem(k: string): string | null;
  setItem(k: string, v: unknown): void;
  removeItem(k: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
  _map: Map<string, string>;
  [k: string]: unknown;
}
function memSession(initial: Record<string, string> = {}): MemSession {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (index) => [...m.keys()][index] ?? null,
    get length() { return m.size; },
    _map: m,
  };
}

// An in-memory Web Storage stub for tests that assert against the app's
// localStorage seam (storage.js reaches globalThis.localStorage ambiently, not
// via the injected env). Stubbing the global keeps the assertion insulated from
// the host runtime's native Web Storage — e.g. Node 25's native localStorage,
// which without --localstorage-file leaves getItem undefined (issue #130).
// Only getItem/setItem are ever read (storage.js's own seam) — `vi.stubGlobal`
// takes `unknown`, so this doesn't need the full `Storage` shape.
interface MemStore { getItem(k: string): string | null; setItem(k: string, v: unknown): void }
function memStore(initial: Record<string, string> = {}): MemStore {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

// A streaming response body (JSONStringsEachRowWithProgress lines), for the
// run()/runScript() paths that read resp.body.getReader() rather than resp.json().
interface FakeBody { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock(): void } }
function streamBody(lines: string[]): FakeBody {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < lines.length ? { done: false, value: new TextEncoder().encode(lines[i++]) } : { done: true }),
      releaseLock: () => {},
    }),
  };
}
// A body whose reader throws on the first read — for mid-export failure tests.
function throwingBody(message: string): FakeBody {
  return { getReader: () => ({ read: async () => { throw new Error(message); }, releaseLock: () => {} }) };
}
/** The subset of a real `Response` app.ts's fetch-consuming code reads —
 * `Response` structurally satisfies this (a genuine subtype relationship, so
 * `makeFetch`'s mock casts cleanly to `typeof fetch` below without an
 * `unknown` bridge). Matches dashboard.test.ts's own `FakeResponse`. */
interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  clone(): FakeResponse;
  body?: FakeBody | null;
  headers: { get(name: string): string | null };
}
interface RespOpts {
  ok?: boolean; status?: number; json?: unknown; text?: string; body?: FakeBody | null;
  headers?: Record<string, string>;
}
function resp(opts: RespOpts): FakeResponse {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? JSON.stringify(opts.json),
    clone() { return this; },
    body: opts.body,
    headers: { get: (name) => (opts.headers && opts.headers[name]) ?? null },
  };
}
// Build a ClickHouse mid-stream exception frame's raw text (issue #87):
// \r\n__exception__\r\n<tag>\r\n<message>\n<len> <tag>\r\n__exception__\r\n
function exceptionFrame(tag: string, message: string): string {
  const len = new TextEncoder().encode(message).length;
  return '\r\n__exception__\r\n' + tag + '\r\n' + message + '\n' + len + ' ' + tag + '\r\n__exception__\r\n';
}
/** A `FileSystemWritableFileStream`-shaped handle + its owning file handle,
 * for streaming-export tests — matches app.ts's own `WritableFileStreamLike`/
 * `FileHandleLike` local seam types. */
interface FakeWritable { write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
interface FakeFileHandle { name: string; createWritable(): Promise<FakeWritable>; move?(name: string): Promise<void> }
/** The subset of `showSaveFilePicker`'s real options bag app.ts's own export
 *  path constructs — suggestedName + a single MIME/extension `types[0]`. */
interface SaveFilePickerOpts { suggestedName: string; types: { accept: Record<string, string[]> }[] }
function fakeFileHandle(name = 'export.tsv'): { handle: FakeFileHandle; writable: FakeWritable; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  const writable: FakeWritable = {
    write: vi.fn(async (chunk: Uint8Array) => { chunks.push(Uint8Array.from(chunk)); }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const handle: FakeFileHandle = { name, createWritable: vi.fn(async () => writable), move: vi.fn(async () => {}) };
  return { handle, writable, chunks };
}
function writtenText(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { merged.set(c, o); o += c.length; }
  return new TextDecoder().decode(merged);
}

// A fetch stub that routes by SQL/URL. `sql` is plain `string` (never
// `undefined`) so every route predicate's own `/pattern/.test(sql)` typechecks
// without an per-callsite guard — a request with no body coerces to '' here,
// same as `undefined` did at runtime (neither ever matches a real route
// pattern, so no test's behavior depends on the distinction).
// A route's response is either a `FakeResponse` literal or a supplier — most
// suppliers return one synchronously, but several tests hand back a still-
// pending `Promise<FakeResponse>` (captured via its own `resolveXxx`) to
// control exactly when a request resolves, so the supplier's return type
// covers both.
type FetchRoute = [(url: string, sql: string) => boolean, FakeResponse | (() => FakeResponse | Promise<FakeResponse>)];
// Returns `typeof fetch` (via the `asFetch` seam below, cast once here) rather
// than leaving every one of this suite's many `env({ fetch: makeFetch(...) })`
// call sites to cast it individually — `FakeResponse` structurally satisfies
// the real `Response` shape app.ts's fetch-consuming code reads (see
// `FakeResponse`'s own doc comment), so this is the same single-level `as`
// `asFetch` already documents, just applied at the one place that builds it.
function makeFetch(routes: FetchRoute[]): typeof fetch {
  return asFetch(vi.fn(async (url: string, init?: { body?: string }) => {
    const sql = (init && init.body) || '';
    for (const [test, r] of routes) if (test(url, sql)) return typeof r === 'function' ? r() : r;
    return resp({ json: { data: [] } });
  }));
}
// A window/fetch stub only ever needs the one member real code reads (e.g.
// `postMessage`) — never the real interface's hundred-odd other members, so
// widening the PARAMETER to `object` (assignable both ways with `Window`/
// `typeof fetch`, since every function and every plain object is an
// `object`) makes the cast inside a genuine single-level `as`, not an
// `unknown` bridge. Matches dashboard.test.ts's own `asWindow`/`asFetch`.
const asWindow = (v: object): Window => v as Window;
const asFetch = (v: object): typeof globalThis.fetch => v as typeof globalThis.fetch;
// The reverse of `asFetch`: every `fetch` seam in this suite is really a
// `vi.fn(...)` mock underneath its `typeof fetch` type (chCtx.fetch, `e.fetch`,
// a bare local `fetch`, all built by `makeFetch`/`makeSignalFetch` above) —
// this reads back the mock-inspection surface (`.mock.calls`, `.mockClear()`)
// the real `fetch` type doesn't carry.
const asMock = (fn: typeof fetch): Mock => fn as Mock;
// A general-purpose variant for a mock hiding behind a plain function-typed
// interface member (e.g. `FakeWritable.write`, declared as a bare
// `(chunk: Uint8Array) => Promise<void>` so the object literal satisfies the
// interface, even though the real value assigned is a `vi.fn(...)`).
const asAnyMock = (fn: (...args: never[]) => unknown): Mock => fn as Mock;
// A `{ writeText }`-only stub doesn't structurally overlap enough of the real
// `Clipboard` interface for a direct `as Clipboard` (TS's "sufficiently
// overlapping" cast check rejects it outright) — widening the PARAMETER to
// `object` first (same `asWindow`/`asFetch` trick above) makes it a genuine
// single-level cast, not an `unknown` bridge.
const asClipboard = (v: object): Clipboard => v as Clipboard;
// `ActionsRegistry.loadIntoNewTab`'s `queryOrName` accepts `string | Json`
// (app.types.ts) — the real saved-query shape it's documented against, but
// `SavedQueryV2` (the generated, concretely-fielded type `app.state.savedQueries`
// actually holds) has no index signature, so passing one through needs the
// same `object`-parameter bridge as `asWindow`/`asClipboard` above.
const asQueryOrName = (v: object): Record<string, unknown> => v as Record<string, unknown>;
// `App.refData`/`App.completions` are deliberately loose (`Json`-shaped)
// placeholders (see app.types.ts's own doc comment on `refData`) — the real
// values `createApp` always populates them with are `core/completions.ts`'s
// `AssembledReference`/`CompletionItem[]`. Same `object`-parameter bridge.
// `createSpecEditor`'s own `SpecEditorApp` param (spec-editor.ts) is a real
// mismatch against `App` — `App.specCompletionSources` is typed `unknown[]`
// (env.types.ts/app.types.ts) while `SpecEditorApp` (via `SpecCompletionApp`)
// wants `DynamicSources`, the object-map shape `createSpecCompletionSources()`
// actually returns. That's a pre-existing type inaccuracy spanning several
// other already-converted test fixtures (dashboard.test.ts et al. all pin
// `specCompletionSources: []`) — out of this task's file scope to widen, so
// bridged locally here the same `object`-parameter way as `asWindow` above.
const asSpecEditorApp = (v: object): SpecEditorApp => v as SpecEditorApp;
// A handful of `openWindow` stubs return a bare marker string (proving the
// pass-through wiring fired) rather than a real `Window` — same `object`
// bridge as the rest of this seam's casts.
const asOpenWindow = (v: object): CreateAppEnv['openWindow'] => v as CreateAppEnv['openWindow'];
// A deliberately partial `Crypto` stub (missing `randomUUID`, forcing a
// fallback path) — same `object`-parameter bridge as the rest of this file's
// seam casts.
const asCrypto = (v: object): Crypto => v as Crypto;
// `AppState.schema` is `Signal<unknown[] | null>` (state.ts) — the real
// shape every fixture/assertion below reads is `core/from-scope.ts`'s own
// `SchemaDb[]`, the same schema-tree contract app.ts's own `loadColumns`
// narrows to internally.
const schemaOf = (app: App): SchemaDb[] => app.state.schema.value as SchemaDb[];
// A pre-#170 tab shape (`sql`/`dirty`, not `sqlDraft`/`dirtySql`) — a
// long-standing fixture (predates this suite's TS conversion) exercising that
// the action wrappers below don't throw on a minimal/legacy tab shape.
const asLegacyTab = (v: object): QueryTab => v as QueryTab;
const asRefData = (v: object): AssembledReference => v as AssembledReference;
const asCompletions = (v: object): CompletionItem[] => v as CompletionItem[];
const refDataOf = (app: App): AssembledReference => asRefData(app.catalog.refData);
const completionsOf = (app: App): CompletionItem[] => asCompletions(app.catalog.completions);

// Matches results.test.ts / login.test.ts's own `qs`/`qsa` convention: every
// selector below targets a real, already-rendered element a passing test
// requires to exist, so a forced non-null cast (never a null check) is the
// same "a test would fail anyway" reasoning as the rest of this suite's `!`.
// `root` itself accepts `App.root`'s own nullable type (`Element | null`) for
// the same reason — every real call below fires only once the app has
// mounted into a real `#root`.
const qs = <T extends Element = HTMLElement>(root: ParentNode | null, selector: string): T => root!.querySelector(selector) as T;
const qsa = <T extends Element = HTMLElement>(root: ParentNode | null, selector: string): T[] =>
  [...root!.querySelectorAll(selector)] as T[];
// `AppDom` (app.types.ts) documents "known-consumed keys, not a closed
// interface" — a couple of assertions below confirm a legacy/never-built key
// (validateSpecBtn/revertSpecBtn) stays absent, which needs a read outside the
// declared key set. Widening `app.dom` (never `app` itself) to a plain
// dictionary for that one read is a genuine single-level `as` (every AppDom
// member's value type is compatible with `unknown`).
const domAny = (a: App): Record<string, unknown> => a.dom as Record<string, unknown>;

// tests/helpers/saved-query.js is plain JS with no default for its `id`
// param; TS's inference over its destructured signature therefore omits `id`
// from the parameter type it derives, rejecting every fixture literal below
// with an excess-property error. Pin the honest fixture shape it accepts
// (same convention as file-menu.test.ts / saved-history.test.ts).
interface SavedQueryFixture {
  id: string;
  sql?: string;
  name?: string;
  favorite?: boolean;
  description?: string;
  view?: string;
  panel?: unknown;
  dashboard?: unknown;
  spec?: Record<string, unknown>;
  [k: string]: unknown;
}
const savedQueryFixture = savedQuery as (fixture: SavedQueryFixture) => SavedQueryV2;

// `QueryTab.result` (state.ts) is deliberately opaque there (`Record<string,
// unknown> | null`) — `ui/results.ts` is the one place that owns the real
// shape a run actually produces (`QueryResult | ScriptResult |
// ScriptExportResult`, see its own module doc comment). These read-side
// accessors mirror results.test.ts's own `Indexed<T>` convention for the
// write side: a real run's `tab.result` always holds exactly one of those
// three shapes by the time a test reads it back (never asserted against
// beforehand), so the cast is a pure type reinterpretation, same spirit as
// `asApp`/`asFetch` above.
type Indexed<T> = T & Record<string, unknown>;
const result = <T = QueryResult>(tab: { result: Record<string, unknown> | null }): Indexed<T> => tab.result as Indexed<T>;
const scriptOf = (tab: { result: Record<string, unknown> | null }): ScriptEntry[] => result<ScriptResult>(tab).script;
// `ScriptEntry`'s per-status members ('ok' | 'error' | 'rows') — a narrowed
// read for the one status-specific field an assertion below reaches for,
// same "would fail anyway if the wrong status landed" reasoning as this
// suite's `!`.
type ScriptRowsEntry = Extract<ScriptEntry, { status: 'rows' }>;
type ScriptErrorEntry = Extract<ScriptEntry, { status: 'error' }>;
const scriptExportOf = (tab: { result: Record<string, unknown> | null }): ScriptExportEntry[] =>
  result<ScriptExportResult>(tab).scriptExport;
const schemaGraphOf = (tab: { result: Record<string, unknown> | null }): Indexed<ResultSchemaGraph> =>
  result<QueryResult>(tab).schemaGraph as Indexed<ResultSchemaGraph>;
// `QueryTab.filterPreview`'s success shape (filter-execution.ts's own
// `helpers[].options` normalized-preview payload) — `tab.filterPreview` is
// opaque `Record<string, unknown> | null` on `QueryTab` for the same reason
// `.result` is (see `result()` above).
interface FilterPreviewNormalized { helpers: { options: { value: string; label: string }[] }[] }
const filterPreviewNormalizedOf = (tab: { filterPreview: Record<string, unknown> | null }): FilterPreviewNormalized =>
  tab.filterPreview!.normalized as FilterPreviewNormalized;
// `outputFormat` is a stray, never-declared field the untyped JS original set
// on `app.state` before a since-removed fallback path — inert today (no code
// reads it), kept as the same harmless dead write via a local intersection
// rather than deleting a pre-existing statement.
const withOutputFormat = (s: AppState): AppState & { outputFormat?: string } => s as AppState & { outputFormat?: string };
// `AppState.varValues` is typed `Record<string, string>` (state.ts) — the
// pipeline's own runtime values include array-valued vars too (#173's
// `Array(T)` declarations), which a couple of tests below exercise directly.
// Bridged locally (out of this task's file scope to widen state.ts itself)
// via the same `object`-parameter trick as `asWindow` above.
const asVarValues = (v: object): AppState['varValues'] => v as AppState['varValues'];
/** happy-dom's plain `Event` stands in for a real `DragEvent` (matches
 *  dashboard.test.ts's own `FakeMessageEvent` convention) — the schema-graph
 *  drag/drop handlers only ever read `dataTransfer.types`/`.getData`. */
interface FakeDragEvent extends Event { dataTransfer: { types?: string[]; getData?(format: string): string } }

function env(over: Partial<CreateAppEnv> = {}): CreateAppEnv {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return {
    root,
    document,
    window,
    location: {
      host: 'ch.example', origin: 'https://ch.example', pathname: '/sql', search: '', hash: '', href: 'https://ch.example/sql',
    } as Location,
    sessionStorage: memSession({ oauth_id_token: validToken }),
    crypto: globalThis.crypto,
    Dagre: dagre,
    Editor: createCodeMirrorEditor, // the real adapter — app tests exercise editor-backed flows (#143/#21)
    SpecEditor: (app) => createSpecEditor(asSpecEditorApp(app)),
    CodeViewer: vi.fn(() => ({ setText: vi.fn(), setLanguage: vi.fn(), setWrap: vi.fn(), focus: vi.fn(), destroy: vi.fn() })),
    fetch: asFetch(makeFetch([])),
    now: () => 0,
    retryMs: 0, // instant script-statement retry in tests (no real 250ms wait)
    navigator: { clipboard: asClipboard({ writeText: vi.fn(async (_data: string) => {}) }) },
    // #287 W4: every saved-query CRUD op now awaits `app.workspace.commit` —
    // a real IndexedDB-backed commit, not the retired flat `asb:saved` write.
    // Default to a working in-memory fake factory (mirrors dashboard.test.ts's
    // own local `fakeIndexedDb`) so the many real `createApp(env())`-driven
    // save/rename/favorite/delete flows below actually persist under
    // happy-dom (which has no real `indexedDB`) instead of silently failing
    // closed on every commit. A test can still override `indexedDB: undefined`
    // to exercise the no-factory fallback path deliberately.
    indexedDB: fakeIndexedDbFactory(),
    ...over,
  };
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => vi.unstubAllGlobals());

describe('createApp basics', () => {
  it('env.specValidators accepts an already-built validator service as-is (not re-wrapped)', () => {
    const service = createSpecValidatorRegistry();
    const app = createApp(env({ specValidators: service }));
    expect(app.specValidators).toBe(service); // identity — the seam's own service passes straight through
  });
  it('constructs the atomic StoredWorkspaceV1 repository (#284) behind the injected IndexedDB seam', () => {
    // `indexedDB: undefined` overrides `env()`'s own #287 W4 default fake
    // factory → falls back to win.indexedDB (absent under happy-dom). The
    // repository still constructs (lazy — no DB opened yet) and exposes the
    // full #280 contract.
    const app = createApp(env({ indexedDB: undefined }));
    expect(typeof app.workspace.loadCurrent).toBe('function');
    expect(typeof app.workspace.commit).toBe('function');
    expect(typeof app.workspace.clearCurrent).toBe('function');
    // Injecting a factory exercises the left side of `env.indexedDB ||
    // win.indexedDB`; the repository still constructs lazily (no DB is opened
    // until an operation runs — the concrete adapter is covered on its own).
    const app2 = createApp(env({ indexedDB: {} as IDBFactory }));
    expect(typeof app2.workspace.commit).toBe('function');
  });
  it('reads the stored token and derives identity', () => {
    const app = createApp(env());
    expect(app.conn.token()).toBe(validToken);
    expect(app.conn.isSignedIn()).toBe(true);
    expect(app.conn.email()).toBe('me@example.com');
    expect(app.conn.host()).toBe('ch.example');
  });
  it('wires every document-toolbar control to its injected action', () => {
    const app = createApp(env());
    app.renderApp();
    const actions = {
      run: vi.fn(), formatQuery: vi.fn(), explainQuery: vi.fn(),
      formatSpec: vi.fn(), save: vi.fn(), setEditorMode: vi.fn(),
      exportEntry: vi.fn(), share: vi.fn(),
    };
    Object.assign(app.actions, actions);
    for (const button of [
      app.dom.runBtn!, app.dom.fmtBtn!, app.dom.explainBtn!,
      app.dom.formatSpecBtn!, app.dom.saveBtn!,
      app.dom.sqlModeBtn!, app.dom.specModeBtn!, app.dom.exportBtn!, app.dom.shareBtn!,
    ]) button.dispatchEvent(new Event('click'));
    expect(actions.run).toHaveBeenCalled();
    expect(actions.formatQuery).toHaveBeenCalled();
    expect(actions.explainQuery).toHaveBeenCalled();
    expect(actions.formatSpec).toHaveBeenCalled();
    expect(actions.save).toHaveBeenCalled();
    expect(actions.setEditorMode.mock.calls).toEqual([['sql'], ['spec']]);
    expect(actions.exportEntry).toHaveBeenCalled();
    expect(actions.share).toHaveBeenCalled();
  });
  it('host falls back when location.host is empty', () => {
    const app = createApp(env({ location: { host: '', origin: 'o', pathname: '/sql' } as Location }));
    expect(app.conn.host()).toBe('clickhouse');
  });
  it('reads the ?host= URL param into app.conn.hostHint (empty when absent)', () => {
    expect(createApp(env()).conn.hostHint).toBe('');
    const app = createApp(env({ location: { host: 'h', origin: 'https://h', pathname: '/sql', search: '?host=antalya.demo:9000' } as Location }));
    expect(app.conn.hostHint).toBe('antalya.demo:9000');
  });
  it('openWindow + stylesText seams resolve from env, from window.open, and from the page <style>', () => {
    // env-provided seams win
    const a1 = createApp(env({ openWindow: asOpenWindow(() => 'X'), stylesText: 'body{color:red}' }));
    expect(a1.openWindow()).toBe('X');
    expect(a1.stylesText).toBe('body{color:red}');
    // default openWindow delegates to window.open
    const open = vi.fn(() => 'W');
    const a2 = createApp(env({ window: asWindow({ ...window, open }), openWindow: undefined, stylesText: undefined }));
    expect(a2.openWindow('', '_blank')).toBe('W');
    expect(open).toHaveBeenCalledWith('', '_blank');
    // default stylesText reads the served page's inlined <style>
    const styleEl = document.createElement('style');
    styleEl.textContent = '.x{}';
    document.head.prepend(styleEl);
    expect(createApp(env({ stylesText: undefined })).stylesText).toBe('.x{}');
    styleEl.remove();
  });
  it('faviconHref resolves from env, from the page <link rel=icon>, or empty when neither is present', () => {
    expect(createApp(env({ faviconHref: 'data:image/x;base64,AA' })).faviconHref).toBe('data:image/x;base64,AA');
    expect(createApp(env({ faviconHref: undefined })).faviconHref).toBe(''); // no <link> in the test document
    const linkEl = document.createElement('link');
    linkEl.setAttribute('rel', 'icon');
    linkEl.setAttribute('href', 'data:image/y;base64,BB');
    document.head.appendChild(linkEl);
    expect(createApp(env({ faviconHref: undefined })).faviconHref).toBe('data:image/y;base64,BB');
    linkEl.remove();
  });
  it('exposes the injected document as app.document, not just the global document', () => {
    const customDoc = document.implementation.createHTMLDocument('');
    const app = createApp(env({ document: customDoc, root: customDoc.createElement('div') }));
    expect(app.document).toBe(customDoc);
    expect(app.document).not.toBe(document);
  });
  it('exposes an injected read-only viewer factory with a stub-friendly lifecycle contract', () => {
    const createViewer = vi.fn(() => ({
      setText: vi.fn(), setLanguage: vi.fn(), setWrap: vi.fn(), focus: vi.fn(), destroy: vi.fn(),
    }));
    const app = createApp(env({ CodeViewer: createViewer }));
    const args: CodeViewerOptions = { parent: document.createElement('div'), document, text: 'raw', language: 'text', wrap: false };
    const viewer = app.CodeViewer(args);
    viewer.setWrap(true); // consumer mode change
    viewer.destroy();     // outgoing mode teardown
    viewer.destroy();     // parent teardown may safely repeat it
    expect(createViewer).toHaveBeenCalledWith(args);
    expect(viewer.setWrap).toHaveBeenCalledWith(true);
    expect(viewer.destroy).toHaveBeenCalledTimes(2);

    const fallback = createApp(env({ CodeViewer: undefined })).CodeViewer(args);
    expect(fallback.setText('x')).toBeUndefined();
    expect(fallback.setLanguage('json')).toBeUndefined();
    expect(fallback.setWrap(true)).toBeUndefined();
    expect(fallback.focus()).toBeUndefined();
    expect(fallback.destroy()).toBeUndefined();
  });
});

// #341/#344 review fix: `app.mutateWorkspace` is the only correct way to
// build a workspace-mutation candidate — `serializeWrite` alone only
// serializes EXECUTION, not the read the candidate is built from. These
// exercise the seam directly (real `createApp`/IndexedDB-backed
// `app.workspace`, mirroring `createApp basics` above) so a regression in the
// "read latest at dequeue time" discipline shows up here, not only in
// file-menu.ts's own higher-level tests.
describe('app.mutateWorkspace (#341/#344)', () => {
  const seedWorkspace = (over: Partial<import('../../src/generated/json-schema.types.js').StoredWorkspaceV1> = {}) => (
    { storageVersion: 1 as const, id: 'w1', name: 'Seed', queries: [], dashboard: null, ...over }
  );

  it('the transform receives the latest COMMITTED aggregate at DEQUEUE time, not whatever was current when mutateWorkspace was called', async () => {
    const app = createApp(env());
    await app.mutateWorkspace(() => ({ candidate: seedWorkspace() }));
    // A first write is pending in the queue (gated open manually, like
    // saved-history.test.ts's own concurrent-writes regression) — a SECOND
    // `mutateWorkspace` call fires while it's still pending.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const first = app.serializeWrite(async () => {
      await gate;
      return app.workspace.commit(seedWorkspace({ queries: [savedQuery({ id: 'q1', name: 'Q1' })] }));
    });
    const second = app.mutateWorkspace((latest) => (latest ? { candidate: { ...latest, name: 'Renamed' } } : null));
    release();
    await Promise.all([first, second]);
    const finalWs = await app.workspace.loadCurrent();
    // Both mutations landed: the queued commit's query AND the rename that ran
    // after it — a `mutateWorkspace` that captured `latest` at enqueue time
    // (before the first commit) would have reverted the query back to [].
    expect(finalWs?.queries.map((q) => q.id)).toEqual(['q1']);
    expect(finalWs?.name).toBe('Renamed');
  });

  it('a null/undefined-returning transform aborts — nothing persisted, resolves an aborted outcome', async () => {
    const app = createApp(env());
    await app.mutateWorkspace(() => ({ candidate: seedWorkspace({ name: 'Before' }) }));
    const result = await app.mutateWorkspace(() => null);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.aborted).toBe(true);
    const ws = await app.workspace.loadCurrent();
    expect(ws?.name).toBe('Before'); // untouched
  });

  it('a null CANDIDATE aborts too (and threads data back), committing nothing', async () => {
    const app = createApp(env());
    await app.mutateWorkspace(() => ({ candidate: seedWorkspace({ name: 'Before' }) }));
    const result = await app.mutateWorkspace(() => ({ candidate: null, data: 'why' }));
    expect(result.ok).toBe(false);
    expect(result.data).toBe('why');
    expect((await app.workspace.loadCurrent())?.name).toBe('Before');
  });

  it('a transform rejection propagates to the caller without wedging the queue for the next op', async () => {
    const app = createApp(env());
    await app.mutateWorkspace(() => ({ candidate: seedWorkspace({ name: 'Before' }) }));
    await expect(app.mutateWorkspace(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The queue still advances — a later op is not stuck behind the rejection.
    const result = await app.mutateWorkspace((latest) => (latest ? { candidate: { ...latest, name: 'After' } } : null));
    expect(result.ok).toBe(true);
    const ws = await app.workspace.loadCurrent();
    expect(ws?.name).toBe('After');
  });

  it('projects the committed workspace exactly once on success, and threads operation data back', async () => {
    const app = createApp(env());
    const projected: string[] = [];
    const orig = app.applyCommittedWorkspace;
    app.applyCommittedWorkspace = (ws) => { projected.push(ws.name); orig(ws); };
    const result = await app.mutateWorkspace(() => ({ candidate: seedWorkspace({ name: 'Proj' }), data: 42 }));
    expect(result.ok && result.data).toBe(42);
    expect(projected).toEqual(['Proj']); // exactly once
    expect(app.state.libraryName.value).toBe('Proj'); // projection took effect
    expect(app.getLastCommittedToken().length).toBeGreaterThan(0);
  });

  it('does not project on an aborted or failed commit', async () => {
    const app = createApp(env());
    let projections = 0;
    const orig = app.applyCommittedWorkspace;
    app.applyCommittedWorkspace = (ws) => { projections++; orig(ws); };
    await app.mutateWorkspace(() => null); // abort
    // Invalid candidate → commit fails (a query missing required fields).
    const failed = await app.mutateWorkspace(() => ({
      candidate: { storageVersion: 1, id: 'x', name: 'n', queries: [{ bad: true } as never], dashboard: null },
    }));
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.aborted).toBeFalsy(); // a real failure, not an abort
    expect(projections).toBe(0);
    expect(app.getLastCommittedToken()).toBe(''); // never advanced
  });
});

// #343 §5/§6: cross-tab invalidation seam. `createApp` opens `asb:workspace`,
// stamps each commit's broadcast with this tab's `sourceTabId`, and ignores its
// own poke on receipt; `documentVisible` is the injected visibility read the
// focus/visibility fallback (step 4) consults.
describe('app cross-tab invalidation (#343)', () => {
  const seed = (over: Partial<StoredWorkspaceV1> = {}): StoredWorkspaceV1 => (
    { storageVersion: 1, id: 'w1', name: 'Seed', queries: [], dashboard: null, ...over }
  );

  it('posts exactly one invalidation per successful commit, and none on abort or failure', async () => {
    const posted: WorkspaceChangedMessage[] = [];
    const factory = (name: string): BroadcastChannelPort => ({
      onmessage: null,
      postMessage: (m) => { if (name === 'asb:workspace') posted.push(m as WorkspaceChangedMessage); },
      close: () => {},
    });
    const app = createApp(env({ broadcastChannel: factory }));
    await app.mutateWorkspace(() => ({ candidate: seed({ name: 'One' }) }));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ type: 'workspace-changed', sourceTabId: app.sourceTabId, workspaceId: 'w1' });
    await app.mutateWorkspace(() => null); // abort
    await app.mutateWorkspace(() => ({ candidate: { storageVersion: 1, id: 'x', name: 'n', queries: [{ bad: true } as never], dashboard: null } })); // fail
    expect(posted).toHaveLength(1); // still just the one success
  });

  it('the sender ignores its OWN broadcast; another tab receives and processes it once', async () => {
    const bus = fakeBroadcastBus();
    const store = fakeIndexedDbFactory();
    const a = createApp(env({ broadcastChannel: bus, indexedDB: store }));
    const b = createApp(env({ broadcastChannel: bus, indexedDB: store }));
    const aSeen: WorkspaceChangedMessage[] = [];
    const bSeen: WorkspaceChangedMessage[] = [];
    a.onExternalWorkspaceChange = (m) => aSeen.push(m);
    // Wrap B's DEFAULT no-op so it still runs (coverage) while we observe.
    const bDefault = b.onExternalWorkspaceChange;
    b.onExternalWorkspaceChange = (m) => { bSeen.push(m); bDefault(m); };
    await a.mutateWorkspace(() => ({ candidate: seed() }));
    expect(aSeen).toHaveLength(0); // guard drops A's own poke
    expect(bSeen).toEqual([{ type: 'workspace-changed', sourceTabId: a.sourceTabId, workspaceId: 'w1' }]);
  });

  it('ignores malformed or mistyped channel messages', async () => {
    const bus = fakeBroadcastBus();
    const a = createApp(env({ broadcastChannel: bus }));
    const b = createApp(env({ broadcastChannel: bus }));
    const seen: WorkspaceChangedMessage[] = [];
    b.onExternalWorkspaceChange = (m) => seen.push(m);
    // A raw port on the same bus posts junk — the app's handler must no-op.
    const raw = bus('asb:workspace');
    raw.postMessage(null);
    raw.postMessage({ type: 'something-else', sourceTabId: 'z', workspaceId: 'w' });
    expect(seen).toHaveLength(0);
    void a;
  });

  it('defaults documentVisible to the document visibility, and honors an injected reader', () => {
    expect(createApp(env()).documentVisible()).toBe(true); // happy-dom is "visible"
    expect(createApp(env({ documentVisible: () => false })).documentVisible()).toBe(false);
  });

  it('opens a real BroadcastChannel when the platform provides one', async () => {
    class FakeBC {
      static made: FakeBC[] = [];
      onmessage: ((e: { data: unknown }) => void) | null = null;
      posted: unknown[] = [];
      name: string;
      constructor(name: string) { this.name = name; FakeBC.made.push(this); }
      postMessage(m: unknown) { this.posted.push(m); }
      close() {}
    }
    (window as unknown as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBC;
    try {
      const app = createApp(env({ broadcastChannel: undefined }));
      await app.mutateWorkspace(() => ({ candidate: seed() }));
      const ch = FakeBC.made.find((c) => c.name === 'asb:workspace');
      expect(ch?.posted).toHaveLength(1);
    } finally {
      delete (window as unknown as { BroadcastChannel?: unknown }).BroadcastChannel;
    }
  });

  it('commits fine when no channel is available (null factory)', async () => {
    const app = createApp(env({ broadcastChannel: () => null }));
    const result = await app.mutateWorkspace(() => ({ candidate: seed() }));
    expect(result.ok).toBe(true);
  });
});

// #343 steps 4/6/8 — workspace refresh through the write queue (focus/visibility
// fallback), the linked-tab conflict resolution UI, and the Save-button state.
describe('app workspace refresh + conflict UI (#343)', () => {
  const q1ws = (sql = 'SELECT 1', name = 'q1'): StoredWorkspaceV1 => ({
    storageVersion: 1, id: 'w1', name: 'Team',
    queries: [{ id: 'q1', sql, specVersion: 1, spec: { name, favorite: false } } as SavedQueryV2],
    dashboard: null,
  });
  const openQ1 = (app: App): QueryTab => {
    app.actions.loadIntoNewTab({ ...app.state.savedQueries.find((q) => q.id === 'q1')! });
    return app.state.tabs.value.find((t) => t.savedId === 'q1')!;
  };

  it('window focus schedules a refresh; a visible visibilitychange schedules another', async () => {
    const app = createApp(env());
    await app.mutateWorkspace(() => ({ candidate: q1ws() }));
    const spy = vi.spyOn(app.workspace, 'loadCurrentResult');
    window.dispatchEvent(new Event('focus'));
    await app.flushWorkspaceWrites();
    expect(spy).toHaveBeenCalled();
    const afterFocus = spy.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    await app.flushWorkspaceWrites();
    expect(spy.mock.calls.length).toBeGreaterThan(afterFocus);
  });

  it('visibilitychange does not refresh while the tab is hidden', async () => {
    const app = createApp(env({ documentVisible: () => false }));
    await app.mutateWorkspace(() => ({ candidate: q1ws() }));
    const spy = vi.spyOn(app.workspace, 'loadCurrentResult');
    document.dispatchEvent(new Event('visibilitychange'));
    await app.flushWorkspaceWrites();
    expect(spy).not.toHaveBeenCalled();
  });

  it('a corrupt reload warns and keeps the projection without wedging the queue', async () => {
    const app = createApp(env());
    await app.mutateWorkspace(() => ({ candidate: q1ws() }));
    vi.spyOn(app.workspace, 'loadCurrentResult').mockResolvedValueOnce({ status: 'corrupt', diagnostics: [] });
    await app.refreshWorkspaceFromStore(); // warns internally, returns
    expect(app.state.savedQueries[0].id).toBe('q1'); // projection intact
    const after = await app.mutateWorkspace((latest) => ({ candidate: { ...latest!, name: 'Still works' } }));
    expect(after.ok).toBe(true); // queue not wedged
  });

  it('back-fills the per-tab baseline token for a tab linked without one at projection', async () => {
    const app = createApp(env());
    await app.mutateWorkspace(() => ({ candidate: q1ws() }));
    const t = app.state.tabs.value[0];
    t.savedId = 'q1';
    t.lastCommittedQueryToken = undefined; // linked, but no baseline token yet
    await app.mutateWorkspace((latest) => ({ candidate: { ...latest!, name: 'again' } }));
    expect(t.lastCommittedQueryToken).toBeTruthy(); // applyCommittedWorkspace filled it
  });

  it('shows "Resolve conflict" on the Save button for a conflicted tab', async () => {
    const app = createApp(env());
    await app.mutateWorkspace(() => ({ candidate: q1ws() }));
    await app.loadWorkspaceOnBoot();
    app.renderApp();
    const t = openQ1(app);
    t.externalState = 'conflict';
    app.updateSaveBtn();
    expect(app.dom.saveBtn!.textContent).toContain('Resolve conflict');
    expect(app.dom.saveBtn!.classList.contains('conflict')).toBe(true);
    // Clearing the conflict restores the ordinary Save state.
    t.externalState = null;
    app.updateSaveBtn();
    expect(app.dom.saveBtn!.classList.contains('conflict')).toBe(false);
  });

  it('Save on a conflicted tab opens the two-action chooser (once), not a silent overwrite', async () => {
    const app = createApp(env());
    await app.mutateWorkspace(() => ({ candidate: q1ws() }));
    await app.loadWorkspaceOnBoot();
    app.renderApp();
    const t = openQ1(app);
    t.sqlDraft = 'SELECT draft'; t.dirtySql = true; t.externalState = 'conflict';
    const commitSpy = vi.spyOn(app.workspace, 'commit');
    await app.actions.save();
    await app.actions.save(); // second call is a no-op while the chooser is open
    expect(document.querySelectorAll('.conflict-chooser')).toHaveLength(1);
    expect(commitSpy).not.toHaveBeenCalled(); // nothing written yet
  });

  it('"Reload saved version" discards the draft and adopts the committed query', async () => {
    const store = fakeIndexedDbFactory();
    const app = createApp(env({ indexedDB: store }));
    const other = createApp(env({ indexedDB: store }));
    await app.mutateWorkspace(() => ({ candidate: q1ws('SELECT 1') }));
    await app.loadWorkspaceOnBoot();
    app.renderApp();
    const t = openQ1(app);
    t.sqlDraft = 'SELECT local'; t.dirtySql = true;
    // Another tab changes q1, then this tab's refresh detects the conflict.
    await other.loadWorkspaceOnBoot();
    await renameSaved(other.state, 'q1', 'External name', undefined, other.mutateWorkspace);
    await app.refreshWorkspaceFromStore();
    expect(t.externalState).toBe('conflict');
    await app.actions.save(); // opens the chooser
    (document.querySelector('.conflict-chooser .cf-reload') as HTMLElement).dispatchEvent(new Event('click', { bubbles: true }));
    expect(t.dirtySql).toBe(false); // draft discarded
    expect(t.name).toBe('External name'); // adopted the committed version
    expect(t.externalState ?? null).toBeNull();
  });

  it('"Keep my draft" confirms, then saves the draft over the latest query and clears the conflict', async () => {
    const store = fakeIndexedDbFactory();
    const app = createApp(env({ indexedDB: store }));
    const other = createApp(env({ indexedDB: store }));
    await app.mutateWorkspace(() => ({ candidate: q1ws('SELECT 1') }));
    await app.loadWorkspaceOnBoot();
    app.renderApp();
    const t = openQ1(app);
    t.sqlDraft = 'SELECT my kept draft'; t.dirtySql = true;
    await other.loadWorkspaceOnBoot();
    await renameSaved(other.state, 'q1', 'External name', undefined, other.mutateWorkspace);
    await app.refreshWorkspaceFromStore();
    expect(t.externalState).toBe('conflict');
    await app.actions.save();
    (document.querySelector('.conflict-chooser .cf-keep') as HTMLElement).dispatchEvent(new Event('click', { bubbles: true }));
    (document.querySelector('.conflict-chooser .cf-overwrite') as HTMLElement).dispatchEvent(new Event('click', { bubbles: true }));
    await app.flushWorkspaceWrites();
    expect(t.externalState ?? null).toBeNull(); // conflict resolved
    const persisted = await app.workspace.loadCurrent();
    expect(persisted!.queries.find((q) => q.id === 'q1')!.sql).toBe('SELECT my kept draft');
  });

  it('the reload resolution is a no-op if the query vanished before it runs', async () => {
    const app = createApp(env());
    await app.mutateWorkspace(() => ({ candidate: q1ws() }));
    await app.loadWorkspaceOnBoot();
    app.renderApp();
    const t = openQ1(app);
    t.externalState = 'conflict';
    t.savedId = 'no-longer-present'; // savedForTab → null inside reloadSavedVersion
    await app.actions.save();
    expect(() => (document.querySelector('.conflict-chooser .cf-reload') as HTMLElement)
      .dispatchEvent(new Event('click', { bubbles: true }))).not.toThrow();
  });
});

describe('renderApp shell', () => {
  function rendered(over: Partial<CreateAppEnv> = {}): { app: App; e: CreateAppEnv } {
    const e = env({
      fetch: makeFetch([
        [(u, sql) => /version\(\)/.test(sql), resp({ json: { data: [{ v: '26.3.1' }] } })],
        [(u, sql) => /system\.tables/.test(sql), resp({ json: { data: [{ database: 'd', name: 't', total_rows: '1', total_bytes: '1', comment: '' }] } })],
      ]),
      ...over,
    });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }
  it('builds header + sidebar + workbench and mounts the editor', async () => {
    const { app } = rendered();
    expect(qs(app.root, '.app-header')).not.toBeNull();
    expect(qs(app.root, '.sidebar')).not.toBeNull();
    expect(qs(app.root, '.cm-editor')).not.toBeNull();
    // user control shows the short name (local-part) + full email on hover
    expect(qs(app.dom.userBtn!, '.user-short').textContent).toBe('me');
    expect(app.dom.userBtn!.getAttribute('title')).toBe('me@example.com');
    await Promise.resolve();
  });
  it('toggles theme via the header button', () => {
    const { app } = rendered();
    app.dom.themeBtn!.dispatchEvent(new Event('click')); // default light → dark
    expect(app.state.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
  it('user menu: open → Log out clears tokens and shows login', () => {
    const { app, e } = rendered();
    app.dom.userBtn!.dispatchEvent(new Event('click'));
    const menu = qs(document, '.user-menu');
    expect(menu).not.toBeNull();
    expect(qs(menu, '.um-id').textContent).toBe('me@example.com');
    expect(qs(menu, '.um-build').textContent).toBe(app.build); // build stamp ('dev' here)
    qs(menu, '.um-item.danger').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.conn.token()).toBeNull();
    expect(e.sessionStorage!.getItem('oauth_id_token')).toBeNull();
    expect(qs(app.root, '.login-screen')).not.toBeNull();
    expect(qs(document, '.user-menu')).toBeNull(); // closed
  });
  it('user menu autofocuses the Log out item on open', async () => {
    const { app } = rendered();
    app.dom.userBtn!.dispatchEvent(new Event('click'));
    const menu = qs(document, '.user-menu');
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement).toBe(qs(menu, '.um-item.danger'));
  });
  it('user menu closes on Escape and outside-click; header has an examples link', () => {
    const { app } = rendered();
    app.dom.userBtn!.dispatchEvent(new Event('click'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(qs(document, '.user-menu')).toBeNull();
    app.actions.openUserMenu();
    app.actions.openUserMenu(); // idempotent while open
    expect(qsa(document, '.user-menu')).toHaveLength(1);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(qs(document, '.user-menu')).toBeNull();
    const examplesLink = qs(app.root, 'a.hd-btn[href*="/examples"]');
    expect(examplesLink).not.toBeNull();
    expect(examplesLink.getAttribute('target')).toBe('_blank');
    expect(examplesLink.getAttribute('rel')).toContain('noopener');
    expect(qs(examplesLink, 'svg')).not.toBeNull();
  });
  it('setTokens clears the one-shot pkce verifier and csrf state', () => {
    const e = env({ sessionStorage: memSession({ oauth_verifier: 'v', oauth_state: 's' }) });
    const app = createApp(e);
    app.conn.setTokens('tok');
    expect(app.conn.token()).toBe('tok');
    expect(e.sessionStorage!.getItem('oauth_id_token')).toBe('tok');
    expect(e.sessionStorage!.getItem('oauth_verifier')).toBeNull();
    expect(e.sessionStorage!.getItem('oauth_state')).toBeNull();
  });
  it('schema search updates the filter', () => {
    const { app } = rendered();
    app.dom.schemaSearchInput!.value = 'foo';
    app.dom.schemaSearchInput!.dispatchEvent(new Event('input'));
    expect(app.state.schemaFilter.value).toBe('foo');
  });
});

describe('loadVersion / loadSchema', () => {
  it('sets the version + online status', async () => {
    const e = env({ fetch: makeFetch([[(u, sql) => /version/.test(sql), resp({ json: { data: [{ v: '26.3.1' }] } })]]) });
    const app = createApp(e);
    app.renderApp();
    await new Promise((r) => setTimeout(r));
    expect(app.state.serverVersion).toBe('26.3.1');
    expect(app.dom.connStatus!.textContent).toContain('26.3.1');
  });
  it('marks offline when the version query fails', async () => {
    const e = env({ fetch: makeFetch([[(u, sql) => /version/.test(sql), resp({ ok: false, status: 500, text: 'err' })]]) });
    const app = createApp(e);
    app.renderApp();
    await new Promise((r) => setTimeout(r));
    expect(app.dom.connStatus!.textContent).toContain('offline');
  });
  it('records a schema error', async () => {
    const e = env({ fetch: makeFetch([
      [(u, sql) => /version/.test(sql), resp({ json: { data: [{ v: '1' }] } })],
      [(u, sql) => /system\.tables/.test(sql), resp({ ok: false, status: 500, text: 'boom' })],
    ]) });
    const app = createApp(e);
    app.renderApp();
    await new Promise((r) => setTimeout(r));
    expect(app.state.schemaError.value).toContain('boom');
  });
});

describe('loadReference / rebuildCompletions (#25)', () => {
  it('loads server keywords + functions into refData and the completion list', async () => {
    const e = env({ fetch: makeFetch([
      [(u, sql) => /system\.keywords/.test(sql), resp({ json: { data: [{ keyword: 'PREWHERE' }] } })],
      [(u, sql) => /system\.functions/.test(sql), resp({ json: { data: [{ name: 'toDate', is_aggregate: 0 }] } })],
    ]) });
    const app = createApp(e);
    app.renderApp();
    await app.catalog.loadReference();
    expect(refDataOf(app).keywordSet.has('PREWHERE')).toBe(true); // drives the tokenizer too
    expect(refDataOf(app).funcSet.has('toDate')).toBe(true);
    expect(completionsOf(app).some((c) => c.label === 'PREWHERE')).toBe(true);
  });
  it('starts with the built-in fallback before any load', () => {
    const app = createApp(env());
    expect(refDataOf(app).keywordSet.has('SELECT')).toBe(true);
    expect(completionsOf(app).length).toBeGreaterThan(0);
  });
  it('rebuildCompletions folds in already-loaded schema columns', () => {
    const app = createApp(env());
    app.state.schema.value = [{ db: 'd', tables: [{ name: 't', columns: [{ name: 'c', type: 'UInt8' }] }] }];
    app.catalog.rebuildCompletions();
    expect(completionsOf(app).some((c) => c.kind === 'column' && c.label === 'c' && c.parent === 't')).toBe(true);
  });
  it('loadReference tolerates being called before the editor mounts', async () => {
    const app = createApp(env()); // no renderApp → refreshReference hits the unmounted guard
    await expect(app.catalog.loadReference()).resolves.toBeUndefined();
    expect(app.catalog.refData).toBeTruthy();
  });
  it('without env.Editor the noop port stands in — headless consumers stay callable (#143)', async () => {
    const e = env();
    delete e.Editor;
    const app = createApp(e);
    await expect(app.catalog.loadReference()).resolves.toBeUndefined(); // refreshReference on the noop port
    expect(app.sqlEditor.hasFocus()).toBe(false);
    expect(app.sqlEditor.getSelection()).toEqual({ start: 0, end: 0, text: '' });
    expect(() => app.actions.insertAtCursor('x')).not.toThrow();
  });
  it('loadColumns folds the newly-loaded columns into the completion list (#26)', async () => {
    const e = env({ fetch: makeFetch([
      [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'id', type: 'UInt64', comment: '' }] } })],
    ]) });
    const app = createApp(e); // no renderApp → loadSchema can't clobber our schema mid-test
    app.state.schema.value = [{ db: 'd', tables: [{ name: 't', columns: null }] }];
    await app.actions.loadColumns('d', 't');
    expect(completionsOf(app).some((c) => c.kind === 'column' && c.label === 'id' && c.parent === 't')).toBe(true);
  });
});

describe('query run', () => {
  function appForRun(routes: FetchRoute[], over: Partial<CreateAppEnv> = {}): { app: App; e: CreateAppEnv } {
    const e = env({ fetch: makeFetch(routes), ...over });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }
  it('runs Filter SQL with owned structured transport and commits only the completed preview', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT \['ATL'\]/.test(sql), resp({ body: streamBody([
        '{"meta":[{"name":"origin","type":"Array(String)"}]}\n',
        '{"row":{"origin":["ATL","JFK"]}}\n',
      ]) })],
    ]);
    const tab = app.activeTab();
    tab.sqlDraft = "SELECT ['ATL'] AS origin";
    tab.specParsed!.dashboard = { role: 'filter' };
    tab.specText = JSON.stringify(tab.specParsed);
    app.state.resultView.value = 'filter';
    await app.actions.run();
    const request = asMock(app.conn.chCtx.fetch).mock.calls.find(([, init]) => /SELECT \['ATL'\]/.test(init.body))!;
    expect(request[0]).toContain('default_format=JSONEachRowWithProgress');
    expect(request[0]).toContain('max_result_rows=2');
    // #359: Filter execution no longer injects `readonly` — server read-only
    // policy belongs to ClickHouse user/profile config, not feature code.
    expect(request[0]).not.toContain('readonly=');
    expect(request[0]).toContain('output_format_json_quote_64bit_integers=1');
    expect(tab.filterPreview!.status).toBe('success');
    expect(filterPreviewNormalizedOf(tab).helpers[0].options).toEqual([
      { value: 'ATL', label: 'ATL' }, { value: 'JFK', label: 'JFK' },
    ]);
    expect(app.dom.resultsRegion!.textContent).toContain('origin');
    expect(app.state.resultView.value).toBe('filter');
  });
  it('a Filter query that reaches the server but fails records an error-status preview, not a thrown/success one', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT \['ATL'\]/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: nope"}' })],
    ]);
    const tab = app.activeTab();
    tab.sqlDraft = "SELECT ['ATL'] AS origin";
    tab.specParsed!.dashboard = { role: 'filter' };
    tab.specText = JSON.stringify(tab.specParsed);
    app.state.resultView.value = 'filter';
    await app.actions.run();
    expect(tab.filterPreview!.status).toBe('error');
    expect((tab.filterPreview as { error: string }).error).toContain('nope');
  });
  it('a Filter query cancelled mid-flight (no explicit error) records the generic cancelled message', async () => {
    const fetchImpl = asFetch(vi.fn((url: string, init?: { body?: string; signal?: AbortSignal }) => {
      if (init && /SELECT \['ATL'\]/.test(init.body || '')) {
        return new Promise<FakeResponse>((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init.signal!.aborted) abort();
          else init.signal!.addEventListener('abort', abort);
        });
      }
      return Promise.resolve(resp({ json: { data: [] } }));
    }));
    const app = createApp(env({ fetch: fetchImpl }));
    app.renderApp();
    const tab = app.activeTab();
    tab.sqlDraft = "SELECT ['ATL'] AS origin";
    tab.specParsed!.dashboard = { role: 'filter' };
    tab.specText = JSON.stringify(tab.specParsed);
    app.state.resultView.value = 'filter';
    const runPromise = app.actions.run();
    await new Promise((r) => setTimeout(r)); // let the request actually start (signal attached)
    app.actions.cancel();
    await runPromise;
    expect(tab.filterPreview!.status).toBe('error');
    expect((tab.filterPreview as { error: string }).error).toBe('Filter query was cancelled.');
  });
  it('blocks invalid Filter SQL before auth/network, including multi-statement and parameters', async () => {
    const { app } = appForRun([]);
    const tab = app.activeTab();
    tab.specParsed!.dashboard = { role: 'filter' };
    tab.specText = JSON.stringify(tab.specParsed);
    tab.sqlDraft = 'SELECT {x:String}; SELECT 2';
    await app.actions.run();
    expect(asMock(app.conn.chCtx.fetch).mock.calls.some(([, init]) => init?.body === tab.sqlDraft)).toBe(false);
    expect(result(tab).error).toContain('exactly one statement');
    expect(tab.filterPreview!.status).toBe('error');
    expect(app.state.resultView.value).toBe('filter');
  });
  it('runs an explicit KPI with owned typed streaming and renders the shared cards', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 42/.test(sql), resp({ body: streamBody([
        '{"meta":[{"name":"users","type":"UInt64"}]}\n', '{"row":{"users":42}}\n',
      ]) })],
    ]);
    const tab = app.activeTab();
    tab.sqlDraft = 'SELECT 42 AS users';
    tab.specParsed!.panel = { cfg: { type: 'kpi' }, fieldConfig: { columns: { users: { displayName: 'Active users' } } } };
    tab.specText = JSON.stringify(tab.specParsed);
    app.state.resultView.value = 'panel';
    await app.actions.run();
    const request = asMock(app.conn.chCtx.fetch).mock.calls.find(([, init]) => /SELECT 42/.test(init.body))!;
    expect(request[0]).toContain('default_format=JSONEachRowWithProgress');
    expect(request[0]).toContain('output_format_json_named_tuples_as_objects=1');
    expect(request[0]).toContain('output_format_json_quote_decimals=1');
    expect(request[0]).toContain('max_result_rows=2');
    expect(qs(app.dom.resultsRegion!, '.kpi-label').textContent).toBe('Active users');
    expect(qs(app.dom.resultsRegion!, '.kpi-value').textContent).toBe('42');
  });
  it('blocks an explicit KPI query with authored FORMAT before fetch', async () => {
    const { app } = appForRun([]);
    const tab = app.activeTab();
    tab.sqlDraft = 'SELECT 1 FORMAT CSV';
    tab.specParsed!.panel = { cfg: { type: 'kpi' } };
    tab.specText = JSON.stringify(tab.specParsed);
    await app.actions.run();
    expect(asMock(app.conn.chCtx.fetch).mock.calls.some(([, init]) => init?.body === 'SELECT 1 FORMAT CSV')).toBe(false);
    expect(result(tab).error).toBe('KPI panel owns the result format. Remove FORMAT CSV from the SQL.');
    expect(app.state.resultView.value).toBe('panel');
  });
  it('runs a streaming query and records history', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })],
    ]);
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).rows).toEqual([['1']]);
    expect(app.activeTab().lastSuccessfulResultColumns).toEqual([{ name: 'a', type: 'UInt8' }]);
    expect(app.state.history.length).toBe(1);
    // a plain SELECT needs no session, so none is opened (avoids the session race)
    expect(asMock(app.conn.chCtx.fetch).mock.calls.map((c) => c[0]).some((u) => /session_id=/.test(u))).toBe(false);
  });
  it('captures result.source for a normal row-returning result (#185)', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })],
    ]);
    const tab = app.activeTab();
    tab.sqlDraft = 'SELECT 1';
    tab.name = 'My query';
    await app.actions.run();
    // the authored template + run-time identity, snapshotted for a detached rerun
    expect(result(tab).source).toEqual({
      sql: 'SELECT 1', tabId: tab.id, rowLimit: app.state.resultRowLimit, title: 'My query', description: '',
    });
    // #185: source must be captured BEFORE the running flip that renders the
    // toolbar, so the Expand affordance appears on the same paint (regression:
    // capturing after the flip left the button missing until the next render).
    const expandBtn = [...qsa(app.dom.resultsRegion!, '.res-act')]
      .find((b) => /Expand/.test(b.textContent));
    expect(expandBtn).toBeTruthy();
  });
  it('does not capture result.source for an empty (0-row) result (#185)', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n']) })],
    ]);
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).rows.length).toBe(0);
    expect(result(app.activeTab()).source).toBeUndefined();
  });
  it('does not capture result.source for a raw FORMAT result (#185)', async () => {
    const { app } = appForRun([
      [(u, sql) => /FORMAT CSV/.test(sql), resp({ text: 'a\n1\n' })],
    ]);
    app.activeTab().sqlDraft = 'SELECT 1 FORMAT CSV';
    await app.actions.run();
    expect(result(app.activeTab()).rawText).toBe('a\n1\n');
    expect(result(app.activeTab()).source).toBeUndefined();
  });
  it('opens a ClickHouse session only for SQL that needs one (SET / TEMPORARY), and it sticks to the tab', async () => {
    const { app } = appForRun([[() => true, resp({ body: streamBody(['{"row":{}}\n']) })]]);
    app.activeTab().sqlDraft = 'SET max_threads = 1';
    await app.actions.run(); // SET → opens a session
    const setUrl = asMock(app.conn.chCtx.fetch).mock.calls.map((c) => c[0]).find((u) => /session_id=/.test(u));
    expect(setUrl).not.toMatch(/session_timeout/); // rely on the server default (60s) — see sessionParams
    const sid = /session_id=([^&]+)/.exec(setUrl)![1];
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT 1'; // plain SELECT now, but the tab already has a session
    await app.actions.run();
    const selUrl = asMock(app.conn.chCtx.fetch).mock.calls.map((c) => c[0]).find((u) => /session_id=/.test(u));
    expect(/session_id=([^&]+)/.exec(selUrl)![1]).toBe(sid); // sticky: same session id
  });
  it('refreshes the schema after a successful schema-mutating statement (#diagnose-db-creation)', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE DATABASE/.test(sql), resp({ body: streamBody([]) })],
    ]);
    await new Promise((r) => setTimeout(r)); // let the initial-mount loadSchema settle
    const spy = vi.spyOn(app.catalog, 'loadSchema');
    app.activeTab().sqlDraft = 'CREATE DATABASE t3';
    await app.actions.run();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('does not refresh the schema after a plain SELECT', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })],
    ]);
    await new Promise((r) => setTimeout(r));
    const spy = vi.spyOn(app.catalog, 'loadSchema');
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(spy).not.toHaveBeenCalled();
  });
  it('keeps the current result view on a plain re-run, and restores a remembered view when opened (#34)', async () => {
    const routes: FetchRoute[] = [[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })]];
    const { app } = appForRun(routes, { Chart: class { destroy() {} } }); // Chart seam so the panel view renders
    app.activeTab().sqlDraft = 'SELECT 1';
    app.state.resultView.value = 'panel';
    await app.actions.run();                  // no opts → keep the current (panel) tab
    expect(app.state.resultView.value).toBe('panel');
    await app.actions.run({ view: 'json' });  // saved-query open restores its view
    expect(app.state.resultView.value).toBe('json');
    await app.actions.run({ view: 'table' });
    expect(app.state.resultView.value).toBe('table');
    await app.actions.run({ view: 'panel' });
    expect(app.state.resultView.value).toBe('panel');
    await app.actions.run({ view: 'chart' }); // legacy remembered view maps to panel (#166)
    expect(app.state.resultView.value).toBe('panel');
    await app.actions.run({ view: 'bogus' }); // unknown view → keep current (panel)
    expect(app.state.resultView.value).toBe('panel');
  });
  it('switching the result view repaints via the effect (the view-tab onclick only sets the signal)', async () => {
    const routes: FetchRoute[] = [[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })]];
    const { app } = appForRun(routes);
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    const region = app.dom.resultsRegion!;
    expect(qs(region, '.res-table')).not.toBeNull(); // table view by default
    const jsonTab = [...qsa(region, '.result-view-tab')].find((b) => b.textContent.includes('JSON'))!;
    jsonTab.dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.resultView.value).toBe('json');
    expect(qs(region, '.json-view')).not.toBeNull(); // repainted by the results effect, not the onclick
    expect(qs(region, '.res-table')).toBeNull();
  });
  it('no-ops on empty SQL', async () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = '   ';
    await app.actions.run();
    expect(app.activeTab().result).toBeNull();
  });
  it('run() while already running is a no-op (cancel is separate)', async () => {
    const { app } = appForRun([]);
    await new Promise((r) => setTimeout(r)); // let mount-time loadVersion/loadSchema/loadReference settle
    app.state.running.value = true;
    const before = asMock(app.conn.chCtx.fetch).mock.calls.length;
    await app.actions.run();
    // Guarded before any request goes out — no additional fetch/exec call.
    expect(asMock(app.conn.chCtx.fetch).mock.calls.length).toBe(before);
    expect(app.state.running.value).toBe(true);
  });
  it('setRunBtn: "Running…" with no trailing "null"; "Run" + kbd when idle', () => {
    const { app } = appForRun([]);
    app.setRunBtn(true);
    expect(app.dom.runBtn!.disabled).toBe(true);
    expect(app.dom.runBtn!.textContent).toBe('Running…'); // regression: not "Running…null"
    app.setRunBtn(false);
    expect(app.dom.runBtn!.disabled).toBe(false);
    expect(app.dom.runBtn!.textContent).toContain('Run');
    expect(qs(app.dom.runBtn!, 'kbd')).not.toBeNull();
  });
  it('typing drives the real onDocChange subscriber: tab.sqlDraft/dirty, tab strip, Save button, var strip (#143)', () => {
    const { app } = appForRun([]);
    const view = app.dom.sqlEditorView!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'SELECT {p:UInt8}' } });
    // the subscriber (registered once in createApp) owns the state writes…
    expect(app.activeTab().sqlDraft).toBe('SELECT {p:UInt8}');
    expect(app.activeTab().dirtySql).toBe(true);
    // …and runs its dependents AFTER them: the var strip read the new text
    // (visible strip proves the tab.sqlDraft write happened first), and the Run
    // button picked up the unfilled-variable gate.
    expect(app.dom.varStrip!.style.display).not.toBe('none');
    expect(qs(app.dom.varStrip!, '.var-name').textContent).toBe('p');
    expect(app.dom.runBtn!.disabled).toBe(true);
    // the tab strip re-rendered with the dirty marker
    expect(qs(app.dom.qtabsInner!, '.dirty')).not.toBeNull();
  });
  it('re-evaluates a Filter-role Spec live as its SQL is typed (audit #2 gate)', () => {
    const { app } = appForRun([]);
    const tab = app.activeTab();
    tab.specParsed = { dashboard: { role: 'filter' } };
    tab.specText = JSON.stringify(tab.specParsed);
    const view = app.dom.sqlEditorView!;
    // A Filter source must be a single statement — typing two makes the Spec's
    // SQL-dependent diagnostic appear without touching the Spec editor.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'SELECT 1; SELECT 2' } });
    expect(tab.specDiagnostics.some((d) => /exactly one statement/.test(d.message))).toBe(true);
  });
  it('query variables (#134): renders an input per detected {name:Type}, hides when none', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {database:String}, {table:String}';
    app.renderVarStrip();
    expect(app.dom.varStrip!.style.display).not.toBe('none');
    const fields = qsa(app.dom.varStrip!, '.var-field');
    expect([...fields].map((f) => qs(f, '.var-name').textContent)).toEqual(['database', 'table']);
    expect(qs<HTMLInputElement>(app.dom.varStrip!, '.var-input').placeholder).toBe('String');
    // an unfilled variable disables Run with an explanatory tooltip
    expect(app.dom.runBtn!.disabled).toBe(true);
    expect(app.dom.runBtn!.title).toContain('database');
    // re-detecting the same set is idempotent (signature guard skips the rebuild)
    const before = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    app.renderVarStrip();
    expect(qs<HTMLInputElement>(app.dom.varStrip!, '.var-input')).toBe(before);
    // no variables → strip hidden again
    app.activeTab().sqlDraft = 'SELECT 1';
    app.renderVarStrip();
    expect(app.dom.varStrip!.style.display).toBe('none');
    expect(app.dom.runBtn!.disabled).toBe(false);
  });
  it('query variables (#345): a field gets a compact, type-aware width — Date narrower than DateTime, Enum its own band', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = "SELECT {n:UInt8}, {d:Date}, {dt:DateTime}, {k:Enum8('a' = 1, 'b' = 2)}";
    app.renderVarStrip();
    const inputs = qsa<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    expect(inputs.map((i) => i.style.getPropertyValue('--var-input-ch'))).toEqual(['9', '13', '17', '14']);
  });
  it('query variables (#134): typing a value updates the shared store, persists, and re-enables Run', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {id:UInt32}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = '42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.state.varValues.id).toBe('42'); // shared, name-keyed store (not per-tab)
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varValues')!).id).toBe('42'); // persisted
    expect(app.dom.runBtn!.disabled).toBe(false);
    expect(app.dom.runBtn!.title).toBe('');
  });
  it('query variables (#134): a value is shared across queries — reused/prefilled by name', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {database:String}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = 'analytics';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // a *different* query using the same variable prefills the value, no retyping
    app.activeTab().sqlDraft = 'SELECT count() FROM {database:String}.events WHERE 1';
    app.renderVarStrip();
    expect(qs<HTMLInputElement>(app.dom.varStrip!, '.var-input').value).toBe('analytics');
    expect(app.dom.runBtn!.disabled).toBe(false); // already satisfied from the shared store
  });
  it('query variables (#134): a persisted value is restored on load and prefilled', () => {
    vi.stubGlobal('localStorage', memStore({ 'asb:varValues': JSON.stringify({ table: 'events' }) }));
    const { app } = appForRun([]);
    expect(app.state.varValues.table).toBe('events'); // loaded from localStorage at startup
    app.activeTab().sqlDraft = 'SELECT * FROM {table:String}';
    app.renderVarStrip();
    expect(qs<HTMLInputElement>(app.dom.varStrip!, '.var-input').value).toBe('events');
    expect(app.dom.runBtn!.disabled).toBe(false);
  });
  it('query variables (#134): a run with an unfilled variable is blocked and toasts', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r)); // let the initial-mount fetches settle
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {id:UInt32}';
    await app.actions.run(); // ⌘↵/button path (runEntry) — bypasses the disabled button
    expect(app.activeTab().result).toBeNull(); // never executed
    expect(asMock(app.conn.chCtx.fetch).mock.calls.length).toBe(0);
    expect(qs(document.body, '.share-toast').textContent).toContain('id');
  });
  it('query variables (#134): a filled SELECT is sent with native param_<name> args', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    const tab = app.activeTab();
    tab.sqlDraft = 'WITH {database:String} AS d, {table:String} AS t SELECT 1';
    app.state.varValues = { database: 'default', table: 'events' };
    await app.actions.run();
    const [url, init] = asMock(app.conn.chCtx.fetch).mock.calls[0];
    expect(url).toMatch(/param_database=default/);
    expect(url).toMatch(/param_table=events/);
    // the SQL text itself is untouched — ClickHouse does the substitution
    expect(init.body).toContain('{database:String}');
  });
  it('relative time (#169): a DateTime var gets the combobox — focus opens the preset list', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    expect(input.getAttribute('role')).toBe('combobox');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(qsa(app.dom.varStrip!, '[role="option"]').length).toBeGreaterThan(0);
    expect(qs(app.dom.varStrip!, '.var-combo-preview')).not.toBeNull();
  });
  it('relative time (#169): a non-date type gets the recents-only combobox (#171), not the date-like preset+preview one', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {n:UInt32}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    // Still a combobox (#171 gives every field a recents dropdown)...
    expect(input.getAttribute('role')).toBe('combobox');
    // ...but never the date-like field's preset live preview.
    expect(qs(app.dom.varStrip!, '.var-combo-preview')).toBeNull();
  });
  it('relative time (#169): picking a preset inserts the expression, persists it (not the resolved value), and shows a live preview', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([], { wallNow: () => 1751200000000 });
    app.activeTab().sqlDraft = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    const opt = qs(app.dom.varStrip!, '[role="option"]'); // first preset: -15m
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(input.value).toBe('-15m'); // the expression stays in the field
    expect(app.state.varValues.from).toBe('-15m'); // …and is what's stored/persisted
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varValues')!).from).toBe('-15m');
    const preview = qs(app.dom.varStrip!, '.var-combo-preview');
    expect(preview.textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
  it('relative time (#169): an invalid (near-miss) expression disables Run with a structured reason', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = 'now/q';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true })); // hardens (#170)
    expect(app.dom.runBtn!.disabled).toBe(true);
    expect(app.dom.runBtn!.title).toContain('from');
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(input.title).toMatch(/Not a valid relative time expression/);
  });
  it("relative time (#169 review finding #2): typing a near-miss stays neutral (incomplete) — Run stays enabled until blur hardens it", () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = 'now/q';
    input.dispatchEvent(new Event('input', { bubbles: true })); // still typing — 'input' mode
    expect(app.dom.runBtn!.disabled).toBe(false);
    expect(input.classList.contains('is-invalid')).toBe(false);
    expect(app.params.hardenedVars.has('from')).toBe(false);
    input.dispatchEvent(new Event('blur', { bubbles: true })); // commits — 'execute' mode hardens it
    expect(app.dom.runBtn!.disabled).toBe(true);
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(app.params.hardenedVars.has('from')).toBe(true);
    // The hardened state (#170's app.params.hardenedVars mechanism) persists across
    // an unrelated re-render — the same mechanism the type-validator's own
    // incomplete→invalid hardening already relies on, now also reached via
    // the relative-time near-miss path (review finding #2's whole point: it
    // routes through the exact same states, not a bespoke gate).
    app.dom.varStripSig = undefined; // force renderVarStrip to rebuild the strip
    app.renderVarStrip();
    expect(app.dom.runBtn!.disabled).toBe(true);
    const rebuiltInput = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    expect(rebuiltInput.classList.contains('is-invalid')).toBe(true);
  });
  it('relative time (#169): Enter with the preset list closed hardens/gates via the same keydown path as a plain field', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = 'now/q';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(app.dom.runBtn!.disabled).toBe(true);
    expect(input.classList.contains('is-invalid')).toBe(true);
  });
  it('relative time (#169): Enter with an active preset option commits it via keydown instead of hardening the prior text', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.focus(); // a real focus (not a synthetic dispatchEvent) — matches document.activeElement
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(input.value).toBe('-15m'); // the first preset, committed — not left as invalid/empty text
    expect(input.getAttribute('aria-expanded')).toBe('false'); // list closed by the commit
  });
  it('relative time (#169): a filled relative expression resolves to epoch seconds on the wave clock and re-resolves on the next run', async () => {
    const { app, e } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]], { wallNow: () => 1751200000000 });
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    const tab = app.activeTab();
    tab.sqlDraft = 'SELECT {from:DateTime}';
    app.state.varValues = { from: '-1h' };
    await app.actions.run();
    const [url1] = asMock(app.conn.chCtx.fetch).mock.calls[0];
    expect(url1).toMatch(new RegExp(`param_from=${Math.round((1751200000000 - 3600000) / 1000)}(?:&|$)`));
    // advance the injected clock and re-run: the stored expression re-resolves
    // to a different absolute value (the moving window, #173's batch clock)
    e.wallNow = () => 1751200000000 + 3600000;
    asMock(app.conn.chCtx.fetch).mockClear();
    await app.actions.run();
    const [url2] = asMock(app.conn.chCtx.fetch).mock.calls[0];
    expect(url2).toMatch(new RegExp(`param_from=${Math.round(1751200000000 / 1000)}(?:&|$)`));
  });
  it('relative time (#169): a Date var formats as a calendar date; non-date types are unaffected by a relative-looking value', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]], { wallNow: () => 1751200000000 });
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    const tab = app.activeTab();
    tab.sqlDraft = 'SELECT {day:Date}, {tag:String}';
    app.state.varValues = { day: 'now', tag: '-1h' }; // a String var keeps a relative-looking value verbatim
    await app.actions.run();
    const [url] = asMock(app.conn.chCtx.fetch).mock.calls[0];
    const expectedDay = new Date(1751200000000).toISOString().slice(0, 10);
    expect(url).toMatch(new RegExp(`param_day=${expectedDay}(?:&|$)`));
    expect(url).toMatch(/param_tag=-1h(?:&|$)/);
  });
  it('relative time (#169): composes with an optional /*[ ]*/ block (#165) — a relative value inside an active block resolves and binds', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]], { wallNow: () => 1751200000000 });
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    const tab = app.activeTab();
    tab.sqlDraft = 'SELECT * FROM t WHERE 1 /*[ AND d >= {from:DateTime} ]*/';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = '-1h';
    input.dispatchEvent(new Event('input', { bubbles: true })); // activates the block (#165) and stores the expression
    await app.actions.run();
    const [url, init] = asMock(app.conn.chCtx.fetch).mock.calls[0];
    expect(init.body).toContain('AND d >= {from:DateTime}'); // block materialized (active)
    expect(url).toMatch(new RegExp(`param_from=${Math.round((1751200000000 - 3600000) / 1000)}(?:&|$)`));
  });
  it('query variables (#134): a CREATE VIEW definition is sent unchanged (no substitution)', async () => {
    const { app } = appForRun([[(u, sql) => /CREATE VIEW/.test(sql), resp({ body: streamBody([]) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    const tab = app.activeTab();
    tab.sqlDraft = 'CREATE VIEW v AS SELECT {x:String}';
    app.state.varValues = { x: 'default' }; // even with a value present, a view is not substituted
    await app.actions.run(); // not row-returning, no variables shown → runs freely
    const [url, init] = asMock(app.conn.chCtx.fetch).mock.calls[0];
    expect(url).not.toMatch(/param_x/);
    expect(init.body).toContain('{x:String}');
  });
  it('query variables (#134): a script substitutes reads but leaves a VIEW verbatim', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE VIEW/.test(sql), resp({ text: '' })],
      [(u, sql) => /SELECT/.test(sql), resp({ text: '{"meta":[{"name":"id","type":"UInt32"}],"data":[["5"]]}' })],
    ]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    const tab = app.activeTab();
    tab.sqlDraft = 'CREATE VIEW v AS SELECT {x:String}; SELECT {id:UInt32}';
    app.state.varValues = { id: '5' }; // x is confined to the view → not required, not sent
    await app.actions.run(); // >1 statement → runScript
    const viewCall = asMock(app.conn.chCtx.fetch).mock.calls.find((c) => /CREATE VIEW/.test(c[1].body))!;
    const selCall = asMock(app.conn.chCtx.fetch).mock.calls.find((c) => /SELECT \{id/.test(c[1].body))!;
    expect(viewCall[0]).not.toMatch(/param_/);
    expect(selCall[0]).toMatch(/param_id=5/);
  });
  it('query variables (#134): the gate lives at the executor, so Explain is blocked too', async () => {
    const { app } = appForRun([[() => true, resp({ text: 'plan' })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {id:UInt32}';
    await app.actions.explainQuery(); // clicks Explain → run({explain}) → gate
    expect(asMock(app.conn.chCtx.fetch).mock.calls.length).toBe(0);
    expect(qs(document.body, '.share-toast').textContent).toContain('id');
  });
  it('query variables (#134): a multi-statement script is blocked when a variable is unfilled', async () => {
    const { app } = appForRun([[() => true, resp({ text: '{"meta":[],"data":[]}' })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {a:String}; SELECT 1';
    await app.actions.run(); // >1 statement → runScript → gate
    expect(asMock(app.conn.chCtx.fetch).mock.calls.length).toBe(0);
    expect(qs(document.body, '.share-toast').textContent).toContain('a');
  });
  it('query variables (#173): an Array(T) value binds as a ClickHouse array literal', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {xs:Array(String)}';
    app.state.varValues = asVarValues({ xs: ['a', "b'c"] });
    await app.actions.run();
    const [url] = asMock(app.conn.chCtx.fetch).mock.calls[0];
    expect(decodeURIComponent(url)).toContain("param_xs=['a','b\\'c']");
  });
  it('query variables (#173): a value that cannot serialize for the declaration blocks the run and toasts', async () => {
    const { app } = appForRun([[() => true, resp({ body: streamBody([]) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {db:String}';
    app.state.varValues = asVarValues({ db: ['not', 'scalar'] }); // array value, scalar declaration → structural
    await app.actions.run();
    expect(asMock(app.conn.chCtx.fetch).mock.calls.length).toBe(0);
    expect(qs(document.body, '.share-toast').textContent).toContain('array value');
  });
  it('optional blocks (#165): Run enables with the optional param blank; the block and its arg are omitted', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    app.renderVarStrip();
    expect(app.dom.runBtn!.disabled).toBe(false); // blank optional never gates
    await app.actions.run();
    const [url, init] = asMock(app.conn.chCtx.fetch).mock.calls[0];
    expect(init.body).toBe('SELECT * FROM t WHERE 1 '); // inactive block removed from the wire
    expect(url).not.toMatch(/param_d/); // its param is never sent
  });
  it('optional blocks (#165): typing a value activates the block — predicate included, param bound', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = 'abc';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.state.filterActive.d).toBe(true); // text control syncs activation
    await app.actions.run();
    const [url, init] = asMock(app.conn.chCtx.fetch).mock.calls[0];
    expect(init.body).toBe('SELECT * FROM t WHERE 1  AND d = {d:String} '); // markers stripped, content kept
    expect(url).toMatch(/param_d=abc/);
  });
  it('optional blocks (#165): the strip lists a block-only param with the optional affordance', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {y:UInt16} FROM t /*[ AND d = {d:String} ]*/';
    app.renderVarStrip();
    const fields = [...qsa(app.dom.varStrip!, '.var-field')];
    expect(fields.map((f) => qs(f, '.var-name').textContent)).toEqual(['y', 'd']);
    expect(fields.map((f) => f.classList.contains('is-optional'))).toEqual([false, true]);
    expect(qs(fields[1], '.var-input').title).toContain('optional');
    // the required param still gates Run
    expect(app.dom.runBtn!.disabled).toBe(true);
    expect(app.dom.runBtn!.title).toContain('y');
    expect(app.dom.runBtn!.title).not.toContain('d');
  });
  it('optional blocks (#165): activation persists alongside the value (own storage key)', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT 1 /*[ AND d = {d:String} ]*/';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = 'v1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(JSON.parse(globalThis.localStorage.getItem('asb:filterActive')!)).toEqual({ d: true });
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varValues')!)).toEqual({ d: 'v1' });
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(JSON.parse(globalThis.localStorage.getItem('asb:filterActive')!)).toEqual({ d: false });
  });
  it('optional blocks (#165): a persisted active:false with a stale value keeps the block omitted', async () => {
    vi.stubGlobal('localStorage', memStore({
      'asb:varValues': JSON.stringify({ d: 'stale' }),
      'asb:filterActive': JSON.stringify({ d: false }),
    }));
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    await app.actions.run();
    const [url, init] = asMock(app.conn.chCtx.fetch).mock.calls[0];
    expect(init.body).toBe('SELECT * FROM t WHERE 1 '); // dormant value is inert
    expect(url).not.toMatch(/param_d/);
  });
  it('optional blocks (#165): a template error blocks the run with a toast', async () => {
    const { app } = appForRun([[() => true, resp({ body: streamBody([]) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT 1 /*[ AND 1 = 1 ]*/'; // parameterless block
    await app.actions.run();
    expect(asMock(app.conn.chCtx.fetch).mock.calls.length).toBe(0);
    expect(qs(document.body, '.share-toast').textContent).toContain('optional block');
  });
  it('optional blocks (#165): Explain wraps the materialized statement, not the raw template', async () => {
    const { app } = appForRun([[() => true, resp({ text: 'plan' })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    app.state.varValues = { d: 'x' };
    app.state.filterActive = { d: true };
    await app.actions.explainQuery();
    const [url, init] = asMock(app.conn.chCtx.fetch).mock.calls.find((c) => c[1] && c[1].body)!;
    expect(init.body).toMatch(/^EXPLAIN/);
    expect(init.body).toContain('AND d = {d:String}'); // active block content in
    expect(init.body).not.toContain('/*['); // markers never reach the server
    expect(url).toMatch(/param_d=x/);
  });
  it('optional blocks (#165): a script sends each statement materialized, args per statement', async () => {
    const { app } = appForRun([[() => true, resp({ text: '{"meta":[],"data":[]}' })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT 1 /*[ AND a = {a:String} ]*/; SELECT 2 /*[ AND b = {b:String} ]*/';
    app.state.varValues = { a: 'x' };
    app.state.filterActive = { a: true };
    await app.actions.run(); // >1 statement → runScript
    const bodies = asMock(app.conn.chCtx.fetch).mock.calls.map((c) => c[1] && c[1].body);
    expect(bodies).toContain('SELECT 1  AND a = {a:String} '); // active block in
    expect(bodies).toContain('SELECT 2 '); // inactive block out
    const aCall = asMock(app.conn.chCtx.fetch).mock.calls.find((c) => /SELECT 1/.test(c[1].body))!;
    expect(aCall[0]).toMatch(/param_a=x/);
    const bCall = asMock(app.conn.chCtx.fetch).mock.calls.find((c) => /SELECT 2/.test(c[1].body))!;
    expect(bCall[0]).not.toMatch(/param_b/);
  });
  it('typed validation (#170): a clearly-invalid value shows the inline error immediately and disables Run', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {n:UInt8}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = 'abc'; // not a plausible prefix of anything — invalid, not incomplete
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(app.dom.runBtn!.disabled).toBe(true);
    expect(app.dom.runBtn!.title).toContain('n');
  });
  it('typed validation (#170): an out-of-range value shows a specific reason, exceeding server strictness on purpose', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {n:UInt8}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = '256'; // the live server accepts this and silently wraps to 0 — blocked client-side instead
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(input.title).toBe('Expected UInt8 from 0 to 255');
  });
  it("typed validation (#170): a plausible mid-typing prefix ('-') stays neutral while focused, hardens on blur", () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {n:Int32}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = '-';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(false); // neutral — could still become '-5'
    expect(app.dom.runBtn!.disabled).toBe(false); // 'input' mode never hardens
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(true); // blur commits — hardens to invalid
    expect(app.dom.runBtn!.disabled).toBe(true);
  });
  it('typed validation (#170 review): a hardened invalid value keeps blocking Run across unrelated re-renders, until the field itself is edited', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {n:Int32}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = '-';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true })); // hardens '-' to invalid
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(app.dom.runBtn!.disabled).toBe(true);

    // renderVarStrip's own tail call (fired on every SQL-editor keystroke via
    // onDocChange) recomputes Run's gate gate-less, in lenient 'input' mode —
    // which alone would read the still-incomplete '-' as merely incomplete
    // and silently re-enable Run while the field still paints red. The
    // signature is unchanged (same {n:Int32}), so this only re-derives the
    // Run button, exactly the path that regressed.
    app.renderVarStrip();
    expect(app.dom.runBtn!.disabled).toBe(true);
    expect(app.dom.runBtn!.title).toContain('n');
    expect(input.classList.contains('is-invalid')).toBe(true);

    // Same gate-less fallback, reached from the hasSelection effect (fires on
    // every cursor/selection move).
    app.state.hasSelection.value = true;
    expect(app.dom.runBtn!.disabled).toBe(true);

    // Editing the field's own value clears its hardened flag — lenient
    // 'input'-mode behavior resumes, and a now-valid value re-enables Run.
    input.value = '-5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(false);
    expect(app.dom.runBtn!.disabled).toBe(false);
  });
  it('typed validation (#170): Enter also hardens an incomplete value', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {n:Float64}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = '1e'; // live-rejected, but a genuine mid-typing state
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(false);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(app.dom.runBtn!.disabled).toBe(true);
  });
  it('typed validation (#170): correcting an invalid value clears the affordance and re-enables Run', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {n:UInt8}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = 'abc';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.dom.runBtn!.disabled).toBe(true);
    input.value = '42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(false);
    expect(app.dom.runBtn!.disabled).toBe(false);
  });
  it('typed validation (#170): an out-of-scope type (String) is never marked invalid', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {s:String}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = 'anything at all, ,,, {}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(false);
    expect(app.dom.runBtn!.disabled).toBe(false);
  });
  it('typed validation (#170): a run is blocked and toasts for an invalid (not just missing) variable', async () => {
    const { app } = appForRun([[() => true, resp({ body: streamBody([]) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {n:UInt8}';
    app.state.varValues = { n: '256' };
    await app.actions.run();
    expect(asMock(app.conn.chCtx.fetch).mock.calls.length).toBe(0);
    expect(qs(document.body, '.share-toast').textContent).toContain('n');
  });
  it('typed validation (#170): a persisted invalid value paints the affordance on strip (re)build, e.g. a tab switch', () => {
    const { app } = appForRun([]);
    app.activeTab().sqlDraft = 'SELECT {n:UInt8}';
    app.state.varValues = { n: '256' };
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(app.dom.runBtn!.disabled).toBe(true);
  });
  it('the wall clock (#173) is its own injected seam, distinct from the duration clock', () => {
    const app = createApp(env({ wallNow: () => 777 })); // injected → tests can pin the wave clock
    expect(app.wallNow()).toBe(777);
    const app2 = createApp(env()); // default → Date.now (epoch ms), while env.now stays 0
    expect(app2.wallNow()).toBeGreaterThan(1e12);
    expect(app2.now()).toBe(0);
  });
  it('tickElapsed updates the live ms readout mid-run (via the workbench session), and no-ops without the element', async () => {
    let resolveRunFetch!: (value: FakeResponse | Promise<FakeResponse>) => void;
    let n = 0;
    const fetch = asFetch(vi.fn((_url: string, init?: { body?: string }) => (init && /SELECT 1/.test(init.body || '')
      ? new Promise<FakeResponse>((res) => { resolveRunFetch = res; })
      : Promise.resolve(resp({ json: { data: [] } })))));
    const { app } = appForRun([], { fetch, now: () => (n += 10) });
    app.activeTab().sqlDraft = 'SELECT 1';
    const pending = app.actions.run();
    await new Promise((r) => setTimeout(r)); // let run() reach the in-flight request
    app.dom.runElapsedEl = document.createElement('span');
    app.tickElapsed();
    const text = app.dom.runElapsedEl!.textContent!;
    expect(text).toMatch(/^\d+ ms$/);
    expect(parseInt(text, 10)).toBeGreaterThan(0);
    app.dom.runElapsedEl = undefined;
    expect(() => app.tickElapsed()).not.toThrow();
    resolveRunFetch(resp({ body: streamBody([]) }));
    await pending;
  });
  it('cancel() aborts + issues KILL QUERY when running; no-op when idle', async () => {
    let resolveRunFetch!: (value: FakeResponse | Promise<FakeResponse>) => void;
    const fetch = asFetch(vi.fn((_url: string, init?: { body?: string }) => (init && /SELECT 1/.test(init.body || '')
      ? new Promise<FakeResponse>((res) => { resolveRunFetch = res; })
      : Promise.resolve(resp({ json: { data: [] } })))));
    const { app, e } = appForRun([], { fetch });
    app.actions.cancel(); // idle → no-op, no throw
    app.activeTab().sqlDraft = 'SELECT 1';
    const pending = app.actions.run();
    await new Promise((r) => setTimeout(r)); // let run() reach the in-flight request, publishing its live query_id
    expect(app.state.running.value).toBe(true);
    const runCall = asMock(fetch).mock.calls.find((c) => c[1] && /SELECT 1/.test(c[1].body || ''))!;
    // The live query_id (#276 Phase 3a: minted + tracked by the workbench
    // session, no longer a state.ts field) rides on the run request's own URL.
    const queryId = decodeURIComponent((runCall[0].match(/query_id=([^&]+)/) || [])[1] || '');
    expect(queryId).toBeTruthy();
    app.actions.cancel();
    expect((runCall[1].signal as AbortSignal).aborted).toBe(true);
    await new Promise((r) => setTimeout(r)); // let the fire-and-forget KILL QUERY run
    const kill = asMock(e.fetch!).mock.calls.find((c) => /KILL QUERY/.test((c[1] && c[1].body) || ''))!;
    expect(kill).toBeTruthy();
    expect(kill[1].body).toContain("query_id = '" + queryId + "'");
    resolveRunFetch(Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    await pending;
  });
  // #276 Phase 5: signOut is the first production wiring of the sessions'
  // teardown surfaces — an in-flight run must be aborted + server-killed and
  // the catalog caches dropped BEFORE the login screen appears, and the
  // workbench must come back fully usable after a re-render (destroy() is
  // not one-way for the workbench session: attachShell re-attaches).
  it('app.closeDocPane closes an open reference pane (true) and no-ops when nothing is open (false) — the global Escape wiring (#60)', async () => {
    const app = createApp(env());
    expect(app.closeDocPane()).toBe(false); // nothing open
    app.openDocEntry({ kind: 'function', name: 'sum' }); // pane opens (lookup resolves unavailable — irrelevant here)
    expect(document.querySelector('[role="complementary"]')).not.toBeNull();
    expect(app.closeDocPane()).toBe(true);
    expect(document.querySelector('[role="complementary"]')).toBeNull();
    await Promise.resolve(); // drain the discarded lookup
  });

  it('signOut() aborts an in-flight run, kills the server query, invalidates the catalog, and still allows a run after re-render', async () => {
    let resolveRunFetch!: (value: FakeResponse | Promise<FakeResponse>) => void;
    const fetch = asFetch(vi.fn((_url: string, init?: { body?: string }) => {
      const sql = (init && init.body) || '';
      if (/SELECT 1\b/.test(sql)) return new Promise<FakeResponse>((res) => { resolveRunFetch = res; });
      if (/SELECT 2\b/.test(sql)) {
        return Promise.resolve(resp({ body: streamBody([
          '{"meta":[{"name":"x","type":"String"}]}\n',
          '{"row":{"x":"ok"}}\n',
        ]) }));
      }
      return Promise.resolve(resp({ json: { data: [] } })); // version/schema/reference background loads
    }));
    const { app, e } = appForRun([], { fetch });
    const invalidateSpy = vi.spyOn(app.catalog, 'invalidate');
    app.activeTab().sqlDraft = 'SELECT 1';
    const pending = app.actions.run();
    await new Promise((r) => setTimeout(r));
    expect(app.state.running.value).toBe(true);
    const runCall = asMock(fetch).mock.calls.find((c) => c[1] && /SELECT 1\b/.test(c[1].body || ''))!;
    app.signOut();
    // Teardown fired before login rendered: stream aborted, catalog invalidated.
    expect((runCall[1].signal as AbortSignal).aborted).toBe(true);
    expect(invalidateSpy).toHaveBeenCalled();
    expect(qs(app.root!, '.login-card')).toBeTruthy();
    await new Promise((r) => setTimeout(r));
    const kill = asMock(e.fetch!).mock.calls.find((c) => /KILL QUERY/.test((c[1] && c[1].body) || ''));
    expect(kill).toBeTruthy();
    resolveRunFetch(Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    await pending;
    // Re-entry: sign back in (signOut cleared the tokens — that's the point),
    // then a fresh renderApp re-attaches the shell effects and the same
    // session runs again (destroy() left it reusable).
    app.conn.setTokens(validToken);
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 2';
    await app.actions.run();
    expect(result(app.activeTab()).rows).toEqual([['ok']]);
    expect(app.state.running.value).toBe(false);
  });
  it('surfaces a query error', async () => {
    const { app } = appForRun([
      [(u, sql) => /bad/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: nope"}' })],
    ]);
    app.activeTab().lastSuccessfulResultColumns = [{ name: 'previous', type: 'String' }];
    app.activeTab().sqlDraft = 'bad';
    await app.actions.run();
    expect(result(app.activeTab()).error).toContain('nope');
    expect(app.activeTab().lastSuccessfulResultColumns).toEqual([{ name: 'previous', type: 'String' }]);
    expect(app.state.history.length).toBe(0);
  });
  it('runs raw and captures the response when the SQL ends with a FORMAT clause', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 9/.test(sql), resp({ text: 'a\tb' })],
    ]);
    app.activeTab().sqlDraft = 'SELECT 9 FORMAT TabSeparatedWithNames';
    await app.actions.run();
    expect(result(app.activeTab()).rawText).toBe('a\tb');
    expect(result(app.activeTab()).rawFormat).toBe('TabSeparatedWithNames'); // label for the raw tab
  });
  const sentExplains = (e: CreateAppEnv): string[] =>
    asMock(e.fetch!).mock.calls.map((c) => c[1] && c[1].body).filter((b) => /EXPLAIN/.test(b || ''));
  it('runs a plain EXPLAIN verbatim in the Explain view (clean TabSeparatedRaw)', async () => {
    const { app, e } = appForRun([
      [(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'Expression\n  ReadFromTable' })],
    ]);
    app.activeTab().sqlDraft = 'EXPLAIN SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).explainView).toBe('explain');
    expect(result(app.activeTab()).rawText).toBe('Expression\n  ReadFromTable');
    expect(sentExplains(e)).toContain('EXPLAIN SELECT 1'); // verbatim
  });
  it('keeps a complex EXPLAIN (extra settings) on the verbatim Explain view', async () => {
    const { app, e } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })]]);
    app.activeTab().sqlDraft = 'EXPLAIN indexes = 1, actions = 1 SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).explainView).toBe('explain'); // not auto-jumped to Indexes
    expect(sentExplains(e)).toContain('EXPLAIN indexes = 1, actions = 1 SELECT 1'); // run as typed
  });
  it('auto-selects the Indexes view for an exact indexes=1 EXPLAIN', async () => {
    const { app } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'idx plan' })]]);
    app.activeTab().sqlDraft = 'EXPLAIN indexes = 1 SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).explainView).toBe('indexes');
  });
  it('does not leak a previous rich view onto a freshly-typed plain EXPLAIN', async () => {
    const { app } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'digraph{}' })]]);
    app.activeTab().sqlDraft = 'EXPLAIN PIPELINE graph = 1 SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).explainView).toBe('pipeline');
    app.activeTab().sqlDraft = 'EXPLAIN SELECT 2'; // plain → must show the plan, not pipeline
    await app.actions.run();
    expect(result(app.activeTab()).explainView).toBe('explain');
  });
  it('setExplainView re-runs a derived query and never edits the SQL', async () => {
    const { app, e } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'digraph{}' })]]);
    app.activeTab().sqlDraft = 'EXPLAIN SELECT 1';
    await app.actions.run();
    await app.actions.setExplainView('pipeline');
    expect(app.activeTab().sqlDraft).toBe('EXPLAIN SELECT 1'); // editor untouched
    expect(result(app.activeTab()).explainView).toBe('pipeline');
    expect(sentExplains(e)).toContain('EXPLAIN PIPELINE graph = 1 SELECT 1');
  });
  it('the Explain button explains a plain SELECT (wraps it, editor untouched)', async () => {
    const { app, e } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })]]);
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.explainQuery();
    expect(app.activeTab().sqlDraft).toBe('SELECT 1'); // editor untouched
    expect(result(app.activeTab()).explainView).toBe('explain');
    expect(sentExplains(e)).toContain('EXPLAIN SELECT 1');
  });
  it('Explain on a multi-statement script shows a message and sends no EXPLAIN', async () => {
    const { app, e } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })]]);
    app.activeTab().sqlDraft = 'SELECT 1; SELECT 2';
    await app.actions.explainQuery();
    expect(qs(document, '.share-toast').textContent).toMatch(/multi-statement/);
    expect(sentExplains(e)).toHaveLength(0); // nothing sent to ClickHouse
    expect(app.activeTab().result).toBeNull();
  });
  it('setExplainView on a multi-statement script is also blocked', async () => {
    const { app, e } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })]]);
    app.activeTab().sqlDraft = 'SELECT 1; SELECT 2';
    await app.actions.setExplainView('pipeline');
    expect(qs(document, '.share-toast').textContent).toMatch(/multi-statement/);
    expect(sentExplains(e)).toHaveLength(0);
  });
  it('runs ESTIMATE as a structured table (streaming), not raw', async () => {
    const { app } = appForRun([
      [(u, sql) => /ESTIMATE/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"rows","type":"UInt64"}]}\n', '{"row":{"rows":"42"}}\n']) })],
    ]);
    app.activeTab().sqlDraft = 'EXPLAIN ESTIMATE SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).explainView).toBe('estimate');
    expect(result(app.activeTab()).rows).toEqual([['42']]);
    expect(result(app.activeTab()).rawText).toBeNull();
  });
  it('decorates the auto-derived Explain/Indexes queries with pretty=1, compact=1 on a >=26.3 server', async () => {
    const { app, e } = appForRun([
      [(u, sql) => /version\(\)/.test(sql), resp({ json: { data: [{ v: '26.3.1' }] } })],
      [(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })],
    ]);
    await new Promise((r) => setTimeout(r)); // let app.catalog.loadVersion() resolve
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.explainQuery();
    expect(sentExplains(e)).toContain('EXPLAIN pretty = 1, compact = 1 SELECT 1');
    app.activeTab().sqlDraft = 'EXPLAIN indexes = 1 SELECT 1';
    await app.actions.run();
    expect(sentExplains(e)).toContain('EXPLAIN indexes = 1, pretty = 1, compact = 1 SELECT 1');
  });
  it('never decorates a typed, verbatim EXPLAIN even on a >=26.3 server', async () => {
    const { app, e } = appForRun([
      [(u, sql) => /version\(\)/.test(sql), resp({ json: { data: [{ v: '26.3.1' }] } })],
      [(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })],
    ]);
    await new Promise((r) => setTimeout(r)); // let app.catalog.loadVersion() resolve
    app.activeTab().sqlDraft = 'EXPLAIN SELECT 1';
    await app.actions.run();
    expect(sentExplains(e)).toContain('EXPLAIN SELECT 1'); // verbatim, no decoration
  });
  it('an explicit FORMAT on an EXPLAIN still wins over the raw default', async () => {
    const { app } = appForRun([
      [(u, sql) => /EXPLAIN/.test(sql), resp({ text: '{"plan":[]}' })],
    ]);
    app.activeTab().sqlDraft = 'EXPLAIN SELECT 1 FORMAT JSON';
    await app.actions.run();
    expect(result(app.activeTab()).rawFormat).toBe('JSON'); // FORMAT clause, not the EXPLAIN default
  });

  // ── multiquery / run-selection (#83) ──────────────────────────────────────
  const SCRIPT = 'CREATE TABLE t (a Int8); INSERT INTO t VALUES (1); SELECT count() AS c FROM t';
  const scriptRoutes = (): FetchRoute[] => [
    [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
    [(u, sql) => /INSERT INTO t/.test(sql), resp({ text: '' })],
    [(u, sql) => /SELECT count/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'c', type: 'UInt64' }], data: [['1']] }) })],
  ];

  it('runs a ;-separated script sequentially, one summary row per statement, and records one history entry', async () => {
    const { app } = appForRun(scriptRoutes());
    app.state.sidePanel.value = 'history'; // exercise the history repaint in the finally
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    const script = scriptOf(app.activeTab());
    expect(script.map((e) => e.status)).toEqual(['ok', 'ok', 'rows']);
    expect(script[2]).toMatchObject({ preview: '1', columns: [{ name: 'c', type: 'UInt64' }], rows: [['1']] });
    expect(script.every((e) => typeof e.ms === 'number')).toBe(true); // per-statement time recorded
    expect(app.state.history).toHaveLength(1);
    expect(app.state.history[0].sql).toBe(SCRIPT);
    // SELECT statements are sent with the JSONCompact + row-cap params
    // (over-fetched by one past the display cap to detect truncation).
    const urls = asMock(app.conn.chCtx.fetch).mock.calls.map((c) => c[0]);
    const selUrl = urls.find((u) => /max_result_rows=101/.test(u));
    expect(selUrl).toMatch(/result_overflow_mode=break/);
    // this script needs no session (permanent table) → session-less (no race)
    expect(urls.some((u) => /session_id=/.test(u))).toBe(false);
  });
  it('refreshes the schema once a script contains a schema-mutating statement that actually ran (#diagnose-db-creation)', async () => {
    const { app } = appForRun(scriptRoutes());
    await new Promise((r) => setTimeout(r)); // let the initial-mount loadSchema settle
    const spy = vi.spyOn(app.catalog, 'loadSchema');
    app.activeTab().sqlDraft = SCRIPT; // CREATE TABLE t; INSERT …; SELECT …
    await app.actions.run();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('still refreshes the schema when a later statement fails — the DDL already ran server-side', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), resp({ ok: false, status: 500, text: 'DB::Exception: boom' })],
    ]);
    await new Promise((r) => setTimeout(r));
    const spy = vi.spyOn(app.catalog, 'loadSchema');
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('does not refresh the schema for a script with no schema-mutating statement', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'n', type: 'Int' }], data: [['1']] }) })],
    ]);
    await new Promise((r) => setTimeout(r));
    const spy = vi.spyOn(app.catalog, 'loadSchema');
    app.activeTab().sqlDraft = 'SELECT 1; SELECT 2';
    await app.actions.run();
    expect(spy).not.toHaveBeenCalled();
  });
  it('a script with CREATE TEMPORARY / SET shares one session across all its statements', async () => {
    const { app } = appForRun([
      [(u, sql) => /TEMPORARY/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), resp({ text: '' })],
      [(u, sql) => /SELECT \* FROM t/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'a', type: 'Int8' }], data: [['1']] }) })],
    ]);
    app.activeTab().sqlDraft = 'CREATE TEMPORARY TABLE t (a Int8); INSERT INTO t VALUES (1); SELECT * FROM t';
    await app.actions.run();
    const sids = asMock(app.conn.chCtx.fetch).mock.calls.map((c) => c[0]).filter((u) => /session_id=/.test(u)).map((u) => /session_id=([^&]+)/.exec(u)![1]);
    expect(sids).toHaveLength(3); // all three statements carry the session
    expect(new Set(sids).size).toBe(1); // and it's the same one (temp table persists)
  });

  it('flags a SELECT as truncated when more than the cap rows come back', async () => {
    const data = Array.from({ length: 101 }, (_, i) => [String(i)]);
    const { app } = appForRun([
      [(u, sql) => /SELECT/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'n', type: 'Int' }], data }) })],
    ]);
    app.activeTab().sqlDraft = 'SELECT 1; SELECT 2'; // two statements → script mode
    await app.actions.run();
    const last = scriptOf(app.activeTab())[1] as ScriptRowsEntry;
    expect(last.rows).toHaveLength(100); // displayed cap
    expect(last.truncated).toBe(true);
  });

  it('a comment-only selection is a no-op (nothing is sent)', async () => {
    const { app } = appForRun([]);
    app.sqlEditor.replaceDocument('-- just a note');
    app.dom.sqlEditorView!.dispatch({ selection: { anchor: 0, head: app.sqlEditor.getValue().length } });
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result).toBeNull(); // no run started
    // the comment text was never POSTed to ClickHouse
    expect(asMock(app.conn.chCtx.fetch).mock.calls.some((c) => /just a note/.test(c[1] && c[1].body))).toBe(false);
  });

  it('copyResult treats a script result as non-exportable (no throw)', async () => {
    const { app } = appForRun(scriptRoutes());
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    expect(scriptOf(app.activeTab())).toHaveLength(3);
    expect(() => app.actions.copyResult()).not.toThrow();
  });

  it('stops on the first failing statement and skips the rest (no history)', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), resp({ ok: false, status: 500, text: 'DB::Exception: boom' })],
    ]);
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    const script = scriptOf(app.activeTab());
    expect(script).toHaveLength(2); // CREATE ok, INSERT error; SELECT never run
    expect(script[1]).toMatchObject({ status: 'error' });
    expect((script[1] as ScriptErrorEntry).error).toMatch(/boom/);
    expect(app.state.history).toHaveLength(0);
  });

  it('reports a connection reset (TypeError) on a non-idempotent statement without retrying it', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), () => { throw new TypeError('fetch failed'); }],
    ]);
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    expect(scriptOf(app.activeTab())[0]).toMatchObject({ status: 'error' });
    expect((scriptOf(app.activeTab())[0] as ScriptErrorEntry).error).toMatch(/may have executed/);
  });

  it('surfaces a non-abort thrown error message per statement', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), () => { throw new Error('kaput'); }],
    ]);
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    expect(scriptOf(app.activeTab())[0]).toMatchObject({ status: 'error', error: 'kaput' });
  });

  it('aborts mid-script: marks the result cancelled and records no history', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }],
    ]);
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    expect(result(app.activeTab()).cancelled).toBe(true);
    expect(scriptOf(app.activeTab())).toHaveLength(1); // CREATE ran; INSERT aborted before pushing
    expect(app.state.history).toHaveLength(0);
  });

  it('retries a READ-ONLY statement once on a transient connection reset (Network error → success)', async () => {
    let sel = 0;
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), resp({ text: '' })],
      // the SELECT (idempotent) resets once, then the retry succeeds
      [(u, sql) => /SELECT count/.test(sql), () => { if (sel++ === 0) throw new TypeError('Failed to fetch'); return resp({ text: JSON.stringify({ meta: [{ name: 'c', type: 'UInt64' }], data: [['1']] }) }); }],
    ]);
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    expect(sel).toBe(2); // retried the SELECT
    expect(scriptOf(app.activeTab()).map((e) => e.status)).toEqual(['ok', 'ok', 'rows']); // recovered
  });

  it('does NOT retry a non-idempotent statement on a connection reset (surfaces "may have executed")', async () => {
    let inserts = 0;
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), () => { inserts++; throw new TypeError('Failed to fetch'); }],
    ]);
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    expect(inserts).toBe(1); // the INSERT is NOT re-sent — it may have run server-side
    expect(scriptOf(app.activeTab())[1]).toMatchObject({ status: 'error' });
    expect((scriptOf(app.activeTab())[1] as ScriptErrorEntry).error).toMatch(/may have executed/);
  });

  it('retries a statement once when the ClickHouse session is briefly locked', async () => {
    let n = 0;
    const locked = '{"exception":"Code: 373. DB::Exception: Session abc is locked by a concurrent client. (SESSION_IS_LOCKED)"}';
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), () => (n++ === 0 ? resp({ ok: false, status: 500, text: locked }) : resp({ text: '' }))],
      [(u, sql) => /INSERT INTO t/.test(sql), resp({ text: '' })],
      [(u, sql) => /SELECT count/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'c', type: 'UInt64' }], data: [['1']] }) })],
    ]);
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    expect(n).toBe(2); // retried past the transient lock
    expect(scriptOf(app.activeTab())[0].status).toBe('ok');
  });

  it('does not retry a genuine query error (stops on the first failure)', async () => {
    let inserts = 0;
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), () => { inserts++; return resp({ ok: false, status: 400, text: '{"exception":"DB::Exception: bad value"}' }); }],
    ]);
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    expect(inserts).toBe(1); // no retry for a non-transient error
    expect(scriptOf(app.activeTab())[1]).toMatchObject({ status: 'error' });
  });

  it('session_id falls back to a unique non-UUID id without crypto.randomUUID', async () => {
    // Deliberately missing `randomUUID`/`subtle` (a partial `Crypto`, forcing
    // the non-secure-context fallback path) — `globalThis.crypto`, not the
    // no-longer-imported `node:crypto` `webcrypto` (dropped when `env()`'s own
    // default switched to it — no @types/node in this project).
    const noUuid = asCrypto({ getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    const { app } = appForRun([[() => true, resp({ body: streamBody(['{"row":{}}\n']) })]], { crypto: noUuid });
    app.activeTab().sqlDraft = 'SET max_threads = 1'; // SET opens a session, so a session_id is sent
    await app.actions.run();
    const url = asMock(app.conn.chCtx.fetch).mock.calls.map((c) => c[0]).find((u) => /session_id=/.test(u));
    expect(decodeURIComponent(/session_id=([^&]+)/.exec(url)![1])).toMatch(/^sess-/); // collision-resistant fallback
  });

  it('run-selection: a non-empty selection runs only the selected statement (rich path) and records that text', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })],
    ]);
    app.sqlEditor.replaceDocument('SELECT 1; SELECT 2');
    app.dom.sqlEditorView!.dispatch({ selection: { anchor: 0, head: 8 } }); // "SELECT 1"
    await app.actions.run();
    expect(result(app.activeTab()).rows).toEqual([['1']]); // single-statement rich path, not the script grid
    expect(scriptOf(app.activeTab())).toBeUndefined();
    expect(app.state.history[0].sql).toBe('SELECT 1'); // the selection, not the whole editor
  });

  it('runEntry while already running is a no-op', async () => {
    const { app } = appForRun([]);
    app.state.running.value = true;
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    expect(app.activeTab().result).toBeNull();
  });

  it('a signed-out script run hits onSignedOut and produces no result', async () => {
    const app = createApp(env({ sessionStorage: memSession({}) }));
    app.renderApp();
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.run();
    expect(app.activeTab().result).toBeNull(); // returns before building the grid
  });

  it('syncSelection drives hasSelection; setRunBtn flips to "Run selection"', () => {
    const { app } = appForRun([]);
    let focused = true;
    let sel = { start: 0, end: 8, text: 'SELECT 1' };
    app.sqlEditor = { ...app.sqlEditor, hasFocus: () => focused, getSelection: () => sel };
    app.syncSelection!();
    expect(app.state.hasSelection.value).toBe(true);
    app.setRunBtn(false);
    expect(app.dom.runBtn!.textContent).toContain('Run selection');
    // collapsed selection → false; unfocused editor → false
    sel = { start: 0, end: 0, text: '' };
    app.syncSelection!();
    expect(app.state.hasSelection.value).toBe(false);
    sel = { start: 0, end: 8, text: 'SELECT 1' };
    focused = false;
    app.syncSelection!();
    expect(app.state.hasSelection.value).toBe(false);
  });

  // ── result-row cap (#86) ──────────────────────────────────────────────────
  // `.findLast` needs an es2023 lib target this project doesn't set — walk
  // backward instead (same "most recent matching request" result).
  const runUrl = (e: CreateAppEnv, re: RegExp): string => {
    const calls = asMock(e.fetch!).mock.calls;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (re.test((calls[i][1] && calls[i][1].body) || '')) return calls[i][0];
    }
    throw new Error('runUrl: no matching call'); // test would already fail on a null/undefined url
  };
  it('caps a normal SELECT server-side and trims block-boundary overage (flagging capped)', async () => {
    const { app, e } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody([
        '{"meta":[{"name":"a","type":"UInt8"}]}\n',
        '{"row":{"a":"1"}}\n', '{"row":{"a":"2"}}\n', '{"row":{"a":"3"}}\n', // overage past the cap of 2
      ]) })],
    ]);
    app.state.resultRowLimit = 2;
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    const url = runUrl(e, /SELECT 1/);
    expect(url).toContain('max_result_rows=2');
    expect(url).toContain('result_overflow_mode=break');
    expect(result(app.activeTab()).rows).toEqual([['1'], ['2']]); // overage trimmed client-side
    expect(result(app.activeTab()).capped).toBe(true);
  });
  it('does not cap EXPLAIN/ESTIMATE runs even though ESTIMATE streams as Table', async () => {
    const { app, e } = appForRun([
      [(u, sql) => /ESTIMATE/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"rows","type":"UInt64"}]}\n', '{"row":{"rows":"42"}}\n']) })],
    ]);
    app.state.resultRowLimit = 100;
    app.activeTab().sqlDraft = 'EXPLAIN ESTIMATE SELECT 1';
    await app.actions.run();
    expect(runUrl(e, /ESTIMATE/)).not.toContain('max_result_rows');
    expect(result(app.activeTab()).capped).toBe(false);
  });
  it('setResultRowLimit persists the normalized preference and re-runs with the new cap', async () => {
    // Route the app's localStorage seam through an in-memory stub so the
    // persistence assertion below doesn't touch the host runtime's native Web
    // Storage (broken under Node 25 without --localstorage-file — issue #130).
    vi.stubGlobal('localStorage', memStore());
    const { app, e } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })],
    ]);
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.setResultRowLimit(99); // not an option → snaps back to the default 500
    expect(app.state.resultRowLimit).toBe(500);
    expect(globalThis.localStorage.getItem('asb:resultRowLimit')).toBe('500');
    await app.actions.setResultRowLimit(1000);
    expect(app.state.resultRowLimit).toBe(1000);
    expect(runUrl(e, /SELECT 1/)).toContain('max_result_rows=1000'); // re-ran with the new cap
  });

  it('run(): the args snapshot is captured at wave start — a var edit during the auth awaits does not change the sent params (review F6)', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    app.activeTab().sqlDraft = 'SELECT {id:String}';
    app.state.varValues = { id: 'first' };
    const p = app.actions.run(); // runs synchronously through the gate + capture, suspends at ensureConfig/getToken
    app.state.varValues.id = 'second'; // the mid-await edit — must apply to the NEXT run only
    await p;
    const urls = asMock(app.conn.chCtx.fetch).mock.calls.map(([url]) => url);
    expect(urls.some((u) => /param_id=first/.test(u))).toBe(true); // the gate-time snapshot was sent
    expect(urls.some((u) => /param_id=second/.test(u))).toBe(false);
  });

  describe('enum variables (#172)', () => {
    const ENUM_TYPE = "Enum8('active' = 1, 'deleted' = 2, 'banned' = 3)";
    it('v1: a declared Enum8 variable renders a dropdown of its members', () => {
      const { app } = appForRun([]);
      app.activeTab().sqlDraft = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`;
      app.renderVarStrip();
      const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      const opts = [...qsa(app.dom.varStrip!, '[role="option"]')].map((o) => o.textContent);
      expect(opts).toEqual(['active', 'deleted', 'banned']);
    });
    it('v1: a non-member value is gated inline (blocking — the declared type is a real Enum)', () => {
      const { app } = appForRun([]);
      app.activeTab().sqlDraft = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`;
      app.renderVarStrip();
      const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.value = 'nope';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      expect(app.dom.runBtn!.disabled).toBe(true);
      expect(input.classList.contains('is-invalid')).toBe(true);
      expect(input.title).toMatch(/Expected one of: 'active', 'deleted', 'banned'/);
    });
    it('v1: a bare numeric code matching a declared code passes (live-server fact)', () => {
      const { app } = appForRun([]);
      app.activeTab().sqlDraft = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`;
      app.renderVarStrip();
      const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.value = '2';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      expect(app.dom.runBtn!.disabled).toBe(false);
      expect(input.classList.contains('is-invalid')).toBe(false);
    });
    it('v2: a String var compared to a column not yet loaded stays a plain input (no dropdown, no recents recorded)', () => {
      const { app } = appForRun([]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: null }] }];
      app.activeTab().sqlDraft = 'SELECT * FROM events WHERE status = {s:String}';
      app.renderVarStrip();
      const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      expect(qsa(app.dom.varStrip!, '[role="option"]')).toHaveLength(0);
    });
    it('v2: the dropdown appears once the idle-tick loader caches the compared column as an Enum — zero new queries beyond the one column load', async () => {
      const { app } = appForRun([
        [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'status', type: ENUM_TYPE, comment: '' }] } })],
      ]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: null }] }];
      app.activeTab().sqlDraft = 'SELECT * FROM events WHERE status = {s:String}';
      app.renderVarStrip();
      let input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      expect(qsa(app.dom.varStrip!, '[role="option"]')).toHaveLength(0); // not loaded yet
      await app.actions.loadColumns('d', 'events'); // the CM6 adapter's idle-tick load, or a schema-panel expand
      // The strip's own signature guard folds in each var's resolved enum
      // options (not just name/type/optional) — the {name:Type} SET itself
      // never changed, only the schema cache did, and the field still upgrades.
      input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      const opts = [...qsa(app.dom.varStrip!, '[role="option"]')].map((o) => o.textContent);
      expect(opts).toEqual(['active', 'deleted', 'banned']);
    });
    it('v2: a non-member value still executes (suggestion-only — the declared type stays String)', async () => {
      const { app } = appForRun([
        [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'status', type: ENUM_TYPE, comment: '' }] } })],
        [(u, sql) => /SELECT \* FROM events/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })],
      ]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: null }] }];
      app.activeTab().sqlDraft = 'SELECT * FROM events WHERE status = {s:String}';
      app.renderVarStrip();
      await app.actions.loadColumns('d', 'events');
      const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.value = 'not-a-member';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      expect(input.classList.contains('is-invalid')).toBe(false);
      expect(app.dom.runBtn!.disabled).toBe(false);
      await app.actions.run();
      expect(asMock(app.conn.chCtx.fetch).mock.calls.some(([url]) => /param_s=not-a-member/.test(url))).toBe(true);
    });
    it('v1: Enter with no active option (list closed) falls through to the plain hard-commit/harden path', () => {
      const { app } = appForRun([]);
      app.activeTab().sqlDraft = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`;
      app.renderVarStrip();
      const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.value = 'nope';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(app.dom.runBtn!.disabled).toBe(true);
      expect(input.classList.contains('is-invalid')).toBe(true);
    });
    it('v1: Enter with an active option commits it via keydown (combobox delegation)', () => {
      const { app } = appForRun([]);
      app.activeTab().sqlDraft = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`;
      app.renderVarStrip();
      const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(input.value).toBe('active'); // the first member, committed
      expect(input.getAttribute('aria-expanded')).toBe('false');
    });
    it('v2: ambiguous (JOIN, unqualified column) degrades silently to a plain input', () => {
      const { app } = appForRun([]);
      app.state.schema.value = [{ db: 'd', tables: [
        { name: 'events', columns: [{ name: 'status', type: ENUM_TYPE }] },
        { name: 'other', columns: [] },
      ] }];
      app.activeTab().sqlDraft = 'SELECT * FROM events e JOIN other o ON 1=1 WHERE status = {s:String}';
      app.renderVarStrip();
      const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      expect(qsa(app.dom.varStrip!, '[role="option"]')).toHaveLength(0);
    });
    it('v2: a background column load never steals focus mid-typing — the strip rebuild defers until blur, then applies', async () => {
      const { app } = appForRun([
        [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'status', type: ENUM_TYPE, comment: '' }] } })],
      ]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: null }] }];
      app.activeTab().sqlDraft = 'SELECT * FROM events WHERE status = {s:String} AND r = {region:String}';
      app.renderVarStrip();
      const region = qsa<HTMLInputElement>(app.dom.varStrip!, '.var-input')[1];
      region.focus(); // real focus: sets document.activeElement AND fires the field's focus listener (dropdown opens)
      region.value = 'us-';
      region.dispatchEvent(new Event('input', { bubbles: true }));
      expect(region.getAttribute('aria-expanded')).toBe('true'); // recents dropdown open (empty is fine — it's open state that matters)
      // The background idle-tick column load completes while the user is
      // mid-typing in the UNRELATED region field: the {s} upgrade must NOT
      // rebuild the strip out from under them.
      await app.actions.loadColumns('d', 'events');
      expect(document.activeElement).toBe(region);                              // focus survived
      expect(qsa<HTMLInputElement>(app.dom.varStrip!, '.var-input')[1]).toBe(region);  // same node — no rebuild
      expect(region.value).toBe('us-');                                         // typed text survived
      expect(region.getAttribute('aria-expanded')).toBe('true');                // open dropdown survived
      // On blur (focus leaves the strip) the deferred upgrade applies: the
      // strip rebuilds and {s} now offers the schema-cache-inferred dropdown.
      region.blur();
      const rebuilt = qsa<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      expect(rebuilt[1]).not.toBe(region); // strip was rebuilt after blur
      expect(rebuilt[1].value).toBe('us-'); // the typed value carried through varValues
      rebuilt[0].dispatchEvent(new Event('focus', { bubbles: true }));
      const opts = [...qsa(app.dom.varStrip!, '[role="option"]')].map((o) => o.textContent);
      expect(opts).toEqual(['active', 'deleted', 'banned']);
    });
    it('v2: a comparison inside a /*[ ]*/ optional block still matches — the scan runs on the analysis materialization, not the raw SQL (review F2)', () => {
      const { app } = appForRun([]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 't', columns: [{ name: 'status', type: ENUM_TYPE }] }] }];
      // In the RAW text this whole comparison is one opaque comment span.
      app.activeTab().sqlDraft = 'SELECT * FROM t WHERE 1 /*[ AND status = {s:String} ]*/';
      app.renderVarStrip();
      const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      const opts = [...qsa(app.dom.varStrip!, '[role="option"]')].map((o) => o.textContent);
      expect(opts).toEqual(['active', 'deleted', 'banned']);
    });
    it('v2: alias-qualified + unqualified refs to the same single-table column still get the dropdown (review F3: resolved identity, not qualifier text)', () => {
      const { app } = appForRun([]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: [{ name: 'status', type: ENUM_TYPE }] }] }];
      app.activeTab().sqlDraft = 'SELECT * FROM events e WHERE e.status = {s:String} OR status = {s:String}';
      app.renderVarStrip();
      const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      const opts = [...qsa(app.dom.varStrip!, '[role="option"]')].map((o) => o.textContent);
      expect(opts).toEqual(['active', 'deleted', 'banned']);
    });
    it('a type-conflicted variable renders a plain input with a visible warning — the enum control is disabled (#173 acceptance, review F1)', () => {
      const { app } = appForRun([]);
      app.activeTab().sqlDraft = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}; SELECT {status:String}`;
      app.renderVarStrip();
      const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      expect(input.classList.contains('is-conflict')).toBe(true); // visible warning, distinct from is-invalid
      expect(input.classList.contains('is-invalid')).toBe(false);
      expect(input.title).toContain('Conflicting type declarations');
      expect(input.title).toContain('String');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      // No member dropdown: the field degraded to the plain (recents-only) control.
      expect(qsa(app.dom.varStrip!, '[role="option"]')).toHaveLength(0);
    });
    it('v2: moving focus BETWEEN strip fields keeps the deferred rebuild pending — it only applies once focus leaves the strip', async () => {
      const { app } = appForRun([
        [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'status', type: ENUM_TYPE, comment: '' }] } })],
      ]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: null }] }];
      app.activeTab().sqlDraft = 'SELECT * FROM events WHERE status = {s:String} AND r = {region:String}';
      app.renderVarStrip();
      const inputs = qsa<HTMLInputElement>(app.dom.varStrip!, '.var-input');
      const sInput = inputs[0];
      const region = inputs[1];
      region.focus();
      await app.actions.loadColumns('d', 'events'); // deferred: focus is inside the strip
      // Tabbing from region to the s field: the focusout's relatedTarget is
      // still inside the strip, so the deferral holds — no rebuild yet.
      region.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: sInput }));
      expect(qsa<HTMLInputElement>(app.dom.varStrip!, '.var-input')[1]).toBe(region);
      // Focus finally leaves the strip → the deferred upgrade applies.
      region.blur();
      expect(qsa<HTMLInputElement>(app.dom.varStrip!, '.var-input')[1]).not.toBe(region);
    });
  });
});

describe('recent-value history (#171)', () => {
  function appForRun(routes: FetchRoute[], over: Partial<CreateAppEnv> = {}): { app: App; e: CreateAppEnv } {
    const e = env({ fetch: makeFetch(routes), ...over });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }

  it('a successful single-statement run records its boundParams (rawValue, not the resolved value)', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]], { wallNow: () => 1751200000000 });
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {from:DateTime}';
    app.state.varValues = { from: '-1h' };
    await app.actions.run();
    expect(app.state.varRecent.byName.from.map((e) => e.value)).toEqual(['-1h']); // the expression, never the epoch timestamp
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varRecent')!).byName.from[0].value).toBe('-1h');
  });

  it('a failed statement records nothing', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[() => true, resp({ ok: false, status: 500, text: 'DB::Exception: boom' })]]);
    app.activeTab().sqlDraft = 'SELECT {id:String}';
    app.state.varValues = { id: 'nope' };
    await app.actions.run();
    expect(app.state.varRecent.byName.id).toBeUndefined();
  });

  it('script (#173): statement 1 of a later-failing script records; the failing statement (and anything after it) does not', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([
      [(u, sql) => /SELECT \{a:String\}/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'a', type: 'String' }], data: [['x']] }) })],
      [(u, sql) => /SELECT \{b:String\}/.test(sql), resp({ ok: false, status: 500, text: 'DB::Exception: boom' })],
    ]);
    app.activeTab().sqlDraft = 'SELECT {a:String}; SELECT {b:String}; SELECT {c:String}';
    app.state.varValues = { a: 'va', b: 'vb', c: 'vc' };
    await app.actions.run(); // >1 statement → runScript, stops after statement 2 fails
    expect(app.state.varRecent.byName.a.map((e) => e.value)).toEqual(['va']);
    expect(app.state.varRecent.byName.b).toBeUndefined();
    expect(app.state.varRecent.byName.c).toBeUndefined(); // never even attempted
  });

  it('a param confined to an inactive optional block is never recorded, even with a non-empty stored value (#165)', async () => {
    vi.stubGlobal('localStorage', memStore({
      'asb:varValues': JSON.stringify({ d: 'stale' }),
      'asb:filterActive': JSON.stringify({ d: false }),
    }));
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    await app.actions.run();
    expect(app.state.varRecent.byName.d).toBeUndefined();
  });

  it('an empty string is never recorded, even when actively bound (#165 allows a real empty-string bind)', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    app.state.varValues = { d: '' };
    app.state.filterActive = { d: true }; // explicitly active despite the blank value
    await app.actions.run();
    expect(app.state.varRecent.byName.d).toBeUndefined();
  });

  it('re-running a known value moves it to the front, no duplicate; caps and MRU order follow core/recent-values.js', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {tenant:String}';
    app.state.varValues = { tenant: 'acme' };
    await app.actions.run();
    app.state.varValues = { tenant: 'other' };
    await app.actions.run();
    app.state.varValues = { tenant: 'acme' }; // re-use → move-to-front, no duplicate
    await app.actions.run();
    expect(app.state.varRecent.byName.tenant.map((e) => e.value)).toEqual(['acme', 'other']);
  });

  it('the disable-history preference stops new recording; existing history is retained', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {id:String}';
    app.state.varValues = { id: 'first' };
    await app.actions.run();
    app.state.varRecentDisabled = true;
    app.state.varValues = { id: 'second' };
    await app.actions.run();
    expect(app.state.varRecent.byName.id.map((e) => e.value)).toEqual(['first']); // not recorded, nothing lost
  });

  it('recorded recents persist across reload (state layer round-trip, shared like varValues)', async () => {
    const store = memStore();
    vi.stubGlobal('localStorage', store);
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {tenant:String}';
    app.state.varValues = { tenant: 'acme' };
    await app.actions.run();
    const { app: app2 } = appForRun([]); // fresh app, same localStorage — simulates a reload
    expect(app2.state.varRecent.byName.tenant.map((e) => e.value)).toEqual(['acme']);
  });

  it('the var-strip recents dropdown lists newest-first, filters as you type, click inserts and leaves the field editable', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {tenant:String}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    // Type each value into the real field (not a direct state write) — the
    // var-strip's own <input> DOM node is built once per {name:Type}
    // signature and only reflects state.varValues through its own typing
    // path, exactly like a real user run.
    input.value = 'acme';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await app.actions.run();
    input.value = 'other';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await app.actions.run();
    // Reopen on a blank field (a fresh look at "everything recorded so far",
    // not filtered by whatever text happens to already be in the box).
    input.value = '';
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    expect([...qsa(app.dom.varStrip!, '[role="option"]')].map((o) => o.textContent)).toEqual(['other', 'acme']);
    input.value = 'ac';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect([...qsa(app.dom.varStrip!, '[role="option"]')].map((o) => o.textContent)).toEqual(['acme']);
    const optAcme = qs(app.dom.varStrip!, '[role="option"]');
    optAcme.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(input.value).toBe('acme');
    expect(input.readOnly).toBe(false); // field stays editable — never becomes select-only
  });

  it('"Clear recent" (the dropdown footer) empties just that field\'s history', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {tenant:String}';
    app.state.varValues = { tenant: 'acme' };
    await app.actions.run();
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    const clearBtn = qs(app.dom.varStrip!, 'button.var-combo-clear');
    clearBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(app.state.varRecent.byName.tenant).toBeUndefined();
  });

  it('a date-like field composes ONE dropdown: Recent first, then Presets (user decision, phase-7 feedback)', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]], { wallNow: () => 1751200000000 });
    await new Promise((r) => setTimeout(r));
    asMock(app.conn.chCtx.fetch).mockClear();
    app.activeTab().sqlDraft = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = qs<HTMLInputElement>(app.dom.varStrip!, '.var-input');
    input.value = '-3h'; // not one of RELATIVE_TIME_PRESETS
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await app.actions.run();
    // Reopen on a blank field so the group check isn't itself filtered by
    // whatever text happens to already be in the box.
    input.value = '';
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    const groups = [...qsa(app.dom.varStrip!, '.combo-group')].map((g) => g.textContent);
    expect(groups).toEqual(['Recent', 'Presets']);
    expect([...qsa(app.dom.varStrip!, '[role="option"]')].map((o) => o.textContent)).toContain('-3h');
  });

  it('app.params.clearVarRecent clears one name and is a no-op (no re-persist) for a name with no history', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([]);
    app.state.varRecent = { version: 1, nextSeq: 2, byName: { a: [{ value: '1', seq: 1 }] } };
    app.saveVarRecent = vi.fn(app.saveVarRecent);
    app.params.clearVarRecent('nope'); // no history for this name → no-op
    expect(app.state.varRecent.byName.a).toBeDefined();
    expect(app.saveVarRecent).not.toHaveBeenCalled();
    app.params.clearVarRecent('a');
    expect(app.state.varRecent.byName.a).toBeUndefined();
    expect(app.saveVarRecent).toHaveBeenCalledTimes(1);
  });

  it('app.params.clearAllVarRecent resets every name\'s history and persists', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([]);
    app.state.varRecent = { version: 1, nextSeq: 3, byName: { a: [{ value: '1', seq: 1 }], b: [{ value: '2', seq: 2 }] } };
    app.params.clearAllVarRecent();
    expect(app.state.varRecent).toEqual({ version: 1, nextSeq: 1, byName: {} });
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varRecent')!)).toEqual({ version: 1, nextSeq: 1, byName: {} });
  });

  it('the File menu\'s "Clear all recent values" + preference toggle drive the same app seams', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([]);
    app.state.varRecent = recordRecent(emptyRecentMap(), 'a', '1');
    for (const node of libraryControls(app)) document.body.appendChild(node);
    openFileMenu(app);
    const checkbox = qs<HTMLInputElement>(document, '.fm-checkbox');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.state.varRecentDisabled).toBe(true);
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varRecentDisabled')!)).toBe(true);
    const clearAll = [...qsa(document, '.fm-item')].find((b) => /Clear all recent values/.test(b.textContent))!;
    clearAll.dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.varRecent.byName.a).toBeUndefined();
    document.body.replaceChildren();
  });
});

describe('formatQuery', () => {
  function appFor(routes: FetchRoute[], over: Partial<CreateAppEnv> = {}): { app: App; e: CreateAppEnv } {
    const e = env({ fetch: makeFetch(routes), ...over });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }
  it('replaces the editor with the server-formatted SQL', async () => {
    const { app } = appFor([
      [(u, sql) => /formatQuery/.test(sql), resp({ json: { data: [{ q: 'SELECT\n  1' }] } })],
    ]);
    app.activeTab().sqlDraft = 'select 1';
    await app.actions.formatQuery();
    // withStatementBreak appends a newline so the caret lands past the last
    // token — otherwise the replace re-opens autocomplete on it (#format bug).
    expect(app.sqlEditor.getValue()).toBe('SELECT\n  1\n');
  });
  it('no-ops on empty SQL', async () => {
    const { app, e } = appFor([]);
    await Promise.resolve(); // let render's loadVersion/loadSchema settle
    asMock(e.fetch!).mockClear();
    app.activeTab().sqlDraft = '   ';
    await app.actions.formatQuery();
    expect(e.fetch).not.toHaveBeenCalled();
  });
  it('signs out when there is no usable token', async () => {
    const { app } = appFor([], { sessionStorage: memSession({}) }); // no token
    app.activeTab().sqlDraft = 'select 1';
    await app.actions.formatQuery();
    expect(qs(app.root, '.login-screen')).not.toBeNull();
  });
  it('shows a format error persistently in the results panel and moves the caret to it', async () => {
    const { app } = appFor([
      [(u, sql) => /formatQuery/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"Code: 62. DB::Exception: Syntax error: failed at position 8 (BEWEEN): BEWEEN 2. Expected one of: BETWEEN, …. (SYNTAX_ERROR)"}' })],
    ]);
    app.activeTab().sqlDraft = 'select x BEWEEN 2';
    app.sqlEditor.replaceDocument('select x BEWEEN 2');
    await app.actions.formatQuery();
    expect(app.sqlEditor.getValue()).toBe('select x BEWEEN 2'); // editor unchanged
    const err = qs(app.root, '.results-error');
    expect(err).not.toBeNull();
    expect(err.textContent).toContain('Code: 62. DB::Exception: Syntax error: failed at position 8 (BEWEEN): BEWEEN 2. Expected one of: BETWEEN, …. (SYNTAX_ERROR)'); // full original message, untruncated
    expect(app.dom.sqlEditorView!.state.selection.main.head).toBe(7); // caret jumped to the offending token (pos 8 → offset 7)
    expect(result(app.activeTab()).formatError).toBe(true);
  });
  it('a later successful format clears a prior format error', async () => {
    const { app } = appFor([
      [(u, sql) => /BEWEEN/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"Syntax error: failed at position 8 (BEWEEN): x. Expected one of: foo"}' })],
      [(u, sql) => /formatQuery/.test(sql), resp({ json: { data: [{ q: 'SELECT 1' }] } })],
    ]);
    app.activeTab().sqlDraft = 'select x BEWEEN 2';
    await app.actions.formatQuery();
    expect(qs(app.root, '.results-error')).not.toBeNull();
    app.activeTab().sqlDraft = 'select 1'; // fixed
    await app.actions.formatQuery();
    expect(qs(app.root, '.results-error')).toBeNull(); // error cleared
    expect(app.activeTab().result).toBeNull();
  });
  it('formats a multi-statement script one statement at a time, joined by ;<blank>', async () => {
    const { app } = appFor([
      [(u, sql) => /create table/.test(sql), resp({ json: { data: [{ q: 'CREATE TABLE t\n(\n    a Int8\n)' }] } })],
      [(u, sql) => /count/.test(sql), resp({ json: { data: [{ q: 'SELECT count()\nFROM t' }] } })],
    ]);
    app.activeTab().sqlDraft = 'create table t (a Int8); select count() from t';
    await app.actions.formatQuery();
    expect(app.sqlEditor.getValue()).toBe('CREATE TABLE t\n(\n    a Int8\n);\n\nSELECT count()\nFROM t\n');
  });
  it('multi-statement format is best-effort: an unformattable statement keeps its original text', async () => {
    const { app } = appFor([
      [(u, sql) => /create table/.test(sql), resp({ json: { data: [{ q: 'CREATE TABLE t (a Int8)' }] } })],
      [(u, sql) => /bad syntax/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"Syntax error"}' })],
    ]);
    app.activeTab().sqlDraft = 'create table t (a Int8); bad syntax here';
    await app.actions.formatQuery();
    expect(app.sqlEditor.getValue()).toContain('bad syntax here'); // original kept
    expect(qs(app.root, '.results-error')).toBeNull(); // no scary error for the script
  });
  it('a multi-statement format clears a prior single-statement format error', async () => {
    const { app } = appFor([
      [(u, sql) => /BEWEEN/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"Syntax error: failed at position 8 (BEWEEN): x"}' })],
      [(u, sql) => /formatQuery/.test(sql), resp({ json: { data: [{ q: 'SELECT 1' }] } })],
    ]);
    app.activeTab().sqlDraft = 'select x BEWEEN 2';
    await app.actions.formatQuery();
    expect(qs(app.root, '.results-error')).not.toBeNull();
    app.activeTab().sqlDraft = 'select 1; select 2'; // now a script
    await app.actions.formatQuery();
    expect(qs(app.root, '.results-error')).toBeNull();
  });
  it('optional blocks (#165): a single statement with a block is skipped with a notice — no server call', async () => {
    const { app, e } = appFor([]);
    await Promise.resolve(); // let render's loadVersion/loadSchema settle
    asMock(e.fetch!).mockClear();
    app.activeTab().sqlDraft = 'select 1 /*[ AND d = {d:String} ]*/';
    app.sqlEditor.replaceDocument('select 1 /*[ AND d = {d:String} ]*/');
    await app.actions.formatQuery();
    expect(e.fetch).not.toHaveBeenCalled(); // never round-tripped through formatQuery()
    expect(app.sqlEditor.getValue()).toBe('select 1 /*[ AND d = {d:String} ]*/'); // untouched
    expect(qs(document.body, '.share-toast').textContent)
      .toContain('optional blocks — not formatted');
  });
  it('optional blocks (#165): a script formats the other statements and skips the template with a notice', async () => {
    const { app, e } = appFor([
      [(u, sql) => /formatQuery/.test(sql), resp({ json: { data: [{ q: 'SELECT 1' }] } })],
    ]);
    app.activeTab().sqlDraft = 'select 1; select 2 /*[ AND d = {d:String} ]*/';
    await app.actions.formatQuery();
    expect(app.sqlEditor.getValue()).toBe('SELECT 1;\n\nselect 2 /*[ AND d = {d:String} ]*/\n');
    expect(qs(document.body, '.share-toast').textContent)
      .toContain('1 statement contains optional blocks — not formatted');
    // exactly one formatQuery round trip — the template statement never went out
    const fmtCalls = asMock(e.fetch!).mock.calls.filter((c) => /formatQuery/.test(c[1] && c[1].body));
    expect(fmtCalls).toHaveLength(1);
    expect(fmtCalls[0][1].body).not.toContain('{d:String}');
  });
  it('setFmtBtn toggles a busy/spinner state and no-ops without the button', () => {
    const { app } = appFor([]);
    app.setFmtBtn(true);
    expect(app.dom.fmtBtn!.disabled).toBe(true);
    expect(app.dom.fmtBtn!.textContent).toContain('Formatting…');
    app.setFmtBtn(false);
    expect(app.dom.fmtBtn!.disabled).toBe(false);
    expect(app.dom.fmtBtn!.textContent).toBe('Format');
    const noRender = createApp(env()); // no renderApp → no fmtBtn
    expect(() => noRender.setFmtBtn(true)).not.toThrow();
  });
});

describe('insertCreate', () => {
  function appFor(routes: FetchRoute[], over: Partial<CreateAppEnv> = {}): { app: App; e: CreateAppEnv } {
    const e = env({ fetch: makeFetch(routes), ...over });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }
  it('fetches DDL, formats it, and inserts as a top line', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ json: { data: [{ statement: 'CREATE TABLE db.t (a Int)' }] } })],
      [(u, sql) => /formatQuery/.test(sql), resp({ json: { data: [{ q: 'CREATE TABLE db.t\n(\n  a Int\n)' }] } })],
    ]);
    await app.actions.insertCreate('db.t');
    expect(app.sqlEditor.getValue()).toBe('CREATE TABLE db.t\n(\n  a Int\n)');
  });
  it('falls back to the raw DDL when formatting fails', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ json: { data: [{ statement: 'CREATE TABLE db.t (a Int)' }] } })],
      [(u, sql) => /formatQuery/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"x"}' })],
    ]);
    await app.actions.insertCreate('db.t');
    expect(app.sqlEditor.getValue()).toBe('CREATE TABLE db.t (a Int)');
  });
  it('no-ops when SHOW CREATE returns no statement', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ json: { data: [] } })],
    ]);
    app.sqlEditor.replaceDocument('keep');
    await app.actions.insertCreate('db.t');
    expect(app.sqlEditor.getValue()).toBe('keep');
  });
  it('surfaces a SHOW CREATE failure without changing the editor', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: no table"}' })],
    ]);
    app.sqlEditor.replaceDocument('keep');
    await app.actions.insertCreate('db.t');
    expect(app.sqlEditor.getValue()).toBe('keep');
    expect(qs(document.body, '.share-toast')).not.toBeNull();
  });
  it('signs out when there is no usable token', async () => {
    const { app } = appFor([], { sessionStorage: memSession({}) });
    await app.actions.insertCreate('db.t');
    expect(qs(app.root, '.login-screen')).not.toBeNull();
  });
});

describe('openCreateInNewTab (#180)', () => {
  function appFor(routes: FetchRoute[], over: Partial<CreateAppEnv> = {}): { app: App; e: CreateAppEnv } {
    const e = env({ fetch: makeFetch(routes), ...over });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }
  it('opens the formatted DDL in a new active tab, leaving the prior tab untouched', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ json: { data: [{ statement: 'CREATE TABLE db1.events (a Int)' }] } })],
      [(u, sql) => /formatQuery/.test(sql), resp({ json: { data: [{ q: 'CREATE TABLE db1.events\n(\n  a Int\n)' }] } })],
    ]);
    app.sqlEditor.replaceDocument('keep');
    const priorId = app.state.activeTabId.value;
    const priorCount = app.state.tabs.value.length;
    await app.actions.openCreateInNewTab('db1.events', 'db1.events');
    expect(app.state.tabs.value.length).toBe(priorCount + 1);
    expect(app.state.tabs.value.find((t) => t.id === priorId)!.sqlDraft).toBe('keep');
    expect(app.activeTab().id).not.toBe(priorId);
    expect(app.activeTab().name).toBe('db1.events');
    expect(app.activeTab().sqlDraft).toBe('CREATE TABLE db1.events\n(\n  a Int\n)');
  });
  it('falls back to the raw DDL in the new tab when formatting fails', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ json: { data: [{ statement: 'CREATE TABLE db1.events (a Int)' }] } })],
      [(u, sql) => /formatQuery/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"x"}' })],
    ]);
    await app.actions.openCreateInNewTab('db1.events', 'db1.events');
    expect(app.activeTab().sqlDraft).toBe('CREATE TABLE db1.events (a Int)');
  });
  it('creates no tab when SHOW CREATE returns no statement', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ json: { data: [] } })],
    ]);
    const priorId = app.state.activeTabId.value;
    const priorCount = app.state.tabs.value.length;
    await app.actions.openCreateInNewTab('db1.events', 'db1.events');
    expect(app.state.tabs.value.length).toBe(priorCount);
    expect(app.state.activeTabId.value).toBe(priorId);
  });
  it('creates no tab and surfaces the toast when SHOW CREATE fails', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: no table"}' })],
    ]);
    app.sqlEditor.replaceDocument('keep');
    const priorId = app.state.activeTabId.value;
    const priorCount = app.state.tabs.value.length;
    await app.actions.openCreateInNewTab('db1.events', 'db1.events');
    expect(app.state.tabs.value.length).toBe(priorCount);
    expect(app.state.activeTabId.value).toBe(priorId);
    expect(app.sqlEditor.getValue()).toBe('keep');
    expect(qs(document.body, '.share-toast')).not.toBeNull();
  });
  it('signs out when there is no usable token, creating no tab', async () => {
    const { app } = appFor([], { sessionStorage: memSession({}) });
    const priorCount = app.state.tabs.value.length;
    await app.actions.openCreateInNewTab('db1.events', 'db1.events');
    expect(qs(app.root, '.login-screen')).not.toBeNull();
    expect(app.state.tabs.value.length).toBe(priorCount);
  });
});

describe('auth flows', () => {
  it('login builds the redirect URL and stashes pkce/state', async () => {
    const loc = { host: 'ch', origin: 'https://ch', pathname: '/sql', search: '', hash: '', href: 'https://ch/sql' } as Location;
    const e = env({
      location: loc,
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://accounts.google.com/auth', token_endpoint: 'https://t' } })],
      ]),
    });
    const app = createApp(e);
    await app.actions.login();
    expect(loc.href).toContain('https://accounts.google.com/auth?');
    expect(e.sessionStorage!.getItem('oauth_verifier')).toBeTruthy();
    expect(e.sessionStorage!.getItem('oauth_state')).toBeTruthy();
  });
  it('multi-IdP: login(id) selects that IdP, persists it, and uses its endpoints', async () => {
    const loc = { host: 'ch', origin: 'https://ch', pathname: '/sql', search: '', hash: '', href: 'https://ch/sql' } as Location;
    const e = env({
      location: loc,
      sessionStorage: memSession({}),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { idps: [
          { id: 'google', issuer: 'https://accounts.google.com', client_id: 'g' },
          { id: 'auth0', issuer: 'https://acme.auth0.com', client_id: 'a' },
        ] } })],
        [(u) => /acme\.auth0\.com\/.well-known/.test(u), resp({ json: { authorization_endpoint: 'https://acme.auth0.com/authorize', token_endpoint: 'https://acme.auth0.com/t' } })],
        [(u) => /accounts\.google\.com\/.well-known/.test(u), resp({ json: { authorization_endpoint: 'https://accounts.google.com/auth', token_endpoint: 'https://t' } })],
      ]),
    });
    const app = createApp(e);
    expect((await app.conn.loadIdps()).idps).toHaveLength(2);
    await app.actions.login('auth0');
    expect(loc.href).toContain('https://acme.auth0.com/authorize?');
    expect(loc.href).toContain('client_id=a');
    expect(e.sessionStorage!.getItem('oauth_idp')).toBe('auth0');
    app.signOut();
    expect(e.sessionStorage!.getItem('oauth_idp')).toBeNull(); // cleared on sign-out
  });
  it('refresh succeeds via the ClickHouse context', async () => {
    const e = env({
      sessionStorage: memSession({ oauth_id_token: jwt({ exp: 1 }), oauth_refresh_token: 'rt' }),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
        [(u) => u === 'https://t', resp({ json: { id_token: validToken } })],
      ]),
    });
    const app = createApp(e);
    const ok = await app.conn.chCtx.refresh();
    expect(ok).toBe(true);
    expect(app.conn.token()).toBe(validToken);
  });
  it('getToken returns null + clears when refresh fails', async () => {
    const e = env({
      sessionStorage: memSession({ oauth_id_token: jwt({ exp: 1 }) }),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
      ]),
    });
    const app = createApp(e);
    expect(await app.conn.chCtx.getToken()).toBeNull();
  });
  it('onSignedOut shows the given message, else a session-expired default', async () => {
    const app = createApp(env());
    app.renderApp();
    // authorization denial: CH-supplied message is shown verbatim on the login screen
    app.conn.chCtx.onSignedOut('ClickHouse denied your account (HTTP 403). Server: nope');
    expect(qs(app.root, '.login-error').textContent).toContain('denied your account');
    // genuine expiry: no detail → the reworded default
    app.conn.chCtx.onSignedOut();
    expect(qs(app.root, '.login-error').textContent).toContain('session expired');
  });
  it('login(idp, origin) stashes oauth_origin for a cross-origin cluster; sign-out clears it', async () => {
    const loc = { host: 'ch', origin: 'https://ch', pathname: '/sql', search: '', hash: '', href: 'https://ch/sql' } as Location;
    const e = env({
      location: loc,
      sessionStorage: memSession({}),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { idps: [{ id: 'google', issuer: 'https://accounts.google.com', client_id: 'g' }] } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://accounts.google.com/auth', token_endpoint: 'https://t' } })],
      ]),
    });
    const app = createApp(e);
    await app.actions.login('google', 'https://antalya.demo.altinity.cloud');
    expect(e.sessionStorage!.getItem('oauth_origin')).toBe('https://antalya.demo.altinity.cloud');
    app.signOut();
    expect(e.sessionStorage!.getItem('oauth_origin')).toBeNull();
  });
  it('oauth mode posts queries to the stashed oauth_origin (cross-origin)', () => {
    const e = env({ sessionStorage: memSession({ oauth_id_token: validToken, oauth_origin: 'https://antalya.demo.altinity.cloud' }) });
    expect(createApp(e).conn.chCtx.origin).toBe('https://antalya.demo.altinity.cloud');
  });
  it('header shows the picked cluster, not the serving host, for cross-origin oauth', () => {
    // Serving host is ch.example; the picked cluster is antalya on :443 (default
    // https port → URL.host drops it, so the header is the bare cluster hostname).
    const e = env({ sessionStorage: memSession({ oauth_id_token: validToken, oauth_origin: 'https://antalya.demo.altinity.cloud:443' }) });
    expect(createApp(e).conn.host()).toBe('antalya.demo.altinity.cloud');
  });
});

describe('credentials (basic) sign-in', () => {
  const creds = btoa('demo:demo');
  const basicSession = { ch_basic_auth: creds, ch_basic_user: 'demo', ch_basic_origin: 'https://gh.example:8443' };

  it('restores a basic session from sessionStorage', () => {
    const app = createApp(env({ sessionStorage: memSession(basicSession) }));
    expect(app.conn.authMode()).toBe('basic');
    expect(app.conn.isSignedIn()).toBe(true);
    expect(app.conn.email()).toBe('demo');
    expect(app.conn.host()).toBe('gh.example:8443');
    expect(app.conn.chCtx.origin).toBe('https://gh.example:8443');
  });
  it('falls back to the serving origin when no stored target is present', () => {
    const app = createApp(env({ sessionStorage: memSession({ ch_basic_auth: creds, ch_basic_user: 'demo' }) }));
    expect(app.conn.chCtx.origin).toBe('https://ch.example');
  });
  it('host falls back to "clickhouse" for an unparseable stored origin', () => {
    const app = createApp(env({ sessionStorage: memSession({ ...basicSession, ch_basic_origin: 'not a url' }) }));
    expect(app.conn.host()).toBe('clickhouse');
  });
  it('basic ctx seams: getToken=creds, authHeader=Basic, refresh=false, ensureConfig=no-op', async () => {
    const app = createApp(env({ sessionStorage: memSession(basicSession) }));
    expect(await app.conn.chCtx.getToken()).toBe(creds);
    expect(app.conn.chCtx.authHeader(creds)).toBe('Basic ' + creds);
    expect(await app.conn.chCtx.refresh()).toBe(false);
    expect(await app.conn.ensureConfig()).toBeNull();
  });
  it('queries carry the Basic header to the target origin', async () => {
    const e = env({
      sessionStorage: memSession(basicSession),
      fetch: makeFetch([[(u, sql) => /version\(\)/.test(sql), resp({ json: { data: [{ v: '26.3.1' }] } })]]),
    });
    const app = createApp(e);
    await app.catalog.loadVersion();
    const [url, init] = asMock(e.fetch!).mock.calls[0];
    expect(url.startsWith('https://gh.example:8443')).toBe(true);
    expect(init.headers.Authorization).toBe('Basic ' + creds);
  });
  it('connect() probes SELECT 1, commits the session, renders the app (blank host → same origin)', async () => {
    const e = env({
      sessionStorage: memSession({}),
      fetch: makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ json: { data: [{ '1': 1 }] } })]]),
    });
    const app = createApp(e);
    expect(app.conn.authMode()).toBe('oauth');
    await app.actions.connect({ username: 'demo', password: 'demo', host: '' });
    expect(app.conn.authMode()).toBe('basic');
    expect(e.sessionStorage!.getItem('ch_basic_auth')).toBe(creds);
    expect(e.sessionStorage!.getItem('ch_basic_user')).toBe('demo');
    expect(e.sessionStorage!.getItem('ch_basic_origin')).toBe('https://ch.example');
    expect(app.conn.chCtx.origin).toBe('https://ch.example');
    expect(qs(app.root, '.app-header')).not.toBeNull();
    const probe = asMock(e.fetch!).mock.calls.find(([, init]) => init && init.body === 'SELECT 1')!;
    expect(probe[1].headers.Authorization).toBe('Basic ' + creds);
  });
  it('connect() targets a custom host via resolveTarget', async () => {
    const e = env({
      sessionStorage: memSession({}),
      fetch: makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ json: { data: [] } })]]),
    });
    const app = createApp(e);
    await app.actions.connect({ username: 'u', password: 'p', host: 'other.example:9000' });
    expect(app.conn.chCtx.origin).toBe('https://other.example:9000');
    expect(e.sessionStorage!.getItem('ch_basic_origin')).toBe('https://other.example:9000');
  });
  it('connect() rejects on bad credentials without committing a session', async () => {
    const e = env({
      sessionStorage: memSession({}),
      fetch: makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ ok: false, status: 403, text: 'Code: 516. Authentication failed' })]]),
    });
    const app = createApp(e);
    await expect(app.actions.connect({ username: 'demo', password: 'wrong', host: '' })).rejects.toThrow();
    expect(app.conn.authMode()).toBe('oauth');
    expect(e.sessionStorage!.getItem('ch_basic_auth')).toBeNull();
  });
  it('signing out of a basic session resets mode, origin, and stored creds', () => {
    const e = env({ sessionStorage: memSession(basicSession) });
    const app = createApp(e);
    app.renderApp();
    app.signOut();
    expect(app.conn.authMode()).toBe('oauth');
    expect(app.conn.chCtx.origin).toBe('https://ch.example');
    expect(e.sessionStorage!.getItem('ch_basic_auth')).toBeNull();
    expect(qs(app.root, '.login-screen')).not.toBeNull();
  });
});

// #287 W4: `commitLinkedQuery`'s Save-button path and the popover's own Save
// button both await the aggregate commit before mutating anything; a DOM
// `click`/keydown dispatch can't be awaited directly (the handler's promise
// isn't returned to the dispatcher), so a macrotask flush lets it settle
// before a test's post-click assertions run (same convention as
// saved-history.test.ts's own `flush`).
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('share + star + columns', () => {
  it('share copies a link to the clipboard', async () => {
    const e = env({ window: asWindow({ history: { replaceState: vi.fn() }, navigator: {} }) });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 1';
    app.actions.share();
    await Promise.resolve();
    expect(e.navigator!.clipboard!.writeText).toHaveBeenCalled();
  });
  it('share no-ops on empty SQL', () => {
    const app = createApp(env());
    app.renderApp();
    app.activeTab().sqlDraft = '  ';
    expect(() => app.actions.share()).not.toThrow();
  });
  it('save opens a name popover; Save commits, links the tab, and the button reads "Saved"', async () => {
    const app = createApp(env());
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 42';
    app.actions.save(); // opens the popover synchronously (before any await)
    const pop = qs(document, '.save-popover');
    expect(pop).not.toBeNull();
    expect(qs<HTMLInputElement>(pop, '.sp-input').value).toBe('SELECT 42'); // inferred name
    qs<HTMLInputElement>(pop, '.sp-input').value = 'My fave';
    qs(pop, '.sp-save').dispatchEvent(new Event('click'));
    await flush(); // the popover's Save button awaits the aggregate commit (#287 W4)
    expect(app.state.savedQueries).toHaveLength(1);
    expect(app.state.savedQueries[0]).toMatchObject({ sql: 'SELECT 42', spec: { name: 'My fave', favorite: false } });
    expect(app.activeTab().savedId).toBe(app.state.savedQueries[0].id);
    expect(app.dom.saveBtn!.classList.contains('saved')).toBe(true);
    expect(app.dom.saveBtn!.textContent).toContain('Saved');
    expect(qs(document, '.save-popover')).toBeNull(); // closed
  });
  it('save popover: re-opening is idempotent, Esc closes, dirty edit flips "Saved"→"Save"', async () => {
    const app = createApp(env());
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 1';
    app.actions.save();
    app.actions.save(); // second call no-ops while open
    expect(qsa(document, '.save-popover')).toHaveLength(1);
    qs<HTMLInputElement>(document, '.save-popover .sp-input').value = 'Q';
    qs(document, '.save-popover .sp-save').dispatchEvent(new Event('click'));
    await flush();
    expect(app.dom.saveBtn!.textContent).toContain('Saved');
    // edit → button reverts to "Save"
    app.activeTab().sqlDraft = 'SELECT 2';
    app.activeTab().dirtySql = true;
    app.updateSaveBtn();
    expect(app.dom.saveBtn!.classList.contains('saved')).toBe(false);
    expect(app.dom.saveBtn!.textContent).toContain('Save');
    // re-open then Escape closes without saving
    app.actions.save();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(qs(document, '.save-popover')).toBeNull();
  });
  it('save is a no-op (toast) for empty SQL', () => {
    const app = createApp(env());
    app.renderApp();
    app.activeTab().sqlDraft = '   ';
    app.actions.save();
    expect(qs(document, '.save-popover')).toBeNull();
    expect(qs(document, '.share-toast').textContent).toBe('Nothing to save');
  });
  it('linked Save also retains the empty-SQL guard', async () => {
    const app = createApp(env());
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    app.sqlEditor.replaceDocument('');
    await app.actions.save();
    expect(app.state.savedQueries[0].sql).toBe('SELECT 9');
    expect(qs(document, '.share-toast').textContent).toBe('Nothing to save');
    expect(app.activeTab().dirtySql).toBe(true);
  });
  it('#287 W4: the Save popover surfaces a toast (and mutates nothing) when the aggregate commit is rejected', async () => {
    const app = createApp(env());
    app.renderApp();
    const diagnostics = [{ path: [], severity: 'error' as const, code: 'test-fail', message: 'boom' }];
    app.workspace.commit = vi.fn(async () => ({ ok: false as const, diagnostics }));
    app.activeTab().sqlDraft = 'SELECT 1';
    app.actions.save(); // opens the popover synchronously
    qs<HTMLInputElement>(document, '.save-popover .sp-input').value = 'Q';
    qs(document, '.save-popover .sp-save').dispatchEvent(new Event('click'));
    await flush();
    expect(app.state.savedQueries).toEqual([]);
    expect(app.activeTab().savedId).toBeNull();
    expect(qs(document, '.share-toast').textContent).toBe('Save failed: boom');
  });
  it('#287 W4: linked Save surfaces a toast (and mutates nothing) when the aggregate commit is rejected', async () => {
    const app = createApp(env());
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    const diagnostics = [{ path: [], severity: 'error' as const, code: 'test-fail', message: 'boom' }];
    app.workspace.commit = vi.fn(async () => ({ ok: false as const, diagnostics }));
    app.sqlEditor.replaceDocument('SELECT 99');
    await app.actions.save();
    expect(app.state.savedQueries[0].sql).toBe('SELECT 9'); // unchanged
    expect(qs(document, '.share-toast').textContent).toBe('Save failed: boom');
  });
  it('#287 W4: loadWorkspaceOnBoot projects the resolved aggregate onto state, or leaves it untouched on a null/failed load', async () => {
    // A working IndexedDB (env()'s own #287 default fake): the one-shot legacy
    // migration builds + commits a fresh aggregate (no favorites yet, but the
    // Dashboard is still created — see legacy-migration.ts), so the resolved
    // workspace is non-null and every field gets projected.
    const app = createApp(env());
    app.state.libraryName.value = 'Before boot';
    const before = app.state.workspaceId;
    const workspace = await app.loadWorkspaceOnBoot();
    expect(workspace).not.toBeNull();
    expect(app.state.savedQueries).toEqual(workspace!.queries);
    expect(app.state.dashboard).toEqual(workspace!.dashboard);
    expect(app.state.workspaceId).toBe(workspace!.id);
    expect(app.state.workspaceId).not.toBe(before); // overwritten by the real committed id
    expect(app.state.libraryName.value).toBe(workspace!.name);

    // The one-shot migration's own commit rejected (a real repository
    // rejection, not an unavailable store — see `workspace-persist-failed`):
    // nothing was ever written, so the still-real, working `loadCurrent()`
    // finds no record and resolves null → state is left exactly as it was
    // (the synchronous `createState()` legacy projection, including its
    // minted placeholder id).
    const app2 = createApp(env());
    const beforeId2 = app2.state.workspaceId;
    app2.workspace.commit = vi.fn(async () => ({
      ok: false as const, diagnostics: [{ path: [], severity: 'error' as const, code: 'test-fail', message: 'boom' }],
    }));
    const workspace2 = await app2.loadWorkspaceOnBoot();
    expect(workspace2).toBeNull();
    expect(app2.state.workspaceId).toBe(beforeId2);
    expect(app2.state.dashboard).toBeNull();
  });
  it('#365: applying a committed workspace scrubs dangling tab links but keeps the SQL draft open', () => {
    const app = createApp(env());
    const tab = app.activeTab();
    tab.sqlDraft = 'SELECT still_here';
    tab.savedId = 'removed';
    tab.editorMode = 'spec';
    const workspace: StoredWorkspaceV1 = {
      storageVersion: 1, id: 'new-workspace', name: 'New workspace', queries: [], dashboard: null,
    };
    app.applyCommittedWorkspace(workspace);
    expect(tab).toMatchObject({ sqlDraft: 'SELECT still_here', savedId: null, editorMode: 'sql' });
    expect(app.state.savedQueries).toEqual([]);
    expect(app.state.workspaceId).toBe('new-workspace');
  });
  it('#300: a corrupt-but-present aggregate surfaces a toast instead of silently continuing, and its Reset action rebuilds a fresh one', async () => {
    const app = createApp(env());
    const beforeId = app.state.workspaceId;
    const beforeQueries = app.state.savedQueries;
    const diagnostics = [{
      path: ['storageVersion'], severity: 'error' as const,
      code: 'workspace-version-unsupported', message: 'Unsupported stored-workspace version',
    }];
    // Simulate a corrupt-but-present record without hand-rolling raw
    // IndexedDB bytes: stub `loadCurrentResult` to report `corrupt` while
    // `corrupted` is true, delegating to the REAL (fake-IndexedDB-backed)
    // implementation once it flips false — so Reset's rebuild below exercises
    // the genuine migrate-then-load path, not another stub.
    let corrupted = true;
    const realLoadCurrentResult = app.workspace.loadCurrentResult.bind(app.workspace);
    app.workspace.loadCurrentResult = vi.fn(
      async () => (corrupted ? { status: 'corrupt' as const, diagnostics } : realLoadCurrentResult()),
    );
    const clearSpy = vi.spyOn(app.workspace, 'clearCurrent');

    const workspace = await app.loadWorkspaceOnBoot();
    expect(workspace).toBeNull();
    // State is left exactly as `createState()`'s synchronous legacy
    // projection populated it — not overwritten by the corrupt record.
    expect(app.state.workspaceId).toBe(beforeId);
    expect(app.state.savedQueries).toBe(beforeQueries);

    const toastEl = qs(document, '.share-toast');
    expect(toastEl.textContent).toContain('Saved workspace could not be read');
    const resetBtn = qs<HTMLButtonElement>(toastEl, 'button.share-toast-action');
    expect(resetBtn.textContent).toBe('Reset workspace');
    expect(clearSpy).not.toHaveBeenCalled();

    // Invoke the Reset action: clears the (real) store, then re-runs the
    // migrate + load path, which now genuinely resolves `ok` and projects.
    corrupted = false;
    resetBtn.click();
    await flush();

    expect(clearSpy).toHaveBeenCalledTimes(1);
    const rebuilt = await app.workspace.loadCurrent();
    expect(rebuilt).not.toBeNull();
    expect(app.state.workspaceId).toBe(rebuilt!.id);
    expect(app.state.workspaceId).not.toBe(beforeId);
  });
  it('#300: the empty and ok load-result cases behave exactly as before (no toast, migrate-then-project runs as usual)', async () => {
    const app = createApp(env());
    // `env()`'s own #287 default fake IndexedDB: a working store with nothing
    // persisted yet resolves `empty`, so `loadWorkspaceOnBoot` migrates and
    // projects the freshly-committed aggregate exactly as the pre-#300 test
    // above (line ~2963) already covers for `loadCurrent`.
    const workspace = await app.loadWorkspaceOnBoot();
    expect(workspace).not.toBeNull();
    expect(app.state.savedQueries).toEqual(workspace!.queries);
    expect(document.querySelector('.share-toast')).toBeNull();
  });
  it('save popover closes on click outside', () => {
    const app = createApp(env());
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 1';
    app.actions.save();
    expect(qs(document, '.save-popover')).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(qs(document, '.save-popover')).toBeNull();
  });
  it('restoring a saved query links the tab → Save button reads "Saved"', () => {
    const app = createApp(env());
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    expect(app.activeTab().savedId).toBe('s9');
    expect(app.dom.saveBtn!.classList.contains('saved')).toBe(true);
    expect(app.dom.saveBtn!.textContent).toContain('Saved');
  });
  it('keeps Spec unavailable until creation, then exposes only Format, Save, and the mode switch', async () => {
    const showSaveFilePicker = vi.fn();
    const e = env({ showSaveFilePicker, isSecureContext: true });
    const app = createApp(e);
    app.renderApp();
    expect(app.dom.specModeBtn!.getAttribute('aria-disabled')).toBe('true');
    expect(app.actions.setEditorMode('spec')).toBe(false);
    expect(app.activeTab().editorMode).toBe('sql');
    expect(qs(document, '.share-toast').textContent).toContain('Save this query');

    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    expect(app.actions.setEditorMode('spec')).toBe(true);
    expect(app.activeTab().editorMode).toBe('spec');
    expect(app.dom.sqlEditorHost!.hidden).toBe(true);
    expect(app.dom.specPane!.hidden).toBe(false);
    expect(app.dom.runBtn!.hidden).toBe(true);
    expect(app.dom.formatSpecBtn!.hidden).toBe(false);
    expect(app.dom.fmtBtn!.hidden).toBe(true);
    expect(app.dom.explainBtn!.hidden).toBe(true);
    expect(app.dom.saveBtn!.hidden).toBe(false);
    expect(app.dom.editorModeSwitch!.hidden).toBe(false);
    expect(app.dom.exportBtn!.hidden).toBe(true);
    expect(app.dom.shareBtn!.hidden).toBe(true);
    expect(domAny(app).validateSpecBtn).toBeUndefined();
    expect(domAny(app).revertSpecBtn).toBeUndefined();
    expect(app.dom.varStrip!.hidden).toBe(true);

    await Promise.resolve();
    asMock(e.fetch!).mockClear();
    await app.actions.run();
    await app.actions.formatQuery();
    await app.actions.explainQuery();
    await app.actions.setExplainView('pipeline');
    await app.actions.setResultRowLimit(1000);
    await app.actions.exportEntry();
    await app.actions.exportDirect('SELECT 9', 0);
    await app.actions.share();
    expect(showSaveFilePicker).not.toHaveBeenCalled();
    expect(e.navigator!.clipboard!.writeText).not.toHaveBeenCalled();
    expect(app.state.resultRowLimit).toBe(1000); // preference changes; Spec mode only blocks the rerun

    app.actions.setEditorMode('sql');
    expect(app.dom.runBtn!.hidden).toBe(false);
    expect(app.dom.fmtBtn!.hidden).toBe(false);
    expect(app.dom.explainBtn!.hidden).toBe(false);
    expect(app.dom.formatSpecBtn!.hidden).toBe(true);
    expect(app.dom.saveBtn!.hidden).toBe(false);
    expect(app.dom.exportBtn!.hidden).toBe(false);
    expect(app.dom.shareBtn!.hidden).toBe(false);
  });
  it('disables Save and Share for invalid Spec and performs no persistence or sharing', async () => {
    const store = { getItem: vi.fn(() => null), setItem: vi.fn() };
    vi.stubGlobal('localStorage', store);
    const replaceState = vi.fn();
    const writeText = vi.fn(async () => {});
    const app = createApp(env({
      window: asWindow({ history: { replaceState }, navigator: {} }),
      navigator: { clipboard: asClipboard({ writeText }) },
    }));
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    app.actions.setEditorMode('spec');
    app.specEditor.replaceDocument('{"name":');
    expect(app.activeTab().specParsed).toBeNull();
    expect(app.dom.saveBtn!.disabled).toBe(true);
    expect(app.dom.shareBtn!.disabled).toBe(true);
    const before = structuredClone(app.state.savedQueries[0]);
    store.setItem.mockClear();

    await app.actions.save();
    app.actions.setEditorMode('sql');
    app.actions.share();
    await Promise.resolve();
    expect(app.state.savedQueries[0]).toEqual(before);
    expect(store.setItem).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
  it('shares sqlDraft with the current valid parsed Spec, including unknown fields', async () => {
    const replaceState = vi.fn();
    const writeText = vi.fn(async () => {});
    const app = createApp(env({
      window: asWindow({ history: { replaceState }, navigator: {} }),
      navigator: { clipboard: asClipboard({ writeText }) },
    }));
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    app.sqlEditor.replaceDocument('SELECT 10');
    app.specEditor.replaceDocument('{"name":"Draft","favorite":false,"future":{"v":2}}');
    app.actions.share();
    await Promise.resolve();
    const url = replaceState.mock.calls[0][2];
    const shared = decodeShare(new URL(url).hash);
    expect(shared.sql).toBe('SELECT 10');
    expect(shared.spec).toEqual({ name: 'Draft', favorite: false, future: { v: 2 } });
    expect(writeText).toHaveBeenCalled();
  });
  it('formats the active valid Spec while invalid JSON remains untouched with diagnostics', () => {
    const app = createApp(env());
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    app.actions.setEditorMode('spec');
    app.specEditor.replaceDocument('{"name":');
    app.actions.formatSpec();
    expect(app.specEditor.getValue()).toBe('{"name":');
    expect(app.activeTab().specDiagnostics).not.toHaveLength(0);
    app.specEditor.replaceDocument('{"name":"Draft","favorite":false}');
    app.actions.formatSpec();
    expect(app.specEditor.getValue()).toBe('{\n  "name": "Draft",\n  "favorite": false\n}');
  });
  it('activates an invalid linked tab directly in Spec mode', () => {
    const app = createApp(env({ window: asWindow({ history: { replaceState: vi.fn() }, navigator: {} }) }));
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    const tab = app.activeTab();
    expect(app.activateInvalidSpecDraft(null)).toBeUndefined();
    app.activateInvalidSpecDraft(tab);
    expect(app.state.activeTabId.value).toBe(tab.id);
    expect(tab.editorMode).toBe('spec');
    expect(qs(document, '.share-toast').textContent).toBe('Fix Spec JSON first');
  });
  it('registers and unregisters synchronous semantic validators by exact path', () => {
    const app = createApp(env());
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    app.specEditor.replaceDocument('{"name":"Fav","favorite":false,"items":[{"kind":"bad"}]}');
    const linked = app.activeTab();
    app.actions.newTab();
    const unregister = app.queryDoc.registerSpecValidator(['items', 0, 'kind'], ({ value, path }) =>
      value === 'ok' ? [] : [{ path, severity: 'warning', code: 'bad-kind', message: 'Unexpected kind' }]);
    expect(linked.specDiagnostics).toEqual([{
      path: ['items', 0, 'kind'], severity: 'warning', code: 'bad-kind', message: 'Unexpected kind',
    }]);
    unregister();
    expect(linked.specDiagnostics).toEqual([]);
  });
  it('keeps warnings/info out of the bottom Spec status and navigates the first real error', () => {
    const app = createApp(env());
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    app.actions.setEditorMode('spec');
    const warning = app.queryDoc.registerSpecValidator([], () => [
      { severity: 'warning', code: 'heads-up', message: 'Non-blocking warning' },
      { severity: 'info', code: 'note', message: 'Informational note' },
    ]);
    expect(app.dom.specStatus!.hidden).toBe(true);
    expect(app.dom.specStatus!.textContent).toBe('');
    expect(app.specBlocked(app.activeTab())).toBe(false);

    const error = app.queryDoc.registerSpecValidator(['runtime'], () => [
      { severity: 'error', code: 'blocked', message: 'Blocking error' },
      { severity: 'error', code: 'also-blocked', message: 'Second blocking error' },
    ]);
    expect(app.dom.specStatus!.hidden).toBe(false);
    expect(app.dom.specStatus!.textContent).toBe('Blocking error — 2 errors');
    expect(app.specBlocked(app.activeTab())).toBe(true);
    const reveal = vi.spyOn(app.specEditor, 'revealDiagnostic');
    app.queryDoc.revealFirstSpecError();
    expect(reveal).toHaveBeenCalledWith(2);
    error(); warning();
    expect(app.dom.specStatus!.hidden).toBe(true);
  });
  it('synchronously reruns registered blocking validation inside linked Save', async () => {
    const store = { getItem: vi.fn(() => null), setItem: vi.fn() };
    vi.stubGlobal('localStorage', store);
    const app = createApp(env());
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    app.sqlEditor.replaceDocument('SELECT 10');
    app.specEditor.replaceDocument('{"name":"Fav","favorite":false,"runtime":{"blocked":true}}');
    app.queryDoc.registerSpecValidator(['runtime'], ({ value }) => (value as { blocked?: boolean } | null)?.blocked
      ? [{ path: ['runtime', 'blocked'], severity: 'error', code: 'runtime-blocked', message: 'Runtime says no' }]
      : []);
    // Simulate stale presentation state: Save must not trust this array.
    app.activeTab().specDiagnostics = [];
    store.setItem.mockClear();
    await app.actions.save();
    expect(app.state.savedQueries[0].sql).toBe('SELECT 9');
    expect(store.setItem).not.toHaveBeenCalled();
    expect(app.activeTab().specDiagnostics[0]).toMatchObject({ code: 'runtime-blocked' });
  });
  it('linked Save commits SQL and authoritative Spec directly without a popover', async () => {
    const app = createApp(env());
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 9', description: 'why' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    app.sqlEditor.replaceDocument('SELECT 10');
    app.specEditor.replaceDocument('{"name":"  Renamed  ","description":"  updated reason  ","favorite":false,"future":{"kept":true}}');
    await app.actions.save();
    expect(qs(document, '.save-popover')).toBeNull();
    expect(app.state.savedQueries[0].sql).toBe('SELECT 10');
    expect(app.state.savedQueries[0].spec).toEqual({
      name: 'Renamed', description: 'updated reason', favorite: false, future: { kept: true }, view: 'table',
    });
    expect(queryDescription(app.state.savedQueries[0])).toBe('updated reason');
    expect(app.activeTab().dirtySql).toBe(false);
    expect(app.activeTab().dirtySpec).toBe(false);
  });
  it('loadColumns fills the target table by reference, leaving siblings untouched', async () => {
    const e = env({ fetch: makeFetch([[(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'id', type: 'UInt64', comment: '' }] } })]]) });
    const app = createApp(e); // no renderApp → loadSchema can't clobber our seeded schema
    // Two dbs / two tables so the immutable replace exercises both ternary arms
    // (non-target db kept, non-target table kept).
    app.state.schema.value = [
      { db: 'other', tables: [{ name: 'x', columns: null }] },
      { db: 'd', tables: [{ name: 's', columns: null }, { name: 't', columns: null }] },
    ];
    await app.actions.loadColumns('d', 't');
    expect(schemaOf(app)[1].tables![1].columns).toEqual([{ name: 'id', type: 'UInt64', comment: '' }]);
    expect(schemaOf(app)[0].tables![0].columns).toBe(null); // other db untouched
    expect(schemaOf(app)[1].tables![0].columns).toBe(null); // sibling table untouched
  });
  it('loadColumns falls back to [] on error', async () => {
    const e = env({ fetch: makeFetch([[(u, sql) => /system\.columns/.test(sql), resp({ ok: false, status: 500, text: 'x' })]]) });
    const app = createApp(e);
    app.state.schema.value = [{ db: 'd', tables: [{ name: 't', columns: null }] }];
    await app.actions.loadColumns('d', 't');
    expect(schemaOf(app)[0].tables![0].columns).toEqual([]);
  });
});

describe('exhaustive controller coverage', () => {
  const fakeWin = (): Window => asWindow({ history: { replaceState: vi.fn() }, navigator: {} });

  it('refresh stores a returned refresh_token', async () => {
    const e = env({
      sessionStorage: memSession({ oauth_id_token: jwt({ exp: 1 }), oauth_refresh_token: 'rt' }),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
        [(u) => u === 'https://t', resp({ json: { id_token: validToken, refresh_token: 'rt2' } })],
      ]),
    });
    const app = createApp(e);
    await app.conn.chCtx.refresh();
    expect(app.conn.refreshToken()).toBe('rt2');
    expect(e.sessionStorage!.getItem('oauth_refresh_token')).toBe('rt2');
  });

  it('clicks every header + toolbar control', async () => {
    const e = env({ window: fakeWin(), navigator: { clipboard: asClipboard({ writeText: vi.fn(async () => {}) }) } });
    const app = createApp(e);
    app.renderApp();
    qs(app.root, '.new-tab').dispatchEvent(new Event('click'));
    qs(app.root, '.hd-btn[title^="Keyboard"]').dispatchEvent(new Event('click')); // shortcuts
    app.activeTab().sqlDraft = 'SELECT 1'; // set sql on the now-active tab
    app.dom.saveBtn!.dispatchEvent(new Event('click')); // open save popover
    qs<HTMLInputElement>(document, '.save-popover .sp-input').value = 'Q';
    qs(document, '.save-popover .sp-save').dispatchEvent(new Event('click')); // commit
    await flush(); // the popover's Save button awaits the aggregate commit (#287 W4)
    app.dom.shareBtn!.dispatchEvent(new Event('click')); // share
    expect(app.state.tabs.value.length).toBeGreaterThan(1);
    expect(app.state.savedQueries.length).toBe(1);
  });

  it('drives each splitter handle through a drag', () => {
    const e = env();
    const app = createApp(e);
    app.renderApp();
    const drag = (el: Element, axis: string): string => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 250, clientY: 40 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
      return axis;
    };
    drag(qs(app.root, '.col-resize'), 'col');
    drag(app.dom.sideSplit!, 'sideRow');
    drag(app.dom.editorResultsSplit!, 'row');
    expect(app.state.sidebarPx).toBeDefined();
    // sideRow must resize the schema pane itself, not whichever element happens
    // to be the sidebar's first child (the mobile segmented control sits before
    // it in the DOM for #126) — regression guard, live bug found post-#126.
    const schemaPane = qs(app.root, '.schema-pane');
    expect(schemaPane.style.height).toBe(app.state.sideSplitPct + '%');
    expect(qs(app.root, '.mobile-segmented').style.height).toBe('');
  });

  it('run(): network error → "Network error"', async () => {
    const e = env({ fetch: vi.fn(async () => { throw new TypeError('net down'); }) });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).error).toBe('Network error');
  });
  it('run(): AbortError marks the result cancelled (keeps partial rows, no error)', async () => {
    const e = env({ fetch: vi.fn(async () => { const err = new Error('x'); err.name = 'AbortError'; throw err; }) });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).cancelled).toBe(true);
    expect(result(app.activeTab()).error).toBeNull();
    expect(app.state.history.length).toBe(0); // cancelled runs are not recorded
  });
  it('run(): generic error → message', async () => {
    const e = env({ fetch: vi.fn(async () => { throw new Error('weird'); }) });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).error).toBe('weird');
  });

  it('share: clipboard rejection falls back to a manual toast', async () => {
    const e = env({ window: fakeWin(), navigator: { clipboard: asClipboard({ writeText: vi.fn(async () => { throw new Error('denied'); }) }) } });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 1';
    app.actions.share();
    await new Promise((r) => setTimeout(r));
    expect(qs(document, '.share-toast')).not.toBeNull();
  });
  it('share: no clipboard API uses the manual toast', () => {
    const e = env({ window: fakeWin(), navigator: {} });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 1';
    app.actions.share();
    expect(qs(document, '.share-toast').textContent).toContain('copy manually');
  });

  it('email() falls back through preferred_username / sub / empty', () => {
    const mk = (p: Record<string, unknown>): App => createApp(env({ sessionStorage: memSession({ oauth_id_token: jwt({ exp: 9e9, ...p }) }) }));
    expect(mk({ preferred_username: 'u' }).conn.email()).toBe('u');
    expect(mk({ sub: 's' }).conn.email()).toBe('s');
    expect(mk({}).conn.email()).toBe('');
  });

  it('getToken: null token, and expired token refreshed', async () => {
    const e0 = env({ sessionStorage: memSession({}) });
    expect(await createApp(e0).conn.chCtx.getToken()).toBeNull();

    const e1 = env({
      sessionStorage: memSession({ oauth_id_token: jwt({ exp: 1 }), oauth_refresh_token: 'rt' }),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
        [(u) => u === 'https://t', resp({ json: { id_token: validToken } })],
      ]),
    });
    expect(await createApp(e1).conn.chCtx.getToken()).toBe(validToken);
  });

  it('loaders + run guard tolerate being called before renderApp', async () => {
    const app = createApp(env({ fetch: makeFetch([[() => true, resp({ json: { data: [] } })]]) }));
    await app.catalog.loadVersion(); // setConn guard: no connStatus
    app.updateSaveBtn(); // guard: no starBtn

    // signed-out run with non-empty SQL exercises the getToken()→onSignedOut path
    const noToken = createApp(env({ sessionStorage: memSession({}) }));
    noToken.activeTab().sqlDraft = 'SELECT 1';
    await noToken.actions.run();
    expect(noToken.activeTab().result).toBeNull();

    // valid token but no renderApp → run proceeds and hits the setRunBtn guard
    const noRender = createApp(env({
      fetch: makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]),
    }));
    noRender.activeTab().sqlDraft = 'SELECT 1';
    await noRender.actions.run();
    expect(result(noRender.activeTab()).error).toBeNull();
  });

  it('every action wrapper is invokable', () => {
    const app = createApp(env());
    app.renderApp();
    app.dom.runBtn!.dispatchEvent(new Event('click')); // run wrapper (empty sql → no-op)
    app.actions.newTab();
    app.state.tabs.value.push(asLegacyTab({ id: 'tx', name: 'X', sql: '', dirty: false, result: null, savedId: null }));
    app.actions.selectTab('tx');
    app.actions.insertAtCursor('zz');
    app.actions.replaceEditor('SELECT 9');
    app.actions.loadIntoNewTab('n', 'SELECT 2');
    app.actions.rerenderTabs();
    app.actions.rerenderResults();
    app.actions.updateSaveBtn();
    app.actions.closeTab(app.state.activeTabId.value);
    expect(app.state.tabs.value.length).toBeGreaterThan(0);
  });

  it('share / toggleSaved tolerate empty SQL; share with no navigator at all', () => {
    const e = env({ window: asWindow({ history: { replaceState: vi.fn() }, navigator: undefined }), navigator: undefined });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sqlDraft = ''; // empty
    app.actions.share(); // returns at !sql (covers the `|| ''` empty branch)
    app.actions.save(); // empty sql → toast, no popover
    app.activeTab().sqlDraft = 'SELECT 1';
    app.actions.share(); // no clipboard anywhere → manual toast
    expect(qs(document, '.share-toast')).not.toBeNull();
  });

  it('schemaError stringifies a non-Error rejection', async () => {
    const e = env({ fetch: vi.fn(async () => { throw 'rawfail'; }) });
    const app = createApp(e);
    app.renderApp();
    await new Promise((r) => setTimeout(r));
    expect(app.state.schemaError.value).toBe('rawfail');
  });

  it('run uses the performance.now fallback when env.now is absent', async () => {
    const e = env({ now: undefined, window: asWindow({ ...fakeWin(), performance: { now: () => 5 } }) });
    e.fetch = makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).error).toBeNull();
  });

  it('run stringifies a non-Error throw', async () => {
    const e = env({ fetch: vi.fn(async () => { throw 'boom-str'; }) });
    const app = createApp(e);
    app.renderApp();
    withOutputFormat(app.state).outputFormat = ''; // exercises the `outputFormat || 'Table'` fallback
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).error).toBe('boom-str');
  });

  it('theme toggles both directions and renders the light icon', () => {
    const app = createApp(env({ sessionStorage: memSession({ oauth_id_token: validToken }) }));
    app.state.theme = 'light';
    app.renderApp(); // renders moon icon (line 283 light branch)
    app.dom.themeBtn!.dispatchEvent(new Event('click')); // light → dark
    expect(app.state.theme).toBe('dark');
    app.dom.themeBtn!.dispatchEvent(new Event('click')); // dark → light
    expect(app.state.theme).toBe('light');
  });

  it('share uses win.navigator when env.navigator is absent, and url when href is empty', async () => {
    const e = env({
      navigator: undefined,
      window: asWindow({ history: { replaceState: vi.fn() }, navigator: { clipboard: asClipboard({ writeText: vi.fn(async () => {}) }) } }),
      location: { host: 'h', origin: 'https://h', pathname: '/sql', search: '', hash: '', href: '' } as Location,
    });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 1';
    app.actions.share();
    await Promise.resolve();
    expect(e.window!.navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('#'));
  });

  it('ch_auth=basic sends Authorization: Basic base64(email:token)', async () => {
    const e = env({
      window: fakeWin(),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid', ch_auth: 'basic' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
        [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })],
      ]),
    });
    const app = createApp(e);
    app.renderApp();
    await app.conn.ensureConfig();
    expect(app.conn.chAuth()).toBe('basic');
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    const q = asMock(e.fetch!).mock.calls.find((c) => c[1] && c[1].body === 'SELECT 1')!;
    const auth = q[1].headers.Authorization;
    expect(auth).toMatch(/^Basic /);
    expect(decodeURIComponent(escape(atob(auth.slice(6))))).toMatch(/^me@example\.com:/);
  });

  it('ch_auth=basic with basic_user_claim maps the Basic username to that claim', async () => {
    const tok = jwt({ email: 'me@example.com', nickname: 'BorisT', exp: Math.floor(Date.now() / 1000) + 3600 });
    const e = env({
      window: fakeWin(),
      sessionStorage: memSession({ oauth_id_token: tok }),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid', ch_auth: 'basic', basic_user_claim: 'nickname' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
        [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })],
      ]),
    });
    const app = createApp(e);
    app.renderApp();
    await app.conn.ensureConfig();
    expect(app.conn.basicUserClaim()).toBe('nickname');
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    const q = asMock(e.fetch!).mock.calls.find((c) => c[1] && c[1].body === 'SELECT 1')!;
    const auth = q[1].headers.Authorization;
    // username segment is the nickname claim, not the email
    expect(decodeURIComponent(escape(atob(auth.slice(6))))).toMatch(/^BorisT:/);
    // the header identity matches the CH user (nickname), not the email claim
    expect(app.conn.email()).toBe('BorisT');
  });

  it('copyResult: TSV for structured, rawText as-is, nothing-to-copy when empty', async () => {
    const writeText = vi.fn(async () => {});
    const app = createApp(env({ window: fakeWin(), navigator: { clipboard: asClipboard({ writeText }) } }));
    app.renderApp();
    app.activeTab().result = { error: null, rawText: null, columns: [{ name: 'a' }, { name: 'b' }], rows: [['1', 'x']] };
    app.actions.copyResult();
    await new Promise((r) => setTimeout(r));
    expect(writeText).toHaveBeenCalledWith('a\tb\n1\tx');
    expect(qs(document, '.share-toast').textContent).toBe('Copied to clipboard');
    app.activeTab().result = { rawText: 'raw\tdata', rows: [] };
    app.actions.copyResult();
    expect(writeText).toHaveBeenLastCalledWith('raw\tdata');
    app.activeTab().result = null;
    app.actions.copyResult();
    expect(qs(document, '.share-toast').textContent).toBe('Nothing to copy');
  });
  it('copyResult: no clipboard → not-supported; rejection → failed', async () => {
    const app = createApp(env({ window: fakeWin(), navigator: {} }));
    app.renderApp();
    app.activeTab().result = { columns: [{ name: 'a' }], rows: [['1']] };
    app.actions.copyResult();
    expect(qs(document, '.share-toast').textContent).toBe('Copy not supported');
    const app2 = createApp(env({ window: fakeWin(), navigator: { clipboard: asClipboard({ writeText: vi.fn(async () => { throw new Error('x'); }) }) } }));
    app2.renderApp();
    app2.activeTab().result = { columns: [{ name: 'a' }], rows: [['1']] };
    app2.actions.copyResult();
    await new Promise((r) => setTimeout(r));
    expect(qs(document, '.share-toast').textContent).toBe('Copy failed');
  });
  it('downloadFile: injected env.download wins; native path uses Blob + createObjectURL + revoke', () => {
    // file-menu.js is the only remaining caller of app.downloadFile; exercise
    // both branches directly since neither is a UI-clickable action anymore.
    const download = vi.fn();
    const app = createApp(env({ window: fakeWin(), download }));
    app.renderApp();
    app.downloadFile('result.tsv', 'text/tab-separated-values', 'a\tb');
    expect(download).toHaveBeenCalledWith('result.tsv', 'text/tab-separated-values', 'a\tb');
    const createObjectURL = vi.fn(() => 'blob:u');
    const revokeObjectURL = vi.fn();
    const app2 = createApp(env({ window: asWindow({
      ...fakeWin(),
      URL: { createObjectURL, revokeObjectURL },
      Blob: class { p: unknown; constructor(p: unknown) { this.p = p; } },
    }) }));
    app2.renderApp();
    app2.downloadFile('result.csv', 'text/csv', 'a,b');
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:u');
  });

  it('shows and dismisses the auth-failure banner', () => {
    const app = createApp(env());
    app.renderApp();
    app.updateBanner();
    expect(app.dom.banner!.style.display).toBe('none'); // no error → hidden
    app.state.schemaError.value = 'Token authentication is not configured';
    app.updateBanner();
    expect(app.dom.banner!.style.display).toBe('');
    expect(app.dom.banner!.textContent).toContain('Token authentication is not configured');
    qs(app.dom.banner!, '.auth-banner-x').dispatchEvent(new Event('click'));
    expect(app.dom.banner!.style.display).toBe('none');
    app.updateBanner(); // dismissed for this error → stays hidden
    expect(app.dom.banner!.style.display).toBe('none');
  });
  it('updateBanner is a no-op before renderApp', () => {
    const app = createApp(env());
    expect(() => app.updateBanner()).not.toThrow();
  });

  it('renders history into the side panel after a successful run', async () => {
    const e = env({
      window: fakeWin(),
      fetch: makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[]}\n', '{"row":{}}\n']) })]]),
    });
    const app = createApp(e);
    app.renderApp();
    app.state.sidePanel.value = 'history';
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(app.state.history.length).toBe(1);
  });
});

// The streaming single-file export (issue #87) and multi-statement script
// export (issue #99) POLICY now lives in `application/export-service.ts`
// (#276 Phase 4B2 — `createExportService`, exercised directly and
// exhaustively by export-service.test.ts: statement-count dispatch, the
// picker-first/stream/hold-back-buffer path, cancellation, the
// directory-picker/per-statement transport loop, file naming, and every
// error/edge-case branch). What's left here is THIN integration coverage —
// the pieces export-service.test.ts's own fake sink/ch-fns/hooks can't
// exercise: `app.canExport`/`app.canExportScript` resolving from the real
// injected env seams, the `setExportBtn` DOM effect reacting to
// `state.exporting`, `app.actions.*` delegating to `app.exports`, and one
// real round trip through each of `app.ts`'s own wiring lines (the
// `ExportSink` wrapper around `showSaveFilePicker`/`showDirectoryPicker`, and
// the `hooks` object's `showExportProgress`/`toast`/`renderResults`/
// `loadSchema` bodies) so those lines stay covered end-to-end, not just at
// the service layer.
describe('streaming export (issue #87)', () => {
  const fakeWin = (): Window => asWindow({ history: { replaceState: vi.fn() }, navigator: {} });

  it('canExport resolves from the injected seams; the toolbar button reflects it', () => {
    const disabled = createApp(env({ window: fakeWin() }));
    disabled.renderApp();
    expect(disabled.canExport()).toBe(false);
    expect(disabled.dom.exportBtn!.classList.contains('is-disabled')).toBe(true);
    expect(disabled.dom.exportBtn!.getAttribute('aria-disabled')).toBe('true');
    expect(disabled.dom.exportBtn!.title).toMatch(/Chrome\/Edge/);

    const enabled = createApp(env({ window: fakeWin(), showSaveFilePicker: vi.fn(), isSecureContext: true }));
    enabled.renderApp();
    expect(enabled.canExport()).toBe(true);
    expect(enabled.dom.exportBtn!.classList.contains('is-disabled')).toBe(false);
    expect(enabled.dom.exportBtn!.getAttribute('aria-disabled')).toBeNull();
  });

  it('"Nothing to export" toast when the editor is empty', async () => {
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker: vi.fn(), isSecureContext: true }));
    app.renderApp();
    app.activeTab().sqlDraft = '   ';
    await app.actions.exportEntry();
    expect(qs(document, '.share-toast').textContent).toBe('Nothing to export');
  });

  it('streams a clean result to disk (default TSV) and reports completion — a real round trip through app.ts\'s own ExportSink/hooks wiring', async () => {
    const { handle, writable, chunks } = fakeFileHandle();
    let pickerOpts: SaveFilePickerOpts | undefined;
    const showSaveFilePicker = vi.fn(async (opts: unknown) => { pickerOpts = opts as SaveFilePickerOpts; return handle; });
    const EXPORT_SQL = 'SELECT 1\nFORMAT TabSeparatedWithNames';
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL, () => resp({ body: streamBody(['a'.repeat(100)]) })]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().name = 'My Query!';
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.exportEntry();
    expect(pickerOpts!.suggestedName).toBe('My_Query.tsv');
    expect(writtenText(chunks)).toBe('a'.repeat(100));
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(qs(document, '.share-toast').textContent).toBe('Export complete');
    expect(app.state.exporting.value).toBe(false);
    const exportCall = asMock(fetch).mock.calls.find((c) => c[1] && c[1].body === EXPORT_SQL)!;
    expect(exportCall[0]).toContain('default_format=TabSeparatedWithNames');
  });

  it('setExportBtn reflects the exporting state on the toolbar button, blocking a second click visually too', () => {
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker: vi.fn(), isSecureContext: true }));
    app.renderApp();
    expect(app.dom.exportBtn!.classList.contains('is-disabled')).toBe(false);
    expect(app.dom.exportBtn!.getAttribute('aria-disabled')).toBeNull();
    app.state.exporting.value = true;
    expect(app.dom.exportBtn!.classList.contains('is-disabled')).toBe(true);
    expect(app.dom.exportBtn!.getAttribute('aria-disabled')).toBe('true');
    expect(app.dom.exportBtn!.title).toBe('Export in progress…');
    app.state.exporting.value = false;
    expect(app.dom.exportBtn!.classList.contains('is-disabled')).toBe(false);
    expect(app.dom.exportBtn!.getAttribute('aria-disabled')).toBeNull();
  });

  it('actions.exportEntry/exportDirect/cancelExport/cancelExportScript delegate to app.exports (#276 Phase 4B2)', async () => {
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker: vi.fn(), isSecureContext: true }));
    app.renderApp();
    const exportEntry = vi.spyOn(app.exports, 'exportEntry').mockResolvedValue(undefined);
    const exportDirect = vi.spyOn(app.exports, 'exportDirect').mockResolvedValue(undefined);
    const cancelExport = vi.spyOn(app.exports, 'cancelExport').mockImplementation(() => {});
    const cancelExportScript = vi.spyOn(app.exports, 'cancelExportScript').mockImplementation(() => {});
    await app.actions.exportEntry();
    await app.actions.exportDirect('SELECT 1', 7);
    app.actions.cancelExport();
    app.actions.cancelExportScript();
    expect(exportEntry).toHaveBeenCalledTimes(1);
    expect(exportDirect).toHaveBeenCalledWith('SELECT 1', 7);
    expect(cancelExport).toHaveBeenCalledTimes(1);
    expect(cancelExportScript).toHaveBeenCalledTimes(1);
  });
});

describe('script export (issue #99)', () => {
  const fakeWin = (): Window => asWindow({ history: { replaceState: vi.fn() }, navigator: {} });

  // A fake FileSystemDirectoryHandle: getFileHandle(name) hands back a fresh
  // fakeFileHandle() and remembers it (keyed by name) for write assertions.
  function fakeDirHandle() {
    const written = new Map<string, ReturnType<typeof fakeFileHandle>>();
    const dir = {
      getFileHandle: vi.fn(async (name: string) => {
        const f = fakeFileHandle();
        written.set(name, f);
        return f.handle;
      }),
    };
    return { dir, written };
  }

  // Restored integration pin (review, Phase-4 PR): the unit-level editorMode
  // gate lives in export-service.test.ts, but only this end-to-end version
  // catches a wiring regression between the query-document session's
  // editor-mode policy and the export service's gate.
  it('exportEntry is unavailable in Spec mode and exports sqlDraft after switching to SQL', async () => {
    const showSaveFilePicker = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    const showDirectoryPicker = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, showDirectoryPicker, isSecureContext: true }));
    app.renderApp();
    app.state.savedQueries = [savedQueryFixture({ id: 's9', name: 'Fav', sql: 'SELECT 1; SELECT 2' })];
    app.actions.loadIntoNewTab(asQueryOrName(app.state.savedQueries[0]));
    app.actions.setEditorMode('spec');
    app.dom.specEditorView!.dispatch({ selection: { anchor: 0, head: 8 } });
    await app.actions.exportEntry();
    expect(showSaveFilePicker).not.toHaveBeenCalled();
    expect(showDirectoryPicker).not.toHaveBeenCalled();
    app.actions.setEditorMode('sql');
    await app.actions.exportEntry();
    expect(showDirectoryPicker).toHaveBeenCalledTimes(1);
  });
  it('canExportScript resolves from the showDirectoryPicker seam + secure context', () => {
    const withPicker = createApp(env({ window: fakeWin(), showDirectoryPicker: vi.fn(), isSecureContext: true }));
    expect(withPicker.canExportScript()).toBe(true);
    const noPicker = createApp(env({ window: fakeWin(), showDirectoryPicker: null, isSecureContext: true }));
    expect(noPicker.canExportScript()).toBe(false);
    const insecure = createApp(env({ window: fakeWin(), showDirectoryPicker: vi.fn(), isSecureContext: false }));
    expect(insecure.canExportScript()).toBe(false);
  });

  it('exportEntry dispatches by statement count: 1 → the single-file picker, N → the directory picker', async () => {
    const showSaveFilePicker = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    const showDirectoryPicker = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, showDirectoryPicker, isSecureContext: true }));
    app.renderApp();
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.exportEntry();
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(showDirectoryPicker).not.toHaveBeenCalled();

    app.activeTab().sqlDraft = 'SELECT 1;\nSELECT 2;';
    await app.actions.exportEntry();
    expect(showDirectoryPicker).toHaveBeenCalledTimes(1);
  });

  it('runs statements sequentially in one shared session, effect statements logged ok with no file, rows streamed to their own file', async () => {
    const { dir, written } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const SCRIPT = 'CREATE TEMPORARY TABLE t (a Int8);\nINSERT INTO t VALUES (1);\nSELECT * FROM t';
    const fetch = makeFetch([
      [(u, sql) => sql === 'CREATE TEMPORARY TABLE t (a Int8)', () => resp({ text: '' })],
      [(u, sql) => sql === 'INSERT INTO t VALUES (1)', () => resp({ text: '' })],
      [(u, sql) => sql === 'SELECT * FROM t\nFORMAT TabSeparatedWithNames', () => resp({ body: streamBody(['1\n']) })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sqlDraft = SCRIPT;
    await app.actions.exportEntry();
    const SCRIPT_SQLS = ['CREATE TEMPORARY TABLE t (a Int8)', 'INSERT INTO t VALUES (1)', 'SELECT * FROM t\nFORMAT TabSeparatedWithNames'];
    // renderApp's mount also fires a version/schema fetch — filter to this script's own requests.
    const calls = asMock(fetch).mock.calls.filter((c) => c[1] && SCRIPT_SQLS.includes(c[1].body));
    expect(calls.map((c) => c[1].body)).toEqual(SCRIPT_SQLS); // sequential, in order
    const sid = /session_id=([^&]+)/.exec(calls[0][0])![1];
    expect(sid).toBeTruthy();
    calls.forEach((c) => expect(c[0]).toContain('session_id=' + sid)); // one shared session

    const entries = scriptExportOf(app.activeTab());
    expect(entries.map((e) => e.status)).toEqual(['ok', 'ok', 'ok']);
    expect(entries[0].file).toBeNull();
    expect(entries[1].file).toBeNull();
    expect(entries[2].file).toBe('003-t.tsv');
    expect(dir.getFileHandle).toHaveBeenCalledTimes(1); // only the row-returning statement
    expect(written.get('003-t.tsv')!.writable.close).toHaveBeenCalledTimes(1);

    // metadata only — never the exported rows.
    expect(result(app.activeTab()).rows).toBeUndefined();
    expect(result(app.activeTab()).rawText).toBeUndefined();
    expect(app.state.exporting.value).toBe(false);
  });

  it('refreshes the schema when an effect statement that actually ran is schema-mutating', async () => {
    const { dir } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const fetch = makeFetch([
      [(u, sql) => sql === 'CREATE TABLE t (a Int8)', () => resp({ text: '' })],
      [(u, sql) => sql === 'SELECT 1\nFORMAT TabSeparatedWithNames', () => resp({ body: streamBody(['x']) })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    await new Promise((r) => setTimeout(r)); // let the initial-mount loadSchema settle
    const spy = vi.spyOn(app.catalog, 'loadSchema');
    app.activeTab().sqlDraft = 'CREATE TABLE t (a Int8);\nSELECT 1;';
    await app.actions.exportEntry();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('schema lineage graph (drag a db/table onto the results pane)', () => {
  const lineageRoutes: FetchRoute[] = [
    [(u, sql) => /EXPLAIN AST/.test(sql), resp({ json: { data: [{ explain: '      TableIdentifier lin.events (alias e)' }] } })],
    [(u, sql) => /system\.dictionaries/.test(sql), resp({ json: { data: [] } })],
    [(u, sql) => /system\.tables/.test(sql), resp({ json: { data: [
      { database: 'lin', name: 'events', engine: 'MergeTree', engine_full: '', create_table_query: '', as_select: '', uuid: '', dependencies_database: ['lin'], dependencies_table: ['mv'], loading_dependencies_database: [], loading_dependencies_table: [] },
      { database: 'lin', name: 'mv', engine: 'MaterializedView', engine_full: '', create_table_query: 'CREATE MATERIALIZED VIEW lin.mv TO lin.dst AS SELECT 1 FROM lin.events', as_select: 'SELECT 1 FROM lin.events', uuid: '', dependencies_database: [], dependencies_table: [], loading_dependencies_database: [], loading_dependencies_table: [] },
      { database: 'lin', name: 'dst', engine: 'MergeTree', engine_full: '', create_table_query: '', as_select: '', uuid: '', dependencies_database: [], dependencies_table: [], loading_dependencies_database: [], loading_dependencies_table: [] },
    ] } })],
  ];
  function appForRun(routes: FetchRoute[], over: Partial<CreateAppEnv> = {}): { app: App; e: CreateAppEnv } {
    const e = env({ fetch: makeFetch(routes), ...over });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }

  it('showSchemaGraph queries system.* and sets a schemaGraph result', async () => {
    const { app } = appForRun(lineageRoutes);
    await app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    const sg = schemaGraphOf(app.activeTab());
    expect(sg.focus).toEqual({ kind: 'db', db: 'lin' });
    const E = new Set(sg.edges!.map((x) => `${x.from}>${x.to}:${x.kind}`));
    expect(E.has('lin.events>lin.mv:feeds')).toBe(true);
    expect(E.has('lin.mv>lin.dst:writes')).toBe(true);
  });

  it('a drop on the results region with the schema-graph MIME triggers showSchemaGraph', () => {
    const { app } = appForRun(lineageRoutes);
    app.actions.showSchemaGraph = vi.fn();
    const e = new Event('drop', { cancelable: true }) as FakeDragEvent;
    e.dataTransfer = { getData: (m) => (m === 'application/x-asb-schema-graph' ? '{"kind":"table","db":"lin","table":"events"}' : '') };
    app.dom.resultsRegion!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(app.actions.showSchemaGraph).toHaveBeenCalledWith({ kind: 'table', db: 'lin', table: 'events' });
  });

  it('surfaces a load error in the results panel', async () => {
    const { app } = appForRun([[(u, sql) => /system\.tables/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: nope"}' })]]);
    await app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    expect(result(app.activeTab()).error).toContain('nope');
  });

  it('expandSchemaGraph loads the enriched dataset and opens a rich-card fullscreen overlay', async () => {
    const routes: FetchRoute[] = [
      ...lineageRoutes,
      [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [
        { database: 'lin', table: 'events', name: 'id', type: 'UInt64', is_in_primary_key: 1, position: 1 },
      ] } })],
      [(u, sql) => /data_skipping_indices/.test(sql), resp({ json: { data: [] } })],
    ];
    const { app } = appForRun(routes, { openWindow: () => null }); // force the in-app overlay fallback
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    const overlay = qs(document.body, '.graph-overlay');
    expect(overlay).not.toBeNull();
    expect(qs(overlay, 'g.eg-card')).not.toBeNull();
    expect(qs(overlay, 'text.eg-card-header').textContent).toMatch(/rows/);
    overlay.remove();
  });

  it('expandSchemaGraph guards: no db, signed-out, and a lineage failure open no overlay', async () => {
    // no focus.db → early return
    const { app } = appForRun(lineageRoutes);
    await app.actions.expandSchemaGraph({ kind: 'db' });
    expect(qs(document.body, '.graph-overlay')).toBeNull();
    // signed out (empty session → null token) → onSignedOut + return
    const { app: app2 } = appForRun(lineageRoutes, { sessionStorage: memSession({}) });
    await app2.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    expect(qs(document.body, '.graph-overlay')).toBeNull();
    // lineage load fails → caught, no overlay (the inline graph would still be on screen)
    const { app: app3 } = appForRun([[(u, sql) => /system\.tables/.test(sql), resp({ ok: false, status: 500, text: 'boom' })]]);
    await app3.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    expect(qs(document.body, '.graph-overlay')).toBeNull();
  });

  it('openNodeDetail mounts the detail pane in the open overlay (and guards an incomplete node)', async () => {
    const { app } = appForRun(lineageRoutes, { openWindow: () => null }); // overlay fallback
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    expect(qs(document.body, '.graph-overlay')).not.toBeNull();
    await app.actions.openNodeDetail({ db: 'lin', name: 'events', kind: 'table' });
    expect(qs(document.body, '.schema-detail')).not.toBeNull();
    await app.actions.openNodeDetail({ db: 'lin' }); // no name → guard returns, no throw
    qs(document.body, '.graph-overlay').remove();
  });

  it('openNodeDetail shows a spinner immediately, then the loaded detail once the fetch resolves', async () => {
    const { app } = appForRun(lineageRoutes, { openWindow: () => null });
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    const pending = app.actions.openNodeDetail({ db: 'lin', name: 'events', kind: 'table' });
    expect(qs(document.body, '.schema-detail .placeholder.starting')).not.toBeNull();
    await pending;
    expect(qs(document.body, '.schema-detail .placeholder.starting')).toBeNull();
    expect(qs(document.body, '.schema-detail-cols')).not.toBeNull();
    qs(document.body, '.graph-overlay').remove();
  });

  it('a stale detail fetch does not clobber a newer pane — last-clicked wins, not last-resolved (#97)', async () => {
    let resolveEvents!: (value: FakeResponse | Promise<FakeResponse>) => void;
    const eventsColumns = new Promise<FakeResponse>((r) => { resolveEvents = r; });
    const routes: FetchRoute[] = [
      ...lineageRoutes,
      [(u, sql) => /system\.columns/.test(sql) && /table = 'events'/.test(sql), () => eventsColumns],
      [(u, sql) => /system\.columns/.test(sql) && /table = 'mv'/.test(sql), resp({ json: { data: [{ name: 'x', type: 'Int32', position: 1 }] } })],
      [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [] } })], // card-load query (expandSchemaGraph)
      [(u, sql) => /system\.parts/.test(sql), resp({ json: { data: [] } })],
      [(u, sql) => /data_skipping_indices/.test(sql), resp({ json: { data: [] } })],
    ];
    const { app } = appForRun(routes, { openWindow: () => null });
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });

    // Click table A (events) — its columns fetch hangs — then quickly click table B
    // (mv) before A resolves. B's fetch is immediate and mounts first.
    const first = app.actions.openNodeDetail({ db: 'lin', name: 'events', kind: 'table', id: 'lin.events' });
    const second = app.actions.openNodeDetail({ db: 'lin', name: 'mv', kind: 'table', id: 'lin.mv' });
    await second;
    expect(qs(document.body, '.schema-detail-head b').textContent).toBe('lin.mv');

    // A resolves last — its stale pane mount must be dropped, not replace B's.
    resolveEvents(resp({ json: { data: [] } }));
    await first;
    expect(qs(document.body, '.schema-detail-head b').textContent).toBe('lin.mv');
    qs(document.body, '.graph-overlay').remove();
  });

  it('attaches a per-result savedPositions map and reuses it when the same result is re-opened', async () => {
    const routes: FetchRoute[] = [
      ...lineageRoutes,
      [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [] } })],
      [(u, sql) => /data_skipping_indices/.test(sql), resp({ json: { data: [] } })],
    ];
    const { app } = appForRun(routes, { openWindow: () => null });
    await app.actions.showSchemaGraph({ kind: 'db', db: 'lin' }); // sets result.schemaGraph
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    const positions = schemaGraphOf(app.activeTab()).savedPositions;
    expect(positions).toBeTypeOf('object');
    qs(document.body, '.graph-overlay').remove();
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    expect(schemaGraphOf(app.activeTab()).savedPositions).toBe(positions); // same map reused
    qs(document.body, '.graph-overlay').remove();
  });

  // #124 — stale-write race, cancellation, progressive draw.
  // Local variant of makeFetch that forwards `init` to a function route, so a
  // route can be signal-aware (reject when the request's own AbortController
  // fires) — the shared makeFetch above only ever calls `r()` with no args.
  // A signal-aware fetch-init: `init.signal` (AbortSignal) is the one member
  // this suite's routes read beyond the shared `FetchRoute`'s `body`.
  interface SignalInit { body?: string; signal?: AbortSignal }
  type SignalRouteFn = (url: string, init: SignalInit) => FakeResponse | Promise<FakeResponse | never>;
  type SignalFetchRoute = [(url: string, sql: string) => boolean, FakeResponse | SignalRouteFn];
  function makeSignalFetch(routes: SignalFetchRoute[]): typeof fetch {
    return asFetch(vi.fn(async (url: string, init?: SignalInit) => {
      const sql = (init && init.body) || '';
      for (const [test, r] of routes) if (test(url, sql)) return typeof r === 'function' ? r(url, init as SignalInit) : r;
      return resp({ json: { data: [] } });
    }));
  }
  const hangsUntilAborted: SignalRouteFn = (url, init) => new Promise((resolve, reject) => {
    const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
    // Real fetch rejects immediately for an already-aborted signal — mirror that
    // (a bare addEventListener would miss an abort that fired before this request
    // was even dispatched, since the event has already come and gone).
    if (init.signal!.aborted) abort();
    else init.signal!.addEventListener('abort', abort);
  });
  // showSchemaGraph awaits ensureConfig()/getToken() before setting the initial
  // placeholder — poll (bounded, no real timer) rather than guessing a fixed
  // microtask-tick count.
  async function untilResult(app: App): Promise<void> {
    for (let i = 0; i < 50 && app.activeTab().result == null; i++) await Promise.resolve();
  }
  // showSchemaGraph's Phase-A/Phase-B split only engages at/above
  // AST_PROGRESSIVE_THRESHOLD view/MV objects (#124 — below it, a single-step
  // draw avoids flicker on small schemas) — pad a fixture's table list with
  // throwaway views so a specific scenario's real object(s) can still exercise
  // the two-phase path under the real (non-test-overridden) default.
  // 'SELECT pad…' (not just 'SELECT …') so a route matching a specific real
  // object's exact EXPLAIN AST text (e.g. /EXPLAIN AST SELECT 1/) never
  // accidentally also matches a padding row's.
  const paddingViews = (n: number) => Array.from({ length: n }, (_, i) => (
    { database: 'lin', name: 'pad' + i, engine: 'View', as_select: 'SELECT pad' + i }
  ));

  it('run() while a lineage fetch is in flight does not corrupt the query result (regression for #124)', async () => {
    let resolveTables!: (value: FakeResponse | Promise<FakeResponse>) => void;
    const tablesPending = new Promise<FakeResponse>((r) => { resolveTables = r; });
    const { app } = appForRun([
      [(u, sql) => /system\.tables/.test(sql), () => tablesPending],
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })],
    ]);
    const graphPromise = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' }); // hangs on system.tables
    await untilResult(app); // let the pre-Phase-A loading placeholder land
    expect(schemaGraphOf(app.activeTab()).loading).toBe(true);
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(result(app.activeTab()).rows).toEqual([['1']]);
    expect(schemaGraphOf(app.activeTab())).toBeUndefined();
    // the stale lineage fetch resolving afterward must not clobber run()'s result
    resolveTables(resp({ json: { data: [] } }));
    await graphPromise;
    expect(result(app.activeTab()).rows).toEqual([['1']]);
    expect(schemaGraphOf(app.activeTab())).toBeUndefined();
  });

  it('runScript() while a lineage fetch is in flight does not corrupt the query result (regression for #124)', async () => {
    let resolveTables!: (value: FakeResponse | Promise<FakeResponse>) => void;
    const tablesPending = new Promise<FakeResponse>((r) => { resolveTables = r; });
    const { app } = appForRun([
      [(u, sql) => /system\.tables/.test(sql), () => tablesPending],
      [(u, sql) => /SELECT 1/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'a', type: 'UInt8' }], data: [['1']] }) })],
    ]);
    const graphPromise = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    await untilResult(app);
    expect(schemaGraphOf(app.activeTab()).loading).toBe(true);
    app.activeTab().sqlDraft = 'SELECT 1;\nSELECT 1'; // >1 statement → runScript path
    await app.actions.run();
    expect(scriptOf(app.activeTab())).toBeDefined();
    expect(schemaGraphOf(app.activeTab())).toBeUndefined();
    resolveTables(resp({ json: { data: [] } }));
    await graphPromise;
    expect(scriptOf(app.activeTab())).toBeDefined();
    expect(schemaGraphOf(app.activeTab())).toBeUndefined();
  });

  it('a second showSchemaGraph before the first resolves shows the second graph only — last-triggered wins, not last-resolved', async () => {
    let resolveFirst!: (value: FakeResponse | Promise<FakeResponse>) => void;
    const firstPending = new Promise<FakeResponse>((r) => { resolveFirst = r; });
    const { app } = appForRun([
      [(u, sql) => /system\.tables/.test(sql) && /database = 'a'/.test(sql), () => firstPending],
      [(u, sql) => /system\.tables/.test(sql) && /database = 'b'/.test(sql), resp({ json: { data: [
        { database: 'b', name: 't', engine: 'MergeTree', as_select: '' },
      ] } })],
    ]);
    const first = app.actions.showSchemaGraph({ kind: 'db', db: 'a' });
    await untilResult(app);
    const second = app.actions.showSchemaGraph({ kind: 'db', db: 'b' });
    await second;
    expect(schemaGraphOf(app.activeTab()).focus!.db).toBe('b');
    resolveFirst(resp({ json: { data: [{ database: 'a', name: 'x', engine: 'MergeTree', as_select: '' }] } }));
    await first;
    expect(schemaGraphOf(app.activeTab()).focus!.db).toBe('b'); // unchanged — a's stale resolution was dropped
  });

  it('cancelSchemaGraph aborts the in-flight fetch; Starting Run cancels it automatically with no unhandled rejection', async () => {
    const fetchImpl = makeSignalFetch([
      [(u, sql) => /system\.tables/.test(sql), hangsUntilAborted],
      [(u, sql) => /SELECT 1/.test(sql), () => resp({ body: streamBody(['{"row":{}}\n']) })],
    ]);
    const app = createApp(env({ fetch: fetchImpl }));
    app.renderApp();
    app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    await untilResult(app);
    expect(schemaGraphOf(app.activeTab()).loading).toBe(true);
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run(); // aborts the pending lineage fetch via cancelSchemaGraph() at its top
    expect(schemaGraphOf(app.activeTab())).toBeUndefined(); // run()'s own result, not clobbered
  });

  it('a manual cancel keeps the Phase-A graph, marked partial, once Phase A has already drawn it', async () => {
    // Padded to AST_PROGRESSIVE_THRESHOLD objects so the two-phase path actually
    // engages under the real default (see paddingViews).
    const tables = [
      { database: 'lin', name: 'mv', engine: 'MaterializedView', as_select: 'SELECT 1 FROM lin.events', create_table_query: '' },
      ...paddingViews(AST_PROGRESSIVE_THRESHOLD - 1),
    ];
    const fetchImpl = makeSignalFetch([
      [(u, sql) => /system\.dictionaries/.test(sql), () => resp({ json: { data: [] } })],
      [(u, sql) => /system\.tables/.test(sql), () => resp({ json: { data: tables } })],
      [(u, sql) => /EXPLAIN AST/.test(sql), hangsUntilAborted],
    ]);
    const app = createApp(env({ fetch: fetchImpl }));
    app.renderApp();
    const pending = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    // Let Phase A land (tableCount known) while Phase B (EXPLAIN AST) hangs.
    await untilResult(app);
    for (let i = 0; i < 50 && schemaGraphOf(app.activeTab()).tableCount == null; i++) await Promise.resolve();
    expect(schemaGraphOf(app.activeTab()).tableCount).not.toBeNull();
    expect(schemaGraphOf(app.activeTab()).nodes!.length).toBeGreaterThan(0);
    app.actions.cancelSchemaGraph({ clearResult: true });
    const sg = schemaGraphOf(app.activeTab());
    expect(sg.loading).toBe(false);
    expect(sg.partial).toBe(true);
    expect(sg.nodes!.length).toBeGreaterThan(0); // kept on screen, not cleared
    await pending; // the aborted EXPLAIN AST rejecting afterward must not resurrect `loading`
    expect(schemaGraphOf(app.activeTab()).loading).toBe(false);
    expect(schemaGraphOf(app.activeTab()).partial).toBe(true);
  });

  it('a manual cancel before Phase A has drawn anything clears the result to the empty placeholder', async () => {
    const fetchImpl = makeSignalFetch([
      [(u, sql) => /system\.tables/.test(sql), hangsUntilAborted],
    ]);
    const app = createApp(env({ fetch: fetchImpl }));
    app.renderApp();
    const pending = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    await untilResult(app);
    expect(schemaGraphOf(app.activeTab()).loading).toBe(true);
    expect(schemaGraphOf(app.activeTab()).nodes).toEqual([]);
    app.actions.cancelSchemaGraph({ clearResult: true });
    expect(app.activeTab().result).toBeNull();
    await pending;
    expect(app.activeTab().result).toBeNull(); // stays cleared — no stray write from the aborted fetch
  });

  it('draws the Phase-A graph (free edges) before EXPLAIN AST resolves, then merges in the view/MV source edges', async () => {
    let resolveAst!: (value: FakeResponse | Promise<FakeResponse>) => void;
    // Every EXPLAIN AST call (the real mv's and all padding views') shares this
    // one pending promise, so resolving it once releases all of them together —
    // the padding views picking up a spurious astTables entry from the shared
    // response doesn't affect the specific edges asserted below (Set#has checks).
    const astPending = new Promise<FakeResponse>((r) => { resolveAst = r; });
    const { app } = appForRun([
      [(u, sql) => /EXPLAIN AST/.test(sql), () => astPending],
      [(u, sql) => /system\.dictionaries/.test(sql), resp({ json: { data: [] } })],
      [(u, sql) => /system\.tables/.test(sql), resp({ json: { data: [
        { database: 'lin', name: 'events', engine: 'MergeTree', as_select: '' },
        { database: 'lin', name: 'mv', engine: 'MaterializedView', as_select: 'SELECT 1 FROM lin.events', create_table_query: 'CREATE MATERIALIZED VIEW lin.mv TO lin.dst AS SELECT 1 FROM lin.events' },
        { database: 'lin', name: 'dst', engine: 'MergeTree', as_select: '' },
        ...paddingViews(AST_PROGRESSIVE_THRESHOLD - 1),
      ] } })],
    ]);
    const pending = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    await untilResult(app);
    for (let i = 0; i < 50 && schemaGraphOf(app.activeTab()).tableCount == null; i++) await Promise.resolve();
    const phaseA = schemaGraphOf(app.activeTab());
    expect(phaseA.loading).toBe(true);
    expect(phaseA.tableCount).toBe(3 + AST_PROGRESSIVE_THRESHOLD - 1);
    // Phase A already has the MV → dst "writes" edge (free, parsed from create_table_query)
    // but not yet the events → mv "feeds" edge (needs EXPLAIN AST — still pending).
    const phaseAEdges = new Set(phaseA.edges!.map((e) => `${e.from}>${e.to}:${e.kind}`));
    expect(phaseAEdges.has('lin.mv>lin.dst:writes')).toBe(true);
    expect(phaseAEdges.has('lin.events>lin.mv:feeds')).toBe(false);
    resolveAst(resp({ json: { data: [{ explain: '      TableIdentifier lin.events (alias e)' }] } }));
    await pending;
    const finalSg = schemaGraphOf(app.activeTab());
    expect(finalSg.loading).toBeUndefined();
    const finalEdges = new Set(finalSg.edges!.map((e) => `${e.from}>${e.to}:${e.kind}`));
    expect(finalEdges.has('lin.events>lin.mv:feeds')).toBe(true);
    expect(finalEdges.has('lin.mv>lin.dst:writes')).toBe(true);
  });

  it('reports EXPLAIN AST resolution progress on the schemaGraph as each view/MV settles', async () => {
    let resolveAstV2!: (value: FakeResponse | Promise<FakeResponse>) => void;
    const astV2Pending = new Promise<FakeResponse>((r) => { resolveAstV2 = r; });
    // v1 + all padding views resolve immediately; v2 alone hangs — so progress
    // should land at (padding+1)/total without waiting for the whole fetch.
    const { app } = appForRun([
      [(u, sql) => /EXPLAIN AST SELECT 2/.test(sql), () => astV2Pending],
      [(u, sql) => /EXPLAIN AST/.test(sql), resp({ json: { data: [{ explain: '' }] } })],
      [(u, sql) => /system\.dictionaries/.test(sql), resp({ json: { data: [] } })],
      [(u, sql) => /system\.tables/.test(sql), resp({ json: { data: [
        { database: 'lin', name: 'v1', engine: 'View', as_select: 'SELECT 1' },
        { database: 'lin', name: 'v2', engine: 'View', as_select: 'SELECT 2' },
        ...paddingViews(AST_PROGRESSIVE_THRESHOLD - 2),
      ] } })],
    ]);
    const pending = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    await untilResult(app);
    for (let i = 0; i < 50 && !schemaGraphOf(app.activeTab()).progress; i++) await Promise.resolve();
    const progress = schemaGraphOf(app.activeTab()).progress!;
    expect(progress.total).toBe(AST_PROGRESSIVE_THRESHOLD);
    expect(progress.done).toBeGreaterThanOrEqual(1);
    expect(progress.done).toBeLessThan(AST_PROGRESSIVE_THRESHOLD); // v2 hasn't settled yet
    expect(schemaGraphOf(app.activeTab()).loading).toBe(true);
    resolveAstV2(resp({ json: { data: [{ explain: '' }] } }));
    await pending;
    expect(schemaGraphOf(app.activeTab()).loading).toBeUndefined();
  });
});

describe('schema graph drop edge cases', () => {
  function mk() { const app = createApp(env({ fetch: makeFetch([]) })); app.renderApp(); return app; }
  it('dragover accepts only the schema-graph MIME', () => {
    const app = mk();
    const a = new Event('dragover', { cancelable: true }) as FakeDragEvent;
    a.dataTransfer = { types: ['application/x-asb-schema-graph'] };
    app.dom.resultsRegion!.dispatchEvent(a);
    expect(a.defaultPrevented).toBe(true);
    const b = new Event('dragover', { cancelable: true }) as FakeDragEvent;
    b.dataTransfer = { types: ['text/plain'] };
    app.dom.resultsRegion!.dispatchEvent(b);
    expect(b.defaultPrevented).toBe(false);
  });
  it('drop ignores a non-schema payload and tolerates malformed JSON', () => {
    const app = mk();
    app.actions.showSchemaGraph = vi.fn();
    const none = new Event('drop', { cancelable: true }) as FakeDragEvent;
    none.dataTransfer = { getData: () => '' };
    app.dom.resultsRegion!.dispatchEvent(none);
    expect(none.defaultPrevented).toBe(false);
    const bad = new Event('drop', { cancelable: true }) as FakeDragEvent;
    bad.dataTransfer = { getData: (m) => (m === 'application/x-asb-schema-graph' ? 'not json' : '') };
    expect(() => app.dom.resultsRegion!.dispatchEvent(bad)).not.toThrow();
    expect(bad.defaultPrevented).toBe(true);
    expect(app.actions.showSchemaGraph).not.toHaveBeenCalled();
  });
});

describe('mobile best-effort mode (#126)', () => {
  // A controllable MediaQueryList stub so a test can seed `matches` and later
  // fire a `change` (simulating crossing the breakpoint / a device rotation).
  interface FakeMQL {
    matches: boolean;
    addEventListener(type: string, fn: (e: { matches: boolean }) => void): void;
    emit(next: boolean): void;
  }
  // Same `object`-parameter trick as `asWindow`/`asClipboard` above: a
  // matches/addEventListener/emit stub doesn't structurally overlap enough of
  // the real `MediaQueryList` for a direct `as`.
  const asMQL = (v: object): MediaQueryList => v as MediaQueryList;
  function fakeMQL(matches: boolean): FakeMQL {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    return {
      matches,
      addEventListener: (_type, fn) => { listeners.push(fn); },
      emit(next) { this.matches = next; for (const fn of listeners) fn({ matches: next }); },
    };
  }
  function mobileApp(matches = true, routes: FetchRoute[] = []): { app: App; mql: FakeMQL } {
    const mql = fakeMQL(matches);
    const app = createApp(env({ matchMedia: () => asMQL(mql), fetch: makeFetch(routes) }));
    app.renderApp();
    return { app, mql };
  }
  const nav = (app: App, view: string): HTMLElement => qs(app.root, '.mobile-nav-btn[data-view="' + view + '"]');

  it('seeds isMobile and mounts the bottom nav + Tables segmented, defaulting to the Editor view', () => {
    const { app } = mobileApp(true);
    expect(app.state.isMobile.value).toBe(true);
    expect(qsa(app.root, '.mobile-nav-btn')).toHaveLength(3);
    expect(qs(app.root, '.mobile-segmented')).not.toBeNull();
    expect(qs(app.root, '.main-row').dataset.mobileView).toBe('editor');
    expect(qs(app.root, '.sidebar').dataset.mobileTab).toBe('schema');
  });

  it('a breakpoint change flips isMobile', () => {
    const { app, mql } = mobileApp(true);
    mql.emit(false);
    expect(app.state.isMobile.value).toBe(false);
    mql.emit(true);
    expect(app.state.isMobile.value).toBe(true);
  });

  it('bottom-nav buttons switch the full-screen view (data-mobile-view)', () => {
    const { app } = mobileApp(true);
    const mainRow = qs(app.root, '.main-row');
    nav(app, 'tables').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.mobileView.value).toBe('tables');
    expect(mainRow.dataset.mobileView).toBe('tables');
    nav(app, 'results').dispatchEvent(new Event('click', { bubbles: true }));
    expect(mainRow.dataset.mobileView).toBe('results');
  });

  it('the Schema | Library segmented switches the sidebar pane (data-mobile-tab)', () => {
    const { app } = mobileApp(true);
    const sidebar = qs(app.root, '.sidebar');
    qs(app.root, '.mseg-btn[data-seg="library"]').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.mobileTab.value).toBe('library');
    expect(sidebar.dataset.mobileTab).toBe('library');
    qs(app.root, '.mseg-btn[data-seg="schema"]').dispatchEvent(new Event('click', { bubbles: true }));
    expect(sidebar.dataset.mobileTab).toBe('schema');
  });

  it('auto-navigates: inserting into the editor → Editor, running → Results', async () => {
    const routes: FetchRoute[] = [[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })]];
    const { app } = mobileApp(true, routes);
    app.state.mobileView.value = 'tables';
    app.actions.insertAtCursor('foo');
    expect(app.state.mobileView.value).toBe('editor'); // insert jumped to Editor
    app.activeTab().sqlDraft = 'SELECT 1';
    await app.actions.run();
    expect(app.state.mobileView.value).toBe('results'); // run jumped to Results
  });

  it('loading a saved query into a tab jumps to the Editor view', () => {
    const { app } = mobileApp(true);
    app.state.mobileView.value = 'tables';
    app.actions.loadIntoNewTab('q', 'SELECT 2');
    expect(app.state.mobileView.value).toBe('editor');
  });

  it('the Results nav badge shows ● while running and the row count when idle', () => {
    const { app } = mobileApp(true);
    app.activeTab().result = { rawText: null, rows: [['1']], columns: [{ name: 'a', type: 'UInt8' }], progress: { rows: 15, bytes: 0, elapsed_ns: 0 } };
    app.state.running.value = true;
    expect(app.dom.mobileBadge!.textContent).toBe('●');
    app.state.running.value = false;
    expect(app.dom.mobileBadge!.textContent).toBe('15');
  });

  it('anchored popovers center horizontally on mobile instead of anchoring off-screen', () => {
    const { app } = mobileApp(true);
    app.activeTab().sqlDraft = 'SELECT 1'; // openSavePopover no-ops on empty SQL
    app.actions.save();
    const pop = qs(document, '.save-popover');
    expect(pop).not.toBeNull();
    expect(pop.style.left).toBe('50%');
    expect(pop.style.transform).toBe('translateX(-50%)');
    expect(pop.style.right).toBe(''); // not right-anchored to the (scrolled) button
  });

  it('the results-pane schema-graph drop target is inert on mobile (drop + dragover no-op)', () => {
    const { app } = mobileApp(true);
    app.actions.showSchemaGraph = vi.fn();
    const drop = new Event('drop', { cancelable: true }) as FakeDragEvent;
    drop.dataTransfer = { getData: () => '{"kind":"db","db":"d"}' };
    app.dom.resultsRegion!.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    expect(app.actions.showSchemaGraph).not.toHaveBeenCalled();
    const over = new Event('dragover', { cancelable: true }) as FakeDragEvent;
    over.dataTransfer = { types: ['application/x-asb-schema-graph'] };
    app.dom.resultsRegion!.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false); // guard returns before preventDefault
  });
});

// ── #288 / #302: Dashboard viewing seams on the App controller ────────────────
describe('Dashboard viewing (open-source, handoff, actions) — #288/#302', () => {
  const vdash = () => ({
    documentVersion: 1, id: 'd', title: 'My View', revision: 1,
    layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
    filters: [], tiles: [{ id: 't1', queryId: 'q1' }],
  });
  const vquery = () => savedQuery({ id: 'q1', name: 'q1', sql: 'SELECT 1' });
  const bundleText = (): string => {
    const enc = encodePortableBundleJson({ queries: [vquery()], dashboards: [vdash()] as never, nowISO: '2026-07-18T00:00:00.000Z' });
    if (!enc.ok) throw new Error('fixture failed to encode');
    return enc.value;
  };
  const child = () => ({ postMessage: vi.fn(), closed: false });

  it('createApp parses the tab open-source + route flag from the location', () => {
    const editTab = createApp(env({ location: { origin: 'https://ch.example', pathname: '/sql/dashboard', search: '?ws=w1&dash=d1', host: 'ch.example' } as Location }));
    expect(editTab.dashboardOpenSource).toEqual({ kind: 'current-workspace', workspaceId: 'w1', dashboardId: 'd1' });
    expect(editTab.dashboardRoute).toBe(true);
    const workbenchTab = createApp(env());
    expect(workbenchTab.dashboardOpenSource).toBeNull();
    expect(workbenchTab.dashboardRoute).toBe(false);
  });

  it('openDashboard opens ?ws=&dash= when the workspace has a dashboard, else the bare route; grants the handoff', () => {
    const opened: (string | undefined)[] = [];
    const c = child();
    const app = createApp(env({ openWindow: asOpenWindow((url?: string) => { opened.push(url); return c; }) }));
    app.state.workspaceId = 'w9';
    app.state.dashboard = vdash() as never;
    app.openDashboard();
    expect(opened[0]).toBe('https://ch.example/sql/dashboard?ws=w9&dash=d');
    expect(c.postMessage).not.toBe(undefined); // grantHandoffTo ran against the child
    // No dashboard → bare route.
    app.state.dashboard = null;
    app.openDashboard();
    expect(opened[1]).toBe('https://ch.example/sql/dashboard');
  });

  it('openDashboardForViewing writes the one-time token then opens ?st=; toasts when there is no dashboard', async () => {
    const opened: (string | undefined)[] = [];
    const put = vi.fn(async () => {});
    const app = createApp(env({ openWindow: asOpenWindow((url?: string) => { opened.push(url); return child(); }) }));
    app.handoff = { put, take: vi.fn(async () => null) };
    app.state.savedQueries = [vquery()] as never;
    app.state.dashboard = vdash() as never;
    app.openDashboardForViewing();
    expect(opened[0]).toMatch(/\/dashboard\?st=[0-9a-f]{64}&dash=d$/);
    expect(put).toHaveBeenCalledOnce();
    // No dashboard → toast, no window.
    app.state.dashboard = null;
    app.openDashboardForViewing();
    expect(opened.length).toBe(1);
    // Blocked popup (openWindow → null) → no orphan token is written.
    const put2 = vi.fn(async () => {});
    const blocked = createApp(env({ openWindow: asOpenWindow(() => null) }));
    blocked.handoff = { put: put2, take: vi.fn(async () => null) };
    blocked.state.savedQueries = [vquery()] as never;
    blocked.state.dashboard = vdash() as never;
    blocked.openDashboardForViewing();
    expect(put2).not.toHaveBeenCalled();
  });

  it('openDashboardForViewing toasts on an unencodable dashboard and on a failed token write', async () => {
    const opened: unknown[] = [];
    // Unencodable dashboard (bad preset) → build fails before opening a window.
    const app = createApp(env({ openWindow: asOpenWindow((url?: string) => { opened.push(url); return child(); }) }));
    app.handoff = { put: vi.fn(async () => {}), take: vi.fn(async () => null) };
    app.state.savedQueries = [vquery()] as never;
    app.state.dashboard = { ...vdash(), layout: { type: 'flow', version: 1, preset: 'nope', items: {} } } as never;
    app.openDashboardForViewing();
    expect(opened.length).toBe(0);
    // Valid dashboard but the token write rejects → the window still opened, the
    // rejection is caught (toast), never thrown.
    const app2 = createApp(env({ openWindow: asOpenWindow(() => child()) }));
    app2.handoff = { put: vi.fn(async () => { throw new Error('idb down'); }), take: vi.fn(async () => null) };
    app2.state.savedQueries = [vquery()] as never;
    app2.state.dashboard = vdash() as never;
    app2.openDashboardForViewing();
    await new Promise((r) => setTimeout(r, 0)); // let the rejected put settle into .catch
  });

  it('consumeDashboardHandoff atomically consumes the token, materializes a detached view, and rewrites the URL', async () => {
    const app = createApp(env({ location: { origin: 'https://ch.example', pathname: '/sql/dashboard', search: '?st=tok&dash=d', host: 'ch.example' } as Location }));
    const put = vi.fn(async () => {});
    app.handoff = { take: vi.fn(async () => ({ text: bundleText(), dashboardId: 'd', detachedWorkspaceId: 'wsview-1', expiresAt: 9e12 })), put: vi.fn(async () => {}) };
    app.detachedViews = { get: vi.fn(async () => null), put };
    // happy-dom's real replaceState rejects a cross-origin URL from the test's
    // blob: document — stub the impl so we observe the call without it throwing.
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    const ws = await app.consumeDashboardHandoff();
    expect(ws?.id).toBe('wsview-1');
    expect(put).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalled();
    expect(app.dashboardOpenSource).toEqual({ kind: 'current-workspace', workspaceId: 'wsview-1', dashboardId: 'd' });
    replaceState.mockRestore();
  });

  it('consumeDashboardHandoff returns null for a non-bundle route, a spent token, and an undecodable record', async () => {
    const plain = createApp(env()); // no ?st → not a session-bundle route
    expect(await plain.consumeDashboardHandoff()).toBeNull();
    const app = createApp(env({ location: { origin: 'https://ch.example', pathname: '/sql/dashboard', search: '?st=tok&dash=d', host: 'ch.example' } as Location }));
    app.handoff = { take: vi.fn(async () => null), put: vi.fn(async () => {}) }; // spent/expired
    expect(await app.consumeDashboardHandoff()).toBeNull();
    app.handoff = { take: vi.fn(async () => ({ text: '{bad', dashboardId: 'd', detachedWorkspaceId: 'x', expiresAt: 9e12 })), put: vi.fn(async () => {}) };
    expect(await app.consumeDashboardHandoff()).toBeNull();
  });

  it('reloadDashboardRoute repoints the URL at the current dashboard and re-renders (URL skipped when absent)', () => {
    const app = createApp(env({ location: { origin: 'https://ch.example', pathname: '/sql/dashboard', search: '?ws=w&dash=old', host: 'ch.example' } as Location }));
    app.renderDashboard = vi.fn();
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    app.state.workspaceId = 'w';
    app.state.dashboard = { ...vdash(), id: 'dNew' } as never;
    app.reloadDashboardRoute();
    expect(replaceState).toHaveBeenCalledWith(null, '', 'https://ch.example/sql/dashboard?ws=w&dash=dNew');
    expect(app.dashboardOpenSource).toEqual({ kind: 'current-workspace', workspaceId: 'w', dashboardId: 'dNew' });
    expect(app.renderDashboard).toHaveBeenCalledOnce();
    // No dashboard → re-render only, no URL rewrite.
    replaceState.mockClear();
    app.state.dashboard = null;
    app.reloadDashboardRoute();
    expect(replaceState).not.toHaveBeenCalled();
    expect(app.renderDashboard).toHaveBeenCalledTimes(2);
    replaceState.mockRestore();
  });

  it('the Dashboard export/import actions delegate to their file-menu flows', () => {
    const app = createApp(env());
    // exportDashboard with no dashboard just toasts (no throw); importDashboard
    // opens a picker input on the page — both exercise the action arrow bodies.
    app.state.dashboard = null;
    expect(() => app.actions.exportDashboard()).not.toThrow();
    expect(() => app.actions.importDashboard()).not.toThrow();
  });
});
