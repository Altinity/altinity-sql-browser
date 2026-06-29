#!/usr/bin/env bash
# Assemble the release bundle for the local runner:
#   dist/altinity-sql-browser.tar.gz   (+ .sha256)
#
# Contents (under a single top dir so `tar --strip-components=1` is clean):
#   altinity-sql-browser/
#     sql.html            — the prebuilt single-file SPA
#     local.py            — the zero-dep Python runner (serves SPA + config.json)
#     sql-browser.xml     — sample public-demo connections (merged with the
#                           user's ~/.clickhouse-client/config.xml by the runner)
#     run.sh              — self-resolving launcher (python3 local.py)
#     VERSION
#     README.txt
#
# Builds the SPA first. Used by .github/workflows/release.yml and runnable
# locally. Pass a version as $1, else it's read from package.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
OUT="$ROOT/dist"
STAGE="$OUT/bundle/altinity-sql-browser"

echo "==> Building SPA"
# Pass the resolved version through so the in-HTML build stamp matches the
# VERSION file written below (build.mjs honors $ASB_VERSION over package.json).
ASB_VERSION="$VERSION" node "$ROOT/build/build.mjs"

echo "==> Staging bundle ($VERSION)"
rm -rf "$OUT/bundle"
mkdir -p "$STAGE"
cp "$OUT/sql.html"                  "$STAGE/sql.html"
cp "$ROOT/build/local.py"           "$STAGE/local.py"
cp "$ROOT/deploy/sql-browser.xml"   "$STAGE/sql-browser.xml"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"

cat > "$STAGE/run.sh" <<'EOF'
#!/bin/sh
# Launch the Altinity SQL Browser local runner. Serves the bundled sql.html and a
# config.json generated from your ~/.clickhouse-client/config.xml.
#   PORT=8900  LOCAL_CH_CONFIG=~/.clickhouse-client/config.xml  ./run.sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$DIR/local.py" "$@"
EOF
chmod +x "$STAGE/run.sh"

cat > "$STAGE/README.txt" <<'EOF'
Altinity SQL Browser — local runner
===================================

Requires only python3 (preinstalled on macOS/Linux).

  ./run.sh                 # serve http://localhost:8900/sql

It merges connections from your ~/.clickhouse-client/config.xml and the bundled
sql-browser.xml (public demos) and offers each in the login picker — your own
config wins on a name clash. Run ./install.sh (curl|sh) to also copy
sql-browser.xml into ~/.clickhouse-client/.

Env: PORT (default 8900), LOCAL_CH_CONFIG (override with one explicit file),
SQL_BROWSER_SPA.

Source & docs: https://github.com/Altinity/altinity-sql-browser
EOF

echo "==> Archiving"
TARBALL="altinity-sql-browser.tar.gz"
tar -C "$OUT/bundle" -czf "$OUT/$TARBALL" altinity-sql-browser
( cd "$OUT" && { sha256sum "$TARBALL" 2>/dev/null || shasum -a 256 "$TARBALL"; } > "$TARBALL.sha256" )
echo "    $OUT/$TARBALL"
echo "    $OUT/$TARBALL.sha256"
