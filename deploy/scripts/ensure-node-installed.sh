#!/usr/bin/env bash
set -euo pipefail

# ensure-node-installed.sh
#
# Idempotently installs the .nvmrc-pinned Node version via nvm before the
# WhatSoup wrapper runs.  Called by systemd as ExecStartPre= so the pinned
# Node is present on the host before the exec-time version gate in the
# wrapper (deploy/whatsoup, PR #663) ever needs to fire.
#
# Exits 0 on hosts without nvm — the wrapper's version gate remains the
# actual safety net, preserving the "hosts without nvm" portability decision
# from PR #478.

# ── POSIX-portable symlink resolution ────────────────────────────────────────
# readlink -f is GNU-only and unavailable on macOS; replicate the same helper
# used in deploy/whatsoup.
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

# ── Locate REPO_ROOT ─────────────────────────────────────────────────────────
# Allow an explicit override so tests can inject a fixture REPO_ROOT without
# needing a real symlink chain.
if [ -z "${REPO_ROOT:-}" ]; then
  # Script lives at $REPO_ROOT/deploy/scripts/ensure-node-installed.sh
  _SCRIPT="$(_resolve_symlinks "${BASH_SOURCE[0]}")"
  REPO_ROOT="$(cd "$(dirname "$_SCRIPT")/../.." && pwd)"
fi

# ── Read .nvmrc ───────────────────────────────────────────────────────────────
NVMRC_PATH="$REPO_ROOT/.nvmrc"
NVMRC_VERSION="$(tr -d '[:space:]' < "$NVMRC_PATH" 2>/dev/null || true)"

if [ -z "$NVMRC_VERSION" ]; then
  echo "FATAL: ensure-node-installed: cannot read Node version from $NVMRC_PATH" >&2
  exit 1
fi

# Validate format: .nvmrc must start with a digit (e.g. "24.15.0").
# Reject alias forms like "lts/iron" that nvm resolves but which the wrapper
# version gate doesn't accept.
if [[ "$NVMRC_VERSION" != [0-9]* ]]; then
  echo "FATAL: ensure-node-installed: .nvmrc contains non-numeric version '$NVMRC_VERSION' (expected dotted version like 24.15.0)" >&2
  exit 1
fi

# ── Locate nvm ───────────────────────────────────────────────────────────────
NVM_ROOT="${NVM_DIR:-$HOME/.nvm}"
LOCAL_NODE="$NVM_ROOT/versions/node/v$NVMRC_VERSION/bin/node"
NVM_SH="$NVM_ROOT/nvm.sh"

if [ -x "$LOCAL_NODE" ]; then
  echo "ensure-node-installed: v$NVMRC_VERSION already present at $LOCAL_NODE; skipping nvm install" >&2
  exit 0
fi

if [ ! -f "$NVM_SH" ]; then
  echo "ensure-node-installed: nvm not found at $NVM_SH; skipping pre-install (wrapper's version gate will enforce compatibility at exec)" >&2
  exit 0
fi

# ── Run nvm install ──────────────────────────────────────────────────────────
# Real nvm.sh (v0.39+) references unset variables during init ($NVM_CD_FLAGS
# and others).  Under `set -u`, sourcing aborts the script before
# `nvm install` can run.  Suspend `set -u` around both the source and the
# install (nvm internals also reference unbound vars), then restore it and
# propagate the install exit status.
#
# We capture the install exit code via `|| install_status=$?` so a non-zero
# return doesn't get short-circuited by `set -e` before we can restore
# `set -u` and re-exit deterministically.
set +u
# shellcheck source=/dev/null disable=SC1091
. "$NVM_SH"

# nvm install is a no-op when the version is already present.
# --no-progress suppresses download progress bars in systemd journals.
install_status=0
nvm install "$NVMRC_VERSION" --no-progress || install_status=$?
set -u
exit "$install_status"
