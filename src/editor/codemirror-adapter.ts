// The CodeMirror 6 EditorPort adapter (#21): replaces the hand-rolled
// textarea editor behind the #143 seam. CM6 owns the DOM — undo history,
// measured text, IME/touch, search panel, completion UI — while the app keeps
// talking through the same EditorPort, and the SQL knowledge stays pure in
// core (`completions.js` ranking, reference data). Injected via
// `createApp(env)` (`env.Editor`, the Chart/Dagre precedent) exactly like the
// textarea adapter it replaces; app-level tests keep running on
// `createNoopPort`.
//
// Testing note: the adapter is unit-tested against the REAL CM6 under
// happy-dom (construct/dispatch/undo all work headless). The inner pieces —
// dialect builder, completion source, hover source, drop handler, input
// handler, Tab command — are exported for direct invocation where headless
// measurement (`coordsAtPos`/`posAtCoords`) makes event-driven coverage
// unreliable.

import type { Extension } from '@codemirror/state';
import { EditorState, Compartment, Annotation, Transaction, Prec } from '@codemirror/state';
import type { Tooltip } from '@codemirror/view';
import { EditorView, keymap, dropCursor, hoverTooltip } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { bracketMatching, syntaxTree } from '@codemirror/language';
import { sql, SQLDialect } from '@codemirror/lang-sql';
import type { Completion, CompletionResult } from '@codemirror/autocomplete';
import { autocompletion, closeBrackets, closeBracketsKeymap, acceptCompletion, startCompletion, completionStatus } from '@codemirror/autocomplete';
import { h } from '../ui/dom.js';
import { completionContext, rankCompletions, wordAt } from '../core/completions.js';
import type {
  AssembledReference, CompletionContext as CoreCompletionContext,
  CompletionFunctionEntry, CompletionItem as CoreCompletionItem,
} from '../core/completions.js';
import { fromScopeAt, pendingColumnLoads } from '../core/from-scope.js';
import type { PendingLoadDb } from '../core/from-scope.js';
import { lexSql } from '../core/sql-lex.js';
import { toSubquery, clamp } from '../core/format.js';
import { activeTab } from '../state.js';
import type { AppState } from '../state.js';
import { IDENT_MIME, SUBQUERY_MIME, COLUMN_TYPE_MIME } from '../ui/dnd-mime.js';
import { codePresentationExtensions, codeSearchKeymap } from './codemirror-base.js';
import type { EditorPort, EditorSelection } from './editor-port.types.js';

// ── Local typed contracts ───────────────────────────────────────────────────
// core/completions.js's own `AssembledReference`/`CompletionContext` shapes
// are imported directly (below) — this adapter's `app.refData` and the
// completion-context plumbing match them exactly. `app.completions` keeps its
// OWN wider local `CompletionItem` (kind: string, not the closed
// `CompletionKind` union): this adapter renders an unrecognized `kind` as a
// bare CSS chip rather than rejecting it (see `completionSourceFor`'s
// `type: it.kind` below), so its own candidate contract is deliberately more
// permissive than `core/completions.ts`'s closed one.

/** The `applyFor`-relevant subset of a completion candidate — a caller (this
 *  suite's tests included) may omit `insert`/`caretBack`/other fields; only
 *  `label`/`insert`/`caretBack` drive how accepting the candidate edits the
 *  doc. `insert` stays optional to match `core/completions.ts`'s own
 *  `CompletionItem` (a bare test fixture there never needs to fake it
 *  either) — `buildCompletions` always sets it in practice. */
interface ApplyItem {
  label: string;
  insert?: string;
  caretBack?: number;
}

/** The `infoFor`-relevant subset — the candidate's kind (which doc source to
 *  use), its label, and the two optional fields a column candidate carries
 *  when its `detail` is a compacted type summary (#177). */
interface InfoItem {
  kind: string;
  label: string;
  detail?: string;
  fullType?: string;
}

/** The complete completion-candidate shape `app.completions` holds (built by
 *  core/completions.js's `buildCompletions`, which in practice never emits
 *  anything outside `CompletionKind` — but this adapter's own contract stays
 *  open on `kind`, see above). `completionSourceFor` reads every field;
 *  `rankCompletions`/`resolveScopeAlias` (core/completions.js) read `parent`. */
interface CompletionItem extends ApplyItem, InfoItem {
  parent?: string;
}

/**
 * The subset of CM6's `CompletionContext` this source reads — `state`,
 * `pos`, `explicit` — rather than the full class (which also demands
 * `view`/`tokenBefore`/`matchBefore`/`aborted`/`addEventListener`). The real
 * class satisfies this shape, so the returned function is still assignable
 * wherever a real `CompletionSource` is expected (`autocompletion({ override
 * })` below); tests can also call it directly with a plain
 * `{ state, pos, explicit }` object, as `CompletionContext`'s own docs
 * recommend for test code.
 */
export interface SqlCompletionContext {
  state: EditorState;
  pos: number;
  explicit: boolean;
}

/** `langExtensionFor`'s own narrow app slice — just the reference data (or
 *  its absence — no connection yet). Declared `unknown` (not
 *  `AssembledReference` directly) so the real, injected `app` controller's
 *  own placeholder type (`App.refData` in `ui/app.types.ts`, kept loose
 *  there since nothing else reads its actual shape) is assignable here too —
 *  `createCodeMirrorEditor` must stay assignable to `env.types.ts`'s
 *  `Editor?: (app: App) => EditorPort` seam. This adapter is the one real
 *  consumer of the precise shape, so it narrows with a local `as` at each
 *  read site instead. */
interface DialectApp {
  refData?: unknown;
}

/** `hoverSourceFor`/`infoFor`'s own narrow app slice: the reference data plus
 *  the lazily-fetched entity-doc loader — independent of the fuller
 *  `CodeMirrorEditorApp` the port itself needs (tests call these two
 *  directly with exactly this shape). */
interface ReferenceApp extends DialectApp {
  entityDoc?: (name: string) => Promise<string | null>;
}

/** The subset of a DOM drag event `handleDrop` reads — real `DragEvent`s (the
 *  view's own drop listener passes them straight through) and the plain
 *  fixture objects tests construct both satisfy it. */
export interface DropEvent {
  dataTransfer: { getData(type: string): string } | null;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

/** The injected app controller's slice this adapter reads/writes: the
 *  reference/completion data assembled from core/completions.js, the
 *  lazily-fetched entity-doc loader, the `dom.sqlEditorView` handoff other
 *  app code reads (e2e/debug only — the app itself talks through the port),
 *  the tab/schema state this port syncs against, and the FROM-scope column
 *  loader (#84). */
export interface CodeMirrorEditorApp extends ReferenceApp {
  state: AppState;
  dom: { sqlEditorView?: EditorView };
  /** `unknown` for the same reason as `DialectApp.refData` above (matches
   *  `App.completions`'s own loose `Json` placeholder); narrowed with a
   *  local `as` in `completionSourceFor`. */
  completions?: unknown;
  actions: { loadColumns(db: string, table: string): Promise<void> };
}

// Programmatic state syncs (tab switch, external tab.sqlDraft reconcile) must not
// reach onDocChange subscribers — the app-level subscriber writes tab.sqlDraft +
// dirty, and a tab switch dirtying the incoming tab would be a bug. User edits
// and port edits (insertAtCursor/replaceDocument/drop) DO emit, matching the
// textarea adapter's input-event semantics. Sync transactions also stay out
// of the undo history: ⌘Z must not resurrect a doc the app already replaced.
export const syncTx = Annotation.define<boolean>(); // exported for the mixed-update emit spec
const syncAnnotations = () => [syncTx.of(true), Transaction.addToHistory.of(false)];
// The whole-document change spec — shared by replaceDocument and both
// syncFromState reconcile paths so their shapes can't drift.
const fullReplace = (state: EditorState, text: string) => ({ changes: { from: 0, to: state.doc.length, insert: text } });

// String/comment/backtick-ident syntax nodes — the contexts where bracket
// auto-close and hover docs must stay quiet (the old adapter's maskLiterals
// role, now answered by CM6's syntax tree).
const LITERAL_NODE = /String|Comment|QuotedIdentifier/;

/**
 * The ClickHouse-flavored SQL language extension for the current reference
 * data: server keywords/function names when loaded (#25), the built-in
 * fallback sets otherwise. Both word lists are lowercased — lang-sql looks
 * dialect words up via `word.toLowerCase()`, so a verbatim `toDateTime` would
 * never match. Backticks and double quotes are identifier quotes in
 * ClickHouse; strings take backslash escapes. Auto-close covers `(`, `[`, and
 * the three quotes (parity with the deleted core/editor-brackets.js) — `{`
 * deliberately doesn't pair (it would fight the #134 `{name:Type}` variables).
 */
export function langExtensionFor(app: DialectApp): Extension[] {
  // `as`: `app.refData` is `unknown` here (see `DialectApp`'s doc comment) —
  // this adapter is the one real consumer of its actual shape.
  const ref = app.refData as AssembledReference | null | undefined;
  const dialect = SQLDialect.define({
    keywords: (ref ? ref.keywords : []).join(' ').toLowerCase(),
    builtin: Object.keys(ref ? ref.functions : {}).join(' ').toLowerCase(),
    backslashEscapes: true,
    identifierQuotes: '`"',
    // ClickHouse comment/heredoc forms (#182). These are editor approximations
    // of the authoritative core scanner (sql-spans.js): `hashComments` treats
    // every `#` as a comment (it can't express the space-or-`!` follow set), and
    // CM6's quoted-identifier escaping differs — but these affect only CM6-owned
    // editor behavior (highlighting, tree-based bracket/quote guards, hover),
    // never core completion/split/param analysis. `doubleQuotedStrings` stays
    // default-false: `"` is an identifier delimiter in ClickHouse.
    hashComments: true,
    slashComments: true,
    doubleDollarQuotedStrings: true,
  });
  return [
    sql({ dialect }),
    dialect.language.data.of({ closeBrackets: { brackets: ['(', '[', "'", '"', '`'] } }),
  ];
}

// Closers and quotes our input guard steps over when typed directly before
// that same character.
const STEP_OVER = new Set([')', ']', "'", '"', '`']);

/**
 * Pairing guards CM6 doesn't provide (editor-brackets.js parity), run ahead
 * of closeBrackets (Prec.high):
 * - type-over: a closer/quote typed directly before that same character steps
 *   over it — including pre-existing text (CM6's closedBracketAt only tracks
 *   pairs it inserted this session) and inside literals, so a string can
 *   always be closed normally;
 * - brackets never pair inside String/Comment/QuotedIdentifier (closeBrackets
 *   is only tree-aware for same-char quotes);
 * - quotes never pair inside Comment/QuotedIdentifier, and a quote typed over
 *   a selection inside a String replaces it instead of wrapping.
 * Mirrors closeBrackets' own bail-outs first: never rewrite the DOM mid-IME
 * composition, and only act when the reported range IS the selection (a
 * browser-generated correction elsewhere must not be re-anchored to it).
 */
export function inputGuards(view: EditorView, from: number, to: number, text: string): boolean {
  if (text.length !== 1) return false;
  if (view.compositionStarted || view.state.readOnly) return false;
  const sel = view.state.selection.main;
  if (from !== sel.from || to !== sel.to) return false;
  if (from === to && STEP_OVER.has(text) && view.state.sliceDoc(to, to + 1) === text) {
    view.dispatch({ selection: { anchor: to + 1 }, userEvent: 'input.type', scrollIntoView: true });
    return true;
  }
  const isBracket = text === '(' || text === '[';
  const isQuote = text === "'" || text === '"' || text === '`';
  if (!isBracket && !isQuote) return false;
  const node = syntaxTree(view.state).resolveInner(from, -1).name;
  const quiet = isBracket
    ? LITERAL_NODE.test(node)
    : /Comment|QuotedIdentifier/.test(node) || (from !== to && /String/.test(node));
  if (!quiet) return false;
  view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type', scrollIntoView: true });
  return true;
}

/**
 * Completion source: CM6's UI over the pure core ranking (#26 parity v0).
 * `filter: false` keeps `rankCompletions`' order (CM6 would fuzzy-rescore and
 * dedup otherwise). Candidates come from `app.completions` at call time, so
 * schema/reference updates need no reconfigure. Never queries — `info` resolves
 * through app.entityDoc's lazy cache, and only for the row the user rests on.
 */
export function completionSourceFor(app: CodeMirrorEditorApp): (ctx: SqlCompletionContext) => CompletionResult | null {
  return (ctx) => {
    // completionContext reads at most to the end of the caret's token — slice
    // to the line end instead of serializing the whole rope per keystroke
    // (cutting AT the caret would misread an open backtick-identifier whose
    // escaped-backtick ends up last-before-the-cut as already closed).
    const doc = ctx.state.sliceDoc(0, ctx.state.doc.lineAt(ctx.pos).to);
    // Lex the caret prefix once and share it: both completionContext (open-
    // backtick detection) and fromScopeAt need the same token stream.
    const toks = lexSql(doc);
    const c: CoreCompletionContext = completionContext(doc, ctx.pos, toks);
    if (!c.qualified && c.word.length < 1 && !ctx.explicit) return null;
    // FROM-aware ranking (#84): resolve `e.` → events, and scope unqualified
    // columns to the statement's FROM/JOIN tables. The slice already covers the
    // lines before the caret, so a FROM above the caret is in view; a FROM below
    // it degrades gracefully to the global pool (no scope).
    c.scope = fromScopeAt(doc, ctx.pos, toks);
    // `as`: `app.completions` is `unknown` here (see `CodeMirrorEditorApp`'s
    // doc comment). Real values are always core/completions.ts's own
    // `buildCompletions` output (`CompletionKind`-typed); this adapter's own
    // `CompletionItem` deliberately keeps `kind: string` open for its
    // pass-through rendering (see the top-of-file note), and
    // `rankCompletions` only ever compares `kind` against its own known
    // literals, so the cast is behaviorally safe either way.
    const items = rankCompletions((app.completions as CompletionItem[] | undefined || []) as CoreCompletionItem[], c);
    if (!items.length) return null;
    return {
      from: c.from,
      to: c.to,
      filter: false,
      options: items.map((it): Completion => ({
        label: it.label,
        detail: it.detail || undefined,
        type: it.kind, // chip glyph via .cm-completionIcon-<kind>; unknown kinds get the base '·'
        apply: applyFor(it),
        info: infoFor(app, it),
      })),
    };
  };
}

// How accepting a candidate edits the doc. Functions insert `name()` with the
// caret pulled between the parens (`caretBack`), so it needs a custom apply —
// a plain string apply would land the caret after the `)`.
export function applyFor(it: ApplyItem): Completion['apply'] {
  if (!it.caretBack) return it.insert === it.label ? undefined : it.insert;
  const caretBack = it.caretBack;
  // `!`: a `caretBack` candidate always pairs with `insert` in practice
  // (buildCompletions' only caretBack-producing branch sets both together).
  const insert = it.insert!;
  return (view, _completion, from, to) => {
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length - caretBack },
      userEvent: 'input.complete',
    });
  };
}

/** The `() => Node` (or async-resolving) shape CM6's `Completion.info` /
 *  `Tooltip.create` info functions must return — a bare string is only legal
 *  when `info` itself IS the string; CM6's addInfoPane appendChild()s the
 *  result, so a FUNCTION must yield a real DOM node. */
type InfoFn = () => Node | null | Promise<Node | null>;

// The active row's description: static keyword docs immediately, function
// docs lazily via app.entityDoc (cached, one query per name ever — #27).
// CM6 shows it as a side tooltip (the old dropdown used a footer). An `info`
// FUNCTION must yield a DOM node (a bare string is only legal when `info`
// itself is the string) — CM6's addInfoPane appendChild()s the result.
export function infoFor(app: ReferenceApp, it: InfoItem): InfoFn | undefined {
  const doc = (text: string | null | undefined): Node | null => (text ? h('div', null, text) : null);
  if (it.kind === 'keyword') {
    // `as`: `app.refData` is `unknown` (see `DialectApp`'s doc comment); read
    // fresh on every call (not hoisted) — CM6 may invoke this `info` callback
    // well after refData has since changed (#25 load lands mid-session).
    return () => {
      const refData = app.refData as AssembledReference | null | undefined;
      return doc(refData && refData.keywordDocs[it.label.toUpperCase()]);
    };
  }
  if (it.kind === 'fn' || it.kind === 'agg' || it.kind === 'cast') {
    if (!app.entityDoc) return undefined;
    // `!`: just checked above; a deferred closure doesn't retain that
    // narrowing across the function boundary, but the guard already ran.
    return () => Promise.resolve(app.entityDoc!(it.label)).then(doc);
  }
  // A column whose `detail` is a compacted type summary (#177) exposes the full
  // declared type here — CM6's detail column has no native title fallback.
  if (it.kind === 'column' && it.fullType && it.fullType !== it.detail) {
    return () => doc(it.fullType);
  }
  return undefined;
}

// SQL function calls are case-insensitive: resolve the hovered word against
// the reference keys the way the old editor-intel lookupFn did (#27) — exact,
// then lower (server keys are mostly canonical-lowercase), then UPPER. Own
// properties only: a column named `constructor` must not hover a phantom card
// off Object.prototype.
const own = <T>(m: Record<string, T>, k: string): T | undefined =>
  (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined);
const lookupFn = (functions: Record<string, CompletionFunctionEntry>, word: string): CompletionFunctionEntry | undefined =>
  own(functions, word) || own(functions, word.toLowerCase()) || own(functions, word.toUpperCase());

/**
 * Hover docs (#27 parity v0): keyword docs from the static set, function
 * signature + return type + lazily-fetched description. Quiet inside
 * strings/comments/quoted identifiers (no phantom docs over literal prose).
 * Signature help (the caret-following arg highlighter) is dropped in v0 —
 * #60 rebuilds docs properly on this foundation.
 */
export function hoverSourceFor(app: ReferenceApp): (view: EditorView, pos: number) => Tooltip | null {
  return (view, pos) => {
    // `as`: `app.refData` is `unknown` here (see `DialectApp`'s doc comment).
    const refData = app.refData as AssembledReference | null | undefined;
    if (!refData) return null;
    if (LITERAL_NODE.test(syntaxTree(view.state).resolveInner(pos, 0).name)) return null;
    // Identifiers can't span lines — scan the line, not the whole doc.
    const line = view.state.doc.lineAt(pos);
    const w = wordAt(line.text, pos - line.from);
    if (!w) return null;
    const kwDoc = refData.keywordDocs[w.word.toUpperCase()];
    const fn = lookupFn(refData.functions, w.word);
    if (!kwDoc && !fn) return null;
    return {
      pos: line.from + w.from,
      end: line.from + w.to,
      create: () => {
        const dom = h('div', { class: 'hover-card' });
        if (fn) {
          dom.appendChild(h('div', { class: 'hover-sig' }, fn.sig || w.word + '()',
            fn.ret ? h('span', { class: 'hover-ret' }, ' → ' + fn.ret) : null));
          const doc = h('div', { class: 'hover-doc' }, fn.desc || '');
          dom.appendChild(doc);
          if (!fn.desc && app.entityDoc) {
            Promise.resolve(app.entityDoc(w.word)).then((d) => { if (d) doc.textContent = d; });
          }
        } else {
          dom.appendChild(h('div', { class: 'hover-doc' }, kwDoc));
        }
        return { dom };
      },
    };
  };
}

/**
 * Drop handler for the app's drag sources (schema identifiers, a column's full
 * type — #186, saved/history queries). All land at the POINTER position
 * (falling back to the caret when the point doesn't map to text) — the
 * dropCursor extension shows the user exactly that target while dragging.
 * Identifier precedence is checked first so db/table/column-name drops keep
 * their existing behavior even if a future source ever supplied more than one
 * supported MIME. Returns true when it consumed the event (so CM6's native
 * text drop can't double-insert). Exported for direct tests — happy-dom's
 * posAtCoords can't exercise the coordinate fallback via real events.
 */
export function handleDrop(app: CodeMirrorEditorApp, view: EditorView, e: DropEvent): boolean {
  const dt = e.dataTransfer;
  if (!dt) return false;
  const insertAt = (text: string): boolean => {
    const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const pos = at == null ? view.state.selection.main.head : at;
    e.preventDefault();
    view.dispatch({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: pos + text.length },
      userEvent: 'input.drop',
      scrollIntoView: true,
    });
    view.focus();
    return true;
  };
  const ident = dt.getData(IDENT_MIME);
  if (ident) return insertAt(ident);
  const type = dt.getData(COLUMN_TYPE_MIME);
  if (type) return insertAt(type);
  const sub = dt.getData(SUBQUERY_MIME);
  if (sub) {
    const text = toSubquery(sub);
    if (!text) return false;
    return insertAt(text);
  }
  return false; // not our drag — leave native behavior alone
}

// Tab inserts two literal spaces (parity with the textarea editor — no indent
// magic); an open completion's Tab-accept is bound ahead of it.
export function insertTwoSpaces(view: EditorView): boolean {
  view.dispatch(view.state.replaceSelection('  '), { userEvent: 'input.type', scrollIntoView: true });
  return true;
}

// Idle delay before the FROM-scope column prefetch runs (#84). Column metadata
// is fetched on this debounced tick, NEVER on the keystroke path (the standing
// editor rule) — long enough that a burst of typing collapses to one tick.
const COLUMN_LOAD_DELAY_MS = 300;

/**
 * FROM-driven lazy column loading (#84): parse the statement around the caret,
 * find its FROM/JOIN tables whose columns aren't loaded yet, and fetch them via
 * the app's existing `loadColumns` (which writes the `'loading'` sentinel to
 * dedupe, caches per connection, and rebuilds `app.completions`). Uses the whole
 * document (not the keystroke-path line slice) so a FROM below the caret still
 * prefetches. Resolves to whether it fetched anything — the caller refreshes an
 * open dropdown only after re-checking the view is still live (destroy race).
 * Exported for direct tests (timer-free).
 */
export function loadScopeColumns(app: CodeMirrorEditorApp, view: EditorView): Promise<boolean> {
  const scope = fromScopeAt(view.state.doc.toString(), view.state.selection.main.head);
  // `as`: `state.ts`'s schema signal is intentionally kept as `unknown[] |
  // null` (the schema shape is owned by other modules, not state.ts);
  // `pendingColumnLoads` only ever reads the `{db, tables:[{name, columns}]}`
  // shape it declares itself as `PendingLoadDb`.
  const pending = pendingColumnLoads(scope, app.state.schema.value as PendingLoadDb[] | null);
  if (!pending.length) return Promise.resolve(false);
  return Promise.all(pending.map((p) => app.actions.loadColumns(p.db, p.table))).then(() => true);
}

/**
 * The CM6 editor behind the EditorPort seam. Port methods tolerate pre-mount
 * calls (no view yet → no-op / empty results). mount() is re-runnable: a
 * renderApp re-run (e.g. sign-out → sign-in) passes a fresh container and the
 * live view.dom is reparented into it — same view, same subscriptions, no
 * zombies. destroy() is terminal (see editor-port.js).
 */
export function createCodeMirrorEditor(app: CodeMirrorEditorApp): EditorPort {
  const subs = new Set<(value: string) => void>();
  const emit = (value: string): void => { for (const cb of subs) cb(value); };
  const langCompartment = new Compartment();
  const tabStates = new Map<string, EditorState>(); // tabId → parked EditorState (per-tab undo)
  // Resolved lazily at first mount, NOT at factory time: createApp constructs
  // the port before it assembles the built-in fallback refData, and an eager
  // snapshot here would mount an empty dialect (no keywords at all).
  let langExt: Extension[] | null = null;
  let view: EditorView | null = null;
  let shownTabId: string | null = null;
  let colTimer: ReturnType<typeof setTimeout> | null = null; // debounce handle for the FROM-scope column prefetch (#84)

  // Schedule the debounced idle-tick column load (#84). Coalesces a typing
  // burst into one tick; cleared on destroy so a torn-down view never fires.
  // After the async fetch, re-check `view === v` (the file's replaceDocument
  // idiom) before touching the view: a destroy() between tick and resolve nulls
  // `view`, and re-running the completion source on a torn-down view would
  // throw. Refresh a live, open completion so freshly-loaded columns appear.
  const scheduleColumnLoad = (): void => {
    if (colTimer) clearTimeout(colTimer);
    colTimer = setTimeout(() => {
      colTimer = null;
      const v = view;
      if (!v) return;
      loadScopeColumns(app, v).then((loaded) => {
        if (loaded && view === v && completionStatus(v.state)) startCompletion(v);
      });
    }, COLUMN_LOAD_DELAY_MS);
  };

  const extensions = (): Extension[] => [
    ...codePresentationExtensions(),
    history(),
    dropCursor(),
    bracketMatching(),
    Prec.high(EditorView.inputHandler.of(inputGuards)),
    closeBrackets(),
    // `!`: freshState (the only caller of extensions()) always resolves
    // langExt before building the extension set.
    langCompartment.of(langExt!),
    autocompletion({ override: [completionSourceFor(app)] }),
    hoverTooltip(hoverSourceFor(app)),
    codeSearchKeymap,
    keymap.of([
      { key: 'Tab', run: acceptCompletion },
      { key: 'Tab', run: insertTwoSpaces },
      ...closeBracketsKeymap,
      ...historyKeymap,
      // Global chords (⌘↵ run, ⌘⇧↵ format, ⌘S/⌘⇧S, Esc) live on the document
      // handler (main.js) — drop CM6's Mod-Enter (insertBlankLine) so ⌘↵
      // bubbles out unhandled, and its Escape (simplifySelection) so Esc with
      // a selection still cancels a running query instead of being consumed
      // (completion/search bind their own Escape and keep working).
      ...defaultKeymap.filter((b) => b.key !== 'Mod-Enter' && b.key !== 'Escape'),
    ]),
    EditorView.updateListener.of((u) => {
      // Suppress only when EVERY transaction is a sync — an update that
      // coalesces a user edit with a reconcile must still reach tab.sqlDraft.
      if (u.docChanged && !u.transactions.every((tr) => tr.annotation(syncTx))) {
        emit(u.state.doc.toString());
        scheduleColumnLoad(); // user edit → prefetch the statement's FROM columns (#84)
      }
    }),
    EditorView.domEventHandlers({
      dragover: (e) => { e.preventDefault(); return false; },
      drop: (e, v) => handleDrop(app, v, e),
    }),
  ];

  const freshState = (doc: string): EditorState => {
    if (!langExt) langExt = langExtensionFor(app);
    return EditorState.create({ doc, extensions: extensions() });
  };

  return {
    mount: (container: Element) => {
      if (!view) {
        const tab = activeTab(app.state); // state guarantees ≥1 tab
        shownTabId = tab.id;
        view = new EditorView({ state: freshState(tab.sqlDraft) });
      }
      // renderApp resets app.dom on every run — re-register the reach-in ref
      // (e2e/debug only; the app itself talks through the port).
      app.dom.sqlEditorView = view;
      container.replaceChildren(view.dom);
    },
    destroy: () => {
      subs.clear();
      tabStates.clear();
      if (colTimer) { clearTimeout(colTimer); colTimer = null; }
      if (view) view.destroy();
      view = null;
    },
    focus: () => { if (view) view.focus(); },
    hasFocus: () => !!view && view.hasFocus,
    getValue: () => (view ? view.state.doc.toString() : ''),
    getSelection: (): EditorSelection => {
      if (!view) return { start: 0, end: 0, text: '' };
      const { from, to } = view.state.selection.main;
      return { start: from, end: to, text: view.state.sliceDoc(from, to) };
    },
    insertAtCursor: (text: string) => {
      if (!view) return;
      view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
      view.focus();
    },
    replaceDocument: (text: string) => {
      if (!view) return;
      if (view.state.doc.length === text.length && view.state.doc.toString() === text) return; // idempotent Format re-run
      view.dispatch({
        ...fullReplace(view.state, text),
        selection: { anchor: text.length },
        userEvent: 'input.replace',
        scrollIntoView: true,
      });
      // Toolbar-initiated replaces (Format, SHOW CREATE) must leave ⌘Z live —
      // the old adapter focused too. Deferred a microtask: happy-dom delivers
      // selectionchange synchronously, and a focused view + an immediately
      // following range-selection dispatch would re-enter CM6's update.
      const v = view;
      queueMicrotask(() => { if (view === v) v.focus(); });
    },
    revealOffset: (pos: number) => {
      if (!view) return;
      view.dispatch({ selection: { anchor: clamp(pos | 0, 0, view.state.doc.length) }, scrollIntoView: true });
      view.focus();
    },
    syncFromState: () => {
      if (!view) return;
      const tab = activeTab(app.state);
      const ids = new Set(app.state.tabs.value.map((t) => t.id));
      for (const id of tabStates.keys()) if (!ids.has(id)) tabStates.delete(id); // closed tabs
      if (shownTabId === tab.id) {
        // Same tab (the effect also fires on unrelated tab-list changes):
        // reconcile only an external tab.sqlDraft change; equal doc = strict no-op
        // (selection/scroll/completion untouched). Length check first — the
        // effect fires on every tab op and O(doc) compares add up.
        if (view.state.doc.length !== tab.sqlDraft.length || view.state.doc.toString() !== tab.sqlDraft) {
          view.dispatch({ ...fullReplace(view.state, tab.sqlDraft), annotations: syncAnnotations() });
        }
        return;
      }
      // `!`: shownTabId is set alongside `view` in mount() (both null before
      // the first mount), so once `view` is live it is always a real tab id.
      if (ids.has(shownTabId!)) tabStates.set(shownTabId!, view.state); // park the outgoing tab (undo intact); a just-closed tab isn't kept
      let next = tabStates.get(tab.id) || null;
      if (next) {
        // A parked state may predate a refData arrival or an external tab.sqlDraft
        // write — re-apply the current language and reconcile the doc via
        // detached updates (undo history survives; no view listener fires).
        next = next.update({ effects: langCompartment.reconfigure(langExt!) }).state;
        if (next.doc.length !== tab.sqlDraft.length || next.doc.toString() !== tab.sqlDraft) {
          next = next.update({ ...fullReplace(next, tab.sqlDraft), annotations: syncAnnotations() }).state;
        }
        // Collapse the restored selection to its head: an invisible parked
        // selection would silently retarget ⌘↵/Export (which read
        // getSelection() without a focus check) — the old adapter's
        // value-reassignment collapsed it too.
        const head = clamp(next.selection.main.head, 0, next.doc.length);
        next = next.update({ selection: { anchor: head }, annotations: syncAnnotations() }).state;
      } else {
        next = freshState(tab.sqlDraft);
      }
      shownTabId = tab.id;
      view.setState(next); // setState is not a transaction — nothing emits
    },
    refreshReference: () => {
      // Server keyword/function sets arrived (#25): swap the dialect on the
      // live view. Parked tab states get it on restore (syncFromState).
      langExt = langExtensionFor(app);
      if (view) view.dispatch({ effects: langCompartment.reconfigure(langExt) });
    },
    onDocChange: (cb: (value: string) => void) => { subs.add(cb); return () => subs.delete(cb); },
  };
}
