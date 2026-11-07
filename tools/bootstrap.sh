#!/usr/bin/env bash
# Install the repository's pinned user-local toolchains. Node.js itself must already be installed.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOCAL_BIN="${HOME}/.local/bin"
LOCAL_PREFIX="${HOME}/.local"
RUST_BIN="${HOME}/.cargo/bin"
COREPACK_VERSION="0.36.0"
PNPM_VERSION="10.34.6"
UV_VERSION="0.12.23"

mkdir -p "$LOCAL_BIN"
export PATH="$LOCAL_BIN:$RUST_BIN:$PATH"
RUST_VERSION=$(sed -nE 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$ROOT/rust-toolchain.toml")
if [[ -z "$RUST_VERSION" || "$RUST_VERSION" == *$'\n'* ]]; then
  echo "rust-toolchain.toml must define exactly one channel." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required; install the version in .nvmrc and rerun this script." >&2
  exit 1
fi
EXPECTED_NODE=$(sed 's/^v//; s/[[:space:]]//g' "$ROOT/.nvmrc")
ACTUAL_NODE=$(node --version | sed 's/^v//')
if [[ "$ACTUAL_NODE" != "$EXPECTED_NODE" ]]; then
  echo "Expected Node.js $EXPECTED_NODE from .nvmrc, found $ACTUAL_NODE." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to install the pinned Corepack version." >&2
  exit 1
fi
if ! command -v corepack >/dev/null 2>&1 || [[ "$(corepack --version)" != "$COREPACK_VERSION" ]]; then
  npm install --prefix "$LOCAL_PREFIX" "corepack@$COREPACK_VERSION"
  export PATH="$LOCAL_BIN:$PATH"
fi
corepack enable --install-directory "$LOCAL_BIN"
corepack install --global "pnpm@$PNPM_VERSION"
if [[ "$(pnpm --version)" != "$PNPM_VERSION" ]]; then
  echo "Corepack did not activate pnpm $PNPM_VERSION." >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1 || [[ "$(uv --version | awk '{print $2}')" != "$UV_VERSION" ]]; then
  curl -LsSf "https://astral.sh/uv/$UV_VERSION/install.sh" | env \
    UV_INSTALL_DIR="$LOCAL_BIN" UV_NO_MODIFY_PATH=1 sh
  export PATH="$LOCAL_BIN:$PATH"
fi
uv python install "$(tr -d '[:space:]' < "$ROOT/.python-version")"

if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- \
    -y --no-modify-path --profile minimal --default-toolchain "$RUST_VERSION"
  export PATH="$RUST_BIN:$PATH"
else
  rustup toolchain install "$RUST_VERSION" --profile minimal
fi

printf 'Node.js %s\npnpm %s\n%s\n' \
  "$ACTUAL_NODE" "$(pnpm --version)" "$(uv --version)"
rustup run "$RUST_VERSION" rustc --version
