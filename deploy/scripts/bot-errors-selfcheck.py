#!/usr/bin/env python3
"""Host-local BOT ERRORS runtime selfcheck.

This is the host-side writer for the Fleet Runtime Sentinel. It verifies the
runtime root against the pinned manifest and may ask the local deployer to heal
safe drift from the already-distributed immutable bundle.
"""
from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
import socket
import subprocess
import sys
import time
from typing import Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import sentinel_pin as sp  # noqa: E402


SAFE_HEAL_CLASSES = {"drift", "manifest_missing"}
HEAL_WINDOW_SECONDS = 6 * 60 * 60
MAX_HEALS_PER_WINDOW = 2


@dataclass(frozen=True)
class SelfcheckConfig:
    root: Path
    state_dir: Path
    manifest_path: Path
    ledger_path: Path
    current_link: Path
    deployer_path: Path
    autoheal_off_path: Path
    disabled_path: Path
    lock_path: Path
    status_path: Path
    memory_path: Path


@dataclass(frozen=True)
class SelfcheckDeps:
    commit_exists: Callable[[str], bool]
    deploy: Callable[[Path, Path, Path], tuple[int, str]]
    now_epoch: Callable[[], float]
    hostname: Callable[[], str]
    before_heal: Callable[[], None] = lambda: None


class SelfcheckError(RuntimeError):
    pass


def now_iso(epoch: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if epoch is None else epoch))


def default_state_dir() -> Path:
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors")) / "sentinel"


def default_config(root: Path, state_dir: Optional[Path] = None) -> SelfcheckConfig:
    scripts = root / "deploy" / "scripts"
    sentinel_state = state_dir or default_state_dir()
    return SelfcheckConfig(
        root=root,
        state_dir=sentinel_state,
        manifest_path=Path(os.environ.get("BOT_ERRORS_RUNTIME_MANIFEST", root / "deploy/bot-errors-runtime-manifest.json")),
        ledger_path=scripts / "lib" / "sentinel_pin_ledger.json",
        current_link=sentinel_state / "current",
        deployer_path=scripts / "whatsoup-bot-errors-deploy.sh",
        autoheal_off_path=sentinel_state.parent / "fleet-sentinel" / "AUTOHEAL_OFF",
        disabled_path=sentinel_state / "DISABLED",
        lock_path=sentinel_state / "selfcheck.lock",
        status_path=sentinel_state / "status.json",
        memory_path=sentinel_state / "selfcheck-state.json",
    )


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def fsync_parent(path: Path) -> None:
    try:
        fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write_json(path: Path, payload: dict) -> None:
    ensure_private_dir(path.parent)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        path.chmod(0o600)
        fsync_parent(path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def read_json_object(path: Path, default: dict) -> dict:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return dict(default)
    except (OSError, json.JSONDecodeError) as exc:
        raise SelfcheckError(f"cannot read {path.name}: {type(exc).__name__}") from exc
    if not isinstance(loaded, dict):
        raise SelfcheckError(f"{path.name} must be a JSON object")
    return loaded


def lever_engaged(path: Path) -> tuple[bool, str]:
    try:
        path.stat()
    except FileNotFoundError:
        return False, "absent"
    except OSError as exc:
        return True, f"stat_error:{type(exc).__name__}"
    return True, "present"


def load_memory(path: Path) -> dict:
    memory = read_json_object(path, {"lastClass": None, "consecutive": 0, "healHistory": []})
    history = memory.get("healHistory")
    if not isinstance(history, list):
        raise SelfcheckError("healHistory must be a list")
    return memory


def update_consecutive(memory: dict, observed_class: str) -> int:
    if memory.get("lastClass") == observed_class:
        consecutive = int(memory.get("consecutive") or 0) + 1
    else:
        consecutive = 1
    memory["lastClass"] = observed_class
    memory["consecutive"] = consecutive
    return consecutive


def heal_allowed(memory: dict, now: float) -> tuple[bool, str]:
    floor = now - HEAL_WINDOW_SECONDS
    kept = []
    for item in memory.get("healHistory", []):
        try:
            stamp = float(item)
        except (TypeError, ValueError):
            return False, "invalid_heal_history"
        if stamp >= floor:
            kept.append(stamp)
    memory["healHistory"] = kept
    if len(kept) >= MAX_HEALS_PER_WINDOW:
        return False, "rate_limited"
    return True, "ok"


def record_heal(memory: dict, now: float) -> None:
    history = list(memory.get("healHistory", []))
    history.append(now)
    memory["healHistory"] = history


def acquire_lock(path: Path) -> Optional[int]:
    ensure_private_dir(path.parent)
    try:
        return os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except FileExistsError:
        return None


def release_lock(path: Path, fd: int) -> None:
    os.close(fd)
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def current_bundle_path(current_link: Path) -> Path:
    try:
        target = os.readlink(current_link)
    except OSError as exc:
        raise SelfcheckError(f"current bundle unavailable: {type(exc).__name__}") from exc
    target_path = Path(target)
    if not target_path.is_absolute():
        target_path = current_link.parent / target_path
    return target_path.resolve()


def classify_runtime_mismatches(mismatches: list[tuple[str, str]]) -> str:
    kinds = {kind for _path, kind in mismatches}
    if "symlink" in kinds or "unsafe_path" in kinds:
        return "unsafe_runtime_path"
    if "missing" in kinds:
        return "manifest_missing"
    if "sha" in kinds:
        return "drift"
    return "drift"


def default_commit_exists(repo_root: Path) -> Callable[[str], bool]:
    def _exists(sha: str) -> bool:
        cat = subprocess.run(
            ["git", "-C", str(repo_root), "cat-file", "-e", f"{sha}^{{commit}}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
        if cat.returncode != 0:
            return False
        ancestor = subprocess.run(
            ["git", "-C", str(repo_root), "merge-base", "--is-ancestor", sha, "origin/main"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
        return ancestor.returncode == 0

    return _exists


def default_deploy(deployer_path: Path) -> Callable[[Path, Path, Path], tuple[int, str]]:
    def _deploy(root: Path, bundle: Path, _deployer: Path = deployer_path) -> tuple[int, str]:
        proc = subprocess.run(
            ["bash", str(_deployer), "deploy", str(root), str(bundle)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=120,
            check=False,
        )
        return proc.returncode, proc.stdout[-4000:]

    return _deploy


def default_deps(config: SelfcheckConfig) -> SelfcheckDeps:
    return SelfcheckDeps(
        commit_exists=default_commit_exists(config.root),
        deploy=default_deploy(config.deployer_path),
        now_epoch=time.time,
        hostname=socket.gethostname,
    )


def base_status(config: SelfcheckConfig, deps: SelfcheckDeps, now: float) -> dict:
    return {
        "schemaVersion": 1,
        "host": deps.hostname(),
        "checkedAt": now_iso(now),
        "root": str(config.root),
        "healthy": False,
        "class": "unknown",
        "action": "none",
        "problems": [],
        "consecutive": 0,
    }


def run_selfcheck(config: SelfcheckConfig, deps: Optional[SelfcheckDeps] = None, heal_enabled: bool = True) -> dict:
    deps = deps or default_deps(config)
    now = deps.now_epoch()
    status = base_status(config, deps, now)
    memory = load_memory(config.memory_path)

    disabled, disabled_reason = lever_engaged(config.disabled_path)
    autoheal_off, autoheal_reason = lever_engaged(config.autoheal_off_path)
    status["levers"] = {
        "disabled": disabled_reason,
        "autohealOff": autoheal_reason,
    }

    try:
        pin = sp.load_pin(config.manifest_path)
        approved = sp.load_approved_f10(config.ledger_path)
        trusted, trust_reason = sp.verify_pin_trust(pin, approved, deps.commit_exists)
    except sp.PinLoadError as exc:
        status["class"] = "pin_untrusted"
        status["problems"] = [str(exc)]
        status["consecutive"] = update_consecutive(memory, status["class"])
        atomic_write_json(config.memory_path, memory)
        atomic_write_json(config.status_path, status)
        return status

    status["pin"] = {"headSha": pin.head_sha, "f10Sha": pin.f10_sha, "trust": trust_reason}
    if not trusted:
        status["class"] = "pin_untrusted"
        status["problems"] = [trust_reason]
        status["consecutive"] = update_consecutive(memory, status["class"])
        atomic_write_json(config.memory_path, memory)
        atomic_write_json(config.status_path, status)
        return status

    try:
        bundle = current_bundle_path(config.current_link)
    except SelfcheckError as exc:
        status["class"] = "bundle_missing"
        status["problems"] = [str(exc)]
        status["consecutive"] = update_consecutive(memory, status["class"])
        atomic_write_json(config.memory_path, memory)
        atomic_write_json(config.status_path, status)
        return status
    status["bundle"] = str(bundle)
    if pin.head_sha and bundle.name != pin.head_sha:
        status["class"] = "bundle_mismatch"
        status["problems"] = [f"current bundle {bundle.name} != pin {pin.head_sha}"]
        status["consecutive"] = update_consecutive(memory, status["class"])
        atomic_write_json(config.memory_path, memory)
        atomic_write_json(config.status_path, status)
        return status

    bundle_ok, bundle_mismatches = sp.verify_bundle(bundle, pin)
    status["bundleMismatches"] = bundle_mismatches
    if not bundle_ok:
        status["class"] = "bundle_bad"
        status["problems"] = [f"{path}:{kind}" for path, kind in bundle_mismatches]
        status["consecutive"] = update_consecutive(memory, status["class"])
        atomic_write_json(config.memory_path, memory)
        atomic_write_json(config.status_path, status)
        return status

    root_ok, root_mismatches = sp.verify_bundle(config.root, pin)
    status["runtimeMismatches"] = root_mismatches
    if root_ok:
        status["healthy"] = True
        status["class"] = "healthy"
        status["consecutive"] = update_consecutive(memory, status["class"])
        status["action"] = "noop"
        atomic_write_json(config.memory_path, memory)
        atomic_write_json(config.status_path, status)
        return status

    observed_class = classify_runtime_mismatches(root_mismatches)
    status["class"] = observed_class
    status["problems"] = [f"{path}:{kind}" for path, kind in root_mismatches]
    consecutive = update_consecutive(memory, observed_class)
    status["consecutive"] = consecutive

    if observed_class not in SAFE_HEAL_CLASSES:
        status["action"] = "escalate"
    elif disabled:
        status["action"] = "mutation_disabled"
    elif autoheal_off or not heal_enabled:
        status["action"] = "monitor_only"
    elif consecutive < 2:
        status["action"] = "hysteresis_wait"
    else:
        allowed, reason = heal_allowed(memory, now)
        if not allowed:
            status["action"] = reason
        else:
            fd = acquire_lock(config.lock_path)
            if fd is None:
                status["action"] = "lock_busy"
            else:
                try:
                    deps.before_heal()
                    if current_bundle_path(config.current_link) != bundle:
                        status["action"] = "current_changed"
                    else:
                        rc, output = deps.deploy(config.root, bundle, config.deployer_path)
                        status["deployerOutput"] = output[-1000:]
                        if rc == 0:
                            record_heal(memory, now)
                            status["action"] = "healed"
                        else:
                            status["action"] = "heal_failed"
                            status["problems"].append(f"deployer_rc={rc}")
                finally:
                    release_lock(config.lock_path, fd)

    atomic_write_json(config.memory_path, memory)
    atomic_write_json(config.status_path, status)
    return status


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a host-local BOT ERRORS runtime selfcheck")
    parser.add_argument("--root", default=os.environ.get("BOT_ERRORS_REPO_ROOT", str(Path.cwd())))
    parser.add_argument("--state-dir", default=os.environ.get("BOT_ERRORS_SENTINEL_STATE_DIR"))
    parser.add_argument("--no-heal", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    state_dir = Path(args.state_dir).expanduser() if args.state_dir else None
    config = default_config(Path(args.root).expanduser().resolve(), state_dir)
    try:
        status = run_selfcheck(config, heal_enabled=not args.no_heal)
    except Exception as exc:
        status = {"schemaVersion": 1, "checkedAt": now_iso(), "healthy": False, "class": "selfcheck_error", "problems": [str(exc)]}
        try:
            atomic_write_json(config.status_path, status)
        except Exception:
            pass
        print(json.dumps(status, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps(status, sort_keys=True))
    return 0 if status.get("healthy") or status.get("action") in {"healed", "hysteresis_wait", "monitor_only"} else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
