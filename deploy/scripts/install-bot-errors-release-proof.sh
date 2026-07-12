#!/usr/bin/env bash
# Narrow installer for the BOT ERRORS release-proof monitor (central pilot).
#
# Manages ONLY:
#   - versioned monitor bundles under   <home>/.local/lib/whatsoup/release-proof/<40-hex>/
#   - the `current` bundle symlink
#   - the mode file                     <home>/.config/whatsoup/bot-errors-release-proof.env
#   - the four monitor unit files       bot-errors-tree-provenance.{service,timer}
#                                       bot-errors-runtime-staleness.{service,timer}
#   - enablement of the two monitor timers
#
# It never mutates any application, fleet, dispatcher, collector, or q-loop
# unit and never writes into the application checkout or instance state.
# The scheduled tree producer it installs is the ONLY tree producer; this
# installer deliberately has no knowledge of the daily-health integration.
#
# Operations:
#   dry-run  --host <name> --mode observe|emit --bundle-sha <40-hex>
#   install  --host <name> --mode observe      --bundle-sha <40-hex>
#   set-mode --host <name> --mode observe|emit
#   verify   --host <name> --bundle-sha <40-hex>
#   rollback --host <name> --receipt <dir>
#
# Exit codes: 0 ok; 1 verification failure; 2 usage/preflight error or
# inconclusive (a check that could not run).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="${RELEASE_PROOF_SOURCE_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
HOME_DIR="${RELEASE_PROOF_HOME:-$HOME}"
SYSTEMD_DIR="${RELEASE_PROOF_SYSTEMD_DIR:-${XDG_CONFIG_HOME:-$HOME_DIR/.config}/systemd/user}"
MANIFEST="${RELEASE_PROOF_MANIFEST:-$SOURCE_ROOT/deploy/bot-errors-runtime-manifest.json}"

BUNDLE_PARENT="$HOME_DIR/.local/lib/whatsoup/release-proof"
MODE_FILE="$HOME_DIR/.config/whatsoup/bot-errors-release-proof.env"
STATE_DIR="${BOT_ERRORS_STATE_DIR:-$HOME_DIR/.local/state/bot-errors}"
RECEIPT_PARENT="$STATE_DIR/release-proof-receipts"
INSTALL_LOCK="$STATE_DIR/release-proof-install.lock"

BUNDLE_FILES=(
  "deploy/scripts/bot-errors-release-proof-run.sh"
  "deploy/scripts/bot-errors-tree-provenance.py"
  "deploy/scripts/bot-errors-runtime-staleness.py"
  "deploy/scripts/bot-errors-emit.py"
  "deploy/scripts/lib/__init__.py"
  "deploy/scripts/lib/bot_errors_redaction.py"
)
UNIT_FILES=(
  "bot-errors-tree-provenance.service"
  "bot-errors-tree-provenance.timer"
  "bot-errors-runtime-staleness.service"
  "bot-errors-runtime-staleness.timer"
)
TIMER_UNITS=(
  "bot-errors-tree-provenance.timer"
  "bot-errors-runtime-staleness.timer"
)

fail() { echo "release-proof-install: $*" >&2; exit 2; }

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

sha256_of() {
  python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"
}

manifest_sha_of() {
  python3 -c '
import json, sys
manifest = json.load(open(sys.argv[1]))
for entry in manifest.get("files", []):
    if entry.get("path") == sys.argv[2]:
        print(entry.get("sha256", ""))
        break
' "$MANIFEST" "$1"
}

canon_host() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/\.*$//'; }

fingerprint() {
  python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$1"
}

require_host() {
  [ -n "$EXPECT_HOST" ] || fail "--host is required"
  local expect actual
  expect="$(canon_host "$EXPECT_HOST")"
  actual="$(canon_host "$(hostname)")"
  if [ "$expect" != "$actual" ]; then
    echo "release-proof-install: host gate failed (expected fp=$(fingerprint "$expect") actual fp=$(fingerprint "$actual"))" >&2
    exit 2
  fi
  echo "host gate ok (fp=$(fingerprint "$actual"))"
}

require_bundle_sha() {
  printf '%s' "$BUNDLE_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail "--bundle-sha must be 40 lowercase hex chars"
}

require_no_symlink() {
  [ -L "$1" ] && fail "refusing symlink in managed path: $1"
  return 0
}

verify_sources() {
  [ -f "$MANIFEST" ] || fail "manifest not found: $MANIFEST"
  local rel src want got
  for rel in "${BUNDLE_FILES[@]}"; do
    src="$SOURCE_ROOT/$rel"
    require_no_symlink "$src"
    [ -e "$src" ] || fail "missing source file: $rel"
    want="$(manifest_sha_of "$rel")"
    [ -n "$want" ] || fail "manifest has no entry for $rel"
    got="$(sha256_of "$src")"
    [ "$want" = "$got" ] || fail "hash mismatch for $rel (manifest=$want actual=$got)"
  done
  for rel in "${UNIT_FILES[@]}"; do
    src="$SOURCE_ROOT/deploy/$rel"
    require_no_symlink "$src"
    [ -e "$src" ] || fail "missing unit source: deploy/$rel"
  done
  echo "sources verified against manifest ($(basename "$MANIFEST"))"
}

require_lock() {
  mkdir -p "$STATE_DIR"
  exec 8>"$INSTALL_LOCK"
  if command -v flock >/dev/null 2>&1; then
    flock -n 8 || fail "installer lock held: $INSTALL_LOCK"
  else
    fail "missing dependency: flock"
  fi
}

sctl() { systemctl --user "$@"; }

validate_units_staged() {
  local stage="$1" unit
  command -v systemd-analyze >/dev/null 2>&1 || fail "missing dependency: systemd-analyze (unit validation is mandatory)"
  bash -n "$stage/bundle/deploy/scripts/bot-errors-release-proof-run.sh" || fail "runner failed bash -n"
  for unit in "${UNIT_FILES[@]}"; do
    systemd-analyze --user verify "$stage/units/$unit" || fail "systemd verify rejected $unit"
  done
}

render_stage() {
  local stage="$1" rel dest
  for rel in "${BUNDLE_FILES[@]}"; do
    dest="$stage/bundle/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$SOURCE_ROOT/$rel" "$dest"
    [ "$(sha256_of "$dest")" = "$(manifest_sha_of "$rel")" ] || fail "staged copy hash drifted: $rel"
  done
  chmod 0755 "$stage/bundle/deploy/scripts/bot-errors-release-proof-run.sh"
  mkdir -p "$stage/units"
  for rel in "${UNIT_FILES[@]}"; do
    cp "$SOURCE_ROOT/deploy/$rel" "$stage/units/$rel"
  done
}

atomic_symlink() {
  python3 -c '
import os, sys
target, link = sys.argv[1], sys.argv[2]
tmp = link + ".tmp-swap"
if os.path.islink(tmp) or os.path.exists(tmp):
    os.unlink(tmp)
os.symlink(target, tmp)
os.replace(tmp, link)
' "$1" "$2"
}

write_mode_file() {
  mkdir -p "$(dirname "$MODE_FILE")"
  local tmp="$MODE_FILE.tmp"
  printf 'BOT_ERRORS_RELEASE_PROOF_MODE=%s\n' "$1" > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$MODE_FILE"
}

take_backup() {
  RECEIPT="$RECEIPT_PARENT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$RECEIPT/units-prior"
  local unit installed
  for unit in "${UNIT_FILES[@]}"; do
    installed="$SYSTEMD_DIR/$unit"
    if [ -f "$installed" ]; then
      require_no_symlink "$installed"
      cp "$installed" "$RECEIPT/units-prior/$unit"
    else
      : > "$RECEIPT/units-prior/$unit.was-absent"
    fi
  done
  if [ -L "$BUNDLE_PARENT/current" ]; then
    readlink "$BUNDLE_PARENT/current" > "$RECEIPT/current-prior.txt"
  else
    : > "$RECEIPT/current-prior.was-absent"
  fi
  if [ -f "$MODE_FILE" ]; then
    cp "$MODE_FILE" "$RECEIPT/mode-prior.env"
  else
    : > "$RECEIPT/mode-prior.was-absent"
  fi
  for unit in "${TIMER_UNITS[@]}"; do
    printf '%s enabled=%s active=%s\n' "$unit" \
      "$(sctl is-enabled "$unit" 2>/dev/null || true)" \
      "$(sctl is-active "$unit" 2>/dev/null || true)" >> "$RECEIPT/timer-state-prior.txt"
  done
  echo "backup receipt: $RECEIPT"
}

do_rollback_from() {
  local receipt="$1" unit prior
  [ -d "$receipt" ] || fail "receipt not found: $receipt"
  for unit in "${TIMER_UNITS[@]}"; do
    sctl disable --now "$unit" || true
  done
  for unit in "${UNIT_FILES[@]}"; do
    prior="$receipt/units-prior/$unit"
    if [ -f "$prior" ]; then
      cp "$prior" "$SYSTEMD_DIR/.$unit.tmp"
      mv -f "$SYSTEMD_DIR/.$unit.tmp" "$SYSTEMD_DIR/$unit"
    elif [ -f "$receipt/units-prior/$unit.was-absent" ]; then
      rm -f "$SYSTEMD_DIR/$unit"
    fi
  done
  if [ -f "$receipt/current-prior.txt" ]; then
    atomic_symlink "$(cat "$receipt/current-prior.txt")" "$BUNDLE_PARENT/current"
  elif [ -f "$receipt/current-prior.was-absent" ]; then
    rm -f "$BUNDLE_PARENT/current"
  fi
  if [ -f "$receipt/mode-prior.env" ]; then
    cp "$receipt/mode-prior.env" "$MODE_FILE.tmp"
    mv -f "$MODE_FILE.tmp" "$MODE_FILE"
  elif [ -f "$receipt/mode-prior.was-absent" ]; then
    rm -f "$MODE_FILE"
  fi
  sctl daemon-reload
  if [ -f "$receipt/timer-state-prior.txt" ]; then
    while read -r unit rest; do
      case "$rest" in
        *enabled=enabled*) sctl enable "$unit" || true ;;
      esac
      case "$rest" in
        *active=active*) sctl start "$unit" || true ;;
      esac
    done < "$receipt/timer-state-prior.txt"
  fi
  for unit in "${UNIT_FILES[@]}"; do
    prior="$receipt/units-prior/$unit"
    if [ -f "$prior" ] && ! cmp -s "$prior" "$SYSTEMD_DIR/$unit"; then
      echo "release-proof-install: rollback byte verification failed for $unit" >&2
      exit 1
    fi
  done
  echo "ROLLBACK_OK receipt=$receipt"
}

do_verify() {
  local unit failures=0
  for unit in "${UNIT_FILES[@]}"; do
    if ! cmp -s "$SOURCE_ROOT/deploy/$unit" "$SYSTEMD_DIR/$unit"; then
      echo "verify: unit drift or missing: $unit" >&2
      failures=$((failures + 1))
    fi
  done
  local link="$BUNDLE_PARENT/current"
  if [ ! -L "$link" ] || [ "$(readlink "$link")" != "$BUNDLE_PARENT/$BUNDLE_SHA" ]; then
    echo "verify: current symlink does not point at $BUNDLE_SHA" >&2
    failures=$((failures + 1))
  fi
  local rel
  for rel in "${BUNDLE_FILES[@]}"; do
    if [ "$(sha256_of "$BUNDLE_PARENT/$BUNDLE_SHA/$rel")" != "$(manifest_sha_of "$rel")" ]; then
      echo "verify: bundle hash drift: $rel" >&2
      failures=$((failures + 1))
    fi
  done
  if [ ! -f "$MODE_FILE" ]; then
    echo "verify: mode file missing" >&2
    failures=$((failures + 1))
  fi
  local frag dropins
  for unit in "${UNIT_FILES[@]}"; do
    frag="$(sctl show -p FragmentPath --value "$unit" 2>/dev/null || true)"
    dropins="$(sctl show -p DropInPaths --value "$unit" 2>/dev/null || true)"
    if [ "$frag" != "$SYSTEMD_DIR/$unit" ]; then
      echo "verify: loaded fragment for $unit is '$frag', expected $SYSTEMD_DIR/$unit" >&2
      failures=$((failures + 1))
    fi
    if [ -n "$dropins" ]; then
      echo "verify: unexpected drop-ins for $unit: $dropins" >&2
      failures=$((failures + 1))
    fi
  done
  [ "$failures" -eq 0 ] || exit 1
  echo "VERIFY_OK"
}

do_install() {
  # Verification precedes the lock (spec 6.5 items 2 vs 5): a failed source
  # check must leave zero filesystem delta, and the lock file is a write.
  verify_sources
  require_lock
  mkdir -p "$BUNDLE_PARENT"
  local stage
  stage="$(mktemp -d "$BUNDLE_PARENT/.stage-XXXXXX")"
  render_stage "$stage"
  validate_units_staged "$stage"
  take_backup
  trap 'echo "release-proof-install: failure after backup — rolling back" >&2; do_rollback_from "$RECEIPT"; exit 1' ERR

  rm -rf "$BUNDLE_PARENT/$BUNDLE_SHA"
  mv "$stage/bundle" "$BUNDLE_PARENT/$BUNDLE_SHA"
  atomic_symlink "$BUNDLE_PARENT/$BUNDLE_SHA" "$BUNDLE_PARENT/current"

  mkdir -p "$SYSTEMD_DIR"
  local unit
  for unit in "${UNIT_FILES[@]}"; do
    [ -e "$SYSTEMD_DIR/$unit" ] && require_no_symlink "$SYSTEMD_DIR/$unit"
    cp "$stage/units/$unit" "$SYSTEMD_DIR/.$unit.tmp"
    mv -f "$SYSTEMD_DIR/.$unit.tmp" "$SYSTEMD_DIR/$unit"
  done
  rm -rf "$stage"

  write_mode_file "$MODE"
  sctl daemon-reload
  for unit in "${TIMER_UNITS[@]}"; do
    sctl enable --now "$unit"
  done
  do_verify
  trap - ERR
  {
    printf 'operation=install\nbundle_sha=%s\nmode=%s\nreceipt=%s\n' "$BUNDLE_SHA" "$MODE" "$RECEIPT"
  } > "$RECEIPT/receipt.txt"
  echo "RECEIPT=$RECEIPT"
  echo "ROLLBACK: bash deploy/scripts/install-bot-errors-release-proof.sh rollback --host <host> --receipt $RECEIPT"
  echo "INSTALL_OK"
}

do_set_mode() {
  require_lock
  take_backup
  write_mode_file "$MODE"
  printf 'operation=set-mode\nmode=%s\nreceipt=%s\n' "$MODE" "$RECEIPT" > "$RECEIPT/receipt.txt"
  echo "RECEIPT=$RECEIPT"
  echo "SET_MODE_OK mode=$MODE"
}

do_dry_run() {
  verify_sources
  echo "--- would materialize bundle $BUNDLE_SHA under $BUNDLE_PARENT/$BUNDLE_SHA/ ---"
  printf '  %s\n' "${BUNDLE_FILES[@]}"
  echo "--- would install units into $SYSTEMD_DIR ---"
  printf '  %s\n' "${UNIT_FILES[@]}"
  echo "--- would write mode file $MODE_FILE with mode=$MODE ---"
  echo "--- would run: systemctl --user daemon-reload; enable --now ${TIMER_UNITS[*]} ---"
  echo "DRY_RUN_OK"
}

OP="${1:-}"
[ -n "$OP" ] || { usage >&2; exit 2; }
shift

EXPECT_HOST=""
MODE=""
BUNDLE_SHA=""
RECEIPT_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) EXPECT_HOST="${2:?missing --host value}"; shift 2 ;;
    --mode) MODE="${2:?missing --mode value}"; shift 2 ;;
    --bundle-sha) BUNDLE_SHA="${2:?missing --bundle-sha value}"; shift 2 ;;
    --receipt) RECEIPT_ARG="${2:?missing --receipt value}"; shift 2 ;;
    *) fail "unexpected argument: $1" ;;
  esac
done

case "$OP" in
  dry-run)
    require_host
    case "$MODE" in observe|emit) ;; *) fail "dry-run requires --mode observe|emit" ;; esac
    [ -n "$BUNDLE_SHA" ] || fail "dry-run requires --bundle-sha"
    require_bundle_sha
    do_dry_run
    ;;
  install)
    require_host
    if [ "$MODE" != "observe" ]; then
      fail "install only supports --mode observe; use set-mode for emit after the observe soak"
    fi
    [ -n "$BUNDLE_SHA" ] || fail "install requires --bundle-sha"
    require_bundle_sha
    do_install
    ;;
  set-mode)
    require_host
    case "$MODE" in observe|emit) ;; *) fail "set-mode requires --mode observe|emit" ;; esac
    do_set_mode
    ;;
  verify)
    require_host
    [ -n "$BUNDLE_SHA" ] || fail "verify requires --bundle-sha"
    require_bundle_sha
    do_verify
    ;;
  rollback)
    require_host
    [ -n "$RECEIPT_ARG" ] || fail "rollback requires --receipt <dir>"
    require_lock
    do_rollback_from "$RECEIPT_ARG"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
