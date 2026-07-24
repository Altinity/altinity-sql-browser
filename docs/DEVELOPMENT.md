# Development and alternative runtimes

This guide covers source development and the Docker and Kubernetes runtimes.
For the zero-setup local installer, see the [README](../README.md#local-install).
For an on-ClickHouse installation, see the [deployment instructions](../README.md#installing-on-any-clickhouse-cluster).

## Source development

Source development requires **Node.js 22 or newer**. The committed `.nvmrc`
selects Node 22 for version managers such as `nvm`; `npm ci` exits with an
unsupported-engine error on older Node releases.

```bash
nvm use                # optional; reads Node 22 from .nvmrc
npm ci                 # exact dependency tree from the committed lockfile
npm test               # vitest + coverage gate
npm run build          # → dist/sql.html (single file)
npm run dev            # build + serve dist/ at http://localhost:8900
```

### Run a checkout against ClickHouse

```bash
npm run local          # build + serve → open http://localhost:8900/sql
```

The app is a thin client — queries go straight from the browser to the chosen
ClickHouse — so the local server only serves the page plus a generated
`config.json`. It reads your **`~/.clickhouse-client/config.xml`** connections and
offers them as a **Saved connection** dropdown on the login screen, or you can
ignore the picker and type a host/user/password by hand (host: include the
scheme, e.g. `http://localhost:8123`; a bare host defaults to
`https://<host>:8443`). See [LOGIN-SCREEN.md](LOGIN-SCREEN.md#the-saved-connection-picker-multi-host)
for exactly how the picker and manual host entry behave, including the
insecure-certificate flow.

The target ClickHouse must allow cross-origin requests — ClickHouse's HTTP
interface sends `Access-Control-Allow-Origin` for requests with an `Origin` header
by default, so a stock server works. For an **OAuth** connection, also register
`http://localhost:8900/sql` as a redirect URI with the IdP. Override the serve
port with `PORT` and the config path with `LOCAL_CH_CONFIG`. Ctrl-C stops it.

## Docker

The production image is a static **nginx** server for the single-file SPA — no
application backend. It serves `/sql`, including Workbench and Dashboard
surfaces selected by query parameters, serves a `config.json` you provide at
`/sql/config.json`, and answers `/healthz` for probes. Queries are **not**
proxied: the browser POSTs them straight to the chosen ClickHouse cluster,
exactly like the on-cluster deployment.

Pull the published multi-arch image (`linux/amd64` + `linux/arm64`):

```bash
docker run --rm -p 8900:8080 \
  -v "$PWD/config.json:/config/config.json:ro" \
  ghcr.io/altinity/altinity-sql-browser:latest
```

Then open `http://localhost:8900/sql`. Tags: `latest` and `X.Y.Z` (releases),
`edge` (main), `sha-<commit>`.

The container listens on **8080** (non-root nginx). Provide your OAuth/host
config as a `config.json` (see [`deploy/config.json.example`](../deploy/config.json.example)
and [LOGIN-SCREEN.md](LOGIN-SCREEN.md)) mounted at `/config/config.json`.
**With no mount** the image serves a built-in demo config for the public
Altinity clusters (antalya + github.demo), each offered as a `demo:demo`
credentials entry and a Google-SSO entry — so a bare
`docker run -p 8900:8080 ghcr.io/altinity/altinity-sql-browser:latest` is
immediately usable.

Set **`CONNECT_SRC`** to the space-separated origins the browser must reach —
your IdP endpoints plus every ClickHouse cluster origin in your `config.json`;
it fills the CSP `connect-src` (same-origin `'self'` is always included):

```bash
docker run --rm -p 8900:8080 \
  -v "$PWD/config.json:/config/config.json:ro" \
  -e CONNECT_SRC="https://accounts.google.com https://oauth2.googleapis.com https://clickhouse.example.com" \
  ghcr.io/altinity/altinity-sql-browser:latest
```

Or use Compose to build locally, mount the demo config, and publish on `$PORT`:

```bash
docker compose up --build          # → http://localhost:8900/sql
PORT=9000 docker compose up --build
```

Two caveats for the baked demo config:

- **OAuth from `localhost` won't complete** — the demo clusters' Google clients
  register redirect URIs on their own hosts, not `http://localhost:8900/sql`. Use
  the `demo:demo` credentials entries locally; the SSO entries work once the app
  is served from a registered origin.
- **Cross-origin queries need CORS** on the target cluster. ClickHouse's HTTP
  interface sends `Access-Control-Allow-Origin` for requests carrying an `Origin`
  by default, so the public demos work out of the box.

## Kubernetes and Helm

A Helm chart is published to GHCR as an OCI artifact:

```bash
helm install sql-browser \
  oci://ghcr.io/altinity/altinity-sql-browser/helm/altinity-sql-browser \
  -n <namespace> -f values.yaml
```

Key values: `image.tag`, `connectSrc` (→ CSP `connect-src`), `config` (the
`config.json` served at `/sql/config.json`, rendered into a ConfigMap), and
`service.annotations`. The container serves plain HTTP on **8080** and runs
non-root (uid 101).

**Exposing a hostname.** For a standard cluster, enable `ingress` in values. In
an **Altinity edge-proxy** environment (e.g. `*.demo.altinity.cloud`) you instead
put edge-proxy annotations on the ClusterIP Service — TLS terminates at the edge
(wildcard cert) and wildcard DNS already resolves, so no ingress/cert/DNS is
needed:

```yaml
service:
  type: ClusterIP
  port: 8080
  annotations:
    edge-proxy.altinity.com/port-mapping: "443:tls-to-tcp:8080"
    edge-proxy.altinity.com/tls-server-name: sql.example.demo.altinity.cloud
```

The chart source is in [`helm/altinity-sql-browser/`](../helm/altinity-sql-browser/);
a ready-made demo overlay is [`deploy/helm/values-demo.yaml`](../deploy/helm/values-demo.yaml).
Plain (no-Helm) manifests are in [`deploy/k8s/`](../deploy/k8s/).

## Testing

```bash
npm test          # run once with coverage
npm run test:watch
```

Coverage is enforced **per file** (no global aggregate can hide a weak module).
Pure, network, state, and DOM/render modules are held at
**100/100/100/100** (statements / branches / functions / lines); the browser
controller and bootstrap have lower gates and integration coverage. The fetch,
crypto, and storage seams are injected, so the suite needs no mocking libraries.

### End-to-end (real browser)

happy-dom has no real layout or scrollbars, so render-layer bugs (keyboard
routing through the real engine, completion popup timing, drop-point geometry)
can't be caught by the unit suite. A small Playwright harness mounts the real
`src/` modules in **Chromium, Firefox and WebKit** for those cases — WebKit is
the Safari proxy.

```bash
npx playwright install chromium firefox webkit   # once per machine
npm run test:e2e
```

The harness (`tests/e2e/`) serves the repo over HTTP and imports the actual
source as native ESM — no bundling, always current. It is **not** part of
`npm test` or the coverage gate.

## Releasing

Releases are cut by pushing a version tag — `.github/workflows/release.yml` then
runs the coverage gate, assembles the bundle, and publishes a GitHub Release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The release attaches `altinity-sql-browser.tar.gz` (+ `.sha256`) and the raw
`sql.html`. The bundle is built by `build/bundle.sh` (also runnable locally), and
every PR smoke-tests it in CI (`bundle` job: extract → boot the runner → fetch
`/sql` + `/config.json`). The `curl | sh` `install.sh` resolves the latest tag and
installs that artifact.

`package-lock.json` is committed and every CI/release job uses `npm ci`, so a tag
build resolves the same complete dependency graph—including transitives—as a
local checkout of that commit. npm records platform-specific esbuild binaries as
optional packages and installs only the current platform's binary; the lockfile
therefore remains portable between Linux CI and macOS development.
