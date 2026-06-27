import { describe, it, expect, vi } from 'vitest';
import { renderLogin } from '../../src/ui/login.js';
import { makeApp } from '../helpers/fake-app.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));
function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}
function selectHost(root, value) {
  const sel = root.querySelector('.login-picker');
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
}
// makeApp defaults loadIdps → { idps: [], basicLogin: true }. Override per test.
function appWith(over = {}) {
  const base = makeApp();
  return makeApp({ ...over, actions: { ...base.actions, ...(over.actions || {}) } });
}

describe('renderLogin — structure', () => {
  it('renders brand, credentials, target row, and footer — no "Sign in" title/subtitle', () => {
    const app = appWith();
    renderLogin(app);
    expect(app.root.querySelector('.login-brand-name').textContent).toContain('Altinity');
    expect(app.root.querySelector('.login-h1')).toBeNull(); // title removed
    expect(app.root.querySelector('.login-sub')).toBeNull(); // subtitle removed
    expect(app.root.querySelectorAll('.login-input')).toHaveLength(3); // user, pass, host
    expect(app.root.querySelector('.login-target .lt-as').textContent).toBe('via SSO');
    expect(app.root.querySelector('.login-foot-link[href*="github.com"]')).not.toBeNull();
    expect(app.root.querySelector('.login-error')).toBeNull();
  });
  it('shows an error message when given', () => {
    const app = appWith();
    renderLogin(app, 'boom');
    expect(app.root.querySelector('.login-error').textContent).toBe('boom');
  });
  it('uses the host for the target row and the host placeholder', () => {
    const app = appWith({ host: () => 'ch.demo' });
    renderLogin(app);
    expect(app.root.querySelector('.login-target .lt-host').textContent).toBe('ch.demo');
    const hostInput = app.root.querySelectorAll('.login-input')[2];
    expect(hostInput.getAttribute('placeholder')).toBe('ch.demo:8443');
  });
});

describe('renderLogin — host picker', () => {
  const hosts = [
    { label: 'demo', url: 'http://localhost:8123', auth: 'basic', user: 'default', password: 'pw', idp: '' },
    { label: 'antalya', url: 'https://antalya.demo.altinity.cloud', auth: 'oauth', user: '', password: '', idp: 'google' },
  ];
  const withHosts = (over = {}) => appWith({ loadIdps: async () => ({ idps: [], basicLogin: true, hosts }), ...over });

  it('is hidden when no hosts are configured', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [], basicLogin: true, hosts: [] }) });
    renderLogin(app); await tick();
    expect(app.root.querySelector('.login-picker-field').style.display).toBe('none');
  });
  it('lists configured hosts (OAuth tagged) when present', async () => {
    const app = withHosts();
    renderLogin(app); await tick();
    expect(app.root.querySelector('.login-picker-field').style.display).toBe('');
    expect([...app.root.querySelector('.login-picker').options].map((o) => o.textContent))
      .toEqual(['Choose a connection…', 'demo', 'antalya (OAuth)']);
  });
  it('selecting a basic host prefills host/user/password and opens Advanced', async () => {
    const app = withHosts();
    renderLogin(app); await tick();
    selectHost(app.root, '0');
    const [user, pass, host] = app.root.querySelectorAll('.login-input');
    expect([host.value, user.value, pass.value]).toEqual(['http://localhost:8123', 'default', 'pw']);
    expect(app.root.querySelector('.login-adv-field').style.display).toBe('');
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
      hosts: [{ label: 'antalya', url: 'https://antalya.demo.altinity.cloud', auth: 'oauth', idp: 'antalya-oauth', user: '', password: '' }],
    }) });
    renderLogin(app); await tick();
    const labels = [...app.root.querySelectorAll('.login-sso .login-btn')].map((b) => b.textContent);
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
    expect(app.root.querySelector('.login-picker').disabled).toBe(false);
  });
});

describe('renderLogin — insecure (accept-invalid-certificate) hosts', () => {
  const insecureHosts = [
    { label: 'audit', url: 'https://support-a.tenant-a.dev.altinity.cloud', auth: 'basic', user: 'mcp', password: 'pw', idp: '', insecure: true },
    { label: 'audit-oauth', url: 'https://support-a.tenant-a.dev.altinity.cloud', auth: 'oauth', user: '', password: '', idp: 'google', insecure: true },
  ];
  const withInsecure = (over = {}) => appWith({ loadIdps: async () => ({ idps: [], basicLogin: true, hosts: insecureHosts }), ...over });

  it('basic insecure host: prefills the form and shows the cert-trust step with an open-cluster link (no Continue button)', async () => {
    const login = vi.fn();
    const app = withInsecure({ actions: { login } });
    renderLogin(app); await tick();
    selectHost(app.root, '0');
    const [user, , host] = app.root.querySelectorAll('.login-input');
    expect([host.value, user.value]).toEqual(['https://support-a.tenant-a.dev.altinity.cloud', 'mcp']);
    const warn = app.root.querySelector('.login-cert-warn');
    expect(warn.style.display).toBe('');
    const link = warn.querySelector('.login-cert-link');
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
    click(go);
    expect(login).toHaveBeenCalledWith('google', 'https://support-a.tenant-a.dev.altinity.cloud');
  });

  it('oauth insecure host: Continue guards against double-submit (disables itself + busy gate)', async () => {
    // login stays pending so `busy` is still 'sso' on the second click.
    const login = vi.fn(() => new Promise(() => {}));
    const app = withInsecure({ actions: { login } });
    renderLogin(app); await tick();
    selectHost(app.root, '1');
    const go = app.root.querySelector('.login-cert-go');
    click(go);
    expect(go.disabled).toBe(true);
    click(go); // re-entry blocked by the busy guard in pickOAuth
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('clears the cert step when switching to the placeholder or a normal connection', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [], basicLogin: true, hosts: [
      ...insecureHosts,
      { label: 'plain', url: 'http://localhost:8123', auth: 'basic', user: 'default', password: 'pw', idp: '' },
    ] }) });
    renderLogin(app); await tick();
    selectHost(app.root, '0');
    expect(app.root.querySelector('.login-cert-warn').style.display).toBe('');
    selectHost(app.root, '');
    expect(app.root.querySelector('.login-cert-warn').style.display).toBe('none');
    selectHost(app.root, '0');
    expect(app.root.querySelector('.login-cert-warn').style.display).toBe('');
    selectHost(app.root, '2'); // a normal (secure) basic connection
    expect(app.root.querySelector('.login-cert-warn').style.display).toBe('none');
  });
});

describe('renderLogin — SSO section', () => {
  it('no IdPs → no SSO button, divider hidden, credentials present', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [], basicLogin: true }) });
    renderLogin(app);
    await tick();
    expect(app.root.querySelectorAll('.login-sso .login-btn')).toHaveLength(0);
    expect(app.root.querySelector('.login-divider').style.display).toBe('none');
    expect(app.root.querySelector('.login-creds')).not.toBeNull();
  });
  it('one IdP → a single IdP-labelled button + divider shown', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: true }) });
    renderLogin(app);
    await tick();
    const btns = [...app.root.querySelectorAll('.login-sso .login-btn')];
    expect(btns.map((b) => b.textContent)).toEqual(['Continue with Google']);
    expect(app.root.querySelector('.login-divider').style.display).toBe('');
    expect(app.root.querySelector('.login-sso-note').textContent).toContain('Authenticates on');
  });
  it('multiple IdPs → one button per provider', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }, { id: 'a', label: 'Acme' }], basicLogin: true }) });
    renderLogin(app);
    await tick();
    const btns = [...app.root.querySelectorAll('.login-sso .login-btn')];
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

describe('renderLogin — footer tag adapts to available methods', () => {
  const ver = (app) => app.root.querySelector('.login-foot-ver').textContent;
  const render = async (over) => { const app = appWith(over); renderLogin(app); await tick(); return app; };

  it('SSO + credentials', async () => {
    expect(ver(await render({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: true }) }))).toBe('OAuth · credentials');
  });
  it('SSO only (basic_login:false)', async () => {
    expect(ver(await render({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: false }) }))).toBe('OAuth');
  });
  it('credentials only (no IdPs)', async () => {
    expect(ver(await render({ loadIdps: async () => ({ idps: [], basicLogin: true }) }))).toBe('credentials');
  });
  it('neither method configured', async () => {
    expect(ver(await render({ loadIdps: async () => ({ idps: [], basicLogin: false }) }))).toBe('—');
  });
  it('config load failure → credentials-only', async () => {
    expect(ver(await render({ loadIdps: async () => { throw new Error('x'); } }))).toBe('credentials');
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
    const hostInput = app.root.querySelectorAll('.login-input')[2];
    expect(hostInput.value).toBe('antalya.demo:9000');
    expect(app.root.querySelector('.login-adv-field').style.display).toBe(''); // opened
    const sso = app.root.querySelector('.login-sso .login-btn');
    expect(sso.disabled).toBe(true); // SSO can't target a custom host
    expect(app.root.querySelector('.lt-host').textContent).toBe('antalya.demo:9000');
    expect(app.root.querySelector('.lt-as').textContent).toBe('credentials');
  });
  it('typing a host (no URL hint) also disables SSO', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: true }) });
    renderLogin(app);
    await tick();
    const sso = app.root.querySelector('.login-sso .login-btn');
    expect(sso.disabled).toBe(false);
    type(app.root.querySelectorAll('.login-input')[2], 'other:9000');
    expect(sso.disabled).toBe(true);
  });
});

describe('renderLogin — credentials reactivity', () => {
  it('typing both fields flips Connect to primary and demotes SSO to ghost', async () => {
    const app = appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: true }) });
    renderLogin(app);
    await tick();
    const [user, pass] = app.root.querySelectorAll('.login-input');
    const connect = app.root.querySelector('.login-creds .login-btn');
    const sso = app.root.querySelector('.login-sso .login-btn');
    expect(connect.classList.contains('btn-ghost')).toBe(true);
    expect(connect.disabled).toBe(true);
    type(user, 'default');
    type(pass, 'secret');
    expect(connect.classList.contains('btn-primary')).toBe(true);
    expect(connect.disabled).toBe(false);
    expect(sso.classList.contains('btn-ghost')).toBe(true);
    expect(app.root.querySelector('.lt-as').textContent).toBe('as default');
  });
  it('the host field drives the target host', () => {
    const app = appWith();
    renderLogin(app);
    const host = app.root.querySelectorAll('.login-input')[2];
    type(host, 'other:9000');
    expect(app.root.querySelector('.lt-host').textContent).toBe('other:9000');
  });
  it('password show/hide toggles the input type', () => {
    const app = appWith();
    renderLogin(app);
    const pass = app.root.querySelectorAll('.login-input')[1];
    const eye = app.root.querySelector('.login-eye');
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
    const advField = app.root.querySelector('.login-adv-field');
    const toggle = app.root.querySelector('.login-disc');
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
    const [user, pass, host] = app.root.querySelectorAll('.login-input');
    type(user, ' default ');
    type(pass, 'pw');
    type(host, 'h:1');
    click(app.root.querySelector('.login-creds .login-btn'));
    await tick();
    expect(connect).toHaveBeenCalledWith({ username: ' default ', password: 'pw', host: 'h:1' });
  });
  it('Enter in a field submits when both credentials are present', async () => {
    const connect = vi.fn(async () => {});
    const app = appWith({ actions: { connect } });
    renderLogin(app);
    const [user, pass] = app.root.querySelectorAll('.login-input');
    type(user, 'u'); type(pass, 'p');
    pass.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    expect(connect).toHaveBeenCalled();
  });
  it('Enter without both credentials does nothing; other keys ignored', async () => {
    const connect = vi.fn(async () => {});
    const app = appWith({ actions: { connect } });
    renderLogin(app);
    const [user] = app.root.querySelectorAll('.login-input');
    type(user, 'only-user');
    user.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    user.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await tick();
    expect(connect).not.toHaveBeenCalled();
  });
  it('clicking Connect with empty fields is a no-op', async () => {
    const connect = vi.fn(async () => {});
    const app = appWith({ actions: { connect } });
    renderLogin(app);
    click(app.root.querySelector('.login-creds .login-btn'));
    await tick();
    expect(connect).not.toHaveBeenCalled();
  });
  it('connect failure surfaces the error via showLogin', async () => {
    const showLogin = vi.fn();
    const connect = vi.fn(async () => { throw new Error('wrong password'); });
    const app = appWith({ showLogin, actions: { connect } });
    renderLogin(app);
    const [user, pass] = app.root.querySelectorAll('.login-input');
    type(user, 'u'); type(pass, 'bad');
    click(app.root.querySelector('.login-creds .login-btn'));
    await tick();
    expect(showLogin).toHaveBeenCalledWith('wrong password');
  });
  it('connect failure with a non-Error value stringifies it', async () => {
    const showLogin = vi.fn();
    const connect = vi.fn(async () => { throw 'nope'; });
    const app = appWith({ showLogin, actions: { connect } });
    renderLogin(app);
    const [user, pass] = app.root.querySelectorAll('.login-input');
    type(user, 'u'); type(pass, 'p');
    click(app.root.querySelector('.login-creds .login-btn'));
    await tick();
    expect(showLogin).toHaveBeenCalledWith('nope');
  });
  it('ignores a second Connect while one is in flight', async () => {
    let resolve;
    const connect = vi.fn(() => new Promise((r) => { resolve = r; }));
    const app = appWith({ actions: { connect } });
    renderLogin(app);
    const [user, pass] = app.root.querySelectorAll('.login-input');
    type(user, 'u'); type(pass, 'p');
    const btn = app.root.querySelector('.login-creds .login-btn');
    click(btn);
    expect(btn.textContent).toBe('Connecting…');
    click(btn); // busy → ignored
    expect(connect).toHaveBeenCalledTimes(1);
    resolve();
    await tick();
  });
});

describe('renderLogin — SSO flow', () => {
  function ssoApp(over = {}) {
    return appWith({ loadIdps: async () => ({ idps: [{ id: 'g', label: 'Google' }], basicLogin: true }), ...over });
  }
  it('clicking SSO calls login(id) and shows Redirecting…', async () => {
    const login = vi.fn(async () => {});
    const app = ssoApp({ actions: { login } });
    renderLogin(app);
    await tick();
    const sso = app.root.querySelector('.login-sso .login-btn');
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
    click(app.root.querySelector('.login-sso .login-btn'));
    await tick();
    expect(showLogin).toHaveBeenCalledWith('redirect failed');
  });
  it('SSO failure with a non-Error value stringifies it', async () => {
    const showLogin = vi.fn();
    const login = vi.fn(async () => { throw 'sso-raw'; });
    const app = ssoApp({ showLogin, actions: { login } });
    renderLogin(app);
    await tick();
    click(app.root.querySelector('.login-sso .login-btn'));
    await tick();
    expect(showLogin).toHaveBeenCalledWith('sso-raw');
  });
  it('ignores a second SSO click while one is in flight', async () => {
    let resolve;
    const login = vi.fn(() => new Promise((r) => { resolve = r; }));
    const app = ssoApp({ actions: { login } });
    renderLogin(app);
    await tick();
    const sso = app.root.querySelector('.login-sso .login-btn');
    click(sso);
    click(sso); // busy → ignored
    expect(login).toHaveBeenCalledTimes(1);
    resolve();
    await tick();
  });
});
