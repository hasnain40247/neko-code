#!/usr/bin/env sh
set -e

REPO="hasnain40247/lotus"
BIN_NAME="neko"
INSTALL_DIR="/usr/local/bin"

# ── Detect OS ────────────────────────────────────────────────────────────────

OS="$(uname -s)"
case "$OS" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

# ── Detect arch ──────────────────────────────────────────────────────────────

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64 | amd64) arch="x86_64" ;;
  arm64 | aarch64) arch="aarch64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

# ── Resolve latest release tag ───────────────────────────────────────────────

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO- "$1"; }
else
  echo "curl or wget is required"
  exit 1
fi

TAG="$(fetch "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' \
  | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"

if [ -z "$TAG" ]; then
  echo "Could not resolve latest release tag"
  exit 1
fi

# ── Download ─────────────────────────────────────────────────────────────────

# Expected asset name: neko-<os>-<arch>  (e.g. neko-darwin-aarch64)
ASSET="${BIN_NAME}-${os}-${arch}"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "Downloading neko ${TAG} (${os}/${arch})..."
fetch "$URL" > "$TMP"
chmod +x "$TMP"

# ── Install ──────────────────────────────────────────────────────────────────

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP" "${INSTALL_DIR}/${BIN_NAME}"
else
  echo "Installing to ${INSTALL_DIR} (may prompt for password)"
  sudo mv "$TMP" "${INSTALL_DIR}/${BIN_NAME}"
fi

echo "Installed: $(${INSTALL_DIR}/${BIN_NAME} --version 2>/dev/null || echo "${INSTALL_DIR}/${BIN_NAME}")"
echo "Run 'neko' to get started."
