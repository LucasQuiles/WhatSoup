#!/usr/bin/env bash
# whatsoup-bot-errors-deploy.sh — reversible materialize of the 10 bot-errors runtime
# files (pinned to current origin/main content) into a host's TRUE bot-errors root.
#
#   deploy:       whatsoup-bot-errors-deploy.sh deploy       <root> <staging-dir>
#   verify:       whatsoup-bot-errors-deploy.sh verify       <root>
#   rollback:     whatsoup-bot-errors-deploy.sh rollback     <root> <backup-dir>
#   rollback-lkg: whatsoup-bot-errors-deploy.sh rollback-lkg <root>
#   pin:          whatsoup-bot-errors-deploy.sh pin          <manifest.json> <ledger.json> <head_sha>
#
# Fail-closed: any sha mismatch or smoke failure exits non-zero. Backup is taken BEFORE
# any write so rollback is always possible. Does NOT touch git or restart services.
# Writes are confined to <root> plus a sibling rollback-backup directory. Restart of
# com.bot-errors.* units is a separate, explicit step.
set -euo pipefail

MODE="${1:?usage: deploy|verify|rollback|rollback-lkg|pin ...}"
ROOT="${2:?missing <root>}"

# F-id : path-relative-to-root : expected current-main sha256
FILES=(
  "deploy/scripts/bot-errors-dispatcher.py:84763cd9f4e860aeb778c87bef5579441088425e80abadaafcda091505a72043"
  "deploy/scripts/bot-errors-health-check.py:26719b054982e09ae5b746c64c3de502dbf6eac746fd5d0092b34b57a9ef77fd"
  "deploy/scripts/bot-errors-heartbeat-watchdog.py:54005e76acf3876772e53dd38e6d000df4c46938de210c683760697197d77bc4"
  "deploy/scripts/bot-errors-q-loop.py:de61c690343d334b508d2852bb5dca4558f2f26796bf355af3d582a1c6bba50a"
  "src/lib/bot-errors-outbox.ts:2c411584ecc40e6d92e9de113f9e3186b5ea9b1da85bdbc2da87ad731c652d3d"
  "deploy/scripts/bot-errors-collector.py:8d83e03b11ecedcb511caf27742a15d53b7a5ca70a9af4db6e3d2f25f2e8ea33"
  "deploy/scripts/bot-errors-emit.py:bcac5e797a7bf421e8f98f9991b5fc7ff8fc1712f8b77ffbdb1dacc00bb38bad"
  "deploy/scripts/bot-errors-runner.py:f189971ec512b39901c1dbbe2c14de7b1c0fa663008f33fb05d3fc794347b030"
  "deploy/scripts/lib/__init__.py:438146338f7ceac8c0ecda8d7c6a7fb13fe88a0749bad1accf39ad92e4370da0"
  "deploy/scripts/lib/bot_errors_redaction.py:9ca62e79bdebbd7767275a91dc3b6a764a18651391dc242d19d3a94eef79a97d"
  "deploy/scripts/lib/bot_errors_daily_health.py:45b9b3e23ffda454a8315c1ec80ffc81c691e8ef37f3b20cb3386eaaa2af5bea"
)

sha() {
  local out rc
  if command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$1" 2>/dev/null)"; rc=$?
  else
    out="$(sha256sum "$1" 2>/dev/null)"; rc=$?
  fi
  if [[ $rc -ne 0 || -z "$out" ]]; then printf 'SHA_FAILED\n'; return 1; fi
  printf '%s\n' "${out%% *}"
}

assert_no_symlink_path() {
  local root="$1" rel="$2" cur i
  cur="$root"
  local parts=()
  IFS='/' read -r -a parts <<< "$rel"
  for ((i=0; i<${#parts[@]}; i++)); do
    cur="$cur/${parts[$i]}"
    if [[ -L "$cur" ]]; then echo "  SYMLINK  $rel via $cur"; return 1; fi
    if (( i < ${#parts[@]} - 1 )) && [[ -e "$cur" && ! -d "$cur" ]]; then
      echo "  NOTDIR   $rel via $cur"; return 1
    fi
  done
}

do_verify() {
  local fail=0 r="$1"
  for entry in "${FILES[@]}"; do
    local path="${entry%%:*}" want="${entry##*:}" f="$r/${entry%%:*}"
    if ! assert_no_symlink_path "$r" "$path"; then fail=1; continue; fi
    if [[ ! -f "$f" ]]; then echo "  MISSING  $path"; fail=1; continue; fi
    local got got_rc
    got="$(sha "$f")"; got_rc=$?
    if [[ $got_rc -ne 0 || "$got" == "SHA_FAILED" ]]; then
      echo "  SHA_ERROR $path"; fail=1
    elif [[ "$got" == "$want" ]]; then
      echo "  MATCH    $path"
    else
      echo "  DRIFT    $path got=${got:0:12}"; fail=1
    fi
  done
  return $fail
}

smoke_redaction() {
  # Prove the deployed F10 module actually redacts an authorization-assignment secret.
  local r="$1"
  python3 - "$r" <<'PY'
import sys, os
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "deploy", "scripts"))
from lib.bot_errors_redaction import redact_bot_errors_text
probe = "authorization: super-secret-token-XYZ123"
out = redact_bot_errors_text(probe, credential_path_marker="[REDACTED PATH]")
assert "super-secret-token-XYZ123" not in out, f"LEAK: secret survived redaction -> {out!r}"
assert "REDACTED" in out.upper() or out != probe, f"no redaction applied -> {out!r}"
print("  SMOKE    redaction ok (secret removed)")
PY
}

last_known_good_pointer_for_root() {
  local root="$1" root_parent root_base safe_root_base
  root_parent="$(cd "$(dirname "$root")" && pwd -P)" || { echo "FATAL: root parent unavailable"; return 3; }
  root_base="$(basename "$root")"
  safe_root_base="${root_base//[^A-Za-z0-9._-]/_}"
  printf '%s/.bot-errors-last-known-good-%s\n' "$root_parent" "$safe_root_base"
}

derive_head_sha() {
  local staging="$1" resolved base
  if resolved="$(cd "$staging" 2>/dev/null && pwd -P)"; then
    base="$(basename "$resolved")"
    if [[ "$base" =~ ^[0-9a-f]{40}$ ]]; then
      printf '%s\n' "$base"
      return 0
    fi
  fi
  printf 'unknown\n'
}

write_backup_metadata() {
  local bkdir="$1" root="$2" staging="$3" head_sha="$4" backup_verified="$5" created_at="$6"
  local head_json head_source verified_json
  if [[ "$head_sha" == "unknown" ]]; then head_json="null"; head_source="unknown"; else head_json="$(json_string "$head_sha")"; head_source="staging_dir_basename"; fi
  if [[ "$backup_verified" == "1" ]]; then verified_json="true"; else verified_json="false"; fi
  {
    printf '{\n'
    printf '  "backup": %s,\n' "$(json_string "$bkdir")"
    printf '  "backupVerified": %s,\n' "$verified_json"
    printf '  "createdAt": %s,\n' "$(json_string "$created_at")"
    printf '  "headSha": %s,\n' "$head_json"
    printf '  "headShaSource": %s,\n' "$(json_string "$head_source")"
    printf '  "root": %s,\n' "$(json_string "$root")"
    printf '  "schemaVersion": 1,\n'
    printf '  "staging": %s\n' "$(json_string "$staging")"
    printf '}\n'
  } > "$bkdir/.bot-errors-backup.json"
}

json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '"%s"' "$value"
}

write_last_known_good_pointer() {
  local pointer="$1" bkdir="$2" tmp
  tmp="$pointer.$$"
  printf '%s\n' "$bkdir" > "$tmp"
  mv -f "$tmp" "$pointer"
}

is_managed_path() {
  local candidate="$1" entry path
  for entry in "${FILES[@]}"; do
    path="${entry%%:*}"
    [[ "$candidate" == "$path" ]] && return 0
  done
  return 1
}

require_backup_dir() {
  local root="$1" bkdir="$2" root_parent root_abs backup_abs absent_path entry local_path
  [ -n "$bkdir" ] || { echo "FATAL: backup dir missing"; return 3; }
  [ -d "$bkdir" ] || { echo "FATAL: backup dir not found: $bkdir"; return 3; }
  [ -f "$bkdir/.was-absent" ] || { echo "FATAL: backup missing .was-absent ledger: $bkdir"; return 3; }
  [ ! -L "$bkdir/.was-absent" ] || { echo "FATAL: backup .was-absent ledger is unsafe: $bkdir"; return 3; }
  root_parent="$(cd "$(dirname "$root")" && pwd -P)" || { echo "FATAL: root parent unavailable"; return 3; }
  root_abs="$root_parent/$(basename "$root")"
  backup_abs="$(cd "$bkdir" && pwd -P)" || { echo "FATAL: backup dir unavailable: $bkdir"; return 3; }
  case "$backup_abs" in
    "$root_abs"|"$root_abs"/*) echo "FATAL: backup is inside runtime root: $backup_abs"; return 3 ;;
  esac
  while IFS= read -r absent_path || [[ -n "$absent_path" ]]; do
    [[ -z "$absent_path" ]] && continue
    is_managed_path "$absent_path" || { echo "FATAL: backup .was-absent contains unmanaged path: $absent_path"; return 3; }
  done < "$bkdir/.was-absent"
  for entry in "${FILES[@]}"; do
    local_path="${entry%%:*}"
    assert_no_symlink_path "$bkdir" "$local_path" || { echo "FATAL: backup path is unsafe"; return 3; }
  done
}

prune_backup_dir() {
  local root_parent="$1" safe_root_base="$2" dir="$3" dir_parent base
  dir_parent="$(cd "$(dirname "$dir")" && pwd -P)" || return 1
  [ "$dir_parent" = "$root_parent" ] || return 1
  base="$(basename "$dir")"
  case "$base" in
    ".bot-errors-deploy-backup-${safe_root_base}-"*) ;;
    *) return 1 ;;
  esac
  [ -f "$dir/.was-absent" ] || return 1
  [ -f "$dir/.bot-errors-backup.json" ] || return 1
  rm -rf "$dir"
}

prune_verified_backups() {
  local root_parent="$1" safe_root_base="$2" lkg_pointer="$3"
  local retention_raw="${BOT_ERRORS_DEPLOY_BACKUP_RETENTION:-8}" limit lkg="" kept=0 pruned=0 dir
  if ! [[ "$retention_raw" =~ ^[0-9]+$ ]] || (( retention_raw < 1 )); then
    echo "BACKUP_RETENTION_SKIPPED=invalid_limit"
    return 0
  fi
  limit="$retention_raw"
  if [[ -f "$lkg_pointer" ]]; then IFS= read -r lkg < "$lkg_pointer" || lkg=""; fi
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    [ -d "$dir" ] || continue
    [ -f "$dir/.was-absent" ] || continue
    [ -f "$dir/.bot-errors-backup.json" ] || continue
    kept=$((kept + 1))
    if (( kept <= limit )); then continue; fi
    if [[ -n "$lkg" && "$dir" == "$lkg" ]]; then continue; fi
    if prune_backup_dir "$root_parent" "$safe_root_base" "$dir"; then pruned=$((pruned + 1)); fi
  done < <(find "$root_parent" -maxdepth 1 -type d -name ".bot-errors-deploy-backup-${safe_root_base}-*" -print | sort -r)
  echo "BACKUP_RETENTION_LIMIT=$limit"
  echo "BACKUP_RETENTION_PRUNED=$pruned"
}

case "$MODE" in
  deploy)
    STAGING="${3:?missing <staging-dir>}"
    STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ROOT_PARENT="$(cd "$(dirname "$ROOT")" && pwd -P)" || { echo "FATAL: root parent unavailable"; exit 3; }
    ROOT_BASE="$(basename "$ROOT")"
    SAFE_ROOT_BASE="${ROOT_BASE//[^A-Za-z0-9._-]/_}"
    BKDIR="$ROOT_PARENT/.bot-errors-deploy-backup-${SAFE_ROOT_BASE}-$STAMP-$$"
    LKG_POINTER="$(last_known_good_pointer_for_root "$ROOT")" || exit 3
    HEAD_SHA="$(derive_head_sha "$STAGING")"
    echo "ROOT=$ROOT"; echo "STAGING=$STAGING"; echo "BACKUP=$BKDIR"; echo "HEAD_SHA=$HEAD_SHA"
    # 0) sanity: staging is complete + matches expected shas (don't deploy a bad packet)
    echo "== staging integrity =="; do_verify "$STAGING" || { echo "FATAL: staging incomplete/mismatched"; exit 3; }
    echo "== target safety =="
    for entry in "${FILES[@]}"; do
      local_path="${entry%%:*}"
      assert_no_symlink_path "$ROOT" "$local_path" || { echo "FATAL: target path is unsafe"; exit 3; }
    done
    # 1) backup EVERY target path that exists (record absentees for rollback-delete)
    mkdir -p "$BKDIR"; : > "$BKDIR/.was-absent"
    for entry in "${FILES[@]}"; do
      local_path="${entry%%:*}"; src="$ROOT/$local_path"
      if [[ -f "$src" ]]; then mkdir -p "$BKDIR/$(dirname "$local_path")"; cp -p "$src" "$BKDIR/$local_path";
      else echo "$local_path" >> "$BKDIR/.was-absent"; fi
    done
    if do_verify "$BKDIR" > "$BKDIR/.bot-errors-backup-verify.log" 2>&1 && smoke_redaction "$BKDIR" >> "$BKDIR/.bot-errors-backup-verify.log" 2>&1; then
      BACKUP_VERIFIED=1
    else
      BACKUP_VERIFIED=0
    fi
    write_backup_metadata "$BKDIR" "$ROOT" "$STAGING" "$HEAD_SHA" "$BACKUP_VERIFIED" "$CREATED_AT"
    echo "== backup complete =="
    echo "BACKUP_VERIFIED=$BACKUP_VERIFIED"
    if [[ "$BACKUP_VERIFIED" == "1" ]]; then
      write_last_known_good_pointer "$LKG_POINTER" "$BKDIR"
      echo "LAST_KNOWN_GOOD_POINTER=$LKG_POINTER"
      echo "LAST_KNOWN_GOOD=$BKDIR"
    else
      echo "LAST_KNOWN_GOOD_SKIPPED=backup_not_clean"
    fi
    # 2) materialize from staging
    for entry in "${FILES[@]}"; do
      local_path="${entry%%:*}"; dst="$ROOT/$local_path"
      mkdir -p "$(dirname "$dst")"; cp -p "$STAGING/$local_path" "$dst"
    done
    echo "== materialized =="
    # 3) fail-closed verify + redaction smoke; auto-rollback on failure
    if do_verify "$ROOT" && smoke_redaction "$ROOT"; then
      if [[ "$BACKUP_VERIFIED" == "1" ]]; then prune_verified_backups "$ROOT_PARENT" "$SAFE_ROOT_BASE" "$LKG_POINTER"; fi
      echo "DEPLOY_OK backup=$BKDIR"
    else
      echo "VERIFY_FAILED -> auto-rollback"; bash "$0" rollback "$ROOT" "$BKDIR"; echo "DEPLOY_FAILED_ROLLED_BACK"; exit 4
    fi
    ;;
  verify)
    echo "== verify $ROOT =="; do_verify "$ROOT" && smoke_redaction "$ROOT" && echo "VERIFY_OK" || { echo "VERIFY_FAIL"; exit 1; }
    ;;
  rollback)
    BKDIR="${3:?missing <backup-dir>}"
    require_backup_dir "$ROOT" "$BKDIR" || exit 3
    echo "== rollback $ROOT from $BKDIR =="
    echo "== rollback target safety =="
    for entry in "${FILES[@]}"; do
      local_path="${entry%%:*}"
      assert_no_symlink_path "$ROOT" "$local_path" || { echo "FATAL: target path is unsafe"; exit 3; }
    done
    for entry in "${FILES[@]}"; do
      local_path="${entry%%:*}"
      if [[ -f "$BKDIR/$local_path" ]]; then mkdir -p "$(dirname "$ROOT/$local_path")"; cp -p "$BKDIR/$local_path" "$ROOT/$local_path"; fi
    done
    # delete files that were absent before deploy
    if [[ -f "$BKDIR/.was-absent" ]]; then
      while IFS= read -r p; do [[ -n "$p" ]] && rm -f "$ROOT/$p"; done < "$BKDIR/.was-absent"
    fi
    echo "ROLLBACK_OK"
    ;;
  rollback-lkg)
    LKG_POINTER="$(last_known_good_pointer_for_root "$ROOT")" || exit 3
    [ -f "$LKG_POINTER" ] || { echo "FATAL: last_known_good pointer missing: $LKG_POINTER"; exit 3; }
    IFS= read -r BKDIR < "$LKG_POINTER" || { echo "FATAL: cannot read last_known_good pointer: $LKG_POINTER"; exit 3; }
    require_backup_dir "$ROOT" "$BKDIR" || exit 3
    echo "== rollback last_known_good $ROOT from $BKDIR =="
    echo "LAST_KNOWN_GOOD_POINTER=$LKG_POINTER"
    if do_verify "$BKDIR" && smoke_redaction "$BKDIR"; then
      bash "$0" rollback "$ROOT" "$BKDIR"
      do_verify "$ROOT" && smoke_redaction "$ROOT" && echo "ROLLBACK_LKG_OK backup=$BKDIR" || { echo "ROLLBACK_LKG_VERIFY_FAIL"; exit 4; }
    else
      echo "FATAL: last_known_good backup does not verify clean: $BKDIR"
      exit 3
    fi
    ;;
  pin)
    # pin <manifest.json> <ledger.json> <head_sha>: stamp expected_head_sha + append F10 to the approved ledger.
    MAN="${2:?manifest}"; LEDGER="${3:?ledger}"; HEAD="${4:?head_sha}"
    [[ "$HEAD" =~ ^[0-9a-f]{40}$ ]] || { echo "FATAL: head_sha must be lowercase 40-char git sha"; exit 3; }
    python3 - "$MAN" "$LEDGER" "$HEAD" <<'PY'
import json
import os
import sys
import tempfile

F10_PATH = "deploy/scripts/lib/bot_errors_redaction.py"
HEX = set("0123456789abcdef")


def fatal(message):
    print(f"FATAL: {message}", file=sys.stderr)
    raise SystemExit(3)


def load_object(path, label):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        fatal(f"cannot load {label}: {type(exc).__name__}: {exc}")
    if not isinstance(data, dict):
        fatal(f"{label} must be a JSON object")
    return data


def is_lower_hex(value, length):
    return isinstance(value, str) and len(value) == length and all(ch in HEX for ch in value)


def atomic_write_json(path, payload):
    directory = os.path.dirname(os.path.abspath(path)) or "."
    basename = os.path.basename(path)
    fd, tmp = tempfile.mkstemp(prefix=f".{basename}.", suffix=".tmp", dir=directory, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        try:
            dir_fd = os.open(directory, os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


man_p, led_p, head = sys.argv[1:4]
if os.path.abspath(man_p) == os.path.abspath(led_p):
    fatal("manifest and ledger paths must be distinct")
manifest = load_object(man_p, "manifest")
if manifest.get("schemaVersion") != 1:
    fatal("manifest schemaVersion must be 1")
files = manifest.get("files")
if not isinstance(files, list):
    fatal("manifest files must be a list")
f10 = next((item.get("sha256", "") for item in files if isinstance(item, dict) and item.get("path") == F10_PATH), "")
if not f10:
    fatal("no F10 in manifest")
if not is_lower_hex(f10, 64):
    fatal("F10 sha must be lowercase sha256")
ledger = load_object(led_p, "ledger")
approved = ledger.get("approved_f10")
if approved is None:
    approved = []
elif not isinstance(approved, list):
    fatal("ledger approved_f10 must be a list")
for index, value in enumerate(approved):
    if not is_lower_hex(value, 64):
        fatal(f"ledger approved_f10[{index}] must be lowercase sha256")
if f10 not in approved:
    approved.append(f10)
ledger["approved_f10"] = approved
approved_heads = ledger.get("approved_heads")
if approved_heads is None:
    approved_heads = []
elif not isinstance(approved_heads, list):
    fatal("ledger approved_heads must be a list")
for index, value in enumerate(approved_heads):
    if not is_lower_hex(value, 40):
        fatal(f"ledger approved_heads[{index}] must be lowercase git sha")
if head not in approved_heads:
    approved_heads.append(head)
ledger["approved_heads"] = approved_heads
manifest["expected_head_sha"] = head
atomic_write_json(led_p, ledger)
atomic_write_json(man_p, manifest)
print(f"PIN_OK head={head} f10={f10[:12]}")
PY
    ;;
  *) echo "unknown mode $MODE"; exit 2;;
esac
