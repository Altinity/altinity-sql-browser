// The sign-in screen. Two auth paths, encoded directly in the UI:
//   • SSO  — the existing OAuth flow, bound to the serving host. One button per
//     configured IdP, labelled with the IdP ("Continue with Google"). Hidden
//     when no IdP is configured.
//   • Credentials — a ClickHouse username/password (HTTP Basic), optionally
//     against another host via the "Advanced" disclosure. Hidden when the
//     deployment sets `basic_login: false`.
// When credentials are in play (both fields filled, or a custom host is set —
// including via a `?host=` URL param, which pre-fills Advanced) the UI favours
// credentials: Connect becomes primary and the SSO buttons demote, and disable
// entirely for a custom host (SSO can only target the serving host). A live
// "Target" row resolves the combined state (effective host + as <user> / via SSO).

import { h } from './dom.js';
import { Icon } from './icons.js';
import type { ActionsRegistry } from './app.types.js';
import type { ConfigDoc, HostDescriptor, IdpDescriptor } from '../net/oauth-config.js';
import type { ConnectionSession } from '../application/connection-session.js';

/** The narrow slice of the real `app` controller this module reads — not the
 *  full ~50-member `App` contract (app.types.ts). `root` is narrowed to a
 *  non-null `Element` (vs. `App.root`'s `Element | null`): this module always
 *  writes through it unconditionally, exactly as it already did pre-#262.
 *  `conn.loadIdps` matches `ConnectionSession.loadIdps`'s real resolved shape
 *  (oauth-config.ts's `ConfigDoc`) directly — #267 fixed the contract that
 *  used to undersell it as `{ idps: Array<{id}> }`, so the local
 *  `LoginIdpsResult` widening this module needed for that gap is gone.
 *  `host`/`hostHint`/`loadIdps` moved onto `app.conn` in #276 Phase 5 (the
 *  flat `App` delegates were deleted); `showLogin` stays App-level — it
 *  composes rendering, not a pure forward. */
export interface LoginApp {
  root: Element;
  conn: Pick<ConnectionSession, 'host' | 'hostHint' | 'loadIdps' | 'basicRecoveryOrigin'>;
  actions: Pick<ActionsRegistry, 'login' | 'connect'>;
  showLogin(msg?: string): void;
}

/** A reusable in-shell authentication mount. The host is stable for the life
 *  of the app shell; showing, hiding, and reporting an authentication error
 *  therefore never replaces the editor/results document tree around it. */
export interface InlineLoginHandle {
  /** Reveal the controls, replace any previous local error, and focus them. */
  show(errorMsg?: string): void;
  /** Hide the controls without discarding field values or async config. */
  hide(): void;
  /** Focus the first usable authentication control. */
  focus(): void;
  /** Fence pending config work and remove only this mount from its host. */
  dispose(): void;
}

interface LoginMount extends InlineLoginHandle {
  container: HTMLElement;
}

// `renderLogin()` historically has no disposer in its public API. Remember its
// private mount so a re-render can still fence a late `loadIdps()` completion
// from the screen it just replaced.
const fullMounts = new WeakMap<Element, LoginMount>();
const inlineMounts = new WeakMap<HTMLElement, LoginMount>();

// `err` is `unknown` under strict catch typing; only a thrown `Error` has a
// `.message` worth surfacing (every throw site in this module and its tests
// is either `new Error(...)` or a raw primitive) — anything else stringifies
// as-is, same as the original `(err && err.message) || err`.
function errMsg(err: unknown): string {
  return String((err instanceof Error && err.message) || err);
}

/**
 * Render the login screen into `app.root`. `app` provides:
 *   conn.host()                — the serving host (where SSO authenticates)
 *   actions.login(id?)         — start the OAuth flow for IdP `id` (async)
 *   actions.connect({...})     — credential sign-in; renders the app on success
 *   conn.loadIdps()            — resolve { idps, basicLogin } (async)
 *   showLogin(msg)             — re-render with an error message
 */
export function renderLogin(app: LoginApp, errorMsg?: string): void {
  fullMounts.get(app.root)?.dispose();
  const mount = mountLoginControls(app, app.root, 'full', errorMsg);
  fullMounts.set(app.root, mount);
}

/**
 * Mount the same authentication card used by `renderLogin()` into a stable
 * in-shell host. Unlike the full-screen renderer, failures are painted into
 * this mount and neither `app.root` nor the surrounding shell is replaced.
 *
 * The mount starts visible and focused. Callers may retain it across lifecycle
 * changes with `hide()`/`show()`, or tear it down permanently with `dispose()`.
 */
export function mountInlineLogin(
  app: LoginApp,
  host: HTMLElement,
  errorMsg?: string,
): InlineLoginHandle {
  inlineMounts.get(host)?.dispose();
  const mount = mountLoginControls(app, host, 'inline', errorMsg);
  inlineMounts.set(host, mount);
  return mount;
}

function mountLoginControls(
  app: LoginApp,
  target: Element,
  mode: 'full' | 'inline',
  initialError?: string,
): LoginMount {
  const cur = app.conn.host();
  let disposed = false;
  let busy: 'sso' | 'creds' | null = null; // guards against double-submit
  let showPw = false;
  // A `?host=` URL param pre-fills the credential server address. A non-empty
  // host means credential-only (SSO can only target the serving host), so
  // Advanced opens and the SSO buttons disable.
  // During in-shell Basic recovery use the exact prior target. `chCtx.origin`
  // is intentionally reset once the loss is reported, so `host()` alone is
  // insufficient (and drops the scheme/port the reconnect must reuse).
  const hostHint = mode === 'inline'
    ? (app.conn.basicRecoveryOrigin() || app.conn.hostHint || '')
    : (app.conn.hostHint || '');
  let advOpen = !!hostHint;
  let ssoBtns: HTMLButtonElement[] = [];

  // A username is enough to connect — the password is optional, since passwordless
  // users are common on demo/playground clusters (e.g. ClickHouse `play`). An empty
  // password sends HTTP Basic `user:` which ClickHouse accepts.
  const hasCreds = (): boolean => userInput.value.trim().length > 0;

  // --- credential fields ---
  const fld = (over: Record<string, unknown>): HTMLInputElement => h('input', {
    class: 'login-input mono', type: 'text', spellcheck: 'false', autocomplete: 'off',
    oninput: update, onkeydown: onCredsKey, ...over,
  });
  const userInput = fld({ placeholder: 'default' });
  const passInput = fld({ type: 'password', placeholder: '••••••••' });
  const hostInput = fld({ placeholder: cur + ':8443', value: hostHint });

  const eyeBtn = h('button', {
    class: 'login-eye', type: 'button', tabindex: '-1', title: 'Show password',
    onclick: () => {
      showPw = !showPw;
      passInput.type = showPw ? 'text' : 'password';
      eyeBtn.title = showPw ? 'Hide password' : 'Show password';
      eyeBtn.replaceChildren(showPw ? Icon.eyeOff() : Icon.eye());
    },
  }, Icon.eye());

  // --- advanced (host override) ---
  const advChev = h('span', { class: 'login-disc-chev' }, Icon.chevDown());
  const advField = h('div', { class: 'login-adv-field', style: { display: 'none' } },
    h('label', { class: 'login-lbl' }, 'Server address (host:port)'),
    hostInput,
    h('div', { class: 'login-hint' },
      'Leave blank to use this server. A custom host applies to credential sign-in only — SSO always authenticates on ',
      h('span', { class: 'mono' }, cur), '.'));
  const advToggle = h('button', {
    class: 'login-disc', type: 'button',
    onclick: () => {
      advOpen = !advOpen;
      advField.style.display = advOpen ? '' : 'none';
      advChev.style.transform = advOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
    },
  }, advChev, h('span', null, 'Advanced — connect to another server'));
  advChev.style.transform = advOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
  if (advOpen) advField.style.display = '';

  // --- connect button + live target row ---
  const connectBtn = h('button', { class: 'login-btn btn-ghost', disabled: true, onclick: doConnect },
    h('span', null, 'Connect'), Icon.arrow());
  const targetHostEl = h('span', { class: 'lt-host' }, cur);
  const targetAsEl = h('span', { class: 'lt-as' }, 'via SSO');

  // --- SSO section (populated async once the IdP list resolves) ---
  const ssoSection = h('div', { class: 'login-sso' });
  const divider = h('div', { class: 'login-divider', style: { display: 'none' } },
    h('span', null, 'or use credentials'));

  const credSection = h('div', { class: 'login-creds' },
    divider,
    h('div', { class: 'login-field' }, h('label', { class: 'login-lbl' }, 'Username'), userInput),
    h('div', { class: 'login-field' },
      h('label', { class: 'login-lbl' }, 'Password'),
      h('div', { class: 'login-input-wrap' }, passInput, eyeBtn)),
    h('div', { class: 'login-advanced' }, advToggle, advField),
    connectBtn,
    h('div', { class: 'login-target' },
      h('span', { class: 'lt-dot' }),
      h('span', { class: 'lt-key' }, 'Target'),
      targetHostEl,
      h('span', { style: { flex: '1' } }),
      targetAsEl));

  // --- saved-connection picker (populated async; shown only when config lists hosts) ---
  let pickHosts: HostDescriptor[] = [];
  let inlineOAuthConfigured = false;
  const hostPicker = h('select', { class: 'login-picker mono', onchange: onPickHost });
  // Shown only for an `insecure` (accept-invalid-certificate) connection — the
  // browser can't be reached until its cert is trusted (see showCertWarn).
  const certWarn = h('div', { class: 'login-cert-warn', style: { display: 'none' } });
  const pickerSection = h('div', { class: 'login-field login-picker-field', style: { display: 'none' } },
    h('label', { class: 'login-lbl' }, 'Saved connection'),
    hostPicker,
    certWarn);

  // The brand block is heading enough, so there's no separate "Sign in" title
  // or subtitle, and no footer — a source link + auth-method tag just added
  // noise the user has to parse before signing in (#123).
  const card = h('div', { class: 'login-card login-card-wide' },
    h('div', { class: 'login-brand' },
      h('div', { class: 'login-logo' }, Icon.brand()),
      h('div', { class: 'login-brand-text' },
        h('div', { class: 'login-brand-name' }, 'Altinity® SQL Browser'),
        h('div', { class: 'login-brand-sub mono' }, 'ClickHouse® query console'))),
    pickerSection,
    ssoSection,
    credSection);
  let errorEl: HTMLElement | null = null;
  const setError = (msg?: string): void => {
    if (!msg) {
      errorEl?.remove();
      errorEl = null;
      return;
    }
    if (!errorEl) {
      errorEl = h('div', {
        class: 'login-error',
        role: 'alert',
        'aria-live': 'polite',
      });
      card.append(errorEl);
    }
    errorEl.textContent = msg;
  };
  setError(initialError);

  const container = mode === 'full'
    ? h('div', { class: 'login-screen' }, card)
    : h('div', {
      class: 'login-inline',
      role: 'group',
      'aria-label': 'Authentication required',
    }, card);
  target.replaceChildren(container);
  if (mode === 'inline') (target as HTMLElement).hidden = false;
  update();

  // Resolve the configured IdPs (and the basic_login flag) and reconcile which
  // sections are shown. On failure keep credentials visible (fail-open — OAuth
  // can't work without config anyway) and show no SSO.
  app.conn.loadIdps().then(({ idps, basicLogin, hosts }) => {
    if (disposed) return;
    const credsShown = basicLogin !== false;
    if (!credsShown) credSection.remove();
    populateHosts(hosts);
    populateSso(idps);
    applyChrome(ssoBtns.length > 0, credsShown);
    update();
  }).catch(() => {
    if (!disposed) applyChrome(false, true);
  }); // no config → credentials only

  // Show the "or use credentials" divider only when both sign-in methods
  // are actually offered.
  function applyChrome(hasSso: boolean, credsShown: boolean): void {
    divider.style.display = (hasSso && credsShown) ? '' : 'none';
  }

  function populateSso(idps: Pick<IdpDescriptor, 'id' | 'label'>[] | undefined): void {
    ssoBtns = [];
    // An IdP referenced by a saved connection is signed into via the picker (which
    // targets that host's origin); don't also offer it as a serving-host SSO button —
    // that would query the serving origin (e.g. localhost), not the chosen cluster.
    const standalone = (idps || []).filter((i) => !pickHosts.some((hh) => hh.auth === 'oauth' && hh.idp === i.id));
    // Phase 2 keeps the document shell mounted during recovery, but does not
    // yet have the redirect-resume checkpoint needed to make an OAuth round
    // trip safe. Full-screen login retains the normal OAuth controls.
    if (mode === 'inline') {
      if (standalone.length || inlineOAuthConfigured) {
        ssoSection.replaceChildren(h('div', {
          class: 'login-inline-oauth-unavailable',
          role: 'status',
          'aria-live': 'polite',
        }, 'Single sign-on is temporarily unavailable while this session is paused. Your work remains open.'));
      }
      return;
    }
    if (!standalone.length) return;
    const mk = (idpId: string, label: string): HTMLButtonElement => {
      const b = h('button', { class: 'login-btn btn-primary', onclick: () => doSso(idpId, b, label) },
        Icon.shield(), h('span', null, label));
      ssoBtns.push(b);
      return b;
    };
    // Always label the button with the IdP — "Continue with Google" reads
    // better than a generic "SSO", and disambiguates when several are configured.
    const btns = standalone.map((i) => mk(i.id, 'Continue with ' + i.label));
    ssoSection.replaceChildren(
      ...btns,
      h('div', { class: 'login-sso-note' },
        Icon.server(), h('span', null, 'Authenticates on '), h('span', { class: 'mono' }, cur)));
  }

  // Fill the picker from config.json's `hosts` (npm run local supplies them from
  // ~/.clickhouse-client/config.xml). Hidden when none are configured.
  function populateHosts(hosts: HostDescriptor[] | undefined): void {
    // OAuth saved connections also redirect away from the mounted document.
    // Only credential targets are safe to offer in Phase 2 inline recovery.
    inlineOAuthConfigured = mode === 'inline' && (hosts || []).some((hh) => hh.auth === 'oauth');
    pickHosts = (hosts || []).filter((hh) => mode === 'full' || hh.auth === 'basic');
    if (!pickHosts.length) return;
    hostPicker.replaceChildren(
      h('option', { value: '' }, 'Choose a connection…'),
      ...pickHosts.map((hh, i) => h('option', { value: String(i) }, hh.label + (hh.auth === 'oauth' ? ' (OAuth)' : ''))));
    pickerSection.style.display = '';
  }

  // Pick a saved connection: a basic one prefills the credentials form (+ reveals
  // the host); an oauth one starts the SSO flow against that cluster. An
  // `insecure` (accept-invalid-certificate) connection first surfaces the
  // cert-trust step — and, for oauth, holds the redirect behind a Continue button
  // so the cert is trusted before any post-login query reaches the cluster.
  function onPickHost(): void {
    clearCertWarn();
    if (hostPicker.value === '') return;
    const hh = pickHosts[Number(hostPicker.value)];
    if (hh.insecure) showCertWarn(hh);
    if (hh.auth === 'oauth') {
      if (!hh.insecure) pickOAuth(hh); // insecure → wait for the warning's Continue button
      return;
    }
    hostInput.value = hh.url;
    userInput.value = hh.user;
    passInput.value = hh.password;
    advOpen = true; advField.style.display = ''; advChev.style.transform = 'rotate(0deg)';
    update();
  }

  // The browser refuses to fetch() a host with an untrusted TLS cert and JS can't
  // override that — so for an `insecure` connection we point the user at the
  // cluster to accept the cert once (per browser session). For oauth, the redirect
  // is gated behind Continue so the post-login queries don't hit an untrusted host.
  function showCertWarn(hh: HostDescriptor): void {
    const kids: HTMLElement[] = [
      h('div', { class: 'login-cert-msg' }, Icon.shield(),
        h('span', null, 'This connection uses a self-signed or otherwise invalid TLS certificate. '
          + 'Your browser blocks it until you open it once and click through the warning to trust the cert.')),
      h('a', { class: 'login-cert-link mono', href: hh.url, target: '_blank', rel: 'noopener noreferrer' },
        h('span', null, 'Open ' + hh.label + ' to accept its certificate'), Icon.arrow()),
      // The opened host often 302-redirects (an auth gateway → its own login, a
      // status page, etc.) once the handshake succeeds — that lands you somewhere
      // unrelated, but the cert is already trusted by then. Say so, so the redirect
      // doesn't read as a failure: close that tab and come back here.
      h('div', { class: 'login-hint' },
        'A certificate prompt should appear — choose proceed/accept. Any login or status '
        + 'page it then redirects to is expected and unrelated; just close that tab, return here, and connect.'),
    ];
    if (hh.auth === 'oauth') {
      const go = h('button', { class: 'login-btn btn-primary login-cert-go',
        onclick: () => { go.disabled = true; pickOAuth(hh); } },
      Icon.shield(), h('span', null, 'Continue — sign in'));
      kids.push(go);
    }
    certWarn.replaceChildren(...kids);
    certWarn.style.display = '';
  }

  function clearCertWarn(): void {
    certWarn.replaceChildren();
    certWarn.style.display = 'none';
  }

  async function pickOAuth(hh: HostDescriptor): Promise<void> {
    if (disposed || busy) return; // reachable from the cert panel's Continue button — guard re-entry like doSso
    busy = 'sso';
    hostPicker.disabled = true;
    try {
      await app.actions.login(hh.idp, hh.url);
    } catch (err) {
      if (disposed) return;
      busy = null;
      hostPicker.disabled = false;
      const certGo = certWarn.querySelector<HTMLButtonElement>('.login-cert-go');
      if (certGo) certGo.disabled = false;
      reportError(errMsg(err));
      if (!disposed) update();
    }
  }

  // Keep the primary/secondary swap, Connect enablement, and target row in sync
  // with the field values — updated in place so focus/caret are preserved.
  function update(): void {
    const has = hasCreds();
    // A custom server address means credential-only — SSO authenticates only on
    // the serving host — so disable the SSO buttons and treat credentials as the
    // active path even before both fields are filled.
    const customHost = hostInput.value.trim().length > 0;
    const credsFocus = has || customHost;
    connectBtn.classList.toggle('btn-primary', has);
    connectBtn.classList.toggle('btn-ghost', !has);
    connectBtn.disabled = !has || !!busy;
    for (const b of ssoBtns) {
      b.classList.toggle('btn-primary', !credsFocus);
      b.classList.toggle('btn-ghost', credsFocus);
      b.disabled = customHost;
    }
    targetHostEl.textContent = hostInput.value.trim() || cur;
    targetAsEl.textContent = has ? 'as ' + userInput.value.trim() : (customHost ? 'credentials' : 'via SSO');
  }

  function onCredsKey(e: KeyboardEvent): void { if (e.key === 'Enter' && hasCreds()) doConnect(); }

  async function doConnect(): Promise<void> {
    if (disposed || busy || !hasCreds()) return;
    busy = 'creds';
    connectBtn.disabled = true;
    connectBtn.replaceChildren(h('span', null, 'Connecting…'));
    try {
      await app.actions.connect({ username: userInput.value, password: passInput.value, host: hostInput.value });
      // Full login mounts the workbench; inline recovery hides this host while
      // retaining the already-mounted document session.
    } catch (err) {
      if (disposed) return;
      busy = null;
      connectBtn.replaceChildren(h('span', null, 'Connect'), Icon.arrow());
      reportError(errMsg(err));
      if (!disposed) update();
    }
  }

  async function doSso(idpId: string, btn: HTMLButtonElement, label: string): Promise<void> {
    if (disposed || busy) return;
    busy = 'sso';
    btn.disabled = true;
    btn.replaceChildren(h('span', null, 'Redirecting…'));
    try {
      await app.actions.login(idpId);
    } catch (err) {
      if (disposed) return;
      busy = null;
      btn.replaceChildren(Icon.shield(), h('span', null, label));
      reportError(errMsg(err));
      if (!disposed) update();
    }
  }

  function reportError(msg: string): void {
    if (mode === 'full') app.showLogin(msg);
    else setError(msg);
  }

  function focus(): void {
    if (disposed || mode === 'inline' && (target as HTMLElement).hidden) return;
    const control = container.querySelector<HTMLElement>('input:not([disabled])')
      ?? container.querySelector<HTMLElement>('.login-sso button:not([disabled])')
      ?? container.querySelector<HTMLElement>('select:not([disabled])')
      ?? container.querySelector<HTMLElement>('button:not([disabled])');
    control?.focus();
  }

  const mount: LoginMount = {
    container,
    show: (msg?: string) => {
      if (disposed) return;
      setError(msg);
      if (mode === 'inline') (target as HTMLElement).hidden = false;
      focus();
    },
    hide: () => {
      if (!disposed && mode === 'inline') (target as HTMLElement).hidden = true;
    },
    focus,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (container.parentNode === target) container.remove();
      if (mode === 'inline') (target as HTMLElement).hidden = true;
    },
  };
  if (mode === 'inline') focus();
  return mount;
}
