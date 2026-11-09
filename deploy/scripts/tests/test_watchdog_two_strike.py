"""Confirm window for SILENT watchdog health reads.

(The file name is historical: an earlier design kept a strike between runs.)

A silent read is one whose connection was accepted but which got no answer: a
typed transport failure at the response or read stage, or a reader killed at
the wall deadline with no output. Base restarts on it at once. Now, once every
restart gate (permanent stop, pairing lease, restart mutex, cooldown) has
passed, the same run re-reads the target every CONFIRM_STEP_SECONDS until
CONFIRM_WINDOW_SECONDS have passed:

- a trusted answer cancels the restart (RESTART-AVOIDED): the fleet console's
  HTTP status below 400, or a bot body the decision block reads without a
  restart verdict (exits 0, 3, 4, 5, 7);
- every other result continues the window and changes no run state;
- at the window's end the restart runs only while the reader still verifies
  (otherwise the run ends: HEALTH-UNKNOWN, exit 2) and the job's launchd
  identity (load state plus pids) was readable at both ends and is unchanged
  (otherwise it is deferred to the next run); it then goes through
  restart_label again, so every gate is evaluated again then and bootstrap or
  kickstart is chosen then.

Nothing is kept between runs. Refusals and request-stage failures restart at
once, as base.

The rendered template runs under zsh with the credential-tiering Harness. One
ordered event log records every reader call, every confirm sleep and every
launchctl call. The reader stub takes each target's behaviour per read from a
control file and can change the world on a given read (a gate closing during
the window). `sleep` is a stub on the template's PATH, so the shipped 90 s
window runs instantly; it can also fail on cue. A `date` stub, where a test
installs one, advances the clock with each sleep and read. A `python3`
wrapper on the same PATH turns a chosen read, or a chosen binding check, into
a binding failure (the reader's digest check fails). The launchctl stub can
fail a chosen `print` call; exit 113 is launchctl's not-found status.

"Red on base" below means the test fails on the base commit, which restarts on
the first silent read and makes no confirm read.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest
from hypothesis import given, strategies as st

_TESTS = Path(__file__).resolve().parent
if str(_TESTS) not in sys.path:
    sys.path.insert(0, str(_TESTS))

from bot_errors_property_support import private_case, properties  # noqa: E402
from test_watchdog_credential_tiering import (  # noqa: E402
    Harness,
    _dead_body,
    _fallback_unknown_body,
    _iso_now,
    _liveness_ok,
    _recovered_body,
    _unknown_body,
)
from test_watchdog_restart_policy import _health, _run_decision  # noqa: E402

_ZSH = pytest.mark.skipif(shutil.which("zsh") is None, reason="zsh not available")

_TEMPLATE = Path(__file__).resolve().parents[2] / "templates" / "watchdog-script.sh"
_PROJECTIONS = (
    Path(__file__).resolve().parents[2] / "observation-plane" / "outcome-projections.json"
)
_FLEET_LABEL = "com.whatsoup.whatsoup-fleet"
_BOT_PORT = "9999"
_FLEET_PORT = "9998"
_SHIPPED_READS = 6  # 90 s window / 15 s step
_PERMANENT_STOP = "gui = {\n  state = stopped\n  last exit code = 78\n}\n"
_NOT_FOUND = 113  # launchctl print's exit status for a service it cannot find

# Shared by the reader stub and the sleep stub: change the world on cue.
_APPLY = '''
def _apply(ops):
    for op in ops:
        path = Path(op["path"])
        if op["op"] == "write":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(op["text"], encoding="utf-8")
        elif op["op"] == "mkdir":
            path.mkdir(parents=True, exist_ok=True)
        elif op["op"] == "move":
            os.replace(path, op["to"])
'''

# Each target's behaviour per read comes from CONTROL: a list of modes, the
# n-th read of a port using the n-th mode (the last one repeats). Modes:
# "answer" (HTTP 200), "untrusted" (a body the decision block rejects, exit 6),
# "custom" (the control file's body and status), "invalid" (an impossible
# status), "raise" (reader exception, exit 3), "refused" / "exhausted"
# (connect stage), "request" (request stage), "response" / "read" (silent).
# "binding" is served by the python3 wrapper, never reaching this stub.
_READER_STUB = '''
import errno
import json
import os
from pathlib import Path


class HealthTransportError(Exception):
    def __init__(self, stage, number):
        self.stage = stage
        self.errno = number
''' + _APPLY + '''

def fetch_loopback_health(port, path, headers, **kwargs):
    control = json.loads(Path(CONTROL).read_text(encoding="utf-8"))
    events = Path(EVENTS)
    prior = events.read_text(encoding="utf-8").splitlines() if events.exists() else []
    index = sum(row.startswith(f"read {port}/") for row in prior)
    modes = control[str(port)]
    mode = modes[min(index, len(modes) - 1)]
    with events.open("a", encoding="utf-8") as stream:
        stream.write(f"read {port}{path} {mode}\\n")
    _apply(control.get("actions", {}).get(str(port), {}).get(str(index), []))
    if mode == "answer":
        return 200, (BOT_BODY if port == 9999 else "ok")
    if mode == "custom":
        return control["status"], control["body"]
    if mode == "untrusted":
        return 200, json.dumps({"status": "healthy", "whatsapp": []})
    if mode == "invalid":
        return 0, "not an HTTP status"
    if mode == "raise":
        raise ValueError("synthetic reader failure")
    if mode == "refused":
        raise HealthTransportError("connect", errno.ECONNREFUSED)
    if mode == "exhausted":
        raise HealthTransportError("connect", errno.EADDRNOTAVAIL)
    if mode == "request":
        raise HealthTransportError("request", errno.ECONNRESET)
    if mode in ("response", "read"):
        raise HealthTransportError(mode, None)
    raise ValueError("unexpected test mode")
'''

_SLEEP_STUB = '''
import json
import os
import sys
from pathlib import Path
''' + _APPLY + '''
events = Path(EVENTS)
prior = events.read_text(encoding="utf-8").splitlines() if events.exists() else []
number = sum(row.startswith("sleep ") for row in prior) + 1
with events.open("a", encoding="utf-8") as stream:
    stream.write("sleep " + " ".join(sys.argv[1:]) + "\\n")
control = json.loads(Path(CONTROL).read_text(encoding="utf-8"))
_apply(control.get("sleep_actions", {}).get(str(number), []))
raise SystemExit(control.get("sleep_rc", {}).get(str(number), 0))
'''

# An opt-in clock for `date +%s`: a fixed start plus every stubbed sleep plus
# READ_SECONDS per health read so far. Every other `date` call (the log's
# timestamps) goes to the real date.
_DATE_STUB = '''
import os
import sys
from pathlib import Path

if sys.argv[1:] == ["+%s"]:
    events = Path(EVENTS)
    rows = events.read_text(encoding="utf-8").splitlines() if events.exists() else []
    elapsed = sum(int(row.split()[1]) for row in rows if row.startswith("sleep "))
    elapsed += READ_SECONDS * sum(row.startswith("read ") for row in rows)
    print(START + elapsed)
else:
    os.execv("/bin/date", ["/bin/date", *sys.argv[1:]])
'''

# Serves "binding" reads: the reader is pointed at a file whose digest does not
# match, so the template's own binding check fails that read (exit 3).
_PYTHON_WRAPPER = '''
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
if len(args) >= 7 and args[0] == "-c" and args[2] == HELPER and args[5] == "verify":
    # The n-th binding check fails when CONTROL's verify_binding lists n.
    events = Path(EVENTS)
    prior = events.read_text(encoding="utf-8").splitlines() if events.exists() else []
    number = sum(row.startswith("verify ") for row in prior) + 1
    failing = number in json.loads(Path(CONTROL).read_text(encoding="utf-8")).get("verify_binding", [])
    with events.open("a", encoding="utf-8") as stream:
        stream.write(f"verify {number}{' binding' if failing else ''}\\n")
    if failing:
        args[2] = BROKEN
elif len(args) >= 7 and args[0] == "-c" and args[2] == HELPER and args[5] in ("/health", "/livez"):
    port = args[4]
    events = Path(EVENTS)
    prior = events.read_text(encoding="utf-8").splitlines() if events.exists() else []
    index = sum(row.startswith(f"read {port}/") for row in prior)
    modes = json.loads(Path(CONTROL).read_text(encoding="utf-8"))[port]
    if modes[min(index, len(modes) - 1)] == "binding":
        with events.open("a", encoding="utf-8") as stream:
            stream.write(f"read {port}{args[5]} binding\\n")
        args[2] = BROKEN
os.execv(REAL, [REAL, *args])
'''

_LAUNCHCTL_STUB = '''#!/bin/sh
printf '%s\\n' "$*" >> "{events}"
conf="{conf}"
if [ "$1" = print ]; then
  n="$(/usr/bin/grep -c '^print ' "{events}")"
  [ -f "$conf/unload_from" ] && [ "$n" -ge "$(cat "$conf/unload_from")" ] && exit 113
  [ -f "$conf/print_body" ] && cat "$conf/print_body"
  [ -f "$conf/print_rc.$n" ] && exit "$(cat "$conf/print_rc.$n")"
  exit "$(cat "$conf/print_rc" 2>/dev/null || echo 0)"
fi
if [ "$1" = bootstrap ]; then
  exit "$(cat "$conf/bootstrap_rc" 2>/dev/null || echo 0)"
fi
if [ "$1" = kickstart ]; then
  exit "$(cat "$conf/kickstart_rc" 2>/dev/null || echo 0)"
fi
exit 0
'''


def _script(path: Path, body: str, constants: dict[str, str]):
    header = f"#!{sys.executable}\n" + "".join(f"{name} = {value!r}\n" for name, value in constants.items())
    path.write_text(header + body, encoding="utf-8")
    path.chmod(0o755)


class ConfirmHarness(Harness):
    """Harness with per-read reader behaviour, a stub sleep and an ordered event log."""

    def __init__(self, tmp_path: Path, bot_name: str):
        super().__init__(tmp_path, bot_name, _unknown_body())
        self.bot_label = f"com.whatsoup.{bot_name}"
        _script(self.home / ".local" / "bin" / "sleep", _SLEEP_STUB,
                {"EVENTS": str(self.calls), "CONTROL": str(self.control)})

    def write_health_stub(self, bot_body: str, fleet_ok: bool = True, **_unused):
        self.control = self.home / "reader-control.json"
        self.helper = self.home / "health_reader.py"
        self.helper.write_text(
            f"CONTROL = {str(self.control)!r}\n"
            f"EVENTS = {str(self.calls)!r}\n"
            f"BOT_BODY = {bot_body!r}\n" + _READER_STUB,
            encoding="utf-8",
        )
        self.plan(bot=["answer"])
        rendered = (
            _TEMPLATE.read_text(encoding="utf-8")
            # No paging happens here; an absent emitter keeps pages off live outboxes.
            .replace("__BOT_ERRORS_EMIT__", str(self.home / "absent-bot-errors-emit.py"))
            .replace("__HOME__", str(self.home))
            .replace("FLEET_PORT", _FLEET_PORT)
            .replace("BOT_PORT", _BOT_PORT)
            .replace("BOT_NAME", self.bot_name)
            .replace("USERNAME", "tester")
            .replace("__HEALTH_READER_PATH__", str(self.helper))
            .replace("__HEALTH_READER_SHA256__", hashlib.sha256(self.helper.read_bytes()).hexdigest())
        )
        self.script.write_text(rendered, encoding="utf-8")
        self.script.chmod(self.script.stat().st_mode | stat.S_IEXEC)

    def write_launchctl_stub(self, kickstart_rc: int = 0, print_body: str = "", print_rc: int = 0,
                             bootstrap_rc: int = 0, **_unused):
        self.conf = self.home / "launchctl-conf"
        self.conf.mkdir(exist_ok=True)
        (self.conf / "print_body").write_text(print_body, encoding="utf-8")
        for name, value in (("print_rc", print_rc), ("bootstrap_rc", bootstrap_rc), ("kickstart_rc", kickstart_rc)):
            (self.conf / name).write_text(f"{value}\n", encoding="utf-8")
        stub = self.home / ".local" / "bin" / "launchctl"
        stub.write_text(_LAUNCHCTL_STUB.replace("{events}", str(self.calls)).replace("{conf}", str(self.conf)),
                        encoding="utf-8")
        stub.chmod(0o755)

    def plan(self, *, bot: list[str], fleet: list[str] | None = None, body: str | None = None,
             status: int = 200, actions: dict | None = None, sleep_actions: dict | None = None,
             sleep_rc: dict | None = None, verify_binding: list[int] | None = None):
        self.control.write_text(json.dumps({
            _BOT_PORT: bot, _FLEET_PORT: fleet or ["answer"], "body": body, "status": status,
            "actions": actions or {}, "sleep_actions": sleep_actions or {}, "sleep_rc": sleep_rc or {},
            "verify_binding": verify_binding or [],
        }), encoding="utf-8")

    def fail_print(self, call: int, rc: int):
        """The `call`-th launchctl print of the run (any label) exits `rc`."""
        (self.conf / f"print_rc.{call}").write_text(f"{rc}\n", encoding="utf-8")

    def unload_from_print(self, call: int):
        """From the `call`-th launchctl print of the run on, launchctl cannot
        find the job (exit 113): the job is booted out at that moment."""
        (self.conf / "unload_from").write_text(f"{call}\n", encoding="utf-8")

    def lock_released(self) -> bool:
        return not (self.log_dir / f"{self.bot_name}-watchdog.lock").exists()

    def install_clock(self, read_seconds: int):
        _script(self.home / ".local" / "bin" / "date", _DATE_STUB, {
            "EVENTS": str(self.calls), "READ_SECONDS": read_seconds, "START": int(time.time()),
        })

    def install_binding_wrapper(self):
        broken = self.home / "health_reader_changed.py"
        broken.write_text("raise RuntimeError('must never execute')\n", encoding="utf-8")
        _script(self.home / ".local" / "bin" / "python3", _PYTHON_WRAPPER, {
            "HELPER": str(self.helper), "EVENTS": str(self.calls), "CONTROL": str(self.control),
            "BROKEN": str(broken), "REAL": sys.executable,
        })

    def events(self) -> list[str]:
        return self.launchctl_calls().splitlines()

    def reads(self, target: str) -> list[str]:
        port = _BOT_PORT if target == "bot" else _FLEET_PORT
        return [row for row in self.events() if row.startswith(f"read {port}/")]

    def sleeps(self) -> list[str]:
        return [row for row in self.events() if row.startswith("sleep ")]

    def kicks(self, label: str) -> int:
        return sum("kickstart -k" in row and row.endswith(label) for row in self.events())

    def bootstraps(self, label: str) -> int:
        return sum(row.startswith("bootstrap ") and row.endswith(f"{label}.plist") for row in self.events())

    def log_text(self) -> str:
        return self.log.read_text(encoding="utf-8")

    def label(self, target: str) -> str:
        return self.bot_label if target == "bot" else _FLEET_LABEL


def _silent_plan(h: ConfirmHarness, target: str, *, main: str = "response", later: list[str] | None = None,
                 **extra):
    """`target`'s first read is silent (`main`), then `later` per read; the other target answers."""
    sequence = [main, *(later or ["read"])]
    if target == "bot":
        h.plan(bot=sequence, **extra)
    else:
        h.plan(bot=["answer"], fleet=sequence, **extra)


def _index(events: list[str], predicate) -> list[int]:
    return [i for i, row in enumerate(events) if predicate(row)]


def _assert_restart_after_window(h: ConfirmHarness, target: str):
    """The restart action comes after every confirm read and sleep of the window."""
    label = h.label(target)
    events = h.events()
    actions = _index(events, lambda row: ("kickstart -k" in row and row.endswith(label))
                     or (row.startswith("bootstrap ") and row.endswith(f"{label}.plist")))
    port = _BOT_PORT if target == "bot" else _FLEET_PORT
    window = _index(events, lambda row: row.startswith("sleep ") or row.startswith(f"read {port}/"))
    assert actions, events
    assert min(actions) > max(window), events


# --- the rule ------------------------------------------------------------------------

_SILENT_STAGES = st.sampled_from([("bot", "response"), ("bot", "read"), ("fleet", "response"), ("fleet", "read")])


@_ZSH
@properties
@given(case=_SILENT_STAGES, answer_on=st.integers(min_value=1, max_value=_SHIPPED_READS))
def test_answer_within_the_window_avoids_the_restart(case, answer_on):
    # Red on base: base restarts on the silent read.
    target, stage = case
    with private_case() as (tmp_path, monkeypatch):
        h = ConfirmHarness(tmp_path, f"confirm-avoid-{target}-{stage}-bot")
        _silent_plan(h, target, main=stage, later=["read"] * (answer_on - 1) + ["answer"])
        proc = h.run()
        label = h.label(target)
        assert proc.returncode == 0, proc.stderr
        assert h.kicks(label) == 0 and h.bootstraps(label) == 0
        assert h.final_log_state() == "RESTART-AVOIDED"
        assert f"{label} answered on confirm read {answer_on}; restart avoided" in h.log_text()
        assert len(h.reads(target)) == 1 + answer_on
        assert h.sleeps() == ["sleep 15"] * answer_on
        assert "HEALTH-UNKNOWN" not in h.log_text()


@_ZSH
@properties
@given(target=st.sampled_from(["bot", "fleet"]), loaded=st.booleans())
def test_silent_throughout_the_window_restarts_at_its_end_through_the_base_call(target, loaded):
    # Red on base: base acts on the silent read itself, before any confirm read.
    # At the window's end the restart is base's: kickstart for a loaded job,
    # bootstrap (and no kickstart) for an unloaded one.
    with private_case() as (tmp_path, monkeypatch):
        h = ConfirmHarness(tmp_path, f"confirm-end-{target}-{'loaded' if loaded else 'unloaded'}-bot")
        _silent_plan(h, target)
        if not loaded:
            h.write_launchctl_stub(print_rc=_NOT_FOUND, bootstrap_rc=0)
        proc = h.run()
        label = h.label(target)
        assert proc.returncode == 0, proc.stderr
        assert len(h.reads(target)) == 1 + _SHIPPED_READS
        assert h.sleeps() == ["sleep 15"] * _SHIPPED_READS
        assert f"{label} no trusted answer in 90s ({_SHIPPED_READS} confirm reads); restart still due" in h.log_text()
        assert h.kicks(label) == int(loaded)
        assert h.bootstraps(label) == int(not loaded)
        _assert_restart_after_window(h, target)
        assert h.final_log_state() == "RESTARTED"


@_ZSH
@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_binding_failure_during_the_window_never_bootstraps_on_that_read(tmp_path, target):
    # Red on base: base bootstraps the unloaded job on the silent read itself.
    # Silent, binding failure, silent: the binding-failure read only continues
    # the window. The reader verifies again by the window's end and the job is
    # still unloaded, as at the silent read, so the one bootstrap is base's,
    # at the window's end.
    h = ConfirmHarness(tmp_path, f"confirm-binding-{target}-bot")
    _silent_plan(h, target, later=["binding", "read"])
    h.install_binding_wrapper()
    h.write_launchctl_stub(print_rc=_NOT_FOUND, bootstrap_rc=0)
    proc = h.run()
    label = h.label(target)
    assert proc.returncode == 0, proc.stderr
    reads = h.reads(target)
    assert reads[1].endswith(" binding") and len(reads) == 1 + _SHIPPED_READS
    assert f"{label} confirm read 1: no HTTP answer (reader exit 3)" in h.log_text()
    events = h.events()
    after_binding = events[events.index(reads[1]) + 1]
    assert after_binding.startswith("sleep "), events
    assert h.bootstraps(label) == 1 and h.kicks(label) == 0
    _assert_restart_after_window(h, target)
    assert "HEALTH-UNKNOWN" not in h.log_text()
    assert h.final_log_state() == "RESTARTED"


# Every confirm-read result that is not a trusted answer, per target (each list
# fits the property's example budget, so every kind runs).
_BOT_NOT_ANSWERS = ["read", "refused", "request", "exhausted", "invalid", "raise", "untrusted",
                    "empty_body", "token_missing", "binding"]
_FLEET_NOT_ANSWERS = ["read", "refused", "request", "exhausted", "invalid", "raise", "http_503", "binding"]


@_ZSH
@properties
@given(kind=st.sampled_from(_BOT_NOT_ANSWERS))
def test_a_bot_confirm_read_that_is_not_an_answer_continues_the_window(kind):
    # Red on base: base restarts on the silent read.
    assert _check_not_an_answer("bot", kind) == "RESTART-AVOIDED"


@_ZSH
@properties
@given(kind=st.sampled_from(_FLEET_NOT_ANSWERS))
def test_a_fleet_confirm_read_that_is_not_an_answer_continues_the_window(kind):
    # Red on base: base restarts on the silent read.
    assert _check_not_an_answer("fleet", kind) == "RESTART-AVOIDED"


def _check_not_an_answer(target: str, kind: str):
    """Silent, then `kind`, then an answer: `kind` neither restarts nor cancels,
    and leaves no HEALTH-UNKNOWN, ERROR or exit status behind."""
    with private_case() as (tmp_path, monkeypatch):
        h = ConfirmHarness(tmp_path, f"confirm-not-{target}-{kind.replace('_', '-')}-bot")
        extra: dict = {}
        mode = kind
        if kind == "empty_body":
            mode, extra = "custom", {"body": "", "status": 200}
        elif kind == "http_503":
            mode, extra = "custom", {"body": "down", "status": 503}
        elif kind == "token_missing":
            # The token is gone only while confirm read 1 runs.
            hidden = str(h.token_file) + ".hidden"
            mode = "answer"
            extra = {"sleep_actions": {
                "1": [{"op": "move", "path": str(h.token_file), "to": hidden}],
                "2": [{"op": "move", "path": hidden, "to": str(h.token_file)}],
            }}
        later = [mode, "answer"] if kind != "token_missing" else ["answer"]
        _silent_plan(h, target, later=later, **extra)
        if kind == "binding":
            h.install_binding_wrapper()
        proc = h.run()
        label = h.label(target)
        assert proc.returncode == 0, proc.stderr
        assert h.kicks(label) == 0 and h.bootstraps(label) == 0
        assert f"{label} answered on confirm read 2; restart avoided" in h.log_text()
        assert "HEALTH-UNKNOWN" not in h.log_text() and "ERROR" not in h.log_text()
        return h.final_log_state()


def _decision_answer(exit_code: int, bot_name: str) -> tuple[str, int]:
    """(body, HTTP status) that make the decision block exit `exit_code`."""
    if exit_code == 0:
        return _recovered_body(), 200
    if exit_code == 1:
        body = json.loads(_liveness_ok())
        body["whatsapp"]["connected"] = False
        body["whatsapp"]["connection"]["state"] = "close"
        return json.dumps(body), 200
    if exit_code == 3:
        return _dead_body(), 200
    if exit_code == 4:
        return _unknown_body(), 200
    if exit_code == 5:
        return _fallback_unknown_body(), 200
    if exit_code == 6:
        return json.dumps({"status": "healthy", "whatsapp": []}), 200
    assert exit_code == 7, exit_code
    body = json.loads(_liveness_ok())
    body.update(
        status="unhealthy",
        generated_at=_iso_now(),
        instance={"name": bot_name, "pid": 123, "mode": "agent", "fallbackReason": None},
        status_reasons=["agent_runtime_unhealthy", "runtime.outbound_queue_poisoned"],
        degradation_causes=["agent_runtime_unhealthy", "agent_outbound_queue_poisoned"],
        runtime={"agent": {"outboundQueuePoisoned": True, "outboundQueuePoisonedScopes": 1}},
        turn_capability={
            "model_usable": True,
            "model_usable_stale": False,
            "model_usability_status": "usable",
        },
    )
    return json.dumps(body), 503


@_ZSH
@properties
@given(exit_code=st.sampled_from([0, 1, 3, 4, 5, 6, 7]))
def test_a_bot_confirm_read_is_classified_by_the_decision_block(exit_code):
    # Red on base: base restarts on the silent read. Exits 0, 3, 4, 5 and 7
    # cancel the restart; a restart verdict (1) and an untrusted body (6) do
    # not, so every confirm read runs and the restart comes at the window's
    # end. A cancelling answer's own verdict (CREDENTIAL-DEAD for 3) is left to
    # the next run: the marker is not touched here.
    with private_case() as (tmp_path, monkeypatch):
        bot_name = f"confirm-exit{exit_code}-bot"
        h = ConfirmHarness(tmp_path, bot_name)
        body, status = _decision_answer(exit_code, bot_name)
        _silent_plan(h, "bot", later=["custom"], body=body, status=status)
        proc = h.run()
        assert proc.returncode == 0, proc.stderr
        assert f"{h.bot_label} confirm read 1: HTTP {status}, decision exit {exit_code}" in h.log_text()
        assert not h.marker.exists()
        if exit_code in (1, 6):
            assert len(h.reads("bot")) == 1 + _SHIPPED_READS
            assert h.kicks(h.bot_label) == 1
            _assert_restart_after_window(h, "bot")
            assert h.final_log_state() == "RESTARTED"
        else:
            assert len(h.reads("bot")) == 2
            assert h.kicks(h.bot_label) == 0
            assert h.final_log_state() == "RESTART-AVOIDED"


@_ZSH
@properties
@given(case=st.sampled_from([("bot", "refused"), ("bot", "request"), ("fleet", "refused"), ("fleet", "request")]))
def test_refusal_or_request_stage_failure_restarts_at_once(case):
    # Passes on base too: these are not silent reads, so no confirm read and
    # no sleep happen before the restart. Fails if they enter the window.
    target, stage = case
    with private_case() as (tmp_path, monkeypatch):
        h = ConfirmHarness(tmp_path, f"confirm-now-{target}-{stage}-bot")
        _silent_plan(h, target, main=stage, later=["answer"])
        proc = h.run()
        assert proc.returncode == 0, proc.stderr
        assert h.kicks(h.label(target)) == 1
        assert len(h.reads(target)) == 1 and h.sleeps() == []
        assert h.final_log_state() == "RESTARTED"


# --- gates -----------------------------------------------------------------------------

# gate -> (final state, log line, exit status, kickstarts)
_GATES = {
    "cooldown": ("RESTART-SUPPRESSED", "restart suppressed by cooldown", 0, 0),
    "permanent_stop": ("RESTART-SUPPRESSED", "restart suppressed after permanent launchd exit code 78", 0, 0),
    "pairing_lease": ("RESTART-SUPPRESSED", "restart declined: pairing coordination lease held", 0, 0),
    "busy_mutex": ("RESTART-SUPPRESSED", "restart already in progress by another watchdog", 0, 0),
}


def _gate_ops(h: ConfirmHarness, gate: str, label: str) -> list[dict]:
    """File operations that close `gate` for `label`."""
    if gate == "cooldown":
        return [{"op": "write", "path": str(h.log_dir / f"{label}.last-restart"), "text": str(int(time.time()))}]
    if gate == "permanent_stop":
        return [{"op": "write", "path": str(h.conf / "print_body"), "text": _PERMANENT_STOP}]
    if gate == "pairing_lease":
        lease = (h.home / ".local" / "state" / "whatsoup" / "instances" / h.bot_name
                 / "coordination-lease.test.json")
        return [{"op": "write", "path": str(lease), "text": '{"mode":"pairing"}\n'}]
    if gate == "busy_mutex":
        # A fresh lock with no pid stamp reads as another watchdog mid-restart.
        return [{"op": "mkdir", "path": str(h.log_dir / f"{label}.restart.lock")}]
    assert gate == "failed_kickstart", gate
    return [{"op": "write", "path": str(h.conf / "kickstart_rc"), "text": "1\n"}]


def _apply_now(ops: list[dict]):
    for op in ops:
        path = Path(op["path"])
        if op["op"] == "write":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(op["text"], encoding="utf-8")
        else:
            path.mkdir(parents=True, exist_ok=True)


@_ZSH
@properties
@given(target=st.sampled_from(["bot", "fleet"]), gate=st.sampled_from(sorted(_GATES)))
def test_gate_closed_at_the_silent_read_suppresses_without_confirm_reads(target, gate):
    # Passes on base too: a gate that suppresses the restart at the silent read
    # suppresses it here as well, with no confirm read and no sleep. Fails if
    # the window ran before the gates or past a closed one.
    final_state, line, status, kicks = _GATES[gate]
    with private_case() as (tmp_path, monkeypatch):
        h = ConfirmHarness(tmp_path, f"confirm-gate-{target}-{gate.replace('_', '-')}-bot")
        label = h.label(target)
        _silent_plan(h, target)
        _apply_now(_gate_ops(h, gate, label))
        proc = h.run()
        assert proc.returncode == status, proc.stderr
        assert len(h.reads(target)) == 1 and h.sleeps() == []
        assert h.kicks(label) == kicks and h.bootstraps(label) == 0
        assert f"{label} " in h.log_text() and line in h.log_text()
        assert h.final_log_state() == final_state


@_ZSH
@properties
@given(target=st.sampled_from(["bot", "fleet"]),
       gate=st.sampled_from([*sorted(_GATES), "failed_kickstart"]))
def test_gate_closing_during_the_window_acts_as_base_at_its_end(target, gate):
    # Red on base: base restarts on the silent read, before the gate closes.
    # The gate closes on confirm read 3; at the window's end the restart meets
    # it exactly as any restart would.
    final_state, line, status, kicks = _GATES.get(
        gate, ("RESTART-FAILED", "ERROR: kickstart failed", 1, 1))
    with private_case() as (tmp_path, monkeypatch):
        h = ConfirmHarness(tmp_path, f"confirm-closing-{target}-{gate.replace('_', '-')}-bot")
        label = h.label(target)
        port = _BOT_PORT if target == "bot" else _FLEET_PORT
        _silent_plan(h, target, actions={port: {"3": _gate_ops(h, gate, label)}})
        proc = h.run()
        assert proc.returncode == status, proc.stderr
        assert len(h.reads(target)) == 1 + _SHIPPED_READS
        assert h.kicks(label) == kicks and h.bootstraps(label) == 0
        assert line in h.log_text()
        assert h.final_log_state() == final_state


# --- the job and the reader at the window's end ---------------------------------------

_LOADED_PID_123 = "pid = 123\n"


@_ZSH
@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_job_unloaded_during_the_window_is_not_bootstrapped(tmp_path, target):
    # Red on base: base would have kickstarted the loaded job at the silent
    # read. Here the job is booted out during the window, so a restart at its
    # end would bootstrap a job base never bootstrapped on that read: it is
    # deferred to the next run's own read.
    h = ConfirmHarness(tmp_path, f"confirm-unloaded-{target}-bot")
    h.write_launchctl_stub(print_body=_LOADED_PID_123)
    label = h.label(target)
    unload = [{"op": "write", "path": str(h.conf / "print_rc"), "text": f"{_NOT_FOUND}\n"}]
    _silent_plan(h, target, sleep_actions={"3": unload})
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert len(h.reads(target)) == 1 + _SHIPPED_READS
    assert h.kicks(label) == 0 and h.bootstraps(label) == 0
    assert (f"{label} restart deferred: job changed during the confirm window "
            "(at the silent read: loaded, pid 123; now: unloaded)") in h.log_text()
    assert h.final_log_state() == "RESTART-SUPPRESSED"


@_ZSH
@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_job_with_a_new_pid_at_the_window_end_is_not_kickstarted(tmp_path, target):
    # Red on base: base would have kickstarted, at the silent read, the
    # process that read saw. A different process at the window's end (a crash
    # and launchd respawn, or an activation) may still be starting; it is not
    # kickstarted, and the next run's own read decides.
    h = ConfirmHarness(tmp_path, f"confirm-newpid-{target}-bot")
    h.write_launchctl_stub(print_body=_LOADED_PID_123)
    label = h.label(target)
    respawn = [{"op": "write", "path": str(h.conf / "print_body"), "text": "pid = 456\n"}]
    _silent_plan(h, target, sleep_actions={"3": respawn})
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert len(h.reads(target)) == 1 + _SHIPPED_READS
    assert h.kicks(label) == 0 and h.bootstraps(label) == 0
    assert (f"{label} restart deferred: job changed during the confirm window "
            "(at the silent read: loaded, pid 123; now: loaded, pid 456)") in h.log_text()
    assert h.final_log_state() == "RESTART-SUPPRESSED"


@_ZSH
@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_reader_unverifiable_at_the_window_end_takes_no_action(tmp_path, target):
    # Red on base: base would have kickstarted the job at the silent read. The
    # bound reader changes during the window, so every confirm read fails its
    # digest check, and so does the binding check at the window's end: the
    # run ends there with HEALTH-UNKNOWN and exit 2, as for an unverifiable
    # reader at the run's start. The job itself is unchanged, so only the
    # binding check stops it.
    h = ConfirmHarness(tmp_path, f"confirm-unbound-{target}-bot")
    h.write_launchctl_stub(print_body=_LOADED_PID_123)
    label = h.label(target)
    change_reader = [{"op": "write", "path": str(h.helper), "text": "raise RuntimeError('must never execute')\n"}]
    _silent_plan(h, target, sleep_actions={"1": change_reader})
    proc = h.run()
    assert not any(row.startswith(("kickstart", "bootstrap")) for row in h.events()), h.events()
    assert proc.returncode == 2, proc.stderr
    log = h.log_text()
    confirms = [line for line in log.splitlines() if f"{label} confirm read " in line]
    assert len(confirms) == _SHIPPED_READS, log
    assert all(line.endswith("no HTTP answer (reader exit 3)") for line in confirms), confirms
    assert "HEALTH-UNKNOWN: health reader binding unavailable or invalid" in log
    assert h.final_log_state() == "HEALTH-UNKNOWN"
    assert h.lock_released(), "the run ended inside restart_label without releasing its lock"


@_ZSH
def test_reader_unverifiable_at_the_bot_window_end_ends_the_run(tmp_path):
    # Red on base: base kickstarts the bot at the silent read and then restarts
    # the refusing fleet console. Here only the binding check at the bot
    # window's end fails (the run's second check); the reader would verify
    # again at once. The run still ends there, as at its start: HEALTH-UNKNOWN,
    # exit 2, and no fleet read or restart in this run.
    h = ConfirmHarness(tmp_path, "confirm-unbound-exit-bot")
    h.plan(bot=["response", "read"], fleet=["refused"], verify_binding=[2])
    h.install_binding_wrapper()
    proc = h.run()
    events = h.events()
    assert not any(row.startswith(("kickstart", "bootstrap")) for row in events), events
    assert proc.returncode == 2, proc.stderr
    assert h.reads("fleet") == [], events
    assert len(h.reads("bot")) == 1 + _SHIPPED_READS and "verify 2 binding" in events, events
    assert "HEALTH-UNKNOWN: health reader binding unavailable or invalid" in h.log_text()
    assert h.final_log_state() == "HEALTH-UNKNOWN"
    assert h.lock_released(), "the run ended inside restart_label without releasing its lock"


def _identity_prints(h: ConfirmHarness, target: str) -> tuple[list[int], list[int]]:
    """Indexes of every launchctl print and of the target's window (sleeps and
    confirm reads), in the run's event order."""
    port = _BOT_PORT if target == "bot" else _FLEET_PORT
    events = h.events()
    prints = _index(events, lambda row: row.startswith("print "))
    window = _index(events, lambda row: row.startswith("sleep ") or row.startswith(f"read {port}/"))
    return prints, window[1:]


@_ZSH
@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_identity_unreadable_at_the_silent_read_defers_even_after_a_real_unload(tmp_path, target):
    # Red on base: base would have kickstarted the loaded job at the silent
    # read. There the identity read times out (exit 124, not launchctl's
    # not-found 113), and the job is then really booted out during the window.
    # Reading the timeout as "unloaded" would match that unload and bootstrap
    # the job; an unreadable identity defers the restart to the next run.
    h = ConfirmHarness(tmp_path, f"confirm-unread-start-{target}-bot")
    h.write_launchctl_stub(print_body=_LOADED_PID_123)
    h.fail_print(2, 124)
    label = h.label(target)
    unload = [{"op": "write", "path": str(h.conf / "print_rc"), "text": f"{_NOT_FOUND}\n"}]
    _silent_plan(h, target, sleep_actions={"3": unload})
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert h.kicks(label) == 0 and h.bootstraps(label) == 0
    prints, window = _identity_prints(h, target)
    # Print 1 is the first gate pass, print 2 the identity read at the silent read.
    assert len(prints) >= 2 and prints[1] < window[0], h.events()
    assert len(h.reads(target)) == 1 + _SHIPPED_READS
    log = h.log_text()
    assert f"{label} restart deferred: job identity unreadable at the silent read" in log
    assert "job changed" not in log
    assert h.final_log_state() == "RESTART-SUPPRESSED"


@_ZSH
@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_identity_unreadable_at_the_window_end_defers_without_claiming_a_change(tmp_path, target):
    # Red on base: base would have kickstarted the job at the silent read. The
    # job stays loaded with the same pid throughout; only the identity read at
    # the window's end fails (exit 1, not launchctl's not-found 113). That says
    # nothing about the job: the restart is deferred as unreadable, not
    # reported as a job change.
    h = ConfirmHarness(tmp_path, f"confirm-unread-end-{target}-bot")
    h.write_launchctl_stub(print_body=_LOADED_PID_123)
    h.fail_print(3, 1)
    label = h.label(target)
    _silent_plan(h, target)
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert h.kicks(label) == 0 and h.bootstraps(label) == 0
    prints, window = _identity_prints(h, target)
    # Print 2 is the identity read at the silent read, print 3 the one at the window's end.
    assert len(prints) >= 3 and prints[1] < window[0] and prints[2] > window[-1], h.events()
    log = h.log_text()
    assert f"{label} restart deferred: job identity unreadable at the window's end" in log
    assert "job changed" not in log
    assert h.final_log_state() == "RESTART-SUPPRESSED"


@_ZSH
@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_job_unloaded_after_the_window_end_check_is_not_bootstrapped(tmp_path, target):
    # Red on base: base would have kickstarted the loaded job at the silent
    # read. The job reads loaded at both identity reads and is booted out only
    # after the window-end one, while the restart's gates run again. A restart
    # confirmed on a loaded job may only kickstart, so when launchctl no longer
    # finds the job it is deferred, not bootstrapped.
    h = ConfirmHarness(tmp_path, f"confirm-late-unload-{target}-bot")
    h.write_launchctl_stub(print_body=_LOADED_PID_123)
    h.unload_from_print(4)
    label = h.label(target)
    _silent_plan(h, target)
    proc = h.run()
    assert h.kicks(label) == 0 and h.bootstraps(label) == 0, h.events()
    assert proc.returncode == 0, proc.stderr
    prints, window = _identity_prints(h, target)
    # Print 3 is the identity read at the window's end; prints 4 (the second
    # gate pass) and 5 (the restart's own) find the job gone.
    assert len(prints) == 5 and prints[2] > window[-1], h.events()
    log = h.log_text()
    assert f"{label} restart deferred: job not confirmed loaded after the window check" in log
    assert "job changed" not in log and "unreadable" not in log
    assert h.final_log_state() == "RESTART-SUPPRESSED"
    assert not (h.log_dir / f"{label}.restart.lock").exists(), "the deferral kept the restart mutex"


@_ZSH
@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_failed_restart_print_on_a_still_loaded_job_defers_without_bootstrap(tmp_path, target):
    # Red on base: base would have kickstarted the loaded job at the silent
    # read. The job stays loaded with the same pid throughout; only the
    # restart's own launchctl print (print 5) fails, with exit 1 rather than
    # launchctl's not-found 113. A restart confirmed on a loaded job may only
    # kickstart, so any failed print there defers it; nothing is bootstrapped.
    h = ConfirmHarness(tmp_path, f"confirm-late-printfail-{target}-bot")
    h.write_launchctl_stub(print_body=_LOADED_PID_123)
    h.fail_print(5, 1)
    label = h.label(target)
    _silent_plan(h, target)
    proc = h.run()
    assert h.kicks(label) == 0 and h.bootstraps(label) == 0, h.events()
    assert proc.returncode == 0, proc.stderr
    prints, window = _identity_prints(h, target)
    # Prints 2 and 3 are the identity reads (both loaded, pid 123); print 4 is
    # the second gate pass and print 5 the restart's own, the one that fails.
    assert len(prints) == 5 and prints[2] > window[-1], h.events()
    log = h.log_text()
    assert f"{label} restart deferred: job not confirmed loaded after the window check" in log
    assert "job changed" not in log and "unreadable" not in log
    assert h.final_log_state() == "RESTART-SUPPRESSED"
    assert not (h.log_dir / f"{label}.restart.lock").exists(), "the deferral kept the restart mutex"


# --- pacing -----------------------------------------------------------------------------


@_ZSH
@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_window_ends_with_the_first_read_that_finishes_past_its_end(tmp_path, target):
    # Red on base: base makes no confirm read. The clock advances with each
    # sleep and by 8 s per read, as when every read runs to the deadline:
    # confirm reads start 15, 38, 61 and 84 s into the window, and the fourth
    # finishes past 90 s and ends it. Without that check all six would run.
    h = ConfirmHarness(tmp_path, f"confirm-clock-{target}-bot")
    h.install_clock(read_seconds=8)
    label = h.label(target)
    _silent_plan(h, target)
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert len(h.reads(target)) == 1 + 4
    assert h.sleeps() == ["sleep 15"] * 4
    assert f"{label} no trusted answer in 90s (4 confirm reads); restart still due" in h.log_text()
    assert h.kicks(label) == 1
    _assert_restart_after_window(h, target)
    assert h.final_log_state() == "RESTARTED"


@_ZSH
@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_failed_sleep_ends_the_window_and_the_restart_follows(tmp_path, target):
    # Red on base: base restarts on the silent read without sleeping. A sleep
    # that fails cannot pace the reads, so it ends the window: no confirm read
    # follows it, and the restart goes through the window-end checks and every
    # gate, as at any window's end.
    h = ConfirmHarness(tmp_path, f"confirm-sleepfail-{target}-bot")
    label = h.label(target)
    _silent_plan(h, target, sleep_rc={"1": 1})
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert len(h.reads(target)) == 1 and h.sleeps() == ["sleep 15"]
    assert (f"{label} confirm window ended: sleep failed (exit 1) after 0 confirm reads; "
            "restart still due") in h.log_text()
    assert h.kicks(label) == 1
    _assert_restart_after_window(h, target)
    assert h.final_log_state() == "RESTARTED"


# --- the rest of the run --------------------------------------------------------------


@_ZSH
def test_fleet_read_still_runs_after_a_bot_confirm_window(tmp_path):
    # Red on base: base makes no confirm read. The fleet console is read once,
    # after the bot's whole window and restart, as at base after the bot section.
    h = ConfirmHarness(tmp_path, "confirm-order-bot")
    h.plan(bot=["response", "read"], fleet=["answer"])
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    events = h.events()
    fleet_reads = _index(events, lambda row: row.startswith(f"read {_FLEET_PORT}/"))
    bot_window = _index(events, lambda row: row.startswith(f"read {_BOT_PORT}/") or row.startswith("sleep ")
                        or "kickstart -k" in row)
    assert len(fleet_reads) == 1 and len(h.reads("bot")) == 1 + _SHIPPED_READS
    assert fleet_reads[0] > max(bot_window), events
    assert h.final_log_state() == "RESTARTED"


@_ZSH
def test_avoided_restart_ranks_below_a_restart_in_the_same_run(tmp_path):
    # Red on base: base restarts the silent bot too (two kickstarts).
    h = ConfirmHarness(tmp_path, "confirm-ladder-bot")
    h.plan(bot=["response", "answer"], fleet=["refused"])
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert h.kicks(h.bot_label) == 0 and h.kicks(_FLEET_LABEL) == 1
    assert "restart avoided" in h.log_text()
    assert h.final_log_state() == "RESTARTED"


@_ZSH
def test_avoided_restart_outranks_an_error_in_the_same_run(tmp_path):
    # Red on base: base restarts the silent bot. The bot's restart is avoided
    # while the refused fleet console's bootstrap fails (ERROR): the final line
    # is the avoided restart, and the ERROR still sets the exit status.
    h = ConfirmHarness(tmp_path, "confirm-avoid-error-bot")
    h.plan(bot=["response", "answer"], fleet=["refused"])
    h.write_launchctl_stub(print_rc=1, bootstrap_rc=1)
    proc = h.run()
    assert proc.returncode == 1
    assert "ERROR: bootstrap failed for com.whatsoup.whatsoup-fleet" in h.log_text()
    assert h.final_log_state() == "RESTART-AVOIDED"


def _template_constant(name: str) -> int:
    match = re.search(rf"(?m)^{name}=(\d+)$", _TEMPLATE.read_text(encoding="utf-8"))
    assert match, f"{name} missing from the watchdog template"
    return int(match.group(1))


def test_documented_window_arithmetic_matches_the_shipped_constants():
    # Red on base: the constants do not exist there. This checks the docs'
    # arithmetic against the shipped constants; it is not a bound on a whole
    # run (the token and decision steps and ensure_loaded's launchctl print
    # have no deadline). The clock-driven pacing test checks the behaviour.
    # On a steady clock a confirm read is running at the window's end or
    # starts then, so the last one starts no earlier than one read deadline
    # before that end; with a timed-out silent read's own reader timeout
    # before it, that exceeds the longest recorded silence (83.2 s). The
    # documented worst case per target (every read after a full step, as
    # after a backward clock step, plus three launchctl prints and one binding
    # check around the window) is 191 s, and two such windows with the bounded
    # steps around them stay inside the invocation lock's 600 s.
    window = _template_constant("CONFIRM_WINDOW_SECONDS")
    step = _template_constant("CONFIRM_STEP_SECONDS")
    reader_timeout = _template_constant("HEALTH_READ_TIMEOUT_SECONDS")
    deadline = _template_constant("HEALTH_READ_DEADLINE_SECONDS")
    prints = {int(limit) for limit in re.findall(r"run_with_timeout (\d+) launchctl print",
                                                 _TEMPLATE.read_text(encoding="utf-8"))}
    assert prints, "launchctl print limit missing from the watchdog template"
    launchctl_print = max(prints)
    max_reads = -(-window // step)
    assert max_reads == _SHIPPED_READS
    assert 0 < step <= window // 4
    assert window - deadline + reader_timeout > 83.2
    worst_window = max_reads * (step + deadline)
    worst_delay = worst_window + 3 * launchctl_print + deadline
    assert (worst_window, worst_delay) == (138, 191)
    # The run-start binding check, then per target the main read, the first
    # gate pass and a 30 s kickstart: about 500 s, the docs' figure.
    worst_bounded_run = deadline + 2 * (deadline + launchctl_print + worst_delay + 30)
    assert worst_bounded_run == 496 and worst_bounded_run < 600


def test_decision_block_still_extracts_and_runs_after_the_function_wrap():
    # The decision block is now called through bot_decision; the restart-policy
    # suite still extracts and runs it from the template as before.
    assert _run_decision(_health("healthy")) == 0
    assert _run_decision({"status": "healthy", "whatsapp": []}) == 6


# --- the closed wd_rank vocabulary ----------------------------------------------------


def _wd_rank_function() -> str:
    text = _TEMPLATE.read_text(encoding="utf-8")
    match = re.search(r"(?ms)^wd_rank\(\) \{\n.*?^\}\n", text)
    assert match, "wd_rank() missing from the watchdog template"
    return match.group(0)


def _wd_rank_case_states() -> list[str]:
    return re.findall(r"(?m)^\s+([A-Za-z][A-Za-z-]*)\) print \d+ ;;$", _wd_rank_function())


def _wd_ranks(states: list[str]) -> dict[str, int]:
    """Run the template's own wd_rank for each state; the default arm ranks "ok"."""
    script = _wd_rank_function() + 'for state in "$@"; do print -r -- "$state $(wd_rank "$state")"; done\n'
    proc = subprocess.run(
        ["zsh", "-c", script, "wd_rank_probe", *states],
        capture_output=True, text=True, timeout=10, check=True,
    )
    return {name: int(rank) for name, rank in (line.split(" ") for line in proc.stdout.splitlines())}


def _projection_surface() -> dict:
    return json.loads(_PROJECTIONS.read_text(encoding="utf-8"))["surfaces"]["watchdog_wd_rank"]


def test_wd_rank_vocabulary_matches_the_outcome_projection_domain():
    # Red on base for RESTART-AVOIDED; afterwards it fails on any divergence
    # between the template's ladder and the projection's closed domain.
    template_states = set(_wd_rank_case_states())
    assert 'WD_FINAL="ok"' in _TEMPLATE.read_text(encoding="utf-8"), "ok is the default-arm state"
    template_states.add("ok")
    surface = _projection_surface()
    domain = surface["domain"]
    row_values = [row["legacy_value"] for row in surface["rows"]]
    assert len(domain) == len(set(domain))
    assert len(row_values) == len(set(row_values))
    assert set(domain) == template_states
    assert set(row_values) == template_states
    assert "RESTART-AVOIDED" in template_states
    assert "RESTART-DEFERRED" not in template_states


def test_every_noted_state_is_in_the_ranked_vocabulary():
    # Red on base: base never notes RESTART-AVOIDED.
    text = _TEMPLATE.read_text(encoding="utf-8")
    noted = set(re.findall(r"wd_note ([A-Z][A-Z-]*)", text))
    assert "RESTART-AVOIDED" in noted
    assert noted <= set(_wd_rank_case_states())


def test_avoided_state_is_projected_as_an_action_record():
    # Red on base: the projection has no RESTART-AVOIDED row there.
    rows = {row["legacy_value"]: row for row in _projection_surface()["rows"]}
    assert rows["RESTART-AVOIDED"]["canonical"] == "not_applicable"
    assert rows["RESTART-AVOIDED"]["lossy"] is True
    assert rows["RESTART-AVOIDED"]["canonical"] == rows["RESTART-SUPPRESSED"]["canonical"]


@_ZSH
def test_avoided_state_ranks_below_suppressed_and_above_error():
    # Red on base: base has no RESTART-AVOIDED rank.
    ranks = _wd_ranks([*_wd_rank_case_states(), "ok"])
    assert len(set(ranks.values())) == len(ranks), "every state needs its own rank"
    assert ranks["ok"] < ranks["ERROR"] < ranks["RESTART-AVOIDED"] < ranks["RESTART-SUPPRESSED"]
    assert ranks["RESTART-SUPPRESSED"] < ranks["RESTARTED"] < ranks["RESTART-FAILED"] < ranks["HEALTH-UNKNOWN"]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
