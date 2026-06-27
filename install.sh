#!/bin/sh
# Altinity SQL Browser — LOCAL RUNNER installer (curl | sh).
#
# Downloads the latest release bundle (prebuilt single-file SPA + the zero-dep
# Python runner) and installs a launcher. Needs only python3 (preinstalled on
# macOS/Linux) plus curl or wget.
#
#   curl -fsSL https://raw.githubusercontent.com/Altinity/altinity-sql-browser/main/install.sh | sh
#
# This installs the LOCAL runner (point the browser at your own clusters from
# ~/.clickhouse-client/config.xml). To deploy the app ONTO a ClickHouse cluster
# instead, use deploy/install.sh in the repo.
#
# Env overrides:
#   ASB_VERSION   release tag to install   (default: latest)
#   ASB_HOME      install dir              (default: ~/.altinity-sql-browser)
#   ASB_BIN       launcher dir            (default: ~/.local/bin)
set -eu

REPO="Altinity/altinity-sql-browser"
ASSET="altinity-sql-browser.tar.gz"
ASB_HOME="${ASB_HOME:-$HOME/.altinity-sql-browser}"
ASB_BIN="${ASB_BIN:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- prerequisites ---
command -v python3 >/dev/null 2>&1 || err "python3 not found — install Python 3 and re-run."
if command -v curl >/dev/null 2>&1; then
  dl()  { curl -fsSL "$1"; }            # to stdout
  dlo() { curl -fsSL -o "$1" "$2"; }    # to file
elif command -v wget >/dev/null 2>&1; then
  dl()  { wget -qO- "$1"; }
  dlo() { wget -qO "$1" "$2"; }
else
  err "need curl or wget."
fi

# --- resolve version ---
TAG="${ASB_VERSION:-}"
if [ -z "$TAG" ]; then
  say "==> Resolving latest release…"
  TAG=$(dl "https://api.github.com/repos/$REPO/releases/latest" \
        | grep -m1 '"tag_name"' \
        | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/') || true
  [ -n "$TAG" ] || err "could not resolve the latest release (set ASB_VERSION=vX.Y.Z)."
fi
say "==> Installing $REPO @ $TAG"

BASE="https://github.com/$REPO/releases/download/$TAG"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "==> Downloading $ASSET"
dlo "$TMP/$ASSET" "$BASE/$ASSET" || err "download failed: $BASE/$ASSET"

# --- verify checksum when published ---
if dlo "$TMP/$ASSET.sha256" "$BASE/$ASSET.sha256" 2>/dev/null; then
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$TMP" && sha256sum -c "$ASSET.sha256" >/dev/null ) || err "checksum mismatch."
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$TMP" && shasum -a 256 -c "$ASSET.sha256" >/dev/null ) || err "checksum mismatch."
  else
    say "    (no sha256 tool; skipping verification)"
  fi
  say "    checksum OK"
else
  say "    (no checksum published; skipping verification)"
fi

# --- install ---
say "==> Installing to $ASB_HOME"
rm -rf "$ASB_HOME"
mkdir -p "$ASB_HOME"
tar -xzf "$TMP/$ASSET" -C "$ASB_HOME" --strip-components=1

mkdir -p "$ASB_BIN"
LAUNCH="$ASB_BIN/altinity-sql-browser"
cat > "$LAUNCH" <<EOF
#!/bin/sh
exec python3 "$ASB_HOME/local.py" "\$@"
EOF
chmod +x "$LAUNCH"

# Install the sample connections beside the user's clickhouse-client config —
# under a separate name so it NEVER replaces their real config.xml. The runner
# merges both. Back up any previous sql-browser.xml first.
CHC="$HOME/.clickhouse-client"
mkdir -p "$CHC"
if [ -e "$CHC/sql-browser.xml" ]; then cp "$CHC/sql-browser.xml" "$CHC/sql-browser.xml.bak"; fi
cp "$ASB_HOME/sql-browser.xml" "$CHC/sql-browser.xml"

say ""
say "Installed $(cat "$ASB_HOME/VERSION" 2>/dev/null || echo "$TAG"). Launcher: $LAUNCH"
case ":$PATH:" in
  *":$ASB_BIN:"*) ;;
  *) say ""; say "NOTE: $ASB_BIN is not on your PATH. Add it:"; say "    export PATH=\"$ASB_BIN:\$PATH\"" ;;
esac
say ""
say "Sample connections written to $CHC/sql-browser.xml (your config.xml is untouched)."
say "The runner merges both files."
say ""
say "Run it:"
say "    altinity-sql-browser            # → http://localhost:8900/sql"
