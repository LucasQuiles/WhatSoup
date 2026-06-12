#!/usr/bin/env bash
# WhatSoup — shared Node-pin resolution + compatibility gate.
#
# Single source of truth for resolving the pinned interpreter and validating it
# against .nvmrc / package.json#engines.node. Sourced by both the launch wrapper
# (deploy/whatsoup) and the restart-safety pre-flight gate (deploy/preflight-check.sh)
# so the node-pin logic lives in exactly one place (DRY).
#
# Functions (all take an explicit repo root so they are worktree-safe):
#   whatsoup_resolve_node <repo-root>
#       Echoes the absolute path to the pinned, compatibility-checked Node binary.
#       Honors $WHATSOUP_NODE override. Prints a FATAL line + returns non-zero on
#       any failure (missing/invalid .nvmrc, binary not found, version out of range).
#   whatsoup_check_node_pin <repo-root> <node-bin>
#       Returns 0 if the resolved Node major == the .nvmrc major, else returns 1
#       (non-fatal advisory; caller decides whether to warn or block).

# Read the dotted .nvmrc version (validated to start with a digit).
_whatsoup_nvmrc_version() {
  local repo_root="$1"
  local version
  version="$(tr -d '[:space:]' < "$repo_root/.nvmrc" 2>/dev/null || true)"
  if [ -z "$version" ]; then
    echo "FATAL: cannot read Node version from $repo_root/.nvmrc" >&2
    return 1
  fi
  # A dotted version (e.g. 24.15.0) is required for the -lt arithmetic gate.
  # lts/iron, latest, or any non-numeric leading value would silently disable it.
  if ! printf '%s' "$version" | grep -qE '^[0-9]'; then
    echo "FATAL: .nvmrc must be a dotted version (e.g. 24.15.0), not '$version'" >&2
    return 1
  fi
  printf '%s' "$version"
}

whatsoup_resolve_node() {
  local repo_root="$1"
  local nvmrc_version node default_node
  nvmrc_version="$(_whatsoup_nvmrc_version "$repo_root")" || return 1

  default_node="$HOME/.nvm/versions/node/v${nvmrc_version}/bin/node"
  node="${WHATSOUP_NODE:-$default_node}"
  if [ ! -x "$node" ]; then
    # Do NOT fall back to system node — it likely lacks --experimental-strip-types
    # and would burn through systemd restart budget with repeated failures.
    echo "FATAL: node v${nvmrc_version} not found at $node. Set WHATSOUP_NODE or run: nvm install ${nvmrc_version}" >&2
    return 1
  fi

  # Version-compatibility gate: the entrypoint passes --experimental-strip-types,
  # which requires Node >= 22.6 (and the repo pins a specific major via .nvmrc).
  local required_major engine_max_exclusive_major node_major resolved_version
  required_major="${nvmrc_version%%.*}"
  engine_max_exclusive_major="$("$node" -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const range = pkg.engines && pkg.engines.node;
if (typeof range !== "string") process.exit(2);
const match = range.match(/<\s*(\d+)/);
if (!match) process.exit(3);
process.stdout.write(match[1]);
' "$repo_root/package.json" 2>/dev/null || true)"
  if ! printf '%s' "$engine_max_exclusive_major" | grep -qE '^[0-9]+$'; then
    echo "FATAL: cannot parse package.json#engines.node upper bound from $repo_root/package.json (expected range like >=24.0.0 <26)" >&2
    return 1
  fi
  node_major="$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if ! printf '%s' "$node_major" | grep -qE '^[0-9]+$' \
    || [ "$node_major" -lt "$required_major" ] \
    || [ "$node_major" -ge "$engine_max_exclusive_major" ]; then
    resolved_version="$("$node" --version 2>/dev/null || echo "unknown")"
    cat >&2 <<EOF
FATAL: resolved Node is incompatible with WhatSoup entrypoint
  Pinned (.nvmrc):             v${nvmrc_version} (default runtime)
  Declared compatibility:      package.json#engines.node requires major >= ${required_major} and < ${engine_max_exclusive_major}
  Resolved:                    ${node}
  Version:                     ${resolved_version}

The entrypoint requires Node >= 22.6 for native TypeScript stripping.
A resolved Node outside package.json#engines.node is unsupported by the repo's CI and dependency policy.

Install the pinned version on this host:
  . \$HOME/.nvm/nvm.sh && nvm install ${nvmrc_version}

Or override with WHATSOUP_NODE=/path/to/compatible/node.
EOF
    return 1
  fi

  printf '%s' "$node"
}

whatsoup_check_node_pin() {
  local repo_root="$1"
  local node="$2"
  local nvmrc_version required_major node_major
  nvmrc_version="$(_whatsoup_nvmrc_version "$repo_root")" || return 1
  required_major="${nvmrc_version%%.*}"
  node_major="$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$node_major" = "$required_major" ]
}
