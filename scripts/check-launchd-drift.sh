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
ALL_INSTANCES=()

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
      INSTANCE_VALUES_SEEN=0
      while [ "$#" -gt 0 ] && [[ "$1" != --* ]]; do
        INSTANCES+=("$1"); INSTANCE_VALUES_SEEN=1; shift
      done
      if [ "$INSTANCE_VALUES_SEEN" -eq 0 ]; then
        echo "missing --instance value" >&2; usage >&2; exit 2
      fi
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
  local v nl
  nl=$'\n'
  for v in "$REPO_ROOT" "$HOME" "$bot"; do
    case "$v" in
      *'|'*|*'&'*|*'\'*|*"$nl"*)
        echo "unsafe character in substitution value (| & \\ or newline); refusing to render: $1" >&2
        return 2 ;;
    esac
  done
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

discover_instances() {
  local f stem k known
  for f in "$LAUNCHD_DIR"/com.whatsoup.*.plist; do
    [ -e "$f" ] || continue
    stem="$(basename "$f" .plist)"
    stem="${stem#com.whatsoup.}"
    case "$stem" in *-watchdog) continue ;; esac
    known=0
    for k in "${NON_INSTANCE_STEMS[@]}"; do
      if [ "$stem" = "$k" ]; then known=1; fi
    done
    if [ "$known" -eq 1 ]; then continue; fi
    ALL_INSTANCES+=("$stem")
  done
}

check_release_drift_surface() { # host-level; uses INSTANCES
  local installed="$LAUNCHD_DIR/com.whatsoup.release-drift-check.plist"
  if [ ! -f "$installed" ]; then
    echo "skip: release-drift-check (not installed on this host)"
    return 0
  fi
  local render="$REPO_ROOT/deploy/scripts/render-release-drift-launchd.sh"
  if [ ! -f "$render" ]; then
    echo "missing repo render script: deploy/scripts/render-release-drift-launchd.sh" >&2
    failures=$((failures + 1)); return 0
  fi
  local tmpd bot out matched=0
  tmpd="$(mktemp -d "${TMPDIR:-/tmp}/launchd-drift-rd.XXXXXX")"
  for bot in ${ALL_INSTANCES[@]+"${ALL_INSTANCES[@]}"}; do
    out="$tmpd/render-$bot.plist"
    if bash "$render" --instance "$bot" --repo-root "$REPO_ROOT" --home "$HOME" --output "$out" >/dev/null 2>&1 \
       && cmp -s "$out" "$installed"; then
      matched=1
      echo "ok: release-drift-check (renders for instance $bot)"
      break
    fi
  done
  rm -rf "$tmpd"
  if [ "$matched" -eq 0 ]; then
    echo "drift: release-drift-check matches no discovered instance render" >&2
    failures=$((failures + 1))
  fi
}

check_watchdog_script() { # BOT
  local bot="$1" script="$BIN_DIR/$bot-watchdog"
  if [ ! -x "$script" ]; then
    echo "missing installed watchdog script: $script" >&2
    failures=$((failures + 1)); return 0
  fi
  if python3 "$REPO_ROOT/deploy/scripts/render-watchdog.py" verify --script "$script" >/dev/null 2>&1; then
    echo "ok: $bot-watchdog script (no surviving placeholders)"
  else
    echo "drift: $bot-watchdog script failed render-watchdog verify" >&2
    failures=$((failures + 1))
  fi
}

check_ms365_script() {
  local script="$BIN_DIR/ms365-token-backup"
  if [ ! -f "$LAUNCHD_DIR/com.whatsoup.ms365-token-backup.plist" ]; then
    return 0 # host does not run this surface; plist skip already reported
  fi
  if [ ! -x "$script" ]; then
    echo "missing installed ms365-token-backup script: $script" >&2
    failures=$((failures + 1)); return 0
  fi
  if grep -qE '__[A-Z][A-Z_]*__' "$script"; then
    echo "drift: ms365-token-backup script has surviving placeholders" >&2
    failures=$((failures + 1))
  else
    echo "ok: ms365-token-backup script (no surviving placeholders)"
  fi
}

plist_key() { # PLIST_ABS Label|Prog0  (python3 plistlib: cross-platform; values printed are structural keys only, never EnvironmentVariables)
  python3 - "$1" "$2" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    p = plistlib.load(f)
if sys.argv[2] == 'Label':
    sys.stdout.write(str(p.get('Label', '')))
else:
    args = p.get('ProgramArguments') or ['']
    sys.stdout.write(str(args[0]))
PY
}

check_bot_plist_structural() { # BOT — content is NEVER printed or diffed (live credentials in EnvironmentVariables)
  local bot="$1" plist="$LAUNCHD_DIR/com.whatsoup.$bot.plist"
  if [ ! -f "$plist" ]; then
    echo "missing installed: $bot plist" >&2
    failures=$((failures + 1))
    return 0
  fi
  local label prog0 ok=1
  label="$(plist_key "$plist" Label 2>/dev/null || echo "")"
  prog0="$(plist_key "$plist" Prog0 2>/dev/null || echo "")"
  if [ "$label" != "com.whatsoup.$bot" ]; then
    echo "structural: $bot Label mismatch (expected com.whatsoup.$bot, got ${label:-unreadable})" >&2
    ok=0
  fi
  case "$prog0" in
    /usr/bin/env)
      echo "structural: $bot ProgramArguments[0] is /usr/bin/env — unpinned interpreter (mini7 incident class)" >&2
      ok=0 ;;
    "")
      echo "structural: $bot ProgramArguments[0] unreadable" >&2
      ok=0 ;;
    /*) : ;;
    *)
      echo "structural: $bot ProgramArguments[0] not an absolute path: $prog0" >&2
      ok=0 ;;
  esac
  if [ "$ok" -eq 1 ]; then
    echo "ok: $bot plist structural (Label + pinned interpreter; content not inspected)"
  else
    failures=$((failures + 1))
  fi
}

check_fleet_console_structural() {
  local plist="$LAUNCHD_DIR/com.whatsoup.whatsoup-fleet.plist"
  if [ ! -f "$plist" ]; then
    echo "skip: whatsoup-fleet (not installed on this host)"
    return 0
  fi
  local label
  label="$(plist_key "$plist" Label 2>/dev/null || echo "")"
  if [ "$label" = "com.whatsoup.whatsoup-fleet" ]; then
    echo "ok: whatsoup-fleet plist structural (content not inspected)"
  else
    echo "structural: whatsoup-fleet Label mismatch (got ${label:-unreadable})" >&2
    failures=$((failures + 1))
  fi
}

warn_unknown_surfaces() { # reported, NOT counted as drift in v1 (calibrate before gating)
  local f stem covered k
  for f in "$LAUNCHD_DIR"/com.whatsoup.*.plist; do
    [ -e "$f" ] || continue
    stem="$(basename "$f" .plist)"
    stem="${stem#com.whatsoup.}"
    covered=0
    for k in "${NON_INSTANCE_STEMS[@]}"; do
      if [ "$stem" = "$k" ]; then covered=1; fi
    done
    for k in ${ALL_INSTANCES[@]+"${ALL_INSTANCES[@]}"}; do
      if [ "$stem" = "$k" ] || [ "$stem" = "$k-watchdog" ]; then covered=1; fi
    done
    if [ "$covered" -eq 1 ]; then continue; fi
    echo "warn: unmanaged launchd surface: com.whatsoup.$stem.plist (not counted as drift in v1)"
  done
}

# NB: the call sites below are asserted VERBATIM by the manifest-parity test in
# tests/scripts/launchd-drift.test.ts (WIRED probes) — update both together.
# --- main ---
check_template_surface "harness-maintenance" "deploy/com.whatsoup.harness-maintenance.plist" "$LAUNCHD_DIR/com.whatsoup.harness-maintenance.plist"
check_template_surface "reply-guarantee" "deploy/com.whatsoup.reply-guarantee.plist" "$LAUNCHD_DIR/com.whatsoup.reply-guarantee.plist"
check_optional_template_surface "ms365-token-backup" "deploy/templates/com.whatsoup.ms365-token-backup.plist" "$LAUNCHD_DIR/com.whatsoup.ms365-token-backup.plist"
check_ms365_script
check_fleet_console_structural

discover_instances
if [ "${#INSTANCES[@]}" -eq 0 ]; then
  INSTANCES=(${ALL_INSTANCES[@]+"${ALL_INSTANCES[@]}"})
fi
for bot in ${INSTANCES[@]+"${INSTANCES[@]}"}; do
  check_bot_plist_structural "$bot"
  check_template_surface "$bot-watchdog plist" "deploy/templates/com.whatsoup.__BOT_NAME__-watchdog.plist" "$LAUNCHD_DIR/com.whatsoup.$bot-watchdog.plist" "$bot"
  check_watchdog_script "$bot"
done
check_release_drift_surface
warn_unknown_surfaces

if [ "$failures" -gt 0 ]; then
  echo "launchd drift check failed: $failures problem(s)" >&2
  exit 1
fi
echo "all managed launchd surfaces match"
