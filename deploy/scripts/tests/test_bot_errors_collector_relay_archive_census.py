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

import importlib.util
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


def test_census_total_stays_partial_and_counts_only_what_it_could_read(collector, tmp_path):
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
