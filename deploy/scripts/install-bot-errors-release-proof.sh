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
# inconclusive (a check that could not run); 4 rollback completed with one
# or more failed steps (partial state — inspect the receipt and stderr).
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="${RELEASE_PROOF_SOURCE_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
HOME_DIR="${RELEASE_PROOF_HOME:-$HOME}"
SYSTEMD_DIR="${RELEASE_PROOF_SYSTEMD_DIR:-${XDG_CONFIG_HOME:-$HOME_DIR/.config}/systemd/user}"
MANIFEST="${RELEASE_PROOF_MANIFEST:-$SOURCE_ROOT/deploy/bot-errors-runtime-manifest.json}"

BUNDLE_PARENT="$HOME_DIR/.local/lib/whatsoup/release-proof"
MODE_FILE="$HOME_DIR/.config/whatsoup/bot-errors-release-proof.env"
INSTALL_STATE_DIR="${RELEASE_PROOF_INSTALL_STATE_DIR:-$HOME_DIR/.local/state/whatsoup/release-proof-installer}"
RECEIPT_PARENT="$INSTALL_STATE_DIR/receipts"
INSTALL_LOCK="$INSTALL_STATE_DIR/install.lock"

BUNDLE_FILES=(
  "deploy/scripts/bot-errors-release-proof-run.sh"
  "deploy/scripts/bot-errors-tree-provenance.py"
  "deploy/scripts/bot-errors-runtime-staleness.py"
  "deploy/scripts/bot-errors-emit.py"
  "deploy/scripts/lib/__init__.py"
  "deploy/scripts/lib/bot_errors_envelope.py"
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
SOURCE_COMMIT_PATHS=(
  "${BUNDLE_FILES[@]}"
  "deploy/bot-errors-runtime-manifest.json"
  "deploy/scripts/install-bot-errors-release-proof.sh"
)
for unit in "${UNIT_FILES[@]}"; do
  SOURCE_COMMIT_PATHS+=("deploy/$unit")
done

fail() { echo "release-proof-install: $*" >&2; exit 2; }

usage() {
  sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
  command -v git >/dev/null 2>&1 || fail "missing dependency: git"
  local source_head
  source_head="$(git --no-optional-locks -C "$SOURCE_ROOT" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" \
    || fail "source root is not a usable git work tree"
  [ "$source_head" = "$BUNDLE_SHA" ] \
    || fail "bundle sha $BUNDLE_SHA does not match source HEAD $source_head"
  for rel in "${SOURCE_COMMIT_PATHS[@]}"; do
    git --no-optional-locks -C "$SOURCE_ROOT" cat-file -e "$BUNDLE_SHA:$rel" 2>/dev/null \
      || fail "bundle commit does not contain required source path: $rel"
  done
  git --no-optional-locks -C "$SOURCE_ROOT" diff --quiet "$BUNDLE_SHA" -- "${SOURCE_COMMIT_PATHS[@]}" \
    || fail "selected source files differ from bundle commit $BUNDLE_SHA"
  echo "sources verified against manifest ($(basename "$MANIFEST"))"
}

require_managed_roots() {
  python3 - "$HOME_DIR" "$BUNDLE_PARENT" "$(dirname "$MODE_FILE")" "$SYSTEMD_DIR" "$INSTALL_STATE_DIR" <<'PY' \
    || fail "managed path roots must stay under a real home directory without symlink components"
import os
from pathlib import Path
import stat
import sys

home = Path(os.path.abspath(sys.argv[1]))
try:
    home_stat = home.lstat()
except OSError:
    raise SystemExit(1)
if stat.S_ISLNK(home_stat.st_mode) or not stat.S_ISDIR(home_stat.st_mode):
    raise SystemExit(1)
for raw_target in sys.argv[2:]:
    target = Path(os.path.abspath(raw_target))
    try:
        relative = target.relative_to(home)
    except ValueError:
        raise SystemExit(1)
    current = home
    for part in relative.parts:
        current /= part
        try:
            item = current.lstat()
        except FileNotFoundError:
            break
        if stat.S_ISLNK(item.st_mode) or not stat.S_ISDIR(item.st_mode):
            raise SystemExit(1)
PY
}

require_lock() {
  require_managed_roots
  mkdir -p "$INSTALL_STATE_DIR"
  chmod 0700 "$INSTALL_STATE_DIR"
  exec 8>"$INSTALL_LOCK"
  if command -v flock >/dev/null 2>&1; then
    flock -n 8 || fail "installer lock held: $INSTALL_LOCK"
  else
    fail "missing dependency: flock"
  fi
}

sctl() { systemctl --user "$@"; }

# Validate copies whose ExecStart points at the staged bundle. This keeps the
# live `current` pointer unchanged until every unit has passed validation.
validate_units_staged() {
  local stage="$1" unit source validation
  if ! bash -n "$stage/bundle/deploy/scripts/bot-errors-release-proof-run.sh"; then
    echo "release-proof-install: runner failed bash -n" >&2
    return 1
  fi
  mkdir -p "$stage/validation-units"
  for unit in "${UNIT_FILES[@]}"; do
    source="$stage/units/$unit"
    validation="$stage/validation-units/$unit"
    if [[ "$unit" == *.service ]]; then
      if ! python3 - "$source" "$validation" "$stage/bundle" <<'PY'
from pathlib import Path
import sys

source, destination, bundle = map(Path, sys.argv[1:])
text = source.read_text(encoding="utf-8")
prefix = "ExecStart=%h/.local/lib/whatsoup/release-proof/current/"
if text.count(prefix) != 1:
    raise SystemExit("expected exactly one release-proof current ExecStart")
destination.write_text(text.replace(prefix, f"ExecStart={bundle}/"), encoding="utf-8")
PY
      then
        echo "release-proof-install: could not render validation unit $unit" >&2
        return 1
      fi
    else
      cp "$source" "$validation"
    fi
    if ! systemd-analyze --user verify "$validation"; then
      echo "release-proof-install: systemd verify rejected $unit" >&2
      return 1
    fi
  done
}

# Under the install lock, any pre-existing .stage-* dir is a leftover from an
# earlier aborted run: sweep before creating this run's staging dir so
# failures never accumulate residue.
sweep_stale_stages() {
  local dir
  for dir in "$BUNDLE_PARENT"/.stage-*; do
    if [ -e "$dir" ] || [ -L "$dir" ]; then
      rm -rf "$dir"
      echo "release-proof-install: swept stale staging dir: $(basename "$dir")" >&2
    fi
  done
}

# The monitor services EnvironmentFile= this file; a missing file means every
# timer fire fails at unit start. Gate before the lock: the lock file itself
# is a filesystem write, and preflight failures must leave zero delta.
require_env_file() {
  [ -f "$HOME_DIR/.config/whatsoup/bot-errors.env" ] \
    || fail "missing $HOME_DIR/.config/whatsoup/bot-errors.env (monitor units EnvironmentFile= it; create it before install)"
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

verify_materialized_bundle() {
  local bundle_dir="$1" rel path want got unexpected_node actual_files expected_files
  if [ -L "$bundle_dir" ] || [ ! -d "$bundle_dir" ]; then
    echo "verify: bundle path is not a real directory: $bundle_dir" >&2
    return 1
  fi
  unexpected_node="$(find "$bundle_dir" ! -type d ! -type f -print -quit)"
  if [ -n "$unexpected_node" ]; then
    echo "verify: bundle contains non-file entry: $unexpected_node" >&2
    return 1
  fi
  for rel in "${BUNDLE_FILES[@]}"; do
    path="$bundle_dir/$rel"
    if [ ! -f "$path" ] || [ -L "$path" ]; then
      echo "verify: bundle file missing or not regular: $rel" >&2
      return 1
    fi
    want="$(manifest_sha_of "$rel")"
    got="$(sha256_of "$path")"
    if [ -z "$want" ] || [ "$want" != "$got" ]; then
      echo "verify: bundle hash drift: $rel" >&2
      return 1
    fi
  done
  if [ ! -x "$bundle_dir/deploy/scripts/bot-errors-release-proof-run.sh" ]; then
    echo "verify: bundle runner is not executable" >&2
    return 1
  fi
  actual_files="$(cd "$bundle_dir" && find . -type f -print | LC_ALL=C sort)"
  expected_files="$(printf './%s\n' "${BUNDLE_FILES[@]}" | LC_ALL=C sort)"
  if [ "$actual_files" != "$expected_files" ]; then
    echo "verify: bundle file set differs from the managed manifest subset" >&2
    return 1
  fi
}

atomic_symlink() {
  python3 -c '
import os, secrets, sys
target, link = sys.argv[1], sys.argv[2]
for _ in range(32):
    tmp = link + ".tmp-swap." + secrets.token_hex(8)
    try:
        os.symlink(target, tmp)
        break
    except FileExistsError:
        continue
else:
    raise RuntimeError("could not allocate temporary symlink")
try:
    os.replace(tmp, link)
finally:
    if os.path.lexists(tmp):
        os.unlink(tmp)
' "$1" "$2"
}

atomic_copy_file() {
  local source="$1" destination="$2" mode="$3" dir base tmp
  dir="$(dirname "$destination")"
  base="$(basename "$destination")"
  tmp="$(mktemp "$dir/.$base.tmp.XXXXXX")" || return 1
  if ! cp "$source" "$tmp" || ! chmod "$mode" "$tmp" || ! mv -f "$tmp" "$destination"; then
    rm -f "$tmp"
    return 1
  fi
}

write_mode_file() {
  mkdir -p "$(dirname "$MODE_FILE")"
  local tmp
  tmp="$(mktemp "$(dirname "$MODE_FILE")/.bot-errors-release-proof.env.tmp.XXXXXX")"
  printf 'BOT_ERRORS_RELEASE_PROOF_MODE=%s\n' "$1" > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$MODE_FILE"
}

is_managed_bundle_target() {
  local target="$1" name
  case "$target" in
    "$BUNDLE_PARENT"/*) name="${target#"$BUNDLE_PARENT"/}" ;;
    *) return 1 ;;
  esac
  printf '%s' "$name" | grep -Eq '^[0-9a-f]{40}$'
}

probe_unit_state() {
  local probe="$1" unit="$2" value
  value="$(sctl "$probe" "$unit" 2>/dev/null || true)"
  value="$(printf '%s\n' "$value" | head -n 1 | tr -d '[:space:]')"
  case "$probe:$value" in
    is-enabled:enabled|is-enabled:enabled-runtime|is-enabled:linked|is-enabled:linked-runtime|\
    is-enabled:alias|is-enabled:static|is-enabled:indirect|is-enabled:generated|\
    is-enabled:transient|is-enabled:disabled|is-enabled:masked|is-enabled:not-found|\
    is-active:active|is-active:reloading|is-active:inactive|is-active:failed|\
    is-active:activating|is-active:deactivating|is-active:maintenance|is-active:unknown)
      printf '%s' "$value"
      ;;
    *)
      echo "release-proof-install: timer state probe failed: $probe $unit returned no recognized state" >&2
      return 1
      ;;
  esac
}

validate_receipt_path() {
  local expected_host_fingerprint
  expected_host_fingerprint="$(fingerprint "$(canon_host "$EXPECT_HOST")")"
  python3 - "$RECEIPT_PARENT" "$1" "$expected_host_fingerprint" <<'PY'
import os
from pathlib import Path
import re
import stat
import sys

parent_arg, receipt_arg, expected_host_fingerprint = sys.argv[1:]
try:
    parent = Path(parent_arg).resolve(strict=True)
    receipt = Path(receipt_arg)
    if not receipt.is_absolute():
        receipt = Path.cwd() / receipt
    receipt_stat = receipt.lstat()
    resolved = receipt.resolve(strict=True)
except (FileNotFoundError, OSError):
    raise SystemExit(1)
if stat.S_ISLNK(receipt_stat.st_mode) or not stat.S_ISDIR(receipt_stat.st_mode):
    raise SystemExit(1)
if resolved.parent != parent or not re.fullmatch(r"\d{8}T\d{6}Z-\d+", resolved.name):
    raise SystemExit(1)
if receipt_stat.st_uid != os.getuid() or stat.S_IMODE(receipt_stat.st_mode) & 0o077:
    raise SystemExit(1)
meta = resolved / "receipt.meta"
try:
    meta_stat = meta.lstat()
    meta_text = meta.read_text(encoding="utf-8")
except (FileNotFoundError, OSError, UnicodeError):
    raise SystemExit(1)
if not stat.S_ISREG(meta_stat.st_mode) or meta_stat.st_uid != os.getuid():
    raise SystemExit(1)
if meta_text != f"schemaVersion=1\nhostFingerprint={expected_host_fingerprint}\n":
    raise SystemExit(1)
for path in resolved.rglob("*"):
    item = path.lstat()
    if stat.S_ISLNK(item.st_mode) or not (stat.S_ISDIR(item.st_mode) or stat.S_ISREG(item.st_mode)):
        raise SystemExit(1)
    if item.st_uid != os.getuid() or stat.S_IMODE(item.st_mode) & 0o077:
        raise SystemExit(1)

def exactly_one(first: Path, second: Path) -> bool:
    return first.is_file() != second.is_file()

units_prior = resolved / "units-prior"
if not units_prior.is_dir():
    raise SystemExit(1)
unit_names = (
    "bot-errors-tree-provenance.service",
    "bot-errors-tree-provenance.timer",
    "bot-errors-runtime-staleness.service",
    "bot-errors-runtime-staleness.timer",
)
for unit in unit_names:
    if not exactly_one(units_prior / unit, units_prior / f"{unit}.was-absent"):
        raise SystemExit(1)
if not exactly_one(resolved / "current-prior.txt", resolved / "current-prior.was-absent"):
    raise SystemExit(1)
if not exactly_one(resolved / "mode-prior.env", resolved / "mode-prior.was-absent"):
    raise SystemExit(1)
timer_state = resolved / "timer-state-prior.txt"
try:
    timer_lines = timer_state.read_text(encoding="utf-8").splitlines()
except (FileNotFoundError, OSError, UnicodeError):
    raise SystemExit(1)
timer_pattern = re.compile(
    r"^(bot-errors-(?:tree-provenance|runtime-staleness)\.timer) "
    r"enabled=(enabled|enabled-runtime|linked|linked-runtime|alias|static|indirect|generated|transient|disabled|masked|not-found) "
    r"active=(active|reloading|inactive|failed|activating|deactivating|maintenance|unknown)$"
)
parsed_timers = [timer_pattern.fullmatch(line) for line in timer_lines]
if any(match is None for match in parsed_timers):
    raise SystemExit(1)
if {match.group(1) for match in parsed_timers if match} != {
    "bot-errors-tree-provenance.timer",
    "bot-errors-runtime-staleness.timer",
} or len(timer_lines) != 2:
    raise SystemExit(1)
PY
}

take_backup() {
  RECEIPT="$RECEIPT_PARENT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$RECEIPT/units-prior"
  chmod 0700 "$RECEIPT" "$RECEIPT/units-prior"
  printf 'schemaVersion=1\nhostFingerprint=%s\n' \
    "$(fingerprint "$(canon_host "$EXPECT_HOST")")" > "$RECEIPT/receipt.meta"
  chmod 0600 "$RECEIPT/receipt.meta"
  local unit installed prior_target enabled_state active_state
  for unit in "${UNIT_FILES[@]}"; do
    installed="$SYSTEMD_DIR/$unit"
    require_no_symlink "$installed"
    if [ -f "$installed" ]; then
      cp "$installed" "$RECEIPT/units-prior/$unit"
    else
      : > "$RECEIPT/units-prior/$unit.was-absent"
    fi
  done
  if [ -L "$BUNDLE_PARENT/current" ]; then
    prior_target="$(readlink "$BUNDLE_PARENT/current")"
    if ! is_managed_bundle_target "$prior_target" || [ ! -d "$prior_target" ]; then
      echo "release-proof-install: current points outside a live managed bundle" >&2
      return 1
    fi
    printf '%s\n' "$prior_target" > "$RECEIPT/current-prior.txt"
  elif [ -e "$BUNDLE_PARENT/current" ]; then
    echo "release-proof-install: current exists but is not a symlink" >&2
    return 1
  else
    : > "$RECEIPT/current-prior.was-absent"
  fi
  if [ -L "$MODE_FILE" ]; then
    echo "release-proof-install: mode file is a symlink" >&2
    return 1
  fi
  if [ -f "$MODE_FILE" ]; then
    cp "$MODE_FILE" "$RECEIPT/mode-prior.env"
  else
    : > "$RECEIPT/mode-prior.was-absent"
  fi
  for unit in "${TIMER_UNITS[@]}"; do
    if ! enabled_state="$(probe_unit_state is-enabled "$unit")"; then
      return 1
    fi
    if ! active_state="$(probe_unit_state is-active "$unit")"; then
      return 1
    fi
    printf '%s enabled=%s active=%s\n' "$unit" \
      "$enabled_state" "$active_state" >> "$RECEIPT/timer-state-prior.txt"
  done
  echo "backup receipt: $RECEIPT"
}

# Rollback handler. Runs both standalone (rollback op) and as do_install's
# ERR-trap recovery, so it must NEVER abort partway: every step is guarded,
# failures accumulate in a counter with a per-step stderr line, and the
# byte-verification loop plus the timer-state restore are always reached.
# Returns 0 with ROLLBACK_OK on a clean pass, or 4 with ROLLBACK_FAILED on
# stderr otherwise (the standalone rollback op surfaces that as exit 4).
do_rollback_from() {
  local receipt="$1" unit prior frag failures=0
  if ! validate_receipt_path "$receipt"; then
    echo "release-proof-install: receipt is not a confined installer receipt" >&2
    return 2
  fi
  for unit in "${TIMER_UNITS[@]}"; do
    if ! sctl disable --now "$unit"; then
      echo "release-proof-install: rollback: failed to disable $unit" >&2
      failures=$((failures + 1))
    fi
  done
  for unit in "${UNIT_FILES[@]}"; do
    prior="$receipt/units-prior/$unit"
    if [ -f "$prior" ]; then
      if ! atomic_copy_file "$prior" "$SYSTEMD_DIR/$unit" 0644; then
        echo "release-proof-install: rollback: failed to restore unit $unit" >&2
        failures=$((failures + 1))
      fi
    elif [ -f "$receipt/units-prior/$unit.was-absent" ]; then
      if ! rm -f "$SYSTEMD_DIR/$unit"; then
        echo "release-proof-install: rollback: failed to remove installed unit $unit" >&2
        failures=$((failures + 1))
      fi
    fi
  done
  if [ -f "$receipt/current-prior.txt" ]; then
    prior="$(cat "$receipt/current-prior.txt")"
    if ! is_managed_bundle_target "$prior" || [ ! -d "$prior" ]; then
      echo "release-proof-install: rollback: prior current target is not a live managed bundle" >&2
      failures=$((failures + 1))
    elif ! atomic_symlink "$prior" "$BUNDLE_PARENT/current"; then
      echo "release-proof-install: rollback: failed to restore current symlink" >&2
      failures=$((failures + 1))
    fi
  elif [ -f "$receipt/current-prior.was-absent" ]; then
    if ! rm -f "$BUNDLE_PARENT/current"; then
      echo "release-proof-install: rollback: failed to remove current symlink" >&2
      failures=$((failures + 1))
    fi
  fi
  if [ -f "$receipt/mode-prior.env" ]; then
    if ! atomic_copy_file "$receipt/mode-prior.env" "$MODE_FILE" 0600; then
      echo "release-proof-install: rollback: failed to restore mode file" >&2
      failures=$((failures + 1))
    fi
  elif [ -f "$receipt/mode-prior.was-absent" ]; then
    if ! rm -f "$MODE_FILE"; then
      echo "release-proof-install: rollback: failed to remove mode file" >&2
      failures=$((failures + 1))
    fi
  fi
  if ! sctl daemon-reload; then
    echo "release-proof-install: rollback: daemon-reload failed" >&2
    failures=$((failures + 1))
  fi
  if [ -f "$receipt/timer-state-prior.txt" ]; then
    while read -r unit rest; do
      case "$rest" in
        *enabled=enabled*)
          if ! sctl enable "$unit"; then
            echo "release-proof-install: rollback: failed to re-enable $unit" >&2
            failures=$((failures + 1))
          fi
          ;;
      esac
      case "$rest" in
        *active=active*)
          if ! sctl start "$unit"; then
            echo "release-proof-install: rollback: failed to restart $unit" >&2
            failures=$((failures + 1))
          fi
          ;;
      esac
    done < "$receipt/timer-state-prior.txt"
  fi
  for unit in "${UNIT_FILES[@]}"; do
    prior="$receipt/units-prior/$unit"
    if [ -f "$prior" ]; then
      if cmp -s "$prior" "$SYSTEMD_DIR/$unit"; then
        echo "rollback byte verification ok: $unit"
      else
        echo "release-proof-install: rollback byte verification failed for $unit" >&2
        failures=$((failures + 1))
      fi
      frag="$(sctl show -p FragmentPath --value "$unit" 2>/dev/null || true)"
      if [ "$frag" != "$SYSTEMD_DIR/$unit" ]; then
        echo "release-proof-install: rollback: loaded fragment for restored $unit is '$frag', expected $SYSTEMD_DIR/$unit" >&2
        failures=$((failures + 1))
      fi
    fi
  done
  if [ "$failures" -ne 0 ]; then
    echo "ROLLBACK_FAILED steps=$failures receipt=$receipt" >&2
    return 4
  fi
  echo "ROLLBACK_OK receipt=$receipt"
}

do_verify() {
  require_managed_roots
  local unit failures=0
  for unit in "${UNIT_FILES[@]}"; do
    if [ -L "$SYSTEMD_DIR/$unit" ]; then
      echo "verify: installed unit is a symlink: $unit" >&2
      failures=$((failures + 1))
    elif ! cmp -s "$SOURCE_ROOT/deploy/$unit" "$SYSTEMD_DIR/$unit"; then
      echo "verify: unit drift or missing: $unit" >&2
      failures=$((failures + 1))
    fi
  done
  local link="$BUNDLE_PARENT/current"
  if [ ! -L "$link" ] || [ "$(readlink "$link")" != "$BUNDLE_PARENT/$BUNDLE_SHA" ]; then
    echo "verify: current symlink does not point at $BUNDLE_SHA" >&2
    failures=$((failures + 1))
  fi
  if ! verify_materialized_bundle "$BUNDLE_PARENT/$BUNDLE_SHA"; then
    failures=$((failures + 1))
  fi
  local mode_value
  if [ -L "$MODE_FILE" ]; then
    echo "verify: mode file is a symlink" >&2
    failures=$((failures + 1))
  elif [ ! -f "$MODE_FILE" ]; then
    echo "verify: mode file missing" >&2
    failures=$((failures + 1))
  else
    # Same extraction the scheduler runner uses (read as data, never sourced).
    mode_value="$(sed -n 's/^BOT_ERRORS_RELEASE_PROOF_MODE=//p' "$MODE_FILE" | tail -n 1 | tr -d '[:space:]')"
    case "$mode_value" in
      observe|emit) ;;
      *)
        echo "verify: mode file value '$mode_value' does not parse to observe|emit" >&2
        failures=$((failures + 1))
        ;;
    esac
  fi
  local enabled_state active_state
  for unit in "${TIMER_UNITS[@]}"; do
    enabled_state="$(sctl is-enabled "$unit" 2>/dev/null || true)"
    if [ "$enabled_state" != "enabled" ]; then
      echo "verify: timer $unit is-enabled reports '$enabled_state', expected enabled" >&2
      failures=$((failures + 1))
    fi
    active_state="$(sctl is-active "$unit" 2>/dev/null || true)"
    if [ "$active_state" != "active" ]; then
      echo "verify: timer $unit is-active reports '$active_state', expected active" >&2
      failures=$((failures + 1))
    fi
  done
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
  [ "$failures" -eq 0 ] || return 1
  echo "VERIFY_OK"
}

do_install() {
  # Preflight precedes the lock (spec 6.5 items 2 vs 5): a failed source,
  # dependency, or environment check must leave zero filesystem delta, and
  # the lock file itself is a write.
  require_env_file
  command -v systemd-analyze >/dev/null 2>&1 || fail "missing dependency: systemd-analyze (unit validation is mandatory)"
  verify_sources
  require_lock
  mkdir -p "$BUNDLE_PARENT"
  mkdir -p "$SYSTEMD_DIR"
  sweep_stale_stages
  local unit
  for unit in "${UNIT_FILES[@]}"; do
    require_no_symlink "$SYSTEMD_DIR/$unit"
  done
  require_no_symlink "$MODE_FILE"
  local bundle_dir="$BUNDLE_PARENT/$BUNDLE_SHA" bundle_preexisting=0
  if [ -L "$bundle_dir" ]; then
    fail "refusing symlink in managed bundle path: $bundle_dir"
  elif [ -e "$bundle_dir" ]; then
    if ! verify_materialized_bundle "$bundle_dir"; then
      fail "existing bundle $BUNDLE_SHA is not the exact immutable managed bundle"
    fi
    bundle_preexisting=1
  fi
  local stage
  stage="$(mktemp -d "$BUNDLE_PARENT/.stage-XXXXXX")"
  render_stage "$stage"
  if ! validate_units_staged "$stage"; then
    rm -rf "$stage"
    fail "staged unit validation failed"
  fi
  if ! take_backup; then
    rm -rf "$stage"
    [ -z "${RECEIPT:-}" ] || rm -rf "$RECEIPT"
    fail "timer state backup failed; live state is unchanged"
  fi
  # The rollback call is guarded (|| …) so a partial rollback cannot abort
  # the trap: an explicit banner is printed and the install still exits 1.
  trap 'echo "release-proof-install: failure after backup — rolling back" >&2
    rm -rf "$stage" || true
    do_rollback_from "$RECEIPT" || echo "release-proof-install: ROLLBACK_FAILED during install recovery — partial state; inspect receipt $RECEIPT" >&2
    exit 1' ERR

  if [ "$bundle_preexisting" -eq 1 ]; then
    echo "release-proof-install: reusing verified immutable bundle $BUNDLE_SHA"
  else
    mv "$stage/bundle" "$bundle_dir"
  fi
  atomic_symlink "$bundle_dir" "$BUNDLE_PARENT/current"
  for unit in "${UNIT_FILES[@]}"; do
    # ERR-flow guard: fail() here would exit 2 and bypass the armed trap.
    if [ -L "$SYSTEMD_DIR/$unit" ]; then
      echo "release-proof-install: refusing symlink in managed path: $SYSTEMD_DIR/$unit" >&2
      false
    fi
    atomic_copy_file "$stage/units/$unit" "$SYSTEMD_DIR/$unit" 0644
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
  if ! take_backup; then
    [ -z "${RECEIPT:-}" ] || rm -rf "$RECEIPT"
    fail "timer state backup failed; mode is unchanged"
  fi
  write_mode_file "$MODE"
  printf 'operation=set-mode\nmode=%s\nreceipt=%s\n' "$MODE" "$RECEIPT" > "$RECEIPT/receipt.txt"
  echo "RECEIPT=$RECEIPT"
  echo "SET_MODE_OK mode=$MODE"
}

do_dry_run() {
  require_managed_roots
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
    require_managed_roots
    validate_receipt_path "$RECEIPT_ARG" \
      || fail "receipt is not a confined installer receipt"
    require_lock
    # Explicit propagation: 4 = rollback ran to completion with failed steps.
    do_rollback_from "$RECEIPT_ARG" || exit "$?"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
