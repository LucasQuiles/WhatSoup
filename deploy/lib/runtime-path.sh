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
  node_dir="${node_bin%/*}"
  # An unset prepend must contribute NO segment. Composing "$path_prepend:$rest"
  # unconditionally would emit a leading empty entry when it is unset, and an
  # empty PATH entry means the CURRENT DIRECTORY — putting CWD ahead of every
  # system binary on every host, which is a worse defect than the one this fixes.
  if [ -n "$path_prepend" ]; then
    printf '%s\n' "$path_prepend:$home_dir/.local/bin:$node_dir:$inherited_path"
    return 0
  fi
  printf '%s\n' "$home_dir/.local/bin:$node_dir:$inherited_path"
}

whatsoup_export_runtime_path() {
  PATH="$(whatsoup_effective_runtime_path "$1" "$2" "$PATH" "${WHATSOUP_PATH_PREPEND:-}")" || return 1
  export PATH
}
