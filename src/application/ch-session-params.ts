// The ClickHouse HTTP `session_id` policy (#276 Phase 5 final home) —
// `sessionParams`/`needsSession`/`sessionParamsFor` moved out of app.ts
// wholesale (byte-identical logic) into their own constructible-without-App
// module so both app.ts's workbench-hook wiring and the ExportService dep
// wiring share ONE implementation instead of two independently-maintained
// copies of the same three functions.
//
// A ClickHouse HTTP session ties a tab's requests together so session state —
// temporary tables, SET settings — survives across the separate HTTP requests
// of a multiquery script (and across successive runs in the tab). ClickHouse's
// HTTP interface runs one statement per request and is otherwise stateless, so
// without this a `CREATE TEMPORARY TABLE …; INSERT …; SELECT …` script can't
// see its own temp table. The id is per-tab (lazily minted) so tabs don't share
// state and never collide on the per-session lock (only one query runs at a
// time, guarded by `running`). No `session_timeout` override is needed:
// ClickHouse resets the idle timer when each query is *released* (end of the
// request, not the start) and cancels it while a query runs, so the default
// (60s) never lapses between a script's back-to-back statements.
//
// Only TEMPORARY tables and session `SET`s need a session; permanent DDL/DML
// and SELECTs are global. So we attach a session_id ONLY when the SQL needs
// one — or when the tab already opened one (sticky, so a temp table / SET
// from an earlier run stays visible to later runs in that tab). Ordinary
// scripts run session-LESS, which avoids the session lock / replica-affinity
// reset that intermittently surfaces as a "Network error". (Schema /
// reference loads are always session-less — they fan out in parallel and
// would deadlock on the lock.)

import { leadingKeyword } from '../core/sql-split.js';

/** The one field this module reads/writes on a tab — real callers always pass
 *  a `state.ts` `QueryTab` (whose own `chSession?: string` satisfies this
 *  structurally), but the policy itself needs nothing else from a tab. */
export interface ChSessionCarrier {
  chSession?: string;
}

export interface ChSessionParamsDeps {
  /** A unique id for the `session_id` (mints `uid('sess-')`). Same seam
   *  app.ts's own `uid` already is (crypto.randomUUID, with a non-secure-
   *  context fallback) — injected here rather than re-derived. */
  uid: (prefix: string) => string;
}

export interface ChSessionParams {
  sessionParams(tab: ChSessionCarrier): { session_id: string };
  needsSession(sqls: string[]): boolean;
  sessionParamsFor(tab: ChSessionCarrier, sqls: string[]): Record<string, string>;
}

/** Build a `ChSessionParams` bound to `deps`. Trivial constructor — no
 *  validation, no defaulting. */
export function createChSessionParams(deps: ChSessionParamsDeps): ChSessionParams {
  function sessionParams(tab: ChSessionCarrier): { session_id: string } {
    tab.chSession = tab.chSession || deps.uid('sess-');
    return { session_id: tab.chSession };
  }

  function needsSession(sqls: string[]): boolean {
    return sqls.some((s) => /\bTEMPORARY\b/i.test(s) || leadingKeyword(s) === 'SET');
  }

  function sessionParamsFor(tab: ChSessionCarrier, sqls: string[]): Record<string, string> {
    return tab.chSession != null || needsSession(sqls) ? sessionParams(tab) : {};
  }

  return { sessionParams, needsSession, sessionParamsFor };
}
