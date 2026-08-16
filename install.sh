#!/bin/sh
# Install InferenceMesh.
#
#   curl -fsSL https://raw.githubusercontent.com/gdalabs/inferencemesh/main/install.sh | sh
#
# Downloads one executable for this platform. Nothing else is required — no
# Node, no Docker, no package manager.
set -eu

REPO="gdalabs/inferencemesh"
BIN_DIR="${INFERENCEMESH_BIN_DIR:-$HOME/.local/bin}"

os=$(uname -s); arch=$(uname -m)
case "$os" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) echo "unsupported OS: $os — see https://github.com/$REPO for other options" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

target="inferencemesh-${os}-${arch}"
url="https://github.com/$REPO/releases/latest/download/${target}"

echo "downloading ${target}…"
mkdir -p "$BIN_DIR"
tmp="$(mktemp)"
curl -fsSL "$url" -o "$tmp"

# Verify against the published checksums rather than trusting the download.
sums="$(mktemp)"
if curl -fsSL "https://github.com/$REPO/releases/latest/download/SHA256SUMS" -o "$sums" 2>/dev/null; then
  want=$(grep " ${target}\$" "$sums" | awk '{print $1}')
  if [ -n "$want" ]; then
    if command -v sha256sum >/dev/null; then got=$(sha256sum "$tmp" | awk '{print $1}')
    else got=$(shasum -a 256 "$tmp" | awk '{print $1}'); fi
    [ "$want" = "$got" ] || { echo "checksum mismatch — refusing to install" >&2; exit 1; }
    echo "checksum ok"
  fi
fi

chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/inferencemesh"
rm -f "$sums"

echo "installed: $BIN_DIR/inferencemesh"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not in your PATH" ;;
esac
echo
echo "next:  inferencemesh serve"
echo "       then open the setup link it prints, and add free API keys."
