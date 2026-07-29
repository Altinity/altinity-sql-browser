# syntax=docker/dockerfile:1
#
# Production image: build the single-file SPA with Node, serve it with Caddy.
# The browser POSTs queries cross-origin straight to the chosen ClickHouse
# cluster, so Caddy only serves the SPA (/sql) and a mounted config.json
# (/sql/config.json) — mirroring the on-ClickHouse http_handlers deployment.
# Published multi-arch to ghcr.io/altinity/altinity-sql-browser (see
# .github/workflows/docker.yml).

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY build ./build
COPY examples ./examples
COPY schemas ./schemas
COPY src ./src
COPY THIRD-PARTY-NOTICES.md ./

# In-HTML build stamp = `v<version> (<commit>)`. The build context ships no .git,
# so pass the commit in via ASB_COMMIT (build.mjs shortens it); the version comes
# from package.json unless ASB_VERSION overrides it (bundle.sh passes the release
# tag). docker.yml passes ASB_COMMIT=${{ github.sha }} and leaves ASB_VERSION
# unset so the stamp reads the package.json version, e.g. `v0.5.0 (6b360e8)`.
ARG ASB_VERSION
ARG ASB_COMMIT
ENV ASB_VERSION=${ASB_VERSION} \
    ASB_COMMIT=${ASB_COMMIT}

RUN npm ci --no-audit --no-fund && npm run build

# Caddy serves the precompressed sidecars selected from Accept-Encoding, with
# no request-time compression. It runs as uid 101 on unprivileged port 8080.
FROM caddy:2.8.4-alpine AS runtime

# The single-file SPA, static encoding sidecars, and default served config.
# Mount your own config.json at /config/config.json to override the baked demo.
COPY --from=build /app/dist/sql.html /app/sql.html
COPY --from=build /app/dist/sql.html.br /app/sql.html.br
COPY --from=build /app/dist/sql.html.zst /app/sql.html.zst
COPY --from=build /app/dist/sql.html.gz /app/sql.html.gz
COPY deploy/config.json.example /config/config.json
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile

# COPY preserves the source file mode, and a checkout under a restrictive umask
# can yield 0600 files the non-root Caddy process (uid 101) then can't read at
# serve time. Normalise to world-readable.
# (Builder-agnostic — avoids requiring BuildKit's COPY --chmod.)
USER root
RUN chmod 0644 /app/sql.html /app/sql.html.br /app/sql.html.zst /app/sql.html.gz \
      /config/config.json /etc/caddy/Caddyfile \
    && chown -R 101:0 /data
USER 101

# CSP connect-src origins: same-origin ('self') is added by the template; this
# lists the IdP endpoints plus the ClickHouse cluster origins the SPA POSTs to
# cross-origin. Override for your own IdP/clusters. Defaults cover the public
# Altinity demos in the baked config.json.
ENV CONNECT_SRC="https://accounts.google.com https://oauth2.googleapis.com https://antalya.demo.altinity.cloud https://github.demo.altinity.cloud"

EXPOSE 8080

# 127.0.0.1, not localhost: Caddy listens IPv4-only here, while `localhost`
# resolves to ::1 first inside the container (→ connection refused).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
