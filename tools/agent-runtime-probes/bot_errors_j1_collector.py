#!/usr/bin/env python3
"""BOT ERRORS J1 unattended collector: contract steps 3-8, read-only, no publication.

Runs from launchd on the relay host. It reads the supervision cursor, freezes a half-open
interval, executes the read-only planes over ssh (alert-host units/liveness/monitoring, two
column-scoped store scans, the canary host), classifies rows, checks store parity, and writes
a collection bundle plus its own pointer (COLLECTOR.json). It never takes the checkpoint
lease, never moves CURRENT.json, never appends the ledger, never sends anything. Collection
liveness is measured by COLLECTOR.json; adjudication liveness stays with CURRENT.json
(decision C5).

Reaching hosts requires --live; --fixture-dir replays captured receipts instead. stdout is
metadata only: counts, statuses, hashes, paths. Message bodies are written to receipt files
under --root (mode 0600, directory 0700) and never printed. The interactive-only mailbox
source is recorded as not_collected so a bundle can never claim it.

Exit 0 after any bundle is written, including a failed or partial one (an alarm that crashes
during the emergency is the failure this collector exists to prevent). Exit 2 only when the
root, the arguments or the cursor are unusable before a bundle can be written. Exit 3 when
another collector holds the lock.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
from collections import Counter, OrderedDict
from pathlib import PurePosixPath

SCHEMA_VERSION = "1.0"
BUNDLE_KIND = "bot-errors-collect"
POINTER_KIND = "bot-errors-collector-pointer"
REDACTION = {
    "policy": "metadata-only",
    "bodies": "receipt-files-only",
    "stdout": "no-bodies",
}
DEFAULT_UNITS = (
    "whatsoup@q.service",
    "whatsoup@personal.service",
    "bot-errors-dispatcher.service",
    "bot-errors-collector.service",
    "bot-errors-heartbeat-watchdog.service",
    "bot-errors-heartbeat-watchdog.timer",
    "bot-errors-deadman.service",
    "bot-errors-deadman.timer",
    "whatsoup-reply-guarantee.service",
    "whatsoup-reply-guarantee.timer",
)
FIELD = re.compile(r"^\s*[>›]\s*([a-z_]+):\s*(.*)$", re.M)
FIELD_SEP = "\x1f"
RECORD_SEP = "\x1e"
SAFE_JID = re.compile(r"^[0-9A-Za-z._:@-]{5,64}$")
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SAFE_UNIT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9@._-]{0,127}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
ISO_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
SLOT_FORWARD_TOLERANCE_S = 120

# Column-scoped scan (contract step 3). Never SELECT *, never immutable=1. The group jid is
# interpolated into the SQL string by the remote shell; it is admitted only when it matches
# SAFE_JID (no quotes, spaces or metacharacters), and the timestamps are integers formatted by
# this process. Field separator US (0x1f) and record separator RS (0x1e) keep a '|' or a
# newline inside a display name or body from shifting columns.
SCAN_SCRIPT = r"""set -u
I="$1"; ST="$2"; EN="$3"; JID="$4"
DB="$HOME/.local/share/whatsoup/instances/$I/bot.db"
sqlite3 -separator "$(printf '\037')" -newline "$(printf '\036')" "file:$DB?mode=ro" "PRAGMA query_only=ON; SELECT pk,message_id,timestamp,created_at,sender_jid,sender_name,content_type,is_from_me,substr(COALESCE(content_text,content),1,2000) FROM messages WHERE chat_jid='$JID' AND timestamp>=$ST AND timestamp<$EN ORDER BY timestamp,pk;"
"""

# Alert-host planes (contract steps 4-6 plus the C1 per-unit read). Read-only. Every section
# reports its own exit status on a SECTION_RC line and the script exits 1 when any section
# failed, so a failed read can never be mistaken for an empty (zero) fact.
PLANES_SCRIPT = r"""set -u
ST="$1"; EN="$2"; JID="$3"; HEALTH_PORT="$4"; shift 4
STATE="$HOME/.local/state/bot-errors"
FAIL=0
rc() { echo "SECTION_RC $1 $2"; [ "$2" -eq 0 ] || FAIL=1; }
echo "=== SECTION clock ==="
date -u +%FT%TZ; rc clock $?
echo "=== SECTION units-failed-listing ==="
systemctl --user list-units --state=failed --no-legend --plain; rc units-failed-listing $?
echo "=== SECTION units-per-unit ==="
worst=0
for u in "$@"; do
  echo "--- $u"
  systemctl --user show "$u" -p LoadState,ActiveState,SubState,Result,NRestarts,MainPID,ExecMainStatus,ActiveEnterTimestamp,LastTriggerUSec || worst=1
done
rc units-per-unit $worst
echo "=== SECTION health ==="
curl -s -o /dev/null -w 'http_code=%{http_code}\n' "http://127.0.0.1:$HEALTH_PORT/health"; rc health $?
echo "=== SECTION liveness ==="
worst=0
for i in q personal; do
  echo "--- $i"
  sqlite3 "file:$HOME/.local/share/whatsoup/instances/$i/bot.db?mode=ro" "PRAGMA query_only=ON; SELECT MAX(pk), MAX(timestamp) FROM messages;" || worst=1
done
rc liveness $worst
echo "=== SECTION window-row-counts ==="
worst=0
for i in q personal; do
  echo "--- $i"
  sqlite3 "file:$HOME/.local/share/whatsoup/instances/$i/bot.db?mode=ro" "PRAGMA query_only=ON; SELECT COUNT(*), MIN(pk), MAX(pk) FROM messages WHERE chat_jid='$JID' AND timestamp>=$ST AND timestamp<$EN;" || worst=1
done
rc window-row-counts $worst
echo "=== SECTION dispatcher-state ==="
python3 -c 'import json;d=json.load(open("'"$STATE"'/dispatcher-state.json"));print(json.dumps({k:d.get(k) for k in ("cycleCompletedAt","lastError","pid")}))'; rc dispatcher-state $?
echo "=== SECTION incident-state ==="
python3 -c 'import json;d=json.load(open("'"$STATE"'/incident-state.json"));inc=d.get("openIncidents") or {};fs=d.get("flapState") or {};print(json.dumps({"openIncidents_len":len(inc),"flapState_len":len(fs),"updatedAt":d.get("updatedAt")}))'; rc incident-state $?
echo "=== SECTION watchdog-state ==="
python3 -c 'import json;d=json.load(open("'"$STATE"'/heartbeat-watchdog-state.json"));o=d.get("open",{});r=d.get("recentlyRecovered",{});c=d.get("_controllerState",{});print(json.dumps({"open":sorted(o),"recentlyRecovered":sorted(r),"generation":c.get("generation"),"writtenAt":c.get("writtenAt")}))'; rc watchdog-state $?
echo "=== SECTION queues ==="
worst=0
for q in outbox processing quarantine sent; do
  if [ -d "$STATE/$q" ] && [ -r "$STATE/$q" ]; then
    n=$(ls -1 "$STATE/$q" | wc -l | tr -d ' '); echo "$q=$n"
  else
    echo "$q=unreadable"; worst=1
  fi
done
rc queues $worst
echo "=== SECTION supervision-pointer ==="
sha256sum "$STATE/supervision/CURRENT.json" && stat -c '%Y' "$STATE/supervision/CURRENT.json"; rc supervision-pointer $?
echo "=== SECTION deployed-checkout ==="
git -C "$HOME/LAB/WhatSoup" rev-parse HEAD && git -C "$HOME/LAB/WhatSoup" rev-parse --abbrev-ref HEAD; rc deployed-checkout $?
echo "=== SECTION end ==="
date -u +%FT%TZ
exit $FAIL
"""

# Canary host (contract step 7). Read-only.
CANARY_SCRIPT = r"""set -u
INST="$1"; FROM_SEQ="$2"
DB="$HOME/.local/share/whatsoup/instances/$INST/bot.db"
FAIL=0
echo "=== clock ==="
date -u +%FT%TZ
echo "=== nonterminal ==="
sqlite3 "file:$DB?mode=ro" "PRAGMA query_only=ON; SELECT COUNT(*) FROM inbound_events WHERE processing_status NOT IN ('complete','failed');" || FAIL=1
echo "=== rows ==="
sqlite3 "file:$DB?mode=ro" "PRAGMA query_only=ON; SELECT COUNT(*), SUM(CASE WHEN processing_status='failed' THEN 1 ELSE 0 END), MAX(seq) FROM inbound_events WHERE seq>=$FROM_SEQ;" || FAIL=1
echo "=== occurrences ==="
sqlite3 "file:$DB?mode=ro" "PRAGMA query_only=ON; SELECT id,state,scheduled_for FROM trigger_occurrences ORDER BY id DESC LIMIT 3;" || FAIL=1
exit $FAIL
"""


# ----------------------------------------------------------------------------- pure helpers


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str) -> dt.datetime:
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def interval(prior_end_utc: str, now: dt.datetime, overlap_seconds: int) -> dict:
    """Half-open [prior end - overlap, now). The end is fixed once and never re-read."""
    start = parse_iso(prior_end_utc) - dt.timedelta(seconds=overlap_seconds)
    if now <= start:
        raise ValueError("interval end must be after its start")
    return {
        "start_inclusive_utc": iso(start),
        "end_exclusive_utc": iso(now),
        "start_ts": int(start.timestamp()),
        "end_ts": int(now.timestamp()),
        "overlap_seconds": overlap_seconds,
    }


def expected_slot(now: dt.datetime, slot_minute: int) -> tuple[str, int]:
    """The slot this run serves and the signed offset from it in seconds.

    A run that starts up to SLOT_FORWARD_TOLERANCE_S before its slot minute (launchd jitter,
    a clock step) serves that slot rather than the previous hour's; otherwise the most recent
    slot at or before now.
    """
    candidate = now.replace(minute=slot_minute, second=0)
    ahead = (candidate - now).total_seconds()
    if ahead > SLOT_FORWARD_TOLERANCE_S:
        candidate -= dt.timedelta(hours=1)
    return iso(candidate), int((now - candidate).total_seconds())


def parse_rows(text: str) -> list[dict]:
    """Rows are RS-separated records of exactly nine US-separated fields (see SCAN_SCRIPT).

    A record with the wrong field count, or a non-numeric pk/timestamp, is returned with
    `malformed: True` and only `raw_sha256` so the caller can count it without guessing.
    """
    rows: list[dict] = []
    for rec in text.split(RECORD_SEP):
        if rec.strip() == "":
            continue
        parts = rec.split(FIELD_SEP)
        if len(parts) != 9 or not parts[0].isdigit() or not parts[2].isdigit():
            rows.append(
                {"malformed": True, "raw_sha256": sha256_bytes(rec.encode("utf-8"))}
            )
            continue
        rows.append(
            {
                "pk": int(parts[0]),
                "message_id": parts[1],
                "ts": int(parts[2]),
                "created_at": parts[3],
                "sender_jid": parts[4],
                "sender_name": parts[5],
                "content_type": parts[6],
                "is_from_me": parts[7],
                "body": parts[8],
            }
        )
    return rows


def fields(body: str) -> dict:
    out: dict = {}
    for k, v in FIELD.findall(body):
        out.setdefault(k, v.strip())
    return out


def flag(body: str, name: str) -> bool:
    """True when a boolean marker is present in either spelling the producers use:
    `name=true` inline, or `> name: true` as a field row."""
    if f"{name}=true" in body:
        return True
    return fields(body).get(name, "").lower() == "true"


def classify(body: str) -> str:
    """Event-lifecycle class of one channel row. Orthogonal to the fault taxonomy's kinds."""
    head = body.split("\n", 1)[0]
    if head.startswith("Codex -> Q / gate nudge"):
        return "gate_nudge"
    if head.startswith("[maclab probe"):
        return "maclab_probe_post"
    if (
        "Flap storm closed" in head
        or "Flap storm resolved" in head
        or flag(body, "flap_storm_resolved")
    ):
        return "flap_storm_close"
    if "Flap storm:" in head:
        return "flap_storm_open"
    if head.startswith("BOT RECOVERY") or " RECOVERED" in head:
        return "recovery"
    if head.startswith("✅ *") and " resolved " in head:
        return "resolved_lifecycle"
    if "heartbeat watchdog escalated" in head:
        return (
            "escalation_bypass_renotify"
            if flag(body, "incident_still_open")
            else "escalation_new"
        )
    # A non-escalated "still open" notification is the same incident again, never a new alert.
    if (
        "↻" in head
        or flag(body, "still_open_digest")
        or flag(body, "stale_digest")
        or flag(body, "incident_still_open")
        or "ESCALATED still open" in head
        or "Stale incident digest" in head
        or "state: stale" in body
    ):
        return "repeat_renotify"
    if (
        head.startswith("BOT WARNING")
        or head.startswith("BOT ERROR")
        or head.startswith("BOT INFO")
    ):
        return "alert"
    if (
        head.startswith("J1 ")
        or head.startswith("[J1 ")
        or "supervision loop" in head
        or "no instruction implied" in body
    ):
        return "lane_observation_post"
    return "other"


# Classes that are neither a new alert nor a repeat of one: coordination chatter, lane posts,
# storm lifecycle and recoveries. They are counted but never enter the novelty denominator.
NOVELTY_EXCLUDED = frozenset(
    {
        "gate_nudge",
        "maclab_probe_post",
        "lane_observation_post",
        "flap_storm_open",
        "flap_storm_close",
        "recovery",
        "resolved_lifecycle",
        "other",
    }
)
ALERT_LIKE = frozenset({"alert", "escalation_new"})
REPEAT_LIKE = frozenset({"repeat_renotify", "escalation_bypass_renotify"})


def summarize(rows: list[dict], prior_hw_pk: int) -> dict:
    malformed = sum(1 for r in rows if r.get("malformed"))
    rows = [r for r in rows if not r.get("malformed")]
    new_rows = [r for r in rows if r["pk"] > prior_hw_pk]
    per_class: Counter = Counter()
    keys: Counter = Counter()
    keys_first: "OrderedDict[str, str]" = OrderedDict()
    sources: Counter = Counter()
    body_hashes: Counter = Counter()
    for r in new_rows:
        c = classify(r["body"])
        per_class[c] += 1
        f = fields(r["body"])
        k = f.get("incident_key")
        if k:
            keys[k] += 1
            keys_first.setdefault(k, r["created_at"])
        if f.get("source"):
            sources[f["source"]] += 1
        body_hashes[sha256_bytes(r["body"].encode("utf-8"))] += 1
    alert_like = sum(n for c, n in per_class.items() if c in ALERT_LIKE)
    repeat_like = sum(n for c, n in per_class.items() if c in REPEAT_LIKE)
    excluded = sum(n for c, n in per_class.items() if c in NOVELTY_EXCLUDED)
    denom = alert_like + repeat_like
    return {
        "rows_scanned": len(rows) + malformed,
        "rows_malformed": malformed,
        "rows_new": len(new_rows),
        "dedup_discarded": len(rows) - len(new_rows),
        "min_pk": min((r["pk"] for r in new_rows), default=None),
        "max_pk": max((r["pk"] for r in new_rows), default=None),
        "max_ts": max((r["ts"] for r in new_rows), default=None),
        "per_class": dict(per_class),
        "novelty": {
            "alert_like": alert_like,
            "repeat_like": repeat_like,
            "excluded": excluded,
            "denominator": denom,
            "ratio": (round(alert_like / denom, 4) if denom else None),
        },
        "distinct_incident_keys": len(keys),
        "rows_with_incident_key": sum(keys.values()),
        "distinct_sources": len(sources),
        "body_sha256_distinct": len(body_hashes),
        "keys_first_seen": list(keys_first.items())[:50],
    }


def parity(q_rows: list[dict], p_rows: list[dict]) -> dict:
    q_rows = [r for r in q_rows if not r.get("malformed")]
    p_rows = [r for r in p_rows if not r.get("malformed")]
    q_ids = {r["message_id"] for r in q_rows}
    p_ids = {r["message_id"] for r in p_rows}
    q_bodies = Counter(sha256_bytes(r["body"].encode("utf-8")) for r in q_rows)
    p_bodies = Counter(sha256_bytes(r["body"].encode("utf-8")) for r in p_rows)
    return {
        "q_rows": len(q_rows),
        "personal_rows": len(p_rows),
        "message_id_intersection": len(q_ids & p_ids),
        "only_in_q": len(q_ids - p_ids),
        "only_in_personal": len(p_ids - q_ids),
        "body_hash_multiset_equal": q_bodies == p_bodies,
    }


def _section(text: str, name: str) -> str:
    marker = f"=== SECTION {name} ==="
    if marker not in text:
        return ""
    after = text.split(marker, 1)[1]
    body = after.split("=== SECTION", 1)[0]
    return "\n".join(ln for ln in body.splitlines() if not ln.startswith("SECTION_RC "))


def parse_planes(text: str, units: tuple[str, ...]) -> dict:
    """Metadata facts from the alert-host receipt. Missing sections stay None (never invented);
    a section whose SECTION_RC is non-zero is listed in failed_sections and its facts are None."""
    facts: dict = {
        "units": {},
        "units_failed_listing_rows": None,
        "health_http_code": None,
        "liveness": {},
        "window_rows": {},
        "dispatcher": None,
        "incident_state": None,
        "watchdog": None,
        "queues": {},
        "supervision_pointer_sha256": None,
        "supervision_pointer_mtime": None,
        "deployed_head": None,
        "deployed_branch": None,
        "remote_clock_start": None,
        "remote_clock_end": None,
        "section_rc": {},
        "failed_sections": [],
    }
    for name, rc in re.findall(r"^SECTION_RC (\S+) (\d+)$", text, re.M):
        facts["section_rc"][name] = int(rc)
        if int(rc) != 0:
            facts["failed_sections"].append(name)

    def ok(name: str) -> bool:
        return facts["section_rc"].get(name) == 0

    clock = _section(text, "clock").strip().splitlines()
    facts["remote_clock_start"] = clock[0] if clock and ok("clock") else None
    end = _section(text, "end").strip().splitlines()
    facts["remote_clock_end"] = end[0] if end else None
    if ok("units-failed-listing"):
        failed = _section(text, "units-failed-listing")
        facts["units_failed_listing_rows"] = len(
            [ln for ln in failed.splitlines() if ln.strip()]
        )
    if ok("units-per-unit"):
        cur = None
        for ln in _section(text, "units-per-unit").splitlines():
            if ln.startswith("--- "):
                cur = ln[4:].strip()
                facts["units"][cur] = {}
            elif cur and "=" in ln:
                k, v = ln.split("=", 1)
                facts["units"][cur][k] = v
    if ok("health"):
        health = re.search(r"http_code=(\d+)", _section(text, "health"))
        facts["health_http_code"] = int(health.group(1)) if health else None
    for name, blob in (("liveness", "liveness"), ("window_rows", "window-row-counts")):
        if not ok(blob):
            continue
        cur = None
        for ln in _section(text, blob).splitlines():
            if ln.startswith("--- "):
                cur = ln[4:].strip()
            elif cur and "|" in ln:
                facts[name][cur] = [
                    int(x) if x.isdigit() else None for x in ln.strip().split("|")
                ]
    for name, blob in (
        ("dispatcher", "dispatcher-state"),
        ("incident_state", "incident-state"),
        ("watchdog", "watchdog-state"),
    ):
        body = _section(text, blob).strip()
        if body and ok(blob):
            try:
                facts[name] = json.loads(body.splitlines()[0])
            except (ValueError, IndexError):
                facts[name] = {"parse_error": True}
    if ok("queues"):
        for ln in _section(text, "queues").splitlines():
            if "=" in ln:
                k, v = ln.split("=", 1)
                facts["queues"][k.strip()] = int(v) if v.strip().isdigit() else None
    if ok("supervision-pointer"):
        ptr = _section(text, "supervision-pointer").split()
        if ptr and HEX64.match(ptr[0]):
            facts["supervision_pointer_sha256"] = ptr[0]
            if len(ptr) >= 3 and ptr[2].isdigit():
                facts["supervision_pointer_mtime"] = int(ptr[2])
    if ok("deployed-checkout"):
        dep = _section(text, "deployed-checkout").split()
        if len(dep) >= 2 and re.match(r"^[0-9a-f]{40}$", dep[0]):
            facts["deployed_head"], facts["deployed_branch"] = dep[0], dep[1]
    for u in units:
        facts["units"].setdefault(u, None)
    return facts


def clock_skew(remote_iso: str | None, local_now: dt.datetime) -> int | None:
    """Signed remote-minus-local seconds, or None when the remote clock was not read or
    did not have the ISO-8601 UTC shape the remote script prints."""
    if not remote_iso or not ISO_UTC.match(remote_iso):
        return None
    return int((parse_iso(remote_iso) - local_now).total_seconds())


def parse_canary(text: str) -> dict:
    out: dict = {
        "nonterminal": None,
        "rows_from_seq": None,
        "failed_from_seq": None,
        "max_seq": None,
        "occurrences_top": [],
        "remote_clock": None,
    }
    sec: dict = {}
    cur = None
    for ln in text.splitlines():
        m = re.match(r"^=== (\w+) ===$", ln)
        if m:
            cur = m.group(1)
            sec[cur] = []
        elif cur:
            sec[cur].append(ln.strip())
    if sec.get("clock"):
        out["remote_clock"] = sec["clock"][0]
    if sec.get("nonterminal") and sec["nonterminal"][0].isdigit():
        out["nonterminal"] = int(sec["nonterminal"][0])
    if sec.get("rows"):
        parts = sec["rows"][0].split("|")
        # An empty window yields "0||": COUNT is 0 while SUM and MAX are NULL. Each field is
        # parsed on its own so the observed zero survives and the NULLs stay None.
        if len(parts) == 3:
            out["rows_from_seq"] = int(parts[0]) if parts[0].isdigit() else None
            out["failed_from_seq"] = int(parts[1]) if parts[1].isdigit() else None
            out["max_seq"] = int(parts[2]) if parts[2].isdigit() else None
    for ln in sec.get("occurrences", []):
        parts = ln.split("|")
        if len(parts) == 3:
            out["occurrences_top"].append(parts)
    return out


# ------------------------------------------------------------------------------- file writes


def write_noclobber(path: str, data: bytes, mode: int = 0o600) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def replace_atomic(path: str, data: bytes, mode: int = 0o600) -> None:
    """Write to a fresh temp file in the target directory, then rename over the target."""
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        # Best-effort cleanup of the temp file; the original error is what propagates.
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    dfd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def _relative_under(root: str, value: object, field: str) -> str:
    """A normalized relative path whose real location stays under root."""
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError(f"{field} must be a relative path")
    p = PurePosixPath(value)
    if p.is_absolute() or ".." in p.parts or "." in p.parts or str(p) != value:
        raise ValueError(f"{field} must be a normalized relative path")
    real_root = os.path.realpath(root)
    real = os.path.realpath(os.path.join(root, value))
    if os.path.commonpath([real_root, real]) != real_root:
        raise ValueError(f"{field} escapes the root")
    return value


def read_cursor(root: str) -> dict:
    cur_path = os.path.join(root, "checkpoint", "CURRENT.json")
    with open(cur_path, "rb") as f:
        cur = json.loads(f.read())
    if not isinstance(cur, dict):
        raise ValueError("pointer must be an object")
    gen_rel = _relative_under(root, cur.get("current_generation"), "current_generation")
    gen_path = os.path.join(root, gen_rel)
    gen_sha = sha256_file(gen_path)
    with open(gen_path, "rb") as f:
        gen = json.loads(f.read())
    if not isinstance(gen, dict):
        raise ValueError("generation must be an object")
    if gen_sha != cur.get("generation_sha256"):
        raise ValueError("pointer sha does not match the generation file")
    run_id = gen.get("run_id")
    if not isinstance(run_id, str) or not SAFE_NAME.match(run_id):
        raise ValueError("run_id must be a bounded name")
    interval_block = gen.get("interval")
    if not isinstance(interval_block, dict):
        raise ValueError("generation interval missing")
    prior_end = interval_block.get("end_exclusive_utc")
    if not isinstance(prior_end, str):
        raise ValueError("generation end_exclusive_utc missing")
    parse_iso(prior_end)
    hw = {}
    sources = gen.get("sources")
    if not isinstance(sources, dict):
        raise ValueError("generation sources missing")
    for name in ("whatsapp_q", "whatsapp_personal"):
        src = sources.get(name)
        rows = (src or {}).get("high_water_rows") if isinstance(src, dict) else None
        pks = [
            int(r["pk"])
            for r in (rows or [])
            if isinstance(r, dict) and isinstance(r.get("pk"), int)
        ]
        hw[name] = max(pks, default=0)
    return {
        "generation_file": gen_rel,
        "generation_sha256": gen_sha,
        "run_id": run_id,
        "prior_end_utc": prior_end,
        "high_water": hw,
    }


# ---------------------------------------------------------------------------------- remote


def run_ssh(host: str, script: str, args: list[str], timeout: int) -> dict:
    cmd = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=20",
        host,
        "bash",
        "-s",
        "--",
        *args,
    ]
    try:
        p = subprocess.run(
            cmd, input=script.encode("utf-8"), capture_output=True, timeout=timeout
        )
        return {
            "rc": p.returncode,
            "stdout": p.stdout,
            "stderr": p.stderr,
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "rc": None,
            "stdout": exc.stdout or b"",
            "stderr": exc.stderr or b"",
            "timed_out": True,
        }


class Remote:
    """ssh-backed reads (--live), or fixture-backed reads when --fixture-dir is given."""

    def __init__(self, fixture_dir: str | None, timeout: int):
        self.fixture_dir = fixture_dir
        self.timeout = timeout

    def _fixture(self, name: str) -> dict:
        path = os.path.join(self.fixture_dir or "", name)
        if not os.path.exists(path):
            return {
                "rc": 1,
                "stdout": b"",
                "stderr": f"fixture missing: {name}".encode(),
                "timed_out": False,
            }
        with open(path, "rb") as f:
            return {"rc": 0, "stdout": f.read(), "stderr": b"", "timed_out": False}

    def planes(
        self, host: str, st: int, en: int, jid: str, port: int, units: tuple[str, ...]
    ) -> dict:
        if self.fixture_dir:
            return self._fixture("nucles.out")
        return run_ssh(
            host,
            PLANES_SCRIPT,
            [str(int(st)), str(int(en)), jid, str(int(port)), *units],
            self.timeout,
        )

    def scan(self, host: str, instance: str, st: int, en: int, jid: str) -> dict:
        if self.fixture_dir:
            return self._fixture(f"whatsapp_{instance}.out")
        return run_ssh(
            host, SCAN_SCRIPT, [instance, str(int(st)), str(int(en)), jid], self.timeout
        )

    def canary(self, host: str, instance: str, from_seq: int) -> dict:
        if self.fixture_dir:
            return self._fixture("mini3.out")
        return run_ssh(
            host, CANARY_SCRIPT, [instance, str(int(from_seq))], self.timeout
        )


# ------------------------------------------------------------------------------------ main


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--root",
        default=os.environ.get("BOT_ERRORS_J1_ROOT"),
        help="loop root (checkpoint/, runs/)",
    )
    ap.add_argument(
        "--group-jid",
        default=os.environ.get("BOT_ERRORS_J1_GROUP_JID"),
        help="alert group chat jid",
    )
    ap.add_argument(
        "--alert-host", default=os.environ.get("BOT_ERRORS_J1_ALERT_HOST", "nucles")
    )
    ap.add_argument(
        "--canary-host", default=os.environ.get("BOT_ERRORS_J1_CANARY_HOST", "mini3")
    )
    ap.add_argument(
        "--canary-instance",
        default=os.environ.get("BOT_ERRORS_J1_CANARY_INSTANCE", "yl-bot"),
    )
    ap.add_argument("--canary-from-seq", type=int, default=913)
    ap.add_argument("--health-port", type=int, default=9092)
    ap.add_argument("--overlap-seconds", type=int, default=300)
    ap.add_argument("--slot-minute", type=int, default=17)
    ap.add_argument("--ssh-timeout", type=int, default=120)
    ap.add_argument(
        "--live", action="store_true", help="reach the hosts over ssh (read-only)"
    )
    ap.add_argument(
        "--fixture-dir", default=None, help="read receipts from files instead of ssh"
    )
    ap.add_argument(
        "--now", default=None, help="fixed UTC end (tests): YYYY-MM-DDTHH:MM:SSZ"
    )
    return ap


def validate_args(args) -> str | None:
    """Return a blocking class when an argument could reach a shell or SQL unsafely."""
    if args.fixture_dir is None and not args.live:
        return "live-not-requested"
    if args.fixture_dir is None:
        if not isinstance(args.group_jid, str) or not SAFE_JID.match(args.group_jid):
            return "group-jid-invalid"
        for value in (args.alert_host, args.canary_host, args.canary_instance):
            if not isinstance(value, str) or not SAFE_NAME.match(value):
                return "host-or-instance-invalid"
    if any(not SAFE_UNIT.match(u) for u in DEFAULT_UNITS):
        return "unit-name-invalid"
    if not (0 <= args.slot_minute <= 59):
        return "slot-minute-invalid"
    if args.overlap_seconds < 0 or args.health_port <= 0 or args.canary_from_seq < 0:
        return "numeric-argument-invalid"
    return None


def collect(args, remote: Remote, now: dt.datetime) -> dict:
    root = args.root
    cursor = read_cursor(root)
    iv = interval(cursor["prior_end_utc"], now, args.overlap_seconds)
    run_id = cursor["run_id"]
    out_dir = os.path.join(root, "runs", run_id, "collect")
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    rec_dir = os.path.join(out_dir, stamp)
    os.makedirs(rec_dir, mode=0o700, exist_ok=False)
    failures: list[dict] = []
    receipts: dict = {}

    def keep(name: str, res: dict) -> bool:
        path = os.path.join(rec_dir, name)
        write_noclobber(path, res["stdout"])
        if res["stderr"]:
            write_noclobber(path + ".err", res["stderr"])
        receipts[name] = sha256_file(path)
        ok = (not res["timed_out"]) and res["rc"] == 0
        if not ok:
            failures.append(
                {
                    "receipt": name,
                    "rc": res["rc"],
                    "timed_out": res["timed_out"],
                    "stderr_bytes": len(res["stderr"]),
                }
            )
        return ok

    planes_res = remote.planes(
        args.alert_host,
        iv["start_ts"],
        iv["end_ts"],
        args.group_jid,
        args.health_port,
        DEFAULT_UNITS,
    )
    planes_ok = keep("nucles.out", planes_res)
    planes_text = planes_res["stdout"].decode("utf-8", "replace")
    planes_facts = (
        parse_planes(planes_text, DEFAULT_UNITS) if planes_text.strip() else None
    )
    skew = clock_skew(planes_facts["remote_clock_start"] if planes_facts else None, now)

    scans: dict = {}
    rows_by_instance: dict = {}
    scan_failed = False
    for inst in ("q", "personal"):
        res = remote.scan(
            args.alert_host, inst, iv["start_ts"], iv["end_ts"], args.group_jid
        )
        name = f"whatsapp_{inst}"
        if not keep(f"whatsapp_{inst}.out", res):
            scan_failed = True
            scans[name] = {
                "status": "failed",
                "receipt_sha256": receipts.get(f"whatsapp_{inst}.out"),
            }
            continue
        rows = parse_rows(res["stdout"].decode("utf-8", "replace"))
        rows_by_instance[inst] = rows
        s = summarize(rows, cursor["high_water"][name])
        s.update(
            {
                "status": "collected",
                "prior_high_water_pk": cursor["high_water"][name],
                "page_exhausted": True,
                "receipt_sha256": receipts[f"whatsapp_{inst}.out"],
            }
        )
        scans[name] = s
    scans["gmail"] = {
        "status": "not_collected",
        "reason": "interactive-only source (workspace connector); adjudicator collects it",
    }

    canary_res = remote.canary(
        args.canary_host, args.canary_instance, args.canary_from_seq
    )
    canary_ok = keep("mini3.out", canary_res)
    canary_text = canary_res["stdout"].decode("utf-8", "replace")
    canary_facts = parse_canary(canary_text) if canary_text.strip() else None

    par = (
        parity(rows_by_instance.get("q", []), rows_by_instance.get("personal", []))
        if ("q" in rows_by_instance and "personal" in rows_by_instance)
        else None
    )
    # A failed store scan means the channel itself was not observed: that is `failed`, never
    # the same label as a degraded host plane or an unreachable canary (`partial`).
    if scan_failed:
        status = "failed"
    elif failures or (planes_facts and planes_facts["failed_sections"]):
        status = "partial"
    else:
        status = "collected"
    slot, slot_delta = expected_slot(now, args.slot_minute)
    self_sha = sha256_file(os.path.abspath(__file__))
    bundle = {
        "schema_version": SCHEMA_VERSION,
        "kind": BUNDLE_KIND,
        "redaction": REDACTION,
        "run_id": run_id,
        "complete": False,
        "collection_status": status,
        "collector": {
            "host": socket.gethostname(),
            "pid": os.getpid(),
            "script_sha256": self_sha,
            "started_at_utc": iso(now),
            "completed_at_utc": iso(utc_now()),
            "slot_expected_utc": slot,
            "slot_delta_seconds": slot_delta,
            "mode": "fixture" if remote.fixture_dir else "live",
            "clock_skew_seconds": skew,
            "clock_skew_flag": (skew is not None and abs(skew) > args.overlap_seconds),
        },
        "cursor": {
            k: cursor[k]
            for k in ("generation_file", "generation_sha256", "prior_end_utc")
        },
        "interval": {
            k: iv[k]
            for k in ("start_inclusive_utc", "end_exclusive_utc", "overlap_seconds")
        },
        "sources": scans,
        "planes": {
            "alert_host": {
                "status": (
                    "collected"
                    if planes_ok
                    and planes_facts
                    and not planes_facts["failed_sections"]
                    else "partial"
                    if planes_facts
                    else "failed"
                ),
                "receipt_sha256": receipts.get("nucles.out"),
                "facts": planes_facts,
            },
            "canary": {
                "status": "collected"
                if canary_ok
                else "partial"
                if canary_facts
                else "failed",
                "receipt_sha256": receipts.get("mini3.out"),
                "facts": canary_facts,
            },
        },
        "parity": par,
        "failures": failures,
        "receipt_dir": os.path.relpath(rec_dir, root),
    }
    bundle_path = os.path.join(out_dir, f"collect-{stamp}.json")
    payload = (json.dumps(bundle, indent=1, sort_keys=True) + "\n").encode("utf-8")
    write_noclobber(bundle_path, payload)
    bundle_sha = sha256_bytes(payload)
    result = {
        "bundle": os.path.relpath(bundle_path, root),
        "bundle_sha256": bundle_sha,
        "collection_status": status,
        "failures": len(failures),
        "failed_sections": planes_facts["failed_sections"] if planes_facts else None,
        "sources": {k: v.get("status") for k, v in scans.items()},
        "rows_new": {k: v.get("rows_new") for k, v in scans.items() if "rows_new" in v},
        "clock_skew_seconds": skew,
        "pointer": None,
        "pointer_write_error": None,
    }

    ptr_path = os.path.join(root, "supervision", "COLLECTOR.json")
    try:
        os.makedirs(os.path.dirname(ptr_path), mode=0o700, exist_ok=True)
        prev = None
        if os.path.exists(ptr_path):
            with open(ptr_path, "rb") as f:
                try:
                    prev = json.loads(f.read())
                except ValueError:
                    prev = {"corrupt": True}
        if not isinstance(prev, dict):
            prev = {"corrupt": True} if prev is not None else None
        pointer = {
            "schema_version": SCHEMA_VERSION,
            "kind": POINTER_KIND,
            "current_bundle": os.path.relpath(bundle_path, root),
            "bundle_sha256": bundle_sha,
            "moved_at_utc": iso(utc_now()),
            "slot_expected_utc": slot,
            "collection_status": status,
            "previous_bundle": (prev or {}).get("current_bundle"),
            "previous_sha256": (prev or {}).get("bundle_sha256"),
            "previous_corrupt": bool((prev or {}).get("corrupt")),
        }
        replace_atomic(ptr_path, (json.dumps(pointer, indent=1) + "\n").encode("utf-8"))
        result["pointer"] = os.path.relpath(ptr_path, root)
    except OSError as exc:
        # The bundle exists; a pointer failure is reported, not turned into a crash.
        result["pointer_write_error"] = type(exc).__name__
    return result


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.root or not os.path.isdir(os.path.join(args.root, "checkpoint")):
        print(json.dumps({"verdict": "Blocked", "class": "root-unusable"}))
        return 2
    blocked = validate_args(args)
    if blocked:
        print(json.dumps({"verdict": "Blocked", "class": blocked}))
        return 2
    lock_dir = os.path.join(args.root, "monitors", "state")
    os.makedirs(lock_dir, mode=0o700, exist_ok=True)
    lock_path = os.path.join(lock_dir, ".collect.lock")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(lock_fd)
        print(json.dumps({"verdict": "Skipped", "class": "lock-held"}))
        return 3
    try:
        try:
            now = parse_iso(args.now) if args.now else utc_now()
            result = collect(args, Remote(args.fixture_dir, args.ssh_timeout), now)
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            print(
                json.dumps(
                    {
                        "verdict": "Blocked",
                        "class": "cursor-or-io",
                        "error": type(exc).__name__,
                    }
                )
            )
            return 2
        print(json.dumps({"verdict": "Pass", "redaction": REDACTION, **result}))
        return 0
    finally:
        os.close(lock_fd)


if __name__ == "__main__":
    sys.exit(main())
