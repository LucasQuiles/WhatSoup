"""Portable fleet monitor regression tests with synthetic local fixtures."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
from tempfile import TemporaryDirectory

import pytest
from hypothesis import example, given, settings, strategies as st


FLEET = Path(__file__).resolve().parents[1]
SCRIPTS = FLEET.parent


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_probe_requires_an_explicit_absolute_private_targets_file(tmp_path: Path) -> None:
    probe = load_module("fleet_probe_portability", FLEET / "fleet_probe.py")
    targets = tmp_path / "synthetic-targets.json"
    targets.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "hosts": {
                    "synthetic-host": {
                        "target": "operator@synthetic-host",
                        "local": True,
                        "instances": ["demo-bot"],
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    request = probe.load_target(targets, "synthetic-host")

    assert request["instances"] == ["demo-bot"]
    with pytest.raises(ValueError, match="absolute"):
        probe.load_target(Path("targets.json"), "synthetic-host")


def test_probe_accepts_the_existing_private_target_map_without_rewriting_it(tmp_path):
    probe = load_module("fleet_probe_existing_map", FLEET / "fleet_probe.py")
    inventory = {"synthetic-host": {"target": "operator@synthetic-host", "instances": []}}
    path = tmp_path / "targets.json"
    path.write_text(json.dumps(inventory))
    before = path.read_bytes()
    assert probe.load_target(path, "synthetic-host")["target"] == "operator@synthetic-host"
    assert path.read_bytes() == before


def test_existing_local_target_does_not_require_an_ssh_destination(tmp_path):
    probe = load_module("fleet_local_target", FLEET / "fleet_probe.py")
    inventory = tmp_path / "targets.json"
    inventory.write_text(json.dumps({"local-host": {"local": True, "instances": ["example-bot"]}}))
    assert probe.load_target(inventory, "local-host")["local"] is True


@given(target=st.one_of(
    st.text(max_size=40).map(lambda value: "-" + value),
    st.tuples(st.text(max_size=20), st.sampled_from([" ", "\t", "\n", "\x00", "\x7f"]), st.text(max_size=20)).map("".join),
))
@example(target="-oProxyCommand=unexpected")
@example(target="host\n-oProxyCommand=unexpected")
@example(target=" ")
@example(target="host\x00")
def test_probe_rejects_option_or_control_characters_in_ssh_destination(target):
    probe = load_module("fleet_transport_validation", FLEET / "fleet_probe.py")
    with TemporaryDirectory() as directory:
        inventory = Path(directory) / "targets.json"
        inventory.write_text(json.dumps({"remote": {"target": target, "instances": []}}))
        with pytest.raises(ValueError, match="transport target"):
            probe.load_target(inventory, "remote")


def test_probe_ssh_destination_cannot_add_transport_options(monkeypatch):
    probe = load_module("fleet_transport_arguments", FLEET / "fleet_probe.py")
    commands = []

    def capture_transport(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 255, stdout=b"", stderr=b"")

    monkeypatch.setattr(probe.subprocess, "run", capture_transport)
    result = probe.run_target({"target": "-oProxyCommand=unexpected", "instances": []})
    assert result["checks"]["ssh_reachable"] is False
    assert len(commands) == 1
    assert commands[0][-3:-1] == ["--", "-oProxyCommand=unexpected"]


def test_default_mcp_sequence_has_no_mailbox_operation(tmp_path) -> None:
    fixtures = load_module("fleet_probe_fixtures", FLEET / "tests/test_fleet_probe.py")
    result, sent, _ = fixtures.m365_probe(
        tmp_path, fixtures.TOOLS, fixtures.SIGNED_IN_CALLS,
        configured=("example-bot",), listed=("example-bot",),
    )
    assert sent == fixtures.SEQUENCE
    assert result["checks"]["m365_graph_reachable"] is True
    assert all("mail" not in name for name in sent)


def test_retired_check_clears_the_existing_incident_id() -> None:
    observer = load_module("fleet_observer_portability", FLEET / "fleet_reliability_observer.py")
    host = {"host": "synthetic-host", "instance": "operations"}
    state = observer.initial_state(0)
    payload = {
        "checked_at": 10,
        "checks": {"ssh_reachable": True, "demo_bot_health_readable": False},
        "codes": [],
        "instances": ["demo_bot"],
        "evidence": {},
        "retired_checks": [],
    }

    observer._advance_host(state, host, payload, 10, 60)
    observer._advance_host(state, host, payload, 20, 60)
    incident_id = state["hosts"]["synthetic-host"]["incidents"]["demo_bot_health_readable"]
    retired = {**payload, "checked_at": 30, "checks": {"ssh_reachable": True}, "retired_checks": ["demo_bot_health_readable"]}

    observer._advance_host(state, host, retired, 30, 60)

    assert "demo_bot_health_readable" not in state["hosts"]["synthetic-host"]["incidents"]
    assert any(
        event["kind"] == "clear" and event["incident_id"] == incident_id
        for event in state["pending_events"]
    )


def test_legacy_mail_capability_probe_is_disabled_without_opt_in(tmp_path: Path) -> None:
    supervisor = load_module("fleet_supervisor_portability", FLEET / "reliability_supervisor.py")
    state_dir = tmp_path / "state"

    result = supervisor.run_capabilities({"state_dir": str(state_dir)})

    assert result["legacy_sent_items_probe"] == {"enabled": False, "status": "disabled"}
    assert not (state_dir / "capabilities.json").exists()


def test_renderer_uses_explicit_paths_and_writes_both_jobs(tmp_path: Path) -> None:
    output_dir = tmp_path / "rendered"
    release_root = tmp_path / "release"
    fleet_root = release_root / "deploy" / "scripts" / "fleet"
    fleet_root.mkdir(parents=True)
    (fleet_root / "fleet_reliability_observer.py").write_text("# fixture\n", encoding="utf-8")
    (fleet_root / "reliability_supervisor.py").write_text("# fixture\n", encoding="utf-8")
    config = tmp_path / "private" / "fleet-observer.json"
    config.parent.mkdir()
    config.write_text("{}", encoding="utf-8")
    state_dir = tmp_path / "state"
    installer = SCRIPTS / "install-fleet-reliability-observer.sh"

    result = subprocess.run(
        [
            "bash",
            str(installer),
            "render",
            "--platform",
            "systemd",
            "--release-root",
            str(release_root),
            "--config",
            str(config),
            "--state-dir",
            str(state_dir),
            "--output-dir",
            str(output_dir),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    observer_unit = (output_dir / "com.whatsoup.fleet-observer.service").read_text(encoding="utf-8")
    deadman_unit = (output_dir / "com.whatsoup.fleet-deadman.service").read_text(encoding="utf-8")
    assert "--config" in observer_unit and str(config) in observer_unit
    assert "--watchdog" in deadman_unit and str(state_dir) in deadman_unit


def test_renderer_refuses_to_infer_a_private_configuration_path(tmp_path: Path) -> None:
    installer = SCRIPTS / "install-fleet-reliability-observer.sh"

    result = subprocess.run(
        ["bash", str(installer), "render", "--platform", "systemd", "--release-root", "/opt/whatsoup-release", "--output-dir", str(tmp_path / "rendered")],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "--config" in result.stderr


def test_install_refuses_an_existing_observer_before_service_activation(tmp_path: Path) -> None:
    release_root = tmp_path / "release"
    fleet_root = release_root / "deploy" / "scripts" / "fleet"
    fleet_root.mkdir(parents=True)
    (fleet_root / "fleet_reliability_observer.py").write_text("# fixture\n", encoding="utf-8")
    (fleet_root / "reliability_supervisor.py").write_text("# fixture\n", encoding="utf-8")
    config = tmp_path / "private" / "fleet-observer.json"
    config.parent.mkdir()
    config.write_text("{}", encoding="utf-8")
    output_dir = tmp_path / "rendered"
    install_dir = tmp_path / "installed"
    install_dir.mkdir()
    (install_dir / "com.whatsoup.fleet-observer.service").write_text("existing", encoding="utf-8")
    installer = SCRIPTS / "install-fleet-reliability-observer.sh"

    result = subprocess.run(
        [
            "bash", str(installer), "install", "--activate", "--platform", "systemd",
            "--release-root", str(release_root), "--config", str(config),
            "--state-dir", str(tmp_path / "state"), "--output-dir", str(output_dir),
            "--install-dir", str(install_dir),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 3
    assert "refusing existing job" in result.stderr


def install_fixture(tmp_path, platform, manager_body, mode="install"):
    release = tmp_path / "release"
    fleet = release / "deploy/scripts/fleet"
    fleet.mkdir(parents=True)
    for name in ("fleet_reliability_observer.py", "reliability_supervisor.py"):
        (fleet / name).write_text("# synthetic executable fixture\n")
    config = tmp_path / "private-config.json"
    config.write_text("{}")
    config.chmod(0o600)
    manager = tmp_path / "bin" / ("launchctl" if platform == "launchd" else "systemctl")
    manager.parent.mkdir()
    manager.write_text("#!/bin/bash\n" + manager_body)
    manager.chmod(0o700)
    output = tmp_path / "rendered"
    installed = tmp_path / "installed"
    installed.mkdir()
    command = ["bash", str(SCRIPTS / "install-fleet-reliability-observer.sh"), mode,
               "--platform", platform, "--release-root", str(release), "--config", str(config),
               "--state-dir", str(tmp_path / "state"), "--output-dir", str(output),
               "--install-dir", str(installed)]
    if mode == "install":
        command.append("--activate")
    environment = {**os.environ, "PATH": str(manager.parent) + os.pathsep + os.environ["PATH"],
                   "PYTHON": sys.executable, "CALLS": str(tmp_path / "calls")}
    return command, environment, output, installed


@pytest.mark.parametrize("platform", ["launchd", "systemd"])
def test_install_refuses_a_loaded_legacy_observer_even_when_destination_is_empty(tmp_path, platform):
    body = '''printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1" == "print" ]]; then
  if [[ "$2" != */com.* ]]; then exit 0; fi
  [[ "$2" == */com.agent365.fleet-observer ]] && exit 0
  exit 113
fi
if [[ "$*" == *" show "* ]]; then
  if [[ "$*" == *com.agent365.fleet-observer.service* ]]; then echo loaded; else echo not-found; fi
  exit 0
fi
exit 0
'''
    command, environment, _, installed = install_fixture(tmp_path, platform, body)
    result = subprocess.run(command, env=environment, capture_output=True, text=True)
    assert result.returncode == 3, result.stderr
    assert "existing job" in result.stderr
    assert list(installed.iterdir()) == []
    calls = (tmp_path / "calls").read_text()
    assert "bootstrap" not in calls and "enable" not in calls


@pytest.mark.parametrize("platform", ["launchd", "systemd"])
def test_install_refuses_an_unavailable_service_manager(tmp_path, platform):
    command, environment, _, installed = install_fixture(tmp_path, platform, "exit 70\n")
    result = subprocess.run(command, env=environment, capture_output=True, text=True)
    assert result.returncode != 0
    assert list(installed.iterdir()) == []
    assert "inspect" in result.stderr


def test_render_never_overwrites_an_existing_output_directory(tmp_path):
    command, environment, output, _ = install_fixture(tmp_path, "launchd", "exit 70\n", "render")
    output.mkdir()
    prior = output / "com.whatsoup.fleet-observer.plist"
    prior.write_text("preserve-existing-definition")
    result = subprocess.run(command, env=environment, capture_output=True, text=True)
    assert result.returncode != 0
    assert prior.read_text() == "preserve-existing-definition"


def test_launchd_render_resolves_python_and_keeps_observer_deadman_arguments_separate(tmp_path):
    command, environment, output, _ = install_fixture(tmp_path, "launchd", "exit 70\n", "render")
    interpreter = tmp_path / "python@3.12"
    interpreter.symlink_to(sys.executable)
    environment["PYTHON"] = str(interpreter)
    result = subprocess.run(command, env=environment, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    observer = plistlib.loads((output / "com.whatsoup.fleet-observer.plist").read_bytes())
    deadman = plistlib.loads((output / "com.whatsoup.fleet-deadman.plist").read_bytes())
    assert observer["ProgramArguments"][0] == str(interpreter)
    assert "--watchdog" not in observer["ProgramArguments"]
    assert deadman["ProgramArguments"] == observer["ProgramArguments"] + ["--watchdog"]
    assert observer["StandardErrorPath"] != deadman["StandardErrorPath"]


@pytest.mark.parametrize("mismatch", [False, True])
def test_config_preflight_validates_state_path_without_running_a_cycle(tmp_path, monkeypatch, mismatch):
    observer = load_module("fleet_preflight", FLEET / "fleet_reliability_observer.py")
    state = tmp_path / "state"
    config = tmp_path / "config.json"
    config.write_text(json.dumps({
        "state_dir": str(state), "hosts": [], "instance": "operations",
        "emitter_command": ["/synthetic/emitter"],
        "delivery_command": ["/synthetic/delivery"],
    }))
    config.chmod(0o600)
    before = config.read_bytes()
    def unexpected_cycle(*args):
        pytest.fail("configuration validation must not probe or write monitor state")
    monkeypatch.setattr(observer, "run_once", unexpected_cycle)
    monkeypatch.setattr(observer, "run_watchdog", unexpected_cycle)
    monkeypatch.setattr(sys, "argv", ["observer", "--config", str(config), "--check-config",
                                    "--state-dir", str(state if not mismatch else tmp_path / "other")])
    assert observer.main() == (1 if mismatch else 0)
    assert config.read_bytes() == before
    assert not state.exists()


@given(instance=st.one_of(st.none(), st.integers(), st.text().map(lambda value: " " + value)))
@example(instance=None)
@example(instance="")
@example(instance="invalid instance")
@example(instance=123)
def test_preflight_rejects_empty_fleet_without_valid_deadman_destination(instance):
    observer = load_module("fleet_empty_preflight", FLEET / "fleet_reliability_observer.py")
    with TemporaryDirectory() as directory:
        root = Path(directory)
        config = root / "config.json"
        value = {"state_dir": str(root / "state"), "hosts": [],
                 "emitter_command": ["/synthetic/emitter"], "delivery_command": ["/synthetic/delivery"]}
        if instance is not None:
            value["instance"] = instance
        config.write_text(json.dumps(value))
        config.chmod(0o600)
        with pytest.raises(observer.supervisor.StateError, match="config_invalid"):
            observer.load_config(config)


@given(name=st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789", min_size=1, max_size=24))
@example(name="same-host")
def test_preflight_rejects_duplicate_host_rows_that_would_double_count_a_cycle(name):
    observer = load_module("fleet_duplicate_hosts", FLEET / "fleet_reliability_observer.py")
    with TemporaryDirectory() as directory:
        root = Path(directory)
        config = root / "config.json"
        value = {
            "state_dir": str(root / "state"),
            "emitter_command": ["/synthetic/emitter"],
            "delivery_command": ["/synthetic/delivery"],
            "hosts": [
                {"host": name, "instance": "first-bot", "probe_command": ["/synthetic/probe"]},
                {"host": name + "-other", "instance": "second-bot", "probe_command": ["/synthetic/probe"]},
            ],
        }
        config.write_text(json.dumps(value))
        config.chmod(0o600)
        assert len(observer.load_config(config)["hosts"]) == 2
        value["hosts"][1]["host"] = name
        config.write_text(json.dumps(value))
        with pytest.raises(observer.supervisor.StateError, match="config_invalid"):
            observer.load_config(config)
        assert not (root / "state").exists()


@pytest.mark.parametrize("mode", ["render", "install"])
def test_installer_stops_at_failed_configuration_preflight(tmp_path, mode):
    body = '''printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1" == "print" && "$2" == */com.* ]]; then exit 113; fi
exit 0
'''
    command, environment, output, installed = install_fixture(tmp_path, "launchd", body, mode)
    observer = tmp_path / "release/deploy/scripts/fleet/fleet_reliability_observer.py"
    observer.write_text("import sys\nassert '--check-config' in sys.argv\nraise SystemExit(42)\n")
    result = subprocess.run(command, env=environment, capture_output=True, text=True)
    assert result.returncode != 0
    assert "configuration validation failed" in result.stderr
    assert not output.exists()
    assert list(installed.iterdir()) == []
    calls = tmp_path / "calls"
    assert not calls.exists() or "bootstrap" not in calls.read_text()


@pytest.mark.parametrize("mode", ["render", "install"])
@settings(deadline=None)
@given(unsafe=st.one_of(st.sampled_from(["symlink", "file"]), st.integers(min_value=0, max_value=0o777).filter(lambda mode: mode != 0o700)))
@example(unsafe=0o755)
@example(unsafe="symlink")
@example(unsafe="file")
def test_installer_rejects_unsafe_state_before_writing_jobs(mode, unsafe):
    with TemporaryDirectory() as directory:
        tmp_path = Path(directory)
        body = '''printf '%s\\n' "$*" >> "$CALLS"
if [[ "$*" == *" show "* ]]; then echo not-found; fi
exit 0
'''
        command, environment, output, installed = install_fixture(tmp_path, "systemd", body, mode)
        for name in ("fleet_reliability_observer.py", "reliability_supervisor.py"):
            (tmp_path / "release/deploy/scripts/fleet" / name).write_bytes((FLEET / name).read_bytes())
        state = tmp_path / "state"
        if isinstance(unsafe, int):
            state.mkdir(mode=0o700)
            state.chmod(unsafe)
        elif unsafe == "symlink":
            target = tmp_path / "retained-state"
            target.mkdir(mode=0o700)
            state.symlink_to(target, target_is_directory=True)
        else:
            state.write_text("retained state")
        metadata = state.lstat()
        config = tmp_path / "private-config.json"
        config.write_text(json.dumps({
            "state_dir": str(state), "hosts": [], "instance": "operations",
            "emitter_command": ["/synthetic/emitter"], "delivery_command": ["/synthetic/delivery"],
        }))
        result = subprocess.run(command, env=environment, capture_output=True, text=True)
        assert result.returncode != 0
        assert not output.exists()
        assert list(installed.iterdir()) == []
        assert (state.lstat().st_ino, state.lstat().st_mode) == (metadata.st_ino, metadata.st_mode)
        calls = tmp_path / "calls"
        assert not calls.exists() or "enable" not in calls.read_text()


@pytest.mark.parametrize("platform", ["launchd", "systemd"])
def test_install_activates_only_the_new_pair_and_preserves_private_inputs(tmp_path, platform):
    body = '''printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1" == "print" ]]; then
  if [[ "$2" == */com.* ]]; then exit 113; else exit 0; fi
fi
if [[ "$*" == *" show "* ]]; then echo not-found; fi
exit 0
'''
    command, environment, _, installed = install_fixture(tmp_path, platform, body)
    config = tmp_path / "private-config.json"
    before = config.read_bytes()
    result = subprocess.run(command, env=environment, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    calls = (tmp_path / "calls").read_text().splitlines()
    if platform == "launchd":
        started = [line for line in calls if line.startswith("bootstrap ")]
        assert len(started) == 2
        assert started[0].endswith("com.whatsoup.fleet-observer.plist")
        assert started[1].endswith("com.whatsoup.fleet-deadman.plist")
        assert len(list(installed.iterdir())) == 2
    else:
        assert sum(" enable --now " in line for line in calls) == 1
        assert any(" link " in line and str(installed) in line for line in calls)
        assert len(list(installed.iterdir())) == 4
    assert config.read_bytes() == before
    assert not (tmp_path / "state" / "fleet-observer.json").exists()


def test_failed_second_launchd_activation_stops_first_job_and_keeps_definitions(tmp_path):
    body = '''printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1" == "print" ]]; then
  if [[ "$2" == */com.* ]]; then exit 113; else exit 0; fi
fi
if [[ "$1" == "bootstrap" && "$3" == *fleet-deadman.plist ]]; then exit 70; fi
exit 0
'''
    command, environment, _, installed = install_fixture(tmp_path, "launchd", body)
    result = subprocess.run(command, env=environment, capture_output=True, text=True)
    assert result.returncode == 1
    calls = (tmp_path / "calls").read_text().splitlines()
    stopped = [line for line in calls if line.startswith("bootout ")]
    assert len(stopped) == 1 and stopped[0].endswith("/com.whatsoup.fleet-observer")
    assert len(list(installed.iterdir())) == 2
    assert "retain definitions and state" in result.stderr
