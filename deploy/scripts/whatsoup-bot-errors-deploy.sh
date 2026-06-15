#!/usr/bin/env bash
# whatsoup-bot-errors-deploy.sh — reversible materialize of the 10 bot-errors runtime
# files (pinned to current origin/main content) into a host's TRUE bot-errors root.
#
#   deploy:   whatsoup-bot-errors-deploy.sh deploy   <root> <staging-dir>
#   verify:   whatsoup-bot-errors-deploy.sh verify   <root>
#   rollback: whatsoup-bot-errors-deploy.sh rollback <root> <backup-dir>
#   pin:      whatsoup-bot-errors-deploy.sh pin      <manifest.json> <ledger.json> <head_sha>
#
# Fail-closed: any sha mismatch or smoke failure exits non-zero. Backup is taken BEFORE
# any write so rollback is always possible. Does NOT touch git, restart services, or
# write outside <root>. Restart of com.bot-errors.* units is a separate, explicit step.
set -euo pipefail

MODE="${1:?usage: deploy|verify|rollback ...}"
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

do_verify() {
  local fail=0 r="$1"
  for entry in "${FILES[@]}"; do
    local path="${entry%%:*}" want="${entry##*:}" f="$r/${entry%%:*}"
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

case "$MODE" in
  deploy)
    STAGING="${3:?missing <staging-dir>}"
    STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    BKDIR="$ROOT/.bot-errors-deploy-backup-$STAMP"
    echo "ROOT=$ROOT"; echo "STAGING=$STAGING"; echo "BACKUP=$BKDIR"
    # 0) sanity: staging is complete + matches expected shas (don't deploy a bad packet)
    echo "== staging integrity =="; do_verify "$STAGING" || { echo "FATAL: staging incomplete/mismatched"; exit 3; }
    # 1) backup EVERY target path that exists (record absentees for rollback-delete)
    mkdir -p "$BKDIR"; : > "$BKDIR/.was-absent"
    for entry in "${FILES[@]}"; do
      local_path="${entry%%:*}"; src="$ROOT/$local_path"
      if [[ -f "$src" ]]; then mkdir -p "$BKDIR/$(dirname "$local_path")"; cp -p "$src" "$BKDIR/$local_path";
      else echo "$local_path" >> "$BKDIR/.was-absent"; fi
    done
    echo "== backup complete =="
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
    echo "== rollback $ROOT from $BKDIR =="
    for entry in "${FILES[@]}"; do
      local_path="${entry%%:*}"
      if [[ -f "$BKDIR/$local_path" ]]; then cp -p "$BKDIR/$local_path" "$ROOT/$local_path"; fi
    done
    # delete files that were absent before deploy
    if [[ -f "$BKDIR/.was-absent" ]]; then
      while IFS= read -r p; do [[ -n "$p" ]] && rm -f "$ROOT/$p"; done < "$BKDIR/.was-absent"
    fi
    echo "ROLLBACK_OK"
    ;;
  pin)
    # pin <manifest.json> <ledger.json> <head_sha>: stamp expected_head_sha + append F10 to the approved ledger.
    MAN="${2:?manifest}"; LEDGER="${3:?ledger}"; HEAD="${4:?head_sha}"
    f10=$(python3 - "$MAN" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(next((f["sha256"] for f in d.get("files",[]) if f["path"].endswith("lib/bot_errors_redaction.py")), ""))
PY
)
    [ -n "$f10" ] || { echo "FATAL: no F10 in manifest"; exit 3; }
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
