"""The poison-quarantine meta alert archives its event to sent/ under its own id.

Every BOT ERRORS card ends in "Ref <8>", and the Ref must lead to a stored
record. send_meta_alert sends straight to the group, so it archives the meta
event itself, named from the meta's id and never from the quarantined file's
name, and an archive failure never undoes the send or the quarantine.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest


_SCRIPTS = Path(__file__).resolve().parents[1]
# A malformed daily-health relay file: its name alone would make the heartbeat
# watchdog's daily_health_events() count it, wherever it lands.
_DAILY_HEALTH_POISON = "20261111T000000Z.relay-host-a.bot-errors-health.daily-health.poison.json"
_CARD_REF = re.compile(r"(?m)^Ref ([0-9a-f]{8}) · ")


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, _SCRIPTS / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


dispatcher = _load("bot_errors_dispatcher_meta_archive", "bot-errors-dispatcher.py")
watchdog = _load("bot_errors_heartbeat_watchdog_meta_archive", "bot-errors-heartbeat-watchdog.py")


@pytest.fixture
def bench(tmp_path, monkeypatch):
    root = tmp_path / "state"
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(root / "outbox"))
    monkeypatch.setenv("BOT_ERRORS_DRY_SEND_CAPTURE", str(tmp_path / "sent.log"))
    monkeypatch.delenv("BOT_ERRORS_DRY_SEND_FAIL", raising=False)
    return tmp_path, dispatcher.setup_dirs()


def _quarantine(paths) -> Path:
    poison = paths["outbox"] / _DAILY_HEALTH_POISON
    poison.write_text("{ not json", encoding="utf-8")
    return dispatcher.quarantine_poison(poison, paths["quarantine"], "json decode failed")


def _cards(tmp_path: Path) -> list[str]:
    capture = tmp_path / "sent.log"
    if not capture.exists():
        return []
    return [json.loads(line)["text"] for line in capture.read_text(encoding="utf-8").splitlines() if line.strip()]


def _log_records(tmp_path: Path) -> list[dict]:
    records = []
    for path in sorted((tmp_path / "state").rglob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                records.append(json.loads(line))
    return records


def test_sent_meta_alert_archives_one_record_named_from_its_id(bench):
    tmp_path, paths = bench

    dest = _quarantine(paths)

    assert dest.parent == paths["quarantine"] and dest.exists()
    cards = _cards(tmp_path)
    assert len(cards) == 1
    match = _CARD_REF.search(cards[0])
    assert match is not None
    stored = [(path, json.loads(path.read_text(encoding="utf-8"))) for path in sorted(paths["sent"].glob("*.sent"))]
    named = [(path, event) for path, event in stored if dispatcher.public_card_ref(event) == match.group(1)]
    assert len(named) == 1
    path, event = named[0]
    assert event["id"].startswith("poison-")
    assert event["source"] == "poison-event-quarantine"
    assert path.name.startswith(f"{event['id']}.json.") and path.name.endswith(".sent")
    assert "daily-health" not in path.name
    assert [record["type"] for record in _log_records(tmp_path) if record.get("type") == "quarantine"] == ["quarantine"]


def test_meta_archive_failure_keeps_quarantine_and_send(bench, monkeypatch):
    tmp_path, paths = bench
    publish = dispatcher.publish_state_json

    # Only the archive write fails: a refused pending write sends nothing
    # (test_bot_errors_synthesized_send_refs.py covers that case).
    def refuse(target, payload, *, component, **kwargs):
        if component == "dispatcher.synthesized_sent_state":
            raise OSError("injected meta archive failure")
        return publish(target, payload, component=component, **kwargs)

    monkeypatch.setattr(dispatcher, "publish_state_json", refuse)

    dest = _quarantine(paths)

    assert dest.parent == paths["quarantine"] and dest.exists()
    assert not (paths["outbox"] / _DAILY_HEALTH_POISON).exists()
    assert len(_cards(tmp_path)) == 1
    assert list(paths["sent"].glob("*.sent")) == []
    records = _log_records(tmp_path)
    failures = [record for record in records if record.get("type") == "meta_alert_archive_failed"]
    # The controller log keeps only allowlisted detail keys, so the named record
    # type is the durable evidence of the failure.
    assert len(failures) == 1
    assert [record["type"] for record in records if record.get("type") == "quarantine"] == ["quarantine"]


def test_meta_alert_delivered_by_email_is_archived(bench, monkeypatch):
    _tmp_path, paths = bench

    def refuse_group(*_args, **_kwargs):
        raise RuntimeError("group send refused")

    monkeypatch.setattr(dispatcher, "send_whatsapp", refuse_group)
    monkeypatch.setattr(dispatcher, "email_fallback", lambda *_args, **_kwargs: True)

    dest = _quarantine(paths)

    assert dest.parent == paths["quarantine"] and dest.exists()
    stored = [json.loads(path.read_text(encoding="utf-8")) for path in paths["sent"].glob("*.sent")]
    assert [event["source"] for event in stored] == ["poison-event-quarantine"]


def _pending(paths) -> list[Path]:
    directory = paths["synthesized_pending"]
    return sorted(p for p in directory.iterdir() if not p.name.startswith(".")) if directory.exists() else []


def test_quarantine_notice_stays_owed_while_its_pending_record_cannot_be_written(bench, monkeypatch):
    """A refused pending write sends nothing, and the poison stays queued until it can be told once."""
    tmp_path, paths = bench
    channels: list[str] = []
    monkeypatch.setattr(dispatcher, "send_whatsapp", lambda text, **_kwargs: channels.append(text))
    monkeypatch.setattr(dispatcher, "email_fallback", lambda *_args, **_kwargs: channels.append("email") or True)
    publish = dispatcher.publish_state_json

    def refuse_pending(target, payload, *, component, **kwargs):
        if component == "dispatcher.synthesized_pending_state":
            raise OSError("injected persistent pending write failure")
        return publish(target, payload, component=component, **kwargs)

    poison = paths["outbox"] / _DAILY_HEALTH_POISON
    poison.write_text("{ not json", encoding="utf-8")
    monkeypatch.setattr(dispatcher, "publish_state_json", refuse_pending)

    # Two scan passes while storage refuses the pending record.
    for _ in range(2):
        dispatcher.ready_disposition(poison, paths["quarantine"])

    assert channels == []
    assert poison.exists(), "the poison left the queue, so nothing owes its notice"
    assert list(paths["quarantine"].iterdir()) == []
    assert _pending(paths) == [] and list(paths["sent"].glob("*.sent")) == []
    assert [record for record in _log_records(tmp_path) if record.get("type") == "quarantine"] == []

    # Storage works again: the next pass tells it exactly once.
    monkeypatch.setattr(dispatcher, "publish_state_json", publish)
    dispatcher.ready_disposition(poison, paths["quarantine"])

    assert len(channels) == 1
    assert not poison.exists()
    assert len(list(paths["quarantine"].iterdir())) == 1
    assert _pending(paths) == []
    match = _CARD_REF.search(channels[0])
    assert match is not None
    stored = [json.loads(path.read_text(encoding="utf-8")) for path in paths["sent"].glob("*.sent")]
    assert [event["source"] for event in stored if dispatcher.public_card_ref(event) == match.group(1)] == [
        "poison-event-quarantine"
    ]

    # A later pass, or a second quarantine call on the moved file, sends nothing more.
    dispatcher.quarantine_poison(poison, paths["quarantine"], "json decode failed")
    assert len(channels) == 1
    assert _pending(paths) == []
    assert len(list(paths["sent"].glob("*.sent"))) == 1


def test_quarantined_daily_health_file_is_not_a_daily_health_event(bench):
    _tmp_path, paths = bench

    _quarantine(paths)

    assert watchdog.daily_health_events() == []
