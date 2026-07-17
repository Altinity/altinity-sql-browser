// #276 Phase 4B2's ExportService — the streaming single-file export (issue
// #87) and multi-statement script export (issue #99) POLICY extracted from
// app.ts (issue #276 §5), a PURE MOVE of the export bodies (already
// re-pointed onto `WorkbenchParameterSession`/`app.params` by Phase 4B1)
// wholesale: `exportEntry`'s statement-count dispatch, `exportDirect`'s
// picker-first/stream/hold-back-buffer path, `exportScriptEntry`/
// `exportScript`'s directory-picker/per-statement transport loop, and both
// cancel paths — byte-identical to app.ts's own prior history for these
// functions. Constructible without App/AppState/DOM, like
// `workbench-parameter-session.ts` before it; no imports from `src/ui/**` or
// `src/editor/**` (check:arch enforces this).
//
// Deliberately NOT included (mirrors the issue's own carve-outs, same
// reasoning as workbench-parameter-session.ts's header comment):
// `canExport`/`canExportScript` (env capability checks — app.ts-owned, read
// here only through the injected `deps.canExport`/`deps.canExportScript`
// booleans), `showExportProgress` (the DOM progress banner — app.ts-owned,
// called through `deps.hooks.showExportProgress`, matching its existing call
// shape `(onCancel) => { update(bytes), remove() }`), and `downloadFile` (a
// generic Blob+anchor file-save helper with no export-specific policy — it
// builds a Blob, which is DOM/browser material, not export policy; stays in
// app.ts, used by the File menu, untouched by this move).
//
// `state.exporting` stays an `AppState` signal (mirrors `workbench-
// session.ts`'s own `state.running` precedent) — this service is its SOLE
// production writer; `deps.state` is the SAME live slice `app.state` backs
// (a structural `Pick`, not a snapshot), so `app.state.exporting.value`
// reads/the `setExportBtn` effect observe this service's writes directly, no
// re-mirroring needed.
//
// `WritableFileStreamLike`/`FileHandleLike`/`DirectoryHandleLike` (formerly
// app.ts-local seam types over the File System Access API, which this
// project's lib.dom build doesn't carry at all) move here, exported, since
// they're this service's own transport shapes now; `ExportSink` wraps
// `showSaveFilePicker`/`showDirectoryPicker` behind an injected seam (mirrors
// `app.Chart`/`app.Dagre`/the editor ports) so this module never references
// `window`/`env` directly.
//
// `ScriptExportEntry`/`ScriptExportResult` below mirror (never import)
// `src/ui/results.ts`'s identically-named, identically-shaped types: `tab.result`
// is deliberately opaque (`Record<string, unknown> | null`, state.ts) at this
// boundary — ui/results.ts is the one place that owns the real shape a run
// (or a script export) actually produces, exactly the same "produced here,
// read back there through the opaque field" relationship `core/script-
// result.ts`'s own `ScriptEntry` has with the transport service (Phase 1)
// vs. results.ts's re-export of it. `src/application/**` may never import
// `src/ui/**` (check:arch), so a structural mirror — not an import — is the
// only option; the two are kept in sync by hand (small, stable shapes).

import type { Signal } from '@preact/signals-core';
import { splitStatements, isRowReturning } from '../core/sql-split.js';
import { mergedSourceArgs } from '../core/param-pipeline.js';
import type { PreparedSource } from '../core/param-pipeline.js';
import { prepareExportSql, isSchemaMutatingSql } from '../core/format.js';
import { formatFileMeta, exportFilename, scriptExportName } from '../core/export.js';
import { findExceptionFrame } from '../core/stream.js';
import type { QueryTab } from '../state.js';
import type { ResultSort } from '../core/sort.js';
import type { ChCtx, exportQuery, runQuery, killQuery } from '../net/ch-client.js';
import type { WorkbenchParameterSession } from './workbench-parameter-session.js';

// ── File System Access seam (moved from app.ts) ─────────────────────────────

/** A `FileSystemWritableFileStream`-shaped handle — narrower than the DOM
 *  lib's own (this project's lib.dom build doesn't carry the File System
 *  Access API at all, hence the sink below being the injected seam). */
export interface WritableFileStreamLike {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
/** A `FileSystemFileHandle`-shaped handle — `ExportSink.pickFile`'s resolved
 *  value, and `DirectoryHandleLike.getFileHandle`'s. `move` (Chrome 110+) is
 *  optional — feature-detected at the one call site that uses it. */
export interface FileHandleLike {
  name: string;
  createWritable(): Promise<WritableFileStreamLike>;
  move?(name: string): Promise<void>;
}
/** A `FileSystemDirectoryHandle`-shaped handle — `ExportSink.pickDirectory`'s
 *  resolved value. */
export interface DirectoryHandleLike {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
}

/** The single-file/directory picker seam — wraps `showSaveFilePicker`/
 *  `showDirectoryPicker` (env-injected, feature-detected — see app.ts's own
 *  `canExport`/`canExportScript`) so this module never touches `window`
 *  directly. Production wires this to the two real pickers; tests inject an
 *  in-memory sink. Rejecting with an `Error` named `'AbortError'` (matching
 *  the real pickers' own dismissal signal) is how a caller reports the user
 *  closed the dialog — both export entry points treat that name specially. */
export interface ExportSink {
  pickFile(input: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileHandleLike>;
  pickDirectory(input: { mode: 'readwrite' }): Promise<DirectoryHandleLike>;
}

// ── tab.result shapes this service produces (mirrors ui/results.ts — see the
// module doc above for why this is a structural mirror, not an import) ──────

/** One statement's export outcome in a script-export run (#99) — metadata
 *  only, never the exported rows. Mirrors `ui/results.ts`'s identically-named
 *  `ScriptExportEntry`. */
export interface ScriptExportEntry {
  i: number;
  sql?: string;
  type: string;
  status: string;
  file: string | null;
  bytes: number;
  startedAt: number | null;
  ms: number | null;
  error: string | null;
}

/** A script-export run's `tab.result` shape (#99). Mirrors `ui/results.ts`'s
 *  identically-named `ScriptExportResult`. */
export interface ScriptExportResult {
  scriptExport: ScriptExportEntry[];
  startedAt: number;
  elapsedMs?: number;
  colWidths?: Record<string, number>;
}

// ── Injected dependency seam ─────────────────────────────────────────────────

/** The `state.exporting`/`state.resultSort` slice this service reads/writes —
 *  a structural `Pick`, not a snapshot: production passes `app.state` itself
 *  (satisfies this directly), so a write here is observed immediately by
 *  every consumer of the live signal/property (mirrors `workbench-
 *  session.ts`'s own `WorkbenchStateSlice` convention). This service is the
 *  SOLE production writer of `exporting` (mirrors `running`'s own
 *  precedent). */
export interface ExportStateSlice {
  exporting: Signal<boolean>;
  /** Reassigned wholesale (`state.resultSort = {...}`) at the start of an
   *  export-script wave — a plain settable property, not a signal (matches
   *  `WorkbenchStateSlice.resultSort`). */
  resultSort: ResultSort;
}

/** DOM/render hooks this service calls into — the shell's job, injected
 *  (mirrors `workbench-session.ts`'s own `WorkbenchHooks` convention). */
export interface ExportHooks {
  /** Per-statement (script export) results-pane repaint. */
  renderResults(): void;
  /** The inline "Exporting… <bytes> · <elapsed>s" banner (app.ts-owned DOM
   *  builder) — called once per single-file export with the export's own
   *  Cancel callback; returns the same `{update(bytes), remove()}` handle the
   *  pre-extraction code built inline. */
  showExportProgress(onCancel: () => void): { update(bytes: number): void; remove(): void };
  /** A user-facing toast (app.ts wires this to `flashToast(message, {
   *  document: doc })`); this service never imports `ui/toast.js`. */
  toast(message: string): void;
  /** Fire-and-forget schema reload after a schema-mutating script statement
   *  actually ran (mirrors `WorkbenchHooks.loadSchema`). */
  loadSchema(): void;
}

/** Every side effect this service needs, injected as a narrow bag — mirrors
 *  `query-execution-service.ts`'s own `QueryExecutionDeps`/`workbench-
 *  session.ts`'s own `WorkbenchSessionDeps` conventions. Transport deps carry
 *  the exact `ch-client.js` functions this service's export paths use
 *  (`exportQuery` for both the single-file and per-statement-rows paths,
 *  `runQuery` for a script's non-row effect statements, `killQuery` for both
 *  cancel paths) plus a live `ctx` PROVIDER (not a snapshot — the caller may
 *  rebuild it after a token refresh, same as `QueryExecutionDeps.ctx`). Kept
 *  as the raw ch-client functions + `ctx()` rather than routed through
 *  `app.exec` — `app.exec`'s `executeRead`/`executeScript` return already-
 *  parsed results, but the export paths need the raw streaming `Response`
 *  itself (for `streamToFile`'s hold-back-buffer inspection), which
 *  `app.exec`'s surface doesn't expose. */
export interface ExportServiceDeps {
  exportQuery: typeof exportQuery;
  runQuery: typeof runQuery;
  killQuery: typeof killQuery;
  ctx(): ChCtx;
  ensureConfig(): Promise<unknown>;
  /** Resolves the live bearer/basic credential, or null when signed out /
   *  unrefreshable — both export entry points call `ctx().onSignedOut()` and
   *  return in that case (byte-equivalent to the ported app.ts's
   *  `chCtx.onSignedOut(); return;`). Unlike `workbench-session.ts`'s own
   *  `onAuthFailed` hook, this service already depends on `ctx()` directly
   *  (see above), so there's no separate hook to keep it ignorant of chCtx. */
  getToken(): Promise<string | null>;
  /** SQL-string-quoting function `killQuery` needs (matches `core/format.js`'s
   *  `sqlString`). */
  sqlString: (s: unknown) => string;
  /** Perf clock — export/script-row elapsed ms, matches app.ts's `now`. */
  now(): number;
  /** The #173 wave wall clock (epoch ms) — matches app.ts's `wallNow`;
   *  `exportEntry` resolves one snapshot per export wave (gate + args), same
   *  F6 invariant as run()/runScript(). */
  wallNow(): number;
  uid(prefix: string): string;
  /** Env capability checks (`showSaveFilePicker`/`showDirectoryPicker` +
   *  secure-context feature detection) — the boolean LOGIC stays app.ts-owned
   *  (`app.canExport`/`app.canExportScript`); this service only reads the
   *  result, mirroring the defensive re-check the pre-extraction code already
   *  performed inside `exportDirect`/`exportScriptEntry` themselves (in
   *  addition to the Export button's own aria-disabled gating). */
  canExport(): boolean;
  canExportScript(): boolean;
  sink: ExportSink;
  state: ExportStateSlice;
  activeTab(): QueryTab;
  /** The `{name:Type}` query-variable POLICY (#276 Phase 4B1) — narrowed to
   *  exactly the three methods the export paths call, matching `workbench-
   *  session.ts`'s own narrow `Pick<QueryExecutionService, ...>` convention
   *  for `exec`. */
  params: Pick<WorkbenchParameterSession, 'prepareTabSource' | 'varGateBlocked' | 'execStatementSql'>;
  /** `tab.chSession`/transport material — stays app.ts-local (Phase 4C's
   *  concern, not this service's), injected as a plain function dep. */
  sessionParamsFor(tab: QueryTab, sqls: string[]): Record<string, string>;
  hooks: ExportHooks;
}

// ── The service ──────────────────────────────────────────────────────────────

export interface ExportService {
  exportEntry(): Promise<void> | undefined;
  exportDirect(sqlInput: string, waveMs: number): Promise<void>;
  cancelExport(): void;
  cancelExportScript(): void;
}

// A latin1 decode (1 char per byte) for byte-accurate exception-frame slicing
// — pure, no injected deps.
const latin1 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

/** Build an `ExportService` bound to `deps`. Trivial constructor — no
 *  validation, no defaulting; the caller supplies every field exactly as it
 *  wants it used. */
export function createExportService(deps: ExportServiceDeps): ExportService {
  // Full, uncapped export of a query — never the loaded grid — streamed
  // straight to a user-chosen file. Its own query_id + abort, kept separate
  // from the workbench session's own private run bookkeeping so an export and
  // a grid run never clobber each other's cancel state.
  let exportAbort: AbortController | null = null;
  let exportQueryId: string | null = null;
  // Script-export state (issue #99) — its own abort/query-id, reassigned each
  // iteration so Cancel reaches the in-flight statement, and kept distinct
  // from both the workbench session's own run bookkeeping and the single-
  // export state above.
  let exportScriptAbort: AbortController | null = null;
  let exportScriptQueryId: string | null = null;
  let exportScriptCancelled = false;
  let exportScriptTick: ReturnType<typeof setInterval> | null = null;

  // The Export button dispatches by statement count: one statement keeps the
  // rich single-file flow below; more than one opens the script-export flow
  // (its own directory + per-statement log, since one file per script makes
  // no sense). Mirrors runEntry's split/branch.
  function exportEntry(): Promise<void> | undefined {
    if (deps.activeTab().editorMode !== 'sql') return undefined;
    if (deps.state.exporting.value) return undefined;
    const waveMs = deps.wallNow(); // one wall clock for this export wave (gate + args)
    if (deps.params.varGateBlocked(waveMs)) return undefined; // don't export with unfilled variables (#134)
    const input = deps.activeTab().sqlDraft;
    const statements = splitStatements(input);
    if (!statements.length) { deps.hooks.toast('Nothing to export'); return undefined; }
    if (statements.length === 1) return exportDirect(statements[0], waveMs);
    return exportScriptEntry(statements, input, waveMs);
  }

  async function exportDirect(sqlInput: string, waveMs: number): Promise<void> {
    if (deps.activeTab().editorMode !== 'sql') return;
    if (deps.state.exporting.value) return;
    if (!deps.canExport()) return; // aria-disabled button; defensive guard
    const tab = deps.activeTab();
    // Export streams the execution view (#165) — identical bytes without blocks.
    const { sql, format } = prepareExportSql(deps.params.execStatementSql(sqlInput));
    if (!sql) { deps.hooks.toast('Nothing to export'); return; }
    const { ext, mime } = formatFileMeta(format);
    // Prepared args captured NOW — synchronously with exportEntry's gate
    // check, BEFORE the picker/auth awaits below (review F6 invariant, shared
    // with run/runScript/exportScript): gate and args see the same varValues
    // snapshot; edits during those awaits apply to the next export. (Session
    // params stay live below — they don't read varValues.)
    const paramArgs = mergedSourceArgs(deps.params.prepareTabSource(sql, waveMs));

    // Flip the flag before the picker (not after, like the file handle) so a
    // second click while the native dialog is still open is blocked by the
    // guard above — the button's own disabled state (setExportBtn) also
    // reflects this via an effect, but the guard is the authority.
    deps.state.exporting.value = true;
    try {
      // Picker FIRST, before any await: showSaveFilePicker requires the click's
      // transient activation, which a prior await (e.g. a token refresh in
      // ensureConfig/getToken can be a network round trip) would forfeit.
      let handle: FileHandleLike;
      try {
        handle = await deps.sink.pickFile({
          suggestedName: exportFilename(tab.name, Date.now(), ext),
          types: [{ description: format + ' data', accept: { [mime]: ['.' + ext] } }],
        });
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return; // user dismissed the picker
        deps.hooks.toast('Save dialog failed: ' + String((e instanceof Error && e.message) || e));
        return;
      }

      // Now the awaits are safe — we already hold the file handle.
      await deps.ensureConfig();
      if (!(await deps.getToken())) { deps.ctx().onSignedOut(); return; }

      exportQueryId = 'export-' + deps.uid('');
      exportAbort = new AbortController();
      const progress = deps.hooks.showExportProgress(cancelExport);
      try {
        const resp = await deps.exportQuery(deps.ctx(), sql, {
          queryId: exportQueryId, signal: exportAbort.signal, format,
          // Native query-parameter substitution (#134/#173), same as run() —
          // paramArgs is the wave-start snapshot captured above (review F6).
          params: { ...deps.sessionParamsFor(tab, [sql]), ...paramArgs },
        });
        const tag = resp.headers.get('X-ClickHouse-Exception-Tag'); // null on servers < 24.11
        const err = await streamToFile(resp, handle, {
          signal: exportAbort.signal, tag, onProgress: (bytes) => progress.update(bytes),
        });
        if (err) deps.hooks.toast('Export incomplete — server error mid-stream: ' + err);
        else deps.hooks.toast('Export complete');
      } catch (e) {
        // AbortError (cancelled) and 'signed out' (chCtx.onSignedOut already
        // rendered the login screen) both already have their own signal — an
        // extra toast on top would just be a confusing second message.
        const msg = String((e instanceof Error && e.message) || e);
        if (!(e instanceof Error && e.name === 'AbortError') && msg !== 'signed out') {
          deps.hooks.toast('Export failed: ' + msg);
        }
      } finally {
        progress.remove();
        exportAbort = null;
        exportQueryId = null;
      }
    } finally {
      deps.state.exporting.value = false;
    }
  }

  // Stream `resp.body` to `handle` with a hold-back buffer: ClickHouse's
  // mid-stream exception frame (findExceptionFrame) is at most 16 KiB and
  // always trailing, so bytes are only committed to disk once they've aged
  // out of a 32 KiB window — at EOF the retained tail is inspected and only
  // the clean prefix is written, so a mid-stream exception is never written
  // into the file. Memory stays flat (one HOLDBACK-sized buffer) regardless of
  // result size. Reads the stream directly (not via a TransformStream) because
  // the write is conditional (withhold, inspect, commit) — a passthrough
  // transform can't un-write. Returns the CH error message, or null when clean.
  async function streamToFile(
    resp: Response, handle: FileHandleLike,
    { signal, tag, onProgress }: { signal: AbortSignal; tag: string | null; onProgress: (bytes: number) => void },
  ): Promise<string | null> {
    const writable = await handle.createWritable();
    const HOLDBACK = 32 * 1024; // >= ClickHouse's MAX_EXCEPTION_SIZE (16 KiB) + margin
    const reader = resp.body!.getReader();
    let held = new Uint8Array(0);
    let written = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        const merged = new Uint8Array(held.length + value.length);
        merged.set(held);
        merged.set(value, held.length);
        const commit = Math.max(0, merged.length - HOLDBACK);
        if (commit > 0) {
          await writable.write(merged.subarray(0, commit));
          written += commit;
          onProgress(written);
        }
        held = merged.subarray(commit);
      }
      // EOF: inspect the retained tail (latin1: 1 char per byte, for byte-accurate slicing).
      const frame = findExceptionFrame(latin1(held), tag);
      const clean = frame ? held.subarray(0, frame.cleanBytes) : held;
      if (clean.length) {
        await writable.write(clean);
        written += clean.length;
        onProgress(written);
      }
      await writable.close();
      return frame ? frame.message : null;
    } catch (e) {
      // writable.abort() would discard everything already committed: on
      // Chrome/File System Access API it leaves a hidden, 0-byte
      // `.crswap` swap file behind and never materializes the visible
      // target at all — so a cancelled/failed export recovers nothing.
      // close() instead finalizes the bytes already written under the
      // target handle, then move() (Chrome 110+) renames it in place with
      // a `.partial` suffix so it reads as an inspectable, clearly-labeled
      // partial artifact rather than a clean export. Best-effort: on
      // browsers without move() (or if it throws), the file is still
      // recoverable under its original name, just without the suffix.
      await writable.close().catch(() => {});
      if (typeof handle.move === 'function') await handle.move(handle.name + '.partial').catch(() => {});
      throw e;
    } finally {
      reader.releaseLock();
    }
  }

  // Mirrors cancel() (the grid run) but on the export's own id/abort.
  function cancelExport(): void {
    if (exportAbort) exportAbort.abort();
    deps.killQuery(deps.ctx(), exportQueryId, deps.sqlString);
  }

  // Directory picker first (transient-activation rule, same as exportDirect's
  // save-file picker), and skip the prompt entirely when there's nothing to
  // export — no point asking for a folder a script will never write into.
  async function exportScriptEntry(statements: string[], originalInput: string, waveMs: number): Promise<void> {
    if (!deps.canExportScript()) {
      deps.hooks.toast('Script export requires Chrome/Edge directory access over HTTPS');
      return;
    }
    if (!statements.some(isRowReturning)) {
      deps.hooks.toast('Nothing to export — script has no result-producing statements.');
      return;
    }
    // One prepared batch for the whole export wave (#173), captured NOW —
    // synchronously with exportEntry's gate check, BEFORE the directory-picker
    // and auth awaits below (review F6 invariant, shared with run/runScript/
    // exportDirect): gate and args see the same varValues snapshot; edits
    // during those awaits apply to the next export. `statements` came from
    // splitStatements(originalInput), so the batch aligns by index.
    const paramSrc = deps.params.prepareTabSource(originalInput, waveMs);
    // Flip the flag before the picker (mirrors exportDirect) so a second click
    // while the directory dialog / auth is still in flight is blocked by
    // exportEntry's guard — exportScript itself doesn't set this until after
    // those awaits, which would otherwise leave a re-entrancy window open.
    deps.state.exporting.value = true;
    try {
      let dir: DirectoryHandleLike;
      try {
        dir = await deps.sink.pickDirectory({ mode: 'readwrite' });
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return; // dismissed → silent no-op
        deps.hooks.toast('Folder dialog failed: ' + String((e instanceof Error && e.message) || e));
        return;
      }
      await deps.ensureConfig();
      if (!(await deps.getToken())) { deps.ctx().onSignedOut(); return; }
      await exportScript(statements, dir, paramSrc);
    } finally {
      // No-op if exportScript already reset it — covers every early-return
      // path above that never reaches exportScript's own finally.
      deps.state.exporting.value = false;
    }
  }

  // Run a script's statements sequentially into `dir`, one file per
  // row-returning statement, for effect otherwise. A single shared session
  // carries SET/TEMPORARY state across statements (sessionParamsFor). The log
  // lives in tab.result.scriptExport — per-statement metadata only (status,
  // file, bytes, time); the exported rows themselves are never held in
  // memory/state, so a multi-million-row script export stays flat. Stop on
  // first failure, mirroring runScript's script grid — but with no retry
  // (statements run one-at-a-time in a single session, so SESSION_IS_LOCKED
  // can't self-collide, and a partially-written file shouldn't be silently
  // re-attempted).
  async function exportScript(statements: string[], dir: DirectoryHandleLike, paramSrc: PreparedSource): Promise<void> {
    const tab = deps.activeTab();
    const t0 = deps.now();
    const sp = deps.sessionParamsFor(tab, statements);
    // `paramSrc` is the wave's prepared batch (#173), captured by
    // exportScriptEntry at wave start, before its awaits (review F6).
    const entries: ScriptExportEntry[] = statements.map((sql, i) => ({
      i, sql, type: isRowReturning(sql) ? 'rows' : 'effect',
      status: 'pending', file: null, bytes: 0, startedAt: null, ms: 0, error: null,
    }));
    const scriptExportResult: ScriptExportResult = { scriptExport: entries, startedAt: t0 };
    Object.assign(tab, { result: scriptExportResult });
    deps.state.resultSort = { col: null, dir: 'asc' };
    exportScriptCancelled = false;
    deps.state.exporting.value = true;
    const taken = new Set<string>();
    try {
      // Live elapsed for the running row (bytes tick via onProgress; this ticks
      // time). Started inside the try so a throw here still clears it below —
      // an interval set before the try would otherwise leak forever.
      exportScriptTick = setInterval(() => deps.hooks.renderResults(), 200);
      deps.hooks.renderResults();
      for (const e of entries) {
        if (exportScriptCancelled) { e.status = 'skipped'; continue; }
        // Wire text = the pipeline's per-statement execution view (#165);
        // verbatim for effect/DDL statements and for block-free SQL.
        const execStmt = paramSrc.statements[e.i].sql;
        const { sql, format } = prepareExportSql(execStmt);
        // Per-statement prepared args (#134/#173): the pipeline binds only
        // row-returning statements, so an effect/DDL statement (incl. CREATE
        // VIEW) is sent with its {name:Type} placeholders intact.
        const params = { ...sp, ...paramSrc.statements[e.i].args };
        exportScriptQueryId = 'export-' + deps.uid('');
        exportScriptAbort = new AbortController();
        const signal = exportScriptAbort.signal;
        e.startedAt = deps.now();
        e.status = e.type === 'rows' ? 'exporting' : 'running';
        deps.hooks.renderResults();
        try {
          if (e.type !== 'rows') {
            const out = await deps.runQuery(deps.ctx(), execStmt,
              { format: 'TSV', signal, queryId: exportScriptQueryId, params });
            if (out.error != null) throw new Error(out.error);
            e.status = 'ok';
          } else {
            const { ext } = formatFileMeta(format);
            const name = scriptExportName(e.i, e.sql || '', ext, taken);
            taken.add(name);
            e.file = name;
            const fileHandle = await dir.getFileHandle(name, { create: true });
            const resp = await deps.exportQuery(deps.ctx(), sql,
              { queryId: exportScriptQueryId, signal, format, params });
            const tag = resp.headers.get('X-ClickHouse-Exception-Tag');
            const midErr = await streamToFile(resp, fileHandle,
              { signal, tag, onProgress: (b) => { e.bytes = b; } });
            if (midErr) {
              e.status = 'failed';
              e.error = 'File may be incomplete; server failed after streaming started. ' + midErr;
              e.ms = deps.now() - e.startedAt!;
              break; // stop-on-first-failure
            }
            e.status = 'ok';
          }
          e.ms = deps.now() - e.startedAt!;
          deps.hooks.renderResults();
        } catch (ex) {
          e.ms = deps.now() - e.startedAt!;
          if (ex instanceof Error && ex.name === 'AbortError') { e.status = 'cancelled'; exportScriptCancelled = true; }
          else { e.status = 'failed'; e.error = String((ex instanceof Error && ex.message) || ex); }
          break; // stop-on-first-failure
        }
      }
      for (const e of entries) if (e.status === 'pending') e.status = 'skipped';
    } finally {
      clearInterval(exportScriptTick as ReturnType<typeof setInterval>); exportScriptTick = null;
      exportScriptAbort = null;
      exportScriptQueryId = null;
      deps.state.exporting.value = false;
      scriptExportResult.elapsedMs = deps.now() - t0;
      // A schema-mutating effect statement that actually ran refreshes the tree
      // (mirrors runScript) even though this export ran outside runScript.
      if (entries.some((e) => e.status === 'ok' && isSchemaMutatingSql(e.sql))) deps.hooks.loadSchema();
      deps.hooks.renderResults();
    }
  }

  // Mirrors cancelExport but on the script's own active id/abort.
  function cancelExportScript(): void {
    exportScriptCancelled = true; // stops the loop from starting the next statement
    if (exportScriptAbort) exportScriptAbort.abort();
    deps.killQuery(deps.ctx(), exportScriptQueryId, deps.sqlString);
  }

  return { exportEntry, exportDirect, cancelExport, cancelExportScript };
}
