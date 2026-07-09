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
    --repo-root)
      if [ "$#" -lt 2 ]; then echo "missing --repo-root value" >&2; usage >&2; exit 2; fi
      REPO_ROOT="$2"; shift 2 ;;
    --launchd-dir)
      if [ "$#" -lt 2 ]; then echo "missing --launchd-dir value" >&2; usage >&2; exit 2; fi
      LAUNCHD_DIR="$2"; shift 2 ;;
    --bin-dir)
      if [ "$#" -lt 2 ]; then echo "missing --bin-dir value" >&2; usage >&2; exit 2; fi
      BIN_DIR="$2"; shift 2 ;;
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

subst_render() { # TEMPLATE_ABS DEST BOT(optional)
  local template="$1" dest="$2" bot="${3:-}"
  sed -e "s|__WHATSOUP_REPO_ROOT__|$REPO_ROOT|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__BOT_NAME__|$bot|g" \
      -e "s|__INSTANCE__|$bot|g" \
      "$template" > "$dest"
  if grep -qE '__[A-Z][A-Z_]*__' "$dest"; then
    echo "unsubstituted placeholder survived render of: $template" >&2
    return 2
  fi
  return 0
}

check_template_surface() { # NAME TEMPLATE_REL INSTALLED_ABS BOT(optional)
  local name="$1" rel="$2" installed="$3" bot="${4:-}"
  local repo_template="$REPO_ROOT/$rel"
  if [ ! -f "$repo_template" ]; then
    echo "missing repo template: $rel" >&2
    failures=$((failures + 1)); return 0
  fi
  if [ ! -f "$installed" ]; then
    echo "missing installed: $name" >&2
    failures=$((failures + 1)); return 0
  fi
  local rendered
  rendered="$(mktemp "${TMPDIR:-/tmp}/launchd-drift.XXXXXX")"
  if ! subst_render "$repo_template" "$rendered" "$bot"; then
    rm -f "$rendered"
    exit 2
  fi
  if cmp -s "$rendered" "$installed"; then
    echo "ok: $name"
  else
    echo "drift: $name" >&2
    if [ "$SHOW_DIFF" -eq 1 ]; then
      diff -u "$rendered" "$installed" | sed -n '1,80p' >&2 || true
    fi
    failures=$((failures + 1))
  fi
  rm -f "$rendered"
}

check_optional_template_surface() { # NAME TEMPLATE_REL INSTALLED_ABS
  local name="$1" rel="$2" installed="$3"
  if [ ! -f "$installed" ]; then
    echo "skip: $name (not installed on this host)"
    return 0
  fi
  check_template_surface "$name" "$rel" "$installed"
}

# --- main ---
check_template_surface "harness-maintenance" "deploy/com.whatsoup.harness-maintenance.plist" "$LAUNCHD_DIR/com.whatsoup.harness-maintenance.plist"
check_template_surface "reply-guarantee" "deploy/com.whatsoup.reply-guarantee.plist" "$LAUNCHD_DIR/com.whatsoup.reply-guarantee.plist"
check_optional_template_surface "ms365-token-backup" "deploy/templates/com.whatsoup.ms365-token-backup.plist" "$LAUNCHD_DIR/com.whatsoup.ms365-token-backup.plist"

if [ "$failures" -gt 0 ]; then
  echo "launchd drift check failed: $failures problem(s)" >&2
  exit 1
fi
echo "all managed launchd surfaces match"
