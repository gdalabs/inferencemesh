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
# Where the release assets live. Overridable for a mirror, an air-gapped copy,
# or to test this script against a local directory of files.
BASE_URL="${INFERENCEMESH_RELEASE_BASE:-https://github.com/$REPO/releases/latest/download}"

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

tmp=""; sums=""
# The `return 0` is load-bearing. An EXIT trap whose last command fails sets the
# script's exit status, and `[ -n "$sums" ]` is false whenever the checksum step
# was skipped — so the install succeeded and reported failure, which in a
# `curl … | sh` inside CI is a red build for a working install.
cleanup() {
  [ -n "$tmp" ] && rm -f "$tmp"
  [ -n "$sums" ] && rm -f "$sums"
  return 0
}
trap cleanup EXIT INT TERM

echo "downloading ${target}…"
mkdir -p "$BIN_DIR"
tmp="$(mktemp)"
curl -fsSL "$BASE_URL/${target}" -o "$tmp"

# Verify against the published checksums, and refuse to install without them.
#
# This used to skip the check whenever SHA256SUMS could not be fetched or held
# no line for this target — which is precisely the situation an attacker who
# can serve you a binary is also able to arrange. A verification that anyone
# able to fail it can also turn off is not a verification.
if [ "${INFERENCEMESH_SKIP_CHECKSUM:-0}" = "1" ]; then
  echo "warning: checksum verification disabled by INFERENCEMESH_SKIP_CHECKSUM" >&2
else
  sums="$(mktemp)"
  curl -fsSL "$BASE_URL/SHA256SUMS" -o "$sums" || {
    echo "could not download SHA256SUMS — refusing to install an unverified binary." >&2
    echo "  (set INFERENCEMESH_SKIP_CHECKSUM=1 if you accept that risk)" >&2
    exit 1
  }
  want=$(grep " ${target}\$" "$sums" | awk '{print $1}')
  [ -n "$want" ] || {
    echo "SHA256SUMS has no entry for ${target} — refusing to install." >&2
    exit 1
  }
  if command -v sha256sum >/dev/null; then got=$(sha256sum "$tmp" | awk '{print $1}')
  elif command -v shasum >/dev/null; then got=$(shasum -a 256 "$tmp" | awk '{print $1}')
  else
    echo "no sha256sum or shasum on this system — cannot verify the download." >&2
    exit 1
  fi
  [ "$want" = "$got" ] || { echo "checksum mismatch — refusing to install" >&2; exit 1; }
  echo "checksum ok"
fi

# 755, not `chmod +x`: mktemp creates 0600 and `+x` only adds the execute bits,
# leaving a binary nobody but the owner can read — including the user's own
# service account, if they run this under one.
chmod 755 "$tmp"
mv "$tmp" "$BIN_DIR/inferencemesh"
tmp=""

echo "installed: $BIN_DIR/inferencemesh"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not in your PATH" ;;
esac
echo
echo "next:  inferencemesh serve"
echo "       then open the setup link it prints, and add free API keys."
