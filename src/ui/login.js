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

/**
 * Render the login screen into `app.root`. `app` provides:
 *   host()                     — the serving host (where SSO authenticates)
 *   actions.login(id?)         — start the OAuth flow for IdP `id` (async)
 *   actions.connect({...})     — credential sign-in; renders the app on success
 *   loadIdps()                 — resolve { idps, basicLogin } (async)
 *   showLogin(msg)             — re-render with an error message
 */
export function renderLogin(app, errorMsg) {
  const cur = app.host();
  let busy = null; // 'sso' | 'creds' — guards against double-submit
  let showPw = false;
  // A `?host=` URL param pre-fills the credential server address. A non-empty
  // host means credential-only (SSO can only target the serving host), so
  // Advanced opens and the SSO buttons disable.
  const hostHint = app.hostHint || '';
  let advOpen = !!hostHint;
  let ssoBtns = [];

  // A username is enough to connect — the password is optional, since passwordless
  // users are common on demo/playground clusters (e.g. ClickHouse `play`). An empty
  // password sends HTTP Basic `user:` which ClickHouse accepts.
  const hasCreds = () => userInput.value.trim().length > 0;

  // --- credential fields ---
  const fld = (over) => h('input', {
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
  let pickHosts = [];
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
      h('div', { class: 'login-logo' }, 'A'),
      h('div', { class: 'login-brand-text' },
        h('div', { class: 'login-brand-name' }, 'Altinity® SQL Browser'),
        h('div', { class: 'login-brand-sub mono' }, 'ClickHouse® query console'))),
    pickerSection,
    ssoSection,
    credSection,
    errorMsg ? h('div', { class: 'login-error' }, errorMsg) : null);

  app.root.replaceChildren(h('div', { class: 'login-screen' }, card));
  update();

  // Resolve the configured IdPs (and the basic_login flag) and reconcile which
  // sections are shown. On failure keep credentials visible (fail-open — OAuth
  // can't work without config anyway) and show no SSO.
  app.loadIdps().then(({ idps, basicLogin, hosts }) => {
    const credsShown = basicLogin !== false;
    if (!credsShown) credSection.remove();
    populateHosts(hosts);
    populateSso(idps);
    applyChrome(ssoBtns.length > 0, credsShown);
    update();
  }).catch(() => applyChrome(false, true)); // no config → credentials only

  // Show the "or use credentials" divider only when both sign-in methods
  // are actually offered.
  function applyChrome(hasSso, credsShown) {
    divider.style.display = (hasSso && credsShown) ? '' : 'none';
  }

  function populateSso(idps) {
    ssoBtns = [];
    // An IdP referenced by a saved connection is signed into via the picker (which
    // targets that host's origin); don't also offer it as a serving-host SSO button —
    // that would query the serving origin (e.g. localhost), not the chosen cluster.
    const standalone = (idps || []).filter((i) => !pickHosts.some((hh) => hh.auth === 'oauth' && hh.idp === i.id));
    if (!standalone.length) return;
    const mk = (idpId, label) => {
      const b = h('button', { class: 'login-btn btn-primary', onclick: () => doSso(idpId, b) },
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
  function populateHosts(hosts) {
    pickHosts = hosts || [];
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
  function onPickHost() {
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
  function showCertWarn(hh) {
    const kids = [
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

  function clearCertWarn() {
    certWarn.replaceChildren();
    certWarn.style.display = 'none';
  }

  async function pickOAuth(hh) {
    if (busy) return; // reachable from the cert panel's Continue button — guard re-entry like doSso
    busy = 'sso';
    hostPicker.disabled = true;
    try {
      await app.actions.login(hh.idp, hh.url);
    } catch (err) {
      busy = null;
      hostPicker.disabled = false;
      app.showLogin(String((err && err.message) || err));
    }
  }

  // Keep the primary/secondary swap, Connect enablement, and target row in sync
  // with the field values — updated in place so focus/caret are preserved.
  function update() {
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

  function onCredsKey(e) { if (e.key === 'Enter' && hasCreds()) doConnect(); }

  async function doConnect() {
    if (busy || !hasCreds()) return;
    busy = 'creds';
    connectBtn.disabled = true;
    connectBtn.replaceChildren(h('span', null, 'Connecting…'));
    try {
      await app.actions.connect({ username: userInput.value, password: passInput.value, host: hostInput.value });
      // success → connect() renders the workbench, replacing this screen.
    } catch (err) {
      busy = null;
      app.showLogin(String((err && err.message) || err));
    }
  }

  async function doSso(idpId, btn) {
    if (busy) return;
    busy = 'sso';
    btn.disabled = true;
    btn.replaceChildren(h('span', null, 'Redirecting…'));
    try {
      await app.actions.login(idpId);
    } catch (err) {
      busy = null;
      app.showLogin(String((err && err.message) || err));
    }
  }
}
