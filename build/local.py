#!/usr/bin/env python3
"""Serve the built SQL browser locally, with a host picker from clickhouse-client.

The app is a thin client: in *credentials* mode its login form takes a ClickHouse
host and queries it directly (cross-origin); in OAuth mode it signs in via an IdP
and sends the bearer to the chosen cluster. So this server only serves the SPA +
a generated config.json — there's nothing to proxy and no ClickHouse to run here.

It reads your `~/.clickhouse-client/config.xml` connections and offers them as a
**Saved connection** dropdown on the login screen:
  • a plain connection (hostname/user/password) → prefills the credentials form.
  • a connection carrying clickhouse-client's OAuth keys (`oauth-url`,
    `oauth-client-id`, optional `oauth-client-secret` for a Web client like Google,
    `oauth-audience`) → an OAuth sign-in against that cluster.

    npm run local            # build + serve, then open http://localhost:8900/sql

For OAuth connections you also register `http://localhost:8900/sql` as a redirect
URI with the IdP and allow CORS from localhost on the cluster (see README).

Env: PORT (default 8900) · LOCAL_CH_CONFIG (default ~/.clickhouse-client/config.xml).
"""
import json
import os
import sys
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPA = os.path.join(ROOT, "dist", "sql.html")
PORT = int(os.environ.get("PORT", "8900"))
CH_CONFIG = os.environ.get("LOCAL_CH_CONFIG") or os.path.expanduser("~/.clickhouse-client/config.xml")


def _text(conn, *names):
    """First non-empty child text among `names` (dash/underscore variants)."""
    for n in names:
        el = conn.find(n)
        if el is not None and el.text and el.text.strip():
            return el.text.strip()
    return ""


def build_config():
    """Generate config.json from the clickhouse-client connections (best-effort)."""
    idps, hosts, seen = [], [], set()
    try:
        root = ET.parse(CH_CONFIG).getroot()
    except (OSError, ET.ParseError):
        root = None
    for conn in (root.iter("connection") if root is not None else []):
        name = _text(conn, "name")
        hostname = _text(conn, "hostname")
        if not name or not hostname:
            continue
        secure = _text(conn, "secure").lower() in ("1", "true", "yes")
        http_port = _text(conn, "http_port", "http-port")
        scheme = "https" if secure else "http"
        url = f"{scheme}://{hostname}:{http_port}" if http_port else f"{scheme}://{hostname}"
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
            hosts.append({"label": name, "url": url, "auth": "oauth", "idp": name})
        else:
            hosts.append({"label": name, "url": url, "auth": "basic",
                          "user": _text(conn, "user"), "password": _text(conn, "password")})
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
    print(
        f"\n  Altinity SQL Browser - local static server\n"
        f"  ▸ open    http://localhost:{PORT}/sql\n"
        f"  ▸ {len(n)} saved connection(s) from {CH_CONFIG}\n"
        f"  ▸ Ctrl-C to stop\n"
    )
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
