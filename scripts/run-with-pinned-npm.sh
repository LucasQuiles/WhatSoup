#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: scripts/run-with-pinned-npm.sh <npm-args...>" >&2
  exit 64
fi

_resolve_symlinks() {
  local p="$1"
  while [ -L "$p" ]; do
    local dir
    dir="$(cd "$(dirname "$p")" && pwd)"
    p="$(readlink "$p")"
    [[ "$p" != /* ]] && p="$dir/$p"
  done
  echo "$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"
}

SCRIPT_DIR="$(cd "$(dirname "$(_resolve_symlinks "${BASH_SOURCE[0]}")")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=deploy/lib/resolve-node.sh
. "$REPO_ROOT/deploy/lib/resolve-node.sh"

if ! NODE="$(whatsoup_resolve_node "$REPO_ROOT")"; then
  exit 1
fi

NODE_DIR="$(dirname "$NODE")"
NPM="${WHATSOUP_NPM:-$NODE_DIR/npm}"
if [ ! -x "$NPM" ]; then
  echo "FATAL: npm not found next to resolved Node: $NPM" >&2
  echo "Install the pinned Node/npm toolchain or set WHATSOUP_NPM=/path/to/npm." >&2
  exit 1
fi

export PATH="$NODE_DIR:$PATH"
exec "$NPM" "$@"
