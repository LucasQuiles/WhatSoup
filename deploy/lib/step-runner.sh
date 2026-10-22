#!/usr/bin/env bash
# Step runner for maintenance jobs: one failing step never suppresses the
# steps after it or the job's final state.
#
# whatsoup_run_step <results file> <name> <command> [args...]
#
# Runs the command in a subshell and appends "<name><TAB><rc>" to the results
# file. The rc is the subshell's own exit status, observed by the parent, so a
# step reports its outcome through that status (and any files it writes), not
# through shell variables: nothing a step assigns survives it.
#
# Shell semantics this relies on, pinned under /bin/bash 3.2 by
# tests/deploy/harness-maintenance-step-runner.test.ts:
#   - `set +e; ( step )` leaves errexit off inside the subshell, so a failing
#     command would not stop the step. errexit is therefore set again INSIDE
#     the subshell.
#   - errexit is ignored for everything run inside a command whose status is
#     tested (if, while, !, &&, ||). Call this function as a plain statement,
#     never as `whatsoup_run_step ... || handler`, or the step loses errexit.
#   - errexit does not reach inside a command substitution: a failure in
#     $(f) counts only through the substitution's final status. Step code must
#     check such work explicitly.
#   - The subshell does not inherit the EXIT trap. The ERR trap is cleared
#     inside the step and suspended in the parent around it, so the parent's
#     handler cannot fire for a failure this runner records; it is restored
#     afterwards, as is the caller's errexit setting.
whatsoup_run_step() {
  local results="$1" name="$2" rc=0 errexit=0 saved_err
  shift 2
  case "$-" in *e*) errexit=1 ;; esac
  saved_err="$(trap -p ERR)"
  trap - ERR
  set +e
  (
    set -e
    trap - ERR
    "$@"
  )
  rc=$?
  if [ "$errexit" -eq 1 ]; then
    set -e
  fi
  if [ -n "$saved_err" ]; then
    eval "$saved_err"
  fi
  printf '%s\t%s\n' "$name" "$rc" >> "$results"
}

# whatsoup_step_rc <results file> <name>: the last recorded rc for a step, or
# nothing when the step never ran.
whatsoup_step_rc() {
  local step rc last=""
  while IFS=$'\t' read -r step rc; do
    if [ "$step" = "$2" ]; then
      last="$rc"
    fi
  done < "$1"
  printf '%s' "$last"
}
