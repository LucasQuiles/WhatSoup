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
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EMIT="$REPO_ROOT/deploy/scripts/bot-errors-emit.py"
DISPATCH="$REPO_ROOT/deploy/scripts/bot-errors-dispatcher.py"
HEALTH="$REPO_ROOT/deploy/scripts/bot-errors-health-check.py"
HEARTBEAT="$REPO_ROOT/deploy/scripts/bot-errors-heartbeat-watchdog.py"
COLLECTOR="$REPO_ROOT/deploy/scripts/bot-errors-collector.py"

# Pin the sandbox under /tmp: the dispatcher's test-leak defense drops events
# whose text contains macOS user temp paths (/var/folders/.../T/), and drill
# evidence embeds sandbox paths by design. /tmp/bot-errors-drill.* is outside
# every default leak pattern on both macOS and Linux CI.
SANDBOX="$(mktemp -d "/tmp/bot-errors-drill.XXXXXX")"
CAPTURE="$SANDBOX/sent.log"
ALL_CAPTURE="$SANDBOX/all-sent.log"
CAPTURE_BYTES=0
# Since relay 16 the group line carries a short human card whose last line is
# "Ref: <8 hex>"; the full body (headline and every "  > field: value" line) is
# in the packet that Ref names, <state>/packets/<ref>.json, written before the
# send. Human assertions read the card ($CAPTURE). Machine assertions read the
# packet for each card's Ref ($PACKETS). Leak assertions read both ($SEEN), and
# the actionability audits read card plus packet per message ($ALL_SEEN). A card
# whose Ref names no packet, or a packet holding a different card, fails the
# drill; a text with no Ref (the full-body fallback) is read as sent.
PACKETS="$SANDBOX/packets.log"
SEEN="$SANDBOX/seen.log"
ALL_SEEN="$SANDBOX/all-seen.log"
NOTICE_VIEW="$SANDBOX/notice-view.py"

export BOT_ERRORS_STATE_DIR="$SANDBOX/state"
export BOT_ERRORS_OUTBOX_DIR="$BOT_ERRORS_STATE_DIR/outbox"
export BOT_ERRORS_DRY_SEND_CAPTURE="$CAPTURE"
# Deterministic platform string so logHints assertions are stable.
export BOT_ERRORS_DRY_SYS_PLATFORM="linux"
export BOT_ERRORS_DRY_PLATFORM_SYSTEM="Linux"
export BOT_ERRORS_DRY_PLATFORM="linux"  # legacy name, kept for older script revisions
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
assert_credential_failure() {
  packets
  if grep -F "FAIL credential:" "$PACKETS" 2>/dev/null | grep -F "$1" | grep -F "$2" >/dev/null; then
    pass "$3"
  else
    fail "$3 (missing: FAIL credential: * $1 * $2)"
  fi
}
credential_failure_count() {
  packets
  grep -F "FAIL credential:" "$PACKETS" 2>/dev/null | grep -F "$1" | grep -F "$2" | wc -l | tr -d ' '
}
# assert_count <dir> <pattern> <expected> <label>
assert_count() {
  local n; n=$(find "$1" -maxdepth 1 -name "$2" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" = "$3" ]; then pass "$4 ($n)"; else fail "$4 (expected $3, got $n)"; fi
}
assert_missing() {
  if [ ! -e "$1" ]; then pass "$2"; else fail "$2 (exists: $1)"; fi
}

cat > "$NOTICE_VIEW" <<'PY'
"""notice-view.py MODE CAPTURE STATE_DIR: print CAPTURE read through each card's Ref.

packets  -> one record per card, its text replaced by the packet body, then one
            record per notice the packet includes (a daily information
            summary lists the Ref of each notice folded into it)
seen     -> each card record followed by its packet record(s) as above
combined -> one record per card, text = card + newline + packet body
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

MAX_PACKET_OUTPUT_BYTES = 64 * 1024 * 1024
PACKET_READ_TIMEOUT_SECONDS = 60
READ_COMPLETE_PACKET = """
import importlib.util
import json
import sys
from pathlib import Path

dispatcher, ref = sys.argv[1:]
spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_packet_reader", Path(dispatcher))
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)
packet = mod.read_notice_packet(mod.state_paths(), ref)
if not isinstance(packet, dict) or not isinstance(packet.get("body"), str) or not isinstance(packet.get("card"), str):
    raise SystemExit("no complete notice packet")
if "included" in packet and not isinstance(packet["included"], list):
    raise SystemExit("invalid included notices")
output_packet = {"body": packet["body"], "card": packet["card"]}
if "included" in packet:
    output_packet["included"] = packet["included"]
output = json.dumps(output_packet, ensure_ascii=False, separators=(",", ":"))
if len(output.encode("utf-8")) > 64 * 1024 * 1024:
    raise SystemExit("notice packet output exceeds bound")
sys.stdout.write(output)
"""

mode, capture, state, dispatcher = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]


def packet_of(ref):
    path = state / "packets" / f"{ref}.json"
    if not path.is_file():
        raise SystemExit(f"Ref {ref} names no packet")
    packet = json.loads(path.read_text(encoding="utf-8"))
    if packet.get("kind") == "bot-errors-notice-packet-index":
        result = subprocess.run(
            [sys.executable, "-B", "-c", READ_COMPLETE_PACKET, dispatcher, ref],
            cwd=Path(dispatcher).parents[2],
            env={**os.environ, "BOT_ERRORS_STATE_DIR": str(state)},
            text=True,
            capture_output=True,
            timeout=PACKET_READ_TIMEOUT_SECONDS,
        )
        if result.returncode:
            raise SystemExit(f"Ref {ref} names no complete packet: {result.stderr.strip()}")
        if len(result.stdout.encode("utf-8")) > MAX_PACKET_OUTPUT_BYTES:
            raise SystemExit(f"Ref {ref} packet output exceeds bound")
        packet = json.loads(result.stdout)
    return packet


for line in capture.read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    record = json.loads(line)
    card = record["text"]
    match = re.search(r"\nRef: ([0-9a-f]{8})$", card)
    included = []
    if not match:
        body = card
    else:
        packet = packet_of(match.group(1))
        if packet.get("card") != card:
            raise SystemExit(f"packet {match.group(1)} does not hold the card that was sent")
        body = packet["body"]
        included = [packet_of(entry["ref"])["body"] for entry in packet.get("included") or []]
    if mode == "packets":
        for text in (body, *included):
            print(json.dumps({**record, "text": text}, sort_keys=True))
    elif mode == "seen":
        print(json.dumps(record, sort_keys=True))
        for text in (body, *included):
            print(json.dumps({**record, "text": text}, sort_keys=True))
    elif mode == "combined":
        print(json.dumps({**record, "text": card if body == card else card + "\n" + body}, sort_keys=True))
    else:
        raise SystemExit(f"unknown mode {mode}")
PY

# notice_view <mode> <capture> <out>: write the view; a broken card/packet link fails.
notice_view() {
  : > "$3"
  [ -s "$2" ] || return 0
  if ! python3 -B "$NOTICE_VIEW" "$1" "$2" "$BOT_ERRORS_STATE_DIR" "$DISPATCH" > "$3" 2> "$SANDBOX/notice-view.err"; then
    fail "card Ref resolves to the packet holding that card ($(tr '\n' ';' < "$SANDBOX/notice-view.err"))"
  fi
}
packets() { notice_view packets "$CAPTURE" "$PACKETS"; }
# assert_packet_in <needle> <label>: a machine field, read from the packet each card's Ref names
assert_packet_in() { packets; assert_in "$1" "$PACKETS" "$2"; }
# assert_seen_not_in <needle> <label>: absent from every card and every packet
assert_seen_not_in() { notice_view seen "$CAPTURE" "$SEEN"; assert_not_in "$1" "$SEEN" "$2"; }

reset_sandbox() {
  rm -rf "$BOT_ERRORS_STATE_DIR" "$CAPTURE"
  mkdir -p "$BOT_ERRORS_OUTBOX_DIR"
  CAPTURE_BYTES=0
}

emit() {
  local stderr_path="$SANDBOX/emit.stderr"
  if python3 "$EMIT" "$@" >/dev/null 2>"$stderr_path"; then
    return 0
  fi
  fail "emitter enqueues drill event"
  sed -n '1,8p' "$stderr_path" >&2
  return 1
}
dispatch_once() {
  python3 "$DISPATCH" --once >/dev/null 2>&1
  local rc=$?
  if [ -s "$CAPTURE" ]; then
    local size
    size=$(wc -c < "$CAPTURE" | tr -d ' ')
    if [ "$size" -gt "$CAPTURE_BYTES" ]; then
      tail -c +$((CAPTURE_BYTES + 1)) "$CAPTURE" > "$SANDBOX/capture-chunk.log"
      cat "$SANDBOX/capture-chunk.log" >> "$ALL_CAPTURE"
      notice_view combined "$SANDBOX/capture-chunk.log" "$SANDBOX/seen-chunk.log"
      cat "$SANDBOX/seen-chunk.log" >> "$ALL_SEEN"
      CAPTURE_BYTES="$size"
    fi
  fi
  return "$rc"
}

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
assert_packet_in "BOT ERROR" "renders BOT ERROR title"
assert_in "ana-bot" "$CAPTURE" "carries instance"
assert_packet_in "agent_tool_error" "carries source"
assert_packet_in "exit=127" "carries evidence"
assert_packet_in "journalctl" "carries actionable logHint"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 1 "event moved to sent/"
assert_count "$BOT_ERRORS_OUTBOX_DIR" "*.json" 0 "outbox drained"
echo

# ── Drill 2: severity / event-type rendering
echo "Drill 2: severity + event-type title rendering"
reset_sandbox
# Relay 16 C3: an information-only notice gets no card of its own; its packet is
# written and it is listed in the daily information summary, sent at or after
# BOT_ERRORS_INFO_SUMMARY_HOUR_UTC (13:00Z by default). Hour 0 makes this drill
# send the summary in the same cycle at any time of day, so it does not depend
# on when the drills run.
export BOT_ERRORS_INFO_SUMMARY_HOUR_UTC=0
emit --severity warning --instance mini3 --source health --summary "degraded"
emit --event-type observation --severity info --instance mini3 --source health --summary "fyi"
dispatch_once
unset BOT_ERRORS_INFO_SUMMARY_HOUR_UTC
emit --event-type clear --instance mini3 --source health --summary "recovered"
dispatch_once
assert_packet_in "BOT WARNING" "warning -> BOT WARNING"
assert_in "fyi" "$CAPTURE" "info -> listed on the daily information summary card"
assert_packet_in "BOT INFO - fyi" "info -> BOT INFO"
assert_packet_in "BOT RECOVERY" "clear -> BOT RECOVERY"
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
assert_seen_not_in "$FAKE_JWT" "JWT not leaked"
assert_seen_not_in "$FAKE_GH" "GitHub token not leaked"
assert_seen_not_in "$FAKE_AWS" "AWS key not leaked"
assert_packet_in "REDACTED" "redaction marker present"
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
assert_packet_in "truncated" "oversized evidence truncated"
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
  if python3 - "$WF_FILE" <<'PY'
import json
import sys
from pathlib import Path

crumb = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
raise SystemExit(0 if crumb.get("event", {}).get("severity") == "critical" else 1)
PY
  then
    pass "breadcrumb carries original event"
  else
    fail "breadcrumb does not carry original critical severity"
  fi
  assert_not_in "+15558675309" "$WF_FILE" "breadcrumb keeps redaction (no PII leak)"
else
  fail "breadcrumb file not found for content assertions"
fi
BOT_ERRORS_WRITEFAIL_DIR="$WF_DIR" dispatch_once
assert_in "should fail to write" "$CAPTURE" "dispatcher recovers breadcrumb into dispatch path"
assert_packet_in "writefail_recovered:" "recovered dispatch declares writefail recovery"
assert_seen_not_in "+15558675309" "recovered dispatch keeps redaction"
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
assert_seen_not_in "$FAKE_PHONE" "phone not leaked (closed in e522e1f)"
assert_seen_not_in "u:p@host" "url userinfo redacted"
# Path retention is policy, not a failure — assert it is intentionally kept.
assert_packet_in "dispatch.jsonl" "diagnostic log path retained (policy)"
echo

# ── Drill 10: quiet daily-health success is still observable by watchdog
echo "Drill 10: daily-health info suppression + stale watchdog pairing"
reset_sandbox
emit --event-type observation --severity info --instance bot-errors-health --source daily-health \
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
assert_packet_in "writefail_recovered: origin=mini5-hostname harvested_from=mini5" "dispatch names remote writefail origin"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 1 "remote critical recovered exactly once"
assert_count "$REMOTE_WF" "*.writefail" 0 "remote writefail source drained"
echo

# ── Drill 12: remote unreachable stays isolated from reachable hosts
echo "Drill 12: collector remote-unreachable isolation"
reset_sandbox
D12_FAIL_REMOTE="$SANDBOX/d12-mini5"
D12_OK_REMOTE="$SANDBOX/d12-mini6"
mkdir -p "$D12_FAIL_REMOTE/outbox" "$D12_OK_REMOTE/outbox"
python3 - "$D12_OK_REMOTE/outbox" <<'PY'
import json
import sys
from pathlib import Path

target = Path(sys.argv[1]) / "mini6-reachable.json"
target.write_text(json.dumps({
    "schemaVersion": 1,
    "id": "mini6-reachable-while-mini5-unreachable",
    "eventType": "alert",
    "severity": "critical",
    "createdAt": "2026-05-31T00:00:00Z",
    "machine": "mini6-hostname",
    "platform": "darwin",
    "instance": "ana-bot",
    "source": "collector-drill",
    "summary": "mini6 reachable event while mini5 unreachable",
    "evidence": "collector must isolate per-host failure",
    "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
}) + "\n")
PY
D12_SSH="$SANDBOX/d12-fake-ssh.sh"
cat > "$D12_SSH" <<'SH'
#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "mini5" ]; then
    echo "simulated mini5 unreachable" >&2
    exit 255
  fi
done
while [ "$#" -gt 0 ] && [ "$1" != "python3" ]; do
  shift
done
[ "$1" = "python3" ] || exit 127
shift
exec python3 "$@"
SH
chmod 0700 "$D12_SSH"
if BOT_ERRORS_RELAY_SSH_COMMAND="$D12_SSH" python3 "$COLLECTOR" \
     --remote "mini5:$D12_FAIL_REMOTE" --remote "mini6:$D12_OK_REMOTE" \
     --max-events 5 --timeout 5 --alert-cooldown 1 > "$SANDBOX/collector-d12.json" 2>&1; then
  pass "collector exits 0 when one remote is down but another is relayed"
else
  fail "collector exited nonzero despite per-host isolation"
fi
assert_in '"processed": 1' "$SANDBOX/collector-d12.json" "reachable host relayed one event"
assert_in '"remotesSucceeded": 1' "$SANDBOX/collector-d12.json" "collector records one successful remote"
assert_count "$BOT_ERRORS_OUTBOX_DIR" "*.json" 2 "unreachable meta + reachable event queued"
dispatch_once
assert_in "collector cannot claim remote outbox: mini5" "$CAPTURE" "unreachable host produces alert"
assert_in "mini6 reachable event while mini5 unreachable" "$CAPTURE" "reachable host still reaches dispatch"
assert_count "$D12_OK_REMOTE/outbox" "*.json" 0 "reachable remote drained"
echo

# ── Drill 13: WhatsApp socket unavailable leaves durable retry state
echo "Drill 13: WhatsApp socket unavailable keeps alert durable"
reset_sandbox
emit --severity critical --instance ana-bot --source socket_down \
  --summary "socket down alert must stay queued" --evidence "send channel unavailable"
D13_GROUP_JID="120363""000000000000""@g.us"
if BOT_ERRORS_DRY_SEND_CAPTURE="" BOT_ERRORS_JID="$D13_GROUP_JID" \
     BOT_ERRORS_EXPECTED_JID="$D13_GROUP_JID" \
     BOT_ERRORS_SOCKET_PATH="$SANDBOX/missing.sock" python3 "$DISPATCH" --once \
     > "$SANDBOX/d13-fail.out" 2>&1; then
  fail "dispatcher unexpectedly succeeded while socket missing"
else
  pass "dispatcher exits nonzero when send channel is missing"
fi
assert_missing "$CAPTURE" "socket-down failure does not fake a send"
assert_count "$BOT_ERRORS_OUTBOX_DIR" "*.json" 1 "socket-down event remains in outbox"
assert_in '"type": "send_failed"' "$BOT_ERRORS_STATE_DIR/logs/dispatch.jsonl" "dispatch log records send_failed"
dispatch_once
assert_missing "$CAPTURE" "retry backoff prevents immediate tight-loop resend"
python3 - "$BOT_ERRORS_OUTBOX_DIR" <<'PY'
import json
import sys
from pathlib import Path

for path in Path(sys.argv[1]).glob("*.json"):
    event = json.loads(path.read_text())
    event.setdefault("delivery", {})["nextAttemptAtEpoch"] = 0
    path.write_text(json.dumps(event, indent=2, sort_keys=True) + "\n")
PY
dispatch_once
assert_in "socket down alert must stay queued" "$CAPTURE" "socket recovery sends queued event"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 1 "socket recovery sends exactly once"
echo

# ── Drill 14: dispatcher crash mid-claim replay
echo "Drill 14: dispatcher processing claim reclaimed after crash"
reset_sandbox
mkdir -p "$BOT_ERRORS_STATE_DIR/processing"
python3 - "$BOT_ERRORS_STATE_DIR/processing" "$BOT_ERRORS_OUTBOX_DIR" <<'PY'
import json
import sys
from pathlib import Path

processing = Path(sys.argv[1])
outbox = Path(sys.argv[2])
event = {
    "schemaVersion": 1,
    "id": "crash-mid-claim-drill",
    "eventType": "alert",
    "severity": "critical",
    "createdAt": "2026-05-31T00:00:00Z",
    "machine": "nucles",
    "platform": "linux",
    "instance": "bot-errors-dispatcher",
    "source": "crash-mid-claim",
    "summary": "processing claim survived dispatcher crash",
    "evidence": "synthetic orphaned processing claim",
    "process": {"pid": 1, "cwd": str(outbox.parent), "argv": ["dispatcher"]},
    "diagnostics": {"logHints": [str(outbox.parent / "logs/dispatch.jsonl")], "queue": str(outbox)},
    "delivery": {"attempts": 0, "status": "sending", "nextAttemptAtEpoch": 0, "lastError": None},
}
(processing / "20260531T000000Z.crash-mid-claim-drill.json.999.processing").write_text(json.dumps(event, indent=2) + "\n")
PY
dispatch_once
assert_in "processing claim survived dispatcher crash" "$CAPTURE" "orphaned processing claim dispatched"
assert_count "$BOT_ERRORS_STATE_DIR/processing" "*.processing" 0 "processing dir drained after reclaim"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 1 "reclaimed event sent once"
echo

# ── Drill 15: local queue permission denied uses HOME fallback before TMPDIR
echo "Drill 15: queue permission denied breadcrumb fallback order"
reset_sandbox
D15_RO="$SANDBOX/d15-ro"
D15_HOME="$SANDBOX/d15-home"
D15_TMP="$SANDBOX/d15-tmp"
mkdir -p "$D15_RO" "$D15_HOME" "$D15_TMP"
chmod 0500 "$D15_RO"
D15_STDERR="$SANDBOX/d15-stderr.log"
if HOME="$D15_HOME" TMPDIR="$D15_TMP" BOT_ERRORS_STATE_DIR="$D15_RO/state" \
     BOT_ERRORS_OUTBOX_DIR="$D15_RO/state/outbox" python3 "$EMIT" \
     --severity critical --instance ana-bot --source queue_perm_denied \
     --summary "home fallback crumb should recover" --evidence "local queue denied" \
     >/dev/null 2>"$D15_STDERR"; then
  fail "emit unexpectedly succeeded with unwritable state root"
else
  pass "emit fails loudly when local queue cannot be created"
fi
chmod 0700 "$D15_RO"
assert_in "outbox write FAILED" "$D15_STDERR" "permission denied writes stderr trace"
assert_count "$D15_HOME/.bot-errors-writefail" "*.writefail" 1 "HOME fallback receives breadcrumb"
assert_count "$D15_TMP/bot-errors-writefail" "*.writefail" 0 "TMPDIR fallback not used before HOME"
BOT_ERRORS_WRITEFAIL_DIR="$D15_HOME/.bot-errors-writefail" dispatch_once
assert_in "home fallback crumb should recover" "$CAPTURE" "HOME fallback breadcrumb recovered"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 1 "permission-denied recovery sends once"
echo

# ── Drill 16: cold restart persistence across outbox, processing, writefail
echo "Drill 16: cold restart replay from outbox + processing + writefail"
reset_sandbox
mkdir -p "$BOT_ERRORS_OUTBOX_DIR" "$BOT_ERRORS_STATE_DIR/processing" "$BOT_ERRORS_STATE_DIR/writefail"
python3 - "$BOT_ERRORS_STATE_DIR" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
base = {
    "schemaVersion": 1,
    "eventType": "alert",
    "severity": "critical",
    "createdAt": "2026-05-31T00:00:00Z",
    "machine": "nucles",
    "platform": "linux",
    "instance": "bot-errors-dispatcher",
    "source": "cold-restart",
    "process": {"pid": 1, "cwd": str(root), "argv": ["dispatcher"]},
    "diagnostics": {"logHints": [str(root / "logs/dispatch.jsonl")], "queue": str(root / "outbox")},
    "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
}
events = [
    ("outbox", "reboot-outbox", "cold restart outbox event"),
    ("processing", "reboot-processing", "cold restart processing event"),
    ("writefail", "reboot-writefail", "cold restart writefail event"),
]
for kind, event_id, summary in events:
    event = {
        **base,
        "id": event_id,
        "source": f"cold-restart-{kind}",
        "summary": summary,
        "evidence": f"{kind} survived process death",
    }
    if kind == "outbox":
        (root / "outbox" / f"20260531T000000Z.{event_id}.json").write_text(json.dumps(event, indent=2) + "\n")
    elif kind == "processing":
        (root / "processing" / f"20260531T000000Z.{event_id}.json.999.processing").write_text(json.dumps(event, indent=2) + "\n")
    else:
        crumb = {
            "schemaVersion": 1,
            "kind": "outbox_write_failure",
            "recordedAt": "2026-05-31T00:00:01Z",
            "failedTarget": str(root / "outbox"),
            "reason": "synthetic cold restart breadcrumb",
            "emitPid": 1,
            "event": event,
        }
        (root / "writefail" / f"{event_id}.writefail").write_text(json.dumps(crumb, indent=2) + "\n")
PY
dispatch_once
assert_in "cold restart outbox event" "$CAPTURE" "outbox event survived cold restart"
assert_in "cold restart processing event" "$CAPTURE" "processing claim survived cold restart"
assert_in "cold restart writefail event" "$CAPTURE" "writefail crumb survived cold restart"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 3 "cold restart sends three events exactly once"
assert_count "$BOT_ERRORS_STATE_DIR/processing" "*.processing" 0 "cold restart leaves no processing stranding"
echo

# ── Drill 17: missing required tool at startup becomes actionable alert
echo "Drill 17: missing required tool/plugin health alert"
reset_sandbox
D17_HOME="$SANDBOX/d17-home"
mkdir -p "$D17_HOME"
HOME="$D17_HOME" BOT_ERRORS_STATE_DIR="$BOT_ERRORS_STATE_DIR" \
  BOT_ERRORS_DRY_TOOL_NAMES="send_message" BOT_ERRORS_REQUIRED_TOOLS="send_message,missing_tool" \
  BOT_ERRORS_HEALTH_PROFILE_JSON='{"role":"tool-test","expectDispatcher":false,"expectQLoop":false,"expectPersonalSocket":false,"expectConfigInventory":false,"expectPluginInventory":false}' \
  python3 "$HEALTH" --daily >/dev/null 2>&1
dispatch_once
assert_packet_in "missing required tools missing_tool" "missing required tool appears in alert summary"
assert_packet_in "required_missing=missing_tool" "missing required tool appears in evidence"
echo

# ── Drill 18: stale heartbeat detects hung supervisor and emits recovery clear
echo "Drill 18: stale heartbeat alert and recovery"
reset_sandbox
D18_Q_STATE="$SANDBOX/d18-q-loop-state.json"
printf '{"updated_at":100}\n' > "$D18_Q_STATE"
chmod 0600 "$D18_Q_STATE"
BOT_ERRORS_Q_LOOP_STATE="$D18_Q_STATE" BOT_ERRORS_WATCHDOG_CHECKS=q_loop \
  BOT_ERRORS_WATCHDOG_RECOVERY_CONFIRMATIONS=1 BOT_ERRORS_DRY_NOW=1000 \
  python3 "$HEARTBEAT" --once --max-q-loop-age 60 > "$SANDBOX/d18-stale-1.json" 2>&1
assert_count "$BOT_ERRORS_OUTBOX_DIR" "*.json" 1 "stale q-loop heartbeat queues one alert"
BOT_ERRORS_Q_LOOP_STATE="$D18_Q_STATE" BOT_ERRORS_WATCHDOG_CHECKS=q_loop \
  BOT_ERRORS_WATCHDOG_RECOVERY_CONFIRMATIONS=1 BOT_ERRORS_DRY_NOW=1001 \
  python3 "$HEARTBEAT" --once --max-q-loop-age 60 > "$SANDBOX/d18-stale-2.json" 2>&1
assert_count "$BOT_ERRORS_OUTBOX_DIR" "*.json" 1 "duplicate stale heartbeat suppressed while open"
printf '{"updated_at":1002}\n' > "$D18_Q_STATE"
chmod 0600 "$D18_Q_STATE"
BOT_ERRORS_Q_LOOP_STATE="$D18_Q_STATE" BOT_ERRORS_WATCHDOG_CHECKS=q_loop \
  BOT_ERRORS_WATCHDOG_RECOVERY_CONFIRMATIONS=1 BOT_ERRORS_DRY_NOW=1002 \
  python3 "$HEARTBEAT" --once --max-q-loop-age 60 > "$SANDBOX/d18-recovery.json" 2>&1
assert_count "$BOT_ERRORS_OUTBOX_DIR" "*.json" 2 "heartbeat recovery queues clear event"
dispatch_once
assert_packet_in "heartbeat watchdog stale: q_loop" "stale heartbeat alert dispatched"
assert_packet_in "heartbeat watchdog recovered: q_loop" "heartbeat recovery dispatched"
echo

# ── Drill 19: rendered alerts must be actionable from the message body alone
echo "Drill 19: Q-actionability render audit"
D19_AUDIT="$SANDBOX/d19-audit.txt"
if python3 - "$ALL_SEEN" > "$D19_AUDIT" 2>&1 <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
messages = [part.strip() for part in path.read_text(encoding="utf-8").split("\n---\n") if part.strip()]
required = ("severity", "machine", "instance", "source", "event", "created", "requested_action")
failures = []
for index, message in enumerate(messages, start=1):
    missing = [label for label in required if f"> {label}:" not in message]
    path_count = 0
    for pattern in (r"> log_\d+:", r"> queue:", r"> dispatch_log:", r"breadcrumb="):
        if re.search(pattern, message):
            path_count += 1
    if path_count < 2:
        missing.append(">=2 evidence paths")
    if "writefail" in message.lower() and "recovered" in message.lower() and "> writefail_recovered:" not in message:
        missing.append("writefail recovery provenance")
    if missing:
        failures.append(f"message {index}: {', '.join(missing)}")
if not messages:
    failures.append("no rendered messages captured")
if failures:
    print("\n".join(failures))
    raise SystemExit(1)
print(f"audited {len(messages)} rendered messages")
PY
then
  pass "all rendered alerts satisfy Q-actionability rubric"
else
  fail "Q-actionability audit failed: $(tr '\n' ';' < "$D19_AUDIT")"
fi
echo

# ── Drill 20: same-fingerprint fleet storms collapse to a single digest (B8)
echo "Drill 20: same-fingerprint storm collapse (D20a-D20e)"
reset_sandbox
python3 - "$BOT_ERRORS_OUTBOX_DIR" <<'PY'
import json
import sys
from pathlib import Path

outbox = Path(sys.argv[1])
hosts = ["MACLAB", "MWLAB"] + [f"mini{i}" for i in range(1, 12)]
for i, host in enumerate(hosts):
    tools = "send_message,missing_tool" if i % 2 == 0 else "missing_tool,send_message"
    event = {
        "schemaVersion": 1,
        "id": f"d20a-{host}",
        "eventType": "alert",
        "severity": "critical",
        "createdAt": "2026-05-31T00:00:00Z",
        "machine": host,
        "platform": "darwin",
        "instance": "bot-errors-health",
        "source": "daily-health",
        "summary": f"{host} missing required tools {tools}",
        "evidence": f"machine={host} profile={host}.json required_missing=missing_tool",
        "process": {"pid": 1, "cwd": str(outbox.parent), "argv": ["health"]},
        "diagnostics": {
            "logHints": [f"/var/log/bot-errors/{host}.log", str(outbox.parent / "remote" / host / "health.json")],
            "queue": str(outbox),
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    (outbox / f"20260531T000000Z.d20a.{host}.json").write_text(json.dumps(event, indent=2) + "\n")
PY
dispatch_once
d20_count=$(grep -c "BOT ERRORS storm collapse" "$CAPTURE" 2>/dev/null | tr -d ' ')
[ "$d20_count" = "1" ] && pass "D20a emits exactly one storm digest" \
  || fail "D20a expected one storm digest, got $d20_count"
assert_packet_in "affected_hosts: 13" "D20a/D20e digest carries affected host count"
for host in MACLAB MWLAB mini1 mini2 mini3 mini4 mini5 mini6 mini7 mini8 mini9 mini10 mini11; do
  assert_packet_in "$host" "D20a/D20e digest names $host"
done
# #2387: the digest text no longer names the manifest path. The path is private
# topology and nothing reads it programmatically, so it must not reach the
# operator page. What ties the page to its window is the window identity, and it
# reaches the operator through the incident key. The expected identity is built
# from the manifest this same window wrote, so the drill never hard-codes a
# fingerprint or a clock-derived window start.
assert_seen_not_in "storm_manifest:" "D20a/D20e digest omits the manifest path"
d20_window_identity="$(python3 - "$BOT_ERRORS_STATE_DIR/storm-manifests" <<'PY'
import json
import re
import sys
from pathlib import Path

manifests = sorted(Path(sys.argv[1]).glob("*.json"))
if len(manifests) != 1:
    raise SystemExit(f"expected exactly one storm manifest, found {len(manifests)}")
record = json.loads(manifests[0].read_text(encoding="utf-8"))
fingerprint = str(record["fingerprint"])
window_start = record["windowStartEpoch"]
# Shape-checked so a renamed or absent manifest field cannot degrade the
# assertion below into a prefix match that any digest would satisfy.
if not re.fullmatch(r"[0-9a-f]{16}", fingerprint):
    raise SystemExit(f"manifest fingerprint is not a 16-hex digest: {fingerprint!r}")
if not isinstance(window_start, int) or isinstance(window_start, bool):
    raise SystemExit(f"manifest windowStartEpoch is not an integer: {window_start!r}")
print(f"storm-{fingerprint}-{window_start}")
PY
)"
if [ -z "$d20_window_identity" ]; then
  fail "D20a/D20e window identity resolved from the manifest"
else
  pass "D20a/D20e window identity resolved from the manifest"
  assert_packet_in "incident_key: fleet|storm-collapse|storm-collapse.$d20_window_identity" \
    "D20a/D20e digest carries the window identity"
fi
assert_count "$BOT_ERRORS_STATE_DIR/storm-collapsed" "*.collapsed" 13 "D20a original storm events retained as collapsed evidence"
assert_count "$BOT_ERRORS_STATE_DIR/storm-manifests" "*.json" 1 "D20a manifest written"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 1 "D20a digest sent once"
assert_count "$BOT_ERRORS_OUTBOX_DIR" "*.json" 0 "D20a outbox drained"

reset_sandbox
python3 - "$BOT_ERRORS_OUTBOX_DIR" <<'PY'
import json
import sys
from pathlib import Path

outbox = Path(sys.argv[1])
hosts = ["MACLAB", "MWLAB"] + [f"mini{i}" for i in range(1, 12)]
for host in hosts:
    event = {
        "schemaVersion": 1,
        "id": f"d20a-reuse-first-{host}",
        "eventType": "alert",
        "severity": "critical",
        "createdAt": "2026-05-31T00:00:00Z",
        "machine": host,
        "platform": "darwin",
        "instance": "bot-errors-health",
        "source": "daily-health",
        "summary": f"{host} missing required tools send_message",
        "evidence": f"machine={host} required_missing=send_message",
        "diagnostics": {"logHints": [f"/var/log/bot-errors/{host}.log"], "queue": str(outbox)},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    (outbox / f"20260531T000000Z.d20a.reuse.first.{host}.json").write_text(json.dumps(event, indent=2) + "\n")
PY
python3 "$DISPATCH" --once --max-events 0 >/dev/null 2>&1
assert_count "$BOT_ERRORS_OUTBOX_DIR" "*.json" 1 "D20a crash-idempotency leaves one deterministic digest queued"
python3 - "$BOT_ERRORS_OUTBOX_DIR" <<'PY'
import json
import sys
from pathlib import Path

outbox = Path(sys.argv[1])
for host in ("mini12", "mini13", "mini14"):
    event = {
        "schemaVersion": 1,
        "id": f"d20a-reuse-late-{host}",
        "eventType": "alert",
        "severity": "critical",
        "createdAt": "2026-05-31T00:00:01Z",
        "machine": host,
        "platform": "darwin",
        "instance": "bot-errors-health",
        "source": "daily-health",
        "summary": f"{host} missing required tools send_message",
        "evidence": f"machine={host} required_missing=send_message",
        "diagnostics": {"logHints": [f"/var/log/bot-errors/{host}.log"], "queue": str(outbox)},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    (outbox / f"20260531T000001Z.d20a.reuse.late.{host}.json").write_text(json.dumps(event, indent=2) + "\n")
PY
dispatch_once
d20_reuse_count=$(grep -c "BOT ERRORS storm collapse" "$CAPTURE" 2>/dev/null | tr -d ' ')
[ "$d20_reuse_count" = "1" ] && pass "D20a crash-idempotency reuses existing digest without double-send" \
  || fail "D20a crash-idempotency expected one digest send, got $d20_reuse_count"
assert_in '"type": "storm_digest_reused"' "$BOT_ERRORS_STATE_DIR/logs/dispatch.jsonl" "D20a crash-idempotency logs digest reuse"
assert_count "$BOT_ERRORS_STATE_DIR/storm-collapsed" "*.collapsed" 16 "D20a crash-idempotency retains original plus late collapsed evidence"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 1 "D20a crash-idempotency sends one digest"

reset_sandbox
python3 - "$BOT_ERRORS_OUTBOX_DIR" <<'PY'
import json
import sys
from pathlib import Path

outbox = Path(sys.argv[1])
for host in ("mini1", "mini2", "mini3"):
    event = {
        "schemaVersion": 1,
        "id": f"d20b-same-{host}",
        "eventType": "alert",
        "severity": "critical",
        "createdAt": "2026-05-31T00:00:00Z",
        "machine": host,
        "platform": "darwin",
        "instance": "bot-errors-health",
        "source": "daily-health",
        "summary": f"{host} missing required tools send_message",
        "evidence": f"machine={host} required_missing=send_message",
        "diagnostics": {"logHints": [f"/var/log/bot-errors/{host}.log"], "queue": str(outbox)},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    (outbox / f"20260531T000000Z.d20b.same.{host}.json").write_text(json.dumps(event, indent=2) + "\n")
one_off = {
    "schemaVersion": 1,
    "id": "d20b-one-off",
    "eventType": "alert",
    "severity": "critical",
    "createdAt": "2026-05-31T00:00:00Z",
    "machine": "mini4",
    "platform": "darwin",
    "instance": "ana-bot",
    "source": "tool-failure",
    "summary": "mini4 tool call failed differently",
    "evidence": "distinct fingerprint must not merge",
    "diagnostics": {"logHints": ["/var/log/bot-errors/mini4.log"], "queue": str(outbox)},
    "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
}
(outbox / "20260531T000000Z.d20b.one-off.json").write_text(json.dumps(one_off, indent=2) + "\n")
PY
dispatch_once
d20b_count=$(grep -c "BOT ERRORS storm collapse" "$CAPTURE" 2>/dev/null | tr -d ' ')
[ "$d20b_count" = "1" ] && pass "D20b same fingerprint collapses once" \
  || fail "D20b expected one digest, got $d20b_count"
assert_in "mini4 tool call failed differently" "$CAPTURE" "D20b distinct fingerprint still sends independently"
assert_count "$BOT_ERRORS_STATE_DIR/storm-collapsed" "*.collapsed" 3 "D20b only same-fingerprint events collapsed"
assert_count "$BOT_ERRORS_STATE_DIR/sent" "*.sent" 2 "D20b emits digest plus one distinct alert"

reset_sandbox
python3 - "$BOT_ERRORS_OUTBOX_DIR" <<'PY'
import json
import sys
from pathlib import Path

outbox = Path(sys.argv[1])
for host, stamp in (("mini1", "2026-05-31T00:01:59Z"), ("mini2", "2026-05-31T00:02:00Z"), ("mini3", "2026-05-31T00:02:01Z")):
    event = {
        "schemaVersion": 1,
        "id": f"d20c-boundary-{host}",
        "eventType": "alert",
        "severity": "critical",
        "createdAt": stamp,
        "machine": host,
        "platform": "darwin",
        "instance": "bot-errors-health",
        "source": "daily-health",
        "summary": f"{host} missing required tools send_message",
        "evidence": f"machine={host} required_missing=send_message",
        "diagnostics": {"logHints": [f"/var/log/bot-errors/{host}.log"], "queue": str(outbox)},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    safe = stamp.replace(":", "").replace("-", "")
    (outbox / f"{safe}.d20c.boundary.{host}.json").write_text(json.dumps(event, indent=2) + "\n")
PY
dispatch_once
d20_boundary_count=$(grep -c "BOT ERRORS storm collapse" "$CAPTURE" 2>/dev/null | tr -d ' ')
[ "$d20_boundary_count" = "1" ] && pass "D20c boundary-straddling events collapse inside sliding window" \
  || fail "D20c boundary straddle expected one digest, got $d20_boundary_count"
assert_count "$BOT_ERRORS_STATE_DIR/storm-collapsed" "*.collapsed" 3 "D20c boundary straddle retains collapsed evidence"

reset_sandbox
python3 - "$BOT_ERRORS_OUTBOX_DIR" <<'PY'
import json
import sys
from pathlib import Path

outbox = Path(sys.argv[1])
for host, stamp in (("mini1", "2026-05-31T00:01:50Z"), ("mini2", "2026-05-31T00:02:31Z"), ("mini3", "2026-05-31T00:03:12Z")):
    event = {
        "schemaVersion": 1,
        "id": f"d20f-trickle-{host}",
        "eventType": "alert",
        "severity": "critical",
        "createdAt": stamp,
        "machine": host,
        "platform": "darwin",
        "instance": "bot-errors-health",
        "source": "daily-health",
        "summary": f"{host} missing required tools send_message",
        "evidence": f"machine={host} required_missing=send_message",
        "diagnostics": {"logHints": [f"/var/log/bot-errors/{host}.log"], "queue": str(outbox)},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    safe = stamp.replace(":", "").replace("-", "")
    (outbox / f"{safe}.d20f.trickle.{host}.json").write_text(json.dumps(event, indent=2) + "\n")
PY
dispatch_once
d20_trickle_count=$(grep -c "BOT ERRORS storm collapse" "$CAPTURE" 2>/dev/null | tr -d ' ')
[ "$d20_trickle_count" = "1" ] && pass "D20f trickle across bucket boundary collapses inside rolling window" \
  || fail "D20f trickle expected one digest, got $d20_trickle_count"
assert_count "$BOT_ERRORS_STATE_DIR/storm-collapsed" "*.collapsed" 3 "D20f trickle retains collapsed evidence"

reset_sandbox
python3 - "$BOT_ERRORS_OUTBOX_DIR" <<'PY'
import json
import sys
from pathlib import Path

outbox = Path(sys.argv[1])
for stamp, hosts in (("2026-05-31T00:00:00Z", ("mini1", "mini2", "mini3")), ("2026-05-31T00:03:00Z", ("mini4", "mini5", "mini6"))):
    for host in hosts:
        event = {
            "schemaVersion": 1,
            "id": f"d20c-{stamp}-{host}",
            "eventType": "alert",
            "severity": "critical",
            "createdAt": stamp,
            "machine": host,
            "platform": "darwin",
            "instance": "bot-errors-health",
            "source": "daily-health",
            "summary": f"{host} missing required tools send_message",
            "evidence": f"machine={host} required_missing=send_message",
            "diagnostics": {"logHints": [f"/var/log/bot-errors/{host}.log"], "queue": str(outbox)},
            "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
        }
        safe = stamp.replace(":", "").replace("-", "")
        (outbox / f"{safe}.d20c.{host}.json").write_text(json.dumps(event, indent=2) + "\n")
PY
BOT_ERRORS_STORM_WINDOW_SECONDS=120 dispatch_once
d20c_count=$(grep -c "BOT ERRORS storm collapse" "$CAPTURE" 2>/dev/null | tr -d ' ')
[ "$d20c_count" = "2" ] && pass "D20c emits separate digests across windows" \
  || fail "D20c expected two digests, got $d20c_count"
assert_count "$BOT_ERRORS_STATE_DIR/storm-collapsed" "*.collapsed" 6 "D20c collapsed both windows without permanent suppression"

reset_sandbox
for host in mini1 mini2 mini3; do
  emit --event-type observation --severity info --instance bot-errors-health --source daily-health \
    --summary "BOT ERRORS daily health passed" --evidence "machine=$host status=ok"
done
dispatch_once
assert_missing "$CAPTURE" "D20d daily-health recovery/info noise remains suppressed"
assert_count "$BOT_ERRORS_STATE_DIR/suppressed" "*.suppressed" 3 "D20d recovery/info events bounded as suppressed dispositions"
D20_AUDIT="$SANDBOX/d20-audit.txt"
if python3 - "$ALL_SEEN" > "$D20_AUDIT" 2>&1 <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
messages = [part.strip() for part in path.read_text(encoding="utf-8").split("\n---\n") if part.strip()]
required = ("severity", "machine", "instance", "source", "event", "created", "requested_action")
failures = []
storm_messages = 0
for index, message in enumerate(messages, start=1):
    missing = [label for label in required if f"> {label}:" not in message]
    path_count = 0
    for pattern in (r"> log_\d+:", r"> queue:", r"> dispatch_log:", r"breadcrumb=", r"> storm_manifest:"):
        if re.search(pattern, message):
            path_count += 1
    if path_count < 2:
        missing.append(">=2 evidence paths")
    if "BOT ERRORS storm collapse" in message:
        storm_messages += 1
        for needle in ("> affected_hosts:", "> affected_host_list:"):
            if needle not in message:
                missing.append(needle)
        # #2387: the manifest path left the digest text. The window identity in
        # the incident key is what now ties the page to the window it collapsed,
        # so the audit requires the identity and refuses the path.
        if "> storm_manifest:" in message:
            missing.append("no > storm_manifest: line")
        if not re.search(
            r"> incident_key: fleet\|storm-collapse\|storm-collapse\.storm-[0-9a-f]{16}-\d+",
            message,
        ):
            missing.append("> incident_key: carrying the window identity")
    if missing:
        failures.append(f"message {index}: {', '.join(missing)}")
if storm_messages < 1:
    failures.append("no storm digest messages captured")
if failures:
    print("\n".join(failures))
    raise SystemExit(1)
print(f"audited {len(messages)} rendered messages including {storm_messages} storm digest(s)")
PY
then
  pass "D20e storm digests satisfy Q-actionability rubric"
else
  fail "D20e actionability audit failed: $(tr '\n' ';' < "$D20_AUDIT")"
fi
echo

# ── Drill 21: bounded fragmented line-card packet reader
echo "Drill 21: bounded fragmented line-card packet reader"
reset_sandbox
if python3 -B - "$DISPATCH" "$CAPTURE" <<'PY'
import importlib.util
import json
import sys
from pathlib import Path

dispatcher, capture = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_fragmented_drill", dispatcher)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)
paths = mod.state_paths()
ref = "1234abcd"
card = f"BOT WARNING - fragmented drill\nRef: {ref}"
body = "BOT WARNING - fragmented drill\n  > evidence: " + "x" * (mod.NOTICE_PACKET_INLINE_BYTES + 1) + "\n  > sentinel: canonical fragment"
packet = mod.build_notice_packet(
    {"id": "fragmented-drill", "summary": "fragmented drill"},
    ref=ref,
    notice_kind="line-check-card",
    card=card,
    body=body,
)
mod.write_notice_packet(paths, packet)
assert len(body.encode("utf-8")) > mod.NOTICE_PACKET_INLINE_BYTES
assert json.loads(mod.notice_packet_path(paths, ref).read_text())["kind"] == mod.NOTICE_PACKET_INDEX_KIND
capture.write_text(json.dumps({"text": card}) + "\n", encoding="utf-8")
PY
then
  assert_packet_in "sentinel: canonical fragment" "D21 >6MiB packet resolves through bounded canonical reader"
  D21_PART=$(find "$BOT_ERRORS_STATE_DIR/packets" -name "*.part.json" -print -quit)
  if python3 -B - "$D21_PART" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
part = json.loads(path.read_text())
data = part["data"]
part["data"] = data[:-1] + ("A" if data[-1] != "A" else "B")
path.write_text(json.dumps(part))
PY
  then
    if ! python3 -B "$NOTICE_VIEW" packets "$CAPTURE" "$BOT_ERRORS_STATE_DIR" "$DISPATCH" >/dev/null 2>"$SANDBOX/d21-corrupt-part.err"; then
      pass "D21 corrupt packet part is refused"
    else
      fail "D21 corrupt packet part must be refused"
    fi
  else
    fail "D21 corrupt packet fixture is created"
  fi
  if [ -n "$D21_PART" ] && rm -f "$D21_PART" && ! python3 -B "$NOTICE_VIEW" packets "$CAPTURE" "$BOT_ERRORS_STATE_DIR" "$DISPATCH" >/dev/null 2>"$SANDBOX/d21-missing-part.err"; then
    pass "D21 missing packet part is refused"
  else
    fail "D21 missing packet part must be refused"
  fi
else
  fail "D21 >6MiB fragmented packet fixture is created"
fi
echo

# ── Drill 22: profile-declared required files + permission policy (B9)
echo "Drill 22: profile-declared required files and permission policy"
reset_sandbox
D22_HOME="$SANDBOX/d22a-home"
mkdir -p "$D22_HOME"
HOME="$D22_HOME" BOT_ERRORS_DRY_CLOCK_STATUS=synced \
  BOT_ERRORS_DRY_DISK_FREE_BYTES=$((10 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_DISK_TOTAL_BYTES=$((100 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_UPTIME_SECONDS=3600 \
  BOT_ERRORS_HEALTH_PROFILE_JSON='{"role":"bot-host","expectDispatcher":false,"expectQLoop":false,"expectPersonalSocket":false,"expectPersonalTools":false,"expectConfigInventory":false,"expectPluginInventory":false,"requiredCredentialFiles":["tokens.env"]}' \
  python3 "$HEALTH" --daily >/dev/null 2>&1
dispatch_once
assert_credential_failure "missing required" "expected_path_basename=tokens.env" "D22a missing required credential fails"
assert_seen_not_in "D22_SECRET" "D22a no credential body leaked"

reset_sandbox
D22_HOME="$SANDBOX/d22b-home"
mkdir -p "$D22_HOME/.config/whatsoup"
chmod 0700 "$D22_HOME/.config/whatsoup"
printf 'TOKEN=D22_SECRET_UNREADABLE\n' > "$D22_HOME/.config/whatsoup/tokens.env"
chmod 000 "$D22_HOME/.config/whatsoup/tokens.env"
HOME="$D22_HOME" BOT_ERRORS_DRY_CLOCK_STATUS=synced \
  BOT_ERRORS_DRY_DISK_FREE_BYTES=$((10 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_DISK_TOTAL_BYTES=$((100 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_UPTIME_SECONDS=3600 \
  BOT_ERRORS_HEALTH_PROFILE_JSON='{"role":"bot-host","expectDispatcher":false,"expectQLoop":false,"expectPersonalSocket":false,"expectPersonalTools":false,"expectConfigInventory":false,"expectPluginInventory":false,"requiredCredentialFiles":["tokens.env"]}' \
  python3 "$HEALTH" --daily >/dev/null 2>&1
chmod 600 "$D22_HOME/.config/whatsoup/tokens.env"
dispatch_once
assert_credential_failure "unreadable" "credential_path_basename=tokens.env" "D22b unreadable required credential fails"
assert_seen_not_in "D22_SECRET_UNREADABLE" "D22b unreadable credential contents not leaked"

reset_sandbox
D22_HOME="$SANDBOX/d22c-warn-home"
mkdir -p "$D22_HOME/.config/whatsoup"
chmod 0700 "$D22_HOME/.config/whatsoup"
printf 'TOKEN=D22_SECRET_MODE_WARN\n' > "$D22_HOME/.config/whatsoup/tokens.env"
chmod 0644 "$D22_HOME/.config/whatsoup/tokens.env"
HOME="$D22_HOME" BOT_ERRORS_DRY_CLOCK_STATUS=synced \
  BOT_ERRORS_DRY_DISK_FREE_BYTES=$((10 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_DISK_TOTAL_BYTES=$((100 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_UPTIME_SECONDS=3600 \
  BOT_ERRORS_HEALTH_PROFILE_JSON='{"role":"bot-host","expectDispatcher":false,"expectQLoop":false,"expectPersonalSocket":false,"expectPersonalTools":false,"expectConfigInventory":false,"expectPluginInventory":false,"requiredCredentialFiles":["tokens.env"]}' \
  python3 "$HEALTH" --daily >/dev/null 2>&1
dispatch_once
assert_packet_in "BOT ERROR" "D22c credential 0644 fails closed"
assert_credential_failure "non_private" "credential_path_basename=tokens.env" "D22c credential 0644 critical line"
assert_seen_not_in "credential_meta" "D22c required credential does not duplicate metadata line"
assert_seen_not_in "D22_SECRET_MODE_WARN" "D22c warning credential contents not leaked"

reset_sandbox
D22_HOME="$SANDBOX/d22c-fail-home"
mkdir -p "$D22_HOME/.config/whatsoup"
chmod 0700 "$D22_HOME/.config/whatsoup"
printf 'TOKEN=D22_SECRET_MODE_FAIL\n' > "$D22_HOME/.config/whatsoup/tokens.env"
chmod 0666 "$D22_HOME/.config/whatsoup/tokens.env"
HOME="$D22_HOME" BOT_ERRORS_DRY_CLOCK_STATUS=synced \
  BOT_ERRORS_DRY_DISK_FREE_BYTES=$((10 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_DISK_TOTAL_BYTES=$((100 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_UPTIME_SECONDS=3600 \
  BOT_ERRORS_HEALTH_PROFILE_JSON='{"role":"bot-host","expectDispatcher":false,"expectQLoop":false,"expectPersonalSocket":false,"expectPersonalTools":false,"expectConfigInventory":false,"expectPluginInventory":false,"requiredCredentialFiles":["tokens.env"]}' \
  python3 "$HEALTH" --daily >/dev/null 2>&1
dispatch_once
assert_credential_failure "world_writable" "credential_path_basename=tokens.env" "D22c credential world-writable fails"
d22c_fail_count=$(credential_failure_count "world_writable" "credential_path_basename=tokens.env")
[ "$d22c_fail_count" = "1" ] && pass "D22c world-writable required credential fails once" \
  || fail "D22c expected one required credential FAIL, got $d22c_fail_count"
assert_seen_not_in "credential_meta" "D22c world-writable required credential does not duplicate metadata line"
assert_seen_not_in "D22_SECRET_MODE_FAIL" "D22c failing credential contents not leaked"

reset_sandbox
D22_HOME="$SANDBOX/d22d-home"
mkdir -p "$D22_HOME/.config/whatsoup/instances/ana-bot"
chmod 0700 "$D22_HOME/.config/whatsoup" "$D22_HOME/.config/whatsoup/instances" "$D22_HOME/.config/whatsoup/instances/ana-bot"
HOME="$D22_HOME" BOT_ERRORS_DRY_CLOCK_STATUS=synced \
  BOT_ERRORS_DRY_DISK_FREE_BYTES=$((10 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_DISK_TOTAL_BYTES=$((100 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_UPTIME_SECONDS=3600 \
  BOT_ERRORS_HEALTH_PROFILE_JSON='{"role":"bot-host","expectDispatcher":false,"expectQLoop":false,"expectPersonalSocket":false,"expectPersonalTools":false,"expectPluginInventory":false,"requiredCredentialFiles":[],"requiredConfigFiles":["config.json"],"instances":[{"name":"ana-bot","expected":"always_on","service":"com.whatsoup.ana-bot"}]}' \
  python3 "$HEALTH" --daily >/dev/null 2>&1
dispatch_once
assert_packet_in "FAIL config ana-bot: missing required config.json" "D22d missing required config fails"

reset_sandbox
D22_HOME="$SANDBOX/d22e-warn-home"
mkdir -p "$D22_HOME/.config/whatsoup/instances/ana-bot"
chmod 0700 "$D22_HOME/.config/whatsoup" "$D22_HOME/.config/whatsoup/instances" "$D22_HOME/.config/whatsoup/instances/ana-bot"
printf '{"type":"agent","secret":"D22_CONFIG_SECRET_WARN"}\n' > "$D22_HOME/.config/whatsoup/instances/ana-bot/config.json"
chmod 0644 "$D22_HOME/.config/whatsoup/instances/ana-bot/config.json"
HOME="$D22_HOME" BOT_ERRORS_DRY_CLOCK_STATUS=synced \
  BOT_ERRORS_DRY_DISK_FREE_BYTES=$((10 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_DISK_TOTAL_BYTES=$((100 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_UPTIME_SECONDS=3600 \
  BOT_ERRORS_HEALTH_PROFILE_JSON='{"role":"bot-host","expectDispatcher":false,"expectQLoop":false,"expectPersonalSocket":false,"expectPersonalTools":false,"expectPluginInventory":false,"requiredCredentialFiles":[],"requiredConfigFiles":["config.json"],"allowUnprofiledInstances":true,"instances":[{"name":"ana-bot","expected":"on_demand"}]}' \
  python3 "$HEALTH" --daily >/dev/null 2>&1
dispatch_once
assert_packet_in "BOT WARNING" "D22e config 0644 warns by default"
assert_packet_in "WARN config ana-bot: world_readable required config.json" "D22e config 0644 warning line"
assert_seen_not_in "D22_CONFIG_SECRET_WARN" "D22e warning config body not leaked"

reset_sandbox
D22_HOME="$SANDBOX/d22e-fail-home"
mkdir -p "$D22_HOME/.config/whatsoup/instances/ana-bot"
chmod 0700 "$D22_HOME/.config/whatsoup" "$D22_HOME/.config/whatsoup/instances" "$D22_HOME/.config/whatsoup/instances/ana-bot"
printf '{"type":"agent","secret":"D22_CONFIG_SECRET_FAIL"}\n' > "$D22_HOME/.config/whatsoup/instances/ana-bot/config.json"
chmod 0644 "$D22_HOME/.config/whatsoup/instances/ana-bot/config.json"
HOME="$D22_HOME" BOT_ERRORS_DRY_CLOCK_STATUS=synced \
  BOT_ERRORS_DRY_DISK_FREE_BYTES=$((10 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_DISK_TOTAL_BYTES=$((100 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_UPTIME_SECONDS=3600 \
  BOT_ERRORS_HEALTH_PROFILE_JSON='{"role":"bot-host","expectDispatcher":false,"expectQLoop":false,"expectPersonalSocket":false,"expectPersonalTools":false,"expectPluginInventory":false,"requiredCredentialFiles":[],"requiredConfigFiles":["config.json"],"requiredConfigMaxMode":"0600","allowUnprofiledInstances":true,"instances":[{"name":"ana-bot","expected":"on_demand"}]}' \
  python3 "$HEALTH" --daily >/dev/null 2>&1
dispatch_once
assert_packet_in "FAIL config ana-bot: mode>600 required config.json" "D22e strict config max mode fails"
assert_seen_not_in "D22_CONFIG_SECRET_FAIL" "D22e strict config body not leaked"

reset_sandbox
D22_HOME="$SANDBOX/d22f-home"
mkdir -p "$D22_HOME"
HOME="$D22_HOME" BOT_ERRORS_DRY_CLOCK_STATUS=synced \
  BOT_ERRORS_DRY_DISK_FREE_BYTES=$((10 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_DISK_TOTAL_BYTES=$((100 * 1024 * 1024 * 1024)) \
  BOT_ERRORS_DRY_UPTIME_SECONDS=3600 \
  BOT_ERRORS_HEALTH_PROFILE_JSON='{"role":"no-bot","expectDispatcher":false,"expectQLoop":false,"expectPersonalSocket":false,"expectPersonalTools":false,"expectConfigInventory":false,"expectPluginInventory":false,"requiredCredentialFiles":[],"instances":[]}' \
  python3 "$HEALTH" --daily >/dev/null 2>&1
dispatch_once
assert_missing "$CAPTURE" "D22f no-bot info event remains suppressed"
assert_count "$BOT_ERRORS_STATE_DIR/suppressed" "*.suppressed" 1 "D22f no-bot produces suppressed info only"

D22_AUDIT="$SANDBOX/d22-audit.txt"
if grep -E "D22_SECRET|D22_CONFIG_SECRET|TOKEN=" "$ALL_SEEN" > "$D22_AUDIT" 2>&1; then
  fail "D22g required-file diagnostics leaked contents: $(tr '\n' ';' < "$D22_AUDIT")"
else
  pass "D22g required-file diagnostics do not leak credential/config contents"
fi
echo

echo "──────────────────────────────────────────"
echo "drills: $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
  printf 'failed drills:\n'; for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
