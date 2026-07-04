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

At startup it probes each connection's HTTP interface — trying both standard ports
(443 then 8443 for secure, 8123 then 80 for plain) and using whichever answers Ok.
on /ping — and prints a
reachability table; hosts with no HTTP interface on any port (native-only
endpoints) are skipped from the picker so they aren't dead picks. Set
SQL_BROWSER_PROBE=0 to keep all hosts.

Env: PORT (default 8900) · LOCAL_CH_CONFIG (override with a single explicit file)
   · SQL_BROWSER_SPA (override the sql.html path) · SQL_BROWSER_PROBE (0 to skip
   the reachability probe) · SQL_BROWSER_PROBE_TIMEOUT (seconds, default 4).
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
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
HOST = os.environ.get("HOST", "127.0.0.1")
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


def collect():
    """Parse + merge + de-dupe the connection files (first file wins on a name
    clash). Pure — no network. Returns (idps_by_id, hosts)."""
    idps_by_id, hosts, names = {}, [], set()
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
        # Candidate HTTP URLs to try, in order — the startup probe picks the first
        # whose /ping answers (see probe()). An explicit <http_port> or a port
        # already embedded in <hostname> is respected as the sole candidate;
        # otherwise we try BOTH standard HTTP ports for the scheme, since a cluster
        # may serve ClickHouse on 8443 (direct) or 443 (TLS-terminating proxy). The
        # native <port> (9440/9000) is never used — it's a different interface.
        tail = hostname.rsplit(":", 1)
        if len(tail) == 2 and tail[1].isdigit():       # hostname already has a port
            alts = [f"{scheme}://{hostname}"]
        elif http_port:                                 # explicit override
            alts = [f"{scheme}://{hostname}:{http_port}"]
        else:                                           # try both standard ports
            # Secure: 443 first (the canonical public endpoint for managed clusters,
            # and it dodges the 8443 timeout when only 443 is open) — the /ping=='Ok.'
            # check still rejects a 443 auth-gateway and falls through to 8443. Plain:
            # 8123 first (the ClickHouse default; 80 is rarely the HTTP interface).
            alts = [f"{scheme}://{hostname}:{p}" for p in (("443", "8443") if secure else ("8123", "80"))]
        url = alts[0]
        oauth_url = _text(conn, "oauth-url", "oauth_url")
        oauth_client = _text(conn, "oauth-client-id", "oauth_client_id")
        oauth_secret = _text(conn, "oauth-client-secret", "oauth_client_secret")
        oauth_aud = _text(conn, "oauth-audience", "oauth_audience")
        if oauth_url and oauth_client:
            idps_by_id.setdefault(name, {
                "id": name, "label": name, "issuer": oauth_url, "client_id": oauth_client,
                # Optional: a Web-client secret (e.g. Google) for the code exchange.
                # Empty → public PKCE. clickhouse-client has no such flag, so this is
                # a local-only convenience key read from the same connection.
                "client_secret": oauth_secret, "audience": oauth_aud,
                "bearer": "access_token" if oauth_aud else "id_token",
            })
            hosts.append({"label": name, "url": url, "auth": "oauth", "idp": name,
                          "insecure": insecure, "_alts": alts})
        else:
            hosts.append({"label": name, "url": url, "auth": "basic",
                          "user": _text(conn, "user"), "password": _text(conn, "password"),
                          "insecure": insecure, "_alts": alts})
    return idps_by_id, hosts


def serialize(idps_by_id, hosts):
    """Render config.json bytes, keeping only IdPs still referenced by a kept host
    (so dropping an unreachable OAuth host doesn't leave a dangling SSO button) and
    stripping internal `_`-prefixed fields (e.g. `_alts`) from the hosts."""
    used = {h["idp"] for h in hosts if h.get("auth") == "oauth"}
    idps = [idps_by_id[i] for i in idps_by_id if i in used]
    clean = [{k: v for k, v in h.items() if not k.startswith("_")} for h in hosts]
    return json.dumps({"basic_login": True, "idps": idps, "hosts": clean}).encode()


PROBE_TIMEOUT = float(os.environ.get("SQL_BROWSER_PROBE_TIMEOUT", "4"))


def _ping_ok(url, insecure):
    """GET <url>/ping and report whether ClickHouse answered 'Ok.'. Returns
    (ok, detail)."""
    ctx = ssl._create_unverified_context() if insecure else None
    try:
        req = urllib.request.Request(url.rstrip("/") + "/ping", method="GET")
        with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT, context=ctx) as r:
            body = r.read(16).decode("ascii", "replace").strip()
            return body == "Ok.", (f"HTTP {r.status}" if body == "Ok." else f"HTTP {r.status}, not ClickHouse")
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except urllib.error.URLError as e:            # refused / timeout / TLS / DNS
        return False, str(getattr(e, "reason", "") or type(e).__name__)
    except Exception as e:
        return False, type(e).__name__


def probe(host):
    """Try the host's candidate ports in order; the first whose /ping answers 'Ok.'
    wins. Returns (chosen_url|None, detail). None → no HTTP interface on any port
    (e.g. a native-only endpoint like play.clickhouse.com on :8443), so the host is
    skipped from the picker rather than offered as a dead pick."""
    notes = []
    for url in host["_alts"]:
        ok, detail = _ping_ok(url, host.get("insecure"))
        port = url.rsplit(":", 1)[-1]
        if ok:
            return url, f"port {port}"
        notes.append(f"{port}: {detail}")
    return None, "; ".join(notes)


def probe_all(hosts):
    """Probe every host concurrently. Returns a list of (chosen_url|None, detail)
    aligned with `hosts`."""
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(hosts)))) as ex:
        return list(ex.map(probe, hosts))


def build_config():
    """All connections as config.json bytes (no probing) — used by tests/imports."""
    return serialize(*collect())


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
        # Serve the SPA for the workbench (/sql) and the client-side dashboard
        # route (/sql/dashboard) — mirrors the production http_handlers rule so
        # "Open as dashboard" works under `npm run local` too (#149 D1).
        if path.rstrip("/") in ("", "/sql", "/sql.html", "/sql/dashboard"):
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
    global CONFIG
    idps_by_id, hosts = collect()
    srcs = ", ".join(p for p in config_paths() if os.path.exists(p)) or "(no connection files found)"
    probe_on = os.environ.get("SQL_BROWSER_PROBE", "1") != "0" and bool(hosts)

    # Probe each host's HTTP interface (trying both candidate ports) so the picker
    # only offers ones the browser can actually reach — a native-only endpoint like
    # play.clickhouse.com on :8443 is otherwise a dead pick. The full situation is
    # printed so nothing is silently dropped. Disable with SQL_BROWSER_PROBE=0.
    if probe_on:
        results = probe_all(hosts)
    else:
        results = [(h["_alts"][0], "not probed") for h in hosts]
    kept = []
    for h, (chosen, _d) in zip(hosts, results):
        if chosen:
            h["url"] = chosen          # pin the port that actually answered
            kept.append(h)
    CONFIG = serialize(idps_by_id, kept)

    width = max((len(h["label"]) for h in hosts), default=0)
    lines = ["",
             "  Altinity SQL Browser - local static server",
             f"  ▸ open    http://{HOST if HOST != '0.0.0.0' else 'localhost'}:{PORT}/sql",
             f"  ▸ connections from {srcs}:" if hosts else "  ▸ no connections found"]
    for h, (chosen, detail) in zip(hosts, results):
        if chosen:
            lines.append(f"      ✓ {h['label']:<{width}}  {h['auth']:<5}  {chosen}  ({detail})")
        else:
            lines.append(f"      ✗ {h['label']:<{width}}  {h['auth']:<5}  no HTTP interface — skipped  [{detail}]")
    if probe_on:
        n = sum(1 for c, _ in results if c)
        extra = f", {len(hosts) - n} skipped" if n < len(hosts) else ""
        lines.append(f"  ▸ {n}/{len(hosts)} reachable{extra}")
    lines += ["  ▸ Ctrl-C to stop  (SQL_BROWSER_PROBE=0 to skip the reachability check)", ""]
    print("\n".join(lines), flush=True)  # flush: serve_forever() never returns to flush for us

    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
