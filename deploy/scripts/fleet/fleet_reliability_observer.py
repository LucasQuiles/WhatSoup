#!/usr/bin/env python3
"""Read-only, durable observer for independent Agent365 fleet probes."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import time
from uuid import uuid4


_SUPERVISOR_PATH = Path(__file__).with_name("reliability_supervisor.py")
_SPEC = importlib.util.spec_from_file_location(
    "fleet_observer_supervisor", _SUPERVISOR_PATH
)
supervisor = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = supervisor
_SPEC.loader.exec_module(supervisor)

MAX_OUTPUT = 64 * 1024
CODE = re.compile(r"[a-z0-9][a-z0-9_-]{0,79}")
# Consecutive samples required before an incident opens. At the 900 s launchd
# cadence two samples span at least 15 min between them, so a single stale
# usability sample that recovers on the next cycle never pages.
FALSE_THRESHOLD = 2
NONE_THRESHOLD = 2
# Consecutive failed or stale whole-host probes before <host>_probe_unverified
# opens. It stays critical; the debounce only absorbs a single missed cycle.
PROBE_FAILURE_THRESHOLD = 2
# Consecutive cycles with a failed delivery lookup before the watchdog pages,
# so one dropped SSH connection does not.
RESOLUTION_FAILURE_THRESHOLD = 2
# Per-instance checks the probe stops reporting once <name>_retired is true.
# An explicit list, not a <name>_ prefix, so retiring "personal" never touches
# a "personal_2" instance.
RETIRED_CHECKS = tuple(
    suffix + variant
    for suffix in (
        "persistent",
        "health_readable",
        "whatsapp_connected",
        "primary_model_usable",
    )
    for variant in ("", "_unverified")
)
# Every per-instance check, for an instance the probe no longer lists.
INSTANCE_CHECKS = RETIRED_CHECKS + (
    "configured",
    "configured_unverified",
    "retired",
    "retired_unverified",
)
# Host checks the probe no longer sends. m365_mail_read read a mailbox;
# m365_graph_reachable replaced it on 2026-10-10.
# A host's target may also name checks the owner retired on that host alone,
# such as a retired host's broker checks after its service was stopped on
# 2026-10-11. The probe passes that retired_checks list through, and the
# observer forgets each listed check and clears what it opened, as it does
# for these. A critical clears only on a True read, so a check that can no
# longer pass needs this explicit retirement to clear.
RETIRED_HOST_CHECKS = ("m365_mail_read",)


def initial_state(now):
    return {
        "schema_version": 1,
        "started_at": now,
        "completed_at": None,
        "hosts": {},
        "pending_events": [],
        "alerts": [],
    }


def load_state(path, now):
    try:
        state = supervisor.read_private(path)
    except FileNotFoundError:
        return initial_state(now)
    if (
        state.get("schema_version") != 1
        or not isinstance(state.get("hosts"), dict)
        or not isinstance(state.get("pending_events"), list)
        or not isinstance(state.get("alerts"), list)
        or not all(
            isinstance(record, dict)
            and isinstance(record.get("checks"), dict)
            and isinstance(record.get("incidents"), dict)
            and (
                record.get("unverified") is None
                or isinstance(record.get("unverified"), str)
            )
            for record in state["hosts"].values()
        )
    ):
        raise supervisor.StateError("state_invalid")
    return state


def _lock(directory, name):
    path = directory / name
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        os.close(fd)
        raise supervisor.StateError("lock_unsafe")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd


def _stop_process(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    process.stdout.close()


def run_probe(command, timeout):
    """Return a bounded validated payload, or None without retaining probe output."""
    if (
        not isinstance(command, list)
        or not command
        or not isinstance(command[0], str)
        or not Path(command[0]).is_absolute()
    ):
        return None
    process = None
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        output = bytearray()
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _stop_process(process)
                return None
            readable, _, _ = select.select([process.stdout], [], [], remaining)
            if not readable:
                _stop_process(process)
                return None
            chunk = os.read(
                process.stdout.fileno(), min(4097, MAX_OUTPUT + 1 - len(output))
            )
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > MAX_OUTPUT:
                _stop_process(process)
                return None
        try:
            process.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            _stop_process(process)
            return None
        if process.returncode:
            return None
        value = json.loads(output)
        return validate_probe(value)
    except (OSError, ValueError, TypeError, ProcessLookupError):
        return None
    finally:
        if process is not None:
            if process.poll() is None:
                _stop_process(process)
            if not process.stdout.closed:
                process.stdout.close()


def validate_probe(value):
    if not isinstance(value, dict) or type(value.get("checked_at")) not in (int, float):
        return None
    checks = value.get("checks")
    codes = value.get("codes")
    if not isinstance(checks, dict) or not isinstance(codes, list):
        return None
    safe_checks = {}
    for name, result in checks.items():
        if (
            not isinstance(name, str)
            or not CODE.fullmatch(name)
            or type(result) not in (bool, type(None))
        ):
            return None
        safe_checks[name] = result
    if not all(isinstance(code, str) and CODE.fullmatch(code) for code in codes):
        return None
    checked_at = float(value["checked_at"])
    if checked_at != checked_at or checked_at in (float("inf"), float("-inf")):
        return None
    # Optional: the exact instances the probe was asked to check. Absent from
    # the wrapper's failure payload and from probes that predate the field.
    instances = value.get("instances")
    if instances is not None and (
        not isinstance(instances, list)
        or len(instances) > 64
        or not all(isinstance(i, str) and CODE.fullmatch(i) for i in instances)
    ):
        return None
    # Optional: per check, a stamp of the evidence behind its result (for a
    # bot's primary-model check, the bot's own model_usable_checked_at), so a
    # result read again on a later cycle is not counted as a new failure.
    # Absent from the wrapper's failure payload and from older probes.
    evidence = value.get("evidence", {})
    if not isinstance(evidence, dict) or len(evidence) > 64:
        return None
    for name, stamp in evidence.items():
        # A finite number below 1e16 in magnitude: epoch-millisecond stamps
        # are below 1e13. NaN and infinities fail the comparison too.
        if (
            not isinstance(name, str)
            or not CODE.fullmatch(name)
            or type(stamp) not in (int, float)
            or not abs(stamp) < 1e16
        ):
            return None
    # Optional: the checks retired on this host, from its target. Absent from
    # the wrapper's failure payload, from older probes and from targets that
    # retire nothing.
    retired_checks = value.get("retired_checks", [])
    if (
        not isinstance(retired_checks, list)
        or len(retired_checks) > 64
        or not all(isinstance(c, str) and CODE.fullmatch(c) for c in retired_checks)
    ):
        return None
    return {
        "checked_at": checked_at,
        "checks": safe_checks,
        "codes": codes[:32],
        "instances": instances,
        "evidence": dict(evidence),
        "retired_checks": list(retired_checks),
    }


def _host_state(state, host):
    return state["hosts"].setdefault(
        host["host"], {"checks": {}, "incidents": {}, "unverified": None}
    )


def _capped_severity(host, severity):
    """Lower an alert to the host's optional max_alert_severity; never raise it.

    For a host whose flaps nobody can act on (a machine outside the fleet's
    control), so its alerts stay visible without paging as critical. An
    invalid cap is ignored rather than failing the whole observer run.
    """
    cap = host.get("max_alert_severity")
    if cap is None:
        return severity
    order = supervisor.EVENT_SEVERITIES
    if not isinstance(cap, str) or cap not in order:
        print(
            "fleet observer: ignoring invalid max_alert_severity for host "
            + host["host"],
            file=sys.stderr,
        )
        return severity
    if severity in order and order.index(severity) < order.index(cap):
        return cap
    return severity


def queue_event(state, host, kind, reason, incident_id, now, severity=None):
    severity = severity or ("info" if kind == "clear" else "critical")
    # Every host alert path passes through here; clears keep their severity.
    if kind == "alert":
        severity = _capped_severity(host, severity)
    state["pending_events"].append(
        {
            "event_id": str(uuid4()),
            "incident_id": incident_id,
            "kind": kind,
            "reason": "fleet_" + reason,
            "host": host["host"],
            "instance": host["instance"],
            "created_at": now,
            "severity": severity,
        }
    )


def _open(state, host, record, reason, now, severity="critical"):
    if reason not in record["incidents"]:
        incident_id = str(uuid4())
        record["incidents"][reason] = incident_id
        queue_event(
            state,
            host,
            "alert",
            host["host"] + "_" + reason,
            incident_id,
            now,
            severity,
        )


def _clear(state, host, record, reason, now):
    incident_id = record["incidents"].pop(reason, None)
    if incident_id:
        queue_event(state, host, "clear", host["host"] + "_" + reason, incident_id, now)


def _advance_host(state, host, payload, now, freshness):
    record = _host_state(state, host)
    fresh = payload is not None and 0 <= now - payload["checked_at"] <= freshness
    if not fresh:
        for check_state in record["checks"].values():
            check_state["false_count"] = 0
            check_state["none_count"] = 0
            check_state["false_evidence"] = None
            check_state["last_result"] = None
        # Host records written before probe_failure_count existed load as 0.
        record["probe_failure_count"] = record.get("probe_failure_count", 0) + 1
        if (
            record["unverified"] is None
            and record["probe_failure_count"] >= PROBE_FAILURE_THRESHOLD
        ):
            record["unverified"] = str(uuid4())
            queue_event(
                state,
                host,
                "alert",
                host["host"] + "_probe_unverified",
                record["unverified"],
                now,
            )
        record["last_status"] = "unverified"
        return
    if record["unverified"]:
        queue_event(
            state,
            host,
            "clear",
            host["host"] + "_probe_unverified",
            record["unverified"],
            now,
        )
        record["unverified"] = None
    record["probe_failure_count"] = 0
    record["last_status"] = "fresh"
    record["checked_at"] = payload["checked_at"]
    record["codes"] = payload["codes"]
    # A retired instance's checks are absent, not unknown: clear what they
    # opened and forget them, rather than counting the absence as None.
    retired = {
        check[: -len("retired")] + suffix
        for check, result in payload["checks"].items()
        if check.endswith("_retired") and result is True
        for suffix in RETIRED_CHECKS
    }
    # An instance has left the target list only when a probe that reached the
    # host says so explicitly. A failed probe (wrapper payload, no list) or an
    # unreachable host never removes anything: forget its checks and clear
    # what they opened only on that positive evidence.
    listed = payload.get("instances")
    removed = set()
    if isinstance(listed, list) and payload["checks"].get("ssh_reachable") is True:
        removed = {
            check[: -len("configured")] + suffix
            for check in record["checks"]
            if check.endswith("_configured")
            and check[: -len("_configured")] not in listed
            for suffix in INSTANCE_CHECKS
        }
    # A retired host check is gone only when a probe that reached the host
    # omits it; a failed probe omits every check. A probe that still sends it
    # (a rollback) has it counted as before. A check in the host's own
    # retired_checks is gone whenever a probe that reached the host lists it,
    # even if the probe still sends it: the explicit retirement wins. A name
    # later dropped from the list counts again from zero.
    dropped = set()
    if payload["checks"].get("ssh_reachable") is True:
        dropped = {
            check + variant
            for check in RETIRED_HOST_CHECKS
            if check not in payload["checks"]
            for variant in ("", "_unverified")
        } | {
            check + variant
            for check in payload.get("retired_checks", [])
            for variant in ("", "_unverified")
        }
    forgotten = retired | removed | dropped
    for check in forgotten:
        record["checks"].pop(check, None)
        _clear(state, host, record, check, now)
    for check in (set(record["checks"]) | set(payload["checks"])) - forgotten:
        if check.endswith("_retired"):
            # A marker, not a check: it never alerts, and it is not kept, so
            # it cannot read as unknown once the probe stops sending it.
            record["checks"].pop(check, None)
            continue
        result = payload["checks"].get(check)
        check_state = record["checks"].setdefault(check, {"false_count": 0})
        # State written before none_count existed loads with the counter at 0.
        check_state.setdefault("none_count", 0)
        check_state["last_result"] = result
        stamp = payload.get("evidence", {}).get(check)
        if result is False:
            # One stamped result read on several cycles is one failure: count
            # it again only when its stamp is new. An unstamped failure (an
            # older probe, or a check without evidence) counts on every read.
            # A count left by a release without stamps already includes the
            # bot's current result, so its first stamp is adopted, not counted.
            legacy = (
                "false_evidence" not in check_state and check_state["false_count"] > 0
            )
            if stamp is None or (
                not legacy and stamp != check_state.get("false_evidence")
            ):
                check_state["false_count"] += 1
            check_state["false_evidence"] = stamp
            check_state["none_count"] = 0
            if check_state["false_count"] >= FALSE_THRESHOLD:
                _open(state, host, record, check, now)
        elif result is True:
            check_state["false_count"] = 0
            check_state["none_count"] = 0
            check_state["false_evidence"] = None
            _clear(state, host, record, check, now)
            _clear(state, host, record, check + "_unverified", now)
        else:
            # Unknown is not a failure: it opens only after a sustained run
            # and pages as a warning, never as critical.
            check_state["false_count"] = 0
            check_state["false_evidence"] = None
            check_state["none_count"] += 1
            if check_state["none_count"] >= NONE_THRESHOLD:
                _open(
                    state,
                    host,
                    record,
                    check + "_unverified",
                    now,
                    severity="warning",
                )


def retired_hosts(config):
    """Return the hosts taken out of the observer; refuse a malformed list.

    Each entry names a host and the instance its alerts went to, so its clears
    reach the same place. A host still in hosts as well is a config error.
    """
    retired = config.get("retired_hosts", [])
    if not isinstance(retired, list) or not all(
        isinstance(host, dict)
        and all(
            isinstance(host.get(k), str) and CODE.fullmatch(host[k])
            for k in ("host", "instance")
        )
        for host in retired
    ):
        raise supervisor.StateError("config_invalid")
    both = sorted(
        {host["host"] for host in retired} & {host["host"] for host in config["hosts"]}
    )
    if both:
        print(
            "fleet observer: refusing to run: in both hosts and retired_hosts: "
            + ", ".join(both),
            file=sys.stderr,
        )
        raise supervisor.StateError("config_invalid")
    return retired


def _retire_host(state, host, now):
    """Clear every incident a retired host left open, then forget the host.

    Without this its record, and any incident it had open, would stay forever:
    the observer advances only the hosts it still probes.
    """
    record = state["hosts"].pop(host["host"], None)
    if record is None:
        return
    for reason in list(record["incidents"]):
        _clear(state, host, record, reason, now)
    if record.get("unverified"):
        queue_event(
            state,
            host,
            "clear",
            host["host"] + "_probe_unverified",
            record["unverified"],
            now,
        )


def _resolve(resolve_delivery, alerts):
    """Run a resolver and return its failures; an injected resolver may return None."""
    try:
        return list(resolve_delivery(alerts) or [])
    except Exception:
        return [{"code": "resolver_error", "returncode": None}]


def _record_resolution(state, failures, now):
    previous = state.get("delivery_resolution") or {}
    state["delivery_resolution"] = {
        "checked_at": now,
        "failures": failures[:8],
        "consecutive_failed_cycles": (
            previous.get("consecutive_failed_cycles", 0) + 1 if failures else 0
        ),
    }


def _flush(config, state, path, now, emit, resolve_delivery):
    # The watchdog resolves and records before judging, and passes None here.
    if resolve_delivery is not None:
        _record_resolution(state, _resolve(resolve_delivery, state["alerts"]), now)
    for alert in state["alerts"]:
        alert["delivery_stale"] = (now - alert.get("published_at", now)) > config[
            "freshness_seconds"
        ] and alert.get("delivery") not in supervisor.TERMINAL_DELIVERY
    supervisor.write_private(path, state)
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
                    "published_at": now,
                    "delivery": "locally_persisted",
                    "file": receipt.get("file"),
                }
            )
        else:
            remaining.append(event)
    state["pending_events"] = remaining
    state["alerts"], dropped = supervisor.retain_alerts(
        state["alerts"],
        now,
        # With no answer this cycle, an old alert may still have been delivered.
        drop_aged=not state.get("delivery_resolution", {}).get("failures"),
    )
    supervisor.record_dropped(state, dropped, now)


def run_once(config, *, now=None, probe=None, emit=None, resolve_delivery=None):
    # Refuse a bad retired_hosts list before touching any state.
    retired = retired_hosts(config)
    live_clock = now is None
    now = time.time() if now is None else now
    directory = Path(config["state_dir"])
    supervisor.private_directory(directory)
    fd = _lock(directory, "fleet-observer.lock")
    try:
        path = directory / "fleet-observer.json"
        state = load_state(path, now)
        state["started_at"] = now
        probe_fn = probe or (
            lambda item, limit: run_probe(item["probe_command"], limit)
        )
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [
                (host, pool.submit(probe_fn, host, config["probe_timeout_seconds"]))
                for host in config["hosts"]
            ]
            for host, future in futures:
                try:
                    payload = future.result()
                except Exception:
                    payload = None
                observed_at = time.time() if live_clock else now
                _advance_host(
                    state,
                    host,
                    validate_probe(payload) if payload is not None else None,
                    observed_at,
                    config["freshness_seconds"],
                )
        now = time.time() if live_clock else now
        for host in retired:
            _retire_host(state, host, now)
        _flush(
            config,
            state,
            path,
            now,
            emit
            or (
                lambda event: supervisor.publish_event(
                    {**config, "instance": event["instance"]}, event
                )
            ),
            resolve_delivery
            or (lambda alerts: supervisor.resolve_alert_delivery(config, alerts)),
        )
        state["completed_at"] = now
        supervisor.write_private(path, state)
        return state
    finally:
        os.close(fd)


def run_watchdog(config, *, now=None, emit=None, resolve_delivery=None):
    now = time.time() if now is None else now
    directory = Path(config["state_dir"])
    supervisor.private_directory(directory)
    fd = _lock(directory, "fleet-watchdog.lock")
    try:
        path = directory / "fleet-watchdog.json"
        try:
            state = supervisor.read_private(path)
        except FileNotFoundError:
            state = {
                "schema_version": 1,
                "incidents": {},
                "pending_events": [],
                "alerts": [],
            }
        if (
            state.get("schema_version") != 1
            or not isinstance(state.get("incidents"), dict)
            or not isinstance(state.get("pending_events"), list)
            or not isinstance(state.get("alerts"), list)
        ):
            raise supervisor.StateError("state_invalid")
        observer = None
        try:
            observer = supervisor.read_private(directory / "fleet-observer.json")
            completed = observer.get("completed_at")
            fresh = (
                type(completed) in (int, float)
                and 0 <= now - completed <= config["freshness_seconds"]
            )
        except (FileNotFoundError, supervisor.StateError):
            fresh = False
        conditions = {"observer_stale": not fresh}
        resolver = resolve_delivery or (
            lambda alerts: supervisor.resolve_alert_delivery(config, alerts)
        )
        # Resolve every lookup this cycle makes before judging, so the
        # watchdog's own failures count this cycle, exactly as the observer's do.
        failures = _resolve(resolver, state["alerts"])
        if observer is not None:
            failures = _resolve(resolver, observer.get("alerts", [])) + failures
        _record_resolution(state, failures, now)
        failed_cycles = state["delivery_resolution"]["consecutive_failed_cycles"]
        if observer is not None:
            waiting = [
                a
                for a in observer.get("alerts", [])
                if a.get("delivery") not in supervisor.TERMINAL_DELIVERY
            ] + observer.get("pending_events", [])
            # An alert dropped undelivered stays stale for one freshness window.
            dropped_at = (observer.get("delivery_dropped") or {}).get("last_at")
            conditions["alert_delivery_stale"] = any(
                now - a.get("created_at", now) > config["freshness_seconds"]
                for a in waiting
            ) or (
                type(dropped_at) in (int, float)
                and 0 <= now - dropped_at <= config["freshness_seconds"]
            )
            failed_cycles = max(
                failed_cycles,
                (observer.get("delivery_resolution") or {}).get(
                    "consecutive_failed_cycles", 0
                ),
            )
        conditions["alert_delivery_unresolved"] = (
            failed_cycles >= RESOLUTION_FAILURE_THRESHOLD
        )
        watchdog_instance = config.get("instance") or config["hosts"][0]["instance"]
        for reason, failed in conditions.items():
            if failed and reason not in state["incidents"]:
                incident_id = str(uuid4())
                state["incidents"][reason] = incident_id
                kind = "alert"
            elif not failed and reason in state["incidents"]:
                incident_id = state["incidents"].pop(reason)
                kind = "clear"
            else:
                continue
            state["pending_events"].append(
                {
                    "event_id": str(uuid4()),
                    "incident_id": incident_id,
                    "kind": kind,
                    "reason": "fleet_" + reason,
                    "instance": watchdog_instance,
                    "created_at": now,
                }
            )
        old_dir = config["state_dir"]
        config = {**config, "state_dir": old_dir}
        _flush(
            config,
            state,
            path,
            now,
            emit
            or (
                lambda event: supervisor.publish_event(
                    {**config, "instance": event["instance"]}, event
                )
            ),
            None,
        )
        state["completed_at"] = now
        supervisor.write_private(path, state)
        return state
    finally:
        os.close(fd)


def load_config(path):
    if not path.is_absolute():
        raise supervisor.StateError("config_not_absolute")
    config = supervisor.read_private(path)
    required = ("state_dir", "emitter_command", "delivery_command", "hosts")
    if (
        any(key not in config for key in required)
        or not isinstance(config["hosts"], list)
        or not isinstance(config["state_dir"], str)
        or not Path(config["state_dir"]).is_absolute()
    ):
        raise supervisor.StateError("config_invalid")
    config.setdefault("probe_timeout_seconds", 90)
    config.setdefault("freshness_seconds", 1200)
    if (
        type(config["probe_timeout_seconds"]) not in (int, float)
        or config["probe_timeout_seconds"] <= 0
        or type(config["freshness_seconds"]) not in (int, float)
        or config["freshness_seconds"] <= 0
    ):
        raise supervisor.StateError("config_invalid")
    for host in config["hosts"]:
        if (
            not isinstance(host, dict)
            or not all(
                isinstance(host.get(k), str) and CODE.fullmatch(host[k])
                for k in ("host", "instance")
            )
            or not isinstance(host.get("probe_command"), list)
            or not host["probe_command"]
            or not isinstance(host["probe_command"][0], str)
            or not Path(host["probe_command"][0]).is_absolute()
        ):
            raise supervisor.StateError("config_invalid")
    destination = config.get("instance")
    if (
        destination is not None
        and (not isinstance(destination, str) or not CODE.fullmatch(destination))
    ) or (not destination and not config["hosts"]):
        raise supervisor.StateError("config_invalid")
    for command in (config["emitter_command"], config["delivery_command"]):
        if (
            not isinstance(command, list)
            or not command
            or not isinstance(command[0], str)
            or not Path(command[0]).is_absolute()
        ):
            raise supervisor.StateError("config_invalid")
    retired_hosts(config)
    return config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--watchdog", action="store_true")
    parser.add_argument("--state-dir", help="assert the private config's existing state directory")
    parser.add_argument("--check-config", action="store_true")
    args = parser.parse_args()
    try:
        config = load_config(Path(args.config))
        if args.state_dir is not None and args.state_dir != config["state_dir"]:
            raise supervisor.StateError("state_dir_mismatch")
        if args.check_config:
            print(json.dumps({"config_valid": True}, sort_keys=True))
            return 0
        state = run_watchdog(config) if args.watchdog else run_once(config)
        print(
            json.dumps(
                {
                    "completed_at": state.get("completed_at"),
                    "pending_events": len(state["pending_events"]),
                    "alerts": len(state["alerts"]),
                    "delivery_dropped": state.get("delivery_dropped", {}).get(
                        "total", 0
                    ),
                    "delivery_failed_cycles": state.get("delivery_resolution", {}).get(
                        "consecutive_failed_cycles", 0
                    ),
                },
                sort_keys=True,
            )
        )
        return 0
    except (OSError, ValueError, supervisor.StateError, BlockingIOError):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
