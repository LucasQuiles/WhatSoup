import dataclasses
import json
import os
import pathlib
import subprocess
import tempfile
from typing import Optional, Sequence


class RollbackError(RuntimeError):
    pass


@dataclasses.dataclass
class JournalEntry:
    op: str
    path: Optional[str] = None
    undo_cmd: Optional[Sequence[str]] = None
    undone: bool = False


@dataclasses.dataclass(frozen=True)
class SkippedLine:
    """A journal line that could not be parsed during from_path(), kept
    operator-visible (RollbackJournal.skipped_lines) rather than swallowed
    into a log, so a crash-recovery rollback still surfaces what it dropped."""

    line_number: int
    raw_line: str
    error: str


def _entry_to_record(entry: JournalEntry) -> dict:
    rec: dict = {"op": entry.op, "undone": entry.undone}
    if entry.path is not None:
        rec["path"] = entry.path
    if entry.undo_cmd is not None:
        rec["undo_cmd"] = list(entry.undo_cmd)
    return rec


def _record_to_entry(rec: dict) -> JournalEntry:
    return JournalEntry(
        op=rec["op"],
        path=rec.get("path"),
        undo_cmd=rec.get("undo_cmd"),
        undone=bool(rec.get("undone", False)),
    )


class RollbackJournal:
    def __init__(self, journal_path: Optional[pathlib.Path] = None) -> None:
        self._entries: list[JournalEntry] = []
        self._journal_path = journal_path
        self.skipped_lines: list[SkippedLine] = []
        if journal_path is not None:
            journal_path.parent.mkdir(parents=True, exist_ok=True)
            if not journal_path.exists():
                journal_path.touch()

    def _append(self, entry: JournalEntry) -> None:
        self._entries.append(entry)
        if self._journal_path is not None:
            with self._journal_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(_entry_to_record(entry)) + "\n")

    def _persist_state(self) -> None:
        """Atomically rewrite the journal file with current entry states.

        Called after each successful entry undo so a crash-recovery
        rollback (from_path) does not re-attempt already-undone entries.
        Critical for `command` undo entries whose re-execution may not
        be idempotent (undo commands should still be written to be
        idempotent as defense-in-depth; this persistence is the primary
        guard)."""
        if self._journal_path is None:
            return
        directory = self._journal_path.parent
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=str(directory), delete=False
        ) as tmp:
            tmp_path = pathlib.Path(tmp.name)
            for entry in self._entries:
                tmp.write(json.dumps(_entry_to_record(entry)) + "\n")
        os.replace(tmp_path, self._journal_path)

    def record_file(self, path: pathlib.Path) -> None:
        self._append(JournalEntry(op="created_file", path=str(path)))

    def record_dir(self, path: pathlib.Path) -> None:
        self._append(JournalEntry(op="created_dir", path=str(path)))

    def record_command(self, undo_cmd: Sequence[str]) -> None:
        if not undo_cmd:
            raise RollbackError("undo_cmd must be a non-empty sequence")
        self._append(JournalEntry(op="command", undo_cmd=list(undo_cmd)))

    def ensure_dir(self, path: pathlib.Path) -> bool:
        if path.exists():
            return False
        path.mkdir(parents=True, exist_ok=False)
        self.record_dir(path)
        return True

    def undo(self) -> list[JournalEntry]:
        failures: list[JournalEntry] = []
        for entry in reversed(self._entries):
            if entry.undone:
                continue
            mutated = False
            try:
                if entry.op == "created_file":
                    assert entry.path is not None
                    p = pathlib.Path(entry.path)
                    if p.exists():
                        p.unlink()
                    entry.undone = True
                    mutated = True
                elif entry.op == "created_dir":
                    assert entry.path is not None
                    p = pathlib.Path(entry.path)
                    if not p.exists():
                        entry.undone = True
                        mutated = True
                    elif any(p.iterdir()):
                        failures.append(entry)
                    else:
                        p.rmdir()
                        entry.undone = True
                        mutated = True
                elif entry.op == "command":
                    assert entry.undo_cmd is not None
                    result = subprocess.run(list(entry.undo_cmd), check=False)
                    if result.returncode == 0:
                        entry.undone = True
                        mutated = True
                    else:
                        failures.append(entry)
                else:
                    raise RollbackError(f"unknown op: {entry.op}")
            except OSError:
                failures.append(entry)
            if mutated:
                self._persist_state()
        return failures

    @classmethod
    def from_path(cls, journal_path: pathlib.Path) -> "RollbackJournal":
        inst = cls(journal_path=None)
        inst._journal_path = journal_path
        text = journal_path.read_text(encoding="utf-8")
        for line_number, raw_line in enumerate(text.splitlines(), start=1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                inst._entries.append(_record_to_entry(json.loads(line)))
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                inst.skipped_lines.append(
                    SkippedLine(line_number=line_number, raw_line=raw_line, error=str(exc))
                )
        return inst
