#!/usr/bin/env python3
"""Bounded Agent365 liveness supervisor, independent of the service event loop."""

from __future__ import annotations

import argparse
from datetime import datetime
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import time
import urllib.error
import urllib.request
from uuid import uuid4
from urllib.parse import urlsplit, quote


class StateError(RuntimeError):
    pass


def private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise StateError("state_directory_unsafe")
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        raise StateError("state_directory_not_private")


def read_private(path: Path) -> dict:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
            or metadata.st_size > 1024 * 1024
        ):
            raise StateError("state_file_unsafe")
        with os.fdopen(fd, closefd=False) as stream:
            result = json.load(stream)
        if not isinstance(result, dict):
            raise StateError("state_invalid")
        return result
    except (ValueError, TypeError) as exc:
        raise StateError("state_invalid") from exc
    finally:
        os.close(fd)


def write_private(path: Path, value: dict) -> None:
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, sort_keys=True, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def probe_liveness(url: str, timeout: float = 5) -> dict:
    start = time.monotonic()
    result = {"ok": False, "code": "unavailable"}
    try:
        request = urllib.request.Request(url, headers={"X-Request-ID": uuid4().hex})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(4097)
            payload = json.loads(body) if len(body) <= 4096 else {}
            result = {
                "ok": response.status == 200 and payload.get("status") == "ok",
                "code": "ok" if payload.get("status") == "ok" else "body_degraded",
                "http_status": response.status,
            }
    except (TimeoutError, socket.timeout):
        result["code"] = "timeout"
    except urllib.error.URLError as exc:
        result["code"] = (
            "timeout" if isinstance(exc.reason, TimeoutError) else "unavailable"
        )
    except (ValueError, AttributeError):
        result["code"] = "invalid_response"
    result["latency_ms"] = round((time.monotonic() - start) * 1000, 2)
    return result


def maintenance_active(path: Path) -> bool:
    # Never create the service's maintenance lock or alter its ownership.
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise StateError("maintenance_lock_unsafe")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def run_command(command: list[str], timeout: float) -> subprocess.CompletedProcess:
    if not command or not Path(command[0]).is_absolute():
        raise StateError("command_not_absolute")
    return subprocess.run(command, capture_output=True, timeout=timeout, check=False)


def restart_service(config: dict) -> dict:
    # The runtime holds maintenance.lock for its lifetime. The cutover controller
    # owns controller.lock; sharing that lease prevents concurrent deployment.
    fd = os.open(config["controller_lock"], os.O_RDWR | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if (
            metadata.st_uid != os.getuid()
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
        ):
            raise StateError("maintenance_lock_unsafe")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _restart_locked(config)
    finally:
        os.close(fd)


def _restart_locked(config: dict) -> dict:
    plist = Path(config["plist_path"])
    if hashlib.sha256(plist.read_bytes()).hexdigest() != config["plist_sha256"]:
        raise StateError("service_configuration_changed")
    observed = run_command(["/bin/launchctl", "print", config["service_target"]], 5)
    text = observed.stdout.decode(errors="replace")
    program = re.search(r"^\s*program = (.+)$", text, re.MULTILINE)
    if (
        observed.returncode
        or program is None
        or program[1] != config["expected_program"]
    ):
        raise StateError("service_identity_unverified")
    result = run_command(config["restart_command"], 45)
    if result.returncode:
        raise StateError("service_restart_failed")
    after = run_command(["/bin/launchctl", "print", config["service_target"]], 5)
    old_pid = re.search(r"^\s*pid = (\d+)$", text, re.MULTILINE)
    new_pid = re.search(
        r"^\s*pid = (\d+)$", after.stdout.decode(errors="replace"), re.MULTILINE
    )
    return {
        "old_pid": int(old_pid[1]) if old_pid else None,
        "new_pid": int(new_pid[1]) if new_pid else None,
    }


EVENT_SEVERITIES = ("critical", "error", "warning", "info")


def event_severity(event: dict) -> str:
    # Events queued before severity was recorded (older state files) and
    # events from callers that never set it keep the original mapping.
    if event["kind"] == "clear":
        return "info"
    severity = event.get("severity")
    return severity if severity in EVENT_SEVERITIES else "critical"


def publish_event(config: dict, event: dict) -> dict:
    command = [
        *config["emitter_command"],
        "--instance",
        config["instance"],
        "--source",
        "agent365-reliability-" + event["reason"],
        "--event-id",
        event["event_id"],
        "--event-type",
        event["kind"],
        "--severity",
        event_severity(event),
        "--summary",
        "Agent365 " + event["reason"].replace("_", " "),
        "--diagnostic",
        "incident_id=" + event["incident_id"],
        "--print-path",
    ]
    try:
        result = run_command(command, 15)
        if result.returncode:
            return {"published": False}
        output = result.stdout.decode().strip()
        return {
            "published": True,
            "event_id": event["event_id"],
            "file": Path(output).name,
        }
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return {"published": False}


def initial_state(now: float) -> dict:
    return {
        "schema_version": 1,
        "started_at": now,
        "completed_at": None,
        "consecutive_failures": 0,
        "restart_attempts": [],
        "restart_result": None,
        "restart_started_at": None,
        "incident_id": None,
        "budget_alerted": False,
        "pending_events": [],
        "alerts": [],
        "liveness": {"ok": False, "code": "not_probed"},
        "observation": {
            "started_at": now,
            "probe_count": 0,
            "failed_probes": 0,
            "max_probe_gap_seconds": 0,
        },
    }


def load_state(path: Path, now: float) -> dict:
    try:
        state = read_private(path)
    except FileNotFoundError:
        return initial_state(now)
    if (
        state.get("schema_version") != 1
        or type(state.get("consecutive_failures")) is not int
        or not isinstance(state.get("restart_attempts"), list)
        or not all(type(x) in (int, float) for x in state["restart_attempts"])
        or not isinstance(state.get("pending_events"), list)
        or not isinstance(state.get("alerts"), list)
    ):
        raise StateError("state_invalid")
    return state


def queue_event(state: dict, kind: str, reason: str, now: float) -> None:
    state["pending_events"].append(
        {
            "event_id": str(uuid4()),
            "incident_id": state["incident_id"],
            "kind": kind,
            "reason": reason,
            "created_at": now,
        }
    )


def _advance(config, state, now, probe, restart, emit, maintenance, path):
    observation = state.setdefault(
        "observation",
        {
            "started_at": now,
            "probe_count": 0,
            "failed_probes": 0,
            "max_probe_gap_seconds": 0,
        },
    )
    if state.get("completed_at") is not None:
        observation["max_probe_gap_seconds"] = max(
            observation["max_probe_gap_seconds"], now - state["completed_at"]
        )
    observation["probe_count"] += 1
    state["started_at"] = now
    write_private(path, state)
    state["liveness"] = probe(config["live_url"], 5)
    state["maintenance"] = maintenance()
    # Future timestamps stay in the budget after a backwards clock adjustment.
    state["restart_attempts"] = [t for t in state["restart_attempts"] if now - t < 3600]
    if state["liveness"]["ok"]:
        state["consecutive_failures"] = 0
        if state["incident_id"]:
            queue_event(state, "clear", "broker_unresponsive", now)
            if state["budget_alerted"]:
                queue_event(state, "clear", "restart_budget_exhausted", now)
            state["incident_id"] = None
            state["budget_alerted"] = False
    else:
        observation["failed_probes"] += 1
        last_restart = state.get("restart_started_at")
        in_grace = last_restart is not None and now - last_restart < config.get(
            "startup_grace_seconds", 120
        )
        if not in_grace:
            state["consecutive_failures"] += 1
        if state["consecutive_failures"] >= 3 and not state["incident_id"]:
            state["incident_id"] = str(uuid4())
            queue_event(state, "alert", "broker_unresponsive", now)
        if (
            state["consecutive_failures"] >= 3
            and not in_grace
            and not state["maintenance"]
        ):
            if len(state["restart_attempts"]) < 2:
                state["restart_attempts"].append(now)
                state["restart_started_at"] = now
                state["consecutive_failures"] = 0
                state["restart_result"] = "reserved"
                write_private(path, state)
                try:
                    state["restart_details"] = restart()
                    state["restart_result"] = "command_succeeded"
                except Exception:
                    state["restart_result"] = "failed"
            elif not state["budget_alerted"]:
                queue_event(state, "alert", "restart_budget_exhausted", now)
                state["budget_alerted"] = True
    write_private(path, state)
    remaining = []
    for event in state["pending_events"]:
        try:
            receipt = emit(event)
        except Exception:
            receipt = {"published": False}
        if receipt.get("published") is True:
            state["alerts"].append(
                {
                    **event,
                    "delivery": "locally_persisted",
                    "published_at": now,
                    "file": receipt.get("file"),
                }
            )
        else:
            remaining.append(event)
    state["pending_events"] = remaining
    state["alerts"] = state["alerts"][-128:]
    state["completed_at"] = now
    write_private(path, state)
    return state


def run_once(
    config, *, now=None, probe=None, restart=None, emit=None, maintenance=None
):
    now = time.time() if now is None else now
    directory = Path(config["state_dir"])
    private_directory(directory)
    lock_fd = os.open(
        directory / "supervisor.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = directory / "supervisor.json"
        state = load_state(path, now)
        return _advance(
            config,
            state,
            now,
            probe or probe_liveness,
            restart or (lambda: restart_service(config)),
            emit or (lambda event: publish_event(config, event)),
            maintenance
            or (lambda: maintenance_active(Path(config["controller_lock"]))),
            path,
        )
    finally:
        os.close(lock_fd)


def observe(config: dict, *, now=None) -> dict:
    now = time.time() if now is None else now
    try:
        state = read_private(Path(config["state_dir"]) / "supervisor.json")
        completed = state.get("completed_at")
        age = now - completed if type(completed) in (int, float) else None
        status = "fresh" if age is not None and 0 <= age <= 90 else "stale"
        alerts = state.get("alerts", [])
        relay = config.get("bot_errors_state_dir")
        for alert in alerts:
            name = alert.get("file")
            if relay and name and Path(name).name == name:
                matches = list((Path(relay) / "relayed").glob(name + ".*.relayed"))
                if matches:
                    alert["delivery"] = "collector_acknowledged"
        return {
            "schema_version": 1,
            "observed_at": now,
            "supervisor": {"status": status, "heartbeat_age_seconds": age},
            "liveness": state["liveness"],
            "restart_attempts_last_hour": len(
                [t for t in state["restart_attempts"] if now - t < 3600]
            ),
            "restart_result": state.get("restart_result"),
            "incident_id": state.get("incident_id"),
            "pending_alerts": len(state["pending_events"]),
            "alerts": alerts[-10:],
            "restart_details": state.get("restart_details"),
            "observation": state.get("observation"),
            "worker": observe_file(
                config.get("worker_heartbeat"), now, max_age=120, milliseconds=True
            ),
            "capabilities": observe_file(
                str(Path(config["state_dir"]) / "capabilities.json"), now, max_age=660
            ),
        }
    except (OSError, ValueError, StateError, KeyError, TypeError):
        return {
            "schema_version": 1,
            "observed_at": now,
            "supervisor": {"status": "unavailable"},
        }


def observe_file(filename, now, *, max_age, milliseconds=False):
    if not filename:
        return {"status": "unavailable"}
    try:
        value = read_private(Path(filename))
        timestamp = (
            value.get("timestamp") if milliseconds else value.get("completed_at")
        )
        age = now - timestamp / (1000 if milliseconds else 1)
        return {
            **value,
            "status": "fresh" if 0 <= age <= max_age else "stale",
            "heartbeat_age_seconds": age,
        }
    except (OSError, TypeError, ValueError, StateError):
        return {"status": "unavailable"}


def sentinel_conditions(snapshot, *, now=None):
    now = time.time() if now is None else now
    reasons = []
    if snapshot.get("supervisor", {}).get("status") != "fresh":
        reasons.append("supervisor_stale")
    worker = snapshot.get("worker", {})
    if worker.get("status") != "fresh":
        reasons.append("mail_worker_stale")
    if worker.get("unknownCount", 0) > 0:
        reasons.append("mail_outcome_unknown")
    if worker.get("oldestQueuedAgeMs", 0) > 900000:
        reasons.append("mail_queue_blocked")
    capabilities = snapshot.get("capabilities", {})
    if capabilities.get("status") != "fresh":
        reasons.append("capability_probe_stale")
    elif not capabilities.get("token", {}).get("ok"):
        reasons.append("token_unavailable")
    elif capabilities.get("mail", {}).get("ok") is False:
        reasons.append("mail_capability_unavailable")
    if (
        capabilities.get("status") == "fresh"
        and capabilities.get("readiness", {}).get("ok") is False
    ):
        reasons.append("broker_not_ready")
    dropped_at = snapshot.get("delivery_dropped_at")
    if any(
        now - a.get("published_at", now) > 900
        and a.get("delivery") not in TERMINAL_DELIVERY
        for a in snapshot.get("alerts", [])
    ) or (type(dropped_at) in (int, float) and 0 <= now - dropped_at <= 900):
        # An alert dropped undelivered is stale for one window, then forgotten.
        reasons.append("alert_delivery_stale")
    if snapshot.get("delivery_resolution"):
        reasons.append("alert_delivery_unresolved")
    return reasons


def remote_observation(config):
    result = run_command(config["observe_command"], 20)
    if result.returncode or len(result.stdout) > 1024 * 1024:
        raise StateError("remote_observation_failed")
    snapshot = json.loads(result.stdout)
    snapshot["delivery_resolution"] = resolve_alert_delivery(
        config, snapshot.get("alerts", [])
    )
    return snapshot


def recovery_confirmed(reason, snapshot, *, now):
    """Missing or stale observations cannot prove an incident has recovered."""
    if snapshot.get("status") == "unavailable":
        return False
    if reason == "remote_observation_unavailable":
        return "supervisor" in snapshot
    surface = {
        "supervisor_stale": "supervisor",
        "mail_worker_stale": "worker",
        "capability_probe_stale": "capabilities",
    }.get(reason)
    if surface:
        return snapshot.get(surface, {}).get("status") == "fresh"
    capability = {
        "broker_not_ready": "readiness",
        "token_unavailable": "token",
        "mail_capability_unavailable": "mail",
    }.get(reason)
    if capability:
        observed = snapshot.get("capabilities", {})
        return (
            observed.get("status") == "fresh"
            and observed.get(capability, {}).get("ok") is True
        )
    if reason in {"mail_outcome_unknown", "mail_queue_blocked"}:
        worker = snapshot.get("worker", {})
        field = (
            "unknownCount" if reason == "mail_outcome_unknown" else "oldestQueuedAgeMs"
        )
        value = worker.get(field)
        limit = 0 if reason == "mail_outcome_unknown" else 900000
        return (
            worker.get("status") == "fresh"
            and type(value) is int
            and 0 <= value <= limit
        )
    if reason == "alert_delivery_stale":
        return isinstance(
            snapshot.get("alerts"), list
        ) and "alert_delivery_stale" not in sentinel_conditions(snapshot, now=now)
    if reason == "alert_delivery_unresolved":
        return snapshot.get("delivery_resolution") == []
    return False


# Receipt statuses where the dispatcher has taken a final decision that the
# operator already sees: suppression, or a storm digest sent in the event's
# place. quarantined, dead_lettered and test_leak_dropped are deliberately
# absent: the dispatcher pages for only one envelope error code (and throttles
# that), so those alerts may have reached no one. They stay undelivered, page
# as stale, and are retired by age, counted.
DISPATCHER_DISPOSITIONS = {
    "suppressed": "dispatcher_suppressed",
    "storm_collapsed": "dispatcher_collapsed",
}
TERMINAL_DELIVERY = frozenset({"channel_delivered", *DISPATCHER_DISPOSITIONS.values()})
# The receipts script refuses more than 128 ids per call.
DELIVERY_BATCH = 128
TERMINAL_ALERTS_RETAINED = 128
# Undelivered alerts are retired by age (an alert with no receipt after a day
# will not get one) and by count (at most four 15 s delivery calls per cycle,
# and state well under read_private's 1 MiB limit).
MAX_UNDELIVERED_ALERTS = 512
MAX_UNDELIVERED_AGE_SECONDS = 86400


def _resolve_batch(config, batch):
    try:
        delivery = run_command(
            [*config["delivery_command"], *(a["event_id"] for a in batch)], 15
        )
    except (OSError, subprocess.TimeoutExpired, StateError):
        return {"code": "command_failed", "returncode": None}
    if delivery.returncode:
        return {"code": "nonzero_exit", "returncode": delivery.returncode}
    if len(delivery.stdout) >= 65536:
        return {"code": "output_oversized", "returncode": None}
    try:
        receipts = json.loads(delivery.stdout)
    except ValueError:
        receipts = None
    if not isinstance(receipts, dict):
        return {"code": "invalid_output", "returncode": None}
    for alert in batch:
        receipt = receipts.get(alert["event_id"])
        if not isinstance(receipt, dict):
            continue
        if receipt.get("status") in {"sent", "email_delivered"}:
            alert["delivery"] = "channel_delivered"
            alert["delivery_receipt"] = receipt
        elif receipt.get("status") in DISPATCHER_DISPOSITIONS:
            alert["delivery"] = DISPATCHER_DISPOSITIONS[receipt["status"]]
    return None


def resolve_alert_delivery(config, alerts):
    """Resolve undelivered alerts in batches; return one failure per failed batch.

    A failure keeps only a fixed code and the exit status, never ids or output.
    """
    if not config.get("delivery_command"):
        return []
    undelivered = [
        a
        for a in alerts
        if a.get("delivery") not in TERMINAL_DELIVERY
        and re.fullmatch(r"[0-9a-f-]{36}", str(a.get("event_id", "")))
    ]
    failures = []
    for start in range(0, len(undelivered), DELIVERY_BATCH):
        failure = _resolve_batch(config, undelivered[start : start + DELIVERY_BATCH])
        if failure:
            failures.append(failure)
    return failures


def retain_alerts(alerts, now, *, drop_aged=True):
    """Keep the newest terminal alerts and a bounded set of undelivered ones.

    Returns the kept alerts in their original order and how many undelivered
    alerts were dropped, so the caller can surface every drop. A caller whose
    delivery lookup failed this cycle passes drop_aged=False: with no answer,
    an old alert may still have been delivered, so only the count cap applies.
    """
    terminal = [a for a in alerts if a.get("delivery") in TERMINAL_DELIVERY]
    undelivered = [
        a
        for a in alerts
        if a.get("delivery") not in TERMINAL_DELIVERY
        and (
            not drop_aged
            or now - a.get("published_at", now) <= MAX_UNDELIVERED_AGE_SECONDS
        )
    ]
    keep = {id(a) for a in terminal[-TERMINAL_ALERTS_RETAINED:]}
    keep |= {id(a) for a in undelivered[-MAX_UNDELIVERED_ALERTS:]}
    kept = [a for a in alerts if id(a) in keep]
    dropped = len(alerts) - len(kept) - max(0, len(terminal) - TERMINAL_ALERTS_RETAINED)
    return kept, dropped


def record_dropped(state, dropped, now):
    if dropped:
        record = state.setdefault("delivery_dropped", {"total": 0})
        record["total"] += dropped
        record["last_at"] = now


def run_sentinel(config, *, now=None, observe_remote=None, emit=None):
    now = time.time() if now is None else now
    directory = Path(config["state_dir"])
    private_directory(directory)
    fd = os.open(
        directory / "sentinel.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = directory / "sentinel.json"
        try:
            state = read_private(path)
        except FileNotFoundError:
            state = {"incidents": {}, "counts": {}, "pending_events": [], "alerts": []}
        try:
            snapshot = (observe_remote or (lambda: remote_observation(config)))()
            snapshot["delivery_resolution"] = [
                *snapshot.get("delivery_resolution", []),
                *resolve_alert_delivery(config, state["alerts"]),
            ]
            snapshot["alerts"] = [*snapshot.get("alerts", []), *state["alerts"]]
            snapshot["delivery_dropped_at"] = state.get("delivery_dropped", {}).get(
                "last_at"
            )
            reasons = set(sentinel_conditions(snapshot, now=now))
        except Exception:
            snapshot = {"status": "unavailable"}
            reasons = {"remote_observation_unavailable"}
        for reason in set(state["counts"]) | reasons:
            state["counts"][reason] = (
                state["counts"].get(reason, 0) + 1 if reason in reasons else 0
            )
            if (
                state["counts"][reason]
                >= (1 if reason == "mail_outcome_unknown" else 2)
                and reason not in state["incidents"]
            ):
                state["incidents"][reason] = str(uuid4())
                state["incident_id"] = state["incidents"][reason]
                queue_event(state, "alert", reason, now)
            elif (
                reason not in reasons
                and reason in state["incidents"]
                and recovery_confirmed(reason, snapshot, now=now)
            ):
                state["incident_id"] = state["incidents"].pop(reason)
                queue_event(state, "clear", reason, now)
        state["snapshot"] = snapshot
        write_private(path, state)
        pending = []
        for event in state["pending_events"]:
            receipt = (emit or (lambda e: publish_event(config, e)))(event)
            if receipt.get("published"):
                state["alerts"].append(
                    {
                        **event,
                        "published_at": now,
                        "delivery": "locally_persisted",
                        "file": receipt.get("file"),
                    }
                )
            else:
                pending.append(event)
        state["pending_events"] = pending
        state["alerts"], dropped = retain_alerts(
            state["alerts"],
            now,
            drop_aged=snapshot.get("delivery_resolution") == [],
        )
        record_dropped(state, dropped, now)
        state["completed_at"] = now
        write_private(path, state)
        return state
    finally:
        os.close(fd)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def capability_request(url, bearer, *, method="GET", timeout=10, body=None):
    started = time.monotonic()
    request_id = str(uuid4())
    telemetry = {"ok": False, "code": "unavailable", "request_id": request_id}
    payload = {}
    try:
        request = urllib.request.Request(
            url,
            data=None if body is None else json.dumps(body).encode(),
            method=method,
            headers={
                "Authorization": "Bearer " + bearer,
                "Content-Type": "application/json",
                "X-Request-ID": request_id,
                "client-request-id": request_id,
            },
        )
        with urllib.request.build_opener(NoRedirect).open(
            request, timeout=timeout
        ) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError("response_too_large")
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("response_invalid")
            telemetry.update(
                ok=response.status == 200, code="ok", http_status=response.status
            )
    except urllib.error.HTTPError as exc:
        telemetry.update(code="http_error", http_status=exc.code)
        try:
            raw = exc.read(1024 * 1024 + 1)
            value = json.loads(raw) if len(raw) <= 1024 * 1024 else {}
            payload = value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            pass
    except (TimeoutError, socket.timeout):
        telemetry["code"] = "timeout"
    except urllib.error.URLError as exc:
        telemetry["code"] = (
            "timeout" if isinstance(exc.reason, TimeoutError) else "unavailable"
        )
    except (TypeError, ValueError):
        telemetry["code"] = "invalid_response"
    except (OSError, http.client.HTTPException):
        telemetry["code"] = "transport_error"
    telemetry["latency_ms"] = round((time.monotonic() - started) * 1000, 2)
    return telemetry, payload


def token_renewed(previous, current):
    try:
        old = datetime.fromisoformat(previous.replace("Z", "+00:00"))
        new = datetime.fromisoformat(current.replace("Z", "+00:00"))
        return (new - old).total_seconds() > 300
    except (AttributeError, TypeError, ValueError):
        return False


def run_capabilities(config):
    if config.get("legacy_sent_items_probe") is not True:
        return {"legacy_sent_items_probe": {"enabled": False, "status": "disabled"}}
    directory = Path(config["state_dir"])
    private_directory(directory)
    fd = os.open(
        directory / "capabilities.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = directory / "capabilities.json"
        try:
            previous = read_private(path)
        except FileNotFoundError:
            previous = {}
        output = {
            "started_at": time.time(),
            "token": {"ok": False, "code": "not_probed"},
        }
        try:
            mcp = json.loads(Path(config["mcp_config"]).read_text())["mcpServers"][
                "microsoft_365"
            ]["env"]
            base = mcp["MS365_AGENT365_BASE_URL"].rstrip("/")
            origin = urlsplit(base)
            if (
                origin.scheme != "http"
                or origin.hostname != "127.0.0.1"
                or origin.path
                or origin.username
                or origin.password
                or origin.query
                or origin.fragment
            ):
                raise StateError("broker_origin_invalid")
            security = shutil.which("security")
            if security is None:
                output["token"]["code"] = "credential_unavailable"
                raise StateError("credential_unavailable")
            key = run_command(
                [
                    security,
                    "find-generic-password",
                    "-s",
                    mcp["MS365_AGENT365_KEYCHAIN_SERVICE"],
                    "-a",
                    mcp["MS365_AGENT365_KEYCHAIN_ACCOUNT"],
                    "-w",
                    mcp["MS365_AGENT365_KEYCHAIN"],
                ],
                8,
            )
            if key.returncode:
                output["token"]["code"] = "credential_unavailable"
                raise StateError("credential_unavailable")
            bearer = key.stdout.decode().strip()
            account = mcp["MS365_AGENT365_ACCOUNT_ID"]
            output["readiness"], ready = capability_request(
                base + "/ready", bearer, timeout=8
            )
            output["readiness"]["status"] = ready.get("status", "unavailable")
            output["readiness"]["reason_codes"] = [
                code
                for code in ready.get("reason_codes", [])
                if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,80}", code)
            ][:32]
            output["event_loop"] = ready.get("event_loop", {"status": "unavailable"})
            output["token"], token = capability_request(
                base + "/accounts/" + quote(account, safe="") + "/tokens/graph",
                bearer,
                method="POST",
                timeout=25,
                body={"profile": "user-full-v1"},
            )
            if output["token"]["ok"]:
                if (
                    token.get("account", {}).get("id") != account
                    or not isinstance(token.get("access_token"), str)
                    or not token["access_token"]
                ):
                    output["token"].update(ok=False, code="token_identity_invalid")
                else:
                    output["token"]["expires_at"] = token.get("expires_at")
                    output["mail"], _ = capability_request(
                        "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$top=1&$select=id",
                        token["access_token"],
                    )
        except Exception:
            output["probe_error"] = "capability_probe_failed"
        output["completed_at"] = time.time()
        old_expiry = previous.get("last_successful_token_expiry") or previous.get(
            "token", {}
        ).get("expires_at")
        expiry = output["token"].get("expires_at")
        output["last_successful_token_expiry"] = expiry or old_expiry
        output["token_renewals_observed"] = previous.get(
            "token_renewals_observed", 0
        ) + int(token_renewed(old_expiry, expiry))
        output["successful_probes"] = previous.get("successful_probes", 0) + int(
            output["token"]["ok"]
        )
        output["failed_probes"] = previous.get("failed_probes", 0) + int(
            not output["token"]["ok"]
        )
        write_private(path, output)
        return output
    finally:
        os.close(fd)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--observe", action="store_true")
    parser.add_argument("--sentinel", action="store_true")
    parser.add_argument("--capabilities", action="store_true")
    args = parser.parse_args()
    try:
        config = read_private(args.config)
        if args.capabilities:
            output = run_capabilities(config)
        elif args.sentinel:
            result = run_sentinel(config)
            output = {
                "completed_at": result["completed_at"],
                "incidents": sorted(result["incidents"]),
                "pending_alerts": len(result["pending_events"]),
            }
        elif args.observe:
            output = observe(config)
        else:
            run_once(config)
            output = observe(config)
        print(json.dumps(output, sort_keys=True))
        return 0
    except Exception:
        print(
            json.dumps(
                {"event": "supervisor_failed", "code": "probe_or_state_unavailable"}
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
