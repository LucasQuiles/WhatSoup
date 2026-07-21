#!/usr/bin/env bash
set -euo pipefail

# Hook-environment safety: when invoked from inside a git hook (pre-push,
# post-merge, ...) the parent git process exports GIT_DIR/GIT_WORK_TREE/
# GIT_INDEX_FILE, which would silently redirect this script's `git -C` calls
# at the target tree to the HOOK's repository instead. Drop them.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

# WhatSoup — restart-safety pre-flight gate.
#
# Verifies that the on-disk tree is SAFE TO START before the wrapper exec's the
# bootstrap. Blocks the "restart landmine" incident class: a dirty/partial tree
# whose live import graph (bootstrap.ts -> main.ts -> runtimes/agent/runtime.ts)
# references a module or export that exists NOWHERE on disk. The old, long-uptime
# process keeps running on cached code; a restart loads the broken on-disk code at
# module-link time, BEFORE any bot logic runs, and crash-loops under the service
# manager. (Incidents 2026-06-12: mini1 personal bot + nucles hub.)
#
# The decisive probe is an import of src/main.ts with the pinned interpreter:
#   - a credentials/env init failure  => every import RESOLVED + linked => SAFE
#   - "does not provide an export" / "Cannot find module" => phantom import => LANDMINE
#   - "Cannot find package"           => dependencies not installed => UNSAFE (distinct)
# It also probes the per-session agent path, because the agent session graph is
# loaded lazily at session spawn and can otherwise false-green a startup-only probe.
# This mirrors the fleet pre-flight audit that distinguished safe from landmine hosts.
#
# Usage:  preflight-check.sh <repo-root> [instance-name]
#
# Exit codes:
#   0  safe to start (import-clean, or stopped only at credential/env init)
#   3  unsafe to start: import landmine (phantom module/export) or missing deps -> BLOCK
#   1  usage / internal error (cannot run the probe)
#
# Warnings (untracked files, unpushed commits, node-pin skew) go to stderr and
# are NON-FATAL. Tracked file drift and missing dependencies are fatal because a
# restart would not load the recorded git SHA/dependency set.

REPO_ROOT="${1:?Usage: preflight-check.sh <repo-root> [instance-name]}"
INSTANCE="${2:-}"

if [ ! -d "$REPO_ROOT" ]; then
  echo "PREFLIGHT-ERROR: repo root not found: $REPO_ROOT" >&2
  exit 1
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

MAIN_TS="$REPO_ROOT/src/main.ts"
if [ ! -f "$MAIN_TS" ]; then
  echo "PREFLIGHT-ERROR: entrypoint not found: $MAIN_TS" >&2
  exit 1
fi
SESSION_TS="$REPO_ROOT/src/runtimes/agent/session.ts"
DATABASE_BOOTSTRAP_TS="$REPO_ROOT/src/database-compatibility-bootstrap.ts"
if [ -L "$DATABASE_BOOTSTRAP_TS" ]; then
  echo "PREFLIGHT-ERROR: unsafe entrypoint (must be a regular non-symlink file): $DATABASE_BOOTSTRAP_TS" >&2
  exit 1
fi
if [ ! -e "$DATABASE_BOOTSTRAP_TS" ]; then
  echo "PREFLIGHT-ERROR: required entrypoint not found: $DATABASE_BOOTSTRAP_TS" >&2
  exit 1
fi
if [ ! -f "$DATABASE_BOOTSTRAP_TS" ]; then
  echo "PREFLIGHT-ERROR: unsafe entrypoint (must be a regular non-symlink file): $DATABASE_BOOTSTRAP_TS" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_TS="$SCRIPT_DIR/preflight-probe.ts"
if [ ! -f "$PROBE_TS" ]; then
  echo "PREFLIGHT-ERROR: probe not found: $PROBE_TS" >&2
  exit 1
fi

# Resolve the pinned interpreter the SAME way deploy/whatsoup does (shared lib, DRY).
# shellcheck source=deploy/lib/resolve-node.sh
. "$SCRIPT_DIR/lib/resolve-node.sh"

NODE=""
if ! NODE="$(whatsoup_resolve_node "$REPO_ROOT")"; then
  echo "PREFLIGHT-ERROR: could not resolve pinned Node for $REPO_ROOT" >&2
  exit 1
fi

# node-pin advisory (non-fatal): the wrapper gate is the hard enforcer; here we
# only surface drift so the pre-flight report is complete on override paths.
if ! whatsoup_check_node_pin "$REPO_ROOT" "$NODE"; then
  echo "PREFLIGHT-WARN: resolved Node major differs from .nvmrc pin" >&2
fi

# Tree-integrity gate: tracked drift is fatal; untracked files and unpushed
# commits are advisory. A long-uptime process on a drifted tracked tree is the
# latent-landmine signature, so we block before restart.
IS_RELEASE_EXPORT=0
if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  tracked_drift_count="$(git -C "$REPO_ROOT" diff --name-only HEAD -- | grep -c . || true)"
  : "${tracked_drift_count:=0}"
  if [ "$tracked_drift_count" -gt 0 ]; then
    {
      echo "PREFLIGHT-FAIL: REFUSING TO START — tracked file drift in checkout."
      echo "  $tracked_drift_count tracked path(s) differ from HEAD."
      echo "  A restart would not be a clean launch of the recorded git SHA."
      echo "  Fix: restore/commit the tracked edits, then re-run: git diff HEAD --exit-code"
    } >&2
    exit 3
  fi

  dirty_count="$(git -C "$REPO_ROOT" status --porcelain | grep -c . || true)"
  : "${dirty_count:=0}"
  if [ "$dirty_count" -gt 0 ]; then
    echo "PREFLIGHT-WARN: working tree has $dirty_count untracked path(s)" >&2
  fi
  if git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    unpushed="$(git -C "$REPO_ROOT" rev-list '@{u}..HEAD' --count 2>/dev/null || echo 0)"
    if [ "${unpushed:-0}" -gt 0 ]; then
      echo "PREFLIGHT-WARN: $unpushed commit(s) ahead of upstream (unpushed)" >&2
    fi
  fi
else
  IS_RELEASE_EXPORT=1
  echo "PREFLIGHT-WARN: $REPO_ROOT is not a git work tree (cannot compute dirty/unpushed)" >&2
  # A non-git deploy dir is a release export, and a release export must carry
  # the manifest the fleet release-drift checker verifies. A manifest-less
  # export (2026-07-16: WhatSoup-release-ee35101f shipped to four hosts without
  # one) makes every host flag release-drift forever and leaves the deployed
  # bytes unverifiable against any recorded plan. Fail closed before restart.
  if [ ! -f "$REPO_ROOT/.whatsoup-release-manifest.json" ]; then
    {
      echo "PREFLIGHT-FAIL: REFUSING TO START — release export lacks .whatsoup-release-manifest.json."
      echo "  The manifest is written by the snapshot pipeline (scripts/release-snapshot-plan.ts)."
      echo "  Fix: re-export the release through the snapshot pipeline, or backfill the"
      echo "  manifest for this export, then re-run preflight."
    } >&2
    exit 3
  fi
fi

if [ -f "$REPO_ROOT/package-lock.json" ] && [ ! -d "$REPO_ROOT/node_modules" ]; then
  {
    echo "PREFLIGHT-FAIL: REFUSING TO START — dependencies are not installed (node_modules)."
    echo "  package-lock.json exists but $REPO_ROOT/node_modules is missing."
    echo "  Run 'npm ci' in $REPO_ROOT before starting."
  } >&2
  exit 3
fi

# Verify release runtime bytes before importing any release-owned module. The
# import probe executes module top-level code, so running this gate afterward
# would detect drift only after the untrusted bytes had already run.
if [ "$IS_RELEASE_EXPORT" -eq 1 ]; then
  SOURCE_RUNTIME_CHECK="$REPO_ROOT/scripts/source-runtime-drift-check.ts"
  SOURCE_RUNTIME_MANIFEST="$REPO_ROOT/deploy/source-runtime-manifest.json"
  if [ -L "$SOURCE_RUNTIME_CHECK" ] || [ ! -f "$SOURCE_RUNTIME_CHECK" ] \
    || [ -L "$SOURCE_RUNTIME_MANIFEST" ] || [ ! -f "$SOURCE_RUNTIME_MANIFEST" ]; then
    echo "PREFLIGHT-FAIL: REFUSING TO START — release source-runtime integrity controls are missing or unsafe." >&2
    exit 3
  fi
  set +e
  source_integrity_out="$({
    cd "$REPO_ROOT"
    "$NODE" \
      --disable-warning=ExperimentalWarning \
      --experimental-strip-types \
      "$SOURCE_RUNTIME_CHECK" \
      --manifest deploy/source-runtime-manifest.json
  } 2>&1)"
  source_integrity_rc=$?
  set -e
  if [ "$source_integrity_rc" -ne 0 ]; then
    {
      echo "PREFLIGHT-FAIL: REFUSING TO START — release source-runtime integrity check failed."
      printf '%s\n' "$source_integrity_out" | sed 's/^/    /'
    } >&2
    exit 3
  fi
  echo "PREFLIGHT-OK: release source-runtime graph matches the release manifest" >&2
fi

# Import-closure probe — the authoritative landmine check. Runs an isolated import
# of startup and lazy agent-session entrypoints under a throwaway state/config/data
# dir so the probe is side-effect-free (no touching prod DB).
PROBE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/whatsoup-preflight.XXXXXX")"
# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap below
cleanup() { rm -rf "$PROBE_TMP" || true; }
trap cleanup EXIT

PROBE_TARGETS=("$MAIN_TS")
if [ -f "$SESSION_TS" ]; then
  PROBE_TARGETS+=("$SESSION_TS")
fi
PROBE_TARGETS+=("$DATABASE_BOOTSTRAP_TS")

set +e
probe_out="$(
  WHATSOUP_CONFIG_DIR="$PROBE_TMP/config" \
  WHATSOUP_DATA_DIR="$PROBE_TMP/data" \
  WHATSOUP_STATE_DIR="$PROBE_TMP/state" \
  WHATSOUP_PREFLIGHT_IMPORT_ONLY=1 \
  WHATSOUP_PREFLIGHT_IMPORT_SENTINEL=restart-safety-link-probe-v1 \
  "$NODE" \
    --disable-warning=ExperimentalWarning \
    --experimental-strip-types \
    "$PROBE_TS" "${PROBE_TARGETS[@]}" 2>&1
)"
probe_rc=$?
set -e

probe_line="$(printf '%s\n' "$probe_out" | grep -m1 '^PREFLIGHT-PROBE:' || true)"
[ -n "$probe_line" ] && echo "$probe_line" >&2

if [ "$probe_rc" -eq 0 ]; then
  # The import probe proves the on-disk tree LINKS. It runs against empty temp
  # config/data/state roots, so it does NOT prove the named instance's real
  # configuration is loadable or semantically valid. Report the two checks
  # distinctly so an operator can tell an import-clean tree from a valid instance.
  echo "PREFLIGHT-OK: import graph is link-clean" >&2

  if [ -n "$INSTANCE" ]; then
    # #1862: validate the exact named instance's real configuration through a
    # side-effect-free path and fail closed BEFORE the service is stopped/replaced.
    # A missing instance or a config runtime startup would reject (e.g. an agent
    # cwd that resolves to the user home directory) must block the restart here,
    # not surface only after the service mutation begins.
    INSTANCE_CHECK_TS="$SCRIPT_DIR/preflight-instance-check.ts"
    if [ ! -f "$INSTANCE_CHECK_TS" ]; then
      echo "PREFLIGHT-ERROR: instance-config probe not found: $INSTANCE_CHECK_TS" >&2
      exit 1
    fi
    set +e
    instance_out="$(
      "$NODE" \
        --disable-warning=ExperimentalWarning \
        --experimental-strip-types \
        "$INSTANCE_CHECK_TS" "$INSTANCE" 2>&1
    )"
    instance_rc=$?
    set -e

    instance_line="$(printf '%s\n' "$instance_out" | grep -m1 '^PREFLIGHT-INSTANCE:' || true)"
    [ -n "$instance_line" ] && echo "$instance_line" >&2

    if [ "$instance_rc" -ne 0 ]; then
      {
        echo "PREFLIGHT-FAIL: REFUSING TO START — instance configuration is invalid or missing."
        echo "  The on-disk tree links, but instance '$INSTANCE' did not pass configuration validation."
        # Surface any NON-marker probe output (stack traces etc.) indented. grep -v
        # returns 1 when every line is a marker line (nothing to show); `|| true`
        # keeps that from tripping `set -e`/pipefail and masking `exit 3` below.
        printf '%s\n' "$instance_out" | { grep -v '^PREFLIGHT-INSTANCE:' || true; } | sed 's/^/    /'
        echo "  A restart would first discover this after stopping the service. Fix the instance"
        echo "  configuration, then re-run preflight."
      } >&2
      exit 3
    fi
    echo "PREFLIGHT-OK: instance '$INSTANCE' configuration is valid — safe to start" >&2
  fi
  exit 0
fi

if [ "$probe_rc" -eq 3 ]; then
  broken="$(printf '%s\n' "$probe_out" | grep -oE "does not provide an export named '[^']*'" | head -n1 || true)"
  missing_mod="$(printf '%s\n' "$probe_out" | grep -oE "Cannot find module '[^']*'" | head -n1 || true)"
  {
    echo "PREFLIGHT-FAIL: REFUSING TO START — import landmine on the live startup path."
    [ -n "$broken" ]      && echo "  Tree references a missing export: $broken"
    [ -n "$missing_mod" ] && echo "  Tree references a missing module: $missing_mod"
    echo "  The on-disk code (bootstrap.ts -> main.ts -> runtimes/agent/runtime.ts) does not link."
    echo "  A restart would crash-loop at module load, BEFORE any bot logic runs."
    echo "  If an old process is still running, it is the last-known-good — DO NOT kill it until this is fixed."
    echo "  Fix: add the missing symbol/module, or drop the dangling re-export, then re-run preflight."
  } >&2
  exit 3
fi

if [ "$probe_rc" -eq 4 ]; then
  {
    echo "PREFLIGHT-FAIL: REFUSING TO START — dependencies are not installed (node_modules)."
    echo "  Run 'npm ci' in $REPO_ROOT before starting."
  } >&2
  exit 3
fi

{
  echo "PREFLIGHT-FAIL: REFUSING TO START — import probe failed in an unexpected way (rc=$probe_rc)."
  echo "  Probe output:"
  printf '%s\n' "$probe_out" | sed 's/^/    /'
} >&2
exit 3
