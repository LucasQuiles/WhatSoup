"""#2459 C3: deterministic, privacy-safe census of the BOT ERRORS relay archive.

Why this exists: at baseline the collector could not answer "how much relay
archive is there, how old is it, and is any of it unparseable?" without
someone listing a remote directory by hand and reading event payloads --
which is exactly the operation that leaks host, account, instance, user and
message text into an operator's terminal. Issue #2459 criterion C3 asks for
the aggregate answer with none of the identifying content.

Scope, stated so it cannot be silently widened:

  - The census reads the TWO archive directories the collector itself writes
    under the remote root -- `relayed/` (bot-errors-collector.py REMOTE_ACK_SCRIPT)
    and `writefail-relayed/` (REMOTE_WRITEFAIL_ACK_SCRIPT) -- and nothing
    else. `test_census_scans_only_the_two_collector_archive_directories`
    pins that boundary against a sibling directory under the same root.
  - It is READ-ONLY. It deletes, moves and rewrites nothing. No retention
    behaviour, no terminal-state vocabulary and no threshold lives here;
    those are gated on the issue's own durability precondition and on owner
    thresholds, and are not this leaf's work.
  - The remote root is passed as argv and is NEVER echoed. The privacy test
    below seeds a host name, an account, an instance, a user, a filesystem
    path and message text -- in a well-formed artifact AND in a malformed one,
    so the parse-failure branch is covered too -- and asserts every seeded
    token is absent from the raw census stdout.

Determinism: the script takes an explicit `now` epoch argument. Fixture
mtimes are pinned with os.utime and `now` is pinned, so oldest/newest ages
are exact integers rather than wall-clock-dependent values. Ages for an
empty archive are `null`, pinned by its own test so the contract is not
left to whatever the implementation happened to do.

Execution model: the production path pipes the script constant to
`ssh ... python3 -`. These tests run the same constant through
`sys.executable -` over a local fixture tree, so the assertions are about
the real shipped script text, not a reimplementation. The ssh argv assembly
is covered separately by the last test here and by
test_bot_errors_remote_command_readonly.py.

Deploy Python tests run in Linux CI; a local macOS run is an indicator only.
"""
from __future__ import annotations

import ast
import contextlib
import errno
import importlib.util
import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_COLLECTOR_PATH = Path(__file__).resolve().parents[1] / "bot-errors-collector.py"

# Fixed clock for every fixture in this file. Ages below are computed against
# it, so an assertion that names a number is checkable by hand.
_NOW = 1_800_000_000
_HOUR = 3600
_DAY = 86_400


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture()
def collector():
    return _load(_COLLECTOR_PATH, "bot_errors_collector_census_harness")


def _write_artifact(directory: Path, name: str, body: str, *, age_seconds: int) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(body, encoding="utf-8")
    mtime = _NOW - age_seconds
    os.utime(path, (mtime, mtime))
    return path


def _event(**overrides) -> str:
    record = {
        "id": "evt-1",
        "createdAt": "2026-08-01T12:00:00.000Z",
        "instance": "x-bot",
        "source": "collector_relay",
        "summary": "an event",
        "severity": "warning",
    }
    record.update(overrides)
    return json.dumps(record)


def _run_census(collector, root: Path, *, now: int | None = _NOW) -> tuple[int, str, str]:
    """Pipe the shipped script constant to a Python interpreter over stdin,
    the same way the collector pipes it to `ssh ... python3 -`."""
    args = [str(root), "" if now is None else str(now)]
    proc = subprocess.run(
        [sys.executable, "-", *args],
        input=collector.REMOTE_ARCHIVE_CENSUS_SCRIPT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=60,
        check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _census(collector, root: Path, *, now: int | None = _NOW) -> dict:
    returncode, stdout, stderr = _run_census(collector, root, now=now)
    assert returncode == 0, f"census exited rc={returncode}; stderr={stderr!r}"
    return json.loads(stdout)


@pytest.fixture()
def populated_root(tmp_path: Path) -> Path:
    """Both archive directories, with a malformed artifact in each.

    relayed/          3 files: two parseable (two distinct source kinds),
                      one malformed. Ages 1h, 2h, 3h.
    writefail-relayed/ 2 files: one parseable (a source kind already seen in
                      relayed/, so the combined cardinality proves a UNION and
                      not a sum), one malformed. Ages 10d, 20d.
    """
    root = tmp_path / "bot-errors"
    relayed = root / "relayed"
    _write_artifact(relayed, "a.json.1.relayed", _event(source="collector_relay"), age_seconds=_HOUR)
    _write_artifact(relayed, "b.json.2.relayed", _event(source="dispatcher_delivery"), age_seconds=2 * _HOUR)
    _write_artifact(relayed, "c.json.3.relayed", "{not json", age_seconds=3 * _HOUR)
    writefail = root / "writefail-relayed"
    _write_artifact(writefail, "d.json.4.relayed", _event(source="collector_relay"), age_seconds=10 * _DAY)
    _write_artifact(writefail, "e.json.5.relayed", "", age_seconds=20 * _DAY)
    return root


# ---------------------------------------------------------------------------
# 1. The aggregates themselves (C3).
# ---------------------------------------------------------------------------


def test_census_reports_labelled_aggregates_for_both_archive_directories(collector, populated_root):
    report = _census(collector, populated_root)

    assert report["censusStatus"] == "ok"
    assert set(report["archives"]) == {"relayed", "writefailRelayed"}

    relayed = report["archives"]["relayed"]
    assert relayed["status"] == "ok"
    assert relayed["errnoClass"] is None
    assert relayed["artifactCount"] == 3
    assert relayed["parseFailureCount"] == 1
    assert relayed["sourceKindCardinality"] == 2
    assert relayed["newestAgeSeconds"] == _HOUR
    assert relayed["oldestAgeSeconds"] == 3 * _HOUR
    assert relayed["totalBytes"] == _dir_bytes(populated_root / "relayed")

    writefail = report["archives"]["writefailRelayed"]
    assert writefail["status"] == "ok"
    assert writefail["artifactCount"] == 2
    assert writefail["parseFailureCount"] == 1
    assert writefail["sourceKindCardinality"] == 1
    assert writefail["newestAgeSeconds"] == 10 * _DAY
    assert writefail["oldestAgeSeconds"] == 20 * _DAY
    assert writefail["totalBytes"] == _dir_bytes(populated_root / "writefail-relayed")


def test_census_total_is_the_combination_of_both_archives(collector, populated_root):
    report = _census(collector, populated_root)
    total = report["total"]

    assert total["status"] == "ok"
    assert total["artifactCount"] == 5
    assert total["parseFailureCount"] == 2
    assert total["totalBytes"] == (
        _dir_bytes(populated_root / "relayed") + _dir_bytes(populated_root / "writefail-relayed")
    )
    # Oldest across both is the writefail 20d artifact; newest is the 1h relayed one.
    assert total["oldestAgeSeconds"] == 20 * _DAY
    assert total["newestAgeSeconds"] == _HOUR
    # UNION, not a sum: collector_relay appears in both directories, so the
    # three per-directory kinds (2 + 1) collapse to 2 distinct kinds overall.
    # A summing implementation would report 3 here.
    assert total["sourceKindCardinality"] == 2


def test_census_reports_null_ages_for_an_empty_archive(collector, tmp_path):
    """Pin the empty-directory contract rather than leaving it implicit."""
    root = tmp_path / "bot-errors"
    (root / "relayed").mkdir(parents=True)
    (root / "writefail-relayed").mkdir(parents=True)

    report = _census(collector, root)

    for label in ("relayed", "writefailRelayed"):
        block = report["archives"][label]
        assert block["artifactCount"] == 0
        assert block["totalBytes"] == 0
        assert block["parseFailureCount"] == 0
        assert block["sourceKindCardinality"] == 0
        assert block["status"] == "ok", "an empty directory that WAS read is ok, not unavailable"
        assert block["oldestAgeSeconds"] is None
        assert block["newestAgeSeconds"] is None
    assert report["total"]["status"] == "ok"
    assert report["total"]["oldestAgeSeconds"] is None
    assert report["total"]["newestAgeSeconds"] is None
    assert report["censusStatus"] == "ok"


def test_census_reports_a_missing_archive_directory_as_unavailable_not_empty(collector, tmp_path):
    """UNAVAILABLE IS NOT EMPTY.

    A directory the census could not list must never be reported as a
    directory holding nothing. The two readings drive opposite operator
    decisions -- "nothing to retain" versus "I cannot see what is there" --
    and the census is the instrument a later retention pass is meant to lean
    on, so an absent directory reading as a zero count is the failure mode
    that matters most here.
    """
    report = _census(collector, tmp_path / "nonexistent-root")

    for label in ("relayed", "writefailRelayed"):
        block = report["archives"][label]
        assert block["status"] == "unavailable"
        assert block["errnoClass"] == "missing"
        # Not 0. A count of zero would be a claim about content the census
        # never got to look at.
        assert block["artifactCount"] is None
        assert block["totalBytes"] is None
        assert block["parseFailureCount"] is None
        assert block["sourceKindCardinality"] is None
    assert report["total"]["status"] == "partial"


def test_census_reports_an_unreadable_archive_directory_as_unavailable_permission(collector, tmp_path):
    """chmod 000: listable-by-name but not readable. Before this, the census
    swallowed the OSError and reported a healthy zero."""
    root = tmp_path / "bot-errors"
    relayed = root / "relayed"
    _write_artifact(relayed, "a.json.1.relayed", _event(), age_seconds=_HOUR)
    (root / "writefail-relayed").mkdir(parents=True)
    os.chmod(relayed, 0o000)
    try:
        returncode, stdout, stderr = _run_census(collector, root)
    finally:
        os.chmod(relayed, 0o755)

    assert returncode == 0, stderr
    report = json.loads(stdout)
    block = report["archives"]["relayed"]
    assert block["status"] == "unavailable"
    assert block["errnoClass"] == "permission"
    assert block["artifactCount"] is None
    # The readable sibling still reports normally -- one bad directory must
    # not blind the whole census.
    assert report["archives"]["writefailRelayed"]["status"] == "ok"
    assert report["archives"]["writefailRelayed"]["artifactCount"] == 0
    assert report["total"]["status"] == "partial"
    # No path, no errno text, no exception string.
    assert str(root) not in stdout
    assert "relayed" not in stderr
    assert "Errno" not in stdout


def test_census_total_stays_partial_and_sums_the_directory_that_produced_numbers(
    collector, tmp_path
):
    root = tmp_path / "bot-errors"
    _write_artifact(root / "writefail-relayed", "d.json.1.relayed", _event(), age_seconds=_DAY)
    # relayed/ is absent entirely.
    report = _census(collector, root)

    assert report["archives"]["relayed"]["status"] == "unavailable"
    assert report["archives"]["writefailRelayed"]["status"] == "ok"
    assert report["total"]["status"] == "partial"
    # The total reports what was actually read, and its status says the
    # number is incomplete rather than pretending the missing side was empty.
    assert report["total"]["artifactCount"] == 1


def test_census_refuses_a_symlinked_archive_directory(collector, tmp_path):
    """S2: the archive directory ITSELF being a symlink walked the census out
    of the root entirely. The reviewer probe counted five files living
    outside the root this way. Refuse the directory and count nothing."""
    root = tmp_path / "bot-errors"
    root.mkdir(parents=True)
    outside = tmp_path / "outside"
    for index in range(5):
        _write_artifact(outside, f"outside-{index}.json", _event(source="OUTSIDEKINDTOKEN"), age_seconds=_HOUR)
    os.symlink(outside, root / "relayed")
    (root / "writefail-relayed").mkdir()

    returncode, stdout, stderr = _run_census(collector, root)
    assert returncode == 0, stderr

    report = json.loads(stdout)
    block = report["archives"]["relayed"]
    assert block["status"] == "refused_symlink"
    assert block["artifactCount"] is None
    assert report["total"]["status"] == "partial"
    # The five files outside the root are counted nowhere.
    assert report["total"]["artifactCount"] == 0
    assert "OUTSIDEKINDTOKEN" not in stdout
    assert str(outside) not in stdout


def test_census_still_refuses_a_symlinked_entry_inside_a_real_archive(collector, tmp_path):
    """The directory-level refusal must not replace the entry-level defence:
    a real archive directory holding a symlink to an outside file still must
    not count that file."""
    root = tmp_path / "bot-errors"
    relayed = root / "relayed"
    _write_artifact(relayed, "real.json.1.relayed", _event(), age_seconds=_HOUR)
    outside_file = tmp_path / "outside.json"
    outside_file.write_text(_event(source="OUTSIDEENTRYTOKEN"), encoding="utf-8")
    os.symlink(outside_file, relayed / "link.json.2.relayed")

    report = _census(collector, root)
    block = report["archives"]["relayed"]
    assert block["status"] == "ok"
    assert block["artifactCount"] == 1
    assert block["sourceKindCardinality"] == 1
    assert "OUTSIDEENTRYTOKEN" not in json.dumps(report)


def test_census_counts_a_malformed_artifact_as_present_and_unparseable(collector, tmp_path):
    """A malformed artifact still occupies bytes and still ages -- it must be
    counted, not skipped, or the census would under-report exactly the
    artifacts an operator most needs to know about."""
    root = tmp_path / "bot-errors"
    _write_artifact(root / "relayed", "broken.json.1.relayed", "\x00\xff not json", age_seconds=_HOUR)

    relayed = _census(collector, root)["archives"]["relayed"]
    assert relayed["artifactCount"] == 1
    assert relayed["parseFailureCount"] == 1
    assert relayed["totalBytes"] > 0
    assert relayed["oldestAgeSeconds"] == _HOUR


def test_census_counts_a_json_non_object_as_a_parse_failure(collector, tmp_path):
    """`[]` and `"text"` parse as JSON but are not event records. Counting
    them as healthy would make parseFailureCount silently optimistic."""
    root = tmp_path / "bot-errors"
    _write_artifact(root / "relayed", "list.json.1.relayed", "[1, 2, 3]", age_seconds=_HOUR)
    _write_artifact(root / "relayed", "str.json.2.relayed", '"a string"', age_seconds=_HOUR)

    relayed = _census(collector, root)["archives"]["relayed"]
    assert relayed["artifactCount"] == 2
    assert relayed["parseFailureCount"] == 2
    assert relayed["sourceKindCardinality"] == 0


# ---------------------------------------------------------------------------
# 1b. Entry-level failures are counted, not swallowed, and the archive
#     directory is pinned by descriptor so the check and the use address the
#     same inode.
# ---------------------------------------------------------------------------

# A directory that can be LISTED but whose entries cannot be STAT-ed (mode
# 0444 -- read, no execute/search). Before this change the census reported
# all seven of these as a healthy zero.
_UNUSABLE_FIXTURE_ARTIFACTS = 7


def test_census_counts_entries_it_could_not_stat_as_unusable_not_absent(collector, tmp_path):
    """An entry-level failure is missing information, not absence.

    `except OSError: continue` swallowed every entry-level error, not just
    the ENOENT its comment described. A mode-0444 archive directory holding
    seven real artifacts therefore reported `status: ok`, `artifactCount: 0`
    and `total.status: ok` -- the same "unreadable is empty" conflation the
    directory level already refuses, surviving one level down. The count of
    entries the census could not look at has to reach the payload, and the
    block has to stop calling itself `ok`.

    Not skipped for root: the archive census suite already relies on an
    unprivileged runner (`test_census_reports_an_unreadable_archive_directory
    _as_unavailable_permission` chmods 0o000 and asserts the refusal), so a
    root runner would already be failing this file before reaching here.
    """
    root = tmp_path / "bot-errors"
    relayed = root / "relayed"
    for index in range(_UNUSABLE_FIXTURE_ARTIFACTS):
        _write_artifact(relayed, f"a.json.{index}.relayed", _event(), age_seconds=_HOUR)
    (root / "writefail-relayed").mkdir(parents=True)
    os.chmod(relayed, 0o444)
    try:
        returncode, stdout, stderr = _run_census(collector, root)
    finally:
        os.chmod(relayed, 0o755)

    assert returncode == 0, stderr
    report = json.loads(stdout)
    block = report["archives"]["relayed"]
    # Never `ok` with a lower count: the block says outright that it is
    # incomplete, and says by how much.
    assert block["status"] == "partial"
    assert block["unusableEntryCount"] == _UNUSABLE_FIXTURE_ARTIFACTS
    assert block["artifactCount"] == 0
    # The gap has to survive aggregation too. A consumer that reads only
    # `total` would otherwise see a silently lower sum with no quantified
    # gap -- exactly what this test exists to remove.
    assert report["total"]["status"] == "partial"
    assert report["total"]["unusableEntryCount"] == _UNUSABLE_FIXTURE_ARTIFACTS
    assert report["total"]["artifactCount"] == 0
    # Nothing was stat-ed, so there is no age to report. Zero here would be a
    # claim about artifacts the census never reached, the same way a zero
    # count would be.
    assert block["oldestAgeSeconds"] is None
    assert block["newestAgeSeconds"] is None
    assert report["total"]["oldestAgeSeconds"] is None
    assert report["total"]["newestAgeSeconds"] is None
    # Still nothing identifying on the wire.
    assert str(root) not in stdout
    assert "Errno" not in stdout


def test_census_total_sums_a_partial_directory_beside_a_complete_one(collector, tmp_path):
    """A partial block still carries numbers, so it still contributes them.

    This is the shape a retention consumer actually meets: one archive
    directory readable, the other listable but not searchable. The total has
    to sum what the readable side found, carry the unreadable side's gap as a
    count rather than dropping it, and say `partial` either way. Ages and
    source kinds come only from entries that were actually reached.
    """
    root = tmp_path / "bot-errors"
    relayed = root / "relayed"
    for index in range(_UNUSABLE_FIXTURE_ARTIFACTS):
        _write_artifact(relayed, f"a.json.{index}.relayed", _event(), age_seconds=_HOUR)
    writefail = root / "writefail-relayed"
    _write_artifact(writefail, "d.json.1.relayed", _event(source="dispatcher_delivery"), age_seconds=_DAY)
    _write_artifact(writefail, "e.json.2.relayed", "{not json", age_seconds=2 * _DAY)
    os.chmod(relayed, 0o444)
    try:
        report = _census(collector, root)
    finally:
        os.chmod(relayed, 0o755)

    blocked = report["archives"]["relayed"]
    assert blocked["status"] == "partial"
    assert blocked["unusableEntryCount"] == _UNUSABLE_FIXTURE_ARTIFACTS
    assert blocked["artifactCount"] == 0
    assert blocked["sourceKindCardinality"] == 0

    readable = report["archives"]["writefailRelayed"]
    assert readable["status"] == "ok"
    assert readable["unusableEntryCount"] == 0
    assert readable["artifactCount"] == 2
    assert readable["parseFailureCount"] == 1
    assert readable["sourceKindCardinality"] == 1

    total = report["total"]
    assert total["status"] == "partial"
    # The readable side is summed rather than discarded ...
    assert total["artifactCount"] == 2
    assert total["parseFailureCount"] == 1
    assert total["sourceKindCardinality"] == 1
    assert total["oldestAgeSeconds"] == 2 * _DAY
    assert total["newestAgeSeconds"] == _DAY
    # ... and the unreadable side is reported as a size, not dropped.
    assert total["unusableEntryCount"] == _UNUSABLE_FIXTURE_ARTIFACTS


def test_census_counts_an_unreadable_file_as_present_and_unparseable(collector, tmp_path):
    """Positive control for the counter above: an entry the census can STAT
    but cannot OPEN keeps the classification it has today.

    Mode-000 FILE inside a normal directory: its bytes and its age ARE known,
    only its content is not, so it stays a counted artifact plus a parse
    failure and must NOT be reclassified as unusable. If this test moves when
    the one above goes green, the new counter has swallowed a case it should
    not own."""
    root = tmp_path / "bot-errors"
    relayed = root / "relayed"
    path = _write_artifact(relayed, "unreadable.json.1.relayed", _event(), age_seconds=_HOUR)
    (root / "writefail-relayed").mkdir(parents=True)
    os.chmod(path, 0o000)
    try:
        report = _census(collector, root)
    finally:
        os.chmod(path, 0o644)

    block = report["archives"]["relayed"]
    assert block["status"] == "ok"
    assert block["artifactCount"] == 1
    assert block["parseFailureCount"] == 1
    assert block["oldestAgeSeconds"] == _HOUR


def test_census_total_is_null_not_zero_when_no_directory_could_be_read(collector, tmp_path):
    """The null-not-zero promise stopped at the directory level.

    With both directories unavailable the combined block summed an empty list
    and reported `artifactCount: 0` beside `status: partial`. A retention pass
    keyed on the number would conclude "nothing to retain" over an archive it
    never managed to look at -- the promise the per-directory blocks make and
    the total did not keep."""
    root = tmp_path / "bot-errors"
    root.mkdir(parents=True)  # neither archive directory exists

    report = _census(collector, root)
    assert report["archives"]["relayed"]["status"] == "unavailable"
    assert report["archives"]["writefailRelayed"]["status"] == "unavailable"

    total = report["total"]
    assert total["status"] == "partial"
    assert total["artifactCount"] is None
    assert total["totalBytes"] is None
    assert total["parseFailureCount"] is None
    assert total["sourceKindCardinality"] is None
    assert total["unusableEntryCount"] is None
    assert total["oldestAgeSeconds"] is None
    assert total["newestAgeSeconds"] is None


def test_census_total_is_null_when_every_directory_listed_but_reached_nothing(collector, tmp_path):
    """Listability is not the test; reaching an entry is.

    Both archive directories at mode 0444 list fine, so both blocks are
    `partial` rather than `unavailable` -- and a total that keyed on status
    summed them to `artifactCount: 0` and `totalBytes: 0`. That is the same
    "I could not look" reported as "there is nothing there" the per-directory
    blocks refuse. The gap itself still has to reach the total as a count,
    which is the one number here that is not null.
    """
    root = tmp_path / "bot-errors"
    relayed = root / "relayed"
    writefail = root / "writefail-relayed"
    for index in range(_UNUSABLE_FIXTURE_ARTIFACTS):
        _write_artifact(relayed, f"a.json.{index}.relayed", _event(), age_seconds=_HOUR)
    _write_artifact(writefail, "d.json.1.relayed", _event(), age_seconds=_DAY)
    os.chmod(relayed, 0o444)
    os.chmod(writefail, 0o444)
    try:
        report = _census(collector, root)
    finally:
        os.chmod(relayed, 0o755)
        os.chmod(writefail, 0o755)

    assert report["archives"]["relayed"]["status"] == "partial"
    assert report["archives"]["writefailRelayed"]["status"] == "partial"

    total = report["total"]
    assert total["status"] == "partial"
    assert total["artifactCount"] is None
    assert total["totalBytes"] is None
    assert total["parseFailureCount"] is None
    assert total["sourceKindCardinality"] is None
    assert total["oldestAgeSeconds"] is None
    assert total["newestAgeSeconds"] is None
    # The size of what could not be looked at is the one thing that IS known.
    assert total["unusableEntryCount"] == _UNUSABLE_FIXTURE_ARTIFACTS + 1


# A race is not a deterministic pytest. What IS deterministic is the property
# that removes the race: after the archive directory
# is opened, every listing, stat and read is addressed to that DESCRIPTOR, so
# there is no second resolution of the name for a swap to land in. The check
# below is a static walk of the shipped script text in the same shape
# test_bot_errors_remote_command_readonly.py uses on these constants, with
# negative controls underneath so it cannot pass by construction.
#
# Scope, stated so it is not read as more than it is: this proves that no
# filesystem call in the script resolves a path, with exactly two budgeted
# exceptions named below -- the single directory open that PRODUCES the
# descriptor, and the lstat that labels a refusal that has already happened.
# The budget is over the whole population of path-resolving calls, not over
# one spelling of it: an aggregate re-stat written as os.stat, a re-listing
# written as os.scandir and a os.readlink are each as much a second
# resolution as an lstat is, and each is flagged.
_MAX_LABEL_ONLY_PATH_LSTAT_CALLS = 1
_DIR_OPEN_FLAGS_NAME = "DIR_OPEN_FLAGS"
_ENTRY_OPEN_FLAGS_NAME = "ENTRY_OPEN_FLAGS"
_REQUIRED_DIR_OPEN_FLAG_TOKENS = ("O_RDONLY", "O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC")
# O_NOFOLLOW on the ENTRY open is what stops a name swapped for a symlink
# between the entry stat and the entry open from being read out of the
# archive. Dropping that one token is a live regression, so the walk checks
# the flags actually USED at the entry open, not only that the constant
# exists.
_REQUIRED_ENTRY_OPEN_FLAG_TOKENS = ("O_RDONLY", "O_NOFOLLOW")

# os functions that resolve a path argument against the filesystem. Purely
# descriptor-addressed calls (fstat, read, close) and pure string handling
# (os.path.join, os.path.basename) are not here, because neither reaches the
# filesystem through a name.
_PATH_RESOLVING_OS_CALLS = frozenset(
    {
        "stat", "lstat", "listdir", "scandir", "readlink", "open", "walk",
        "fwalk", "access", "statvfs", "truncate", "utime", "chmod", "chown",
        "link", "symlink", "rename", "replace", "remove", "unlink", "rmdir",
        "mkdir", "makedirs", "removedirs", "getxattr", "listxattr", "pathconf",
    }
)
# os.path helpers that stat behind the scenes.
_PATH_RESOLVING_OSPATH_CALLS = frozenset(
    {
        "exists", "lexists", "isdir", "isfile", "islink", "getsize",
        "getmtime", "getctime", "getatime", "realpath", "samefile",
    }
)


def _descriptor_names(tree: ast.AST) -> set[str]:
    """Names bound directly to an `os.open(...)` result.

    Derived from the script, not named by this test, so the check is about
    where the descriptor came from rather than what someone called it.
    """
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        value = node.value
        if not isinstance(value, ast.Call):
            continue
        if not (isinstance(value.func, ast.Attribute) and value.func.attr == "open"):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                names.add(target.id)
    return names


def _flag_expression_source(tree: ast.AST, source: str, name: str) -> str:
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            return ast.get_source_segment(source, node.value) or ""
    return ""


def _is_os_path_call(func: ast.Attribute) -> bool:
    value = func.value
    return (
        isinstance(value, ast.Attribute)
        and value.attr == "path"
        and isinstance(value.value, ast.Name)
        and value.value.id == "os"
    )


def _flags_are_acceptable(source: str, flags, constant_name: str, required: tuple) -> bool:
    """The flags expression must be the named module-level constant, or spell
    out every required token inline. Either way the token that matters cannot
    be dropped without the walk seeing it."""
    if isinstance(flags, ast.Name) and flags.id == constant_name:
        return True
    rendered = ast.get_source_segment(source, flags) if flags is not None else ""
    return bool(rendered) and all(token in rendered for token in required)


def _descriptor_pinning_violations(source: str) -> list[str]:
    """Return a list of violation descriptions; an empty list means pinned."""
    tree = ast.parse(source)
    descriptors = _descriptor_names(tree)
    violations: list[str] = []

    for flag_name, required in (
        (_DIR_OPEN_FLAGS_NAME, _REQUIRED_DIR_OPEN_FLAG_TOKENS),
        (_ENTRY_OPEN_FLAGS_NAME, _REQUIRED_ENTRY_OPEN_FLAG_TOKENS),
    ):
        expression = _flag_expression_source(tree, source, flag_name)
        if not expression:
            violations.append(f"no module-level {flag_name} assignment")
            continue
        missing = [token for token in required if token not in expression]
        if missing:
            violations.append(f"{flag_name} is missing {missing}")

    path_lstat_calls = 0
    pinned_lstat_calls = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id == "open":
            rendered = ast.get_source_segment(source, node) or "open(...)"
            violations.append(f"builtin open() reads by path: {rendered}")
            continue
        if not isinstance(func, ast.Attribute):
            continue
        rendered = ast.get_source_segment(source, node) or f"os.{func.attr}(...)"
        keywords = {keyword.arg: keyword.value for keyword in node.keywords}
        pinned_to = keywords.get("dir_fd")
        if pinned_to is not None and not (
            isinstance(pinned_to, ast.Name) and pinned_to.id in descriptors
        ):
            violations.append(f"dir_fd is not an os.open() descriptor: {rendered}")

        name = func.attr
        if _is_os_path_call(func):
            if name in _PATH_RESOLVING_OSPATH_CALLS:
                violations.append(f"os.path.{name}() resolves a path: {rendered}")
            continue
        if name not in _PATH_RESOLVING_OS_CALLS:
            continue

        # The entry open is descriptor-relative, and the flags it actually
        # uses are what keeps a swapped-in symlink from being followed out of
        # the archive -- so they are checked at the call site, not only where
        # the constant is defined.
        if name == "open" and "dir_fd" in keywords:
            flags = node.args[1] if len(node.args) > 1 else None
            if not _flags_are_acceptable(
                source, flags, _ENTRY_OPEN_FLAGS_NAME, _REQUIRED_ENTRY_OPEN_FLAG_TOKENS
            ):
                violations.append(
                    f"entry os.open() does not carry {_ENTRY_OPEN_FLAGS_NAME}"
                    f" or {list(_REQUIRED_ENTRY_OPEN_FLAG_TOKENS)}: {rendered}"
                )
            continue

        first = node.args[0] if node.args else None
        if "dir_fd" in keywords or (isinstance(first, ast.Name) and first.id in descriptors):
            if name == "lstat":
                pinned_lstat_calls += 1
            continue

        # Everything below resolves a path. Exactly two are budgeted.
        if name == "open":
            # Budgeted exception 1: the single open that PRODUCES the
            # descriptor everything else is addressed to.
            flags = node.args[1] if len(node.args) > 1 else None
            if not _flags_are_acceptable(
                source, flags, _DIR_OPEN_FLAGS_NAME, _REQUIRED_DIR_OPEN_FLAG_TOKENS
            ):
                violations.append(
                    f"os.open() without dir_fd does not use {_DIR_OPEN_FLAGS_NAME}: {rendered}"
                )
            continue
        if name == "lstat":
            # Budgeted exception 2: the refusal label, counted below.
            path_lstat_calls += 1
            continue
        if name == "listdir":
            violations.append(f"listing is not addressed to an os.open() descriptor: {rendered}")
            continue
        violations.append(f"os.{name}() resolves a path: {rendered}")

    if pinned_lstat_calls < 1:
        violations.append("no os.lstat(..., dir_fd=...): archive entries are stat-ed by path")
    if path_lstat_calls > _MAX_LABEL_ONLY_PATH_LSTAT_CALLS:
        violations.append(
            f"{path_lstat_calls} os.lstat() calls resolve a path; at most "
            f"{_MAX_LABEL_ONLY_PATH_LSTAT_CALLS} (the refusal label) is allowed"
        )
    return violations


# Each control is a script fragment that MUST be rejected, paired with the
# substring of the rejection that names why. Without these the walk above
# would pass on anything that merely lacked the shapes it looks for.
_PINNING_NEGATIVE_CONTROLS = (
    (
        "listing resolved from a path",
        "import os\nnames = sorted(os.listdir(os.path.join(root, 'relayed')))\n",
        "listing is not addressed",
    ),
    (
        "entry read through the builtin open",
        "with open(entry, 'rb') as handle:\n    body = handle.read()\n",
        "builtin open()",
    ),
    (
        "check and use as two path lstats",
        "import os\nfirst = os.lstat(directory)\nsecond = os.lstat(entry)\n",
        "resolve a path",
    ),
    (
        "entry stat pinned to something that is not a descriptor",
        "import os\ninfo = os.lstat(name, dir_fd=some_other_value)\n",
        "dir_fd is not an os.open() descriptor",
    ),
    (
        "entry open keeps dir_fd but drops O_NOFOLLOW",
        "import os\nfd = os.open(directory, DIR_OPEN_FLAGS)\n"
        "entry_fd = os.open(name, os.O_RDONLY, dir_fd=fd)\n",
        "entry os.open() does not carry",
    ),
    (
        "aggregates re-stat by path with os.stat",
        "import os\nfd = os.open(directory, DIR_OPEN_FLAGS)\n"
        "again = os.stat(os.path.join(directory, name))\n",
        "os.stat() resolves a path",
    ),
    (
        "re-listing spelled os.scandir",
        "import os\nfd = os.open(directory, DIR_OPEN_FLAGS)\n"
        "for entry in os.scandir(directory):\n    pass\n",
        "os.scandir() resolves a path",
    ),
    (
        "symlink target read by path with os.readlink",
        "import os\nfd = os.open(directory, DIR_OPEN_FLAGS)\n"
        "target = os.readlink(os.path.join(directory, name))\n",
        "os.readlink() resolves a path",
    ),
    (
        "existence probed through os.path",
        "import os\nfd = os.open(directory, DIR_OPEN_FLAGS)\n"
        "present = os.path.isdir(directory)\n",
        "os.path.isdir() resolves a path",
    ),
)


_SWAP_TARGET_NAME = "b.swapme.relayed"
_OUTSIDE_SOURCE_KIND = "OUTSIDEENTRYSWAPKIND"
_OUTSIDE_AGE_SECONDS = 999_999


def _run_census_in_process(collector, root: Path) -> dict:
    """Execute the shipped script text in THIS process so a swap can be
    driven from inside the syscall the script itself makes.

    The subprocess helper above is the normal path and covers everything
    else; a check-then-use window cannot be opened from outside the process
    deterministically, and a sleep-and-hope race is not a test.
    """
    namespace: dict = {"__name__": "__main__"}
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            exec(compile(collector.REMOTE_ARCHIVE_CENSUS_SCRIPT, "<census>", "exec"), namespace)
    except SystemExit as exit_exc:  # the script exits 3 on its quiet-failure path
        raise AssertionError(f"census exited {exit_exc.code}; stdout={captured.getvalue()!r}")
    return json.loads(captured.getvalue())


def test_census_refuses_an_entry_swapped_for_a_symlink_after_it_was_stat_ed(
    collector, tmp_path, monkeypatch
):
    """The entry-open flags are load-bearing, so an entry-level swap must be
    exercised and not merely described.

    `test_census_still_refuses_a_symlinked_entry_inside_a_real_archive` plants
    its symlink BEFORE the run, so the entry stat rejects it and the open is
    never reached -- which leaves the open's own O_NOFOLLOW untested. Here the
    entry is a real file when it is stat-ed and a symlink to a file outside
    the archive by the time it is opened. Without O_NOFOLLOW on that open the
    census reads a file that is not in the archive and that file's mtime
    reaches the payload as an age.
    """
    root = tmp_path / "bot-errors"
    relayed = root / "relayed"
    _write_artifact(relayed, "a.keep.relayed", _event(), age_seconds=_HOUR)
    _write_artifact(relayed, _SWAP_TARGET_NAME, _event(), age_seconds=_HOUR)
    (root / "writefail-relayed").mkdir(parents=True)
    outside = tmp_path / "outside-of-the-archive.json"
    outside.write_text(_event(source=_OUTSIDE_SOURCE_KIND), encoding="utf-8")
    os.utime(outside, (_NOW - _OUTSIDE_AGE_SECONDS, _NOW - _OUTSIDE_AGE_SECONDS))

    real_lstat = os.lstat
    fired: list[str] = []

    def swapping_lstat(path, *args, **kwargs):
        info = real_lstat(path, *args, **kwargs)
        if path == _SWAP_TARGET_NAME and not fired:
            # The stat has already returned a regular file; the name now
            # points outside the archive. This is the window.
            fired.append(path)
            os.unlink(relayed / _SWAP_TARGET_NAME)
            os.symlink(outside, relayed / _SWAP_TARGET_NAME)
        return info

    monkeypatch.setattr(os, "lstat", swapping_lstat)
    monkeypatch.setattr(sys, "argv", ["census", str(root), str(_NOW)])
    report = _run_census_in_process(collector, root)
    assert fired, "the swap never fired; the fixture did not create the window"

    block = report["archives"]["relayed"]
    # The outside file is never opened, so its producer never appears ...
    assert block["sourceKindCardinality"] == 1
    assert _OUTSIDE_SOURCE_KIND not in json.dumps(report)
    # ... and its mtime never becomes an age.
    assert block["oldestAgeSeconds"] == _HOUR
    assert block["newestAgeSeconds"] == _HOUR
    # The swapped entry is reported as something the census could not look
    # at, rather than counted from the stat it took before the swap.
    assert block["artifactCount"] == 1
    assert block["unusableEntryCount"] == 1
    assert block["status"] == "partial"
    assert report["total"]["unusableEntryCount"] == 1


def test_census_counts_an_entry_swapped_for_a_directory_as_unusable(
    collector, tmp_path, monkeypatch
):
    """The other half of the same window: the name is a regular file at the
    stat and a directory at the open, so `os.fstat` on the descriptor
    disagrees with the stat. The entry is not an artifact and the swap the
    census detected has to survive into the report."""
    root = tmp_path / "bot-errors"
    relayed = root / "relayed"
    _write_artifact(relayed, "a.keep.relayed", _event(), age_seconds=_HOUR)
    _write_artifact(relayed, _SWAP_TARGET_NAME, _event(), age_seconds=_HOUR)
    (root / "writefail-relayed").mkdir(parents=True)

    real_lstat = os.lstat
    fired: list[str] = []

    def swapping_lstat(path, *args, **kwargs):
        info = real_lstat(path, *args, **kwargs)
        if path == _SWAP_TARGET_NAME and not fired:
            fired.append(path)
            os.unlink(relayed / _SWAP_TARGET_NAME)
            (relayed / _SWAP_TARGET_NAME).mkdir()
        return info

    monkeypatch.setattr(os, "lstat", swapping_lstat)
    monkeypatch.setattr(sys, "argv", ["census", str(root), str(_NOW)])
    report = _run_census_in_process(collector, root)
    assert fired, "the swap never fired; the fixture did not create the window"

    block = report["archives"]["relayed"]
    assert block["artifactCount"] == 1
    assert block["unusableEntryCount"] == 1
    assert block["status"] == "partial"


def test_census_contains_a_failing_entry_stat_and_still_reports_every_other_entry(
    collector, tmp_path, monkeypatch
):
    """One bad entry must cost one entry, not the whole census.

    The stat on the freshly opened entry sat in a try/finally with no OSError
    handler while every neighbouring entry-level failure was contained, so a
    single I/O error or stale handle discarded the accumulated report for
    BOTH archive directories and returned the quiet failure payload. It fails
    closed, but an operator loses an answer that was almost entirely
    collected."""
    root = tmp_path / "bot-errors"
    relayed = root / "relayed"
    for index in range(3):
        _write_artifact(relayed, f"a.json.{index}.relayed", _event(), age_seconds=_HOUR)
    _write_artifact(root / "writefail-relayed", "d.json.1.relayed", _event(), age_seconds=_DAY)

    real_fstat = os.fstat
    calls: list[int] = []

    def failing_fstat(descriptor, *args, **kwargs):
        calls.append(descriptor)
        if len(calls) == 1:
            raise OSError(errno.EIO, "injected entry stat failure")
        return real_fstat(descriptor, *args, **kwargs)

    monkeypatch.setattr(os, "fstat", failing_fstat)
    monkeypatch.setattr(sys, "argv", ["census", str(root), str(_NOW)])
    report = _run_census_in_process(collector, root)
    assert calls, "the injected stat failure never fired"

    assert report["censusStatus"] == "ok"
    block = report["archives"]["relayed"]
    assert block["artifactCount"] == 2
    assert block["unusableEntryCount"] == 1
    assert block["status"] == "partial"
    # The neighbouring archive is untouched -- the failure cost one entry.
    assert report["archives"]["writefailRelayed"]["status"] == "ok"
    assert report["archives"]["writefailRelayed"]["artifactCount"] == 1
    assert report["total"]["artifactCount"] == 3
    assert report["total"]["unusableEntryCount"] == 1


def test_census_refuses_a_directory_it_cannot_pin_when_an_open_flag_is_absent(
    collector, tmp_path, monkeypatch
):
    """The flags are looked up with getattr so an unsupported platform does
    not raise before the fail-quiet guard is even installed. Degrading
    silently instead would be worse than raising: the census would keep
    counting through a name it can neither pin nor refuse. It reports the
    directory unavailable and still emits a well-formed payload."""
    root = tmp_path / "bot-errors"
    _write_artifact(root / "relayed", "a.json.1.relayed", _event(), age_seconds=_HOUR)
    (root / "writefail-relayed").mkdir(parents=True)

    monkeypatch.delattr(os, "O_DIRECTORY", raising=False)
    monkeypatch.setattr(sys, "argv", ["census", str(root), str(_NOW)])
    report = _run_census_in_process(collector, root)

    assert report["censusStatus"] == "ok"
    for label in ("relayed", "writefailRelayed"):
        block = report["archives"][label]
        assert block["status"] == "unavailable"
        assert block["errnoClass"] == "other"
        assert block["artifactCount"] is None
    assert report["total"]["status"] == "partial"
    assert report["total"]["artifactCount"] is None


def test_census_addresses_every_read_to_a_pinned_directory_descriptor(collector):
    """`os.lstat(directory)` then `os.listdir(directory)` were two
    independent resolutions of the same name with nothing pinning the inode,
    so whoever can write the archive parent could swap the directory for a
    symlink in the window and redirect every aggregate. Opening the directory
    once and addressing the listing, the entry stats and the entry reads to
    that descriptor removes the window rather than narrowing it."""
    violations = _descriptor_pinning_violations(collector.REMOTE_ARCHIVE_CENSUS_SCRIPT)
    assert violations == [], "; ".join(violations)


@pytest.mark.parametrize(
    "label, fragment, expected",
    _PINNING_NEGATIVE_CONTROLS,
    ids=[control[0] for control in _PINNING_NEGATIVE_CONTROLS],
)
def test_descriptor_pinning_walk_is_not_vacuous(label, fragment, expected):
    """Falsifier: prove the walk goes RED on each unpinned shape it claims to
    catch, so a green run above is evidence and not an absence of triggers."""
    violations = _descriptor_pinning_violations(fragment)
    assert any(expected in violation for violation in violations), f"{label}: {violations!r}"


# ---------------------------------------------------------------------------
# 2. Scope: nothing outside the two archive directories is read.
# ---------------------------------------------------------------------------


def test_census_scans_only_the_two_collector_archive_directories(collector, populated_root):
    """The remote root also holds the live queue (`outbox/`) and in-flight
    claims (`relay-processing/`). Sweeping those into an ARCHIVE census would
    conflate archive volume with current backlog -- the exact confusion #2459
    is about. Sibling content must not move any number."""
    before = _census(collector, populated_root)

    for sibling in ("outbox", "relay-processing", "relay-writefail-processing", "quarantine"):
        _write_artifact(populated_root / sibling, "x.json", _event(source="unrelated_source"), age_seconds=_DAY)
    # A nested directory inside an archive must not be walked either.
    _write_artifact(populated_root / "relayed" / "nested", "y.json", _event(source="nested"), age_seconds=_DAY)

    after = _census(collector, populated_root)
    assert after == before


# ---------------------------------------------------------------------------
# 3. Privacy (C3's "aggregates only" half).
# ---------------------------------------------------------------------------


_SEEDED_TOKENS = {
    # Deliberately a synthetic token, not a real fleet host name: this file is
    # public and the repo-hygiene guard rejects private host labels.
    "host": "SEEDEDHOSTTOKEN.example",
    "account": "SEEDEDACCOUNTTOKEN",
    "instance": "SEEDEDINSTANCETOKEN",
    "user": "SEEDEDUSERTOKEN",
    "summary": "PAYLOADSECRETsupersensitivemessagebody",
    "path_component": "SECRETPATHSEGMENT",
    "event_id": "evt-IDENTIFIER-9f2c",
    "source": "SECRETSOURCEKIND",
}


def test_census_output_contains_none_of_the_seeded_identifying_tokens(collector, tmp_path):
    """Every seeded token appears in a well-formed artifact AND in a malformed
    one, so the parse-failure branch is proven not to leak either. The tokens
    are also planted in the file names and in the remote root path itself,
    because argv and directory listings are the two other ways a probe like
    this leaks."""
    root = tmp_path / _SEEDED_TOKENS["path_component"] / "bot-errors"
    identifying = _event(
        id=_SEEDED_TOKENS["event_id"],
        instance=_SEEDED_TOKENS["instance"],
        source=_SEEDED_TOKENS["source"],
        summary=_SEEDED_TOKENS["summary"],
        host=_SEEDED_TOKENS["host"],
        account=_SEEDED_TOKENS["account"],
        user=_SEEDED_TOKENS["user"],
    )
    malformed = identifying[:-8] + "  <-- truncated, not JSON"
    named = f"{_SEEDED_TOKENS['event_id']}.json.1.relayed"
    _write_artifact(root / "relayed", named, identifying, age_seconds=_HOUR)
    _write_artifact(root / "relayed", f"{named}.broken", malformed, age_seconds=_HOUR)
    _write_artifact(root / "writefail-relayed", named, identifying, age_seconds=_DAY)
    _write_artifact(root / "writefail-relayed", f"{named}.broken", malformed, age_seconds=_DAY)

    returncode, stdout, stderr = _run_census(collector, root)
    assert returncode == 0, stderr

    # Positive control: the fixture really does contain the tokens, so an
    # absence assertion below cannot pass because the seeding silently failed.
    seeded_text = (root / "relayed" / named).read_text(encoding="utf-8")
    for label, token in _SEEDED_TOKENS.items():
        if label == "path_component":
            continue
        assert token in seeded_text, f"fixture never seeded {label}"

    for label, token in _SEEDED_TOKENS.items():
        assert token not in stdout, f"census stdout leaked {label}"
        assert token not in stderr, f"census stderr leaked {label}"

    # The archive is non-empty, so the absence above is not vacuous.
    report = json.loads(stdout)
    assert report["total"]["artifactCount"] == 4
    assert report["total"]["parseFailureCount"] == 2
    assert report["total"]["sourceKindCardinality"] == 1


def test_census_emits_only_numeric_aggregates_and_fixed_labels(collector, populated_root):
    """Structural privacy proof: every leaf value in the report is a number,
    a null, or the fixed status string. A future field carrying a path, a
    host or a message would be a string leaf and would fail here even if no
    test happened to seed that exact token."""
    report = _census(collector, populated_root)

    # Every string the census may emit comes from a closed vocabulary. This is
    # stronger than allowing a field NAME to hold any string: a status field
    # that started carrying an errno message would fail here.
    allowed_string_fields = {"censusStatus", "status", "errnoClass"}
    allowed_string_values = {
        "ok", "failed", "partial", "unavailable", "refused_symlink",
        "permission", "missing", "other",
    }

    def walk(node, trail: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{trail}.{key}")
            return
        if isinstance(node, str):
            assert trail.split(".")[-1] in allowed_string_fields, f"string leaf at {trail}: {node!r}"
            assert node in allowed_string_values, f"unvetted string value at {trail}: {node!r}"
            return
        assert node is None or isinstance(node, (int, float)), f"unexpected leaf at {trail}: {node!r}"

    walk(report, "report")
    # Coverage assertion: the walk must actually have visited leaves.
    assert report["total"]["artifactCount"] == 5


_FAILURE_ROOT_TOKEN = "FAILUREROOTTOKEN"
_FAILURE_CLOCK_TOKEN = "FAILURECLOCKTOKEN"


def _run_census_raw(collector, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-", *args],
        input=collector.REMOTE_ARCHIVE_CENSUS_SCRIPT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=60,
        check=False,
    )


def test_census_failure_payload_leaks_neither_the_root_nor_a_seeded_token(collector, tmp_path):
    """S3: the fail-quiet promise was never asserted on the SCRIPT side.

    An unhandled exception makes Python print a traceback naming the failing
    line and the offending value -- and the offending value is argv, which
    carries the remote root. The census must answer a forced failure with the
    fixed failed payload and nothing else, on both streams.
    """
    root = tmp_path / _FAILURE_ROOT_TOKEN / "bot-errors"
    root.mkdir(parents=True)

    # A clock argument that cannot be parsed: the failure happens while
    # reading argv, which is exactly where a traceback would echo it.
    proc = _run_census_raw(collector, [str(root), f"NOT-A-NUMBER-{_FAILURE_CLOCK_TOKEN}"])

    assert proc.returncode != 0, "a census that could not run must not exit 0"
    for stream_name, stream in (("stdout", proc.stdout), ("stderr", proc.stderr)):
        assert _FAILURE_ROOT_TOKEN not in stream, f"{stream_name} leaked the remote root"
        assert _FAILURE_CLOCK_TOKEN not in stream, f"{stream_name} leaked the clock argument"
        assert "Traceback" not in stream, f"{stream_name} carried a traceback"
    assert json.loads(proc.stdout) == {"schemaVersion": 1, "censusStatus": "failed"}


def test_census_failure_payload_is_quiet_when_argv_is_missing_entirely(collector):
    """The same guarantee with no arguments at all -- an IndexError raised
    while reading argv must not become a traceback either."""
    proc = _run_census_raw(collector, [])
    assert proc.returncode != 0
    assert "Traceback" not in proc.stderr
    assert json.loads(proc.stdout) == {"schemaVersion": 1, "censusStatus": "failed"}


def test_census_privacy_walk_is_not_vacuous():
    """Falsifier: the structural walk above must go RED on a leaked string."""
    leaked = {"archives": {"relayed": {"remoteRoot": "/srv/whatsoup/bot-errors"}}}

    def walk(node, trail: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{trail}.{key}")
            return
        if isinstance(node, str):
            assert trail.split(".")[-1] in {"censusStatus"}, f"string leaf at {trail}: {node!r}"
            return

    with pytest.raises(AssertionError):
        walk(leaked, "report")


# ---------------------------------------------------------------------------
# 4. The census must not mutate the archive.
# ---------------------------------------------------------------------------


def test_census_leaves_every_archive_artifact_untouched(collector, populated_root):
    """#2459 Leaf A deletes nothing. Proven by comparing name, size and mtime
    of every artifact before and after, not by reading the script."""

    def snapshot() -> dict[str, tuple[int, int]]:
        result: dict[str, tuple[int, int]] = {}
        for path in sorted(populated_root.rglob("*")):
            if path.is_file():
                stat = path.stat()
                result[str(path.relative_to(populated_root))] = (stat.st_size, int(stat.st_mtime))
        return result

    before = snapshot()
    assert before, "fixture produced no artifacts to protect"
    _census(collector, populated_root)
    assert snapshot() == before


# ---------------------------------------------------------------------------
# 5. The ssh call assembly for the census is read-only and pipes only the
#    vetted constant (same contract test_bot_errors_remote_command_readonly.py
#    holds the other remote scripts to).
# ---------------------------------------------------------------------------


def test_remote_archive_census_pipes_only_the_known_census_script(collector, monkeypatch):
    calls: list[dict] = []

    def fake_run(cmd, **kwargs):
        calls.append({"cmd": list(cmd), "kwargs": kwargs})
        return subprocess.CompletedProcess(args=[], returncode=0, stdout='{"censusStatus": "ok"}', stderr="")

    monkeypatch.setattr(collector.subprocess, "run", fake_run)
    report = collector.remote_archive_census("host-a", "/remote/root", 5, now=_NOW)

    assert report == {"censusStatus": "ok"}
    assert len(calls) == 1
    call = calls[0]
    assert call["cmd"] == [
        *collector.ssh_command(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
        "host-a", "python3", "-", "/remote/root", str(_NOW),
    ]
    assert call["kwargs"].get("shell") is not True
    assert call["kwargs"]["input"] is collector.REMOTE_ARCHIVE_CENSUS_SCRIPT


def test_remote_archive_census_failure_message_carries_no_remote_detail(collector, monkeypatch):
    """The other remote helpers append `proc.stderr` to their RuntimeError.
    The census must not: its stderr can name the remote root, and the whole
    point of C3 is that operating this probe cannot surface a path."""

    # Seeded tokens, not structural words: asserting that a word like
    # "relayed" is absent would fail on a host whose NAME contained it, for a
    # reason unrelated to the leak under test.
    leaked_root = "/srv/REMOTEROOTTOKEN/bot-errors"
    leaked_stderr = f"Traceback: {leaked_root}/relayed/STDERRLEAKTOKEN"

    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(args=[], returncode=3, stdout="", stderr=leaked_stderr)

    monkeypatch.setattr(collector.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError) as excinfo:
        collector.remote_archive_census("host-a", leaked_root, 5)
    message = str(excinfo.value)
    assert "rc=3" in message, "the failure must still be diagnosable as a non-zero exit"
    assert "REMOTEROOTTOKEN" not in message, "the remote root reached the error message"
    assert "STDERRLEAKTOKEN" not in message, "remote stderr reached the error message"
    assert leaked_stderr not in message


def _dir_bytes(directory: Path) -> int:
    return sum(path.stat().st_size for path in directory.iterdir() if path.is_file())


# ---------------------------------------------------------------------------
# 6. Wrapper failure routes. Every route out of remote_archive_census() must
#    name the host and nothing else; the rc-nonzero and unparseable routes
#    already did, the timeout route did not.
# ---------------------------------------------------------------------------

_WRAPPER_ROOT_TOKEN = "WRAPPERROOTTOKEN"


def test_remote_archive_census_timeout_leaks_neither_argv_nor_the_remote_root(collector, monkeypatch):
    """Item T: `subprocess.run(..., timeout=...)` raises TimeoutExpired, and
    that exception carries the FULL argv in its message -- argv that ends with
    the remote root. With no handler it propagated to the caller verbatim, so
    the one unhardened route out of this function was also the one that
    printed a path.
    """

    def fake_run(cmd, **kwargs):
        # The real TimeoutExpired is built by subprocess with exactly this
        # cmd, so the fixture reproduces the real leak rather than a stand-in.
        raise subprocess.TimeoutExpired(cmd=list(cmd), timeout=kwargs.get("timeout", 5))

    monkeypatch.setattr(collector.subprocess, "run", fake_run)
    remote_root = f"/srv/{_WRAPPER_ROOT_TOKEN}/bot-errors"

    with pytest.raises(RuntimeError) as excinfo:
        collector.remote_archive_census("host-a", remote_root, 5)

    message = str(excinfo.value)
    assert "host-a" in message, "the failure must still say which host"
    assert _WRAPPER_ROOT_TOKEN not in message, "the remote root reached the error message"
    assert "python3" not in message, "the assembled argv reached the error message"
    # `from None`: without it the TimeoutExpired stays chained as __context__
    # and its argv is printed under "During handling of the above exception".
    assert excinfo.value.__cause__ is None
    assert excinfo.value.__suppress_context__ is True


def test_remote_archive_census_timeout_is_not_swallowed(collector, monkeypatch):
    """Symmetry: hardening the timeout route must not turn a timeout into a
    successful empty census."""

    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd=list(cmd), timeout=5)

    monkeypatch.setattr(collector.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError):
        collector.remote_archive_census("host-a", "/remote/root", 5)


def _stub_run(monkeypatch, collector, stdout: str, returncode: int = 0):
    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr="")

    monkeypatch.setattr(collector.subprocess, "run", fake_run)


def test_remote_archive_census_rejects_empty_stdout_rather_than_reporting_an_empty_census(
    collector, monkeypatch
):
    """Item U: the wrapper never checked censusStatus. Empty stdout with a
    zero exit parsed to `{}` and came back as a report -- an answer that reads
    as a completed census of nothing. Same class of defect as the script side:
    the absence of an answer must not be served as an answer."""
    _stub_run(monkeypatch, collector, stdout="")

    with pytest.raises(RuntimeError) as excinfo:
        collector.remote_archive_census("host-a", f"/srv/{_WRAPPER_ROOT_TOKEN}", 5)
    assert "host-a" in str(excinfo.value)
    assert _WRAPPER_ROOT_TOKEN not in str(excinfo.value)


def test_remote_archive_census_rejects_a_failed_census_payload(collector, monkeypatch):
    """The script answers a forced failure with censusStatus "failed" and a
    non-zero exit. A caller that only checked the exit code would still be
    relying on the exit code alone; check the payload it actually returned."""
    _stub_run(monkeypatch, collector, stdout=json.dumps({"schemaVersion": 1, "censusStatus": "failed"}))

    with pytest.raises(RuntimeError):
        collector.remote_archive_census("host-a", "/remote/root", 5)


def test_remote_archive_census_accepts_a_complete_report(collector, monkeypatch):
    """Falsifier symmetry: the censusStatus check must not reject a real
    report, or every one of the rejections above would be vacuous."""
    good = {
        "schemaVersion": 1,
        "censusStatus": "ok",
        "generatedAtEpoch": _NOW,
        "archives": {},
        "total": {"status": "ok", "artifactCount": 0},
    }
    _stub_run(monkeypatch, collector, stdout=json.dumps(good))

    assert collector.remote_archive_census("host-a", "/remote/root", 5) == good
