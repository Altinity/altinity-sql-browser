// The connection lifecycle is deliberately a small, pure state machine.  The
// application/session layer owns effects (OAuth, storage and transport); it
// feeds their results here with the epoch captured when the work started.
// Epochs make a late response harmless after a newer login, credential change,
// or sign-out has superseded it.

/** Every lifecycle state that can be resumed after a token refresh. */
export type ConnectionLifecycleResumeState =
  | ConnectionLifecycleStableState<'connected'>
  | ConnectionLifecycleStableState<'starting'>
  | ConnectionLifecycleStableState<'offline'>;

type ConnectionLifecycleStableKind =
  | 'starting'
  | 'connected'
  | 'offline'
  | 'auth-required'
  | 'reauthenticating'
  | 'signed-out';

/** A non-refreshing lifecycle state. `detail` is deliberately display-safe
 * context (for example, an authentication explanation), never credentials. */
export interface ConnectionLifecycleStableState<K extends ConnectionLifecycleStableKind> {
  kind: K;
  epoch: number;
  detail?: string;
}

/** Refreshing retains the exact pre-refresh state, so a successful refresh
 * resumes an in-progress startup or an offline state rather than claiming the
 * transport is connected. */
export interface ConnectionLifecycleRefreshingState {
  kind: 'refreshing';
  epoch: number;
  detail?: string;
  resume: ConnectionLifecycleResumeState;
}

/** The complete, discriminated connection lifecycle value. */
export type ConnectionLifecycleState =
  | ConnectionLifecycleStableState<'starting'>
  | ConnectionLifecycleStableState<'connected'>
  | ConnectionLifecycleRefreshingState
  | ConnectionLifecycleStableState<'offline'>
  | ConnectionLifecycleStableState<'auth-required'>
  | ConnectionLifecycleStableState<'reauthenticating'>
  | ConnectionLifecycleStableState<'signed-out'>;

/** The safe state an unsuccessful interactive authentication may restore. */
export type AuthenticationPriorState =
  | ConnectionLifecycleStableState<'auth-required'>
  | ConnectionLifecycleStableState<'signed-out'>;

type CurrentEpochEvent = { epoch: number; detail?: string };

/** Inputs to {@link reduceConnectionLifecycle}. Events that complete async
 * work carry its captured epoch. New user/session intents do not: they create
 * a new epoch themselves. */
export type ConnectionLifecycleEvent =
  | { type: 'start-authentication'; detail?: string }
  | { type: 'credentials-installed'; detail?: string }
  | ({ type: 'begin-refresh' } & CurrentEpochEvent)
  | ({ type: 'refresh-succeeded' } & CurrentEpochEvent)
  | ({ type: 'refresh-failed' } & CurrentEpochEvent)
  | ({ type: 'transport-connected' } & CurrentEpochEvent)
  | ({ type: 'transport-offline' } & CurrentEpochEvent)
  | ({ type: 'auth-required' } & CurrentEpochEvent)
  | { type: 'signed-out'; detail?: string }
  | ({ type: 'failed-authentication'; prior: AuthenticationPriorState } & CurrentEpochEvent);

/** Start a session before credentials or a transport result are available. */
export function initialConnectionLifecycle(detail?: string): ConnectionLifecycleStableState<'starting'> {
  return stable('starting', 0, detail);
}

function stable<K extends ConnectionLifecycleStableKind>(
  kind: K, epoch: number, detail?: string,
): ConnectionLifecycleStableState<K> {
  return detail === undefined ? { kind, epoch } : { kind, epoch, detail };
}

function isRefreshable(state: ConnectionLifecycleState): state is ConnectionLifecycleResumeState {
  return state.kind === 'connected' || state.kind === 'starting' || state.kind === 'offline';
}

function isCurrent(state: ConnectionLifecycleState, event: CurrentEpochEvent): boolean {
  return state.epoch === event.epoch;
}

/**
 * Reduce one lifecycle event. Illegal transitions and stale async completions
 * return `state` itself, allowing callers to skip rendering/persistence by
 * identity. The reducer never mutates its input.
 */
export function reduceConnectionLifecycle(
  state: ConnectionLifecycleState,
  event: ConnectionLifecycleEvent,
): ConnectionLifecycleState {
  switch (event.type) {
    case 'start-authentication':
      return stable('reauthenticating', state.epoch + 1, event.detail);

    case 'credentials-installed':
      return stable('starting', state.epoch + 1, event.detail);

    case 'signed-out':
      return stable('signed-out', state.epoch + 1, event.detail);

    case 'begin-refresh':
      if (!isCurrent(state, event) || !isRefreshable(state)) return state;
      return event.detail === undefined
        ? { kind: 'refreshing', epoch: state.epoch, resume: state }
        : { kind: 'refreshing', epoch: state.epoch, detail: event.detail, resume: state };

    case 'refresh-succeeded':
    case 'refresh-failed':
      if (!isCurrent(state, event) || state.kind !== 'refreshing') return state;
      return state.resume;

    case 'transport-connected':
      if (isCurrent(state, event) && state.kind === 'refreshing') {
        if (state.resume.kind === 'connected') return state;
        return { ...state, resume: stable('connected', state.epoch, event.detail) };
      }
      if (!isCurrent(state, event) || (state.kind !== 'starting' && state.kind !== 'offline')) return state;
      return stable('connected', state.epoch, event.detail);

    case 'transport-offline':
      if (!isCurrent(state, event)
        || state.kind === 'offline'
        || state.kind === 'auth-required'
        || state.kind === 'signed-out'
        || state.kind === 'reauthenticating') return state;
      if (state.kind === 'refreshing') {
        if (state.resume.kind === 'offline') return state;
        return { ...state, resume: stable('offline', state.epoch, event.detail) };
      }
      return stable('offline', state.epoch, event.detail);

    case 'auth-required':
      if (!isCurrent(state, event) || state.kind === 'auth-required' || state.kind === 'signed-out') return state;
      // An authentication requirement invalidates the credentials that scoped
      // all outstanding work. Advance the epoch so those completions cannot
      // subsequently overwrite the login-required state.
      return stable('auth-required', state.epoch + 1, event.detail);

    case 'failed-authentication':
      if (!isCurrent(state, event) || state.kind !== 'reauthenticating') return state;
      return stable(event.prior.kind, state.epoch, event.prior.detail);
  }
}

export type ConnectionPresentationTone = 'success' | 'error' | 'warning' | 'offline' | 'neutral';

/** A DOM-agnostic projection consumed by the header/status surface. */
export interface ConnectionLifecyclePresentation {
  /** Short visible chip text. */
  label: string;
  /** An announcement suitable for the status chip's accessible name. */
  ariaLabel: string;
  /** Complete class string for the existing connection chip. */
  className: string;
  /** Semantic colour treatment, useful to non-DOM consumers too. */
  tone: ConnectionPresentationTone;
}

/** Project a lifecycle value into the one status-chip display contract. */
export function connectionLifecyclePresentation(state: ConnectionLifecycleState): ConnectionLifecyclePresentation {
  switch (state.kind) {
    case 'connected':
      return presentation(state.kind, 'Connected', 'connected', 'success');
    case 'auth-required':
      return presentation(state.kind, 'Sign in required', 'authentication required', 'error');
    case 'starting':
      return presentation(state.kind, 'Connecting…', 'connecting', 'warning');
    case 'refreshing':
      return presentation(state.kind, 'Refreshing…', 'refreshing', 'warning');
    case 'reauthenticating':
      return presentation(state.kind, 'Signing in…', 'reauthenticating', 'warning');
    case 'offline':
      return presentation(state.kind, 'Offline', 'offline', 'offline');
    case 'signed-out':
      return presentation(state.kind, 'Signed out', 'signed out', 'neutral');
  }
}

function presentation(
  kind: ConnectionLifecycleState['kind'],
  label: string,
  ariaState: string,
  tone: ConnectionPresentationTone,
): ConnectionLifecyclePresentation {
  return {
    label,
    ariaLabel: `ClickHouse connection: ${ariaState}`,
    className: `conn-status connection-chip is-${kind} tone-${tone}`,
    tone,
  };
}
