"""Exercise the bundled qualifier through its real CLI and loopback boundary."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import py_compile
import shutil
import subprocess
import sys

import pytest

from test_deployment_effective_config import _fixture, _rewrite_record
from test_qualify_health_deployment import _Handler, VALID_TOKEN, health_server


_SCRIPTS = Path(__file__).resolve().parents[1]
_FILES = (
    "qualify-health-deployment.py",
    "health-deployment-qualification-profile.json",
    "deployment-qualification-profile.json",
    "runtime-test-qualification.json",
    "lib/health_reader.py",
    "lib/durable_json.py",
    "lib/deployment_effective_config.py",
    "lib/deployment_qualification_bundle.py",
)


def _case(tmp_path: Path, port: int):
    fixture = _fixture(tmp_path, "a")
    fixture.record["generated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    fixture.record["configured"]["instance"]["healthPort"] = port
    fixture.digest = _rewrite_record(fixture, fixture.record)
    root = tmp_path / "export"
    runtime = root / "runtime"
    (runtime / "lib").mkdir(parents=True, mode=0o700)
    root.chmod(0o700)
    runtime.chmod(0o700)
    files = []
    for relative in _FILES:
        target = runtime / relative
        source = (_SCRIPTS.parents[1] / "docs" / "operations" / relative
                  if relative == "runtime-test-qualification.json" else _SCRIPTS / relative)
        shutil.copyfile(source, target)
        executable = relative == "qualify-health-deployment.py"
        target.chmod(0o700 if executable else 0o600)
        files.append({"path": relative, "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "executable": executable})
    context = fixture.record["context"]
    payload = {
        "schema_version": "whatsoup.qualification-bundle.v1",
        "source_commit": context["whatsoup_commit"],
        "compatibility": {"arc_commit": context["arc_commit"], "qfleet_commit": context["qfleet_commit"]},
        "policy_version": "whatsoup.deployment-qualification-profile.v1",
        "execution_root": "runtime",
        "qualifier": "qualify-health-deployment.py",
        "files": files,
    }
    manifest = root / "bundle.json"
    manifest.write_text(json.dumps(payload))
    manifest.chmod(0o600)
    target = fixture.record["target"]
    argv = [
        sys.executable, "-B", str(runtime / "qualify-health-deployment.py"),
        "--instance", target["instance_name"],
        "--effective-record-root", str(fixture.root), "--effective-record", str(fixture.record_path),
        "--effective-record-sha256", fixture.digest,
        "--bundle-root", str(root), "--bundle-manifest", str(manifest),
        "--bundle-sha256", hashlib.sha256(manifest.read_bytes()).hexdigest(),
    ]
    for key, value in context.items():
        argv.extend(["--" + key.replace("_", "-"), value])
    for key in ("host_ref", "user_ref", "instance_ref", "inventory_host"):
        argv.extend(["--" + key.replace("_", "-"), target[key]])
    return fixture, root, runtime, argv


def _run(argv, extra_env=None):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", WHATSOUP_HEALTH_TOKEN=VALID_TOKEN)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(argv, capture_output=True, text=True, env=env, timeout=15)


def test_bundle_cli_qualifies_actual_bound_health_and_records_inputs(tmp_path, health_server):
    fixture, _root, _runtime, argv = _case(tmp_path, health_server.server_port)
    result = _run(argv)
    assert result.returncode == 0, result.stderr
    receipt = json.loads(result.stdout)
    assert receipt["outcome"] == "qualified"
    assert receipt["bundle_binding"] == {
        "manifest_sha256": argv[argv.index("--bundle-sha256") + 1],
        "effective_record_sha256": fixture.digest,
        "context": fixture.record["context"],
        "target": {key: fixture.record["target"][key] for key in ("host_ref", "user_ref", "instance_ref")},
    }
    assert len(health_server.requests) == 3
    assert VALID_TOKEN not in result.stdout
    assert str(fixture.root) not in result.stdout


@pytest.mark.parametrize("change", ["profile_bytes", "foreign_profile", "missing_binding"])
def test_bundle_cli_refuses_invalid_inputs_before_health(tmp_path, health_server, change):
    _fixture_value, root, runtime, argv = _case(tmp_path, health_server.server_port)
    if change == "profile_bytes":
        (runtime / "health-deployment-qualification-profile.json").write_text("{}")
    elif change == "foreign_profile":
        foreign = root / "foreign-profile.json"
        shutil.copyfile(runtime / "health-deployment-qualification-profile.json", foreign)
        argv.extend(["--profile", str(foreign)])
    else:
        position = argv.index("--effective-record-sha256")
        del argv[position:position + 2]
    result = _run(argv)
    assert result.returncode == 3, result.stderr
    receipt = json.loads(result.stdout)
    assert receipt["outcome"] == "inconclusive"
    assert "bundle_binding" not in receipt
    assert health_server.requests == []


def test_bundle_cli_rejects_helper_change_during_health_observation(tmp_path, health_server):
    _fixture_value, _root, runtime, argv = _case(tmp_path, health_server.server_port)
    helper = runtime / "lib" / "health_reader.py"

    class MutatingHandler(_Handler):
        def do_GET(self):
            if self.headers.get("Authorization") == f"Bearer {VALID_TOKEN}":
                helper.write_bytes(helper.read_bytes() + b"\n# changed during observation\n")
            super().do_GET()

    health_server.RequestHandlerClass = MutatingHandler
    result = _run(argv)
    assert result.returncode == 3, result.stderr
    receipt = json.loads(result.stdout)
    assert receipt["outcome"] == "inconclusive"
    assert receipt["unresolved"] == ["bundle_unavailable"]
    assert "bundle_binding" not in receipt
    assert len(health_server.requests) == 3


def test_bundle_cli_requires_source_test_profile_in_declared_closure(tmp_path, health_server):
    _fixture_value, root, runtime, argv = _case(tmp_path, health_server.server_port)
    (runtime / "runtime-test-qualification.json").unlink()
    manifest = root / "bundle.json"
    payload = json.loads(manifest.read_text())
    payload["files"] = [row for row in payload["files"] if row["path"] != "runtime-test-qualification.json"]
    manifest.write_text(json.dumps(payload))
    argv[argv.index("--bundle-sha256") + 1] = hashlib.sha256(manifest.read_bytes()).hexdigest()
    result = _run(argv)
    assert result.returncode == 3, result.stderr
    assert json.loads(result.stdout)["outcome"] == "inconclusive"
    assert health_server.requests == []


@pytest.mark.parametrize("selection", ["environment", "interpreter_option"])
def test_bundle_cli_refuses_external_bytecode_before_loading_helpers(tmp_path, health_server, monkeypatch, selection):
    _fixture_value, _root, runtime, argv = _case(tmp_path, health_server.server_port)
    helper = runtime / "lib" / "health_reader.py"
    original = helper.read_bytes()
    metadata = helper.stat()
    marker = tmp_path / "unbound-helper-executed"
    helper.write_bytes(original + f"\nPath({str(marker)!r}).write_text('loaded')\n".encode())
    cache_root = tmp_path / "external-cache"
    with monkeypatch.context() as cache_context:
        cache_context.setattr(sys, "pycache_prefix", str(cache_root))
        cache_file = Path(importlib.util.cache_from_source(str(helper)))
    cache_file.parent.mkdir(parents=True)
    py_compile.compile(str(helper), cfile=str(cache_file), doraise=True,
                       invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
    helper.write_bytes(original)
    os.utime(helper, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
    env = {}
    if selection == "environment":
        env["PYTHONPYCACHEPREFIX"] = str(cache_root)
    else:
        argv[1:1] = ["-X", f"pycache_prefix={cache_root}"]
    result = _run(argv, env)
    assert not marker.exists(), "code outside the declared source closure executed"
    assert result.returncode == 3, result.stderr
    receipt = json.loads(result.stdout)
    assert receipt["outcome"] == "inconclusive"
    assert receipt["unresolved"] == ["bundle_unavailable"]
    assert "bundle_binding" not in receipt
    assert health_server.requests == []
    assert str(cache_root) not in result.stdout + result.stderr


def test_bundle_cli_returns_content_free_refusal_for_deep_manifest(tmp_path, health_server):
    _fixture_value, root, _runtime, argv = _case(tmp_path, health_server.server_port)
    manifest = root / "bundle.json"
    manifest.write_text('{"nested":' + '[' * 10000 + '0' + ']' * 10000 + '}')
    argv[argv.index("--bundle-sha256") + 1] = hashlib.sha256(manifest.read_bytes()).hexdigest()
    result = _run(argv)
    assert result.returncode == 3, result.stderr
    receipt = json.loads(result.stdout)
    assert receipt["outcome"] == "inconclusive"
    assert receipt["unresolved"] == ["bundle_unavailable"]
    assert "bundle_binding" not in receipt
    assert health_server.requests == []
    assert result.stderr == ""
