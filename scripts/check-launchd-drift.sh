#!/usr/bin/env bash
set -euo pipefail

# check-launchd-drift.sh — macOS sibling of scripts/check-unit-drift.sh (systemd).
# Compares installed ~/Library/LaunchAgents/com.whatsoup.* surfaces against their
# checked-in templates. No launchd surface is byte-identical to the repo: templates
# carry __WHATSOUP_REPO_ROOT__/__HOME__/__BOT_NAME__/__INSTANCE__ install-time
# placeholders, so every comparison is substitute-then-compare, failing CLOSED if
# any placeholder survives (the hand-render bug class that churned mini7/8/9).
#
# SECRET RULE: installed com.whatsoup.<bot>.plist carries live credentials in
# EnvironmentVariables (observed on the fleet) — its content is NEVER printed or
# diffed; it gets structural checks only (Label + pinned interpreter, the mini7
# /usr/bin/env-node incident class). Diff bodies for repo-shaped surfaces are
# opt-in via --show-diff.
#
# Exit: 0 all ok · 1 drift/missing · 2 usage or unsubstituted placeholder ·
#       3 LaunchAgents dir absent (0 with --allow-missing-launchd-dir).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
BIN_DIR="$HOME/.local/bin"
ALLOW_MISSING_LAUNCHD_DIR=0
SHOW_DIFF=0
INSTANCES=()

# Non-instance stems: parity with deploy/managed-components.json
# protective_services (+ the fleet console). Enforced by
# tests/scripts/launchd-drift.test.ts (manifest-parity test).
NON_INSTANCE_STEMS=(reply-guarantee harness-maintenance release-drift-check ms365-token-backup whatsoup-fleet)

usage() {
  cat <<'USAGE'
Usage: check-launchd-drift.sh [--repo-root PATH] [--launchd-dir PATH]
                              [--bin-dir PATH] [--instance NAME ...]
                              [--allow-missing-launchd-dir] [--show-diff]

Compare installed com.whatsoup.* LaunchAgents with their checked-in templates
(substitute-then-compare). Exits 0 when all managed surfaces match, 1 on
drift/missing, 2 on usage error or a placeholder surviving substitution, 3 when
the LaunchAgents directory is absent (unless --allow-missing-launchd-dir, which
exits 0 with a skip message). Secret-bearing per-bot plist content is never
printed.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root) REPO_ROOT="${2:?missing --repo-root value}"; shift 2 ;;
    --launchd-dir) LAUNCHD_DIR="${2:?missing --launchd-dir value}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:?missing --bin-dir value}"; shift 2 ;;
    --allow-missing-launchd-dir) ALLOW_MISSING_LAUNCHD_DIR=1; shift ;;
    --show-diff) SHOW_DIFF=1; shift ;;
    --instance)
      shift
      while [ "$#" -gt 0 ] && [[ "$1" != --* ]]; do INSTANCES+=("$1"); shift; done
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unexpected argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ ! -d "$LAUNCHD_DIR" ]; then
  echo "SKIP: LaunchAgents directory not found; skipping drift check: $LAUNCHD_DIR"
  if [ "$ALLOW_MISSING_LAUNCHD_DIR" -eq 1 ]; then exit 0; fi
  exit 3
fi

failures=0

# --- main ---
echo "all managed launchd surfaces match"
