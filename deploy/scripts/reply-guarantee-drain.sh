#!/usr/bin/env bash
set -euo pipefail

# The observer runs from an immutable release tree; Python writing
# __pycache__/.pyc there pollutes the release and later trips the
# release-drift check. Never emit bytecode from any python lane here.
export PYTHONDONTWRITEBYTECODE=1

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

# Resolve the observer's Python interpreter through the repository's canonical
# capability contract (deploy/lib/host-capabilities.sh) rather than an implicit
# `command -v python3`, which under a minimal launchd PATH can select Apple's
# Python 3.9 — below the declared >= 3.12 baseline. The resolver prefers the
# managed quality-venv, then python3.12/3.13/3.14/python3, and whatsoup_probe_python
# gates the version. An absent or below-baseline interpreter is an execution-context
# problem, not a reply-drain workload breach, so classify it as inconclusive
# (status 2) and skip the observer instead of letting it crash and be reported as a
# bot failure (status 1). The observer itself uses the 3.9-safe timezone.utc idiom,
# so this gate enforces the declared support-job policy, not an accidental import.
WHATSOUP_CAPABILITY_ROOT="$REPO_ROOT"
export WHATSOUP_CAPABILITY_ROOT
# shellcheck source=deploy/lib/host-capabilities.sh
. "$REPO_ROOT/deploy/lib/host-capabilities.sh"

CAP_STATUS=available
CAP_VERSION=""
CAP_PATH=""
CAP_DETAIL=""
CAP_VISIBILITY=""
if [ -n "${WHATSOUP_PYTHON:-}" ]; then
  # Explicit pin is still gated against the declared >= 3.12 contract.
  CAP_PATH="$WHATSOUP_PYTHON"
  CAP_VISIBILITY=pinned
  if [ -x "$CAP_PATH" ]; then
    whatsoup_probe_python
  else
    CAP_STATUS=missing
    CAP_DETAIL=executable-not-found
  fi
elif whatsoup_resolve_python312; then
  whatsoup_probe_python
else
  CAP_STATUS=missing
  CAP_DETAIL=executable-not-found
fi

PYTHON=""
if [ "$CAP_STATUS" = "available" ]; then
  PYTHON="$CAP_PATH"
else
  echo "INCONCLUSIVE: reply-guarantee observer interpreter does not satisfy the declared Python >= 3.12 capability contract (status=${CAP_STATUS} detail=${CAP_DETAIL:-none} version=${CAP_VERSION:-unknown} visibility=${CAP_VISIBILITY:-none} path=${CAP_PATH:-none}). Classifying as inconclusive rather than a reply-drain failure; provide a managed quality-venv or python3.12+ interpreter, or set WHATSOUP_PYTHON. See deploy/lib/host-capabilities.sh." >&2
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
