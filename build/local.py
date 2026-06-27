#!/usr/bin/env python3
"""Serve the built SQL browser locally, with a host picker from clickhouse-client.

The app is a thin client: in *credentials* mode its login form takes a ClickHouse
host and queries it directly (cross-origin); in OAuth mode it signs in via an IdP
and sends the bearer to the chosen cluster. So this server only serves the SPA +
a generated config.json — there's nothing to proxy and no ClickHouse to run here.

It merges connections from `~/.clickhouse-client/config.xml` (your own) and
`~/.clickhouse-client/sql-browser.xml` (the demo file installed by install.sh),
de-duped by name (your config.xml wins), and offers them as a
**Saved connection** dropdown on the login screen:
  • a plain connection (hostname/user/password) → prefills the credentials form.
  • a connection carrying clickhouse-client's OAuth keys (`oauth-url`,
    `oauth-client-id`, optional `oauth-client-secret` for a Web client like Google,
    `oauth-audience`) → an OAuth sign-in against that cluster.

  A connection with `<accept-invalid-certificate>1</accept-invalid-certificate>`
  is flagged `insecure` in config.json. The browser can't skip TLS validation
  from fetch(), so the login screen walks the user through trusting the cert
  once (opening the cluster in a tab) before connecting.

    npm run local            # build + serve, then open http://localhost:8900/sql

For OAuth connections you also register `http://localhost:8900/sql` as a redirect
URI with the IdP and allow CORS from localhost on the cluster (see README).

Env: PORT (default 8900) · LOCAL_CH_CONFIG (override with a single explicit file)
   · SQL_BROWSER_SPA (override the sql.html path).
"""
import json
import os
import sys
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


def _find_spa():
    """Locate the built sql.html across both layouts (explicit override wins):
      • $SQL_BROWSER_SPA            — explicit path
      • <dir>/sql.html             — release bundle (local.py + sql.html together)
      • <dir>/../dist/sql.html     — dev / in-repo checkout
    Returns the first that exists, else the dev path (so the missing-file error
    names the place a contributor expects to build into)."""
    env = os.environ.get("SQL_BROWSER_SPA")
    if env:
        return env
    bundle = os.path.join(HERE, "sql.html")
    dev = os.path.join(HERE, "..", "dist", "sql.html")
    return bundle if os.path.exists(bundle) else dev


SPA = _find_spa()
PORT = int(os.environ.get("PORT", "8900"))
CH_DIR = os.path.expanduser("~/.clickhouse-client")


def config_paths():
    """Files to read connections from, in precedence order (first wins on a name
    clash). LOCAL_CH_CONFIG overrides the list with a single explicit file; else
    we merge the user's own `config.xml` with the SQL-browser demo file —
    installed at ~/.clickhouse-client/sql-browser.xml and/or shipped next to this
    runner in the release bundle. Missing files are skipped silently."""
    env = os.environ.get("LOCAL_CH_CONFIG")
    if env:
        return [env]
    return [
        os.path.join(CH_DIR, "config.xml"),       # the user's own connections — win on clash
        os.path.join(CH_DIR, "sql-browser.xml"),  # installed by install.sh
        os.path.join(HERE, "sql-browser.xml"),     # run-from-bundle fallback (same names → deduped)
    ]


def _connections():
    """Yield <connection> elements from every configured file that parses."""
    for path in config_paths():
        try:
            root = ET.parse(path).getroot()
        except (OSError, ET.ParseError):
            continue
        for conn in root.iter("connection"):
            yield conn


def _text(conn, *names):
    """First non-empty child text among `names` (dash/underscore variants)."""
    for n in names:
        el = conn.find(n)
        if el is not None and el.text and el.text.strip():
            return el.text.strip()
    return ""


def build_config():
    """Generate config.json from the clickhouse-client connections (best-effort),
    merged across config_paths() and de-duped by connection name (first file wins)."""
    idps, hosts, seen, names = [], [], set(), set()
    for conn in _connections():
        name = _text(conn, "name")
        hostname = _text(conn, "hostname")
        if not name or not hostname or name in names:
            continue
        names.add(name)
        secure = _text(conn, "secure").lower() in ("1", "true", "yes")
        # A self-signed / wrong-host TLS cert. The browser can't bypass cert
        # validation from fetch(), so the SPA can't honour this on its own — it
        # flags the connection and walks the user through trusting the cert once
        # (see populateHosts in src/ui/login.js).
        insecure = _text(conn, "accept-invalid-certificate", "accept_invalid_certificate").lower() in ("1", "true", "yes")
        # The browser talks to ClickHouse's HTTP interface, NOT the native <port>
        # (9440/9000) clickhouse-client uses — those are independent server ports,
        # so we never derive one from the other. Read <http_port> if given; else
        # fall back to the HTTP-interface default keyed off `secure`.
        http_port = _text(conn, "http_port", "http-port")
        scheme = "https" if secure else "http"
        # Default to ClickHouse's HTTP-interface ports (8443 TLS / 8123 plain), NOT
        # 443/80 — mirrors the SPA's resolveTarget for a bare host. Managed endpoints
        # often park an auth gateway on 443 (a browser GET 302s to an SSO login), so
        # 443 wouldn't reach ClickHouse; 8443 is the direct HTTPS interface. Set an
        # explicit <http_port> to override (e.g. 443 for a proxy that fronts the HTTP
        # interface there with no gateway).
        # Don't double-append when <hostname> already carries a port (clickhouse-client
        # accepts host:port), else 'h:9000' would become 'h:9000:8443'.
        tail = hostname.rsplit(":", 1)
        has_port = len(tail) == 2 and tail[1].isdigit()
        url = f"{scheme}://{hostname}" if has_port else f"{scheme}://{hostname}:{http_port or ('8443' if secure else '8123')}"
        oauth_url = _text(conn, "oauth-url", "oauth_url")
        oauth_client = _text(conn, "oauth-client-id", "oauth_client_id")
        oauth_secret = _text(conn, "oauth-client-secret", "oauth_client_secret")
        oauth_aud = _text(conn, "oauth-audience", "oauth_audience")
        if oauth_url and oauth_client:
            if name not in seen:
                idps.append({
                    "id": name, "label": name, "issuer": oauth_url, "client_id": oauth_client,
                    # Optional: a Web-client secret (e.g. Google) for the code exchange.
                    # Empty → public PKCE. clickhouse-client has no such flag, so this is
                    # a local-only convenience key read from the same connection.
                    "client_secret": oauth_secret, "audience": oauth_aud,
                    "bearer": "access_token" if oauth_aud else "id_token",
                })
                seen.add(name)
            hosts.append({"label": name, "url": url, "auth": "oauth", "idp": name, "insecure": insecure})
        else:
            hosts.append({"label": name, "url": url, "auth": "basic",
                          "user": _text(conn, "user"), "password": _text(conn, "password"),
                          "insecure": insecure})
    return json.dumps({"basic_login": True, "idps": idps, "hosts": hosts}).encode()


CONFIG = build_config()


class Handler(BaseHTTPRequestHandler):
    def _send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.endswith("/config.json"):
            self._send(CONFIG, "application/json; charset=utf-8")
            return
        if path.rstrip("/") in ("", "/sql", "/sql.html"):
            try:
                with open(SPA, "rb") as f:
                    html = f.read()
            except FileNotFoundError:
                self._send(b"dist/sql.html missing - run `npm run build`.\n", "text/plain", 500)
                return
            self._send(html, "text/html; charset=utf-8")
            return
        self._send(b"not found\n", "text/plain", 404)

    def log_message(self, *_a):  # keep the console quiet
        pass


def main():
    if not os.path.exists(SPA):
        sys.exit("dist/sql.html not found - run `npm run build` first (or `npm run local`).")
    n = json.loads(CONFIG)["hosts"]
    srcs = ", ".join(p for p in config_paths() if os.path.exists(p)) or "(no connection files found)"
    print(
        f"\n  Altinity SQL Browser - local static server\n"
        f"  ▸ open    http://localhost:{PORT}/sql\n"
        f"  ▸ {len(n)} saved connection(s) from {srcs}\n"
        f"  ▸ Ctrl-C to stop\n"
    )
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
