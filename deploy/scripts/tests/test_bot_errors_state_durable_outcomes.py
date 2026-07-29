"""Fail-closed durable-outcome consumption for utility state publishers."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
from types import ModuleType

import pytest

from deploy.scripts.lib import durable_json


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_script(file_name: str, module_name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(module_name, _SCRIPT_ROOT / file_name)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _unproven(component: str) -> durable_json.PublicationResult:
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


@pytest.mark.parametrize(
    ("command", "component"),
    [
        (["open", "fixture", "30m", "--machine", "host-a"], "maintenance.open_state"),
        (["close", "fixture", "--machine", "host-a"], "maintenance.close_state"),
    ],
)
def test_maintenance_command_rejects_unproven_state_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    command: list[str],
    component: str,
) -> None:
    module = _load_script(
        "bot-errors-maintenance.py",
        f"bot_errors_maintenance_{command[0]}_durable",
    )
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(
        module,
        "publish_state_json",
        lambda *_args, **_kwargs: _unproven(component),
        raising=False,
    )

    result = module.main(command)

    assert result == 1
    assert not (tmp_path / "state" / "maintenance.json").exists()


def test_gui_monitor_save_rejects_unproven_state_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_script(
        "bot-errors-gui-session-monitor.py",
        "bot_errors_gui_monitor_state_durable",
    )
    state_file = tmp_path / "state" / "gui-session-monitor-state.json"
    monkeypatch.setattr(module, "state_path", lambda: state_file)
    monkeypatch.setattr(
        module,
        "publish_state_json",
        lambda *_args, **_kwargs: _unproven("gui_session_monitor.state"),
        raising=False,
    )

    with pytest.raises(RuntimeError) as raised:
        module.save_state({"fixture": {"consecutive_failures": 1}})

    assert type(raised.value).__name__ == "DurableWriteError"
    assert not state_file.exists()


def test_gui_monitor_save_merges_concurrent_observed_keys(
    tmp_path: Path,
) -> None:
    module = _load_script(
        "bot-errors-gui-session-monitor.py",
        "bot_errors_gui_monitor_state_merge",
    )
    state_file = tmp_path / "state" / "gui-session-monitor-state.json"
    state_file.parent.mkdir(mode=0o700)
    state_file.write_text('{"concurrent":{"consecutive_failures":2}}\n', encoding="utf-8")
    state_file.chmod(0o600)
    module.state_path = lambda: state_file

    module.save_state({"fixture": {"consecutive_failures": 1}})

    observed = durable_json.observe_json(
        durable_json.durable_json_target(
            trusted_root=state_file.parent.resolve(strict=True),
            relative_path=state_file.name,
        )
    )
    assert observed.payload == {
        "concurrent": {"consecutive_failures": 2},
        "fixture": {"consecutive_failures": 1},
    }
