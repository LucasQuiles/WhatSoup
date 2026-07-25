#!/usr/bin/env bash
set -euo pipefail

if timeout_bin="$(command -v gtimeout)"; then
  printf '%s\n' "$timeout_bin"
  exit 0
fi

if timeout_bin="$(command -v timeout)"; then
  printf '%s\n' "$timeout_bin"
  exit 0
fi

echo "Neither timeout nor gtimeout found. On macOS: brew install coreutils" >&2
exit 1
