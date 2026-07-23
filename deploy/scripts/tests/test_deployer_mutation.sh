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

copy_manifest_files() {
  local from="$1" to="$2" rel
  rm -rf "$to"
  mkdir -p "$to"
  while IFS= read -r rel; do
    mkdir -p "$to/$(dirname "$rel")"
    cp -p "$from/$rel" "$to/$rel"
  done < "$files_list"
}

prepare_current_root() {
  copy_manifest_files "$PWD" "$1"
}

prepare_staging() {
  copy_manifest_files "$PWD" "$1"
}

backup_from_log() {
  local log="$1"
  awk -F= '/^BACKUP=/{print $2; exit}' "$log"
}

pointer_from_log() {
  local log="$1"
  awk -F= '/^LAST_KNOWN_GOOD_POINTER=/{print $2; exit}' "$log"
}

assert_backup_metadata() {
  local metadata="$1" expected_verified="$2" expected_head="$3"
  [ -f "$metadata" ] || fail "backup metadata missing: $metadata"
  python3 - "$metadata" "$expected_verified" "$expected_head" <<'PY' || fail "backup metadata mismatch: $metadata"
import json
import sys

path, expected_verified, expected_head = sys.argv[1:4]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
assert data["schemaVersion"] == 1
assert data["backupVerified"] is (expected_verified == "true")
if expected_head == "null":
    assert data["headSha"] is None
    assert data["headShaSource"] == "unknown"
else:
    assert data["headSha"] == expected_head
    assert data["headShaSource"] == "staging_dir_basename"
PY
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
grep -q "BACKUP_VERIFIED=0" "$tmp/deploy.log" || { cat "$tmp/deploy.log"; fail "drifted pre-deploy backup was not marked unverified"; }
grep -q "LAST_KNOWN_GOOD_SKIPPED=backup_not_clean" "$tmp/deploy.log" || { cat "$tmp/deploy.log"; fail "unclean backup updated last_known_good"; }
[ ! -e "$tmp/.bot-errors-last-known-good-runtime" ] || fail "unclean backup created last_known_good pointer"
assert_backup_metadata "$backup/.bot-errors-backup.json" false null
bash "$D" verify "$root" > "$tmp/verify.log" 2>&1 || { cat "$tmp/verify.log"; fail "deployed root did not verify"; }

bash "$D" rollback "$root" "$backup" > "$tmp/rollback.log" 2>&1
grep -q "ROLLBACK_OK" "$tmp/rollback.log" || { cat "$tmp/rollback.log"; fail "rollback did not report ROLLBACK_OK"; }
grep -q "old:deploy/scripts/bot-errors-emit.py" "$root/deploy/scripts/bot-errors-emit.py" || fail "rollback did not restore old bytes"
[ ! -e "$root/deploy/scripts/bot-errors-runner.py" ] || fail "rollback did not delete pre-deploy absent file"

stage_sha=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
staging="$tmp/$stage_sha"
prepare_staging "$staging"
clean_root="$tmp/clean-runtime"
prepare_current_root "$clean_root"
bash "$D" deploy "$clean_root" "$staging" > "$tmp/clean-deploy.log" 2>&1
grep -q "DEPLOY_OK" "$tmp/clean-deploy.log" || { cat "$tmp/clean-deploy.log"; fail "clean deploy did not report DEPLOY_OK"; }
clean_backup=$(backup_from_log "$tmp/clean-deploy.log")
assert_backup_outside_root "$clean_root" "$clean_backup"
grep -q "BACKUP_VERIFIED=1" "$tmp/clean-deploy.log" || { cat "$tmp/clean-deploy.log"; fail "clean backup was not verified"; }
clean_pointer=$(pointer_from_log "$tmp/clean-deploy.log")
[ -f "$clean_pointer" ] || fail "last_known_good pointer missing: $clean_pointer"
IFS= read -r pointed_backup < "$clean_pointer"
[ "$pointed_backup" = "$clean_backup" ] || fail "last_known_good pointer did not target verified backup"
assert_backup_metadata "$clean_backup/.bot-errors-backup.json" true "$stage_sha"
printf 'damaged\n' > "$clean_root/deploy/scripts/bot-errors-emit.py"
bash "$D" rollback-lkg "$clean_root" > "$tmp/rollback-lkg.log" 2>&1
grep -q "ROLLBACK_LKG_OK" "$tmp/rollback-lkg.log" || { cat "$tmp/rollback-lkg.log"; fail "rollback-lkg did not report ROLLBACK_LKG_OK"; }
bash "$D" verify "$clean_root" > "$tmp/verify-lkg.log" 2>&1 || { cat "$tmp/verify-lkg.log"; fail "rollback-lkg root did not verify"; }

retention_root="$tmp/retention-runtime"
prepare_current_root "$retention_root"
for run in 1 2 3; do
  BOT_ERRORS_DEPLOY_BACKUP_RETENTION=2 bash "$D" deploy "$retention_root" "$staging" > "$tmp/retention-$run.log" 2>&1
  grep -q "DEPLOY_OK" "$tmp/retention-$run.log" || { cat "$tmp/retention-$run.log"; fail "retention deploy $run did not report DEPLOY_OK"; }
  grep -q "BACKUP_RETENTION_LIMIT=2" "$tmp/retention-$run.log" || { cat "$tmp/retention-$run.log"; fail "retention limit was not reported"; }
done
retained_count=$(find "$tmp" -maxdepth 1 -type d -name '.bot-errors-deploy-backup-retention-runtime-*' -print | wc -l | tr -d ' ')
[ "$retained_count" = "2" ] || fail "retention kept $retained_count backups, expected 2"
retention_pointer="$tmp/.bot-errors-last-known-good-retention-runtime"
[ -f "$retention_pointer" ] || fail "retention last_known_good pointer missing"
IFS= read -r retention_lkg < "$retention_pointer"
[ -d "$retention_lkg" ] || fail "retention pruned last_known_good backup"
bash "$D" verify "$retention_root" > "$tmp/verify-retention.log" 2>&1 || { cat "$tmp/verify-retention.log"; fail "retention root did not verify"; }

missing_lkg_root="$tmp/missing-lkg-runtime"
prepare_current_root "$missing_lkg_root"
if bash "$D" rollback-lkg "$missing_lkg_root" > "$tmp/missing-lkg.log" 2>&1; then
  cat "$tmp/missing-lkg.log"
  fail "rollback-lkg unexpectedly succeeded without a pointer"
fi
grep -q "last_known_good pointer missing" "$tmp/missing-lkg.log" || {
  cat "$tmp/missing-lkg.log"
  fail "missing last_known_good pointer was not reported"
}

if bash "$D" rollback "$clean_root" "$tmp/not-a-backup" > "$tmp/missing-backup.log" 2>&1; then
  cat "$tmp/missing-backup.log"
  fail "rollback unexpectedly succeeded with a missing backup"
fi
grep -q "backup dir not found" "$tmp/missing-backup.log" || {
  cat "$tmp/missing-backup.log"
  fail "missing backup was not reported"
}

bad_absent_backup="$tmp/bad-absent-backup"
mkdir -p "$bad_absent_backup"
printf '../../outside-victim\n' > "$bad_absent_backup/.was-absent"
if bash "$D" rollback "$clean_root" "$bad_absent_backup" > "$tmp/bad-absent.log" 2>&1; then
  cat "$tmp/bad-absent.log"
  fail "rollback accepted unmanaged .was-absent path"
fi
grep -q "unmanaged path" "$tmp/bad-absent.log" || {
  cat "$tmp/bad-absent.log"
  fail "unmanaged .was-absent path was not reported"
}

bad_ledger_symlink_backup="$tmp/bad-ledger-symlink-backup"
mkdir -p "$bad_ledger_symlink_backup"
: > "$tmp/outside-was-absent"
ln -s "$tmp/outside-was-absent" "$bad_ledger_symlink_backup/.was-absent"
if bash "$D" rollback "$clean_root" "$bad_ledger_symlink_backup" > "$tmp/bad-ledger-symlink.log" 2>&1; then
  cat "$tmp/bad-ledger-symlink.log"
  fail "rollback accepted symlinked .was-absent ledger"
fi
grep -q ".was-absent ledger is unsafe" "$tmp/bad-ledger-symlink.log" || {
  cat "$tmp/bad-ledger-symlink.log"
  fail "symlinked .was-absent ledger was not reported"
}

bad_symlink_backup="$tmp/bad-symlink-backup"
mkdir -p "$bad_symlink_backup/deploy/scripts/lib"
: > "$bad_symlink_backup/.was-absent"
ln -s "$tmp/outside-source" "$bad_symlink_backup/deploy/scripts/lib/bot_errors_redaction.py"
if bash "$D" rollback "$clean_root" "$bad_symlink_backup" > "$tmp/bad-backup-symlink.log" 2>&1; then
  cat "$tmp/bad-backup-symlink.log"
  fail "rollback accepted symlinked backup path"
fi
grep -q "backup path is unsafe" "$tmp/bad-backup-symlink.log" || {
  cat "$tmp/bad-backup-symlink.log"
  fail "symlinked backup path was not reported"
}

fail_root="$tmp/fail-runtime"
prepare_old_root "$fail_root"
fakebin="$tmp/fakebin"
mkdir -p "$fakebin"
real_python3="$(command -v python3)"
# Only fail smoke_redaction's invocation (python3 - <root-dir> <<PY ... PY).
# resolve_managed_files() also calls python3 now (python3 - <manifest.json>
# <paths...> <<PY ... PY>) to resolve MANAGED_FILES from the runtime
# manifest -- that call must still succeed so deploy mode reaches its own
# smoke_redaction step and the auto-rollback path this test exercises,
# rather than failing earlier for an unrelated reason. Distinguished by the
# script's second argument: a manifest path (.json) vs. a root directory.
cat > "$fakebin/python3" <<SH
#!/usr/bin/env bash
if [[ "\$2" == *.json ]]; then
  exec "$real_python3" "\$@"
fi
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
grep -q "BACKUP_VERIFIED=0" "$tmp/fail-deploy.log" || { cat "$tmp/fail-deploy.log"; fail "smoke-failing deploy backup was not marked unverified"; }
assert_backup_metadata "$fail_backup/.bot-errors-backup.json" false null
grep -q "old:deploy/scripts/bot-errors-emit.py" "$fail_root/deploy/scripts/bot-errors-emit.py" || fail "auto-rollback did not restore old bytes"
[ ! -e "$fail_root/deploy/scripts/bot-errors-runner.py" ] || fail "auto-rollback did not delete pre-deploy absent file"

# SSOT collapse (pin-reconciliation debt fix): FILES=() no longer carries a
# hand-maintained sha256 -- expected hashes are resolved from
# deploy/bot-errors-runtime-manifest.json at startup via
# BOT_ERRORS_RUNTIME_MANIFEST_PATH (or the real manifest by default). Proves
# that resolution is a REAL enforcement, not a pass-through: a manifest
# entry deliberately mismatched against the actual file bytes must still
# fail closed, exactly like the old hardcoded pin did.
ssot_root="$tmp/ssot-runtime"
prepare_current_root "$ssot_root"
mismatch_manifest="$tmp/mismatch-manifest.json"
python3 - "$PWD/deploy/bot-errors-runtime-manifest.json" "$mismatch_manifest" <<'PY'
import json
import sys

src, dst = sys.argv[1:3]
with open(src, encoding="utf-8") as handle:
    data = json.load(handle)
for entry in data["files"]:
    if entry["path"] == "deploy/scripts/bot-errors-emit.py":
        entry["sha256"] = "f" * 64
with open(dst, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2)
PY
if BOT_ERRORS_RUNTIME_MANIFEST_PATH="$mismatch_manifest" bash "$D" verify "$ssot_root" > "$tmp/ssot-mismatch.log" 2>&1; then
  cat "$tmp/ssot-mismatch.log"
  fail "verify did not fail closed on a manifest-vs-file hash mismatch"
fi
grep -q "DRIFT.*bot-errors-emit.py" "$tmp/ssot-mismatch.log" || {
  cat "$tmp/ssot-mismatch.log"
  fail "manifest-vs-file mismatch was not reported as DRIFT"
}
# The real manifest (untouched by the above -- the override pointed at a
# disposable copy) must still verify this same root clean.
bash "$D" verify "$ssot_root" > "$tmp/ssot-clean.log" 2>&1 || {
  cat "$tmp/ssot-clean.log"
  fail "verify against the real manifest failed for an unmodified root"
}
grep -q "VERIFY_OK" "$tmp/ssot-clean.log" || {
  cat "$tmp/ssot-clean.log"
  fail "real-manifest verify did not report VERIFY_OK"
}
# The FILES=() array itself must no longer carry an embedded sha256 -- the
# only place a hash can appear now is the manifest this test just proved is
# authoritative.
if grep -qE '"[^"]+:[0-9a-f]{64}"' "$D"; then
  fail "FILES=() still embeds a hand-maintained sha256 -- SSOT collapse incomplete"
fi

echo "DEPLOYER_MUTATION_PASS"
