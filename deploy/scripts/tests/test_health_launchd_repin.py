"""Exercise health-only re-pinning through its operator entrypoint."""

import hashlib
import fcntl
import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import sys

import pytest


INSTALLER = Path(__file__).resolve().parents[1] / "install-bot-errors-health-launchd.sh"
LABEL = "com.bot-errors.health"


@pytest.fixture
def job(tmp_path):
    old, new = tmp_path / "old", tmp_path / "new"
    for root in (old, new):
        scripts = root / "deploy/scripts"
        scripts.mkdir(parents=True)
        for name in ("bot-errors-runner.py", "bot-errors-health-check.py"):
            (scripts / name).write_text("# fixture\n")
    profile = old / "profile.json"
    profile.write_text('{"retiredLine":"blocked"}\n')
    plist = tmp_path / "Library/LaunchAgents" / (LABEL + ".plist")
    plist.parent.mkdir(parents=True)
    original = {
        "Label": LABEL,
        "ProgramArguments": ["/bin/bash", "-c", 'source "$BOT_ERRORS_ENV_FILE"; exec "$@"',
                             "health", "/usr/bin/python3", str(old / "deploy/scripts/bot-errors-runner.py"),
                             "--", "/usr/bin/python3", str(old / "deploy/scripts/bot-errors-health-check.py"), "--daily"],
        "WorkingDirectory": str(old), "RunAtLoad": False,
        "StartCalendarInterval": {"Hour": 7, "Minute": 20},
        "EnvironmentVariables": {"PYTHONDONTWRITEBYTECODE": "1", "BOT_ERRORS_ENV_FILE": str(tmp_path / "private.env"),
                                 "BOT_ERRORS_HEALTH_PROFILE": str(profile), "PRIVATE_VALUE": "do-not-print-this",
                                 "BOT_ERRORS_RUNTIME_MANIFEST": str(old / "manifest.json")},
        "StandardErrorPath": str(tmp_path / "health.err"), "ProcessType": "Background",
    }
    (old / "manifest.json").write_text('{}\n')
    (tmp_path / "private.env").write_text('BOT_ERRORS_JID=fixture@g.us\n')
    raw = plistlib.dumps(original)
    plist.write_bytes(raw)
    plist.chmod(0o600)
    state = tmp_path / "service.json"
    state.write_text(json.dumps(original))
    shim = tmp_path / "bin"
    shim.mkdir()
    ctl = shim / "launchctl"
    ctl.write_text('#!' + sys.executable + '\n' + '''
import json, os, pathlib, plistlib, signal, sys
h = pathlib.Path(os.environ["HOME"]); state = h / "service.json"
args = sys.argv[1:]; mode = args[0]
with (h / "calls.jsonl").open("a") as f: f.write(json.dumps(args) + "\\n")
if mode == "print-disabled":
    print('disabled services = { }' if os.environ.get("DISABLED") == "omit" else 'disabled services = { "com.bot-errors.health" => ' + os.environ.get("DISABLED", "enabled") + ' }')
elif mode == "list":
    lists = sum(1 for line in (h / "calls.jsonl").read_text().splitlines() if json.loads(line)[0] == "list")
    if os.environ.get("EDIT_ON_LIST") == str(lists):
        with (h / "Library/LaunchAgents/com.bot-errors.health.plist").open("ab") as f: f.write(b"\\n")
    if os.environ.get("LIST_FAIL") or not state.exists(): sys.exit(113)
    print('{ "Label" = "com.bot-errors.health"; ' + ('"PID" = 123;' if os.environ.get("BUSY") else '') + ' }')
elif mode == "bootout":
    if os.environ.get("BOOTOUT_FAIL"): sys.exit(5)
    state.unlink(missing_ok=True)
    if os.environ.get("BOOTOUT_FAILED_AFTER_UNLOAD"): sys.exit(5)
    if os.environ.get("SIGNAL_AFTER_UNLOAD"): os.kill(os.getppid(), signal.SIGTERM)
elif mode == "bootstrap":
    value = plistlib.loads(pathlib.Path(args[2]).read_bytes())
    if os.environ.get("SWAP_ON_FAILED_BOOTSTRAP") and value["WorkingDirectory"].endswith("/new"):
        p = pathlib.Path(args[2]); p.unlink()
        if os.environ["SWAP_ON_FAILED_BOOTSTRAP"] == "fifo": os.mkfifo(p)
        else: p.symlink_to(h / "unrelated")
        sys.exit(37)
    if os.environ.get("BOOTSTRAP_FAIL") and (value["WorkingDirectory"].endswith("/new") or os.environ.get("ROLLBACK_FAIL")): sys.exit(37)
    state.write_text(json.dumps(value))
else: sys.exit(64)
''')
    ctl.chmod(0o755)
    validator = shim / "plutil"
    validator.write_text('#!' + sys.executable + '\nimport plistlib,sys\nplistlib.loads(open(sys.argv[-1], "rb").read())\n')
    validator.chmod(0o755)
    env = {**os.environ, "HOME": str(tmp_path), "PATH": str(shim) + os.pathsep + os.environ["PATH"],
           "BOT_ERRORS_REPO_ROOT": str(new), "BOT_ERRORS_PYTHON": sys.executable,
           "BOT_ERRORS_HEALTH_PROFILE": str(profile)}

    def run(*args, **changes):
        return subprocess.run(["bash", str(INSTALLER), "--repin-existing", "--expected-plist-sha256",
                               hashlib.sha256(raw).hexdigest(), *args], env={**env, **changes},
                              capture_output=True, text=True, timeout=15)

    return {"run": run, "plist": plist, "raw": raw, "original": original, "new": new,
            "home": tmp_path, "state": state, "env": env}


def run_installer(job, *args):
    """Run the installer with exactly these arguments (run() always adds --repin-existing)."""
    return subprocess.run(["bash", str(INSTALLER), *args], env=job["env"],
                          capture_output=True, text=True, timeout=15)


def repin_plan(job, value):
    """Install `value` as the reviewed plist and plan a re-pin of it."""
    raw = plistlib.dumps(value)
    job["plist"].write_bytes(raw)
    return raw, ("--repin-existing", "--expected-plist-sha256", hashlib.sha256(raw).hexdigest())


def apply(job, **env):
    plan = job["run"]()
    assert plan.returncode == 0, plan.stderr
    return job["run"]("--apply", "--expected-candidate-sha256", json.loads(plan.stdout)["candidate_sha256"], **env)


def test_plan_preserves_bytes_permissions_and_service(job):
    result = job["run"]()
    assert result.returncode == 0, result.stderr
    assert job["plist"].read_bytes() == job["raw"]
    assert stat.S_IMODE(job["plist"].stat().st_mode) == 0o600
    assert json.loads(result.stdout)["status"] == "planned"
    assert json.loads(job["state"].read_text()) == job["original"]
    assert not list(job["plist"].parent.glob("*.backup-*"))
    assert "do-not-print-this" not in result.stdout + result.stderr


def test_apply_changes_only_code_paths_and_preserves_private_mode(job):
    result = apply(job)
    assert result.returncode == 0, result.stderr
    value = plistlib.loads(job["plist"].read_bytes())
    expected = {**job["original"], "WorkingDirectory": str(job["new"])}
    expected["ProgramArguments"] = job["original"]["ProgramArguments"].copy()
    expected["ProgramArguments"][5] = str(job["new"] / "deploy/scripts/bot-errors-runner.py")
    expected["ProgramArguments"][8] = str(job["new"] / "deploy/scripts/bot-errors-health-check.py")
    assert value == expected
    assert json.loads(job["state"].read_text()) == expected
    assert stat.S_IMODE(job["plist"].stat().st_mode) == 0o600
    backup = Path(json.loads(result.stdout)["backup"])
    assert backup.read_bytes() == job["raw"]
    assert stat.S_IMODE(backup.stat().st_mode) == 0o600


def test_failed_bootstrap_restores_bytes_mode_and_loaded_job(job):
    result = apply(job, BOOTSTRAP_FAIL="1")
    assert result.returncode == 1
    assert json.loads(result.stdout)["status"] == "rolled_back"
    assert job["plist"].read_bytes() == job["raw"]
    assert stat.S_IMODE(job["plist"].stat().st_mode) == 0o600
    assert json.loads(job["state"].read_text()) == job["original"]


def test_rollback_failure_is_not_reported_as_recovery(job):
    result = apply(job, BOOTSTRAP_FAIL="1", ROLLBACK_FAIL="1")
    assert result.returncode == 3
    assert json.loads(result.stdout)["status"] == "rollback_unverified"
    assert job["plist"].read_bytes() == job["raw"]
    assert not job["state"].exists()


@pytest.mark.parametrize("env", [{"BUSY": "1"}, {"LIST_FAIL": "1"}, {"DISABLED": "true"}, {"DISABLED": "disabled"}, {"DISABLED": "omit"}])
def test_uncertain_running_or_disabled_job_is_not_replaced(job, env):
    result = job["run"](**env)
    assert result.returncode == 2
    assert job["plist"].read_bytes() == job["raw"]
    calls = (job["home"] / "calls.jsonl").read_text()
    assert "bootout" not in calls and "bootstrap" not in calls


def test_bootout_failure_leaves_original_loaded(job):
    result = apply(job, BOOTOUT_FAIL="1")
    assert result.returncode == 2
    assert job["plist"].read_bytes() == job["raw"]
    assert json.loads(job["state"].read_text()) == job["original"]


def test_failed_bootout_after_unload_reloads_original(job):
    result = apply(job, BOOTOUT_FAILED_AFTER_UNLOAD="1")
    assert result.returncode == 1
    assert json.loads(result.stdout)["status"] == "rolled_back"
    assert job["plist"].read_bytes() == job["raw"]
    assert json.loads(job["state"].read_text()) == job["original"]


def test_interruption_after_unload_restores_original(job):
    result = apply(job, SIGNAL_AFTER_UNLOAD="1")
    assert result.returncode == 1
    assert json.loads(result.stdout)["status"] == "rolled_back"
    assert job["plist"].read_bytes() == job["raw"]
    assert json.loads(job["state"].read_text()) == job["original"]


@pytest.mark.parametrize("kind", ["symlink", "fifo"])
def test_rollback_refuses_concurrent_identity_change_without_blocking(job, kind):
    unrelated = job["home"] / "unrelated"
    unrelated.write_bytes(b"retain unrelated data")
    result = apply(job, SWAP_ON_FAILED_BOOTSTRAP=kind)
    assert result.returncode == 3
    assert json.loads(result.stdout)["status"] == "rollback_unverified"
    assert unrelated.read_bytes() == b"retain unrelated data"
    assert stat.S_ISLNK(job["plist"].lstat().st_mode) if kind == "symlink" else stat.S_ISFIFO(job["plist"].lstat().st_mode)


def test_concurrent_plist_edit_is_not_overwritten(job):
    job["plist"].write_bytes(job["raw"] + b"\n")
    result = job["run"]()
    assert result.returncode == 2
    assert job["plist"].read_bytes() == job["raw"] + b"\n"


def test_apply_requires_reviewed_candidate(job):
    result = job["run"]("--apply", "--expected-candidate-sha256", "0" * 64)
    assert result.returncode == 2
    assert job["plist"].read_bytes() == job["raw"]


def test_explicit_manifest_changes_only_that_environment_key(job):
    manifest = job["new"] / "manifest.json"
    manifest.write_text('{}\n')
    args = ("--runtime-manifest", str(manifest))
    plan = job["run"](*args)
    assert plan.returncode == 0, plan.stderr
    result = job["run"](*args, "--apply", "--expected-candidate-sha256", json.loads(plan.stdout)["candidate_sha256"])
    assert result.returncode == 0, result.stderr
    env = plistlib.loads(job["plist"].read_bytes())["EnvironmentVariables"]
    assert env == {**job["original"]["EnvironmentVariables"], "BOT_ERRORS_RUNTIME_MANIFEST": str(manifest)}


def test_unknown_argument_does_not_fall_through_to_fresh_install(job):
    result = job["run"]("--misspelled-option")
    assert result.returncode == 2
    assert job["plist"].read_bytes() == job["raw"]


def test_unknown_argument_without_repin_exits_before_fresh_install(job):
    # Reaches the shell's own argument guard: no --repin-existing comes first.
    result = run_installer(job, "--misspelled-option")
    assert result.returncode == 2
    assert job["plist"].read_bytes() == job["raw"]
    assert sorted(p.name for p in job["plist"].parent.iterdir()) == [LABEL + ".plist"]
    assert not (job["home"] / "calls.jsonl").exists()


@pytest.mark.parametrize("value", [["not", "a", "dict"], "plain string"])
def test_plist_without_a_top_level_dict_is_refused_with_a_receipt(job, value):
    raw, args = repin_plan(job, value)
    result = run_installer(job, *args)
    assert result.returncode == 2, result.stderr
    assert json.loads(result.stdout)["status"] == "refused"
    assert job["plist"].read_bytes() == raw


def test_environment_variables_that_are_not_a_dict_are_refused_with_a_receipt(job):
    manifest = job["new"] / "manifest.json"
    manifest.write_text('{}\n')
    raw, args = repin_plan(job, {**job["original"], "EnvironmentVariables": "not a dict"})
    result = run_installer(job, *args, "--runtime-manifest", str(manifest))
    assert result.returncode == 2, result.stderr
    assert json.loads(result.stdout)["status"] == "refused"
    assert job["plist"].read_bytes() == raw


def test_refusal_after_the_backup_is_staged_leaves_no_backup(job):
    # List calls: 1 plan, 2 apply's plan check, 3 the idle check right before the
    # backup is staged. The edit then fails the re-read that follows the backup.
    result = apply(job, EDIT_ON_LIST="3")
    assert result.returncode == 2, result.stderr
    assert json.loads(result.stdout) == {"status": "refused", "reason": "plist changed since review"}
    assert sorted(p.name for p in job["plist"].parent.iterdir()) == [LABEL + ".plist", LABEL + ".plist.repin.lock"]
    assert "bootout" not in (job["home"] / "calls.jsonl").read_text()


def test_competing_repin_cannot_acquire_lock(job):
    with Path(str(job["plist"]) + ".repin.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = apply(job)
    assert result.returncode == 2
    assert job["plist"].read_bytes() == job["raw"]
    assert "bootout" not in (job["home"] / "calls.jsonl").read_text()


@pytest.mark.parametrize("kind", ["symlink", "fifo"])
def test_untrusted_plist_identity_is_refused_without_blocking(job, kind):
    job["plist"].unlink()
    if kind == "symlink":
        unrelated = job["home"] / "unrelated"
        unrelated.write_bytes(job["raw"])
        job["plist"].symlink_to(unrelated)
    else:
        os.mkfifo(job["plist"])
    result = job["run"]()
    assert result.returncode == 2


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS extended attributes")
def test_extended_attributes_are_refused_instead_of_dropped(job):
    subprocess.run(["/usr/bin/xattr", "-w", "com.example.repin-fixture", "retain", str(job["plist"])], check=True)
    result = job["run"]()
    assert result.returncode == 2
    assert job["plist"].read_bytes() == job["raw"]
    assert "com.example.repin-fixture" in subprocess.check_output(["/usr/bin/xattr", str(job["plist"])], text=True)
