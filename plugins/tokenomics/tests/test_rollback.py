import importlib.util
import json
import pathlib
import sys

ROLLBACK_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "lib" / "rollback.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("rollback", ROLLBACK_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_empty_journal_undo_is_noop(tmp_path):
    module = _load_module()
    journal = module.RollbackJournal()
    failures = journal.undo()
    assert failures == []


def test_record_file_undo_removes_only_if_present(tmp_path):
    module = _load_module()
    target = tmp_path / "a.txt"
    target.write_text("x", encoding="utf-8")
    journal = module.RollbackJournal()
    journal.record_file(target)
    failures = journal.undo()
    assert failures == []
    assert not target.exists()


def test_record_file_undo_skips_already_removed_file(tmp_path):
    module = _load_module()
    target = tmp_path / "a.txt"
    target.write_text("x", encoding="utf-8")
    journal = module.RollbackJournal()
    journal.record_file(target)
    target.unlink()
    failures = journal.undo()
    assert failures == []


def test_record_dir_undo_only_removes_if_empty(tmp_path):
    module = _load_module()
    created = tmp_path / "created"
    created.mkdir()
    journal = module.RollbackJournal()
    journal.record_dir(created)
    (created / "user_state.txt").write_text("preserve me", encoding="utf-8")
    failures = journal.undo()
    assert len(failures) == 1
    assert failures[0].path == str(created)
    assert created.exists()
    assert (created / "user_state.txt").read_text(encoding="utf-8") == "preserve me"


def test_ensure_dir_records_only_when_newly_created(tmp_path):
    module = _load_module()
    pre_existing = tmp_path / "pre"
    pre_existing.mkdir()
    new_dir = tmp_path / "new"

    journal = module.RollbackJournal()
    assert journal.ensure_dir(pre_existing) is False
    assert journal.ensure_dir(new_dir) is True
    assert new_dir.is_dir()

    journal.undo()
    assert pre_existing.is_dir()
    assert not new_dir.exists()


def test_undo_executes_entries_in_reverse_of_record_order(tmp_path):
    """LIFO contract: the LAST recorded entry undoes FIRST. Proven by
    capturing real execution order via record_command markers; file ops
    alone would not detect a regression to forward iteration."""
    module = _load_module()
    order_file = tmp_path / "order.txt"
    journal = module.RollbackJournal()
    journal.record_command([
        sys.executable, "-c",
        f"open({str(order_file)!r}, 'a').write('first\\n')",
    ])
    journal.record_command([
        sys.executable, "-c",
        f"open({str(order_file)!r}, 'a').write('second\\n')",
    ])

    failures = journal.undo()

    assert failures == []
    lines = order_file.read_text(encoding="utf-8").splitlines()
    # LIFO: the SECOND command (recorded last) ran first
    assert lines == ["second", "first"]


def test_undo_unwinds_file_before_parent_dir_so_rmdir_succeeds(tmp_path):
    """LIFO contract under real installer-style sequencing: record the
    parent dir, then a child file; on undo the file must be removed
    before the empty-dir removal of the parent."""
    module = _load_module()
    parent = tmp_path / "parent"
    parent.mkdir()
    child = parent / "child.txt"
    child.write_text("x", encoding="utf-8")

    journal = module.RollbackJournal()
    journal.record_dir(parent)
    journal.record_file(child)

    failures = journal.undo()

    assert failures == []
    assert not child.exists()
    assert not parent.exists()


def test_undo_is_idempotent_on_rerun(tmp_path):
    module = _load_module()
    target = tmp_path / "a.txt"
    target.write_text("x", encoding="utf-8")
    journal = module.RollbackJournal()
    journal.record_file(target)
    journal.undo()
    failures = journal.undo()
    assert failures == []


def test_record_command_runs_undo_on_undo(tmp_path):
    module = _load_module()
    marker = tmp_path / "marker.txt"
    journal = module.RollbackJournal()
    journal.record_command([sys.executable, "-c", f"open({str(marker)!r}, 'w').write('done')"])
    failures = journal.undo()
    assert failures == []
    assert marker.read_text(encoding="utf-8") == "done"


def test_journal_persists_to_jsonl_when_path_given(tmp_path):
    module = _load_module()
    journal_path = tmp_path / "state" / "journal.jsonl"
    target = tmp_path / "a.txt"
    target.write_text("x", encoding="utf-8")
    journal = module.RollbackJournal(journal_path=journal_path)
    journal.record_file(target)

    assert journal_path.exists()
    lines = [json.loads(l) for l in journal_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert any(rec.get("op") == "created_file" and rec.get("path") == str(target) for rec in lines)


def test_from_path_reloads_journal_for_out_of_process_rollback(tmp_path):
    module = _load_module()
    journal_path = tmp_path / "j.jsonl"
    target = tmp_path / "a.txt"
    target.write_text("x", encoding="utf-8")

    journal = module.RollbackJournal(journal_path=journal_path)
    journal.record_file(target)

    reloaded = module.RollbackJournal.from_path(journal_path)
    failures = reloaded.undo()
    assert failures == []
    assert not target.exists()


def test_from_path_skips_malformed_lines_instead_of_aborting(tmp_path):
    """Crash-recovery must tolerate a corrupt/malformed journal line: skip
    and record it rather than raising and aborting the entire rollback
    (issue #2299 M2 — from_path() previously had zero per-line tolerance)."""
    module = _load_module()
    journal_path = tmp_path / "j.jsonl"
    good_a = tmp_path / "a.txt"
    good_b = tmp_path / "b.txt"
    good_a.write_text("x", encoding="utf-8")
    good_b.write_text("x", encoding="utf-8")

    journal = module.RollbackJournal(journal_path=journal_path)
    journal.record_file(good_a)
    journal.record_file(good_b)

    # Corrupt the middle line of an otherwise-valid 2-entry journal.
    lines = journal_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    corrupted = [lines[0], "{not valid json", lines[1]]
    journal_path.write_text("\n".join(corrupted) + "\n", encoding="utf-8")

    reloaded = module.RollbackJournal.from_path(journal_path)

    assert len(reloaded._entries) == 2
    assert len(reloaded.skipped_lines) == 1
    skipped = reloaded.skipped_lines[0]
    assert skipped.line_number == 2
    assert "not valid json" in skipped.raw_line
    assert skipped.error

    failures = reloaded.undo()
    assert failures == []
    assert not good_a.exists()
    assert not good_b.exists()


def test_undo_persists_done_state_so_reload_does_not_double_execute(tmp_path):
    """Regression: a crash-recovery rollback that reloads the journal
    after a successful undo MUST NOT re-execute command undos. The
    journal file is rewritten atomically per-entry as undo proceeds,
    so a subsequent from_path() sees the same entries with undone=True."""
    module = _load_module()
    journal_path = tmp_path / "j.jsonl"
    marker = tmp_path / "marker.txt"
    journal = module.RollbackJournal(journal_path=journal_path)
    journal.record_command([
        sys.executable, "-c",
        # Each execution appends "ran\n" so a double-run produces two lines
        f"open({str(marker)!r}, 'a').write('ran\\n')",
    ])

    journal.undo()
    assert marker.read_text(encoding="utf-8") == "ran\n"

    # Simulate a fresh process re-reading the same journal file after
    # the prior rollback succeeded.
    reloaded = module.RollbackJournal.from_path(journal_path)
    reloaded.undo()

    # No second execution
    assert marker.read_text(encoding="utf-8") == "ran\n"


def test_undo_never_removes_unrecorded_pre_existing_files(tmp_path):
    """SPEC.md §5.4 case 6: reinstall must preserve pre-existing
    history.jsonl and threshold.json. The journal records only what
    the current install created, so unrecorded files cannot be removed."""
    module = _load_module()
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    pre_history = state_dir / "history.jsonl"
    pre_threshold = state_dir / "threshold.json"
    pre_history.write_text('{"keep": "me"}\n', encoding="utf-8")
    pre_threshold.write_text('{"keep": "me"}', encoding="utf-8")

    journal = module.RollbackJournal()
    assert journal.ensure_dir(state_dir) is False
    installer_artifact = state_dir / "installer-created.txt"
    installer_artifact.write_text("install", encoding="utf-8")
    journal.record_file(installer_artifact)

    failures = journal.undo()

    assert not installer_artifact.exists()
    assert pre_history.read_text(encoding="utf-8") == '{"keep": "me"}\n'
    assert pre_threshold.read_text(encoding="utf-8") == '{"keep": "me"}'
    assert state_dir.is_dir()
    assert failures == []
