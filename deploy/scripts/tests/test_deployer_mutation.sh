#!/usr/bin/env bash
set -euo pipefail

D=deploy/scripts/whatsoup-bot-errors-deploy.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "DEPLOYER_MUTATION_FAIL: $*"
  exit 1
}

files_list="$tmp/files.txt"
python3 - "$D" > "$files_list" <<'PY'
import sys

inside = False
for line in open(sys.argv[1], encoding="utf-8"):
    stripped = line.strip()
    if stripped == "FILES=(":
        inside = True
        continue
    if inside and stripped == ")":
        break
    if inside and stripped.startswith('"') and stripped.endswith('"'):
        print(stripped.strip('"').split(":", 1)[0])
PY

prepare_old_root() {
  local root="$1"
  rm -rf "$root"
  mkdir -p "$root"
  while IFS= read -r rel; do
    mkdir -p "$root/$(dirname "$rel")"
    printf 'old:%s\n' "$rel" > "$root/$rel"
  done < "$files_list"
  rm -f "$root/deploy/scripts/bot-errors-runner.py"
}

backup_from_log() {
  local log="$1"
  awk -F= '/^BACKUP=/{print $2; exit}' "$log"
}

assert_backup_outside_root() {
  local root="$1" backup="$2"
  [ -n "$backup" ] || fail "backup path missing"
  [ -d "$backup" ] || fail "backup dir missing: $backup"
  case "$backup" in
    "$root"|"$root"/*) fail "backup is inside runtime root: $backup" ;;
  esac
  inside_count=$(find "$root" -maxdepth 1 -name '.bot-errors-deploy-backup-*' -print | wc -l | tr -d ' ')
  [ "$inside_count" = "0" ] || fail "backup marker was created inside runtime root"
}

root="$tmp/runtime"
prepare_old_root "$root"

bash "$D" deploy "$root" "$PWD" > "$tmp/deploy.log" 2>&1
grep -q "DEPLOY_OK" "$tmp/deploy.log" || { cat "$tmp/deploy.log"; fail "deploy did not report DEPLOY_OK"; }
backup=$(backup_from_log "$tmp/deploy.log")
assert_backup_outside_root "$root" "$backup"
bash "$D" verify "$root" > "$tmp/verify.log" 2>&1 || { cat "$tmp/verify.log"; fail "deployed root did not verify"; }

bash "$D" rollback "$root" "$backup" > "$tmp/rollback.log" 2>&1
grep -q "ROLLBACK_OK" "$tmp/rollback.log" || { cat "$tmp/rollback.log"; fail "rollback did not report ROLLBACK_OK"; }
grep -q "old:deploy/scripts/bot-errors-emit.py" "$root/deploy/scripts/bot-errors-emit.py" || fail "rollback did not restore old bytes"
[ ! -e "$root/deploy/scripts/bot-errors-runner.py" ] || fail "rollback did not delete pre-deploy absent file"

fail_root="$tmp/fail-runtime"
prepare_old_root "$fail_root"
fakebin="$tmp/fakebin"
mkdir -p "$fakebin"
cat > "$fakebin/python3" <<'SH'
#!/usr/bin/env bash
echo "fake python smoke failure" >&2
exit 9
SH
chmod +x "$fakebin/python3"

if PATH="$fakebin:$PATH" bash "$D" deploy "$fail_root" "$PWD" > "$tmp/fail-deploy.log" 2>&1; then
  cat "$tmp/fail-deploy.log"
  fail "smoke-failing deploy unexpectedly succeeded"
fi
grep -q "DEPLOY_FAILED_ROLLED_BACK" "$tmp/fail-deploy.log" || {
  cat "$tmp/fail-deploy.log"
  fail "smoke-failing deploy did not auto-rollback"
}
fail_backup=$(backup_from_log "$tmp/fail-deploy.log")
assert_backup_outside_root "$fail_root" "$fail_backup"
grep -q "old:deploy/scripts/bot-errors-emit.py" "$fail_root/deploy/scripts/bot-errors-emit.py" || fail "auto-rollback did not restore old bytes"
[ ! -e "$fail_root/deploy/scripts/bot-errors-runner.py" ] || fail "auto-rollback did not delete pre-deploy absent file"

echo "DEPLOYER_MUTATION_PASS"
