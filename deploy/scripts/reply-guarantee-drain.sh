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
DRAIN_READY=1
DRAIN_STATUS=0
if NVMRC_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc" 2>/dev/null)" && [ -n "$NVMRC_VERSION" ]; then
  DEFAULT_NODE="$HOME/.nvm/versions/node/v${NVMRC_VERSION}/bin/node"
  NODE="${WHATSOUP_NODE:-$DEFAULT_NODE}"
else
  echo "FATAL: cannot read Node version from $REPO_ROOT/.nvmrc" >&2
  NVMRC_VERSION="unknown"
  NODE="${WHATSOUP_NODE:-}"
  DRAIN_READY=0
  DRAIN_STATUS=2
fi

if [ ! -x "$NODE" ]; then
  echo "FATAL: node v${NVMRC_VERSION} not found at $NODE. Set WHATSOUP_NODE or run: nvm install ${NVMRC_VERSION}" >&2
  DRAIN_READY=0
  DRAIN_STATUS=2
fi

if [ "$DRAIN_READY" -eq 1 ]; then
  NODE_DIR="$(dirname "$NODE")"
  export PATH="$HOME/.local/bin:$NODE_DIR:$PATH"
fi

OBSERVER_READY=1
OBSERVER_STATUS=0
if [ -n "${WHATSOUP_PYTHON:-}" ]; then
  PYTHON="$WHATSOUP_PYTHON"
elif ! PYTHON="$(command -v python3)"; then
  echo "FATAL: python3 not found. Set WHATSOUP_PYTHON to an executable Python path." >&2
  PYTHON=""
  OBSERVER_READY=0
  OBSERVER_STATUS=2
fi
if [ ! -x "$PYTHON" ]; then
  echo "FATAL: Python executable not found at $PYTHON. Set WHATSOUP_PYTHON." >&2
  OBSERVER_READY=0
  OBSERVER_STATUS=2
fi

if [ "$DRAIN_READY" -eq 1 ]; then
  if "$NODE" "$REPO_ROOT/deploy/hooks/drain-stuck-replies.mjs" --once "$@"; then
    DRAIN_STATUS=0
  else
    DRAIN_STATUS=$?
  fi
fi

OBSERVER_ARGS=(
  "$REPO_ROOT/deploy/scripts/reply-guarantee-observer.py"
  --repo-root "$REPO_ROOT"
  --emit
  --json
)
if [ -n "${WHATSOUP_REPLY_GUARANTEE_DATA_ROOT:-}" ]; then
  OBSERVER_ARGS+=(--data-root "$WHATSOUP_REPLY_GUARANTEE_DATA_ROOT")
fi
if [ "$OBSERVER_READY" -eq 1 ]; then
  if "$PYTHON" "${OBSERVER_ARGS[@]}"; then
    OBSERVER_STATUS=0
  else
    OBSERVER_STATUS=$?
  fi
fi

if [ "$DRAIN_STATUS" -eq 2 ] || [ "$OBSERVER_STATUS" -eq 2 ]; then
  exit 2
fi
if [ "$DRAIN_STATUS" -ne 0 ] || [ "$OBSERVER_STATUS" -ne 0 ]; then
  exit 1
fi
exit 0
