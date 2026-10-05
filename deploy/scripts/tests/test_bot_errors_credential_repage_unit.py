"""Dead-credential re-page: the cases that need a name the change adds.

The behaviour cases are in test_bot_errors_credential_repage.py, and import
nothing new, so that each of them fails at an assertion on the unchanged code.
The cases here import the new module, run the new acknowledge command, or put
a fault into a function that exists only with the change. This file lands with
the change and is proven by mutants.

It takes the rig, the event builders and the contract literals from the
behaviour file. The same rules hold: one function per variant, named
test_t<case>_...; a stub records and the test body asserts; `Rig.cycle` returns
what `run_once` raised; no `pytest.raises`; a child process is started with
`sys.executable` and the environment the test inherited.

The acknowledge command stamps the real clock, so the cases that run it place
the rig's clock at the real time.
"""
from __future__ import annotations

import importlib.util
import json
import os
import signal
import subprocess
import sys
import time as real_time
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

import test_bot_errors_credential_repage as cases  # noqa: E402

_SCRIPTS_DIR = _TESTS_DIR.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from lib import credential_repage, durable_json  # noqa: E402
from lib.state_files import CREDENTIAL_ACK  # noqa: E402

_CLI = _SCRIPTS_DIR / "bot-errors-credential-ack.py"

T0 = cases.T0
INTERVAL = cases.INTERVAL
DEAD, MANUAL, UNUSABLE_30 = cases.DEAD, cases.MANUAL, cases.UNUSABLE_30

# What the acknowledge command says when it refuses.
NO_OPEN_CONDITION = "no open condition for"
SEVERAL_OPEN_CONDITIONS = "more than one open condition for"
STATE_UNREADABLE = "cannot be read"
NO_INCIDENT_STATE = "no incident state under"


# The rig fixture of the other file: one directory per test under /tmp, removed when the test ends,
# and the check that the dispatcher dropped no event as a test leak. cases.Rig
# sets BOT_ERRORS_FLEET_SENTINEL_HOSTS to a path inside that directory, never to an empty value: an
# unset one would read the developer's roster.
make_rig = cases.make_rig


class StateReadDeadline(Exception):
    pass


@pytest.mark.parametrize("reader", ["acknowledgements", "conditions"])
@pytest.mark.parametrize("kind", ["missing-root", "missing", "regular", "readable", "fifo",
                                 "directory", "symlink", "bad-json", "non-object"])
def test_t19_state_readers_classify_files_without_waiting_for_a_writer(tmp_path, monkeypatch, reader, kind):
    root = tmp_path / "state"
    if kind != "missing-root":
        root.mkdir(mode=0o700)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    cli = load_cli("credential_ack_state_reader")
    path = root / ("credential-ack.json" if reader == "acknowledgements" else "incident-state.json")
    entries = {"hosta|synthetic-bot": {"ackedAt": 100, "by": "operator"}}
    payload = entries if reader == "acknowledgements" else {
        "credentialConditions": {"hosta|synthetic-bot": {"openedAt": 100, "members": {}}}}
    if kind in ("regular", "readable"):
        path.write_text(json.dumps(payload), encoding="utf-8")
        path.chmod(0o644 if kind == "readable" else 0o600)
    elif kind == "fifo":
        os.mkfifo(path, 0o600)
    elif kind == "directory":
        path.mkdir()
    elif kind == "symlink":
        target = tmp_path / "outside-state.json"
        target.write_text(json.dumps(payload), encoding="utf-8")
        target.chmod(0o600)
        path.symlink_to(target)
    elif kind in ("bad-json", "non-object"):
        path.write_text("{broken" if kind == "bad-json" else "[]", encoding="utf-8")
        path.chmod(0o600)

    def expired(signum, frame):
        raise StateReadDeadline()

    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
    previous = signal.signal(signal.SIGALRM, expired)
    deadline_fired = False
    refused = False
    result = None
    try:
        signal.setitimer(signal.ITIMER_REAL, 1.0)
        try:
            result = (credential_repage.read_acknowledgements(path) if reader == "acknowledgements"
                      else cli.open_conditions("synthetic-bot", None))
        except StateReadDeadline:
            deadline_fired = True
        except cli.Refused:
            refused = True
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)

    assert not deadline_fired, f"{reader} blocked on {kind} state instead of classifying it"
    if reader == "acknowledgements":
        assert not refused
        expected = ((entries, False) if kind in ("regular", "readable")
                    else ({}, kind not in ("missing-root", "missing")))
        assert result == expected
    elif kind in ("regular", "readable"):
        assert not refused and result == ["hosta|synthetic-bot"]
    else:
        assert refused


def raising_for(real: Callable[..., Any], wanted: str) -> Callable[..., Any]:
    """`real`, except that a call which is given `wanted` raises: an event with that id, or that scope key."""

    def wrapped(*args, **kwargs):
        for value in (*args, *kwargs.values()):
            if value == wanted or (isinstance(value, dict) and value.get("id") == wanted):
                raise RuntimeError("a fault put into the class by the test")
        return real(*args, **kwargs)

    return wrapped


# ---------------------------------------------------------------------------
# The observer and the timer pass: cost, and the boundary of a fault.
# ---------------------------------------------------------------------------


def test_t56b_the_observer_lists_the_outbox_once_and_reads_each_file_once(make_rig):
    bots = ["bot-1", "bot-2", "bot-3"]
    rig = make_rig(fleet=cases.roster(*[("hosta", bot) for bot in bots]))
    rig.clock.set(T0)
    for index in range(1997):
        rig.put(cases.plain_event("routine_note", "hostb", f"filler-{index:04d}", T0 - 100, severity="warning"))
    for bot in bots:
        rig.put(cases.observer_event(MANUAL, "hosta", bot, T0))
    listings: list[int] = []
    reads: dict[str, int] = {}
    real_list, real_read = credential_repage.outbox_files, credential_repage.read_event

    def counted_list(*args, **kwargs):
        found = real_list(*args, **kwargs)
        listings.append(len(found))
        return found

    def counted_read(path, *args, **kwargs):
        name = Path(path).name
        reads[name] = reads.get(name, 0) + 1
        return real_read(path, *args, **kwargs)

    rig.monkeypatch.setattr(credential_repage, "outbox_files", counted_list)
    rig.monkeypatch.setattr(credential_repage, "read_event", counted_read)
    assert rig.cycle() is None
    assert listings == [2000]
    assert (len(reads), sorted(set(reads.values()))) == (2000, [1])
    assert rig.open_scopes() == [f"hosta|{bot}" for bot in bots]


def test_t65_a_fault_in_the_observers_per_event_function_costs_that_event_only(make_rig):
    rig = make_rig(fleet=cases.ROSTER_THREE)
    rig.clock.set(T0)
    first = rig.put(cases.watchdog_event(DEAD, "hosta", "bot-one", T0))
    faulty = rig.put(cases.observer_event(MANUAL, "hostb", "bot-two", T0))
    third = rig.put(cases.observer_event(UNUSABLE_30, "hostc", "bot-three", T0))
    rig.monkeypatch.setattr(credential_repage, "observe_event",
                            raising_for(credential_repage.observe_event, faulty))
    assert rig.cycle() is None
    # Every group alert of the cycle went out, the faulty event's own included.
    assert [len(rig.group_for(event_id)) for event_id in (first, faulty, third)] == [1, 1, 1]
    # The other members are recorded.
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.members("hostc|bot-three") == [UNUSABLE_30]
    assert rig.members("hostb|bot-two") == []
    assert rig.page_times() == [T0]
    assert sorted(set(rig.logged("passFault"))) == [True]


def test_t66_a_fault_in_the_timer_pass_for_one_entry_leaves_the_others_paged_and_keeps_its_outcome(make_rig):
    rig = make_rig(fleet=cases.ROSTER_THREE)
    rig.clock.set(T0)
    rig.put(cases.watchdog_event(DEAD, "hosta", "bot-one", T0))
    rig.put(cases.observer_event(MANUAL, "hostb", "bot-two", T0))
    rig.put(cases.observer_event(MANUAL, "hostc", "bot-three", T0))
    assert rig.cycle() is None
    assert len(rig.page_times()) == 3
    real = credential_repage.evaluate_entry
    failing = raising_for(real, "hosta|bot-one")

    # The next pass fails for one entry. The outcome of its accepted page is not applied yet;
    # the other two are, and the cycle records its completion.
    rig.monkeypatch.setattr(credential_repage, "evaluate_entry", failing)
    assert rig.cycle_at(T0 + 60) is None
    assert ("stamp", "") in cases.last_cycle(rig)
    counts = [rig.entry(scope).get("count") for scope in cases.THREE_SCOPES]
    assert (not counts[0], counts[1:]) == (True, [1, 1])
    assert sorted(set(rig.logged("passFault"))) == [True]

    # The pass after that works: the waiting outcome is still there and is applied.
    rig.monkeypatch.setattr(credential_repage, "evaluate_entry", real)
    rig.cycle_at(T0 + 120)
    entry = rig.entry("hosta|bot-one")
    assert (entry.get("count"), entry.get("lastAcceptedAt")) == (1, T0)

    # The fault returns when the next pages are due: the other two are paged.
    rig.monkeypatch.setattr(credential_repage, "evaluate_entry", failing)
    due = T0 + INTERVAL
    assert rig.cycle_at(due) is None
    assert ("stamp", "") in cases.last_cycle(rig)
    assert [rig.page_times(where) for where in ("hosta/bot-one", "hostb/bot-two", "hostc/bot-three")] == [
        [T0], [T0, due], [T0, due]]


def test_t89_an_entry_that_fails_in_every_cycle_is_announced_once_a_day_and_keeps_its_legacy_copy(make_rig):
    rig = make_rig()
    rig.monkeypatch.setattr(credential_repage, "evaluate_entry",
                            raising_for(credential_repage.evaluate_entry, "hosta|bot-one"))
    rig.clock.set(T0)
    rig.put(cases.observer_event(MANUAL, "hosta", "bot-one", T0))
    rig.put(cases.watchdog_event(DEAD, "hostb", "bot-two", T0))
    for offset in (0, 60, 120):
        assert rig.cycle_at(T0 + offset) is None
    # The observer recorded both; the other condition is paged, the failing one is not.
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert rig.page_times("hostb/bot-two") == [T0]
    assert rig.page_times("hosta/bot-one") == []
    # The failing scope's routed opener keeps its legacy copy: no page was accepted for that
    # scope and no hold applies. The other opener's copy was dropped for its accepted page.
    assert cases.copy_heads(rig) == [f"hosta/bot-one: {cases.ROUTED_TITLE[MANUAL]}"]
    # One group meta-alert in the UTC day, however many cycles failed; one more on the next day.
    assert len(rig.meta_alerts(cases.META_PASS_ERROR)) == 1
    rig.cycle_at(T0 + cases.DAY)
    assert len(rig.meta_alerts(cases.META_PASS_ERROR)) == 2


# ---------------------------------------------------------------------------
# The member list: every re-auth observer source has a class.
# ---------------------------------------------------------------------------

# The re-auth observer's catalog of diagnoses, each with the class this change gives it. The
# observer is not imported here: a diagnosis it adds later has no class until this table names it.
DIAGNOSES = {
    "reauth_needed_manual": credential_repage.OPENER,
    "credential_present_runtime_unusable": credential_repage.OPENER_DELAYED,
    "indeterminate_investigate": credential_repage.SUSTAIN,
    "public_liveness_only": credential_repage.SUSTAIN,
    "public_liveness_degraded": credential_repage.SUSTAIN,
    "probe_unsupported_provider_stuck": credential_repage.NOT_MEMBER,
    "probe_diverges_from_turn_execution": credential_repage.NOT_MEMBER,
    "recovery_stuck_restart": credential_repage.NOT_MEMBER,
    "probe_gated_fallback_stuck": credential_repage.NOT_MEMBER,
    "non_auth_degraded_escalate": credential_repage.NOT_MEMBER,
    "health_degraded_non_fallback": credential_repage.NOT_MEMBER,
    "all_clear": credential_repage.NOT_MEMBER,
}


def test_t29_every_observer_source_has_a_class_and_a_mismatch_takes_the_class_beneath_it():
    # Emitted bare: every pageable diagnosis. `all_clear` is not pageable, and the mismatch
    # always carries the diagnosis beneath it.
    bare = {f"reauth-observe:{diagnosis}": expected
            for diagnosis, expected in DIAGNOSES.items() if diagnosis != "all_clear"}
    # The mismatch stands over every diagnosis that is not critical, `all_clear` included.
    mismatch = {f"reauth-observe:account_identity_mismatch:{diagnosis}": expected
                for diagnosis, expected in DIAGNOSES.items() if diagnosis != "reauth_needed_manual"}
    assert (len(bare), len(mismatch)) == (11, 11)
    assert {source: credential_repage.source_class(source) for source in bare} == bare
    assert {source: credential_repage.source_class(source) for source in mismatch} == mismatch
    # A diagnosis the table does not hold has no class; that is not the class "not a member".
    assert credential_repage.source_class("reauth-observe:a_diagnosis_added_later") is None
    assert credential_repage.source_class(
        "reauth-observe:account_identity_mismatch:a_diagnosis_added_later") is None


# ---------------------------------------------------------------------------
# The acknowledge command.
# ---------------------------------------------------------------------------


def at_the_real_time(make_rig, **options) -> tuple[cases.Rig, int]:
    """A rig whose clock stands two minutes before the real time, and that time."""
    start = int(real_time.time()) - 120
    return make_rig(start=start, **options), start


def run_cli(*arguments: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(_CLI), *arguments], env=dict(os.environ),
                          capture_output=True, text=True, timeout=60)


def ack_file(rig: cases.Rig) -> dict[str, Any]:
    path = rig.root / CREDENTIAL_ACK
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def write_ack_file(rig: cases.Rig, data: dict[str, Any]) -> None:
    path = rig.root / CREDENTIAL_ACK
    path.write_text(json.dumps(data), encoding="utf-8")
    path.chmod(0o600)


def test_t20_the_command_writes_an_entry_the_dispatcher_accepts_replaces_it_and_drops_old_ones(make_rig):
    rig, opened = at_the_real_time(make_rig)
    cases.open_now(rig, opened)
    assert rig.page_times() == [opened]
    # An entry of another scope, written more than 24 h ago.
    write_ack_file(rig, {"hostz|bot-old": {"ackedAt": opened - cases.DAY - cases.HOUR, "by": "an-earlier-writer"}})

    first = run_cli("bot-one")
    assert (first.returncode, first.stderr) == (0, "")
    written = ack_file(rig)
    assert sorted(written) == ["hosta|bot-one"]
    acked = written["hosta|bot-one"].get("ackedAt")
    assert type(acked).__name__ == "int"
    assert opened <= acked <= int(real_time.time())
    # It prints the key and the time it wrote.
    assert ("hosta|bot-one" in first.stdout, str(acked) in first.stdout) == (True, True)

    # A second run replaces the entry.
    marked = ack_file(rig)
    marked["hosta|bot-one"]["by"] = "an-earlier-writer"
    write_ack_file(rig, marked)
    second = run_cli("bot-one")
    assert second.returncode == 0
    again = ack_file(rig)
    assert sorted(again) == ["hosta|bot-one"]
    assert again["hosta|bot-one"].get("by") != "an-earlier-writer"
    assert again["hosta|bot-one"].get("ackedAt") >= acked

    # The dispatcher accepts it: no page while it holds.
    rig.cycle_at(opened + INTERVAL)
    rig.cycle_at(opened + 2 * INTERVAL)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [opened]


def refused(result: subprocess.CompletedProcess, rig: cases.Rig) -> tuple[bool, bool]:
    """(the command exited non-zero, it wrote no file)."""
    return result.returncode != 0, not (rig.root / CREDENTIAL_ACK).exists()


def test_t53_the_command_refuses_when_the_instance_has_no_condition(make_rig):
    rig, opened = at_the_real_time(make_rig)
    cases.open_now(rig, opened, host="hostb", bot="bot-two")
    assert rig.open_scopes() == ["hostb|bot-two"]
    result = run_cli("bot-one")
    assert refused(result, rig) == (True, True)
    assert f"{NO_OPEN_CONDITION} bot-one" in result.stderr


def test_t53_the_command_refuses_when_the_instance_has_only_a_pending_condition(make_rig):
    rig, opened = at_the_real_time(make_rig)
    rig.put(cases.observer_event(UNUSABLE_30, "hosta", "bot-one", opened))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "pending"
    result = run_cli("bot-one")
    assert refused(result, rig) == (True, True)
    assert f"{NO_OPEN_CONDITION} bot-one" in result.stderr


def test_t53_the_command_refuses_when_the_incident_state_cannot_be_read(make_rig):
    rig, opened = at_the_real_time(make_rig)
    cases.open_now(rig, opened)
    assert rig.open_scopes() == ["hosta|bot-one"]
    rig.paths["incident_state"].write_text("{ this is not JSON", encoding="utf-8")
    result = run_cli("bot-one")
    assert refused(result, rig) == (True, True)
    assert STATE_UNREADABLE in result.stderr
    assert NO_OPEN_CONDITION not in result.stderr


def test_t53_the_command_refuses_when_the_state_root_holds_no_incident_state(make_rig):
    rig, _ = at_the_real_time(make_rig)
    assert rig.paths["incident_state"].exists() is False
    result = run_cli("bot-one")
    assert refused(result, rig) == (True, True)
    assert NO_INCIDENT_STATE in result.stderr
    assert NO_OPEN_CONDITION not in result.stderr


def two_open_conditions_of_one_name(make_rig) -> cases.Rig:
    rig, opened = at_the_real_time(make_rig, fleet=cases.ROSTER_DUP)
    cases.open_now(rig, opened, host="hosta", bot="dup-bot")
    cases.open_now(rig, opened, host="hostb", bot="dup-bot")
    return rig


def test_t53_the_command_refuses_two_open_conditions_of_one_name_and_lists_both(make_rig):
    rig = two_open_conditions_of_one_name(make_rig)
    assert rig.open_scopes() == ["hosta|dup-bot", "hostb|dup-bot"]
    result = run_cli("dup-bot")
    assert refused(result, rig) == (True, True)
    assert f"{SEVERAL_OPEN_CONDITIONS} dup-bot" in result.stderr
    assert ("hosta|dup-bot" in result.stderr, "hostb|dup-bot" in result.stderr) == (True, True)


def test_t53_the_command_writes_the_condition_chosen_with_the_machine_option(make_rig):
    rig = two_open_conditions_of_one_name(make_rig)
    assert rig.open_scopes() == ["hosta|dup-bot", "hostb|dup-bot"]
    result = run_cli("dup-bot", "--machine", "hostb")
    assert (result.returncode, result.stderr) == (0, "")
    assert sorted(ack_file(rig)) == ["hostb|dup-bot"]


def check_t54_the_key_written_is_the_conditions_own(make_rig, name: str) -> str:
    # The roster does not hold the name, so the scope is the event's own host and the
    # instance name as the dispatcher's segment rule writes it.
    rig, opened = at_the_real_time(make_rig, fleet=cases.roster(("hostb", "bot-two")))
    cases.open_now(rig, opened, host="hosta", bot=name)
    keys = rig.open_scopes()
    assert len(keys) == 1
    assert rig.page_times() == [opened]
    result = run_cli(name)
    assert (result.returncode, result.stderr) == (0, "")
    assert sorted(ack_file(rig)) == keys
    # And the acknowledgement holds.
    rig.cycle_at(opened + INTERVAL)
    assert rig.phase(keys[0]) == "open"
    assert rig.page_times() == [opened]
    return keys[0]


# In each case the key is the one the dispatcher's own segment rule made for the condition;
# the command was given the name as an operator would type it.

def test_t54_an_instance_name_with_a_space(make_rig):
    key = check_t54_the_key_written_is_the_conditions_own(make_rig, "bot one")
    assert key == "hosta|bot_one"


def test_t54_an_instance_name_with_a_special_character(make_rig):
    key = check_t54_the_key_written_is_the_conditions_own(make_rig, "bot/one$")
    assert key == "hosta|bot_one"


def test_t54_an_instance_name_longer_than_80_characters(make_rig):
    key = check_t54_the_key_written_is_the_conditions_own(make_rig, "bot-" + "n" * 96)
    assert key == "hosta|bot-" + "n" * 76


def load_cli(module_name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(module_name, _CLI)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def unproven(component: str) -> durable_json.PublicationResult:
    """A publication the durable publisher could not prove (as tests/test_bot_errors_state_durable_outcomes.py)."""
    return durable_json.PublicationResult(
        component=component,
        durability=durable_json.DurabilityProof.UNPROVEN,
        confinement=durable_json.ConfinementProof.PROVEN,
        cleanup=durable_json.CleanupState.NOT_REQUIRED,
        authority=durable_json.AuthorityState.UNKNOWN,
        stage=durable_json.WriteStage.PARENT_SYNC,
        error_class=durable_json.ErrorClass.IO,
        generation=1,
        private_operation_id="private-operation",
        private_content_sha256="private-digest",
    )


def test_t63_a_publication_that_does_not_advance_exits_1_and_writes_nothing(make_rig):
    rig, opened = at_the_real_time(make_rig)
    cases.open_now(rig, opened)
    assert rig.open_scopes() == ["hosta|bot-one"]
    module = load_cli("bot_errors_credential_ack_no_advance")
    rig.monkeypatch.setattr(module, "publish_state_json",
                            lambda *args, **kwargs: unproven("credential_ack.write_state"))
    try:
        result = module.main(["bot-one"])
    except SystemExit as stopped:
        result = stopped.code
    assert result == 1
    assert (rig.root / CREDENTIAL_ACK).exists() is False
