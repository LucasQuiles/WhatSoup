#!/usr/bin/env bash
# Shared effective PATH contract for the WhatSoup launcher and provider health probes.

# The optional 4th argument is a host-configured prepend that outranks
# ~/.local/bin. Without it the composition is byte-identical to the legacy form.
#
# ORDERING, deliberate and load-bearing: the prepend precedes BOTH ~/.local/bin
# and the pinned Node directory. A prepend directory containing a `node` binary
# therefore shadows the WHATSOUP_NODE pin for every child process that resolves
# node from PATH. The launcher itself is unaffected -- deploy/whatsoup invokes
# "$NODE" absolutely at every call site -- but the exported PATH is inherited by
# the bot and its children. Do not put a node binary in service.pathPrepend.
# test_runtime_path_prepend.sh asserts this order so a future reorder has to be
# a deliberate act rather than an accident.
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
    # EVERY segment is validated here, and the value is not trusted because it
    # is "config-owned". Only ONE of the three routes into arg 4 passes the
    # fleet-config validator:
    #   the config `service.pathPrepend` block -- validated upstream;
    #   WHATSOUP_PATH_PREPEND in the process environment, read directly by
    #     whatsoup_export_runtime_path below -- never seen by that validator;
    #   on Linux, the same variable set through the unit's optional environment
    #     files (docs/configuration.md, "Platform scope") -- likewise unseen.
    # This helper is where all three converge and is sourced by deploy/whatsoup
    # on both operating systems, so it is the one place the check holds for all
    # of them.
    #
    # What is rejected and why:
    #   empty       an empty PATH entry means the CURRENT DIRECTORY;
    #   relative    the same hazard spelled differently -- it resolves against
    #               the launcher's CWD and still lands ahead of every system
    #               binary on a service PATH;
    #   control     a newline would split the exported PATH outright, and no
    #               control character belongs in a directory name a human meant;
    #   padded      leading or trailing whitespace is a copy-paste artefact, not
    #               a path -- an INTERIOR space is legal and is kept.
    #
    # Ordered so that no message can echo a value that would corrupt the line it
    # is written on: control characters are caught before anything interpolates
    # a segment, and the control-character line names no value at all.
    # FATAL line first, per whatsoup_resolve_node.
    local remainder="$path_prepend" segment
    while : ; do
      segment="${remainder%%:*}"
      if [ -z "$segment" ]; then
        echo "FATAL: WHATSOUP_PATH_PREPEND contains an empty PATH segment (an empty entry means the current directory): $path_prepend" >&2
        return 1
      fi
      case "$segment" in
        *[[:cntrl:]]*)
          echo "FATAL: WHATSOUP_PATH_PREPEND contains a control character in one of its segments (value withheld: printing it would corrupt this line)" >&2
          return 1
          ;;
      esac
      case "$segment" in
        [[:space:]]*|*[[:space:]])
          echo "FATAL: WHATSOUP_PATH_PREPEND segment has leading or trailing whitespace: '$segment'" >&2
          return 1
          ;;
      esac
      case "$segment" in
        /*) ;;
        *)
          echo "FATAL: WHATSOUP_PATH_PREPEND segment is not an absolute path (a relative entry resolves against the launcher's working directory): $segment" >&2
          return 1
          ;;
      esac
      case "$remainder" in
        *:*) remainder="${remainder#*:}" ;;
        *) break ;;
      esac
    done
    printf '%s\n' "$path_prepend:$home_dir/.local/bin:$node_dir:$inherited_path"
    return 0
  fi
  printf '%s\n' "$home_dir/.local/bin:$node_dir:$inherited_path"
}

whatsoup_export_runtime_path() {
  # Composed into a local FIRST. Assigning the command substitution straight to
  # PATH sets PATH to the empty string before `|| return 1` runs, so a caller
  # that invokes this inside an `if` or with `||` would continue with an empty
  # PATH. deploy/whatsoup calls it bare under `set -euo pipefail` and so exits,
  # but the empty-segment rejection added here makes that failure newly
  # reachable and the footgun is not worth leaving for the next caller.
  local composed
  composed="$(whatsoup_effective_runtime_path "$1" "$2" "$PATH" "${WHATSOUP_PATH_PREPEND:-}")" || return 1
  PATH="$composed"
  export PATH
}
