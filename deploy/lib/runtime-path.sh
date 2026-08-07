#!/usr/bin/env bash
# Shared effective PATH contract for the WhatSoup launcher and provider health probes.

whatsoup_effective_runtime_path() {
  local home_dir="$1"
  local node_bin="$2"
  local inherited_path="$3"

  [ -n "$home_dir" ] || return 1
  [ -n "$node_bin" ] || return 1
  [ -n "$inherited_path" ] || return 1
  printf '%s\n' "$home_dir/.local/bin:$(dirname "$node_bin"):$inherited_path"
}

whatsoup_export_runtime_path() {
  PATH="$(whatsoup_effective_runtime_path "$1" "$2" "$PATH")" || return 1
  export PATH
}
