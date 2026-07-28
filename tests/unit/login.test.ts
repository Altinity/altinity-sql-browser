import { describe, it, expect, vi } from 'vitest';
import { mountInlineLogin, renderLogin } from '../../src/ui/login.js';
import { makeApp } from '../helpers/fake-app.js';
import type { ConfigDoc, HostDescriptor, IdpDescriptor } from '../../src/net/oauth-config.js';

/** This suite's own `loadIdps()` fixture shape — every test constructs a
 *  partial `ConfigDoc` (login.ts's `LoginApp.loadIdps` now returns the real
 *  `ConfigDoc` directly, #267), but only ever fills in the fields it actually
 *  exercises (`hosts`/`basicLogin` are frequently omitted, and each `idps[]`
 *  entry only ever needs `id`/`label` — the `Pick<IdpDescriptor,'id'|'label'>`
 *  narrowing login.ts's own doc comment describes for what `renderLogin`
 *  reads off each entry). `App.loadIdps` (fake-app.ts's `makeApp`) wants the
 *  real, fully-fielded `ConfigDoc` — `asLoadIdps` bridges this suite's
 *  intentionally-thinner fixture the same "widen the PARAMETER to `object`
 *  first" way as this file's other seam bridges, since every real IdpDescriptor
 *  field beyond id/label is simply unread by the render path this suite
 *  exercises. */
interface TestIdpsResult {
  idps: Pick<IdpDescriptor, 'id' | 'label'>[];
  basicLogin?: boolean;
  hosts?: HostDescriptor[];
}
const asLoadIdps = (fn: object): (() => Promise<ConfigDoc>) => fn as () => Promise<ConfigDoc>;

const qs = <T extends Element = Element>(root: ParentNode, selector: string): T => root.querySelector(selector) as T;
const qsa = <T extends Element = Element>(root: ParentNode, selector: string): T[] =>
  [...root.querySelectorAll(selector)] as T[];

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const click = (el: Element): boolean => el.dispatchEvent(new Event('click', { bubbles: true }));
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}
function selectHost(root: ParentNode, value: string): void {
  const sel = qs<HTMLSelectElement>(root, '.login-picker');
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
}

type FakeApp = ReturnType<typeof makeApp>;
/** `appWith`'s override bag — a partial `FakeApp`, except `actions`, which is
 *  merged key-by-key against the real `makeApp()` defaults below (a plain
 *  top-level `{...over}` spread in fake-app.js would otherwise drop every
 *  other stubbed action). `host`/`hostHint`/`loadIdps` are flat convenience
 *  keys here (this suite's own long-standing call-site shape, kept as-is —
 *  #276 Phase 5 moved the REAL fields onto `app.conn`) that `appWith` below
 *  routes into `makeApp`'s `conn: {...}` override. */
interface AppOverrides extends Partial<Omit<FakeApp, 'actions' | 'conn'>> {
  actions?: Partial<FakeApp['actions']>;
  host?: () => string;
  loadIdps?: () => Promise<TestIdpsResult>;
  basicRecoveryOrigin?: () => string | null;
  // Not a base fake-app.js field (only ever supplied as an override, matching
  // the real app's optional `conn.hostHint` — app.types.ts / login.ts's
  // `LoginApp`).
  hostHint?: string;
}
// makeApp defaults loadIdps → { idps: [], basicLogin: true }. Override per test.
function appWith(over: AppOverrides = {}): FakeApp {
  const base = makeApp();
  const { loadIdps, host, hostHint, basicRecoveryOrigin, ...rest } = over;
  return makeApp({
    ...rest,
    actions: { ...base.actions, ...(over.actions || {}) },
    conn: {
      ...(host ? { host } : {}),
      ...(hostHint !== undefined ? { hostHint } : {}),
      ...(basicRecoveryOrigin ? { basicRecoveryOrigin } : {}),
      ...(loadIdps ? { loadIdps: asLoadIdps(loadIdps) } : {}),
    },
  });
}

describe('renderLogin — structure', () => {
  it('renders brand, credentials, target row, and footer — no "Sign in" title/subtitle', () => {
    const app = appWith();
    renderLogin(app);
    expect(qs(app.root, '.login-brand-name').textContent).toContain('Altinity');
    expect(app.root.querySelector('.login-h1')).toBeNull(); // title removed
    expect(app.root.querySelector('.login-sub')).toBeNull(); // subtitle removed
    expect(app.root.querySelectorAll('.login-input')).toHaveLength(3); // user, pass, host
    expect(qs(app.root, '.login-target .lt-as').textContent).toBe('via SSO');
    expect(app.root.querySelector('.login-foot')).toBeNull(); // no source link / auth-method tag (#123)
    expect(app.root.querySelector('.login-error')).toBeNull();
  });
  it('shows an error message when given', () => {
    const app = appWith();
    renderLogin(app, 'boom');
    expect(qs(app.root, '.login-error').textContent).toBe('boom');
  });
  it('uses the host for the target row and the host placeholder', () => {
    const app = appWith({ host: () => 'ch.demo' });
    renderLogin(app);
    expect(qs(app.root, '.login-target .lt-host').textContent).toBe('ch.demo');
    const hostInput = qsa<HTMLInputElement>(app.root, '.login-input')[2];
    expect(hostInput.getAttribute('placeholder')).toBe('ch.demo:8443');
  });
});

describe('renderLogin — host picker', () => {
  const hosts: HostDescriptor[] = [
    { label: 'demo', url: 'http://localhost:8123', auth: 'basic', user: 'default', password: 'pw', idp: '', insecure: false },
    { label: 'antalya', url: 'https://antalya.demo.altinity.cloud', auth: 'oauth', user: '', password: '', idp: 'google', insecure: false },
  ];
  const withHosts = (over: AppOverrides = {}) => appWith({ loadIdps: async () => ({ idps: [], basicLogin: true, hosts }), ...over });

  it('is hidden when no hosts are configured', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [], basicLogin: true, hosts: [] }) });
    renderLogin(app); await tick();
    expect(qs<HTMLElement>(app.root, '.login-picker-field').style.display).toBe('none');
  });
  it('lists configured hosts (OAuth tagged) when present', async () => {
    const app = withHosts();
    renderLogin(app); await tick();
    expect(qs<HTMLElement>(app.root, '.login-picker-field').style.display).toBe('');
    expect([...qs<HTMLSelectElement>(app.root, '.login-picker').options].map((o) => o.textContent))
      .toEqual(['Choose a connection…', 'demo', 'antalya (OAuth)']);
  });
  it('selecting a basic host prefills host/user/password and opens Advanced', async () => {
    const app = withHosts();
    renderLogin(app); await tick();
    selectHost(app.root, '0');
    const [user, pass, host] = qsa<HTMLInputElement>(app.root, '.login-input');
    expect([host.value, user.value, pass.value]).toEqual(['http://localhost:8123', 'default', 'pw']);
    expect(qs<HTMLElement>(app.root, '.login-adv-field').style.display).toBe('');
  });
  it('selecting a passwordless basic host (empty password) still enables Connect', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [], basicLogin: true, hosts: [
      { label: 'clickhouse-sql', url: 'https://sql-clickhouse.clickhouse.com:8443', auth: 'basic', user: 'play', password: '', idp: '', insecure: false },
    ] }) });
    renderLogin(app); await tick();
    selectHost(app.root, '0');
    const [user, pass] = qsa<HTMLInputElement>(app.root, '.login-input');
    expect([user.value, pass.value]).toEqual(['play', '']);
    expect(qs<HTMLButtonElement>(app.root, '.login-creds .login-btn').disabled).toBe(false);
  });
  it('selecting an OAuth host starts SSO against that cluster', async () => {
    const login = vi.fn(async () => {});
    const app = withHosts({ actions: { login } });
    renderLogin(app); await tick();
    selectHost(app.root, '1');
    expect(login).toHaveBeenCalledWith('google', 'https://antalya.demo.altinity.cloud');
  });
  it('does not show a standalone SSO button for an IdP a host references (picker-only)', async () => {
    const app = appWith({ loadIdps: async () => ({
      idps: [{ id: 'antalya-oauth', label: 'antalya-oauth' }, { id: 'google', label: 'Google' }],
      basicLogin: true,
      hosts: [{ label: 'antalya', url: 'https://antalya.demo.altinity.cloud', auth: 'oauth', idp: 'antalya-oauth', user: '', password: '', insecure: false }],
    }) });
    renderLogin(app); await tick();
    const labels = qsa<HTMLButtonElement>(app.root, '.login-sso .login-btn').map((b) => b.textContent || '');
    expect(labels.some((l) => /antalya-oauth/.test(l))).toBe(false); // reached via the picker, not a serving-host button
    expect(labels.some((l) => /Google/.test(l))).toBe(true); // an unreferenced IdP still shows standalone
  });
  it('the placeholder option is a no-op', async () => {
    const login = vi.fn();
    const app = withHosts({ actions: { login } });
    renderLogin(app); await tick();
    selectHost(app.root, '');
    expect(login).not.toHaveBeenCalled();
  });
  it('re-enables the picker and surfaces an error when OAuth sign-in fails', async () => {
    const login = vi.fn(async () => { throw new Error('redirect blocked'); });
    const app = withHosts({ actions: { login } });
    app.showLogin = vi.fn();
    renderLogin(app); await tick();
    selectHost(app.root, '1');
    await tick();
    expect(login).toHaveBeenCalled();
    expect(app.showLogin).toHaveBeenCalled();
    expect(qs<HTMLSelectElement>(app.root, '.login-picker').disabled).toBe(false);
  });
});

describe('renderLogin — insecure (accept-invalid-certificate) hosts', () => {
  const insecureHosts: HostDescriptor[] = [
    { label: 'audit', url: 'https://support-a.tenant-a.dev.altinity.cloud', auth: 'basic', user: 'mcp', password: 'pw', idp: '', insecure: true },
    { label: 'audit-oauth', url: 'https://support-a.tenant-a.dev.altinity.cloud', auth: 'oauth', user: '', password: '', idp: 'google', insecure: true },
  ];
  const withInsecure = (over: AppOverrides = {}) => appWith({ loadIdps: async () => ({ idps: [], basicLogin: true, hosts: insecureHosts }), ...over });

  it('basic insecure host: prefills the form and shows the cert-trust step with an open-cluster link (no Continue button)', async () => {
    const login = vi.fn();
    const app = withInsecure({ actions: { login } });
    renderLogin(app); await tick();
    selectHost(app.root, '0');
    const [user, , host] = qsa<HTMLInputElement>(app.root, '.login-input');
    expect([host.value, user.value]).toEqual(['https://support-a.tenant-a.dev.altinity.cloud', 'mcp']);
    const warn = qs<HTMLElement>(app.root, '.login-cert-warn');
    expect(warn.style.display).toBe('');
    const link = qs<HTMLAnchorElement>(warn, '.login-cert-link');
    expect(link.getAttribute('href')).toBe('https://support-a.tenant-a.dev.altinity.cloud');
    expect(link.textContent).toContain('Open audit');
    expect(warn.querySelector('.login-cert-go')).toBeNull(); // basic: no SSO redirect to gate
    expect(login).not.toHaveBeenCalled();
  });

  it('oauth insecure host: shows the cert step + Continue and does NOT auto-redirect until Continue is clicked', async () => {
    const login = vi.fn(async () => {});
    const app = withInsecure({ actions: { login } });
    renderLogin(app); await tick();
    selectHost(app.root, '1');
    expect(login).not.toHaveBeenCalled(); // gated behind the cert-trust step
    const go = app.root.querySelector('.login-cert-go');
    expect(go).not.toBeNull();
    click(go as Element);
    expect(login).toHaveBeenCalledWith('google', 'https://support-a.tenant-a.dev.altinity.cloud');
  });

  it('oauth insecure host: Continue guards against double-submit (disables itself + busy gate)', async () => {
    // login stays pending so `busy` is still 'sso' on the second click.
    const login = vi.fn(() => new Promise<void>(() => {}));
    const app = withInsecure({ actions: { login } });
    renderLogin(app); await tick();
    selectHost(app.root, '1');
    const go = qs<HTMLButtonElement>(app.root, '.login-cert-go');
    click(go);
    expect(go.disabled).toBe(true);
    click(go); // re-entry blocked by the busy guard in pickOAuth
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('oauth insecure host: restores its Continue control after a live redirect failure', async () => {
    const login = vi.fn(async () => { throw new Error('certificate redirect failed'); });
    const app = withInsecure({ actions: { login } });
    app.showLogin = vi.fn();
    renderLogin(app); await tick();
    selectHost(app.root, '1');
    const go = qs<HTMLButtonElement>(app.root, '.login-cert-go');
    click(go);
    expect(go.disabled).toBe(true);
    await tick();

    expect(go.disabled).toBe(false);
    expect(app.showLogin).toHaveBeenCalledWith('certificate redirect failed');
  });

  it('fences a certificate-gated OAuth failure after its full-screen mount is replaced', async () => {
    let rejectLogin: ((reason?: unknown) => void) | undefined;
    const login = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLogin = reject; }));
    const app = withInsecure({ actions: { login } });
    renderLogin(app); await tick();
    selectHost(app.root, '1');
    click(qs(app.root, '.login-cert-go'));
    renderLogin(app); // disposes the redirecting mount
    rejectLogin?.(new Error('late certificate redirect failure'));
    await tick();

    expect(app.root.querySelector('.login-error')).toBeNull();
  });

  it('clears the cert step when switching to the placeholder or a normal connection', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [], basicLogin: true, hosts: [
      ...insecureHosts,
      { label: 'plain', url: 'http://localhost:8123', auth: 'basic', user: 'default', password: 'pw', idp: '', insecure: false },
    ] }) });
    renderLogin(app); await tick();
    selectHost(app.root, '0');
    expect(qs<HTMLElement>(app.root, '.login-cert-warn').style.display).toBe('');
    selectHost(app.root, '');
    expect(qs<HTMLElement>(app.root, '.login-cert-warn').style.display).toBe('none');
    selectHost(app.root, '0');
    expect(qs<HTMLElement>(app.root, '.login-cert-warn').style.display).toBe('');
    selectHost(app.root, '2'); // a normal (secure) basic connection
    expect(qs<HTMLElement>(app.root, '.login-cert-warn').style.display).toBe('none');
  });
});

describe('renderLogin — SSO section', () => {
  it('no IdPs → no SSO button, divider hidden, credentials present', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [], basicLogin: true }) });
    renderLogin(app);
    await tick();
    expect(app.root.querySelectorAll('.login-sso .login-btn')).toHaveLength(0);
    expect(qs<HTMLElement>(app.root, '.login-divider').style.display).toBe('none');
    expect(app.root.querySelector('.login-creds')).not.toBeNull();
  });
  it('one IdP → a single IdP-labelled button + divider shown', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: true }) });
    renderLogin(app);
    await tick();
    const btns = qsa<HTMLButtonElement>(app.root, '.login-sso .login-btn');
    expect(btns.map((b) => b.textContent)).toEqual(['Continue with Google']);
    expect(qs<HTMLElement>(app.root, '.login-divider').style.display).toBe('');
    expect(qs(app.root, '.login-sso-note').textContent).toContain('Authenticates on');
  });
  it('multiple IdPs → one button per provider', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }, { id: 'a', label: 'Acme' }], basicLogin: true }) });
    renderLogin(app);
    await tick();
    const btns = qsa<HTMLButtonElement>(app.root, '.login-sso .login-btn');
    expect(btns.map((b) => b.textContent)).toEqual(['Continue with Google', 'Continue with Acme']);
  });
  it('basic_login:false removes the credentials section', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: false }) });
    renderLogin(app);
    await tick();
    expect(app.root.querySelector('.login-creds')).toBeNull();
    expect(app.root.querySelectorAll('.login-sso .login-btn')).toHaveLength(1);
  });
  it('config load failure keeps credentials and shows no SSO', async () => {
    const app = appWith({ loadIdps: async () => { throw new Error('no config'); } });
    renderLogin(app);
    await tick();
    expect(app.root.querySelector('.login-creds')).not.toBeNull();
    expect(app.root.querySelectorAll('.login-sso .login-btn')).toHaveLength(0);
  });
});

describe('renderLogin — ?host= URL hint', () => {
  it('pre-fills the server address, opens Advanced, disables SSO, targets credentials', async () => {
    const app = appWith({
      hostHint: 'antalya.demo:9000',
      loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: true }),
    });
    renderLogin(app);
    await tick();
    const hostInput = qsa<HTMLInputElement>(app.root, '.login-input')[2];
    expect(hostInput.value).toBe('antalya.demo:9000');
    expect(qs<HTMLElement>(app.root, '.login-adv-field').style.display).toBe(''); // opened
    const sso = qs<HTMLButtonElement>(app.root, '.login-sso .login-btn');
    expect(sso.disabled).toBe(true); // SSO can't target a custom host
    expect(qs(app.root, '.lt-host').textContent).toBe('antalya.demo:9000');
    expect(qs(app.root, '.lt-as').textContent).toBe('credentials');
  });
  it('typing a host (no URL hint) also disables SSO', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: true }) });
    renderLogin(app);
    await tick();
    const sso = qs<HTMLButtonElement>(app.root, '.login-sso .login-btn');
    expect(sso.disabled).toBe(false);
    type(qsa<HTMLInputElement>(app.root, '.login-input')[2], 'other:9000');
    expect(sso.disabled).toBe(true);
  });
});

describe('renderLogin — credentials reactivity', () => {
  it('typing both fields flips Connect to primary and demotes SSO to ghost', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: true }) });
    renderLogin(app);
    await tick();
    const [user, pass] = qsa<HTMLInputElement>(app.root, '.login-input');
    const connect = qs<HTMLButtonElement>(app.root, '.login-creds .login-btn');
    const sso = qs<HTMLButtonElement>(app.root, '.login-sso .login-btn');
    expect(connect.classList.contains('btn-ghost')).toBe(true);
    expect(connect.disabled).toBe(true);
    type(user, 'default');
    type(pass, 'secret');
    expect(connect.classList.contains('btn-primary')).toBe(true);
    expect(connect.disabled).toBe(false);
    expect(sso.classList.contains('btn-ghost')).toBe(true);
    expect(qs(app.root, '.lt-as').textContent).toBe('as default');
  });
  it('a username alone enables Connect — password is optional (passwordless demos like `play`)', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: true }) });
    renderLogin(app);
    await tick();
    const [user] = qsa<HTMLInputElement>(app.root, '.login-input');
    const connect = qs<HTMLButtonElement>(app.root, '.login-creds .login-btn');
    expect(connect.disabled).toBe(true);          // nothing typed yet
    type(user, 'play');                            // username only, no password
    expect(connect.disabled).toBe(false);
    expect(connect.classList.contains('btn-primary')).toBe(true);
    expect(qs(app.root, '.lt-as').textContent).toBe('as play');
  });
  it('the host field drives the target host', () => {
    const app = appWith();
    renderLogin(app);
    const host = qsa<HTMLInputElement>(app.root, '.login-input')[2];
    type(host, 'other:9000');
    expect(qs(app.root, '.lt-host').textContent).toBe('other:9000');
  });
  it('password show/hide toggles the input type', () => {
    const app = appWith();
    renderLogin(app);
    const pass = qsa<HTMLInputElement>(app.root, '.login-input')[1];
    const eye = qs<HTMLButtonElement>(app.root, '.login-eye');
    expect(pass.type).toBe('password');
    click(eye);
    expect(pass.type).toBe('text');
    expect(eye.title).toBe('Hide password');
    click(eye);
    expect(pass.type).toBe('password');
  });
  it('advanced disclosure toggles the host field', () => {
    const app = appWith();
    renderLogin(app);
    const advField = qs<HTMLElement>(app.root, '.login-adv-field');
    const toggle = qs<HTMLButtonElement>(app.root, '.login-disc');
    expect(advField.style.display).toBe('none');
    click(toggle);
    expect(advField.style.display).toBe('');
    click(toggle);
    expect(advField.style.display).toBe('none');
  });
});

describe('renderLogin — connect flow', () => {
  it('Connect calls actions.connect with the field values', async () => {
    const connect = vi.fn(async () => {});
    const app = appWith({ actions: { connect } });
    renderLogin(app);
    const [user, pass, host] = qsa<HTMLInputElement>(app.root, '.login-input');
    type(user, ' default ');
    type(pass, 'pw');
    type(host, 'h:1');
    click(qs(app.root, '.login-creds .login-btn'));
    await tick();
    expect(connect).toHaveBeenCalledWith({ username: ' default ', password: 'pw', host: 'h:1' });
  });
  it('Enter in a field submits when both credentials are present', async () => {
    const connect = vi.fn(async () => {});
    const app = appWith({ actions: { connect } });
    renderLogin(app);
    const [user, pass] = qsa<HTMLInputElement>(app.root, '.login-input');
    type(user, 'u'); type(pass, 'p');
    pass.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    expect(connect).toHaveBeenCalled();
  });
  it('Enter is a no-op with no username and for non-Enter keys; submits once a username is present', async () => {
    const connect = vi.fn(async () => {});
    const app = appWith({ actions: { connect } });
    renderLogin(app);
    const [user] = qsa<HTMLInputElement>(app.root, '.login-input');
    user.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); // empty → no-op
    type(user, 'play');
    user.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));     // non-Enter → ignored
    await tick();
    expect(connect).not.toHaveBeenCalled();
    user.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); // username present → submits (no password)
    await tick();
    expect(connect).toHaveBeenCalledWith({ username: 'play', password: '', host: '' });
  });
  it('clicking Connect with empty fields is a no-op', async () => {
    const connect = vi.fn(async () => {});
    const app = appWith({ actions: { connect } });
    renderLogin(app);
    click(qs(app.root, '.login-creds .login-btn'));
    await tick();
    expect(connect).not.toHaveBeenCalled();
  });
  it('connect failure surfaces the error via showLogin', async () => {
    const showLogin = vi.fn();
    const connect = vi.fn(async () => { throw new Error('wrong password'); });
    const app = appWith({ showLogin, actions: { connect } });
    renderLogin(app);
    const [user, pass] = qsa<HTMLInputElement>(app.root, '.login-input');
    type(user, 'u'); type(pass, 'bad');
    click(qs(app.root, '.login-creds .login-btn'));
    await tick();
    expect(showLogin).toHaveBeenCalledWith('wrong password');
  });
  it('connect failure with a non-Error value stringifies it', async () => {
    const showLogin = vi.fn();
    const connect = vi.fn(async () => { throw 'nope'; });
    const app = appWith({ showLogin, actions: { connect } });
    renderLogin(app);
    const [user, pass] = qsa<HTMLInputElement>(app.root, '.login-input');
    type(user, 'u'); type(pass, 'p');
    click(qs(app.root, '.login-creds .login-btn'));
    await tick();
    expect(showLogin).toHaveBeenCalledWith('nope');
  });
  it('ignores a second Connect while one is in flight', async () => {
    let resolve: (() => void) | undefined;
    const connect = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const app = appWith({ actions: { connect } });
    renderLogin(app);
    const [user, pass] = qsa<HTMLInputElement>(app.root, '.login-input');
    type(user, 'u'); type(pass, 'p');
    const btn = qs<HTMLButtonElement>(app.root, '.login-creds .login-btn');
    click(btn);
    expect(btn.textContent).toBe('Connecting…');
    click(btn); // busy → ignored
    expect(connect).toHaveBeenCalledTimes(1);
    resolve?.();
    await tick();
  });
});

describe('renderLogin — SSO flow', () => {
  function ssoApp(over: AppOverrides = {}) {
    return appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: true }), ...over });
  }
  it('clicking SSO calls login(id) and shows Redirecting…', async () => {
    const login = vi.fn(async () => {});
    const app = ssoApp({ actions: { login } });
    renderLogin(app);
    await tick();
    const sso = qs<HTMLButtonElement>(app.root, '.login-sso .login-btn');
    click(sso);
    expect(sso.textContent).toBe('Redirecting…');
    await tick();
    expect(login).toHaveBeenCalledWith('g');
  });
  it('SSO failure surfaces the error via showLogin', async () => {
    const showLogin = vi.fn();
    const login = vi.fn(async () => { throw new Error('redirect failed'); });
    const app = ssoApp({ showLogin, actions: { login } });
    renderLogin(app);
    await tick();
    click(qs(app.root, '.login-sso .login-btn'));
    await tick();
    expect(showLogin).toHaveBeenCalledWith('redirect failed');
  });
  it('SSO failure with a non-Error value stringifies it', async () => {
    const showLogin = vi.fn();
    const login = vi.fn(async () => { throw 'sso-raw'; });
    const app = ssoApp({ showLogin, actions: { login } });
    renderLogin(app);
    await tick();
    click(qs(app.root, '.login-sso .login-btn'));
    await tick();
    expect(showLogin).toHaveBeenCalledWith('sso-raw');
  });
  it('fences an SSO failure after its full-screen mount is replaced', async () => {
    let rejectLogin: ((reason?: unknown) => void) | undefined;
    const login = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLogin = reject; }));
    const app = ssoApp({ actions: { login } });
    renderLogin(app); await tick();
    click(qs(app.root, '.login-sso .login-btn'));
    renderLogin(app); // disposes the redirecting mount
    rejectLogin?.(new Error('late redirect failure'));
    await tick();

    expect(app.root.querySelector('.login-error')).toBeNull();
  });
  it('ignores a second SSO click while one is in flight', async () => {
    let resolve: (() => void) | undefined;
    const login = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const app = ssoApp({ actions: { login } });
    renderLogin(app);
    await tick();
    const sso = qs<HTMLButtonElement>(app.root, '.login-sso .login-btn');
    click(sso);
    click(sso); // busy → ignored
    expect(login).toHaveBeenCalledTimes(1);
    resolve?.();
    await tick();
  });
});

describe('mountInlineLogin', () => {
  const idps: Pick<IdpDescriptor, 'id' | 'label'>[] = [{ id: 'g', label: 'Google' }];
  const hosts: HostDescriptor[] = [{
    label: 'demo',
    url: 'http://localhost:8123',
    auth: 'basic',
    user: 'default',
    password: 'pw',
    idp: '',
    insecure: false,
  }];

  it('mounts Basic recovery controls without replacing the app root', async () => {
    const loadIdps = async () => ({ idps, basicLogin: true, hosts });
    const full = appWith({ loadIdps });
    const inline = appWith({ loadIdps });
    const shell = document.createElement('div');
    const sentinel = document.createElement('div');
    sentinel.className = 'editor-sentinel';
    inline.root.replaceChildren(sentinel);
    const host = document.createElement('div');
    shell.append(host);

    renderLogin(full);
    mountInlineLogin(inline, host);
    await tick();

    expect(inline.root.firstElementChild).toBe(sentinel);
    expect(inline.root.querySelector('.login-card')).toBeNull();
    expect(host.querySelector('.login-screen')).toBeNull();
    expect(host.querySelector('.login-inline')).not.toBeNull();
    expect(qsa(host, '.login-input')).toHaveLength(qsa(full.root, '.login-input').length);
    expect(host.querySelector('.login-sso .login-btn')).toBeNull();
    expect(qs(host, '.login-inline-oauth-unavailable').textContent).toContain('Single sign-on');
    expect([...qs<HTMLSelectElement>(host, '.login-picker').options].map((o) => o.textContent))
      .toEqual([...qs<HTMLSelectElement>(full.root, '.login-picker').options].map((o) => o.textContent));
    expect(qs(host, '.login-brand-name').textContent).toBe(qs(full.root, '.login-brand-name').textContent);
  });

  it('keeps Basic failures local, accessible, and preserves the surrounding root and field values', async () => {
    const showLogin = vi.fn();
    const connect = vi.fn(async () => { throw new Error('wrong password'); });
    const app = appWith({ showLogin, actions: { connect } });
    const sentinel = document.createElement('div');
    app.root.replaceChildren(sentinel);
    const host = document.createElement('div');
    const handle = mountInlineLogin(app, host);
    const [user, pass] = qsa<HTMLInputElement>(host, '.login-input');
    type(user, 'alice');
    type(pass, 'bad');

    click(qs(host, '.login-creds .login-btn'));
    await tick();

    expect(app.root.firstElementChild).toBe(sentinel);
    expect(showLogin).not.toHaveBeenCalled();
    expect([user.value, pass.value]).toEqual(['alice', 'bad']);
    const error = qs<HTMLElement>(host, '.login-error');
    expect(error.textContent).toBe('wrong password');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.getAttribute('aria-live')).toBe('polite');
    const button = qs<HTMLButtonElement>(host, '.login-creds .login-btn');
    expect(button.textContent).toContain('Connect');
    expect(button.disabled).toBe(false);
    click(button); // a current failure leaves the same values available to retry
    await tick();
    expect(connect).toHaveBeenCalledTimes(2);

    handle.show();
    expect(host.querySelector('.login-error')).toBeNull();
  });

  it('keeps inline OAuth unavailable without replacing the surrounding root', async () => {
    const showLogin = vi.fn();
    const login = vi.fn(async () => { throw new Error('redirect blocked'); });
    const app = appWith({
      showLogin,
      actions: { login },
      loadIdps: async () => ({ idps, basicLogin: true }),
    });
    const sentinel = document.createElement('div');
    app.root.replaceChildren(sentinel);
    const host = document.createElement('div');
    mountInlineLogin(app, host);
    await tick();
    expect(app.root.firstElementChild).toBe(sentinel);
    expect(showLogin).not.toHaveBeenCalled();
    expect(host.querySelector('.login-sso .login-btn')).toBeNull();
    expect(qs(host, '.login-inline-oauth-unavailable').getAttribute('role')).toBe('status');
    expect(login).not.toHaveBeenCalled();
  });

  it('prefills and reuses the exact prior Basic target during inline recovery', async () => {
    const connect = vi.fn(async () => {});
    const app = appWith({
      actions: { connect },
      basicRecoveryOrigin: () => 'https://db.example:9440',
    });
    const host = document.createElement('div');
    mountInlineLogin(app, host);
    const [user, pass, target] = qsa<HTMLInputElement>(host, '.login-input');

    expect(target.value).toBe('https://db.example:9440');
    expect(qs(host, '.login-target .lt-host').textContent).toBe('https://db.example:9440');
    type(user, 'alice');
    type(pass, 'fresh-secret');
    click(qs(host, '.login-creds .login-btn'));
    await tick();

    expect(connect).toHaveBeenCalledWith({
      username: 'alice', password: 'fresh-secret', host: 'https://db.example:9440',
    });
  });

  it('resets a successful Basic submission so the retained mount supports a second recovery cycle', async () => {
    const connect = vi.fn(async () => {});
    const app = appWith({ actions: { connect } });
    const host = document.createElement('div');
    const handle = mountInlineLogin(app, host);
    const [user, pass] = qsa<HTMLInputElement>(host, '.login-input');
    const eye = qs<HTMLButtonElement>(host, '.login-eye');
    const button = qs<HTMLButtonElement>(host, '.login-creds .login-btn');

    type(user, 'alice');
    type(pass, 'first-secret');
    click(eye); // prove a successful cycle also resets password visibility
    expect(pass.type).toBe('text');
    click(button);
    await tick();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(pass.value).toBe('');
    expect(pass.type).toBe('password');
    expect(eye.title).toBe('Show password');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Connect');

    handle.hide();
    handle.show('Expired again');
    expect(button.disabled).toBe(false);
    type(pass, 'second-secret');
    click(button);
    await tick();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenLastCalledWith({
      username: 'alice', password: 'second-secret', host: '',
    });
    expect(pass.value).toBe('');
    expect(button.disabled).toBe(false);
  });

  it('does not let a stale successful recovery clear a newer recovery presentation', async () => {
    let resolveFirst: (() => void) | undefined;
    const connect = vi.fn(() => new Promise<void>((resolve) => { resolveFirst = resolve; }));
    const app = appWith({ actions: { connect } });
    const host = document.createElement('div');
    const handle = mountInlineLogin(app, host);
    const [user, pass] = qsa<HTMLInputElement>(host, '.login-input');
    const button = qs<HTMLButtonElement>(host, '.login-creds .login-btn');

    type(user, 'alice'); type(pass, 'old-secret');
    click(button);
    expect(button.disabled).toBe(true);
    handle.hide(); // actions.connect normally hides the retained recovery host
    handle.show('Credentials expired again');
    type(pass, 'new-secret');
    expect(button.disabled).toBe(false); // a new recovery cycle is immediately usable

    resolveFirst?.();
    await tick();

    expect(pass.value).toBe('new-secret');
    expect(qs<HTMLElement>(host, '.login-error').textContent).toBe('Credentials expired again');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Connect');
  });

  it('does not let a stale failed recovery overwrite or block a newer recovery cycle', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    let attempts = 0;
    const connect = vi.fn(() => {
      attempts += 1;
      return attempts === 1
        ? new Promise<void>((_resolve, reject) => { rejectFirst = reject; })
        : Promise.resolve();
    });
    const app = appWith({ actions: { connect } });
    const host = document.createElement('div');
    const handle = mountInlineLogin(app, host);
    const [user, pass] = qsa<HTMLInputElement>(host, '.login-input');
    const button = qs<HTMLButtonElement>(host, '.login-creds .login-btn');

    type(user, 'alice'); type(pass, 'old-secret');
    click(button);
    handle.hide();
    handle.show('Credentials expired again');
    type(pass, 'fresh-secret');

    rejectFirst?.(new Error('old password rejected'));
    await tick();

    expect([user.value, pass.value]).toEqual(['alice', 'fresh-secret']);
    expect(qs<HTMLElement>(host, '.login-error').textContent).toBe('Credentials expired again');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Connect');

    click(button); // the current presentation can retry even after old failure settles
    await tick();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(pass.value).toBe('');
    expect(button.disabled).toBe(false);
  });

  it('does not expose OAuth navigation inline before the recovery checkpoint exists', async () => {
    const login = vi.fn(async () => {});
    const app = appWith({
      actions: { login },
      loadIdps: async () => ({
        idps: [{ id: 'g', label: 'Google' }], basicLogin: false,
        hosts: [{
          label: 'oauth-only', url: 'https://db.example', auth: 'oauth',
          user: '', password: '', idp: 'g', insecure: false,
        }],
      }),
    });
    const host = document.createElement('div');
    mountInlineLogin(app, host);
    await tick();

    expect(host.querySelector('.login-sso button')).toBeNull();
    expect(qs<HTMLElement>(host, '.login-picker-field').style.display).toBe('none');
    expect(host.querySelector('.login-creds')).toBeNull();
    const message = qs<HTMLElement>(host, '.login-inline-oauth-unavailable');
    expect(message.getAttribute('role')).toBe('status');
    expect(message.textContent).toContain('Single sign-on');
    expect(login).not.toHaveBeenCalled();
  });

  it('hides, shows, and focuses the existing mount without rebuilding it', () => {
    const app = appWith();
    const host = document.createElement('div');
    host.hidden = true;
    document.body.append(host);
    const handle = mountInlineLogin(app, host, 'Sign in again');
    const card = qs(host, '.login-card');
    const user = qsa<HTMLInputElement>(host, '.login-input')[0];

    expect(host.hidden).toBe(false);
    expect(document.activeElement).toBe(user);
    handle.hide();
    expect(host.hidden).toBe(true);
    handle.show('Session expired');
    expect(host.hidden).toBe(false);
    expect(qs(host, '.login-card')).toBe(card);
    expect(qs(host, '.login-error').textContent).toBe('Session expired');
    expect(document.activeElement).toBe(user);
    host.remove();
  });

  it('dispose removes only its own mount and fences a late IdP load', async () => {
    let resolveConfig: ((value: TestIdpsResult) => void) | undefined;
    const loadIdps = () => new Promise<TestIdpsResult>((resolve) => { resolveConfig = resolve; });
    const app = appWith({ loadIdps });
    const host = document.createElement('div');
    const handle = mountInlineLogin(app, host);
    const detachedContainer = qs<HTMLElement>(host, '.login-inline');

    handle.dispose();
    const replacement = document.createElement('div');
    replacement.className = 'new-owner';
    host.append(replacement);
    resolveConfig?.({ idps, basicLogin: false, hosts });
    await tick();

    expect(host.hidden).toBe(true);
    expect(host.firstElementChild).toBe(replacement);
    expect(detachedContainer.querySelector('.login-sso .login-btn')).toBeNull();
    expect(detachedContainer.querySelector('.login-creds')).not.toBeNull();
    handle.show('ignored after disposal');
    expect(host.firstElementChild).toBe(replacement);
  });

  it('fences a late credential failure after an inline mount is disposed', async () => {
    let rejectConnect: ((reason?: unknown) => void) | undefined;
    const connect = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectConnect = reject; }));
    const app = appWith({
      actions: { connect },
      loadIdps: async () => ({ idps, basicLogin: true }),
    });
    const host = document.createElement('div');
    const basic = mountInlineLogin(app, host);
    const [user, pass] = qsa<HTMLInputElement>(host, '.login-input');
    type(user, 'alice'); type(pass, 'wrong');
    click(qs(host, '.login-creds .login-btn'));
    await tick();
    basic.dispose();
    rejectConnect?.(new Error('late credential failure'));
    await tick();
    expect(host.querySelector('.login-error')).toBeNull();
  });

  it('makes hidden and disposed inline handle methods inert', () => {
    const app = appWith();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = mountInlineLogin(app, host);
    handle.hide();
    handle.focus(); // hidden controls must not steal focus
    expect(host.hidden).toBe(true);
    host.replaceChildren(); // mount was independently removed by a shell owner
    handle.dispose();
    handle.dispose();
    handle.show('ignored');
    handle.focus();
    expect(host.hidden).toBe(true);
    host.remove();
  });

  it('a full-screen re-render fences the superseded mount config load', async () => {
    let resolveFirst: ((value: TestIdpsResult) => void) | undefined;
    const app = appWith({
      loadIdps: () => new Promise<TestIdpsResult>((resolve) => { resolveFirst = resolve; }),
    });
    renderLogin(app);
    const oldCard = qs<HTMLElement>(app.root, '.login-card');
    app.conn.loadIdps = asLoadIdps(async () => ({ idps: [], basicLogin: true }));
    renderLogin(app, 'new screen');

    resolveFirst?.({ idps, basicLogin: false, hosts });
    await tick();

    expect(app.root.contains(oldCard)).toBe(false);
    expect(oldCard.querySelector('.login-sso .login-btn')).toBeNull();
    expect(oldCard.querySelector('.login-creds')).not.toBeNull();
    expect(qs(app.root, '.login-error').textContent).toBe('new screen');
  });
});
