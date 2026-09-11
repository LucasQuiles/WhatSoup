#!/usr/bin/env python3
"""BOT ERRORS J1 unattended collector: contract steps 3-8, read-only, no publication.

Runs from launchd on the relay host. It reads the supervision cursor, freezes a half-open
interval, executes the read-only planes over ssh (alert-host units/liveness/monitoring, two
column-scoped store scans, the canary host), classifies the scan, and writes a collection
bundle plus its own pointer (COLLECTOR.json). It never takes the checkpoint lease, never
moves CURRENT.json, never appends the ledger, never sends anything. Collection liveness is
measured by COLLECTOR.json; adjudication liveness stays with CURRENT.json (decision C5).

stdout carries metadata only: counts, statuses, hashes, paths. Message bodies are written to
receipt files under --root and never printed. The interactive-only source (mailbox search via
the workspace connector) is recorded as not_collected so a bundle can never claim it.

Exit 0 after any bundle is written, including a failed one (an alarm that crashes during the
emergency is the failure this collector exists to prevent). Exit 2 only when the root or the
cursor is unusable before a bundle can be written. Exit 3 when another collector holds the lock.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
from collections import Counter, OrderedDict

BUNDLE_SCHEMA = "bot-errors-collect.v1"
POINTER_SCHEMA = "bot-errors-collector-pointer.v1"
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
ROW_START = re.compile(r"^(\d+)\|([0-9A-Fa-f]{12,})\|(\d+)\|")
FIELD = re.compile(r"^\s*[>›]\s*([a-z_]+):\s*(.*)$", re.M)

# Column-scoped scan (contract step 3). Never SELECT *, never immutable=1. Placeholders are
# substituted by str.format on a fixed template; the arguments reach the remote shell as
# positional parameters, not by string interpolation into SQL.
SCAN_SCRIPT = r"""set -u
I="$1"; ST="$2"; EN="$3"; JID="$4"
DB="$HOME/.local/share/whatsoup/instances/$I/bot.db"
sqlite3 -separator '|' "file:$DB?mode=ro" "PRAGMA query_only=ON; SELECT pk,message_id,timestamp,created_at,sender_jid,sender_name,content_type,is_from_me,substr(COALESCE(content_text,content),1,2000) FROM messages WHERE chat_jid='$JID' AND timestamp>=$ST AND timestamp<$EN ORDER BY timestamp,pk;"
"""

# Alert-host planes (contract steps 4-6 plus the C1 per-unit read). Read-only.
PLANES_SCRIPT = r"""set -u
ST="$1"; EN="$2"; JID="$3"; HEALTH_PORT="$4"; shift 4
STATE="$HOME/.local/state/bot-errors"
echo "=== SECTION clock ==="
date -u +%FT%TZ
echo "=== SECTION units-failed-listing ==="
systemctl --user list-units --state=failed --no-legend --plain
echo "=== SECTION units-per-unit ==="
for u in "$@"; do
  echo "--- $u"
  systemctl --user show "$u" -p LoadState,ActiveState,SubState,Result,NRestarts,MainPID,ExecMainStatus,ActiveEnterTimestamp,LastTriggerUSec
done
echo "=== SECTION health ==="
curl -s -o /dev/null -w 'http_code=%{http_code}\n' "http://127.0.0.1:$HEALTH_PORT/health"
echo "=== SECTION liveness ==="
for i in q personal; do
  echo "--- $i"
  sqlite3 "file:$HOME/.local/share/whatsoup/instances/$i/bot.db?mode=ro" "PRAGMA query_only=ON; SELECT MAX(pk), MAX(timestamp) FROM messages;"
done
echo "=== SECTION window-row-counts ==="
for i in q personal; do
  echo "--- $i"
  sqlite3 "file:$HOME/.local/share/whatsoup/instances/$i/bot.db?mode=ro" "PRAGMA query_only=ON; SELECT COUNT(*), MIN(pk), MAX(pk) FROM messages WHERE chat_jid='$JID' AND timestamp>=$ST AND timestamp<$EN;"
done
echo "=== SECTION dispatcher-state ==="
python3 -c 'import json;d=json.load(open("'"$STATE"'/dispatcher-state.json"));print(json.dumps({k:d.get(k) for k in ("cycleCompletedAt","lastError","pid")}))'
echo "=== SECTION incident-state ==="
python3 -c 'import json;d=json.load(open("'"$STATE"'/incident-state.json"));inc=d.get("openIncidents") or {};fs=d.get("flapState") or {};print(json.dumps({"openIncidents_len":len(inc),"flapState_len":len(fs),"updatedAt":d.get("updatedAt")}))'
echo "=== SECTION watchdog-state ==="
python3 -c 'import json;d=json.load(open("'"$STATE"'/heartbeat-watchdog-state.json"));o=d.get("open",{});r=d.get("recentlyRecovered",{});c=d.get("_controllerState",{});print(json.dumps({"open":sorted(o),"recentlyRecovered":sorted(r),"generation":c.get("generation"),"writtenAt":c.get("writtenAt")}))'
echo "=== SECTION queues ==="
for q in outbox processing quarantine sent; do printf '%s=' "$q"; ls -1 "$STATE/$q" | wc -l | tr -d ' '; done
echo "=== SECTION supervision-pointer ==="
sha256sum "$STATE/supervision/CURRENT.json"
stat -c '%Y' "$STATE/supervision/CURRENT.json"
echo "=== SECTION deployed-checkout ==="
git -C "$HOME/LAB/WhatSoup" rev-parse HEAD
git -C "$HOME/LAB/WhatSoup" rev-parse --abbrev-ref HEAD
echo "=== SECTION end ==="
date -u +%FT%TZ
"""

# Canary host (contract step 7). Read-only.
CANARY_SCRIPT = r"""set -u
INST="$1"; FROM_SEQ="$2"
DB="$HOME/.local/share/whatsoup/instances/$INST/bot.db"
echo "=== clock ==="
date -u +%FT%TZ
echo "=== nonterminal ==="
sqlite3 "file:$DB?mode=ro" "PRAGMA query_only=ON; SELECT COUNT(*) FROM inbound_events WHERE processing_status NOT IN ('complete','failed');"
echo "=== rows ==="
sqlite3 "file:$DB?mode=ro" "PRAGMA query_only=ON; SELECT COUNT(*), SUM(CASE WHEN processing_status='failed' THEN 1 ELSE 0 END), MAX(seq) FROM inbound_events WHERE seq>=$FROM_SEQ;"
echo "=== occurrences ==="
sqlite3 "file:$DB?mode=ro" "PRAGMA query_only=ON; SELECT id,state,scheduled_for FROM trigger_occurrences ORDER BY id DESC LIMIT 3;"
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


def expected_slot(now: dt.datetime, slot_minute: int) -> str:
    """The most recent HH:<slot_minute> at or before now, in UTC."""
    candidate = now.replace(minute=slot_minute, second=0)
    if candidate > now:
        candidate -= dt.timedelta(hours=1)
    return iso(candidate)


def parse_rows(text: str) -> list[dict]:
    rows: list[dict] = []
    cur: dict | None = None
    for line in text.splitlines():
        m = ROW_START.match(line)
        if m:
            if cur is not None:
                rows.append(cur)
            parts = line.split("|", 8)
            if len(parts) < 9:
                parts += [""] * (9 - len(parts))
            cur = {
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
        elif cur is not None:
            cur["body"] += "\n" + line
    if cur is not None:
        rows.append(cur)
    return rows


def fields(body: str) -> dict:
    out: dict = {}
    for k, v in FIELD.findall(body):
        out.setdefault(k, v.strip())
    return out


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
        or "flap_storm_resolved=true" in body
    ):
        return "flap_storm_close"
    if "Flap storm:" in head:
        return "flap_storm_open"
    if head.startswith("BOT RECOVERY") or " RECOVERED" in head:
        return "recovery"
    if head.startswith("✅ *") and " resolved " in head:
        return "resolved_lifecycle"
    if (
        "↻" in head
        or "still_open_digest=true" in body
        or "stale_digest=true" in body
        or "ESCALATED still open" in head
        or "Stale incident digest" in head
        or "state: stale" in body
    ):
        return "repeat_renotify"
    if "heartbeat watchdog escalated" in head:
        return (
            "escalation_bypass_renotify"
            if "incident_still_open=true" in body
            else "escalation_new"
        )
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


NOVELTY_EXCLUDED = frozenset(
    {
        "gate_nudge",
        "maclab_probe_post",
        "lane_observation_post",
        "flap_storm_open",
        "flap_storm_close",
        "recovery",
        "resolved_lifecycle",
    }
)


def summarize(rows: list[dict], prior_hw_pk: int) -> dict:
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
    alert_like = per_class.get("alert", 0) + per_class.get("escalation_new", 0)
    repeat_like = per_class.get("repeat_renotify", 0) + per_class.get(
        "escalation_bypass_renotify", 0
    )
    denom = alert_like + repeat_like
    return {
        "rows_scanned": len(rows),
        "rows_new": len(new_rows),
        "dedup_discarded": len(rows) - len(new_rows),
        "min_pk": min((r["pk"] for r in new_rows), default=None),
        "max_pk": max((r["pk"] for r in new_rows), default=None),
        "max_ts": max((r["ts"] for r in new_rows), default=None),
        "per_class": dict(per_class),
        "novelty": {
            "alert_like": alert_like,
            "repeat_like": repeat_like,
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
    return after.split("=== SECTION", 1)[0]


def parse_planes(text: str, units: tuple[str, ...]) -> dict:
    """Metadata facts from the alert-host receipt. Missing sections stay None (never invented)."""
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
    }
    clock = _section(text, "clock").strip().splitlines()
    facts["remote_clock_start"] = clock[0] if clock else None
    end = _section(text, "end").strip().splitlines()
    facts["remote_clock_end"] = end[0] if end else None
    failed = _section(text, "units-failed-listing")
    if "=== SECTION units-failed-listing ===" in text:
        facts["units_failed_listing_rows"] = len(
            [ln for ln in failed.splitlines() if ln.strip()]
        )
    per_unit = _section(text, "units-per-unit")
    cur = None
    for ln in per_unit.splitlines():
        if ln.startswith("--- "):
            cur = ln[4:].strip()
            facts["units"][cur] = {}
        elif cur and "=" in ln:
            k, v = ln.split("=", 1)
            facts["units"][cur][k] = v
    health = re.search(r"http_code=(\d+)", _section(text, "health"))
    facts["health_http_code"] = int(health.group(1)) if health else None
    for name, blob in (("liveness", "liveness"), ("window_rows", "window-row-counts")):
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
        if body:
            try:
                facts[name] = json.loads(body.splitlines()[0])
            except (ValueError, IndexError):
                facts[name] = {"parse_error": True}
    for ln in _section(text, "queues").splitlines():
        if "=" in ln:
            k, v = ln.split("=", 1)
            facts["queues"][k.strip()] = int(v) if v.strip().isdigit() else None
    ptr = _section(text, "supervision-pointer").split()
    if ptr:
        facts["supervision_pointer_sha256"] = ptr[0]
        if len(ptr) >= 3 and ptr[2].isdigit():
            facts["supervision_pointer_mtime"] = int(ptr[2])
    dep = _section(text, "deployed-checkout").split()
    if len(dep) >= 2:
        facts["deployed_head"], facts["deployed_branch"] = dep[0], dep[1]
    for u in units:
        facts["units"].setdefault(u, None)
    return facts


def parse_canary(text: str) -> dict:
    out: dict = {
        "nonterminal": None,
        "rows_from_seq": None,
        "failed_from_seq": None,
        "max_seq": None,
        "occurrences_top": [],
        "remote_clock": None,
    }
    sec = {}
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
        if len(parts) == 3 and all(p.isdigit() for p in parts):
            out["rows_from_seq"], out["failed_from_seq"], out["max_seq"] = map(
                int, parts
            )
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
    tmp = path + ".tmp-" + str(os.getpid())
    write_noclobber(tmp, data, mode)
    os.replace(tmp, path)
    dfd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def read_cursor(root: str) -> dict:
    cur_path = os.path.join(root, "checkpoint", "CURRENT.json")
    with open(cur_path, "rb") as f:
        cur = json.loads(f.read())
    gen_rel = cur["current_generation"]
    gen_path = os.path.join(root, gen_rel)
    gen_sha = sha256_file(gen_path)
    with open(gen_path, "rb") as f:
        gen = json.loads(f.read())
    if gen_sha != cur["generation_sha256"]:
        raise ValueError("pointer sha does not match the generation file")
    hw = {}
    for name in ("whatsapp_q", "whatsapp_personal"):
        rows = (gen.get("sources", {}).get(name, {}) or {}).get("high_water_rows") or []
        hw[name] = max((int(r.get("pk", 0)) for r in rows), default=0)
    return {
        "generation_file": gen_rel,
        "generation_sha256": gen_sha,
        "run_id": gen.get("run_id"),
        "prior_end_utc": gen["interval"]["end_exclusive_utc"],
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
    """ssh-backed reads, or fixture-backed reads when --fixture-dir is given (tests, replays)."""

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
            [str(st), str(en), jid, str(port), *units],
            self.timeout,
        )

    def scan(self, host: str, instance: str, st: int, en: int, jid: str) -> dict:
        if self.fixture_dir:
            return self._fixture(f"whatsapp_{instance}.out")
        return run_ssh(
            host, SCAN_SCRIPT, [instance, str(st), str(en), jid], self.timeout
        )

    def canary(self, host: str, instance: str, from_seq: int) -> dict:
        if self.fixture_dir:
            return self._fixture("mini3.out")
        return run_ssh(host, CANARY_SCRIPT, [instance, str(from_seq)], self.timeout)


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
        "--fixture-dir", default=None, help="read receipts from files instead of ssh"
    )
    ap.add_argument(
        "--now", default=None, help="fixed UTC end (tests): YYYY-MM-DDTHH:MM:SSZ"
    )
    return ap


def collect(args, remote: Remote, now: dt.datetime) -> dict:
    root = args.root
    cursor = read_cursor(root)
    iv = interval(cursor["prior_end_utc"], now, args.overlap_seconds)
    run_id = cursor["run_id"] or "unknown-run"
    out_dir = os.path.join(root, "runs", run_id, "collect")
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    rec_dir = os.path.join(out_dir, stamp)
    os.makedirs(rec_dir, mode=0o700, exist_ok=False)
    failures: list[dict] = []
    receipts: dict = {}

    def keep(name: str, res: dict) -> str | None:
        path = os.path.join(rec_dir, name)
        write_noclobber(path, res["stdout"])
        if res["stderr"]:
            write_noclobber(path + ".err", res["stderr"])
        receipts[name] = sha256_file(path)
        if res["timed_out"] or res["rc"] != 0:
            failures.append(
                {
                    "receipt": name,
                    "rc": res["rc"],
                    "timed_out": res["timed_out"],
                    "stderr_bytes": len(res["stderr"]),
                }
            )
            return None
        return path

    planes_res = remote.planes(
        args.alert_host,
        iv["start_ts"],
        iv["end_ts"],
        args.group_jid,
        args.health_port,
        DEFAULT_UNITS,
    )
    planes_path = keep("nucles.out", planes_res)
    planes_facts = (
        parse_planes(planes_res["stdout"].decode("utf-8", "replace"), DEFAULT_UNITS)
        if planes_path
        else None
    )

    scans: dict = {}
    rows_by_instance: dict = {}
    for inst in ("q", "personal"):
        res = remote.scan(
            args.alert_host, inst, iv["start_ts"], iv["end_ts"], args.group_jid
        )
        path = keep(f"whatsapp_{inst}.out", res)
        name = f"whatsapp_{inst}"
        if path is None:
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
    canary_path = keep("mini3.out", canary_res)
    canary_facts = (
        parse_canary(canary_res["stdout"].decode("utf-8", "replace"))
        if canary_path
        else None
    )

    par = (
        parity(rows_by_instance.get("q", []), rows_by_instance.get("personal", []))
        if ("q" in rows_by_instance and "personal" in rows_by_instance)
        else None
    )
    status = (
        "failed" if len(failures) >= 3 else ("partial" if failures else "collected")
    )
    self_sha = sha256_file(os.path.abspath(__file__))
    bundle = {
        "schema_version": BUNDLE_SCHEMA,
        "run_id": run_id,
        "complete": False,
        "collection_status": status,
        "collector": {
            "host": socket.gethostname(),
            "pid": os.getpid(),
            "script_sha256": self_sha,
            "started_at_utc": iso(now),
            "completed_at_utc": iso(utc_now()),
            "slot_expected_utc": expected_slot(now, args.slot_minute),
            "mode": "launchd-shadow",
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
                "status": "collected" if planes_path else "failed",
                "receipt_sha256": receipts.get("nucles.out"),
                "facts": planes_facts,
            },
            "canary": {
                "status": "collected" if canary_path else "failed",
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

    ptr_path = os.path.join(root, "supervision", "COLLECTOR.json")
    os.makedirs(os.path.dirname(ptr_path), mode=0o700, exist_ok=True)
    prev = None
    if os.path.exists(ptr_path):
        with open(ptr_path, "rb") as f:
            try:
                prev = json.loads(f.read())
            except ValueError:
                prev = {"corrupt": True}
    pointer = {
        "schema_version": POINTER_SCHEMA,
        "current_bundle": os.path.relpath(bundle_path, root),
        "bundle_sha256": bundle_sha,
        "moved_at_utc": iso(utc_now()),
        "slot_expected_utc": bundle["collector"]["slot_expected_utc"],
        "collection_status": status,
        "previous_bundle": (prev or {}).get("current_bundle"),
        "previous_sha256": (prev or {}).get("bundle_sha256"),
    }
    replace_atomic(ptr_path, (json.dumps(pointer, indent=1) + "\n").encode("utf-8"))
    return {
        "bundle": os.path.relpath(bundle_path, root),
        "bundle_sha256": bundle_sha,
        "pointer": os.path.relpath(ptr_path, root),
        "collection_status": status,
        "failures": len(failures),
        "sources": {k: v.get("status") for k, v in scans.items()},
        "rows_new": {k: v.get("rows_new") for k, v in scans.items() if "rows_new" in v},
    }


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.root or not os.path.isdir(os.path.join(args.root, "checkpoint")):
        print(json.dumps({"verdict": "Blocked", "class": "root-unusable"}))
        return 2
    if not args.group_jid and not args.fixture_dir:
        print(json.dumps({"verdict": "Blocked", "class": "group-jid-missing"}))
        return 2
    lock_dir = os.path.join(args.root, "monitors", "state")
    os.makedirs(lock_dir, mode=0o700, exist_ok=True)
    lock_path = os.path.join(lock_dir, ".collect.lock")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print(json.dumps({"verdict": "Skipped", "class": "lock-held"}))
        return 3
    try:
        now = parse_iso(args.now) if args.now else utc_now()
        try:
            result = collect(args, Remote(args.fixture_dir, args.ssh_timeout), now)
        except (OSError, ValueError, KeyError) as exc:
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
        print(json.dumps({"verdict": "Pass", **result}))
        return 0
    finally:
        os.close(lock_fd)


if __name__ == "__main__":
    sys.exit(main())
