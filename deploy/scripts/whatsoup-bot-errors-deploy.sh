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
  "deploy/scripts/bot-errors-dispatcher.py:955cb984f9c5fbecaef893d9c94b1f309f0b306cfc5974fcdef9ba4bf3db8010"
  "deploy/scripts/bot-errors-health-check.py:8f12a71bd68ea239ccf27f973b4d45bc66042f35d8ecee19a75cb08e81af7f9d"
  "deploy/scripts/bot-errors-heartbeat-watchdog.py:166800cab559e33483c24fb976a8adeecbf58c1a8aea023acc27a596744f8f21"
  "deploy/scripts/bot-errors-q-loop.py:de61c690343d334b508d2852bb5dca4558f2f26796bf355af3d582a1c6bba50a"
  "src/lib/bot-errors-outbox.ts:67c7875e3672585e93a2c5221a816199fe08572efd582fff20c3aa787ee26b83"
  "deploy/scripts/bot-errors-collector.py:6cf38d47a856a14e63577f5b6904758ffa025b9ca5782c8f72d62612dd0a9e86"
  "deploy/scripts/bot-errors-emit.py:bb97461ae638d2fe395ca71cacc79dc804ca1e4c2b4e19540135978f1fef41ad"
  "deploy/scripts/bot-errors-runner.py:f189971ec512b39901c1dbbe2c14de7b1c0fa663008f33fb05d3fc794347b030"
  "deploy/scripts/lib/__init__.py:438146338f7ceac8c0ecda8d7c6a7fb13fe88a0749bad1accf39ad92e4370da0"
  "deploy/scripts/lib/bot_errors_redaction.py:1448da21ae9b598d4cafb342fc1c7aa042141ec3db7fee11c8ff1368cf94812f"
)

sha() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; else sha256sum "$1" 2>/dev/null | awk '{print $1}'; fi; }

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
    local got; got="$(sha "$f")"
    if [[ "$got" == "$want" ]]; then echo "  MATCH    $path"; else echo "  DRIFT    $path got=${got:0:12}"; fail=1; fi
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

require_backup_dir() {
  local root="$1" bkdir="$2" root_parent root_abs backup_abs
  [ -n "$bkdir" ] || { echo "FATAL: backup dir missing"; return 3; }
  [ -d "$bkdir" ] || { echo "FATAL: backup dir not found: $bkdir"; return 3; }
  [ -f "$bkdir/.was-absent" ] || { echo "FATAL: backup missing .was-absent ledger: $bkdir"; return 3; }
  root_parent="$(cd "$(dirname "$root")" && pwd -P)" || { echo "FATAL: root parent unavailable"; return 3; }
  root_abs="$root_parent/$(basename "$root")"
  backup_abs="$(cd "$bkdir" && pwd -P)" || { echo "FATAL: backup dir unavailable: $bkdir"; return 3; }
  case "$backup_abs" in
    "$root_abs"|"$root_abs"/*) echo "FATAL: backup is inside runtime root: $backup_abs"; return 3 ;;
  esac
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
    f10=$(python3 - "$MAN" <<'PY'
import json,sys
F10_PATH = "deploy/scripts/lib/bot_errors_redaction.py"
d=json.load(open(sys.argv[1]))
files=d.get("files",[])
print(next((f.get("sha256", "") for f in files if isinstance(f, dict) and f.get("path") == F10_PATH), ""))
PY
)
    [ -n "$f10" ] || { echo "FATAL: no F10 in manifest"; exit 3; }
    [[ "$f10" =~ ^[0-9a-f]{64}$ ]] || { echo "FATAL: F10 sha must be lowercase sha256"; exit 3; }
    python3 - "$MAN" "$LEDGER" "$HEAD" "$f10" <<'PY'
import json,sys
man_p,led_p,head,f10=sys.argv[1:5]
with open(man_p) as fh: m=json.load(fh)
m["expected_head_sha"]=head
with open(man_p,"w") as fh: json.dump(m,fh,indent=2)
with open(led_p) as fh: l=json.load(fh)
a=l.setdefault("approved_f10",[])
if f10 not in a: a.append(f10)
with open(led_p,"w") as fh: json.dump(l,fh,indent=2)
PY
    echo "PIN_OK head=$HEAD f10=${f10:0:12}"
    ;;
  *) echo "unknown mode $MODE"; exit 2;;
esac
