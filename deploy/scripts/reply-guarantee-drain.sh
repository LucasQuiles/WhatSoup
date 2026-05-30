#!/usr/bin/env bash
set -euo pipefail

resolve_symlinks() {
  local path="$1"
  while [ -L "$path" ]; do
    local dir
    dir="$(cd "$(dirname "$path")" && pwd)"
    path="$(readlink "$path")"
    [[ "$path" != /* ]] && path="$dir/$path"
  done
  echo "$(cd "$(dirname "$path")" && pwd)/$(basename "$path")"
}

SCRIPT_PATH="$(resolve_symlinks "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"
NVMRC_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc" 2>/dev/null || true)"
if [ -z "$NVMRC_VERSION" ]; then
  echo "FATAL: cannot read Node version from $REPO_ROOT/.nvmrc" >&2
  exit 1
fi

DEFAULT_NODE="$HOME/.nvm/versions/node/v${NVMRC_VERSION}/bin/node"
NODE="${WHATSOUP_NODE:-$DEFAULT_NODE}"
if [ ! -x "$NODE" ]; then
  echo "FATAL: node v${NVMRC_VERSION} not found at $NODE. Set WHATSOUP_NODE or run: nvm install ${NVMRC_VERSION}" >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE")"
export PATH="$HOME/.local/bin:$NODE_DIR:$PATH"

exec "$NODE" "$REPO_ROOT/deploy/hooks/drain-stuck-replies.mjs" --once "$@"
