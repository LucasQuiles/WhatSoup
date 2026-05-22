import importlib.util
import pathlib
import pytest

TOOLCHAIN_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "lib" / "toolchain.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("toolchain", TOOLCHAIN_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _which_factory(present):
    """Build a which_fn that returns a fake path for tools in `present`."""
    def _which(name):
        return f"/usr/local/bin/{name}" if name in present else None
    return _which


# ---- check_toolchain -------------------------------------------------------

def test_all_tools_present_yields_no_missing_no_warnings():
    module = _load_module()
    present = {"rg", "fd", "rga", "ast-grep", "ugrep"}
    report = module.check_toolchain(which_fn=_which_factory(present))
    assert report.missing_required == []
    assert report.missing_recommended == []
    assert report.required["rg"] == "/usr/local/bin/rg"


def test_missing_rg_appears_in_missing_required():
    module = _load_module()
    present = {"fd", "rga", "ast-grep", "ugrep"}
    report = module.check_toolchain(which_fn=_which_factory(present))
    assert report.missing_required == ["rg"]
    assert report.missing_recommended == []


def test_missing_fd_is_recommended_warning_not_required():
    module = _load_module()
    present = {"rg", "rga", "ast-grep", "ugrep"}
    report = module.check_toolchain(which_fn=_which_factory(present))
    assert report.missing_required == []
    assert "fd" in report.missing_recommended


def test_missing_rga_is_recommended_warning():
    module = _load_module()
    present = {"rg", "fd", "ast-grep", "ugrep"}
    report = module.check_toolchain(which_fn=_which_factory(present))
    assert "rga" in report.missing_recommended


def test_missing_ast_grep_is_recommended_warning():
    module = _load_module()
    present = {"rg", "fd", "rga", "ugrep"}
    report = module.check_toolchain(which_fn=_which_factory(present))
    assert "ast-grep" in report.missing_recommended


def test_missing_ugrep_does_not_appear_anywhere():
    """SPEC §738: ugrep is optional and unblocked."""
    module = _load_module()
    present = {"rg", "fd", "rga", "ast-grep"}
    report = module.check_toolchain(which_fn=_which_factory(present))
    assert report.missing_required == []
    assert report.missing_recommended == []
    assert "ugrep" not in report.required


def test_all_recommended_missing_keeps_required_empty_when_rg_present():
    module = _load_module()
    present = {"rg"}
    report = module.check_toolchain(which_fn=_which_factory(present))
    assert report.missing_required == []
    assert sorted(report.missing_recommended) == ["ast-grep", "fd", "rga"]


def test_everything_missing_reports_rg_required_and_all_recommended():
    module = _load_module()
    report = module.check_toolchain(which_fn=_which_factory(set()))
    assert report.missing_required == ["rg"]
    assert sorted(report.missing_recommended) == ["ast-grep", "fd", "rga"]


# ---- require_toolchain ----------------------------------------------------

def test_require_toolchain_empty_missing_returns_none():
    module = _load_module()
    report = module.ToolchainReport(
        required={"rg": "/usr/local/bin/rg"},
        missing_required=[],
        missing_recommended=[],
    )
    result = module.require_toolchain(report)
    assert result is None


def test_require_toolchain_with_missing_required_raises():
    module = _load_module()
    report = module.ToolchainReport(
        required={"rg": None},
        missing_required=["rg"],
        missing_recommended=["fd"],
    )
    with pytest.raises(module.MissingToolchainError) as exc_info:
        module.require_toolchain(report)
    assert exc_info.value.missing == ["rg"]
    assert "rg" in str(exc_info.value)


def test_require_toolchain_ignores_recommended_warnings():
    """Missing recommended tools are surfaced but do not block."""
    module = _load_module()
    report = module.ToolchainReport(
        required={"rg": "/usr/local/bin/rg"},
        missing_required=[],
        missing_recommended=["fd", "rga", "ast-grep"],
    )
    result = module.require_toolchain(report)
    assert result is None


# ---- live PATH integration -----------------------------------------------

def test_check_toolchain_default_which_uses_shutil_which():
    """Without an injected which_fn, the function defers to shutil.which.
    We can't assert on the live host's PATH content, but we CAN assert the
    function runs without error and returns a ToolchainReport whose required
    dict has exactly the documented tools as keys."""
    module = _load_module()
    report = module.check_toolchain()
    assert set(report.required.keys()) == {"rg"}
