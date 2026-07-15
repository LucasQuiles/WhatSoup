#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: scripts/run-with-pinned-node.sh <script.ts> [args...]" >&2
  exit 64
fi

# Resolve a path to its physical (fully symlink-free) location. Uses `pwd -P`
# so directory-level symlinks are resolved too — not just a trailing symlinked
# file. This must mirror how Node canonicalises the main module: Node realpaths
# the entrypoint, so `import.meta.url` is always the physical file:// URL.
_resolve_symlinks() {
  local p="$1"
  while [ -L "$p" ]; do
    local dir
    dir="$(cd "$(dirname "$p")" && pwd -P)"
    p="$(readlink "$p")"
    [[ "$p" != /* ]] && p="$dir/$p"
  done
  echo "$(cd "$(dirname "$p")" && pwd -P)/$(basename "$p")"
}

SCRIPT_DIR="$(cd "$(dirname "$(_resolve_symlinks "${BASH_SOURCE[0]}")")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$1"
shift

case "$TARGET" in
  /*) ;;
  *) TARGET="$REPO_ROOT/$TARGET" ;;
esac

if [ ! -f "$TARGET" ]; then
  echo "FATAL: script not found: $TARGET" >&2
  exit 1
fi

# Pass Node the physical (realpath'd) entrypoint so process.argv[1] matches the
# realpath'd import.meta.url that Node derives for the main module. Otherwise a
# run from a symlinked/out-of-tree worktree (e.g. macOS /tmp -> /private/tmp)
# would make every `import.meta.url === pathToFileURL(process.argv[1]).href`
# main-module gate compare a physical URL against a logical path — they mismatch,
# the guard body silently never runs, and pre-push node-wrapper guards fail OPEN
# (exit 0). Resolving TARGET here fixes all such guards at a single source. (#1831)
TARGET="$(_resolve_symlinks "$TARGET")"

NVMRC_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc" 2>/dev/null || true)"
if [ -z "$NVMRC_VERSION" ]; then
  echo "FATAL: cannot read Node version from $REPO_ROOT/.nvmrc" >&2
  exit 1
fi
if ! printf '%s' "$NVMRC_VERSION" | grep -qE '^[0-9]'; then
  echo "FATAL: .nvmrc must be a dotted version (e.g. 24.15.0), not '$NVMRC_VERSION'" >&2
  exit 1
fi

DEFAULT_NODE="$HOME/.nvm/versions/node/v${NVMRC_VERSION}/bin/node"
if [ -n "${WHATSOUP_NODE:-}" ]; then
  NODE="$WHATSOUP_NODE"
  NODE_SOURCE="env"
elif [ -x "$DEFAULT_NODE" ]; then
  NODE="$DEFAULT_NODE"
  NODE_SOURCE="pinned"
else
  NODE="$(command -v node || true)"
  NODE_SOURCE="path"
fi

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "FATAL: node not found. Set WHATSOUP_NODE or install node v${NVMRC_VERSION}." >&2
  exit 1
fi

required_major="${NVMRC_VERSION%%.*}"
engine_max_exclusive_major="$("$NODE" -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const range = pkg.engines && pkg.engines.node;
if (typeof range !== "string") process.exit(2);
const match = range.match(/<\s*(\d+)/);
if (!match) process.exit(3);
process.stdout.write(match[1]);
' "$REPO_ROOT/package.json" 2>/dev/null || true)"
if ! printf '%s' "$engine_max_exclusive_major" | grep -qE '^[0-9]+$'; then
  echo "FATAL: cannot parse package.json#engines.node upper bound from $REPO_ROOT/package.json (expected range like >=24.0.0 <26)" >&2
  exit 1
fi

node_major="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if ! printf '%s' "$node_major" | grep -qE '^[0-9]+$' \
  || [ "$node_major" -lt "$required_major" ] \
  || { [ "$node_major" -ge "$engine_max_exclusive_major" ] && [ "$NODE_SOURCE" != "path" ]; }; then
  resolved_version="$("$NODE" --version 2>/dev/null || echo "unknown")"
  cat >&2 <<EOF
FATAL: resolved Node is incompatible with WhatSoup TypeScript scripts
  Pinned (.nvmrc):             v${NVMRC_VERSION} (default runtime)
  Declared compatibility:      package.json#engines.node requires major >= ${required_major} and < ${engine_max_exclusive_major}
  Resolved:                    ${NODE}
  Version:                     ${resolved_version}

The script runner requires Node >= 22.6 for native TypeScript stripping.

Install the pinned version on this host:
  . \$HOME/.nvm/nvm.sh && nvm install ${NVMRC_VERSION}

Or override with WHATSOUP_NODE=/path/to/compatible/node.
EOF
  exit 1
fi

if [ "$node_major" -ge "$engine_max_exclusive_major" ]; then
  resolved_version="$("$NODE" --version 2>/dev/null || echo "unknown")"
  echo "WARN: pinned node v${NVMRC_VERSION} not found; using PATH node ${resolved_version} outside package.json#engines.node for script $TARGET" >&2
fi

if ! "$NODE" --experimental-strip-types -e '' >/dev/null 2>&1; then
  resolved_version="$("$NODE" --version 2>/dev/null || echo "unknown")"
  echo "FATAL: resolved Node does not support --experimental-strip-types: $NODE ($resolved_version)" >&2
  exit 1
fi

export PATH="$(dirname "$NODE"):$PATH"
exec "$NODE" \
  --disable-warning=ExperimentalWarning \
  --experimental-strip-types \
  "$TARGET" "$@"
