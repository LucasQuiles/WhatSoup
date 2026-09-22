"""Absent vs unobservable in the active-service inventory (#2486).

The inventory reader returned a bare ``set[str]``, so a missing
service-manager binary, a timeout, a nonzero exit and a malformed read all
produced the same empty set as a healthy host running zero WhatSoup services.
Profile completeness then reported full coverage from an inventory that was
never observed.

These cases drive the PUBLIC consumer (``unprofiled_service_inventory``) and
assert on the lines it emits, so they fail behaviourally on the pre-fix source
(zero FAIL lines where one is required) rather than on a missing symbol. The
one exception is the freshness case, which necessarily names the new result
type.

The branch is pinned with ``BOT_ERRORS_DRY_PLATFORM`` set BEFORE the module is
loaded and is parametrized over both service managers: this host is darwin and
CI is linux, so without the pin each would exercise a different ``except``
clause. ``BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES`` is removed for the same
reason -- when it is set the reader short-circuits before any discovery.

Loads the script via importlib (the hyphen in the filename prevents a normal
import), mirroring test_bot_errors_health_check_port_authority.py.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"
_load = dispatcher_fixtures.load_module_from_path

# One active, undeclared WhatSoup service in each backend's grammar. The unit
# name is composed rather than written whole: a literal `whatsoup@<name>.service`
# reads as an email address to the repo hygiene guard.
_ROGUE = "rogue-instance"
_ROGUE_UNIT = f"whatsoup@{_ROGUE}.service"
_LAUNCHCTL_ACTIVE = f"4242\t0\tcom.whatsoup.{_ROGUE}\n"
_SYSTEMCTL_ACTIVE = f"{_ROGUE_UNIT} loaded active running WhatSoup {_ROGUE}\n"
# A line cut mid-record: too few fields for the backend's grammar.
_LAUNCHCTL_TRUNCATED = "4242\n"
_SYSTEMCTL_TRUNCATED = f"{_ROGUE_UNIT} loaded\n"
# A record cut INSIDE the discriminating token. The field count is intact and
# the token no longer matches, so a field-count check sees nothing and the row
# is silently skipped; only a token-level check catches it.
_LAUNCHCTL_TOKEN_CUT = "4242\t0\tcom.what\n"
_SYSTEMCTL_TOKEN_CUT = f"whatsoup@{_ROGUE}.serv loaded active running WhatSoup\n"


class _FakeProc:
    def __init__(self, stdout: str, returncode: int):
        self.stdout = stdout
        self.returncode = returncode


@pytest.fixture(params=["darwin", "linux"])
def backend_env(request, monkeypatch):
    """Load the script with one service-manager branch pinned.

    monkeypatch is function-scoped, so the pinned environment is undone after
    each case and nothing leaks to sibling test files sharing the session.
    """
    platform = request.param
    monkeypatch.setenv("BOT_ERRORS_DRY_PLATFORM", platform)
    # A WSL kernel release would route linux through launchctl (that backend
    # divergence is a separate defect); pin a plain release so the branch under
    # test is the one this parameter names.
    monkeypatch.setenv("BOT_ERRORS_DRY_PLATFORM_RELEASE", "6.8.0-generic")
    monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)
    monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
    module = _load(f"bot_errors_health_check_2486_{platform}", _SCRIPT)
    return {
        "module": module,
        "platform": platform,
        "backend": "launchctl" if platform == "darwin" else "systemctl",
        "active_line": _LAUNCHCTL_ACTIVE if platform == "darwin" else _SYSTEMCTL_ACTIVE,
        "truncated_line": (
            _LAUNCHCTL_TRUNCATED if platform == "darwin" else _SYSTEMCTL_TRUNCATED
        ),
        "token_cut_line": (
            _LAUNCHCTL_TOKEN_CUT if platform == "darwin" else _SYSTEMCTL_TOKEN_CUT
        ),
    }


def _drive(backend_env, tmp_path, fake_run):
    """Return the lines the profile-coverage consumer emits for one fake read."""
    module = backend_env["module"]
    with patch("subprocess.run", fake_run):
        return module.unprofiled_service_inventory(tmp_path, set())


def _inventory_fails(lines: list[str]) -> list[str]:
    return [line for line in lines if "profile_coverage_service_inventory" in line]


# ---------------------------------------------------------------------------
# C1 -- the service-manager binary is missing
# ---------------------------------------------------------------------------


def test_missing_binary_is_not_an_empty_inventory(backend_env, tmp_path):
    def raise_missing(argv, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", argv[0])

    lines = _drive(backend_env, tmp_path, raise_missing)
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    assert fails[0].startswith("FAIL profile_coverage_service_inventory:")
    assert "status=unavailable_missing_binary" in fails[0]
    assert f"backend={backend_env['backend']}" in fails[0]


# ---------------------------------------------------------------------------
# C2 -- the read times out
# ---------------------------------------------------------------------------


def test_timeout_is_not_an_empty_inventory(backend_env, tmp_path):
    def raise_timeout(argv, **kwargs):
        raise subprocess.TimeoutExpired(argv, 3)

    lines = _drive(backend_env, tmp_path, raise_timeout)
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    assert "status=unavailable_timeout" in fails[0]
    assert f"backend={backend_env['backend']}" in fails[0]


# ---------------------------------------------------------------------------
# C3 -- a nonzero exit is never an observation, with or without stdout
# ---------------------------------------------------------------------------


def test_nonzero_exit_with_empty_stdout_is_not_an_empty_inventory(
    backend_env, tmp_path
):
    lines = _drive(backend_env, tmp_path, lambda argv, **kw: _FakeProc("", 1))
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    assert "status=unavailable_nonzero_exit" in fails[0]


def test_nonzero_exit_never_parses_its_stdout(backend_env, tmp_path):
    """A failed command's residual output must not become an observation."""
    lines = _drive(
        backend_env,
        tmp_path,
        lambda argv, **kw: _FakeProc(backend_env["active_line"], 1),
    )
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    assert "status=unavailable_nonzero_exit" in fails[0]
    # The rogue name reached stdout but the command failed, so nothing may be
    # reported about it -- neither as a coverage FAIL nor as observed coverage.
    assert not [line for line in lines if "rogue-instance" in line], lines


# ---------------------------------------------------------------------------
# C4 -- unreadable and duplicate records are counted, not silently dropped
# ---------------------------------------------------------------------------


def _rogue_coverage(lines: list[str]) -> list[str]:
    return [
        line for line in lines if line.startswith(f"FAIL profile_coverage_service {_ROGUE}:")
    ]


def test_unreadable_record_among_good_ones_is_partial(backend_env, tmp_path):
    """A partly readable inventory must not hide the names it did read.

    The gate stays non-green because coverage cannot be proven from an
    incomplete read, but every positively observed name still reaches the
    undeclared-instance comparison.
    """
    stdout = backend_env["active_line"] + backend_env["truncated_line"]
    lines = _drive(backend_env, tmp_path, lambda argv, **kw: _FakeProc(stdout, 0))
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    assert "status=partial" in fails[0]
    assert "unreadable_lines=1" in fails[0]
    assert "count=1" in fails[0]
    assert len(_rogue_coverage(lines)) == 1, lines


def test_duplicate_record_among_good_ones_is_partial(backend_env, tmp_path):
    stdout = backend_env["active_line"] * 2
    lines = _drive(backend_env, tmp_path, lambda argv, **kw: _FakeProc(stdout, 0))
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    assert "status=partial" in fails[0]
    assert "duplicate_labels=1" in fails[0]
    assert len(_rogue_coverage(lines)) == 1, lines


def test_all_records_unusable_stays_malformed(backend_env, tmp_path):
    """Nothing usable was read, so there is no name to carry."""
    stdout = backend_env["truncated_line"] * 2
    lines = _drive(backend_env, tmp_path, lambda argv, **kw: _FakeProc(stdout, 0))
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    assert "status=malformed" in fails[0]
    assert "count=0" in fails[0]
    assert _rogue_coverage(lines) == [], lines


# ---------------------------------------------------------------------------
# Q -- a record cut inside the discriminating token is unusable, not observed
# ---------------------------------------------------------------------------


def test_token_truncation_alone_is_unusable(backend_env, tmp_path):
    stdout = backend_env["token_cut_line"]
    lines = _drive(backend_env, tmp_path, lambda argv, **kw: _FakeProc(stdout, 0))
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    assert "status=malformed" in fails[0]
    assert "unreadable_lines=1" in fails[0]


def test_token_truncation_among_good_records_is_partial(backend_env, tmp_path):
    """The surviving record must not read as full coverage."""
    stdout = backend_env["active_line"] + backend_env["token_cut_line"]
    lines = _drive(backend_env, tmp_path, lambda argv, **kw: _FakeProc(stdout, 0))
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    assert "status=partial" in fails[0]
    assert "unreadable_lines=1" in fails[0]
    assert len(_rogue_coverage(lines)) == 1, lines


def test_stream_cut_before_the_final_terminator_is_unusable(backend_env, tmp_path):
    """A stream whose last record has no terminator was cut in transit."""
    stdout = backend_env["active_line"].rstrip("\n")
    lines = _drive(backend_env, tmp_path, lambda argv, **kw: _FakeProc(stdout, 0))
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    assert "status=partial" in fails[0]
    assert "unreadable_lines=1" in fails[0]


# ---------------------------------------------------------------------------
# C5 -- a genuine zero-service host stays green AND stays distinguishable
# ---------------------------------------------------------------------------


def test_true_zero_service_host_is_green_and_distinguishable(backend_env, tmp_path):
    zero = _drive(backend_env, tmp_path, lambda argv, **kw: _FakeProc("", 0))
    assert zero == [], zero

    def raise_missing(argv, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", argv[0])

    unavailable = _drive(backend_env, tmp_path, raise_missing)
    assert unavailable != zero, "unobservable inventory reads as a true zero"


def test_observed_undeclared_service_still_reports_coverage(backend_env, tmp_path):
    """C9: the pre-existing per-service detection is unchanged on a good read."""
    lines = _drive(
        backend_env,
        tmp_path,
        lambda argv, **kw: _FakeProc(backend_env["active_line"], 0),
    )
    assert _inventory_fails(lines) == [], lines
    assert lines == [
        "FAIL profile_coverage_service rogue-instance: active service not declared "
        "in health profile service=com.whatsoup.rogue-instance config_exists=False"
    ]


# ---------------------------------------------------------------------------
# C8 (restated) -- coverage passes only on an observation that is also fresh
# ---------------------------------------------------------------------------


def test_stale_observation_cannot_report_coverage(backend_env, tmp_path):
    """An aged reading is not a current one, even when its status is observed.

    Nothing on this path persists an observation today; the gate exists so a
    future cached reading cannot report coverage from a stale inventory.
    """
    module = backend_env["module"]
    stale = module.ServiceInventoryObservation(
        status="observed",
        backend=backend_env["backend"],
        count=1,
        unreadable_lines=0,
        duplicate_labels=0,
        observed_at_monotonic=time.monotonic()
        - (module.SERVICE_INVENTORY_MAX_AGE_SECONDS * 10),
        names=frozenset({"rogue-instance"}),
    )
    lines = module.unprofiled_service_inventory(tmp_path, set(), observation=stale)
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    assert "fresh=false" in fails[0]
    assert not [line for line in lines if "rogue-instance" in line], lines


# ---------------------------------------------------------------------------
# C10 (narrow) -- the new fields carry no private value
# ---------------------------------------------------------------------------


def test_inventory_fail_line_exposes_only_status_backend_count_freshness(
    backend_env, tmp_path
):
    seeded_name = "private-account-instance"
    (tmp_path / seeded_name).mkdir()
    (tmp_path / seeded_name / "config.json").write_text("{}", encoding="utf-8")
    if backend_env["platform"] == "darwin":
        seeded_line = f"4242\t0\tcom.whatsoup.{seeded_name}\n"
    else:
        seeded_line = (
            f"whatsoup@{seeded_name}.service loaded active running seeded\n"
        )
    stdout = seeded_line + backend_env["truncated_line"]

    lines = _drive(backend_env, tmp_path, lambda argv, **kw: _FakeProc(stdout, 0))
    fails = _inventory_fails(lines)
    assert len(fails) == 1, lines
    line = fails[0]
    for forbidden in (
        seeded_name,
        "com.whatsoup.",
        str(tmp_path),
        "config.json",
        "whatsoup@",
    ):
        assert forbidden not in line, line
    assert "status=" in line
    assert "backend=" in line
    assert "count=" in line
    assert "observed_age_s=" in line
