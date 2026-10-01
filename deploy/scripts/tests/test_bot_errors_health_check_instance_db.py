"""The zero-byte instance DB tripwire fails closed.

Every 0-byte .db directly in the instance dir FAILs unless its name is a
known placeholder (KNOWN_PLACEHOLDER_DB_NAMES: store.db, whatsoup.db,
case-insensitive). A 0-byte .db in a subfolder cannot be live, so it is
evidence only, never a FAIL/WARN in the daily digest.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


def _instance_dir(home: Path, name: str) -> Path:
    path = home / ".local/share/whatsoup/instances" / name
    path.mkdir(parents=True)
    return path


def test_zero_byte_placeholders_beside_live_db_are_not_failures(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    instance = _instance_dir(tmp_path, "test-line")
    (instance / "bot.db").write_bytes(b"SQLite format 3\x00")
    (instance / "store.db").write_bytes(b"")
    (instance / "whatsoup.db").write_bytes(b"")

    lines = _mod.instance_db_inventory()

    assert [line for line in lines if line.startswith(("FAIL ", "WARN "))] == []
    assert any("zero_byte_placeholder_db" in line and line.endswith("store.db") for line in lines)
    assert any("zero_byte_placeholder_db" in line and line.endswith("whatsoup.db") for line in lines)


def test_zero_byte_live_db_still_fails(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    instance = _instance_dir(tmp_path, "test-line")
    (instance / "bot.db").write_bytes(b"")

    lines = _mod.instance_db_inventory()

    fails = [line for line in lines if line.startswith("FAIL ")]
    assert len(fails) == 1
    assert fails[0].startswith("FAIL instance_db test-line: zero_byte_db ")
    assert f"path={instance / 'bot.db'} " in fails[0]


def test_zero_byte_bot_db_outside_instance_root_is_a_placeholder(tmp_path, monkeypatch) -> None:
    # Only <instance>/bot.db is live; a nested bot.db is not what the loader opens.
    monkeypatch.setenv("HOME", str(tmp_path))
    instance = _instance_dir(tmp_path, "test-line")
    (instance / "bot.db").write_bytes(b"SQLite format 3\x00")
    nested = instance / "media"
    nested.mkdir()
    (nested / "bot.db").write_bytes(b"")

    lines = _mod.instance_db_inventory()

    assert [line for line in lines if line.startswith(("FAIL ", "WARN "))] == []
    assert any(
        "zero_byte_placeholder_db" in line and line.endswith(str(nested / "bot.db"))
        for line in lines
    )


def test_zero_byte_lifecycle_events_db_still_fails(tmp_path, monkeypatch) -> None:
    # Control: the lifecycle event store is a second live DB; a 0-byte copy is
    # the only on-disk sign of a broken store.
    monkeypatch.setenv("HOME", str(tmp_path))
    instance = _instance_dir(tmp_path, "test-line")
    (instance / "bot.db").write_bytes(b"SQLite format 3\x00")
    (instance / "lifecycle-events.db").write_bytes(b"")

    lines = _mod.instance_db_inventory()

    fails = [line for line in lines if line.startswith("FAIL ")]
    assert len(fails) == 1
    assert f"path={instance / 'lifecycle-events.db'} " in fails[0]


def test_live_db_name_match_is_case_insensitive(tmp_path, monkeypatch) -> None:
    # Control: APFS is case-insensitive, so Bot.db is the live bot.db.
    monkeypatch.setenv("HOME", str(tmp_path))
    instance = _instance_dir(tmp_path, "test-line")
    (instance / "Bot.db").write_bytes(b"")

    lines = _mod.instance_db_inventory()

    fails = [line for line in lines if line.startswith("FAIL ")]
    assert len(fails) == 1
    assert "zero_byte_db" in fails[0]


def test_zero_byte_unknown_top_level_db_fails_closed(tmp_path, monkeypatch) -> None:
    # Control: an unlisted top-level name may be a live DB, so it FAILs.
    monkeypatch.setenv("HOME", str(tmp_path))
    instance = _instance_dir(tmp_path, "test-line")
    (instance / "bot.db").write_bytes(b"SQLite format 3\x00")
    (instance / "future.db").write_bytes(b"")

    lines = _mod.instance_db_inventory()

    fails = [line for line in lines if line.startswith("FAIL ")]
    assert len(fails) == 1
    assert f"path={instance / 'future.db'} " in fails[0]


def test_dangling_db_symlink_warns_instead_of_crashing(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    instance = _instance_dir(tmp_path, "test-line")
    (instance / "bot.db").write_bytes(b"SQLite format 3\x00")
    (instance / "broken.db").symlink_to(instance / "missing-target.db")

    # Record a raise as a line so a crash fails the assertion below.
    try:
        lines = _mod.instance_db_inventory()
    except OSError as exc:
        lines = [f"raised {type(exc).__name__}"]

    assert lines == [
        f"WARN instance_db test-line: unreadable_db path={instance / 'broken.db'} error=FileNotFoundError"
    ]


def test_placeholder_name_match_is_case_insensitive(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    instance = _instance_dir(tmp_path, "test-line")
    (instance / "bot.db").write_bytes(b"SQLite format 3\x00")
    (instance / "Store.DB").write_bytes(b"")

    lines = _mod.instance_db_inventory()

    assert [line for line in lines if line.startswith(("FAIL ", "WARN "))] == []
    assert any(
        "zero_byte_placeholder_db" in line and line.endswith(str(instance / "Store.DB"))
        for line in lines
    )
