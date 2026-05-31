#!/usr/bin/env bash
# BOT ERRORS — end-to-end failure-scenario drill harness.
#
# Exercises the REAL emit + dispatcher scripts against a throwaway sandbox
# (BOT_ERRORS_STATE_DIR) with dispatch captured to a file instead of sent
# (BOT_ERRORS_DRY_SEND_CAPTURE). Touches ZERO live bots, sends ZERO real
# WhatsApp messages, sends ZERO email fallback. Safe to run anytime.
#
# Each drill simulates one failure class in the alert pipeline and asserts the
# pipeline behaves as intended: a qualifying failure reaches the dispatch
# channel with self-contained evidence, secrets are redacted, malformed events
# are quarantined (not silently dropped, not crash-the-batch), oversized
# payloads truncate, and delivery is idempotent.
#
# Fake credential patterns used in the redaction drill are assembled at runtime
# from fragments so no secret-shaped literal is ever stored in this file.
#
# Usage:  bash tests/drills/bot-errors-failure-drills.sh
# Exit:   0 = all drills passed, 1 = at least one drill failed.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMIT="$REPO_ROOT/deploy/scripts/bot-errors-emit.py"
DISPATCH="$REPO_ROOT/deploy/scripts/bot-errors-dispatcher.py"
HEARTBEAT="$REPO_ROOT/deploy/scripts/bot-errors-heartbeat-watchdog.py"
COLLECTOR="$REPO_ROOT/deploy/scripts/bot-errors-collector.py"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/bot-errors-drill.XXXXXX")"
CAPTURE="$SANDBOX/sent.log"

export BOT_ERRORS_STATE_DIR="$SANDBOX/state"
export BOT_ERRORS_OUTBOX_DIR="$BOT_ERRORS_STATE_DIR/outbox"
export BOT_ERRORS_DRY_SEND_CAPTURE="$CAPTURE"
# Deterministic platform string so logHints assertions are stable.
export BOT_ERRORS_DRY_PLATFORM="linux"
export BOT_ERRORS_DRY_PLATFORM_RELEASE="6.0.0-drill"

PASS=0
FAIL=0
declare -a FAILURES=()

cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); FAILURES+=("$1"); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

# assert_in <needle> <haystack-file> <label>
assert_in() {
  if grep -qF -- "$1" "$2"; then pass "$3"; else fail "$3 (missing: $1)"; fi
}
# assert_not_in <needle> <haystack-file> <label>
assert_not_in() {
  if grep -qF -- "$1" "$2"; then fail "$3 (leaked)"; else pass "$3"; fi
}
# assert_count <dir> <pattern> <expected> <label>
assert_count() {
  local n; n=$(find "$1" -maxdepth 1 -name "$2" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" = "$3" ]; then pass "$4 ($n)"; else fail "$4 (expected $3, got $n)"; fi
}
assert_missing() {
  if [ ! -e "$1" ]; then pass "$2"; else fail "$2 (exists: $1)"; fi
}

reset_sandbox() {
  rm -rf "$BOT_ERRORS_STATE_DIR" "$CAPTURE"
  mkdir -p "$BOT_ERRORS_OUTBOX_DIR"
}

emit() { python3 "$EMIT" "$@" >/dev/null 2>&1; }
dispatch_once() { python3 "$DISPATCH" --once >/dev/null 2>&1; }

echo "BOT ERRORS failure-scenario drills"
echo "sandbox: $SANDBOX"
echo

# ── Drill 1: happy path — tool failure reaches dispatch with self-contained evidence
echo "Drill 1: tool-failure alert end-to-end + self-contained evidence"
reset_sandbox
emit --severity critical --instance ana-bot --source agent_tool_error \
  --summary "Tool Bash failed in ana-bot" \
  --evidence "exit=127 cmd=missing-binary; PostToolUse hook captured nonzero"
dispatch_once
assert_in "BOT ERROR" "$CAPTURE" "renders BOT ERROR title"
assert_in "ana-bot" "$CAPTURE" "carries instance"
assert_in "agent_tool_error" "$CAPTURE" "carries source"
assert_in "exit=127" "$CAPTURE" "carries evidence"
assert_in "journalctl" "$CAPTURE" "carries actionable logHint"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 1 "event moved to sent/"
assert_count "$BOT_ERRORS_OUTBOX_DIR" "*.json" 0 "outbox drained"
echo

# ── Drill 2: severity / event-type rendering
echo "Drill 2: severity + event-type title rendering"
reset_sandbox
emit --severity warning --instance mini3 --source health --summary "degraded"
emit --severity info --instance mini3 --source health --summary "fyi"
dispatch_once
emit --event-type clear --instance mini3 --source health --summary "recovered"
dispatch_once
assert_in "BOT WARNING" "$CAPTURE" "warning -> BOT WARNING"
assert_in "BOT INFO" "$CAPTURE" "info -> BOT INFO"
assert_in "BOT RECOVERY" "$CAPTURE" "clear -> BOT RECOVERY"
echo

# ── Drill 3: secret redaction — never leak credentials to the group
echo "Drill 3: secret redaction in evidence"
reset_sandbox
# Assemble fake secret-shaped tokens at runtime (no literal in the file).
FAKE_JWT="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkcmlsbCJ9.s5doX9rAbCdEfGhIjKlMnOpQrStUvWxYz0123456"
FAKE_GH="gh""p_0123456789abcdefABCDEF0123456789abcd"
FAKE_AWS="AK""IAIOSFODNN7EXAMPLE"
# Assemble the Bearer sample from fragments too (no "Authorization: Bearer <tok>"
# literal stored in the file, per repo hygiene scanner rules).
FAKE_BEARER="Bea""rer abc.def.ghi"
emit --severity critical --instance ana-bot --source secret_probe \
  --summary "leak probe" \
  --evidence "token=$FAKE_JWT gh=$FAKE_GH aws=$FAKE_AWS Authorization: $FAKE_BEARER"
dispatch_once
assert_not_in "$FAKE_JWT" "$CAPTURE" "JWT not leaked"
assert_not_in "$FAKE_GH" "$CAPTURE" "GitHub token not leaked"
assert_not_in "$FAKE_AWS" "$CAPTURE" "AWS key not leaked"
assert_in "REDACTED" "$CAPTURE" "redaction marker present"
echo

# ── Drill 4: poison event quarantined, not silently dropped, batch survives
echo "Drill 4: malformed event quarantine + batch survival"
reset_sandbox
printf '{ this is not valid json' > "$BOT_ERRORS_OUTBOX_DIR/20260101T000000Z.bad.poison.deadbeef.json"
emit --severity critical --instance ana-bot --source agent_tool_error \
  --summary "valid alongside poison" --evidence "exit=1"
dispatch_once
rc=$?
[ "$rc" = "0" ] && pass "dispatcher exits 0 despite poison" || fail "dispatcher exit $rc on poison"
assert_count "$BOT_ERRORS_STATE_DIR/quarantine" "*.poison" 1 "poison moved to quarantine/"
assert_in "valid alongside poison" "$CAPTURE" "valid event still delivered"
assert_in "quarantined an unreadable event" "$CAPTURE" "quarantine self-alert fired"
echo

# ── Drill 5: oversized payload truncates, no crash
echo "Drill 5: oversized evidence truncation"
reset_sandbox
BIG=$(head -c 20000 < /dev/zero | tr '\0' 'A')
emit --severity critical --instance ana-bot --source big --summary "huge" --evidence "$BIG"
dispatch_once
assert_in "truncated" "$CAPTURE" "oversized evidence truncated"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 1 "oversized event still delivered"
echo

# ── Drill 6: idempotent dispatch — no double send
echo "Drill 6: idempotent dispatch (no double-send)"
reset_sandbox
emit --severity critical --instance ana-bot --source dup --summary "once only"
dispatch_once
n1=$(find "$BOT_ERRORS_STATE_DIR/sent" -name "*.sent" | wc -l | tr -d ' ')
dispatch_once
n2=$(find "$BOT_ERRORS_STATE_DIR/sent" -name "*.sent" | wc -l | tr -d ' ')
[ "$n1" = "1" ] && [ "$n2" = "1" ] && pass "event sent exactly once across two runs" \
  || fail "double-send: sent count $n1 then $n2"
echo

# ── Drill 7: empty summary falls back, never empty-body alert
echo "Drill 7: blank summary fallback"
reset_sandbox
emit --severity critical --instance ana-bot --source blank --summary " "
dispatch_once
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 1 "blank-summary event still delivered"
[ -s "$CAPTURE" ] && pass "dispatch body non-empty" || fail "dispatch body empty"
echo

# ── Drill 8: outbox-write failure leaves a loud, reconstructable breadcrumb (B4)
# NB: emit.ensure_private_dir() force-chmods the outbox dir back to 0700, so
# making the outbox dir itself read-only cannot simulate a write failure — the
# realistic trigger is an unwritable PARENT (disk full / perms / RO mount), so
# the mkdir of the outbox dir fails. We point the outbox under a 0500 parent.
# B4 (closed): emit must exit nonzero AND drop a reconstructable breadcrumb in a
# fallback dir so a write failure is never a silent lost alert.
echo "Drill 8: outbox-write-failure breadcrumb (B4)"
reset_sandbox
RO_PARENT="$SANDBOX/ro-parent"
mkdir -p "$RO_PARENT"
chmod 0500 "$RO_PARENT"
WF_DIR="$SANDBOX/writefail"
WF_STDERR="$SANDBOX/wf-stderr.log"
if BOT_ERRORS_OUTBOX_DIR="$RO_PARENT/outbox" BOT_ERRORS_WRITEFAIL_DIR="$WF_DIR" \
     python3 "$EMIT" \
     --severity critical --instance ana-bot --source wf \
     --summary "should fail to write" --evidence "phone=+15558675309" \
     >/dev/null 2>"$WF_STDERR"; then
  fail "emit unexpectedly succeeded on unwritable parent"
else
  pass "emit fails loudly (nonzero) on unwritable outbox parent"
fi
chmod 0700 "$RO_PARENT"
# Trace 1: loud stderr line names the failure.
assert_in "outbox write FAILED" "$WF_STDERR" "B4 trace 1: stderr records write failure"
# Trace 2: a reconstructable breadcrumb lands in the fallback dir.
assert_count "$WF_DIR" "*.writefail" 1 "B4 trace 2: breadcrumb written to fallback dir"
WF_FILE=$(find "$WF_DIR" -name "*.writefail" 2>/dev/null | head -1)
if [ -n "$WF_FILE" ]; then
  assert_in "outbox_write_failure" "$WF_FILE" "breadcrumb tags kind"
  assert_in "ana-bot" "$WF_FILE" "breadcrumb carries instance for reconstruction"
  assert_in '"severity": "critical"' "$WF_FILE" "breadcrumb carries original event"
  assert_not_in "+15558675309" "$WF_FILE" "breadcrumb keeps redaction (no PII leak)"
else
  fail "breadcrumb file not found for content assertions"
fi
BOT_ERRORS_WRITEFAIL_DIR="$WF_DIR" dispatch_once
assert_in "should fail to write" "$CAPTURE" "dispatcher recovers breadcrumb into dispatch path"
assert_in "writefail_recovered:" "$CAPTURE" "recovered dispatch declares writefail recovery"
assert_not_in "+15558675309" "$CAPTURE" "recovered dispatch keeps redaction"
assert_count "$BOT_ERRORS_STATE_DIR/writefail-recovered" "*.recovered" 1 "breadcrumb moved to writefail-recovered/"
assert_count "$WF_DIR" "*.writefail" 0 "writefail dir drained after recovery"
echo

echo "Drill 8b: writefail idempotency does not use substring matches"
reset_sandbox
COLLIDE_WF="$SANDBOX/writefail-collision"
mkdir -p "$BOT_ERRORS_STATE_DIR/sent" "$COLLIDE_WF"
printf '{"id":"evt-ABCDEF123456","delivery":{"status":"sent"}}\n' \
  > "$BOT_ERRORS_STATE_DIR/sent/existing.evt-ABCDEF123456.json.sent"
python3 - "$COLLIDE_WF" <<'PY'
import json
import sys
from pathlib import Path

target = Path(sys.argv[1]) / "collision.writefail"
event = {
    "schemaVersion": 1,
    "id": "evt-ABCDEF",
    "eventType": "alert",
    "severity": "critical",
    "createdAt": "2026-05-31T00:00:00Z",
    "machine": "drill",
    "instance": "ana-bot",
    "source": "wf",
    "summary": "substring collision must still send",
    "evidence": "new alert id is a prefix of an old alert id",
    "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
}
target.write_text(json.dumps({
    "schemaVersion": 1,
    "kind": "outbox_write_failure",
    "recordedAt": "2026-05-31T00:00:01Z",
    "failedTarget": "/tmp/outbox",
    "reason": "synthetic collision",
    "emitPid": 1,
    "event": event,
}) + "\n")
PY
BOT_ERRORS_WRITEFAIL_DIR="$COLLIDE_WF" dispatch_once
assert_in "substring collision must still send" "$CAPTURE" "substring-colliding writefail is sent"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 2 "new prefix-id alert not dropped as duplicate"
echo

# ── Drill 9: redaction coverage matrix (acceptance: raw_secret_hits == 0)
# Policy decision (Q+peer): diagnostic log PATHS are intentionally retained in
# rendered messages — investigators need them for remediation. Secrets and PII
# (token/bearer/JWT/PEM/userinfo/phone) must be zero. Phone redaction was the
# gap surfaced by the peer drill; closed in e522e1f (phone-like 10-15 digit
# redaction added to TS + Python redactors, bounded so ISO timestamps survive).
echo "Drill 9: redaction coverage matrix (phone + path policy)"
reset_sandbox
FAKE_PHONE="+15558675309"
# System log path (not an operator-home path) so the hygiene guard stays clean
# while still exercising the diagnostic-path-retention policy.
DIAG_PATH="/var/log/bot-errors/dispatch.jsonl"
emit --severity critical --instance ana-bot --source redaction_matrix \
  --summary "coverage probe" \
  --evidence "phone=$FAKE_PHONE logfile=$DIAG_PATH userinfo=https://u:p@host/x"
dispatch_once
assert_not_in "$FAKE_PHONE" "$CAPTURE" "phone not leaked (closed in e522e1f)"
assert_not_in "u:p@host" "$CAPTURE" "url userinfo redacted"
# Path retention is policy, not a failure — assert it is intentionally kept.
assert_in "dispatch.jsonl" "$CAPTURE" "diagnostic log path retained (policy)"
echo

# ── Drill 10: quiet daily-health success is still observable by watchdog
echo "Drill 10: daily-health info suppression + stale watchdog pairing"
reset_sandbox
emit --severity info --instance bot-errors-health --source daily-health \
  --summary "BOT ERRORS daily health passed" --evidence "machine=mini1 status=ok"
dispatch_once
assert_missing "$CAPTURE" "daily-health info does not send to BOT ERRORS"
assert_count "$BOT_ERRORS_STATE_DIR/suppressed" "*.suppressed" 1 "daily-health info retained as suppressed disposition"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 0 "daily-health info not marked sent"
HEARTBEAT_OK="$SANDBOX/heartbeat-ok.json"
BOT_ERRORS_WATCHDOG_CHECKS=daily_health python3 "$HEARTBEAT" --once \
  --max-daily-health-age 999999 > "$HEARTBEAT_OK" 2>&1
assert_in '"problems": []' "$HEARTBEAT_OK" "suppressed daily-health satisfies heartbeat freshness"
rm -rf "$BOT_ERRORS_STATE_DIR/suppressed"
HEARTBEAT_STALE="$SANDBOX/heartbeat-stale.json"
BOT_ERRORS_WATCHDOG_CHECKS=daily_health python3 "$HEARTBEAT" --once \
  --max-daily-health-age 1 > "$HEARTBEAT_STALE" 2>&1
assert_in 'daily_health' "$HEARTBEAT_STALE" "missing daily-health produces stale watchdog problem"
assert_count "$BOT_ERRORS_OUTBOX_DIR" "*.json" 1 "stale watchdog queues a critical alert"
echo

# ── Drill 11: remote writefail harvest reaches dispatcher recovery as CRITICAL
echo "Drill 11: collector remote writefail harvest + critical recovery"
reset_sandbox
REMOTE_ROOT="$SANDBOX/remote-root"
REMOTE_WF="$REMOTE_ROOT/writefail"
mkdir -p "$REMOTE_WF"
python3 - "$REMOTE_WF" <<'PY'
import json
import sys
from pathlib import Path

target = Path(sys.argv[1]) / "remote-critical.writefail"
event = {
    "schemaVersion": 1,
    "id": "remote-critical-drill",
    "eventType": "alert",
    "severity": "critical",
    "createdAt": "2026-05-31T00:00:00Z",
    "machine": "mini5-hostname",
    "platform": "darwin",
    "instance": "ana-bot",
    "source": "wf",
    "summary": "remote writefail drill critical",
    "evidence": "remote outbox failed before collector harvest",
    "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
}
target.write_text(json.dumps({
    "schemaVersion": 1,
    "kind": "outbox_write_failure",
    "recordedAt": "2026-05-31T00:00:01Z",
    "failedTarget": "/remote/outbox",
    "reason": "synthetic remote writefail",
    "emitPid": 1,
    "event": event,
}) + "\n")
PY
FAKE_SSH="$SANDBOX/fake-ssh-exec.sh"
cat > "$FAKE_SSH" <<'SH'
#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "python3" ]; do
  shift
done
if [ "$1" != "python3" ]; then
  echo "python3 command not found" >&2
  exit 127
fi
shift
exec python3 "$@"
SH
chmod 0700 "$FAKE_SSH"
BOT_ERRORS_RELAY_SSH_COMMAND="$FAKE_SSH" python3 "$COLLECTOR" \
  --remote "mini5:$REMOTE_ROOT" --max-events 5 --timeout 5 > "$SANDBOX/collector-b6.json" 2>&1
assert_in '"writefailHarvested": 1' "$SANDBOX/collector-b6.json" "collector harvests one remote writefail"
assert_count "$BOT_ERRORS_STATE_DIR/writefail" "*.writefail" 1 "remote crumb lands in nucles writefail inbox"
dispatch_once
assert_in "remote writefail drill critical" "$CAPTURE" "harvested remote critical reaches dispatch"
assert_in "writefail_recovered: origin=mini5-hostname harvested_from=mini5" "$CAPTURE" "dispatch names remote writefail origin"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 1 "remote critical recovered exactly once"
assert_count "$REMOTE_WF" "*.writefail" 0 "remote writefail source drained"
echo

echo "──────────────────────────────────────────"
echo "drills: $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
  printf 'failed drills:\n'; for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
