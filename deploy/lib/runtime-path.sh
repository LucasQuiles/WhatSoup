#!/usr/bin/env bash
# Shared effective PATH contract for the WhatSoup launcher and provider health probes.

# The optional 4th argument is a host-configured prepend that outranks
# ~/.local/bin. Without it the composition is byte-identical to the legacy form.
#
# Why it exists: ~/.local/bin was prepended ahead of the ENTIRE inherited PATH,
# including the ordering a LaunchAgent plist had deliberately chosen. A host that
# pinned an older claude CLI by putting ~/.local/opt/claude-pin/bin first in its
# plist had that pin silently overridden, because ~/.local/bin is exactly where
# the CLI auto-updates itself — so the pin was inert from the day it was created
# and the auto-updating symlink moved under it unnoticed.
whatsoup_effective_runtime_path() {
  local home_dir="$1"
  local node_bin="$2"
  local inherited_path="$3"
  local path_prepend="${4:-}"
  local node_dir

  [ -n "$home_dir" ] || return 1
  [[ "$node_bin" == /*/* ]] || return 1
  [ -n "$inherited_path" ] || return 1

  # Arg 3 is whatever PATH the process inherited, so an empty segment here is a
  # host fact this function does not control. COLLAPSE rather than reject: the
  # launcher runs under `set -euo pipefail` and calls the wrapper bare, so
  # rejecting would fail bot start on every host whose ambient PATH already
  # contains "::". An empty PATH entry means the CURRENT DIRECTORY, so the
  # hazard still has to go. One substitution pass is not enough -- ":::" would
  # collapse to "::" -- so iterate to a fixed point, then strip one leading and
  # one trailing colon, then re-assert non-empty so an all-empty value like
  # "::" still fails closed rather than composing a PATH with nothing in it.
  while [[ "$inherited_path" == *::* ]]; do
    inherited_path="${inherited_path//::/:}"
  done
  inherited_path="${inherited_path#:}"
  inherited_path="${inherited_path%:}"
  [ -n "$inherited_path" ] || return 1

  node_dir="${node_bin%/*}"
  # An unset prepend must contribute NO segment. Composing "$path_prepend:$rest"
  # unconditionally would emit a leading empty entry when it is unset, and an
  # empty PATH entry means the CURRENT DIRECTORY — putting CWD ahead of every
  # system binary on every host, which is a worse defect than the one this fixes.
  if [ -n "$path_prepend" ]; then
    # Arg 4 is config-owned and already validated upstream, so an empty segment
    # can only come from a hand-set WHATSOUP_PATH_PREPEND. Reject it: refusing
    # to start beats putting the current directory ahead of every system binary
    # on a service PATH. Wrapping in colons catches leading, trailing and
    # embedded empties in one test. FATAL line first, per whatsoup_resolve_node.
    case ":$path_prepend:" in
      *::*)
        echo "FATAL: WHATSOUP_PATH_PREPEND contains an empty PATH segment (an empty entry means the current directory): $path_prepend" >&2
        return 1
        ;;
    esac
    printf '%s\n' "$path_prepend:$home_dir/.local/bin:$node_dir:$inherited_path"
    return 0
  fi
  printf '%s\n' "$home_dir/.local/bin:$node_dir:$inherited_path"
}

whatsoup_export_runtime_path() {
  PATH="$(whatsoup_effective_runtime_path "$1" "$2" "$PATH" "${WHATSOUP_PATH_PREPEND:-}")" || return 1
  export PATH
}
