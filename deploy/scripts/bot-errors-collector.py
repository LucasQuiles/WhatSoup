#!/usr/bin/env python3
"""Pull BOT ERRORS events from remote machine outboxes into the nucles outbox."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import time
from typing import Any, NoReturn

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.bot_errors_redaction import redact_bot_errors_text, redact_json_value as redact_shared_json_value
from lib.bot_errors_envelope import new_event_fields
from lib.controller_log import (
    ControllerLogContext,
    controller_cycle,
    metadata_only_controller_details,
    write_controller_log,
)
from lib.durable_json import (
    JsonVersion,
    durable_json_target,
    observe_json,
    operation_id,
    publish_event_json,
    publish_state_json,
    require_advance,
)
from lib.controller_state import (
    STATE_RECOVERY_REQUIRED_EXIT,
    ControllerStateRequired,
    emit_state_recovery_fallback,
    open_controller_state,
    state_diagnostic_details,
)
from lib.state_files import COLLECTOR_STATE
from lib.state_root import state_root


TAILSCALE_STATUS_CACHE: dict[str, Any] | None = None
TAILSCALE_STATUS_ERROR: str | None = None
REMOTE_HOST_TARGETS_CACHE: dict[str, list[str]] = {}
CONTROLLER_LOG_CONTEXT = ControllerLogContext("collector")


def reset_tailscale_cache() -> None:
    """Clear the module-level Tailscale status memo.

    Called at the start of each collection cycle so that load_tailscale_status()
    re-fetches a fresh snapshot.  Within a single cycle the memo still avoids
    redundant subprocess calls (N hosts → 1 call per cycle).
    """
    global TAILSCALE_STATUS_CACHE, TAILSCALE_STATUS_ERROR
    TAILSCALE_STATUS_CACHE = None
    TAILSCALE_STATUS_ERROR = None

RELAY_BACKOFF_FAILURE_THRESHOLD: int = 3
RELAY_BACKOFF_SCHEDULE_S: list[int] = [300, 900, 3600]


REMOTE_CLAIM_SCRIPT = r"""
import json, os, sys, time
from pathlib import Path

root = Path(sys.argv[1]).expanduser()
limit = int(sys.argv[2])
lease_seconds = int(sys.argv[3])
outbox = root / "outbox"
processing = root / "relay-processing"
processing.mkdir(parents=True, exist_ok=True, mode=0o700)
try:
    processing.chmod(0o700)
except OSError:
    pass
now = time.time()
for claim in sorted(processing.glob("*.relay")):
    try:
        if now - claim.stat().st_mtime <= lease_seconds:
            continue
        target = outbox / (claim.name.split(".json.", 1)[0] + ".json" if ".json." in claim.name else claim.name)
        if target.exists():
            target = outbox / f"{int(now)}.{target.name}"
        os.replace(claim, target)
    except FileNotFoundError:
        pass
count = 0
for path in sorted(outbox.glob("*.json")):
    if count >= limit:
        break
    claim = processing / f"{path.name}.{os.getpid()}.relay"
    try:
        os.replace(path, claim)
        payload = claim.read_text(encoding="utf-8")
    except FileNotFoundError:
        continue
    print(json.dumps({"name": path.name, "claim": str(claim), "payload": payload}, sort_keys=True))
    count += 1
"""


REMOTE_ACK_SCRIPT = r"""
import os, sys, time
from pathlib import Path

claim = Path(sys.argv[1])
root = Path(sys.argv[2]).expanduser()
action = sys.argv[3]
if action == "ack":
    target_dir = root / "relayed"
    suffix = f".{int(time.time())}.relayed"
else:
    target_dir = root / "outbox"
    suffix = ""
target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
try:
    target_dir.chmod(0o700)
except OSError:
    pass

def unique_target_path(target_dir, base, suffix):
    candidates = [target_dir / f"{base}{suffix}"]
    prefix = f"{int(time.time())}.{os.getpid()}"
    candidates.extend(target_dir / f"{prefix}.{index}.{base}{suffix}" for index in range(1000))
    for candidate in candidates:
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"no unique remote ack path in {target_dir}")

base = claim.name.split(".json.", 1)[0] + ".json" if ".json." in claim.name else claim.name
target = unique_target_path(target_dir, base, suffix)
os.replace(claim, target)
print(target)
"""


REMOTE_WRITEFAIL_CLAIM_SCRIPT = r"""
import json, os, re, sys, time
from pathlib import Path

root = Path(sys.argv[1]).expanduser()
limit = int(sys.argv[2])
lease_seconds = int(sys.argv[3])

def unique(paths):
    result = []
    seen = set()
    for path in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        result.append(path)
    return result

def safe(value):
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value).strip("_")
    return (cleaned or "unknown")[:80]

def private_dir(candidates):
    for path in candidates:
        try:
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                path.chmod(0o700)
            except OSError:
                pass
            return path
        except OSError:
            continue
    raise RuntimeError("no writable writefail processing dir")

override = os.environ.get("BOT_ERRORS_WRITEFAIL_DIR")
sources = []
if override:
    sources.append(Path(override).expanduser())
sources.append(root / "writefail")
tmpdir = Path(os.environ.get("TMPDIR", "/tmp")).expanduser()
sources.append(Path.home() / ".bot-errors-writefail")
sources.append(tmpdir / "bot-errors-writefail")
sources.append(Path("/tmp") / "bot-errors-writefail")
sources = unique(sources)

def is_under(path, root):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False

def source_durability(source):
    if source == root / "writefail" or source == Path.home() / ".bot-errors-writefail":
        return "durable", "state_or_home_path"
    if is_under(source, tmpdir) or is_under(source, Path("/tmp")):
        return "non_durable", "tmpdir_or_tmp_path"
    return "unknown", "configured_or_unclassified_path"

processing = private_dir([
    root / "relay-writefail-processing",
    Path.home() / ".bot-errors-writefail-relay-processing",
    Path("/tmp") / f"bot-errors-writefail-relay-processing-{os.getuid()}",
])

now = time.time()
count = 0
for claim in sorted(processing.glob("*.relay-writefail")):
    try:
        if now - claim.stat().st_mtime <= lease_seconds:
            continue
        payload = claim.read_text(encoding="utf-8")
    except FileNotFoundError:
        continue
    print(json.dumps({
        "kind": "writefail",
        "name": claim.name,
        "claim": str(claim),
        "sourceDir": str(processing),
        "sourceDurability": "unknown",
        "sourceDurabilityReason": "relay_processing_claim",
        "payload": payload,
    }, sort_keys=True))
    count += 1
    if count >= limit:
        raise SystemExit(0)

for source in sources:
    if count >= limit:
        break
    if not source.exists():
        continue
    for path in sorted(source.glob("*.writefail")):
        if count >= limit:
            break
        claim = processing / f"{safe(source.name)}.{safe(path.name)}.{os.getpid()}.relay-writefail"
        try:
            os.replace(path, claim)
            payload = claim.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            # Claim race: another collector took this file first. Log it
            # so operators can detect frequent collisions (#2441).
            print(f"[bot-errors-collector] claim lost for {path.name}: {type(exc).__name__}: {exc}", file=sys.stderr)
            continue
        durability, durability_reason = source_durability(source)
        print(json.dumps({
            "kind": "writefail",
            "name": path.name,
            "claim": str(claim),
            "sourceDir": str(source),
            "sourceDurability": durability,
            "sourceDurabilityReason": durability_reason,
            "payload": payload,
        }, sort_keys=True))
        count += 1
"""


# BEGIN GENERATED REMOTE DURABLE JSON SOURCE
REMOTE_DURABLE_JSON_SOURCE = (
    '"""Runtime-safe durable event publisher embedded into remote BOT ERRORS scripts."""\n'
    '\n'
    'from __future__ import annotations\n'
    '\n'
    'from dataclasses import dataclass\n'
    'from enum import Enum\n'
    'import errno\n'
    'import hashlib\n'
    'import json\n'
    'import os\n'
    'from pathlib import Path, PurePath, PurePosixPath\n'
    'import stat\n'
    'from typing import Any, Callable, Mapping, Sequence\n'
    '\n'
    'try:\n'
    '    import fcntl\n'
    'except ImportError:  # pragma: no cover - exercised through capability simulation\n'
    '    fcntl = None  # type: ignore[assignment]\n'
    '\n'
    '\n'
    'HELPER_GENERATION = 1\n'
    '_MAX_JSON_BYTES = 8 * 1024 * 1024\n'
    '_MAX_SAFE_INTEGER = (1 << 53) - 1\n'
    '_HAS_OPEN_DIR_FD = os.open in os.supports_dir_fd\n'
    '_HAS_LINK_DIR_FD = os.link in os.supports_dir_fd\n'
    '_HAS_LINK_NOFOLLOW = os.link in os.supports_follow_symlinks\n'
    '\n'
    '\n'
    'class DurabilityProof(str, Enum):\n'
    '    NOT_MUTATED = "not_mutated"\n'
    '    COMMITTED = "committed"\n'
    '    UNPROVEN = "unproven"\n'
    '    RECONCILED_COMMITTED = "reconciled_committed"\n'
    '\n'
    '\n'
    'class ConfinementProof(str, Enum):\n'
    '    PROVEN = "proven"\n'
    '    UNPROVEN = "unproven"\n'
    '    VIOLATED = "violated"\n'
    '\n'
    '\n'
    'class CleanupState(str, Enum):\n'
    '    NOT_REQUIRED = "not_required"\n'
    '    COMPLETE = "complete"\n'
    '    DEBT_PRIVATE_TEMP = "debt_private_temp"\n'
    '    DEBT_RECOVERY_RECORD = "debt_recovery_record"\n'
    '\n'
    '\n'
    'class AuthorityState(str, Enum):\n'
    '    EXPECTED_PREDECESSOR = "expected_predecessor"\n'
    '    INTENDED_AUTHORITATIVE = "intended_authoritative"\n'
    '    SUPERSEDED = "superseded"\n'
    '    CONFLICT = "conflict"\n'
    '    UNKNOWN = "unknown"\n'
    '\n'
    '\n'
    'class WriteStage(str, Enum):\n'
    '    SERIALIZATION = "serialization"\n'
    '    CAPABILITY_CHECK = "capability_check"\n'
    '    LOCK_ACQUISITION = "lock_acquisition"\n'
    '    TEMPORARY_CREATION = "temporary_creation"\n'
    '    WRITE = "write"\n'
    '    FILE_FLUSH = "file_flush"\n'
    '    FILE_SYNC = "file_sync"\n'
    '    PERMISSION_FINALIZATION = "permission_finalization"\n'
    '    PUBLICATION = "publication"\n'
    '    PARENT_OPEN = "parent_open"\n'
    '    PARENT_SYNC = "parent_sync"\n'
    '    CLEANUP = "cleanup"\n'
    '    RECONCILIATION = "reconciliation"\n'
    '\n'
    '\n'
    'class ErrorClass(str, Enum):\n'
    '    SERIALIZATION = "serialization"\n'
    '    SIZE = "size"\n'
    '    PERMISSION = "permission"\n'
    '    DESCRIPTOR_EXHAUSTION = "descriptor_exhaustion"\n'
    '    UNSUPPORTED_CAPABILITY = "unsupported_capability"\n'
    '    IO = "io"\n'
    '    INTERRUPTION = "interruption"\n'
    '    CONFLICT = "conflict"\n'
    '    IDENTITY_TYPE = "identity_type"\n'
    '    CLEANUP = "cleanup"\n'
    '    UNKNOWN = "unknown"\n'
    '\n'
    '\n'
    'class _EventTempRecovery(Enum):\n'
    '    ABSENT = 0\n'
    '    RETIRED_UNPUBLISHED = 1\n'
    '    RETIRED_PUBLISHED = 2\n'
    '\n'
    '\n'
    'class DurableWriteError(RuntimeError):\n'
    '    def __init__(\n'
    '        self,\n'
    '        error_class: ErrorClass | str,\n'
    '        public_message: str | None = None,\n'
    '    ):\n'
    '        self.error_class = ErrorClass(error_class)\n'
    '        super().__init__(public_message or self.error_class.value)\n'
    '\n'
    '\n'
    '@dataclass(frozen=True)\n'
    'class PublicationResult:\n'
    '    component: str\n'
    '    durability: DurabilityProof\n'
    '    confinement: ConfinementProof\n'
    '    cleanup: CleanupState\n'
    '    authority: AuthorityState\n'
    '    stage: WriteStage\n'
    '    error_class: ErrorClass | None\n'
    '    generation: int | None\n'
    '    private_operation_id: str\n'
    '    private_content_sha256: str | None\n'
    '\n'
    '    @property\n'
    '    def advance_allowed(self) -> bool:\n'
    '        return (\n'
    '            self.durability\n'
    '            in {\n'
    '                DurabilityProof.COMMITTED,\n'
    '                DurabilityProof.RECONCILED_COMMITTED,\n'
    '            }\n'
    '            and self.confinement is ConfinementProof.PROVEN\n'
    '            and self.authority is AuthorityState.INTENDED_AUTHORITATIVE\n'
    '            and self.cleanup\n'
    '            in {\n'
    '                CleanupState.NOT_REQUIRED,\n'
    '                CleanupState.COMPLETE,\n'
    '                CleanupState.DEBT_PRIVATE_TEMP,\n'
    '            }\n'
    '        )\n'
    '\n'
    '    def public_projection(self) -> dict[str, str | int | None]:\n'
    '        return {\n'
    '            "component": self.component,\n'
    '            "durability": self.durability.value,\n'
    '            "confinement": self.confinement.value,\n'
    '            "cleanup": self.cleanup.value,\n'
    '            "authority": self.authority.value,\n'
    '            "stage": self.stage.value,\n'
    '            "error_class": self.error_class.value if self.error_class else None,\n'
    '            "generation": self.generation,\n'
    '        }\n'
    '\n'
    '\n'
    '@dataclass(frozen=True)\n'
    'class DurableJsonTarget:\n'
    '    trusted_root: Path\n'
    '    relative_path: PurePath\n'
    '    logical_target: str\n'
    '\n'
    '\n'
    '@dataclass(frozen=True)\n'
    'class JsonVersion:\n'
    '    exists: bool\n'
    '    raw_sha256: str | None\n'
    '    generation: int | None\n'
    '    operation_id: str | None\n'
    '\n'
    '\n'
    'def durable_json_target(\n'
    '    *,\n'
    '    trusted_root: os.PathLike[str] | str,\n'
    '    relative_path: os.PathLike[str] | str,\n'
    ') -> DurableJsonTarget:\n'
    '    root_text = os.fspath(trusted_root)\n'
    '    relative_text = os.fspath(relative_path)\n'
    '    root_parts = root_text.split("/")\n'
    '    relative_parts = relative_text.split("/")\n'
    '    if (\n'
    '        not root_text.startswith("/")\n'
    '        or any(part in {"", ".", ".."} for part in root_parts[1:])\n'
    '        or relative_text.startswith("/")\n'
    '        or "\\\\" in relative_text\n'
    '        or any(part in {"", ".", ".."} for part in relative_parts)\n'
    '    ):\n'
    '        raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)\n'
    '    relative = PurePosixPath(*relative_parts)\n'
    '    return DurableJsonTarget(\n'
    '        trusted_root=Path(root_text),\n'
    '        relative_path=relative,\n'
    '        logical_target=relative.as_posix(),\n'
    '    )\n'
    '\n'
    '\n'
    'def _open_directory(name: str, *, dir_fd: int) -> int:\n'
    '    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(\n'
    '        os,\n'
    '        "O_NOFOLLOW",\n'
    '        0,\n'
    '    )\n'
    '    try:\n'
    '        descriptor = os.open(name, flags, dir_fd=dir_fd)\n'
    '    except OSError as exc:\n'
    '        if exc.errno in {errno.EMFILE, errno.ENFILE}:\n'
    '            error_class = ErrorClass.DESCRIPTOR_EXHAUSTION\n'
    '        elif exc.errno in {errno.EACCES, errno.EPERM}:\n'
    '            error_class = ErrorClass.PERMISSION\n'
    '        else:\n'
    '            error_class = ErrorClass.IDENTITY_TYPE\n'
    '        raise DurableWriteError(error_class.value) from exc\n'
    '    if not stat.S_ISDIR(os.fstat(descriptor).st_mode):\n'
    '        os.close(descriptor)\n'
    '        raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)\n'
    '    return descriptor\n'
    '\n'
    '\n'
    'def _open_target_parent(target: DurableJsonTarget) -> tuple[int, str]:\n'
    '    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)\n'
    '    try:\n'
    '        for component in target.trusted_root.parts[1:]:\n'
    '            next_descriptor = _open_directory(component, dir_fd=descriptor)\n'
    '            os.close(descriptor)\n'
    '            descriptor = next_descriptor\n'
    '        root_stat = os.fstat(descriptor)\n'
    '        if (\n'
    '            root_stat.st_uid != os.getuid()\n'
    '            or stat.S_IMODE(root_stat.st_mode) & 0o077\n'
    '        ):\n'
    '            raise DurableWriteError(ErrorClass.PERMISSION.value)\n'
    '        relative_parts = target.relative_path.parts\n'
    '        for component in relative_parts[:-1]:\n'
    '            next_descriptor = _open_directory(component, dir_fd=descriptor)\n'
    '            component_stat = os.fstat(next_descriptor)\n'
    '            if (\n'
    '                component_stat.st_uid != os.getuid()\n'
    '                or stat.S_IMODE(component_stat.st_mode) & 0o077\n'
    '            ):\n'
    '                os.close(next_descriptor)\n'
    '                raise DurableWriteError(ErrorClass.PERMISSION.value)\n'
    '            os.close(descriptor)\n'
    '            descriptor = next_descriptor\n'
    '        return descriptor, relative_parts[-1]\n'
    '    except BaseException:\n'
    '        os.close(descriptor)\n'
    '        raise\n'
    '\n'
    '\n'
    'def _parent_authority_matches(\n'
    '    target: DurableJsonTarget,\n'
    '    parent_fd: int,\n'
    ') -> bool:\n'
    '    comparison_fd = -1\n'
    '    try:\n'
    '        comparison_fd, _leaf = _open_target_parent(target)\n'
    '        current = os.fstat(parent_fd)\n'
    '        comparison = os.fstat(comparison_fd)\n'
    '        return (\n'
    '            current.st_dev == comparison.st_dev\n'
    '            and current.st_ino == comparison.st_ino\n'
    '        )\n'
    '    except (OSError, DurableWriteError):\n'
    '        return False\n'
    '    finally:\n'
    '        if comparison_fd >= 0:\n'
    '            os.close(comparison_fd)\n'
    '\n'
    '\n'
    'def _canonical_payload(payload: Mapping[str, Any]) -> bytes:\n'
    '    if not isinstance(payload, Mapping):\n'
    '        raise DurableWriteError(ErrorClass.SERIALIZATION.value)\n'
    '\n'
    '    active_containers: set[int] = set()\n'
    '\n'
    '    def validate(value: Any) -> None:\n'
    '        if isinstance(value, bool) or value is None or isinstance(value, str):\n'
    '            return\n'
    '        if isinstance(value, int):\n'
    '            if abs(value) > _MAX_SAFE_INTEGER:\n'
    '                raise DurableWriteError(ErrorClass.SERIALIZATION.value)\n'
    '            return\n'
    '        if isinstance(value, float):\n'
    '            return\n'
    '        if not isinstance(value, (Mapping, list, tuple)):\n'
    '            return\n'
    '        identity = id(value)\n'
    '        if identity in active_containers:\n'
    '            raise DurableWriteError(ErrorClass.SERIALIZATION.value)\n'
    '        active_containers.add(identity)\n'
    '        try:\n'
    '            if isinstance(value, Mapping):\n'
    '                if any(not isinstance(key, str) for key in value):\n'
    '                    raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)\n'
    '                for nested in value.values():\n'
    '                    validate(nested)\n'
    '            else:\n'
    '                for nested in value:\n'
    '                    validate(nested)\n'
    '        finally:\n'
    '            active_containers.remove(identity)\n'
    '\n'
    '    validate(payload)\n'
    '    try:\n'
    '        rendered = json.dumps(\n'
    '            payload,\n'
    '            allow_nan=False,\n'
    '            ensure_ascii=False,\n'
    '            separators=(",", ":"),\n'
    '            sort_keys=True,\n'
    '        )\n'
    '    except (TypeError, ValueError) as exc:\n'
    '        raise DurableWriteError(ErrorClass.SERIALIZATION.value) from exc\n'
    '    raw = rendered.encode("utf-8")\n'
    '    if len(raw) + 1 > _MAX_JSON_BYTES:\n'
    '        raise DurableWriteError(ErrorClass.SIZE.value)\n'
    '    return raw\n'
    '\n'
    '\n'
    'def operation_id(\n'
    '    target: DurableJsonTarget,\n'
    '    payload: Mapping[str, Any],\n'
    '    *,\n'
    '    component: str,\n'
    '    predecessor: JsonVersion,\n'
    ') -> str:\n'
    '    if (\n'
    '        not isinstance(target, DurableJsonTarget)\n'
    '        or not isinstance(predecessor, JsonVersion)\n'
    '        or not isinstance(component, str)\n'
    '        or not component\n'
    '        or "\\0" in component\n'
    '    ):\n'
    '        raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)\n'
    '    intended_sha256 = hashlib.sha256(_canonical_payload(payload)).hexdigest()\n'
    '    material = "\\0".join(\n'
    '        [\n'
    '            "whatsoup.durable-json.v1",\n'
    '            component,\n'
    '            target.logical_target,\n'
    '            predecessor.raw_sha256 or "absent",\n'
    '            intended_sha256,\n'
    '        ]\n'
    '    ).encode("utf-8")\n'
    '    return hashlib.sha256(material).hexdigest()\n'
    '\n'
    '\n'
    'def _result(\n'
    '    *,\n'
    '    component: str,\n'
    '    operation: str,\n'
    '    content_sha256: str | None,\n'
    '    durability: DurabilityProof,\n'
    '    authority: AuthorityState,\n'
    '    stage: WriteStage,\n'
    '    error_class: ErrorClass | None = None,\n'
    '    cleanup: CleanupState = CleanupState.NOT_REQUIRED,\n'
    '    confinement: ConfinementProof = ConfinementProof.PROVEN,\n'
    '    generation: int | None = None,\n'
    ') -> PublicationResult:\n'
    '    return PublicationResult(\n'
    '        component=component,\n'
    '        durability=durability,\n'
    '        confinement=confinement,\n'
    '        cleanup=cleanup,\n'
    '        authority=authority,\n'
    '        stage=stage,\n'
    '        error_class=error_class,\n'
    '        generation=generation,\n'
    '        private_operation_id=operation,\n'
    '        private_content_sha256=content_sha256,\n'
    '    )\n'
    '\n'
    '\n'
    'def _classify_exception(\n'
    '    exc: OSError | DurableWriteError,\n'
    '    *,\n'
    '    parent_opened: bool,\n'
    ') -> tuple[ConfinementProof, ErrorClass]:\n'
    '    if isinstance(exc, InterruptedError):\n'
    '        return (\n'
    '            (\n'
    '                ConfinementProof.PROVEN\n'
    '                if parent_opened\n'
    '                else ConfinementProof.UNPROVEN\n'
    '            ),\n'
    '            ErrorClass.INTERRUPTION,\n'
    '        )\n'
    '    if isinstance(exc, DurableWriteError):\n'
    '        confinement = (\n'
    '            ConfinementProof.VIOLATED\n'
    '            if not parent_opened\n'
    '            and exc.error_class is ErrorClass.IDENTITY_TYPE\n'
    '            else (\n'
    '                ConfinementProof.PROVEN\n'
    '                if parent_opened\n'
    '                else ConfinementProof.UNPROVEN\n'
    '            )\n'
    '        )\n'
    '        return confinement, exc.error_class\n'
    '    if exc.errno in {errno.EMFILE, errno.ENFILE}:\n'
    '        error_class = ErrorClass.DESCRIPTOR_EXHAUSTION\n'
    '    elif exc.errno in {errno.EACCES, errno.EPERM}:\n'
    '        error_class = ErrorClass.PERMISSION\n'
    '    elif exc.errno in {\n'
    '        errno.EINVAL,\n'
    '        getattr(errno, "ENOTSUP", errno.EINVAL),\n'
    '        getattr(errno, "EOPNOTSUPP", errno.EINVAL),\n'
    '    }:\n'
    '        error_class = ErrorClass.UNSUPPORTED_CAPABILITY\n'
    '    else:\n'
    '        error_class = ErrorClass.IO\n'
    '    return (\n'
    '        (\n'
    '            ConfinementProof.PROVEN\n'
    '            if parent_opened\n'
    '            else ConfinementProof.UNPROVEN\n'
    '        ),\n'
    '        error_class,\n'
    '    )\n'
    '\n'
    '\n'
    'def _lock_parent(parent_fd: int) -> int:\n'
    '    if fcntl is None:\n'
    '        raise DurableWriteError(ErrorClass.UNSUPPORTED_CAPABILITY.value)\n'
    '    common_flags = (\n'
    '        os.O_RDWR | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)\n'
    '    )\n'
    '    descriptor = -1\n'
    '    created = False\n'
    '    for _attempt in range(3):\n'
    '        try:\n'
    '            descriptor = os.open(\n'
    '                ".durable-json.lock",\n'
    '                common_flags | os.O_CREAT | os.O_EXCL,\n'
    '                0o600,\n'
    '                dir_fd=parent_fd,\n'
    '            )\n'
    '            created = True\n'
    '            break\n'
    '        except FileExistsError:\n'
    '            try:\n'
    '                descriptor = os.open(\n'
    '                    ".durable-json.lock",\n'
    '                    common_flags,\n'
    '                    dir_fd=parent_fd,\n'
    '                )\n'
    '                break\n'
    '            except FileNotFoundError:\n'
    '                continue\n'
    '        except FileNotFoundError:\n'
    '            continue\n'
    '    if descriptor < 0:\n'
    '        raise FileNotFoundError("lock entry did not stabilize")\n'
    '    lock_stat = os.fstat(descriptor)\n'
    '    if (\n'
    '        not stat.S_ISREG(lock_stat.st_mode)\n'
    '        or lock_stat.st_uid != os.getuid()\n'
    '        or stat.S_IMODE(lock_stat.st_mode) & 0o077\n'
    '    ):\n'
    '        os.close(descriptor)\n'
    '        raise DurableWriteError(ErrorClass.PERMISSION.value)\n'
    '    os.fchmod(descriptor, 0o600)\n'
    '    if created:\n'
    '        os.fsync(descriptor)\n'
    '        os.fsync(parent_fd)\n'
    '    fcntl.flock(descriptor, fcntl.LOCK_EX)\n'
    '    return descriptor\n'
    '\n'
    '\n'
    'def _require_capabilities() -> None:\n'
    '    if (\n'
    '        fcntl is None\n'
    '        or not getattr(os, "O_NOFOLLOW", 0)\n'
    '        or not _HAS_OPEN_DIR_FD\n'
    '        or not _HAS_LINK_DIR_FD\n'
    '        or not _HAS_LINK_NOFOLLOW\n'
    '    ):\n'
    '        raise DurableWriteError(ErrorClass.UNSUPPORTED_CAPABILITY.value)\n'
    '\n'
    '\n'
    'def _write_all(descriptor: int, raw: bytes) -> None:\n'
    '    offset = 0\n'
    '    while offset < len(raw):\n'
    '        written = os.write(descriptor, raw[offset:])\n'
    '        if written <= 0:\n'
    '            raise OSError("short write")\n'
    '        offset += written\n'
    '\n'
    '\n'
    'def _inject_fault(\n'
    '    hook: Callable[[WriteStage], None] | None,\n'
    '    stage: WriteStage,\n'
    ') -> None:\n'
    '    if hook is not None:\n'
    '        hook(stage)\n'
    '\n'
    '\n'
    'def _recover_reconciled_event_temp(\n'
    '    parent_fd: int,\n'
    '    *,\n'
    '    leaf: str,\n'
    '    temp_name: str,\n'
    '    intended_raw: bytes,\n'
    ') -> _EventTempRecovery:\n'
    '    flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)\n'
    '    try:\n'
    '        temp_fd = os.open(temp_name, flags, dir_fd=parent_fd)\n'
    '    except FileNotFoundError:\n'
    '        return _EventTempRecovery.ABSENT\n'
    '    target_fd = -1\n'
    '    try:\n'
    '        temp_stat = os.fstat(temp_fd)\n'
    '        if (\n'
    '            not stat.S_ISREG(temp_stat.st_mode)\n'
    '            or temp_stat.st_uid != os.getuid()\n'
    '            or stat.S_IMODE(temp_stat.st_mode) & 0o077\n'
    '            or temp_stat.st_nlink not in {1, 2}\n'
    '            or temp_stat.st_size != len(intended_raw)\n'
    '        ):\n'
    '            raise DurableWriteError(ErrorClass.CONFLICT)\n'
    '        observed = b""\n'
    '        while len(observed) < len(intended_raw):\n'
    '            chunk = os.read(\n'
    '                temp_fd,\n'
    '                len(intended_raw) - len(observed),\n'
    '            )\n'
    '            if not chunk:\n'
    '                break\n'
    '            observed += chunk\n'
    '        if observed != intended_raw:\n'
    '            raise DurableWriteError(ErrorClass.CONFLICT)\n'
    '        try:\n'
    '            target_fd = os.open(leaf, flags, dir_fd=parent_fd)\n'
    '        except FileNotFoundError:\n'
    '            if temp_stat.st_nlink != 1:\n'
    '                raise DurableWriteError(ErrorClass.CONFLICT)\n'
    '            os.unlink(temp_name, dir_fd=parent_fd)\n'
    '            os.fsync(parent_fd)\n'
    '            return _EventTempRecovery.RETIRED_UNPUBLISHED\n'
    '        target_stat = os.fstat(target_fd)\n'
    '        if (\n'
    '            not stat.S_ISREG(target_stat.st_mode)\n'
    '            or target_stat.st_uid != os.getuid()\n'
    '            or stat.S_IMODE(target_stat.st_mode) & 0o077\n'
    '            or temp_stat.st_dev != target_stat.st_dev\n'
    '            or temp_stat.st_ino != target_stat.st_ino\n'
    '            or temp_stat.st_nlink != 2\n'
    '            or target_stat.st_nlink != 2\n'
    '            or target_stat.st_size != len(intended_raw)\n'
    '        ):\n'
    '            raise DurableWriteError(ErrorClass.CONFLICT)\n'
    '        os.unlink(temp_name, dir_fd=parent_fd)\n'
    '        os.fsync(parent_fd)\n'
    '        return _EventTempRecovery.RETIRED_PUBLISHED\n'
    '    finally:\n'
    '        if target_fd >= 0:\n'
    '            os.close(target_fd)\n'
    '        os.close(temp_fd)\n'
    '\n'
    '\n'
    'def publish_event_json(\n'
    '    target: DurableJsonTarget,\n'
    '    payload: Mapping[str, Any],\n'
    '    *,\n'
    '    component: str,\n'
    '    operation_id: str,\n'
    '    _fault_hook: Callable[[WriteStage], None] | None = None,\n'
    ') -> PublicationResult:\n'
    '    absent = JsonVersion(False, None, None, None)\n'
    '    try:\n'
    '        canonical = _canonical_payload(payload)\n'
    '        expected_operation = globals()["operation_id"](\n'
    '            target,\n'
    '            payload,\n'
    '            component=component,\n'
    '            predecessor=absent,\n'
    '        )\n'
    '    except DurableWriteError as exc:\n'
    '        return _result(\n'
    '            component=component,\n'
    '            operation=operation_id,\n'
    '            content_sha256=None,\n'
    '            durability=DurabilityProof.NOT_MUTATED,\n'
    '            authority=AuthorityState.EXPECTED_PREDECESSOR,\n'
    '            stage=WriteStage.SERIALIZATION,\n'
    '            error_class=exc.error_class,\n'
    '        )\n'
    '    raw = canonical + b"\\n"\n'
    '    content_sha256 = hashlib.sha256(raw).hexdigest()\n'
    '    if operation_id != expected_operation:\n'
    '        return _result(\n'
    '            component=component,\n'
    '            operation=operation_id,\n'
    '            content_sha256=content_sha256,\n'
    '            durability=DurabilityProof.NOT_MUTATED,\n'
    '            authority=AuthorityState.EXPECTED_PREDECESSOR,\n'
    '            stage=WriteStage.CAPABILITY_CHECK,\n'
    '            error_class=ErrorClass.IDENTITY_TYPE,\n'
    '        )\n'
    '\n'
    '    parent_fd = -1\n'
    '    lock_fd = -1\n'
    '    temp_fd = -1\n'
    '    temp_name = f".durable-json.{operation_id}.tmp"\n'
    '    temp_created = False\n'
    '    published = False\n'
    '    cleanup = CleanupState.NOT_REQUIRED\n'
    '    current_stage = WriteStage.SERIALIZATION\n'
    '    try:\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        current_stage = WriteStage.CAPABILITY_CHECK\n'
    '        _require_capabilities()\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        current_stage = WriteStage.PARENT_OPEN\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        parent_fd, leaf = _open_target_parent(target)\n'
    '        current_stage = WriteStage.LOCK_ACQUISITION\n'
    '        lock_fd = _lock_parent(parent_fd)\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        current_stage = WriteStage.TEMPORARY_CREATION\n'
    '        event_temp_recovery = _recover_reconciled_event_temp(\n'
    '            parent_fd,\n'
    '            leaf=leaf,\n'
    '            temp_name=temp_name,\n'
    '            intended_raw=raw,\n'
    '        )\n'
    '        if event_temp_recovery is _EventTempRecovery.RETIRED_PUBLISHED:\n'
    '            authority = (\n'
    '                AuthorityState.INTENDED_AUTHORITATIVE\n'
    '                if _parent_authority_matches(target, parent_fd)\n'
    '                else AuthorityState.UNKNOWN\n'
    '            )\n'
    '            return _result(\n'
    '                component=component,\n'
    '                operation=operation_id,\n'
    '                content_sha256=content_sha256,\n'
    '                durability=DurabilityProof.RECONCILED_COMMITTED,\n'
    '                authority=authority,\n'
    '                stage=WriteStage.RECONCILIATION,\n'
    '                cleanup=CleanupState.COMPLETE,\n'
    '            )\n'
    '        flags = (\n'
    '            os.O_WRONLY\n'
    '            | os.O_CREAT\n'
    '            | os.O_EXCL\n'
    '            | os.O_CLOEXEC\n'
    '            | getattr(os, "O_NOFOLLOW", 0)\n'
    '        )\n'
    '        temp_fd = os.open(\n'
    '            temp_name,\n'
    '            flags,\n'
    '            0o600,\n'
    '            dir_fd=parent_fd,\n'
    '        )\n'
    '        temp_created = True\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        current_stage = WriteStage.WRITE\n'
    '        _write_all(temp_fd, raw)\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        current_stage = WriteStage.FILE_FLUSH\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        current_stage = WriteStage.FILE_SYNC\n'
    '        os.fsync(temp_fd)\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        current_stage = WriteStage.PERMISSION_FINALIZATION\n'
    '        os.fchmod(temp_fd, 0o600)\n'
    '        temp_stat = os.fstat(temp_fd)\n'
    '        if not stat.S_ISREG(temp_stat.st_mode) or temp_stat.st_nlink != 1:\n'
    '            raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        os.close(temp_fd)\n'
    '        temp_fd = -1\n'
    '        current_stage = WriteStage.PUBLICATION\n'
    '        os.link(\n'
    '            temp_name,\n'
    '            leaf,\n'
    '            src_dir_fd=parent_fd,\n'
    '            dst_dir_fd=parent_fd,\n'
    '            follow_symlinks=False,\n'
    '        )\n'
    '        published = True\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        current_stage = WriteStage.CLEANUP\n'
    '        try:\n'
    '            os.unlink(temp_name, dir_fd=parent_fd)\n'
    '            temp_created = False\n'
    '            cleanup = CleanupState.COMPLETE\n'
    '        except OSError:\n'
    '            cleanup = CleanupState.DEBT_PRIVATE_TEMP\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        current_stage = WriteStage.PARENT_SYNC\n'
    '        _inject_fault(_fault_hook, current_stage)\n'
    '        os.fsync(parent_fd)\n'
    '        authority = (\n'
    '            AuthorityState.INTENDED_AUTHORITATIVE\n'
    '            if _parent_authority_matches(target, parent_fd)\n'
    '            else AuthorityState.UNKNOWN\n'
    '        )\n'
    '        return _result(\n'
    '            component=component,\n'
    '            operation=operation_id,\n'
    '            content_sha256=content_sha256,\n'
    '            durability=DurabilityProof.COMMITTED,\n'
    '            authority=authority,\n'
    '            stage=WriteStage.PARENT_SYNC,\n'
    '            cleanup=cleanup,\n'
    '        )\n'
    '    except FileExistsError:\n'
    '        if current_stage is WriteStage.TEMPORARY_CREATION:\n'
    '            return _result(\n'
    '                component=component,\n'
    '                operation=operation_id,\n'
    '                content_sha256=content_sha256,\n'
    '                durability=DurabilityProof.NOT_MUTATED,\n'
    '                authority=AuthorityState.UNKNOWN,\n'
    '                stage=current_stage,\n'
    '                error_class=ErrorClass.CONFLICT,\n'
    '                cleanup=CleanupState.DEBT_RECOVERY_RECORD,\n'
    '            )\n'
    '        if parent_fd >= 0:\n'
    '            existing_fd = -1\n'
    '            try:\n'
    '                existing_fd = os.open(\n'
    '                    leaf,\n'
    '                    (\n'
    '                        os.O_RDONLY\n'
    '                        | os.O_CLOEXEC\n'
    '                        | getattr(os, "O_NOFOLLOW", 0)\n'
    '                    ),\n'
    '                    dir_fd=parent_fd,\n'
    '                )\n'
    '                existing_stat = os.fstat(existing_fd)\n'
    '                if (\n'
    '                    not stat.S_ISREG(existing_stat.st_mode)\n'
    '                    or existing_stat.st_uid != os.getuid()\n'
    '                    or stat.S_IMODE(existing_stat.st_mode) & 0o077\n'
    '                    or existing_stat.st_nlink != 1\n'
    '                    or existing_stat.st_size != len(raw)\n'
    '                ):\n'
    '                    raise DurableWriteError(ErrorClass.CONFLICT.value)\n'
    '                existing = b""\n'
    '                while len(existing) < len(raw):\n'
    '                    chunk = os.read(\n'
    '                        existing_fd,\n'
    '                        len(raw) - len(existing),\n'
    '                    )\n'
    '                    if not chunk:\n'
    '                        break\n'
    '                    existing += chunk\n'
    '                if existing == raw:\n'
    '                    try:\n'
    '                        os.unlink(temp_name, dir_fd=parent_fd)\n'
    '                        temp_created = False\n'
    '                        cleanup = CleanupState.COMPLETE\n'
    '                    except OSError:\n'
    '                        cleanup = CleanupState.DEBT_PRIVATE_TEMP\n'
    '                    os.fsync(parent_fd)\n'
    '                    authority = (\n'
    '                        AuthorityState.INTENDED_AUTHORITATIVE\n'
    '                        if _parent_authority_matches(target, parent_fd)\n'
    '                        else AuthorityState.UNKNOWN\n'
    '                    )\n'
    '                    return _result(\n'
    '                        component=component,\n'
    '                        operation=operation_id,\n'
    '                        content_sha256=content_sha256,\n'
    '                        durability=DurabilityProof.RECONCILED_COMMITTED,\n'
    '                        authority=authority,\n'
    '                        stage=WriteStage.RECONCILIATION,\n'
    '                        cleanup=cleanup,\n'
    '                    )\n'
    '            except (OSError, DurableWriteError):\n'
    '                pass\n'
    '            finally:\n'
    '                if existing_fd >= 0:\n'
    '                    os.close(existing_fd)\n'
    '        return _result(\n'
    '            component=component,\n'
    '            operation=operation_id,\n'
    '            content_sha256=content_sha256,\n'
    '            durability=(\n'
    '                DurabilityProof.UNPROVEN\n'
    '                if published\n'
    '                else DurabilityProof.NOT_MUTATED\n'
    '            ),\n'
    '            authority=AuthorityState.CONFLICT,\n'
    '            stage=WriteStage.PUBLICATION,\n'
    '            error_class=ErrorClass.CONFLICT,\n'
    '            cleanup=(\n'
    '                CleanupState.DEBT_PRIVATE_TEMP\n'
    '                if temp_created\n'
    '                else CleanupState.NOT_REQUIRED\n'
    '            ),\n'
    '        )\n'
    '    except (OSError, DurableWriteError) as exc:\n'
    '        confinement, error_class = _classify_exception(\n'
    '            exc,\n'
    '            parent_opened=parent_fd >= 0,\n'
    '        )\n'
    '        cleanup_state = (\n'
    '            CleanupState.DEBT_RECOVERY_RECORD\n'
    '            if current_stage is WriteStage.TEMPORARY_CREATION\n'
    '            and not temp_created\n'
    '            else (\n'
    '                CleanupState.DEBT_PRIVATE_TEMP\n'
    '                if temp_created\n'
    '                else CleanupState.NOT_REQUIRED\n'
    '            )\n'
    '        )\n'
    '        return _result(\n'
    '            component=component,\n'
    '            operation=operation_id,\n'
    '            content_sha256=content_sha256,\n'
    '            durability=(\n'
    '                DurabilityProof.UNPROVEN\n'
    '                if published\n'
    '                else DurabilityProof.NOT_MUTATED\n'
    '            ),\n'
    '            authority=(\n'
    '                AuthorityState.UNKNOWN\n'
    '                if published\n'
    '                else AuthorityState.EXPECTED_PREDECESSOR\n'
    '            ),\n'
    '            stage=current_stage,\n'
    '            error_class=error_class,\n'
    '            cleanup=cleanup_state,\n'
    '            confinement=confinement,\n'
    '        )\n'
    '    finally:\n'
    '        if temp_fd >= 0:\n'
    '            os.close(temp_fd)\n'
    '        if temp_created and parent_fd >= 0:\n'
    '            try:\n'
    '                os.unlink(temp_name, dir_fd=parent_fd)\n'
    '            except OSError:\n'
    '                pass\n'
    '        if lock_fd >= 0:\n'
    '            os.close(lock_fd)\n'
    '        if parent_fd >= 0:\n'
    '            os.close(parent_fd)\n'
    '\n'
    '\n'
    'def require_advance(result: PublicationResult) -> None:\n'
    '    if not result.advance_allowed:\n'
    '        raise DurableWriteError(\n'
    '            result.error_class or ErrorClass.UNKNOWN,\n'
    '            json.dumps(\n'
    '                result.public_projection(),\n'
    '                sort_keys=True,\n'
    '                separators=(",", ":"),\n'
    '            ),\n'
    '        )\n'
    '\n'
    '\n'
    'def require_all_advance(results: Sequence[PublicationResult]) -> None:\n'
    '    for result in results:\n'
    '        require_advance(result)\n'
)
# END GENERATED REMOTE DURABLE JSON SOURCE


REMOTE_WRITEFAIL_ACK_SCRIPT = REMOTE_DURABLE_JSON_SOURCE + r"""
import errno, hashlib, json, os, re, shutil, sys, time
from pathlib import Path

claim = Path(sys.argv[1])
root = Path(sys.argv[2]).expanduser()
action = sys.argv[3]

def safe(value):
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value).strip("_")
    return (cleaned or "unknown")[:80]

def unique(paths):
    result = []
    seen = set()
    for path in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        result.append(path)
    return result

def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def payload_sha256():
    digest = hashlib.sha256()
    with open(claim, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def target_path(target_dir, suffix, digest):
    return target_dir / f"{safe(claim.name)}.{digest}{suffix}"

def unique_child_path(target_dir, name):
    stem = safe(name)
    candidates = [target_dir / stem]
    prefix = f"{int(time.time())}.{os.getpid()}"
    candidates.extend(target_dir / f"{prefix}.{index}.{stem}" for index in range(1000))
    for candidate in candidates:
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"no unique writefail requeue path in {target_dir}")

def temp_path(target_dir, target):
    candidates = [target_dir / f".{target.name}.{os.getpid()}.tmp"]
    candidates.extend(target_dir / f".{target.name}.{os.getpid()}.{index}.tmp" for index in range(1, 100))
    for candidate in candidates:
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"no unique temporary writefail ack path in {target_dir}")

def journal_path(target_dir, digest):
    return target_dir / f".{safe(claim.name)}.{digest}.ack.json"

def copy_receipt_path(target_dir, digest):
    return target_dir / f".{safe(claim.name)}.{digest}.copy.json"

def write_ack_journal(target, digest):
    journal = journal_path(target.parent, digest)
    payload = {
        "claim": str(claim),
        "payloadSha256": digest,
        "target": str(target),
        "createdAt": int(claim.stat().st_mtime),
    }
    publication_target = durable_json_target(
        trusted_root=str(target.parent.resolve(strict=True)),
        relative_path=journal.name,
    )
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        publication_target,
        payload,
        component="collector.remote_writefail_ack_journal",
        predecessor=absent,
    )
    publication = publish_event_json(
        publication_target,
        payload,
        component="collector.remote_writefail_ack_journal",
        operation_id=publication_operation,
    )
    require_advance(publication)
    return journal, publication

def find_terminal_journal(digest):
    for target_dir in terminal_dirs():
        journal = journal_path(target_dir, digest)
        try:
            loaded = json.loads(journal.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        except Exception:
            continue
        if loaded.get("claim") != str(claim) or loaded.get("payloadSha256") != digest:
            continue
        target = Path(str(loaded.get("target") or ""))
        if target.parent != target_dir:
            continue
        try:
            if validate_terminal_target(target_dir, target, digest):
                return target
        except OSError:
            continue
    return None

def terminal_dirs():
    tmpdir = Path(os.environ.get("TMPDIR", "/tmp")).expanduser()
    # The local harvest/quarantine copy is authoritative; these terminal archives are forensic breadcrumbs.
    return unique([
        root / "writefail-relayed",
        Path.home() / ".bot-errors-writefail-relayed",
        tmpdir / "bot-errors-writefail-relayed",
        Path("/tmp") / f"bot-errors-writefail-relayed-{os.getuid()}",
    ])

def descriptor_sha256(descriptor):
    digest = hashlib.sha256()
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    return digest.hexdigest()

def open_private_terminal_dir(path):
    path_stat = path.lstat()
    if path.is_symlink() or not path.is_dir():
        raise OSError(errno.EPERM, "terminal directory is not a direct directory")
    if path_stat.st_uid != os.getuid() or path_stat.st_mode & 0o077:
        raise OSError(errno.EPERM, "terminal directory is not private")
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
    )
    descriptor_stat = os.fstat(descriptor)
    if (
        descriptor_stat.st_dev != path_stat.st_dev
        or descriptor_stat.st_ino != path_stat.st_ino
    ):
        os.close(descriptor)
        raise OSError(errno.EPERM, "terminal directory identity changed")
    return descriptor

def validate_terminal_target(target_dir, target, digest):
    if target.parent != target_dir:
        return False
    parent_fd = open_private_terminal_dir(target_dir)
    lock_fd = -1
    target_fd = -1
    try:
        lock_fd = _lock_parent(parent_fd)
        target_fd = os.open(
            target.name,
            os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_fd,
        )
        target_stat = os.fstat(target_fd)
        if (
            not stat.S_ISREG(target_stat.st_mode)
            or target_stat.st_uid != os.getuid()
            or stat.S_IMODE(target_stat.st_mode) & 0o077
            or target_stat.st_nlink != 1
        ):
            return False
        if descriptor_sha256(target_fd) != digest:
            return False
        os.fsync(parent_fd)
        return True
    finally:
        if target_fd >= 0:
            os.close(target_fd)
        if lock_fd >= 0:
            os.close(lock_fd)
        os.close(parent_fd)

def copy_claim_atomic(target_dir, target):
    digest = payload_sha256()
    tmp = temp_path(target_dir, target)
    try:
        if os.path.lexists(target):
            if not validate_terminal_target(target_dir, target, digest):
                raise FileExistsError(f"terminal writefail ack target conflicts: {target}")
        else:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(tmp, flags, 0o600)
            try:
                with open(claim, "rb") as source, os.fdopen(descriptor, "wb", closefd=False) as dest:
                    shutil.copyfileobj(source, dest)
                    dest.flush()
                    os.fsync(dest.fileno())
                os.fchmod(descriptor, 0o600)
            finally:
                os.close(descriptor)
            try:
                os.link(tmp, target, follow_symlinks=False)
            except FileExistsError:
                if not validate_terminal_target(target_dir, target, digest):
                    raise
            tmp.unlink()
        fsync_dir(target_dir)
        if not validate_terminal_target(target_dir, target, digest):
            raise OSError(errno.EIO, "terminal writefail ack target validation failed")
        receipt = copy_receipt_path(target_dir, digest)
        receipt_payload = {
            "claim": str(claim),
            "payloadSha256": digest,
            "target": str(target),
        }
        receipt_target = durable_json_target(
            trusted_root=str(target_dir.resolve(strict=True)),
            relative_path=receipt.name,
        )
        absent = JsonVersion(False, None, None, None)
        receipt_operation = operation_id(
            receipt_target,
            receipt_payload,
            component="collector.remote_writefail_copy",
            predecessor=absent,
        )
        copy_publication = publish_event_json(
            receipt_target,
            receipt_payload,
            component="collector.remote_writefail_copy",
            operation_id=receipt_operation,
        )
        _journal, journal_publication = write_ack_journal(target, digest)
        require_all_advance([copy_publication, journal_publication])
        claim.unlink()
        fsync_dir(claim.parent)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise

def move_claim_terminal(target_dir, suffix):
    target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if target_dir.is_symlink() or not target_dir.is_dir():
        raise OSError(errno.EPERM, "terminal directory is not a direct directory")
    try:
        target_dir.chmod(0o700)
    except OSError:
        pass
    digest = payload_sha256()
    target = target_path(target_dir, suffix, digest)
    try:
        if target.exists():
            raise FileExistsError(f"terminal writefail ack target already exists: {target}")
        os.replace(claim, target)
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
        copy_claim_atomic(target_dir, target)
        return target
    fsync_dir(target_dir)
    fsync_dir(claim.parent)
    return target

if action == "ack":
    digest = payload_sha256()
    already_terminal = find_terminal_journal(digest)
    if already_terminal is not None:
        try:
            claim.unlink()
            fsync_dir(claim.parent)
            print(already_terminal)
            raise SystemExit(0)
        except OSError as exc:
            raise RuntimeError(f"terminal writefail ack already archived but claim unlink failed: target={already_terminal} error={exc}") from exc
    last_error = None
    for target_dir in terminal_dirs():
        try:
            target = move_claim_terminal(target_dir, ".relayed")
            print(target)
            raise SystemExit(0)
        except OSError as exc:
            last_error = exc
            continue
    raise RuntimeError(f"no writable writefail ack terminal dir: {last_error}")
else:
    # Requeue intentionally returns only to root/writefail; if that write fails, the processing lease preserves retry state.
    target_dir = root / "writefail"
    target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    base = claim.name.split(".writefail.", 1)[0] + ".writefail" if ".writefail." in claim.name else claim.name
    target = unique_child_path(target_dir, base)
    os.replace(claim, target)
    print(target)
"""


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_private_dir(path: Path) -> None:
    try:
        path.lstat()
    except FileNotFoundError:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    else:
        if path.is_symlink():
            raise RuntimeError(f"refusing to use private directory through symlink: {path}")
        if not os.path.isdir(path):
            raise RuntimeError(f"refusing to use private directory over non-directory path: {path}")
    try:
        path.chmod(0o700)
    except OSError:
        pass


def safe_segment(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def safe_filename(value: str, max_length: int = 180) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    cleaned = cleaned or "unknown"
    if len(cleaned) <= max_length:
        return cleaned
    for suffix in (".writefail", ".poison", ".json"):
        if cleaned.endswith(suffix) and len(suffix) < max_length:
            stem = cleaned[: max_length - len(suffix)].rstrip("._-:")
            return f"{stem or 'unknown'}{suffix}"
    return cleaned[:max_length]


def env_key_segment(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").upper()


def remote_exec_prefix(host: str) -> list[str]:
    raw = os.environ.get(f"BOT_ERRORS_RELAY_EXEC_{env_key_segment(host)}", "")
    return shlex.split(raw) if raw else []


def ssh_command() -> list[str]:
    raw = os.environ.get("BOT_ERRORS_RELAY_SSH_COMMAND", "")
    return shlex.split(raw) if raw else ["ssh"]


def tailscale_status_command() -> list[str] | None:
    raw = os.environ.get("BOT_ERRORS_TAILSCALE_STATUS_COMMAND")
    if raw is not None and not raw.strip():
        return None
    return shlex.split(raw) if raw else ["tailscale", "status", "--json"]


def tailscale_lookup_timeout() -> float:
    raw = os.environ.get("BOT_ERRORS_TAILSCALE_STATUS_TIMEOUT_SECONDS", "2")
    try:
        timeout = float(raw)
    except ValueError:
        timeout = 2
    return max(timeout, 0.1)


def remote_python_command(host: str, args: list[str]) -> list[str]:
    return [
        *ssh_command(),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        host,
        *remote_exec_prefix(host),
        "python3",
        "-",
        *args,
    ]


def _durable_target(path: Path):
    ensure_private_dir(path.parent)
    return durable_json_target(
        trusted_root=path.parent.resolve(strict=True),
        relative_path=path.name,
    )


def assert_regular_or_missing(path: Path) -> None:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return
    if os.path.islink(path):
        raise RuntimeError(f"refusing to append through symlink: {path}")
    if not os.path.isfile(path):
        raise RuntimeError(f"refusing to append non-regular file: {path}")


def append_private_jsonl(path: Path, record: dict[str, Any]) -> None:
    ensure_private_dir(path.parent)
    assert_regular_or_missing(path)
    data = (json.dumps(record, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(
        path,
        os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    with os.fdopen(fd, "ab") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        path.chmod(0o600)
    except OSError:
        pass
    try:
        dir_fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
    except OSError:
        dir_fd = None
    if dir_fd is not None:
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


def redact_collector_text(value: Any) -> str:
    return redact_bot_errors_text(
        value,
        credential_path_marker="[REDACTED_CREDENTIAL_PATH]",
        github_marker="[REDACTED_GITHUB_TOKEN]",
    )


def redacted_collector_payload(value: Any) -> Any:
    return redact_shared_json_value(value, redact_collector_text)


def persist_controller_log_health(record: dict[str, Any]) -> None:
    target = _durable_target(
        state_root() / "controller-log-health" / "collector.json"
    )
    observation = observe_json(target)
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        record,
        component="collector.controller_log_health",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        record,
        component="collector.controller_log_health",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    if not publication.advance_allowed:
        require_advance(publication)


def controller_log_fallback(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


def append_log(
    payload: dict[str, Any],
    *,
    level: str = "info",
    outcome: str = "observed",
) -> str:
    path = state_root() / "logs" / "collector.jsonl"
    redacted = redacted_collector_payload(payload)
    record_kind = redacted.get("type") if isinstance(redacted, dict) else None
    if not isinstance(record_kind, str):
        raise ValueError("collector controller log requires a bounded type")
    details = {key: value for key, value in redacted.items() if key != "type"}
    return write_controller_log(
        context=CONTROLLER_LOG_CONTEXT,
        record_kind=record_kind,
        level=level,
        outcome=outcome,
        durability_class="diagnostic_best_effort",
        details=metadata_only_controller_details(details),
        append_record=lambda record: append_private_jsonl(path, record),
        persist_health=persist_controller_log_health,
        emit_fallback=controller_log_fallback,
    )


def state_path() -> Path:
    return state_root() / COLLECTOR_STATE


STATE_LOCK_TIMEOUT_SECONDS = 30.0


def save_state(state: dict[str, Any]) -> None:
    path = state_path()
    target = _durable_target(path)
    observation = observe_json(target)
    payload = redacted_collector_payload(state)
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        payload,
        component="collector.state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        payload,
        component="collector.state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    require_advance(publication)


def collector_bootstrap_state() -> dict[str, Any]:
    return {"remotes": {}}


def validate_collector_state(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("collector state root must be an object")
    sanitized = {
        key: value
        for key, value in payload.items()
        if key != "_controllerState"
    }
    if not isinstance(sanitized.setdefault("remotes", {}), dict):
        raise ValueError("collector state remotes must be an object")
    return json.loads(json.dumps(sanitized))


def reconcile_recovered_collector_state(
    payload: Any,
) -> tuple[dict[str, Any], str]:
    # Candidate evidence (remote configuration, claimed entries,
    # acknowledgements, probe fixtures) is not a complete local ledger and
    # must not change recovered membership, clocks, cooldowns, backoff,
    # retry budgets, suppression, or counters.
    return validate_collector_state(payload), "validated_previous_only"


def open_collector_state_session():
    anchor = state_path()
    ensure_private_dir(anchor.parent)
    # macOS state/tmp roots commonly traverse OS path aliases (/var and /tmp
    # are symlinks to /private/...). Anchor the store at the resolved
    # directory so the library's no-follow identity checks guard the store
    # artifacts themselves rather than rejecting the alias, which would
    # fail-stop every cycle with unsafe_file on a healthy store.
    resolved = anchor.parent.resolve(strict=True) / anchor.name
    return open_controller_state(
        resolved,
        component="collector",
        bootstrap=collector_bootstrap_state,
        validate_payload=validate_collector_state,
        lock_timeout_seconds=STATE_LOCK_TIMEOUT_SECONDS,
    )


def save_collector_state(session: Any, state: dict[str, Any], capability: Any):
    return session.save(redacted_collector_payload(state), capability)


def project_collector_state_mode(diagnostic: Any) -> str:
    # schemaVersion is a reserved controller-log record field; the record
    # envelope owns it, the closed diagnostic details must not shadow it.
    details = metadata_only_controller_details(
        {
            key: value
            for key, value in state_diagnostic_details(diagnostic).items()
            if key != "schemaVersion"
        }
    )
    failed = diagnostic.mode == "recovery_required"
    log_path = state_root() / "logs" / "collector.jsonl"
    return write_controller_log(
        context=CONTROLLER_LOG_CONTEXT,
        record_kind="controller_state_mode",
        level="error" if failed else "info",
        outcome="failed" if failed else "observed",
        durability_class="diagnostic_best_effort",
        details=details,
        append_record=lambda record: append_private_jsonl(log_path, record),
        persist_health=persist_controller_log_health,
        emit_fallback=lambda _line: emit_state_recovery_fallback(diagnostic),
    )


def _load_collector_state_for_cycle(session: Any) -> tuple[dict[str, Any], Any]:
    result = session.load()
    project_collector_state_mode(result.diagnostic)
    if result.mode == "recovery_required":
        raise ControllerStateRequired(result.diagnostic)
    if result.mode == "recovered":
        recovered_payload, outcome = reconcile_recovered_collector_state(
            result.payload
        )
        committed = session.complete_reconciliation(
            recovered_payload,
            result.capability,
            outcome=outcome,
        )
        project_collector_state_mode(committed.diagnostic)
        result = session.reload()
        project_collector_state_mode(result.diagnostic)
    if result.mode not in {"bootstrap", "valid", "reconciled"}:
        raise ControllerStateRequired(result.diagnostic)
    return result.payload, result.capability


def alert_key(remote: str, source: str) -> str:
    return f"{remote}:{source}"


def normalize_match_token(value: Any) -> str:
    return re.sub(r"\s+", "-", str(value or "").strip().rstrip(".").lower())


def parse_remote_host_targets_env() -> dict[str, list[str]]:
    raw = os.environ.get("BOT_ERRORS_REMOTE_HOST_TARGETS", "").strip()
    if not raw:
        return {}
    parsed: dict[str, list[str]] = {}
    try:
        loaded = json.loads(raw)
        if isinstance(loaded, dict):
            for key, value in loaded.items():
                values = value if isinstance(value, list) else [value]
                parsed[str(key)] = [str(item).strip() for item in values if str(item).strip()]
            return parsed
    except json.JSONDecodeError:
        pass
    for item in raw.split(","):
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        targets = [target.strip() for target in re.split(r"[|;]", value) if target.strip()]
        if key.strip() and targets:
            parsed[key.strip()] = targets
    return parsed


def unique_values(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = normalize_match_token(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(value)
    return result


def resolve_ssh_host_targets(host: str) -> list[str]:
    if host in REMOTE_HOST_TARGETS_CACHE:
        return REMOTE_HOST_TARGETS_CACHE[host]
    targets = [host]
    for value in parse_remote_host_targets_env().get(host, []):
        targets.append(value)
    try:
        proc = subprocess.run(
            [*ssh_command(), "-G", host],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=tailscale_lookup_timeout(),
            check=False,
        )
        if proc.returncode == 0:
            for line in proc.stdout.splitlines():
                if not line.strip() or " " not in line:
                    continue
                key, value = line.split(None, 1)
                if key.lower() in {"hostname", "hostkeyalias"} and value.strip():
                    targets.append(value.strip())
    except Exception as exc:  # noqa: BLE001 - enrichment must not block collection.
        append_log({"type": "ssh_config_lookup_failed", "host": host, "error": str(exc)[:300]})
    REMOTE_HOST_TARGETS_CACHE[host] = unique_values(targets)
    return REMOTE_HOST_TARGETS_CACHE[host]


def load_tailscale_status() -> tuple[dict[str, Any] | None, str | None]:
    global TAILSCALE_STATUS_CACHE, TAILSCALE_STATUS_ERROR
    if TAILSCALE_STATUS_CACHE is not None or TAILSCALE_STATUS_ERROR is not None:
        return TAILSCALE_STATUS_CACHE, TAILSCALE_STATUS_ERROR
    command = tailscale_status_command()
    if command is None:
        TAILSCALE_STATUS_ERROR = "disabled"
        return None, TAILSCALE_STATUS_ERROR
    try:
        proc = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=tailscale_lookup_timeout(),
            check=False,
        )
    except Exception as exc:  # noqa: BLE001 - optional enrichment.
        TAILSCALE_STATUS_ERROR = str(exc)[:500]
        return None, TAILSCALE_STATUS_ERROR
    if proc.returncode != 0:
        TAILSCALE_STATUS_ERROR = f"rc={proc.returncode}: {proc.stderr.strip()[:300]}"
        return None, TAILSCALE_STATUS_ERROR
    try:
        loaded = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        TAILSCALE_STATUS_ERROR = f"invalid_json: {exc}"
        return None, TAILSCALE_STATUS_ERROR
    if not isinstance(loaded, dict):
        TAILSCALE_STATUS_ERROR = "json_root_not_object"
        return None, TAILSCALE_STATUS_ERROR
    TAILSCALE_STATUS_CACHE = loaded
    return TAILSCALE_STATUS_CACHE, None


def tailscale_peers(status: dict[str, Any]) -> list[dict[str, Any]]:
    peers: list[dict[str, Any]] = []
    self_peer = status.get("Self")
    if isinstance(self_peer, dict):
        peers.append(self_peer)
    raw_peers = status.get("Peer")
    if isinstance(raw_peers, dict):
        for peer in raw_peers.values():
            if isinstance(peer, dict):
                peers.append(peer)
    return peers


def peer_tokens(peer: dict[str, Any]) -> set[str]:
    tokens: set[str] = set()
    for key in ("HostName", "DNSName", "Name"):
        value = str(peer.get(key) or "").strip()
        if not value:
            continue
        normalized = normalize_match_token(value)
        tokens.add(normalized)
        if "." in normalized:
            tokens.add(normalized.split(".", 1)[0])
    ips = peer.get("TailscaleIPs")
    if isinstance(ips, list):
        for ip in ips:
            if isinstance(ip, str):
                tokens.add(normalize_match_token(ip))
    return {token for token in tokens if token}


def tailscale_peer_summary(host: str) -> dict[str, Any]:
    targets = resolve_ssh_host_targets(host)
    target_tokens = {normalize_match_token(target) for target in targets if normalize_match_token(target)}
    status, error = load_tailscale_status()
    if status is None:
        return {
            "status": "unavailable" if error != "disabled" else "disabled",
            "error": error,
            "targets": targets,
        }
    for peer in tailscale_peers(status):
        overlap = sorted(target_tokens.intersection(peer_tokens(peer)))
        if not overlap:
            continue
        summary = {
            "status": "found",
            "matched": overlap[0],
            "targets": targets,
            "hostName": peer.get("HostName"),
            "dnsName": peer.get("DNSName"),
            "tailscaleIPs": peer.get("TailscaleIPs") if isinstance(peer.get("TailscaleIPs"), list) else [],
            "online": peer.get("Online"),
            "active": peer.get("Active"),
            "lastSeen": peer.get("LastSeen"),
            "lastHandshake": peer.get("LastHandshake"),
            "os": peer.get("OS"),
        }
        return {key: value for key, value in summary.items() if value is not None}
    return {"status": "not_found", "targets": targets}


def evidence_value(value: Any) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, list):
        return ",".join(str(item) for item in value)
    return str(value)


def tailscale_evidence_lines(summary: dict[str, Any]) -> list[str]:
    if not summary or summary.get("status") == "disabled":
        return []
    ordered_keys = [
        "status",
        "matched",
        "hostName",
        "dnsName",
        "tailscaleIPs",
        "online",
        "active",
        "lastSeen",
        "lastHandshake",
        "os",
        "targets",
        "error",
    ]
    lines: list[str] = []
    for key in ordered_keys:
        value = summary.get(key)
        if value in (None, "", []):
            continue
        lines.append(f"tailscale_{key}={evidence_value(value)[:240]}")
    return lines


def _is_ssh_transport_failure(normalized_error: str) -> bool:
    """Return True when the error string indicates a transport-level SSH failure.

    Transport failures mean the TCP/TLS handshake never completed or SSH's own
    authentication (key / host-key) was rejected — the remote host is unreachable
    or the SSH layer itself cannot establish a session.  These are distinct from
    remote-command failures (nonzero exit, missing script, file permission errors)
    where the SSH tunnel was established successfully.

    Transport patterns (any of):
    - connection refused / reset
    - no route to host / network is unreachable
    - ssh: connect to host …  (generic SSH connect error prefix)
    - permission denied (publickey) / (password) / (gssapi…)  — SSH auth failure
    - host key verification failed / known_hosts mismatch
    - timed out / operation timed out / connection timed out (handled separately
      as tailscale_online_ssh_timeout; listed here so the caller need not repeat
      the check, but this helper is not called for timeouts — see ssh_failure_diagnosis)
    """
    return (
        "connection refused" in normalized_error
        or "connection reset by peer" in normalized_error
        or "no route to host" in normalized_error
        or "network is unreachable" in normalized_error
        or normalized_error.startswith("ssh: connect to host")
        or "permission denied (publickey" in normalized_error
        or "permission denied (password" in normalized_error
        or "permission denied (gssapi" in normalized_error
        or "host key verification failed" in normalized_error
        or "known_hosts" in normalized_error
    )


def ssh_failure_diagnosis(error: str, tailscale: dict[str, Any]) -> str | None:
    """Classify an SSH failure into one of three reachability diagnoses.

    Classification table:
    | Condition                               | Diagnosis                          |
    |-----------------------------------------|------------------------------------|
    | peer online + timeout variant           | tailscale_online_ssh_timeout       |
    | peer online + transport-level failure   | tailscale_online_ssh_failed        |
    | peer online + remote-command failure    | tailscale_online_ssh_remote_error  |
    | peer offline                            | tailscale_offline                  |
    | peer status unknown / not found         | None                               |

    Only tailscale_offline, tailscale_online_ssh_timeout, and
    tailscale_online_ssh_failed are genuine unreachability signals — callers must
    NOT skip secondary probes for tailscale_online_ssh_remote_error.
    """
    if not tailscale or tailscale.get("status") != "found":
        return None
    normalized_error = error.lower()
    if tailscale.get("online") is True and (
        "timed out" in normalized_error
        or "operation timed out" in normalized_error
        or "connection timed out" in normalized_error
    ):
        return "tailscale_online_ssh_timeout"
    if tailscale.get("online") is True:
        if _is_ssh_transport_failure(normalized_error):
            return "tailscale_online_ssh_failed"
        return "tailscale_online_ssh_remote_error"
    if tailscale.get("online") is False:
        return "tailscale_offline"
    return None


def remote_failure_context(host: str, error: str = "") -> tuple[list[str], dict[str, Any]]:
    tailscale = tailscale_peer_summary(host)
    if not tailscale or tailscale.get("status") == "disabled":
        return [], {}
    diagnostics: dict[str, Any] = {"tailscale": tailscale}
    lines = tailscale_evidence_lines(tailscale)
    diagnosis = ssh_failure_diagnosis(error, tailscale)
    if diagnosis:
        diagnostics["reachabilityDiagnosis"] = diagnosis
        lines.append(f"reachability_diagnosis={diagnosis}")
    return lines, diagnostics


def tailscale_ping_command(host: str) -> list[str] | None:
    raw = os.environ.get("BOT_ERRORS_TAILSCALE_PING_COMMAND")
    if raw is not None and not raw.strip():
        return None  # explicitly disabled
    if raw:
        return [*shlex.split(raw), host]
    return ["tailscale", "ping", "--c", "1", "--timeout", "3s", host]


def tailscale_ping_timeout() -> float:
    raw = os.environ.get("BOT_ERRORS_TAILSCALE_PING_TIMEOUT_SECONDS", "4")
    try:
        timeout = float(raw)
    except ValueError:
        timeout = 4
    return max(timeout, 0.5)


def liveness_probe_enabled() -> bool:
    raw = os.environ.get("BOT_ERRORS_PREFLIGHT_LIVENESS_PROBE", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def best_effort_info_tier_enabled() -> bool:
    """Pattern I — best-effort remotes are operator-declared expected-flaky hosts.

    A ``--best-effort-remote`` (e.g. a laptop that sleeps) going offline is a
    planned/expected condition, not a crash. When this gate is on (default), its
    per-remote failure events (``relay_host_down``, pre-threshold
    ``remote-claim-failed``) emit at ``info`` instead of ``warning``/``critical``
    so they surface in the digest without paging. Gate off restores prior
    behavior (fail-open).
    """
    raw = os.environ.get("BOT_ERRORS_BEST_EFFORT_INFO_TIER", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def probe_target_for(host: str, tailscale: dict[str, Any] | None = None) -> str:
    """Pick the address ``tailscale ping`` can actually resolve.

    ``tailscale ping`` resolves only Tailscale IPs and MagicDNS names — NOT
    arbitrary ssh host aliases. The collector keys remotes by their ssh alias,
    which ``tailscale ping`` cannot look up (``error looking up IP of
    "<alias>"``), so probing the bare alias always
    errored → fail-closed → the liveness probe could never clear a stale
    ``Online: false`` and the false-positive storm it was meant to suppress
    fired anyway.

    Prefer the peer's Tailscale IPv4, then any Tailscale IP, then the matched
    token, then the alias itself as a last resort.
    """
    summary = tailscale if tailscale is not None else tailscale_peer_summary(host)
    ips = summary.get("tailscaleIPs") if isinstance(summary, dict) else None
    if isinstance(ips, list):
        for ip in ips:
            if isinstance(ip, str) and "." in ip and ":" not in ip:
                return ip  # IPv4 — most universally pingable
        for ip in ips:
            if isinstance(ip, str) and ip:
                return ip  # IPv6 fallback
    matched = summary.get("matched") if isinstance(summary, dict) else None
    if isinstance(matched, str) and matched:
        return matched
    return host


def remote_liveness_probe_ok(host: str, probe_target: str | None = None) -> bool:
    """Confirm a peer is actually reachable via a direct probe.

    The Tailscale control-plane ``Online`` flag goes stale for idle peers that
    hold a direct (LAN) path — they stop refreshing the coordination-server
    heartbeat while remaining fully reachable over WireGuard. Trusting that flag
    alone produced correlated false-positive ``relay_host_down`` storms (the
    whole relay fleet flagged offline while every node answered ssh in <10ms).

    ``probe_target`` is the address actually handed to ``tailscale ping`` — it
    MUST be a Tailscale-resolvable IP/MagicDNS name, not the ssh host alias.
    Callers pass the peer's Tailscale IP via :func:`probe_target_for`. When
    omitted (unit tests) it falls back to ``host``.

    Returns True only on a positive pong. Fail-closed: a disabled, timed-out, or
    erroring probe returns False so the caller preserves the conservative
    skip-on-offline behaviour rather than hanging on a genuinely dead host.
    """
    if not liveness_probe_enabled():
        return False
    cmd = tailscale_ping_command(probe_target or host)
    if cmd is None:
        return False
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=tailscale_ping_timeout(),
            check=False,
        )
    except (subprocess.SubprocessError, OSError):
        return False
    return proc.returncode == 0 and "pong" in proc.stdout.lower()


def preflight_remote_unreachable(host: str) -> dict[str, Any] | None:
    tailscale = tailscale_peer_summary(host)
    if tailscale.get("status") == "found" and tailscale.get("online") is False:
        # The Online flag is a stale-prone control-plane heartbeat; confirm with
        # a real liveness probe before skipping ssh. A node that answers a direct
        # ping is reachable regardless of the flag — do not suppress its claim.
        # Probe the peer's Tailscale IP, never the bare ssh alias (which
        # ``tailscale ping`` cannot resolve).
        if remote_liveness_probe_ok(host, probe_target_for(host, tailscale)):
            return None
        return tailscale
    return None


def reachability_diagnosis(diagnostics: dict[str, Any]) -> str | None:
    value = diagnostics.get("reachabilityDiagnosis")
    return value if isinstance(value, str) and value else None


def skip_writefail_after_outbox_failure(diagnostics: dict[str, Any]) -> bool:
    return reachability_diagnosis(diagnostics) in {
        "tailscale_offline",
        "tailscale_online_ssh_timeout",
        "tailscale_online_ssh_failed",
    }


def legacy_open_record(state: dict[str, Any], key: str, remote: str, source: str) -> dict[str, Any] | None:
    last = int(state.setdefault("alerts", {}).get(key) or 0)
    if not last:
        return None
    record = {
        "status": "open",
        "eventId": f"legacy-{safe_segment(remote)}-{safe_segment(source)}-{last}",
        "openedAt": last,
        "openedIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last)),
        "lastSeenAt": last,
        "lastSeenIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last)),
        "lastEvidence": "migrated from pre-open-incident collector state",
        "suppressedCount": 0,
    }
    state.setdefault("openAlerts", {})[key] = record
    return record


def clear_meta_recovery_progress(state: dict[str, Any], remote: str, source: str) -> None:
    open_record = state.setdefault("openAlerts", {}).get(alert_key(remote, source))
    if not isinstance(open_record, dict):
        return
    for field in (
        "recoveryPendingAt",
        "recoveryPendingIso",
        "recoveryConsecutiveSuccesses",
        "recoverySuccessesRequired",
        "recoveryEvidence",
    ):
        open_record.pop(field, None)


def enqueue_meta_alert(
    remote: str,
    source: str,
    summary: str,
    evidence: str,
    state: dict[str, Any],
    cooldown: int,
    extra_diagnostics: dict[str, Any] | None = None,
    best_effort: bool = False,
) -> None:
    current = int(time.time())
    effective_severity = "info" if (best_effort and best_effort_info_tier_enabled()) else "critical"
    alerts = state.setdefault("alerts", {})
    open_alerts = state.setdefault("openAlerts", {})
    key = alert_key(remote, source)
    safe_summary = redact_collector_text(summary)
    safe_evidence = redact_collector_text(evidence)
    safe_extra_diagnostics = redacted_collector_payload(extra_diagnostics) if extra_diagnostics else None
    open_record = open_alerts.get(key)
    if not isinstance(open_record, dict):
        open_record = legacy_open_record(state, key, remote, source)
    if isinstance(open_record, dict) and open_record.get("status") == "open":
        clear_meta_recovery_progress(state, remote, source)
        created_at = now_iso()
        open_record["lastSeenAt"] = current
        open_record["lastSeenIso"] = created_at
        open_record["lastEvidence"] = safe_evidence[-1000:]
        if safe_extra_diagnostics:
            open_record["lastDiagnostics"] = safe_extra_diagnostics
        open_record["suppressedCount"] = int(open_record.get("suppressedCount") or 0) + 1
        last_notify = int(open_record.get("lastRenotifyAt") or open_record.get("openedAt") or alerts.get(key) or current)
        if current - last_notify >= cooldown:
            renotify_count = int(open_record.get("renotifyCount") or 0) + 1
            event_id = f"collector-{safe_segment(remote)}-{safe_segment(source)}-still-open-{current}"
            opened = open_record.get("openedIso") or open_record.get("openedAt")
            prior_event = open_record.get("eventId")
            diagnostics = {
                "queue": str(state_root() / "outbox"),
                "logHints": [str(state_root() / "logs/collector.jsonl")],
                "collectorLog": str(state_root() / "logs/collector.jsonl"),
                "remote": remote,
                "openIncident": {
                    "opened": opened,
                    "priorEventId": prior_event,
                    "suppressedCount": open_record["suppressedCount"],
                    "renotifyCount": renotify_count,
                },
            }
            if safe_extra_diagnostics:
                diagnostics.update(safe_extra_diagnostics)
            event = {
                **new_event_fields("observation" if effective_severity == "info" else "alert", effective_severity),
                "id": event_id,
                "createdAt": created_at,
                "machine": socket.gethostname(),
                "platform": sys.platform,
                "instance": "bot-errors-collector",
                "source": source,
                "summary": f"{safe_summary} (still open)",
                "evidence": (
                    f"{safe_evidence}\n"
                    f"incident_status=still_open\n"
                    f"opened={opened}\n"
                    f"prior_event={prior_event}\n"
                    f"suppressed_duplicates={open_record['suppressedCount']}\n"
                    f"renotify_count={renotify_count}\n"
                    f"collector_log={state_root() / 'logs/collector.jsonl'}"
                ),
                "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
                "diagnostics": diagnostics,
                "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
            }
            path = local_outbox_path(event, "collector")
            target = _durable_target(path)
            absent = JsonVersion(False, None, None, None)
            publication_operation = operation_id(
                target,
                event,
                component="collector.meta_alert_existing_claim",
                predecessor=absent,
            )
            publication = publish_event_json(
                target,
                event,
                component="collector.meta_alert_existing_claim",
                operation_id=publication_operation,
            )
            require_advance(publication)
            alerts[key] = current
            open_record["lastRenotifyAt"] = current
            open_record["lastRenotifyIso"] = created_at
            open_record["lastRenotifyEventId"] = event_id
            open_record["renotifyCount"] = renotify_count
            append_log({
                "type": "meta_alert_renotified_open",
                "remote": remote,
                "source": source,
                "eventId": event_id,
                "priorEventId": prior_event,
                "suppressedCount": open_record["suppressedCount"],
                "renotifyCount": renotify_count,
            })
            return
        append_log({
            "type": "meta_alert_suppressed_open",
            "remote": remote,
            "source": source,
            "eventId": open_record.get("eventId"),
            "suppressedCount": open_record["suppressedCount"],
        })
        return
    last = int(alerts.get(key) or 0)
    if current - last < cooldown:
        return
    event_id = f"collector-{safe_segment(remote)}-{safe_segment(source)}-{current}"
    diagnostics = {
        "queue": str(state_root() / "outbox"),
        "logHints": [str(state_root() / "logs/collector.jsonl")],
        "collectorLog": str(state_root() / "logs/collector.jsonl"),
        "remote": remote,
    }
    if safe_extra_diagnostics:
        diagnostics.update(safe_extra_diagnostics)
    event = {
        **new_event_fields("observation" if effective_severity == "info" else "alert", effective_severity),
        "id": event_id,
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-collector",
        "source": source,
        "summary": safe_summary,
        "evidence": safe_evidence,
        "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
        "diagnostics": diagnostics,
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    path = local_outbox_path(event, "collector")
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        event,
        component="collector.meta_alert_new_claim",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        event,
        component="collector.meta_alert_new_claim",
        operation_id=publication_operation,
    )
    require_advance(publication)
    alerts[key] = current
    open_alerts[key] = {
        "status": "open",
        "eventId": event_id,
        "openedAt": current,
        "openedIso": event["createdAt"],
        "lastSeenAt": current,
        "lastSeenIso": event["createdAt"],
        "lastEvidence": safe_evidence[-1000:],
        "suppressedCount": 0,
    }
    if safe_extra_diagnostics:
        open_alerts[key]["lastDiagnostics"] = safe_extra_diagnostics


def enqueue_meta_recovery(remote: str, source: str, summary: str, evidence: str, state: dict[str, Any]) -> None:
    open_alerts = state.setdefault("openAlerts", {})
    key = alert_key(remote, source)
    open_record = open_alerts.get(key)
    if not isinstance(open_record, dict):
        open_record = legacy_open_record(state, key, remote, source)
    if not isinstance(open_record, dict) or open_record.get("status") != "open":
        return
    current = int(time.time())
    event_id = f"collector-{safe_segment(remote)}-{safe_segment(source)}-recovered-{current}"
    safe_summary = redact_collector_text(summary)
    safe_evidence = redact_collector_text(evidence)
    opened = open_record.get("openedIso") or open_record.get("openedAt")
    prior_event = open_record.get("eventId")
    suppressed = int(open_record.get("suppressedCount") or 0)
    event = {
        **new_event_fields("clear", "info"),
        "id": event_id,
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-collector",
        "source": source,
        "summary": safe_summary,
        "evidence": (
            f"{safe_evidence}\n"
            f"opened={opened}\n"
            f"prior_event={prior_event}\n"
            f"suppressed_duplicates={suppressed}\n"
            f"collector_log={state_root() / 'logs/collector.jsonl'}"
        ),
        "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
        "diagnostics": {
            "queue": str(state_root() / "outbox"),
            "logHints": [str(state_root() / "logs/collector.jsonl")],
            "collectorLog": str(state_root() / "logs/collector.jsonl"),
            "remote": remote,
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    path = local_outbox_path(event, "collector")
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        event,
        component="collector.meta_recovery",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        event,
        component="collector.meta_recovery",
        operation_id=publication_operation,
    )
    require_advance(publication)
    open_alerts.pop(key, None)
    state.setdefault("alerts", {}).pop(key, None)
    append_log({
        "type": "meta_alert_recovered",
        "remote": remote,
        "source": source,
        "eventId": event_id,
        "priorEventId": prior_event,
        "suppressedCount": suppressed,
    })


def defer_meta_recovery(
    remote: str,
    source: str,
    state: dict[str, Any],
    consecutive_successes: int,
    required_successes: int,
    evidence: str,
) -> None:
    open_alerts = state.setdefault("openAlerts", {})
    key = alert_key(remote, source)
    open_record = open_alerts.get(key)
    if not isinstance(open_record, dict):
        open_record = legacy_open_record(state, key, remote, source)
    if not isinstance(open_record, dict) or open_record.get("status") != "open":
        return
    current = int(time.time())
    open_record["recoveryPendingAt"] = current
    open_record["recoveryPendingIso"] = now_iso()
    open_record["recoveryConsecutiveSuccesses"] = consecutive_successes
    open_record["recoverySuccessesRequired"] = required_successes
    open_record["recoveryEvidence"] = redact_collector_text(evidence)[-1000:]
    append_log({
        "type": "meta_alert_recovery_deferred",
        "remote": remote,
        "source": source,
        "consecutiveSuccesses": consecutive_successes,
        "requiredSuccesses": required_successes,
    })


def parse_remote(value: str) -> tuple[str, str]:
    if ":" in value:
        host, remote_root = value.split(":", 1)
        return host, remote_root
    return value, "~/.local/state/bot-errors"


def configured_remote_hosts(remotes: list[str]) -> list[str]:
    hosts: list[str] = []
    seen: set[str] = set()
    for remote in remotes:
        host, _remote_root = parse_remote(remote)
        if host in seen:
            continue
        seen.add(host)
        hosts.append(host)
    return hosts


# --- #2429 registered collector alert-source inventory ---------------------
#
# One inventory for pruning, so a source that any emit site mints cannot fall
# outside the pruning model and strand its record after its producer is gone.
# Each entry declares WHERE that source's open state lives, because the three
# homes are retired differently:
#
#   ALERT_STATE_OPEN_ALERTS   -- state["alerts"] / state["openAlerts"], keyed
#                                f"{remote}:{source}" by alert_key().
#   ALERT_STATE_ACK_FAILURES  -- state["writefailAckFailures"], keyed by an
#                                opaque payload digest, remote in the record
#                                body (acknowledgement membership).
#   ALERT_STATE_REMOTE_RECORD -- flags on state["remotes"][remote]. These
#                                direct escalation tiers are minted straight
#                                to the outbox by _emit_collector_outbox_event
#                                and hold no open-alert bucket key at all.
#
# Only the ALERT_STATE_OPEN_ALERTS subset is suffix-matched against bucket
# keys; the other two are matched by their own state shape.
# test_bot_errors_collector_pruning_disposition_2429.py AST-scans this
# module's emit sites and fails when a minted source literal is absent here,
# so the inventory cannot drift behind a newly added emitter.
ALERT_STATE_OPEN_ALERTS = "openAlerts"
ALERT_STATE_ACK_FAILURES = "writefailAckFailures"
ALERT_STATE_REMOTE_RECORD = "remotes"

# HD-11b -- collector capture-failure escalation (DEFECT-REGISTER collection-
# blindness class / NOTES.md wishlist 10, 13): a persistently uncollectable
# remote must not silently stall collection. Distinct from and independently
# tunable from RELAY_BACKOFF_FAILURE_THRESHOLD (backoff entry) -- both key off
# the same consecutiveFailures counter but serve different purposes: this is
# the earlier, lower-confidence escalation signal that opens a real dispatcher
# incident with a typed clear; relay_host_down is backoff-schedule entry.
# Defined here rather than beside collector_failure_escalate_threshold() so
# the registry below has a single definition point for every source it names.
COLLECTOR_CAPTURE_ESCALATION_SOURCE: str = "collector_remote_unreachable"
RELAY_HOST_DOWN_SOURCE: str = "relay_host_down"

REGISTERED_ALERT_SOURCES: dict[str, str] = {
    "remote-claim-failed": ALERT_STATE_OPEN_ALERTS,
    "remote-drain-stale": ALERT_STATE_OPEN_ALERTS,
    "remote-relay-failed": ALERT_STATE_OPEN_ALERTS,
    "remote-writefail-harvest-failed": ALERT_STATE_OPEN_ALERTS,
    "remote-writefail-nondurable": ALERT_STATE_OPEN_ALERTS,
    "remote-writefail-ack-failed": ALERT_STATE_ACK_FAILURES,
    COLLECTOR_CAPTURE_ESCALATION_SOURCE: ALERT_STATE_REMOTE_RECORD,
    RELAY_HOST_DOWN_SOURCE: ALERT_STATE_REMOTE_RECORD,
}

OPEN_ALERT_KEY_SOURCES: tuple[str, ...] = tuple(
    source for source, location in REGISTERED_ALERT_SOURCES.items() if location == ALERT_STATE_OPEN_ALERTS
)

# Which state["remotes"][remote] field marks each remote-record tier's incident
# as open. prune_state_to_configured_remotes iterates THIS map rather than
# branching on hand-typed flag names, so a tier added to
# REGISTERED_ALERT_SOURCES with location ALERT_STATE_REMOTE_RECORD but no entry
# here is a test failure, not a silent pruning-scope hole (#2429 review F1).
REMOTE_RECORD_OPEN_FLAGS: dict[str, str] = {
    COLLECTOR_CAPTURE_ESCALATION_SOURCE: "captureFailureEscalated",
    RELAY_HOST_DOWN_SOURCE: "downEventEmitted",
}

# emit_relay_host_state_event's `kind` argument is NOT a source. #2419 requires
# the recovered clear to carry the DOWN source so it keys onto the incident the
# alert opened; "relay_host_recovered" must therefore never reach an envelope as
# a source of its own. This map is that translation and the only place a relay
# host kind becomes a source, so the drift guard can sweep its values and an
# unknown kind fails closed instead of minting an unregistered source.
RELAY_HOST_STATE_KIND_SOURCES: dict[str, str] = {
    "relay_host_down": RELAY_HOST_DOWN_SOURCE,
    "relay_host_recovered": RELAY_HOST_DOWN_SOURCE,
}

CONFIGURATION_RETIRED_DISPOSITION = "configuration_retired"
CONFIGURATION_RETIRED_REASON = "remote_not_configured"


class UnregisteredAlertSourceError(RuntimeError):
    """An alert bucket key names a source outside REGISTERED_ALERT_SOURCES.

    #2429 requires an unknown or newly added source key to fail closed rather
    than be silently retained (old behaviour) or silently dropped. The message
    is bounded and content-free -- a count plus an opaque digest, never the raw
    key, remote identity, or remote root.
    """


def relay_host_state_source(kind: str) -> str:
    """Translate a relay-host state kind into the source its envelope carries.

    Fails closed on an unknown kind. Before #2429 an unrecognised kind fell
    through to ``source = kind``, minting an envelope under a source no
    inventory knew about, whose open state pruning would then delete with no
    disposition -- the same class of hole the registry closes for bucket keys.
    """
    try:
        return RELAY_HOST_STATE_KIND_SOURCES[kind]
    except KeyError:
        digest = hashlib.sha256(kind.encode("utf-8")).hexdigest()[:16]
        raise UnregisteredAlertSourceError(
            f"unregistered_relay_host_kind kinds=1 digest={digest}"
        ) from None


def split_alert_key(key: str) -> tuple[str, str] | None:
    """Split an alerts/openAlerts key into (remote, source), or None.

    None means the key names no registered open-alert source. Callers that
    prune must treat that as fail-closed, never as "not an alert key".
    """
    for source in OPEN_ALERT_KEY_SOURCES:
        suffix = f":{source}"
        if key.endswith(suffix):
            return key[: -len(suffix)], source
    return None


def _raise_unregistered_alert_sources(unregistered: list[str]) -> NoReturn:
    """Fail closed with a bounded, content-free reason.

    The message carries a count and an opaque digest only: an alert key holds
    a remote identity and remote root, and #2429's public-surface rule keeps
    those out of operator-visible diagnostics.
    """
    digest = hashlib.sha256("\0".join(unregistered).encode("utf-8")).hexdigest()[:16]
    raise UnregisteredAlertSourceError(
        f"unregistered_alert_source keys={len(unregistered)} digest={digest}"
    )


def require_registered_alert_keys(keys: list[str]) -> None:
    """Raise once for the whole batch when any key names an unregistered source."""
    unregistered = sorted({key for key in keys if split_alert_key(key) is None})
    if unregistered:
        _raise_unregistered_alert_sources(unregistered)


def emit_configuration_retired_disposition(
    remote: str,
    source: str,
    state_location: str,
    *,
    prior_status: str,
    alert_key_value: str | None = None,
    record_count: int = 1,
) -> str:
    """Publish the terminal disposition for one configuration-retired record.

    Reuses _emit_collector_outbox_event -- the same publish_event_json +
    require_advance + append_log path every other collector-minted lifecycle
    transition already uses -- rather than opening a second ledger.

    eventType is "observation", never "clear". Only kind == "incident_recovery"
    (eventType "clear", severity info) closes a dispatcher incident, and #2429
    forbids manufacturing a recovery clear: roster/configuration absence is
    configuration evidence, not health evidence. The disposition keeps the
    retired source and diagnostics.remote unchanged so dispatcher
    incident_key() lands it on the very incident it disposes.
    """
    key = alert_key_value or f"{remote}:{source}"
    retired_at = int(time.time())
    retired_at_iso = now_iso()
    key_digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    evidence = "\n".join([
        f"remote={remote}",
        f"alert_source={source}",
        f"disposition={CONFIGURATION_RETIRED_DISPOSITION}",
        f"disposition_reason={CONFIGURATION_RETIRED_REASON}",
        f"state_location={state_location}",
        f"prior_status={prior_status}",
        f"retired_record_count={record_count}",
        f"alert_key_digest={key_digest}",
        f"retired_at={retired_at_iso}",
        "recovery_claimed=false",
        f"collector_log={state_root() / 'logs/collector.jsonl'}",
    ])
    return _emit_collector_outbox_event(
        remote,
        source=source,
        event_type="observation",
        severity="info",
        summary=f"BOT ERRORS collector retired open alert state for unconfigured remote: {remote}",
        evidence=evidence,
        log_type="alert_configuration_retired",
        extra_diagnostics={
            "disposition": CONFIGURATION_RETIRED_DISPOSITION,
            "dispositionReason": CONFIGURATION_RETIRED_REASON,
            "dispositionSource": source,
            "dispositionStateLocation": state_location,
            "retiredAt": retired_at,
            "retiredAtIso": retired_at_iso,
            "priorStatus": prior_status,
            "retiredRecordCount": record_count,
            "alertKeyDigest": key_digest,
            "recoveryClaimed": False,
        },
    )


def prune_state_to_configured_remotes(state: dict[str, Any], remotes: list[str]) -> None:
    """Retire the state of remotes that configuration no longer lists.

    #2429 (pruning half): every open record removed here first emits an
    audited ``configuration_retired`` terminal disposition through the normal
    durable outbox path, so an operator can tell a deliberate retirement from
    a recovery, a corrupt-state loss, or an accidental roster omission. The
    disposition is an observation, never a clear -- see
    emit_configuration_retired_disposition.

    Validation runs to completion BEFORE the first effect. A bucket key naming
    a source outside REGISTERED_ALERT_SOURCES raises
    UnregisteredAlertSourceError with nothing published and nothing popped.
    This function runs at the top of _run_once_with_state, above every
    remote/probe/claim/ack/outbox effect and above save_collector_state, so
    that raise fails the whole cycle closed and leaves the prior ledger intact.
    """
    configured = set(remotes)

    # --- validation pass: no effects before the whole key world is known ---
    alert_buckets: list[dict[str, Any]] = []
    for bucket_name in ("alerts", "openAlerts"):
        bucket = state.get(bucket_name)
        if isinstance(bucket, dict):
            alert_buckets.append(bucket)
    require_registered_alert_keys([str(key) for bucket in alert_buckets for key in bucket])

    # --- direct escalation tiers (state["remotes"][remote] flags) ----------
    remote_state = state.get("remotes")
    if isinstance(remote_state, dict):
        for remote in list(remote_state):
            if remote in configured:
                continue
            record = remote_state.get(remote)
            if isinstance(record, dict):
                # Registry-driven: one disposition per remote-record tier whose
                # open flag is set. A quiet remote record owns no incident and
                # needs no disposition.
                for source, open_flag in REMOTE_RECORD_OPEN_FLAGS.items():
                    if record.get(open_flag):
                        emit_configuration_retired_disposition(
                            remote,
                            source,
                            ALERT_STATE_REMOTE_RECORD,
                            prior_status="open",
                        )
            remote_state.pop(remote, None)
    else:
        state["remotes"] = {}

    # --- open alert bookkeeping (alerts + openAlerts share one key space) --
    open_alerts = state.get("openAlerts")
    retiring: dict[str, tuple[str, str]] = {}
    for bucket in alert_buckets:
        for raw_key in bucket:
            key = str(raw_key)
            if key in retiring:
                continue
            remote, source = split_alert_key(key)  # type: ignore[misc]
            if remote not in configured:
                retiring[key] = (remote, source)
    for key, (remote, source) in retiring.items():
        record = open_alerts.get(key) if isinstance(open_alerts, dict) else None
        if isinstance(record, dict):
            prior_status = str(record.get("status") or "open")
        else:
            # An alerts-only key is a pre-open-incident timestamp that
            # legacy_open_record() would still materialise as an open episode.
            prior_status = "legacy"
        emit_configuration_retired_disposition(
            remote,
            source,
            ALERT_STATE_OPEN_ALERTS,
            prior_status=prior_status,
            alert_key_value=key,
        )
    for bucket in alert_buckets:
        for key in retiring:
            bucket.pop(key, None)
    for bucket_name in ("alerts", "openAlerts"):
        bucket = state.get(bucket_name)
        if not isinstance(bucket, dict) and bucket is not None:
            state[bucket_name] = {}

    # --- acknowledgement membership (writefailAckFailures) ----------------
    ack_failures = state.get("writefailAckFailures")
    if isinstance(ack_failures, dict):
        # This bucket is digest-keyed: one record per failed payload, many per
        # remote. Collapse to ONE disposition per remote carrying the record
        # count, mirroring how the openAlerts path collapses a key seen in both
        # buckets, so retiring a remote holding N ack failures does not emit N
        # identical observations (#2429 review F5).
        retiring_ack: dict[str, int] = {}
        unattributable: list[str] = []
        doomed: list[str] = []
        for key, record in ack_failures.items():
            remote = record.get("remote") if isinstance(record, dict) else None
            if isinstance(remote, str) and remote in configured:
                continue
            doomed.append(str(key))
            if isinstance(remote, str) and remote:
                retiring_ack[remote] = retiring_ack.get(remote, 0) + 1
            else:
                unattributable.append(str(key))
        for remote, retired_records in retiring_ack.items():
            emit_configuration_retired_disposition(
                remote,
                "remote-writefail-ack-failed",
                ALERT_STATE_ACK_FAILURES,
                prior_status="open",
                record_count=retired_records,
            )
        for key in unattributable:
            # No attributable remote: the record cannot be dispositioned
            # against an incident, but its removal is still audited rather
            # than silent.
            append_log({
                "type": "writefail_ack_failure_pruned_unattributable",
                "recordKeyDigest": hashlib.sha256(key.encode("utf-8")).hexdigest()[:16],
            })
        for key in doomed:
            ack_failures.pop(key, None)
    elif ack_failures is not None:
        state["writefailAckFailures"] = {}


def default_recovery_successes() -> int:
    raw = os.environ.get("BOT_ERRORS_COLLECTOR_RECOVERY_SUCCESSES", "2")
    try:
        return max(1, int(raw))
    except ValueError:
        return 2


# HD-11b escalation threshold. COLLECTOR_CAPTURE_ESCALATION_SOURCE, the source
# this threshold opens, is defined with the REGISTERED_ALERT_SOURCES registry
# above so the inventory has one definition point per source.
def collector_failure_escalate_threshold() -> int:
    raw = os.environ.get("BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD", "2")
    try:
        return max(1, int(raw))
    except ValueError:
        return 2


FAILURE_RETENTION_DETAIL_MAX_CHARS: int = 1000


def classify_collector_failure(exc: BaseException) -> str:
    """Classify a per-remote collection failure for retained diagnostics.

    Distinguishes malformed remote output (the SSH session completed and a
    claimed line failed to parse as JSON — a protocol/encoding problem on the
    remote side) from a genuine SSH/transport failure (nonzero exit,
    connection refused, timeout, preflight skip — anything that kept the
    remote command from running at all).
    """
    if isinstance(exc, json.JSONDecodeError):
        return "malformed_remote_output"
    return "ssh_failure"


def update_failure_retention(remote_record: dict[str, Any], exc: BaseException, error_text: str) -> None:
    """Persist bounded, redacted failure diagnostics that survive recovery.

    ``remote_record["lastError"]`` is cleared to ``None`` on the next success
    (see the success branch in :func:`run_once`), so the reason a remote was
    previously down is lost the moment it recovers. This retains a single,
    bounded record per remote — never an unbounded list — so an operator can
    still see what the last failure was, when it started, and when the remote
    recovered. Redaction runs before truncation (matching the
    ``safe_evidence`` pattern used elsewhere in this module) so a secret is
    never left half-exposed by the length cap.
    """
    current = int(time.time())
    retention = remote_record.get("failureRetention")
    if not isinstance(retention, dict):
        retention = {}
    failure_class = classify_collector_failure(exc)
    detail = redact_collector_text(error_text)[:FAILURE_RETENTION_DETAIL_MAX_CHARS]
    same_episode = retention.get("status") == "failing" and retention.get("failureClass") == failure_class
    if not same_episode:
        retention["firstObservedAt"] = current
        retention["firstObservedIso"] = now_iso()
    retention["status"] = "failing"
    retention["failureClass"] = failure_class
    retention["lastFailureDetail"] = detail
    retention["lastObservedAt"] = current
    retention["lastObservedIso"] = now_iso()
    remote_record["failureRetention"] = retention


def record_recovery_retention(remote_record: dict[str, Any]) -> None:
    """Mark recovery on the retained failure record, if one exists.

    Intentionally does not delete ``failureRetention`` — the prior failure
    detail must remain visible after recovery (DUR-03 acceptance: a
    fail -> success transition retains prior failure + recovery state). A
    remote that has never failed has no retention record and none is created
    here; retention only tracks remotes that have actually failed at least
    once.
    """
    retention = remote_record.get("failureRetention")
    if not isinstance(retention, dict):
        return
    current = int(time.time())
    retention["status"] = "recovered"
    retention["lastSuccessAt"] = current
    retention["lastSuccessIso"] = now_iso()


def ssh_json_lines(host: str, script: str, args: list[str], timeout: int) -> list[dict[str, Any]]:
    unreachable = preflight_remote_unreachable(host)
    if unreachable is not None:
        raise RuntimeError(f"preflight skipped ssh {host}: tailscale_offline")
    proc = subprocess.run(
        remote_python_command(host, args),
        input=script,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ssh {host} failed rc={proc.returncode}: {proc.stderr.strip()[:500]}")
    rows = []
    for line in proc.stdout.splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def remote_ack(host: str, claim: str, remote_root: str, action: str, timeout: int) -> str:
    proc = subprocess.run(
        remote_python_command(host, [claim, remote_root, action]),
        input=REMOTE_ACK_SCRIPT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ssh ack {host} failed rc={proc.returncode}: {proc.stderr.strip()[:500]}")
    return proc.stdout.strip()


REMOTE_CLAIM_STAT_SCRIPT = r"""
import sys
from pathlib import Path
print("present" if Path(sys.argv[1]).exists() else "absent")
"""


def remote_claim_exists(host: str, claim: str, timeout: int) -> bool:
    """#2427: read-only remote probe — does the claim file still exist?

    After an ack-phase failure: claim PRESENT means the acknowledgement
    genuinely failed (conservative requeue path). Claim ABSENT means either
    the ack archived it to relayed/ or lease recovery returned it to the
    remote outbox — absence does not discriminate the two, but in both cases
    the already-durable local record makes reconciling safe (a reoffer
    dedupes). Raises on probe failure so the caller can stay conservative.
    """
    proc = subprocess.run(
        remote_python_command(host, [claim]),
        input=REMOTE_CLAIM_STAT_SCRIPT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ssh claim-stat {host} failed rc={proc.returncode}: {proc.stderr.strip()[:500]}")
    return proc.stdout.strip() == "present"


REMOTE_ARCHIVE_CENSUS_SCRIPT = r"""
import json, os, sys, time
from stat import S_ISREG

# #2459 C3: read-only census of the terminal relay archive.
#
# Reports how much archive exists, how old it is and how much of it no longer
# parses -- as aggregates only. It never deletes, moves, renames or rewrites
# anything, and it never echoes the root it was pointed at, an artifact name,
# a source value or any payload field. The answer an operator gets is a
# handful of numbers, which is the whole point: the alternative (listing the
# directory by hand) puts host, account, instance, user and message text on
# a terminal.
#
# Scope: exactly the two directories this collector's own remote scripts
# write under the given root -- relayed/ (REMOTE_ACK_SCRIPT) and
# writefail-relayed/ (REMOTE_WRITEFAIL_ACK_SCRIPT). Sibling directories
# (outbox/, relay-processing/) hold live queue state, not archive, and
# conflating the two is the confusion this census exists to remove. Nested
# directories are not walked. The other writefail terminal locations the
# writefail script falls back to (home, TMPDIR, /tmp) are deliberately NOT
# scanned: they are outside the root the caller named.
#
# `now` (argv[2], optional) makes ages deterministic for a caller that needs
# a fixed clock; empty or absent means "read the clock here".

root = os.path.expanduser(sys.argv[1])
now = float(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else time.time()

ARCHIVE_DIRS = (("relayed", "relayed"), ("writefailRelayed", "writefail-relayed"))


def census(directory):
    # Aggregate one archive directory. Returns (report, source_kinds).
    count = 0
    total_bytes = 0
    oldest = None
    newest = None
    parse_failures = 0
    source_kinds = set()
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        # A host that has never relayed has no such directory. That is a zero
        # census, not a fault.
        names = []
    for name in names:
        entry = os.path.join(directory, name)
        try:
            info = os.lstat(entry)
        except OSError:
            # Vanished between listing and stat -- it is not in the archive now.
            continue
        # lstat + S_ISREG, so a symlink is never followed out of the archive
        # and a nested directory is never descended into.
        if not S_ISREG(info.st_mode):
            continue
        count += 1
        total_bytes += info.st_size
        age = int(round(now - info.st_mtime))
        oldest = age if oldest is None else max(oldest, age)
        newest = age if newest is None else min(newest, age)
        try:
            with open(entry, "rb") as handle:
                record = json.loads(handle.read().decode("utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            # Unreadable or not JSON: still a present artifact occupying
            # bytes and ageing, so it is counted AND flagged. Skipping it
            # would under-report exactly the artifacts worth knowing about.
            parse_failures += 1
            continue
        if not isinstance(record, dict):
            # `[]` and `"text"` are valid JSON but not event records.
            parse_failures += 1
            continue
        kind = record.get("source")
        if isinstance(kind, str) and kind:
            source_kinds.add(kind)
    report = {
        "artifactCount": count,
        "totalBytes": total_bytes,
        "oldestAgeSeconds": oldest,
        "newestAgeSeconds": newest,
        "parseFailureCount": parse_failures,
        # Cardinality only -- how MANY distinct producers are represented,
        # never which ones.
        "sourceKindCardinality": len(source_kinds),
    }
    return report, source_kinds


def combine(reports, kind_sets):
    oldest_values = [r["oldestAgeSeconds"] for r in reports if r["oldestAgeSeconds"] is not None]
    newest_values = [r["newestAgeSeconds"] for r in reports if r["newestAgeSeconds"] is not None]
    union = set()
    for kinds in kind_sets:
        union |= kinds
    return {
        "artifactCount": sum(r["artifactCount"] for r in reports),
        "totalBytes": sum(r["totalBytes"] for r in reports),
        "oldestAgeSeconds": max(oldest_values) if oldest_values else None,
        "newestAgeSeconds": min(newest_values) if newest_values else None,
        "parseFailureCount": sum(r["parseFailureCount"] for r in reports),
        # Union, not a sum: a producer present in both archives is one kind.
        "sourceKindCardinality": len(union),
    }


try:
    archives = {}
    reports = []
    kind_sets = []
    for label, dirname in ARCHIVE_DIRS:
        report, kinds = census(os.path.join(root, dirname))
        archives[label] = report
        reports.append(report)
        kind_sets.append(kinds)
    payload = {
        "schemaVersion": 1,
        "censusStatus": "ok",
        "generatedAtEpoch": int(now),
        "archives": archives,
        "total": combine(reports, kind_sets),
    }
except Exception:
    # Fail closed and fail QUIET: an escaping traceback would print argv,
    # which carries the remote root. The caller sees a non-zero exit and an
    # explicit failed status, never a path.
    print(json.dumps({"schemaVersion": 1, "censusStatus": "failed"}, sort_keys=True))
    sys.exit(3)

print(json.dumps(payload, sort_keys=True))
"""


def remote_archive_census(host: str, remote_root: str, timeout: int, now: float | None = None) -> dict[str, Any]:
    """#2459 C3: read-only, privacy-safe census of the remote relay archive.

    The acknowledged-claim archive lives on the REMOTE host (REMOTE_ACK_SCRIPT
    moves claims under the remote root), so no local scan can cover it -- see
    the LOCAL_EVENT_LIFECYCLE_DIR_NAMES note below. This probe answers how
    much of it there is, how old it is and how much of it no longer parses,
    without moving or deleting anything and without surfacing a host,
    account, instance, user, message, path or identifier.

    Unlike the other remote helpers, the failure path deliberately does NOT
    append `proc.stderr` to the raised error: the census's own stderr can name
    the remote root, and a probe whose failure mode leaks the path defeats the
    privacy property that is the reason it exists.

    `now` pins the clock the ages are measured against; None reads the remote
    clock. Returns the parsed aggregate report.
    """
    args = [remote_root, "" if now is None else str(int(now))]
    proc = subprocess.run(
        remote_python_command(host, args),
        input=REMOTE_ARCHIVE_CENSUS_SCRIPT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ssh archive-census {host} failed rc={proc.returncode}")
    try:
        report = json.loads(proc.stdout.strip() or "{}")
    except ValueError:
        raise RuntimeError(f"ssh archive-census {host} returned unparseable output") from None
    if not isinstance(report, dict):
        raise RuntimeError(f"ssh archive-census {host} returned a non-object report")
    return report


def remote_writefail_ack(host: str, claim: str, remote_root: str, action: str, timeout: int) -> str:
    proc = subprocess.run(
        remote_python_command(host, [claim, remote_root, action]),
        input=REMOTE_WRITEFAIL_ACK_SCRIPT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ssh writefail ack {host} failed rc={proc.returncode}: {proc.stderr.strip()[:500]}")
    return proc.stdout.strip()


def remote_writefail_ack_degraded(path: str) -> bool:
    normalized = path.replace("\\", "/")
    return "/bot-errors-writefail-relayed/" in normalized or "/bot-errors-writefail-relayed-" in normalized


def writefail_ack_identity(remote: str, record: dict[str, Any]) -> tuple[str, str]:
    payload_sha256 = writefail_poison_hash(record)
    key = hashlib.sha256(f"{remote}\0{payload_sha256}".encode("utf-8")).hexdigest()
    return key, payload_sha256


def writefail_ack_failure_bucket(state: dict[str, Any]) -> dict[str, Any]:
    bucket = state.setdefault("writefailAckFailures", {})
    if not isinstance(bucket, dict):
        bucket = {}
        state["writefailAckFailures"] = bucket
    return bucket


def clear_writefail_ack_failure(remote: str, record: dict[str, Any], state: dict[str, Any]) -> None:
    key, payload_sha256 = writefail_ack_identity(remote, record)
    bucket = writefail_ack_failure_bucket(state)
    removed = bucket.pop(key, None)
    if removed is not None:
        append_log({
            "type": "writefail_ack_failure_cleared",
            "remote": remote,
            "payloadSha256": payload_sha256,
            "remoteClaim": record.get("claim"),
        })
        if not bucket:
            # All remote writefail ack failures cleared — emit idempotent
            # recovery outbox event (#2405). No-op if no incident exists.
            _emit_collector_outbox_event(
                remote,
                "remote-writefail-ack-failed",
                "observation",
                "info",
                f"remote writefail ack recovered: {remote}",
                redact_collector_text(f"remote={remote} writefail_ack_all_cleared=true"),
                "writefail_ack_recovered",
            )


def enqueue_writefail_ack_failure(
    remote: str,
    remote_root: str,
    record: dict[str, Any],
    status: str,
    local_path: Path,
    error: Exception,
    state: dict[str, Any],
    cooldown: int,
) -> None:
    current = int(time.time())
    key, payload_sha256 = writefail_ack_identity(remote, record)
    bucket = writefail_ack_failure_bucket(state)
    existing = bucket.get(key)
    entry = existing if isinstance(existing, dict) else {}
    first_failure = not entry
    last_alert = int(entry.get("lastAlertAt") or 0)
    should_alert = first_failure or not last_alert or current - last_alert >= cooldown
    entry.update({
        "remote": remote,
        "remoteRoot": remote_root,
        "payloadSha256": payload_sha256,
        "remoteClaim": record.get("claim"),
        "remoteName": record.get("name"),
        "sourceDir": record.get("sourceDir"),
        "status": status,
        "localPath": str(local_path),
        "lastError": redact_collector_text(error),
        "lastSeenAt": current,
        "lastSeenIso": now_iso(),
        "seenCount": int(entry.get("seenCount") or 0) + 1,
    })
    if first_failure:
        entry["firstFailedAt"] = current
        entry["firstFailedIso"] = now_iso()
        entry["suppressedCount"] = 0
    if should_alert:
        event_id = f"collector-{safe_segment(remote)}-remote-writefail-ack-failed-{payload_sha256[:16]}-{current}"
        evidence = redact_collector_text("\n".join([
            f"remote={remote}",
            f"remote_root={remote_root}",
            f"remote_claim={record.get('claim')}",
            f"remote_name={record.get('name')}",
            f"source_dir={record.get('sourceDir')}",
            f"writefail_status={status}",
            f"payload_sha256={payload_sha256}",
            f"local_path={local_path}",
            f"error={error}",
            f"alert_path=normal_outbox",
            f"terminal_ack_dirs_are_not_used_for_this_meta_alert=true",
            f"collector_log={state_root() / 'logs/collector.jsonl'}",
        ]))
        event = {
            **new_event_fields("alert", "critical"),
            "id": event_id,
            "createdAt": now_iso(),
            "machine": socket.gethostname(),
            "platform": sys.platform,
            "instance": "bot-errors-collector",
            "source": "remote-writefail-ack-failed",
            "summary": f"BOT ERRORS collector cannot terminal-ack remote writefail: {remote}",
            "evidence": evidence,
            "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
            "diagnostics": {
                "queue": str(state_root() / "outbox"),
                "logHints": [str(state_root() / "logs/collector.jsonl")],
                "collectorLog": str(state_root() / "logs/collector.jsonl"),
                "remote": remote,
                "remoteClaim": record.get("claim"),
                "payloadSha256": payload_sha256,
            },
            "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
        }
        path = local_outbox_path(event, "collector")
        target = _durable_target(path)
        absent = JsonVersion(False, None, None, None)
        publication_operation = operation_id(
            target,
            event,
            component="collector.writefail_ack_failure",
            predecessor=absent,
        )
        publication = publish_event_json(
            target,
            event,
            component="collector.writefail_ack_failure",
            operation_id=publication_operation,
        )
        require_advance(publication)
        entry["lastAlertAt"] = current
        entry["lastAlertIso"] = event["createdAt"]
        entry["suppressedCount"] = 0
        append_log({
            "type": "writefail_ack_failure_alerted",
            "remote": remote,
            "payloadSha256": payload_sha256,
            "remoteClaim": record.get("claim"),
            "eventId": event_id,
            "error": str(error),
        })
    else:
        entry["suppressedCount"] = int(entry.get("suppressedCount") or 0) + 1
        append_log({
            "type": "writefail_ack_failure_suppressed",
            "remote": remote,
            "payloadSha256": payload_sha256,
            "remoteClaim": record.get("claim"),
            "suppressedCount": entry["suppressedCount"],
            "error": str(error),
        })
    bucket[key] = entry


def local_outbox_path(event: dict[str, Any], remote_host: str) -> Path:
    outbox = Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", state_root() / "outbox"))
    created = str(event.get("createdAt") or now_iso()).replace("-", "").replace(":", "")
    event_id = str(event.get("id") or idless_event_filename_token(event, remote_host))
    filename = ".".join([
        created,
        f"relay-{safe_segment(remote_host)}",
        safe_segment(str(event.get("instance") or "unknown")),
        safe_segment(str(event.get("source") or "unknown")),
        safe_segment(event_id),
        "json",
    ])
    return safe_child_path(outbox, filename)


def idless_event_filename_token(event: dict[str, Any], remote_host: str) -> str:
    """Filename token for an event without a stable id.

    #2427: the remote-relay path can no longer reach this — relay_event's
    identity ingress gate quarantines id-less remote events before
    local_outbox_path runs. The remaining callers are LOCAL collector-authored
    writers (meta alerts, storm summaries): single-write, no acknowledgement
    retry, so the fresh nanosecond token cannot cause retry-convergence
    duplicates there.
    """
    try:
        payload = json.dumps(event, sort_keys=True, separators=(",", ":"), default=str)
    except Exception:
        payload = str(event)
    digest = hashlib.sha256(f"{remote_host}\0{payload}".encode("utf-8", errors="replace")).hexdigest()[:16]
    return f"idless-{digest}-{time.time_ns()}"


def local_record_event_identity(path: Path) -> tuple[str | None, str]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None, ""
    if not isinstance(loaded, dict):
        return None, ""
    if isinstance(loaded.get("id"), str):
        return loaded["id"], str(loaded.get("createdAt") or "")
    event = loaded.get("event")
    if isinstance(event, dict) and isinstance(event.get("id"), str):
        return event["id"], str(event.get("createdAt") or "")
    return None, ""


# #2427: the single source of truth for every LOCAL directory that can hold
# an authoritative per-event lifecycle record. local_event_exists derives its
# scan candidates from this tuple (plus the env-aware outbox entry), and the
# matrix guard (tests/test_bot_errors_collector_terminal_inventory_matrix.py)
# cross-checks it against dispatcher state_paths() so a dispatcher-side
# directory addition can no longer silently escape dedupe coverage (the
# dead-letter and testleak resurrection defects). The identity parser
# (local_record_event_identity) covers both record shapes: raw event files
# (top-level id) and nested terminal wrappers ({"event": {...}}).
#
# Deliberately NOT here: the acknowledged-claim archive relayed/ lives on the
# REMOTE host (REMOTE_ACK_SCRIPT moves claims under the remote root), so no
# local scan can cover it — the ack-retry reconciliation remainder of #2427
# owns that surface. Dispatcher dirs without per-event records (locks, logs,
# storm-manifests, state files) carry documented exemptions in the matrix.
LOCAL_EVENT_LIFECYCLE_DIR_NAMES = (
    "processing",
    "sent",
    "storm-collapsed",
    "suppressed",
    "quarantine",
    "testleak",
    "writefail",
    "writefail-recovered",
    "writefail-quarantine",
    "dead-letter",
)


def local_event_candidate_dirs() -> list[Path]:
    root = state_root()
    return [
        Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox")),
        *(root / name for name in LOCAL_EVENT_LIFECYCLE_DIR_NAMES),
    ]


def local_event_exists(event_id: str, created_at: str = "") -> bool:
    if not event_id:
        return False
    candidates = local_event_candidate_dirs()
    seen: set[Path] = set()
    for directory in candidates:
        try:
            key = directory.resolve()
        except OSError:
            key = directory
        if key in seen:
            continue
        seen.add(key)
        if not directory.exists():
            continue
        for path in directory.glob("*"):
            if not path.is_file():
                continue
            existing_id, existing_created_at = local_record_event_identity(path)
            if existing_id == event_id and (not created_at or not existing_created_at or existing_created_at == created_at):
                return True
    return False


def safe_child_path(directory: Path, name: str) -> Path:
    ensure_private_dir(directory)
    target = directory / safe_filename(name)
    if target.resolve().parent != directory.resolve():
        raise RuntimeError(f"unsafe child path escaped {directory}: {name}")
    if target.exists():
        stem = safe_filename(name, 140)
        prefix = f"{int(time.time())}.{os.getpid()}"
        for counter in range(1000):
            target = directory / f"{prefix}.{counter}.{stem}"
            if target.resolve().parent != directory.resolve():
                raise RuntimeError(f"unsafe child path escaped {directory}: {name}")
            if not target.exists():
                return target
        raise RuntimeError(f"no available child path in {directory}: {name}")
    return target


def local_writefail_path(remote_host: str, event_id: str) -> Path:
    stamp = now_iso().replace("-", "").replace(":", "")
    name = f"{stamp}.harvest-{safe_segment(remote_host)}.{safe_segment(event_id)}.writefail"
    return safe_child_path(state_root() / "writefail", name)


def writefail_poison_hash(record: dict[str, Any]) -> str:
    payload = str(record.get("payload") or "")
    return hashlib.sha256(payload.encode("utf-8", errors="replace")).hexdigest()


def existing_harvest_quarantine(remote_host: str, remote_root: str, record: dict[str, Any], payload_sha256: str) -> Path | None:
    directory = state_root() / "writefail-harvest-quarantine"
    if not directory.exists():
        return None
    remote_claim = str(record.get("claim") or "")
    for path in sorted(directory.glob("*.poison")):
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(loaded, dict):
            continue
        if loaded.get("remoteHost") != remote_host or loaded.get("remoteRoot") != remote_root:
            continue
        if loaded.get("payloadSha256") == payload_sha256:
            return path
        if remote_claim and "payloadSha256" not in loaded and loaded.get("remoteClaim") == remote_claim:
            return path
    return None


def local_writefail_quarantine_path(remote_host: str, record: dict[str, Any], payload_sha256: str) -> Path:
    directory = state_root() / "writefail-harvest-quarantine"
    name = (
        f"harvest-{safe_segment(remote_host)}."
        f"{payload_sha256[:24]}."
        f"{safe_segment(str(record.get('name') or 'poison'))}.poison"
    )
    return safe_child_path(directory, name)


def write_harvest_quarantine(remote_host: str, remote_root: str, record: dict[str, Any], reason: str) -> Path:
    payload_text = redact_collector_text(record.get("payload") or "")
    payload_sha256 = writefail_poison_hash(record)
    existing = existing_harvest_quarantine(remote_host, remote_root, record, payload_sha256)
    if existing is not None:
        return existing
    path = local_writefail_quarantine_path(remote_host, record, payload_sha256)
    payload = {
        "schemaVersion": 1,
        "kind": "writefail_harvest_poison",
        "remoteHost": remote_host,
        "remoteRoot": remote_root,
        "remoteClaim": record.get("claim"),
        "remoteName": record.get("name"),
        "sourceDir": record.get("sourceDir"),
        "reason": redact_collector_text(reason),
        "payloadSha256": payload_sha256,
        "payload": payload_text[:20000],
        "quarantinedAt": now_iso(),
    }
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        payload,
        component="collector.harvest_quarantine",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        payload,
        component="collector.harvest_quarantine",
        operation_id=publication_operation,
    )
    require_advance(publication)
    return path


def relay_writefail(remote_host: str, remote_root: str, record: dict[str, Any]) -> tuple[Path, str]:
    try:
        crumb = json.loads(record["payload"])
    except Exception as exc:
        path = write_harvest_quarantine(remote_host, remote_root, record, f"invalid JSON: {exc}")
        append_log({"type": "harvest_poison", "remote": remote_host, "path": str(path), "reason": str(exc)})
        return path, "poison"
    if not isinstance(crumb, dict):
        path = write_harvest_quarantine(remote_host, remote_root, record, "breadcrumb root is not an object")
        append_log({"type": "harvest_poison", "remote": remote_host, "path": str(path), "reason": "root"})
        return path, "poison"
    event = crumb.get("event")
    if crumb.get("kind") != "outbox_write_failure" or not isinstance(event, dict) or not isinstance(event.get("id"), str) or not event.get("id"):
        # #2427: an EMPTY nested id is poison too — it would flow through
        # local_event_exists('') and the idless fallback into the same
        # non-convergent retry path the ordinary-relay ingress gate rejects.
        path = write_harvest_quarantine(remote_host, remote_root, record, "missing outbox_write_failure event.id")
        append_log({"type": "harvest_poison", "remote": remote_host, "path": str(path), "reason": "schema"})
        return path, "poison"
    event_id = str(event["id"])
    if local_event_exists(event_id, str(event.get("createdAt") or "")):
        # Before writing to writefail-recovered, check if another collector
        # already holds a claim on this event. If so, skip the recovery to
        # prevent duplicate deliveries (#2440).
        claims_dir = state_root() / "relay-writefail-processing"
        if claims_dir.exists():
            for f in claims_dir.glob("*.relay-writefail"):
                if event_id in f.name:
                    append_log({
                        "type": "writefail_duplicate_already_claimed",
                        "remote": remote_host,
                        "eventId": event_id,
                    })
                    return state_root() / "writefail-recovered" / f"existing-{safe_segment(event_id)}", "skipped_already_claimed"
        append_log({
            "type": "writefail_duplicate_already_local",
            "remote": remote_host,
            "eventId": event_id,
            "remoteClaim": record.get("claim"),
        })
        return state_root() / "writefail-recovered" / f"existing-{safe_segment(event_id)}", "duplicate"
    crumb = redacted_collector_payload(crumb)
    crumb["harvest"] = {
        "fromHost": remote_host,
        "fromRoot": remote_root,
        "fromDir": record.get("sourceDir"),
        "sourceDurability": record.get("sourceDurability") or "unknown",
        "sourceDurabilityReason": record.get("sourceDurabilityReason") or "missing",
        "remoteClaim": record.get("claim"),
        "remoteName": record.get("name"),
        "collectorHost": socket.gethostname(),
        "harvestedAt": now_iso(),
    }
    path = local_writefail_path(remote_host, event_id)
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        crumb,
        component="collector.relay_writefail",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        crumb,
        component="collector.relay_writefail",
        operation_id=publication_operation,
    )
    require_advance(publication)
    append_log({
        "type": "writefail_harvested",
        "remote": remote_host,
        "eventId": event_id,
        "remoteClaim": record.get("claim"),
        "localPath": str(path),
    })
    return path, "harvested"


def relay_event(remote_host: str, remote_root: str, record: dict[str, Any]) -> Path:
    event = json.loads(record["payload"])
    if not isinstance(event, dict):
        raise ValueError("remote event root must be an object")
    # #2427 identity ingress gate: without a stable nonempty string id,
    # local_event_exists('') can never converge acknowledgement retries and
    # the idless filename fallback mints a fresh identity per write — every
    # reoffer would create another outbox copy with a reset delivery budget.
    # Reject-and-ack: quarantine via the payload-sha-keyed harvest surface
    # (idempotent across retries) and return like the duplicate path so the
    # caller acknowledges the claim and it cannot lease-loop.
    raw_id = event.get("id")
    if not isinstance(raw_id, str) or not raw_id:
        path = write_harvest_quarantine(remote_host, remote_root, record, "missing or empty event id")
        append_log({"type": "harvest_poison", "remote": remote_host, "path": str(path), "reason": "identity"})
        return path
    event_id = raw_id
    if local_event_exists(event_id, str(event.get("createdAt") or "")):
        append_log({"type": "duplicate_already_local", "remote": remote_host, "eventId": event_id, "remoteClaim": record["claim"]})
        return state_root() / "sent" / f"existing-{safe_segment(event_id)}"
    diagnostics = event.setdefault("diagnostics", {})
    if not isinstance(diagnostics, dict):
        diagnostics = {}
        event["diagnostics"] = diagnostics
    diagnostics["relay"] = {
        "remoteHost": remote_host,
        "remoteRoot": remote_root,
        "remoteClaim": record["claim"],
        "remoteName": record["name"],
        "collectorHost": socket.gethostname(),
        "collectedAt": now_iso(),
    }
    diagnostics["relayLog"] = str(state_root() / "logs/collector.jsonl")
    diagnostics["remoteQueue"] = str(Path(remote_root) / "outbox")
    diagnostics["queue"] = str(state_root() / "outbox")
    log_hints = diagnostics.get("logHints")
    if isinstance(log_hints, list):
        log_hints.append(str(state_root() / "logs/collector.jsonl"))
    else:
        diagnostics["logHints"] = [str(state_root() / "logs/collector.jsonl")]
    event["delivery"] = {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None}
    event = redacted_collector_payload(event)
    path = local_outbox_path(event, remote_host)
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        event,
        component="collector.relay_event",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        event,
        component="collector.relay_event",
        operation_id=publication_operation,
    )
    require_advance(publication)
    return path


def _emit_collector_outbox_event(
    remote: str,
    source: str,
    event_type: str,
    severity: str,
    summary: str,
    evidence: str,
    log_type: str,
    extra_diagnostics: dict[str, Any] | None = None,
) -> str:
    """Shared low-level constructor for collector-minted outbox events (ENTRY/EXIT
    only). Used by both emit_relay_host_state_event (relay_host_down/recovered)
    and emit_collector_capture_escalation_event (collector_remote_unreachable) --
    extracted during HD-11b review to close a DRY gap AND fix an id-truncation
    collision (below) in both emitters at once, rather than fixing it in one and
    leaving the other's copy stale. Writes via atomic_write_json directly, NOT
    through enqueue_meta_alert, so these unconditional state transitions emit
    with no cooldown gate and contribute no open-alert tracking.

    instance="bot-errors-collector" + diagnostics.remote are load-bearing:
    dispatcher.py's incident_source() qualifies collector-minted events by
    diagnostics.remote precisely when instance == "bot-errors-collector" --
    that is what keeps per-remote incidents (e.g. two different unreachable
    remotes, or a remote's down-state vs a DIFFERENT remote's) on separate
    incident keys instead of colliding. Both fields are set unconditionally
    here so no caller can accidentally omit them.

    id ordering (time_ns/pid first, event_type + remote last) is deliberate,
    not cosmetic (found + RED-proven during HD-11b): local_outbox_path()
    truncates this id via safe_segment() at 80 chars and sorts outbox
    filenames lexicographically on the resulting name. A long remote
    ("host:/long/path") embedded before the numeric suffix can truncate away
    the very fields that make two events distinguishable -- two genuinely
    different events for the same remote would then collide on an identical
    filename and the second atomic_write_json silently overwrites the first
    (event loss). A text field (event_type: "alert"/"clear") sorting before
    the numeric time_ns also breaks filename-order-as-emission-order for two
    events sharing source/instance/created (same real-world second). Putting
    time_ns/pid first and the remote last means truncation can only ever
    clip the least-important trailing text.

    Returns the event id.
    """
    host, _remote_root = parse_remote(remote)
    diagnostics: dict[str, Any] = {
        "remote": remote,
        "host": host,
        "queue": str(state_root() / "outbox"),
        "logHints": [str(state_root() / "logs/collector.jsonl")],
        "collectorLog": str(state_root() / "logs/collector.jsonl"),
    }
    if extra_diagnostics:
        diagnostics.update(extra_diagnostics)
    event_id = f"collector-{time.time_ns()}-{os.getpid()}-{event_type}-{safe_segment(remote)}"
    envelope_event_type = "observation" if event_type == "alert" and severity == "info" else event_type
    event = {
        **new_event_fields(envelope_event_type, severity),
        "id": event_id,
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-collector",
        "source": source,
        "summary": summary,
        "evidence": redact_collector_text(evidence),
        "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
        "diagnostics": diagnostics,
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    path = local_outbox_path(event, "collector")
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        event,
        component="collector.local_outbox_event",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        event,
        component="collector.local_outbox_event",
        operation_id=publication_operation,
    )
    require_advance(publication)
    append_log({
        "type": log_type,
        "remote": remote,
        "eventId": event_id,
        "evidence": redact_collector_text(evidence),
    })
    return event_id


def emit_relay_host_state_event(remote: str, kind: str, evidence: str, state: dict[str, Any], best_effort: bool = False) -> None:
    """Write a relay_host_down or relay_host_recovered outbox event (ENTRY/EXIT only).

    Delegates envelope construction to _emit_collector_outbox_event (shared
    with emit_collector_capture_escalation_event).
    """
    # Pattern I: a best-effort host going down is expected, not a crash — info, not a page.
    if kind == "relay_host_down" and not (best_effort and best_effort_info_tier_enabled()):
        severity = "warning"
    else:
        severity = "info"
    # #2419: recovery is a typed SAME-SOURCE clear. Incident identity includes
    # the exact source (dispatcher incident_key), so an event_type="clear" that
    # carried source="relay_host_recovered" would key onto an incident that is
    # never open and be suppressed as a stale recovery, leaving the paired
    # relay_host_down record open forever. The clear must carry the DOWN source;
    # the recovered kind survives in the summary and collector log_type.
    event_type = "clear" if kind == "relay_host_recovered" else "alert"
    source = relay_host_state_source(kind)
    _emit_collector_outbox_event(
        remote,
        source=source,
        event_type=event_type,
        severity=severity,
        summary=f"BOT ERRORS collector relay host {kind.replace('_', ' ')}: {remote}",
        evidence=evidence,
        log_type=kind,
    )


def emit_collector_capture_escalation_event(
    remote: str,
    event_type: str,
    *,
    consecutive_failures: int | None = None,
    threshold: int | None = None,
    error_class: str | None = None,
    last_error: str | None = None,
    last_success_age_seconds: int | None = None,
    reachability_diagnosis_value: str | None = None,
) -> None:
    """Write a collector_remote_unreachable alert/clear outbox event (ENTRY/EXIT only).

    Delegates envelope construction to _emit_collector_outbox_event (shared
    with emit_relay_host_state_event), but is a genuinely distinct,
    independently-tunable signal: default threshold=2
    (BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD) fires earlier than
    RELAY_BACKOFF_FAILURE_THRESHOLD=3's relay_host_down, and — unlike
    relay_host_down/relay_host_recovered, which both use eventType="alert" —
    emits a real eventType="clear" on recovery so the dispatcher's standard
    clear-pop path (mark_incident_sent) closes the incident directly.
    """
    _, remote_root = parse_remote(remote)
    severity = "warning" if event_type == "alert" else "info"
    redacted_last_error = (
        redact_collector_text(last_error)[:FAILURE_RETENTION_DETAIL_MAX_CHARS] if last_error else None
    )
    evidence_parts = [f"remote={remote}"]
    if consecutive_failures is not None:
        evidence_parts.append(f"consecutive_failures={consecutive_failures}")
    if threshold is not None:
        evidence_parts.append(f"threshold={threshold}")
    if error_class:
        evidence_parts.append(f"error_class={error_class}")
    evidence_parts.append(
        f"last_success_age_seconds={last_success_age_seconds if last_success_age_seconds is not None else 'never'}"
    )
    if redacted_last_error:
        evidence_parts.append(f"last_error={redacted_last_error}")
    if reachability_diagnosis_value:
        evidence_parts.append(f"reachability_diagnosis={reachability_diagnosis_value}")
    evidence_parts.append(f"collector_log={state_root() / 'logs/collector.jsonl'}")
    evidence = "\n".join(evidence_parts)
    extra_diagnostics: dict[str, Any] = {
        "remoteRoot": remote_root,
        # Always present (possibly null) so a reader never has to distinguish
        # "never succeeded" from "field omitted".
        "consecutiveFailures": consecutive_failures,
        "thresholdConfigured": threshold,
        "errorClass": error_class,
        "lastSuccessAgeSeconds": last_success_age_seconds,
    }
    if reachability_diagnosis_value:
        extra_diagnostics["reachabilityDiagnosis"] = reachability_diagnosis_value
    _emit_collector_outbox_event(
        remote,
        source=COLLECTOR_CAPTURE_ESCALATION_SOURCE,
        event_type=event_type,
        severity=severity,
        summary=(
            f"BOT ERRORS collector cannot capture remote outbox: {remote}"
            if event_type == "alert"
            else f"BOT ERRORS collector remote capture recovered: {remote}"
        ),
        evidence=evidence,
        log_type=f"{COLLECTOR_CAPTURE_ESCALATION_SOURCE}_{event_type}",
        extra_diagnostics=extra_diagnostics,
    )


@controller_cycle(
    CONTROLLER_LOG_CONTEXT,
    lambda kind, details, level, outcome: append_log(
        {"type": kind, **details},
        level=level,
        outcome=outcome,
    ),
)
def run_once(
    remotes: list[str],
    best_effort_remotes: set[str],
    max_events: int,
    timeout: int,
    lease_seconds: int,
    remote_sla: int,
    alert_cooldown: int,
    recovery_successes: int,
) -> dict[str, Any]:
    # The state session opens before any remote/probe/claim/ack/outbox
    # effect; recovery_required must escape with zero domain side effects.
    try:
        session = open_collector_state_session()
    except ControllerStateRequired as exc:
        project_collector_state_mode(exc.diagnostic)
        raise
    try:
        state, capability = _load_collector_state_for_cycle(session)
        return _run_once_with_state(
            session,
            state,
            capability,
            remotes,
            best_effort_remotes,
            max_events,
            timeout,
            lease_seconds,
            remote_sla,
            alert_cooldown,
            recovery_successes,
        )
    finally:
        session.close()


def _run_once_with_state(
    session: Any,
    state: dict[str, Any],
    capability: Any,
    remotes: list[str],
    best_effort_remotes: set[str],
    max_events: int,
    timeout: int,
    lease_seconds: int,
    remote_sla: int,
    alert_cooldown: int,
    recovery_successes: int,
) -> dict[str, Any]:
    reset_tailscale_cache()
    state["configuredRemotes"] = list(remotes)
    state["configuredRemoteHosts"] = configured_remote_hosts(remotes)
    state["configuredBestEffortRemotes"] = sorted(best_effort_remotes)
    state["configuredBestEffortRemoteHosts"] = configured_remote_hosts(sorted(best_effort_remotes))
    state["updatedAt"] = now_iso()
    prune_state_to_configured_remotes(state, remotes)
    remote_state = state.setdefault("remotes", {})
    processed = 0
    writefail_harvested = 0
    writefail_duplicates = 0
    writefail_poison = 0
    writefail_nondurable = 0
    remotes_succeeded = 0
    isolated_failures = 0
    best_effort_failures = 0
    best_effort_isolated_failures = 0
    hard_remotes_succeeded = 0
    failed = 0
    remotes_skipped_backoff = 0
    for remote in remotes:
        host, remote_root = parse_remote(remote)
        is_best_effort = remote in best_effort_remotes or host in best_effort_remotes
        outbox_claim_failed = False
        outbox_claim_succeeded = False
        outbox_relay_failed = False
        writefail_claim_failed = False
        skip_writefail_claim = False

        # --- Dead-host backoff guard ---
        # Read persisted backoff fields (all default-zero on first cycle).
        remote_record_pre = remote_state.setdefault(remote, {})
        consecutive_failures_pre = int(remote_record_pre.get("consecutiveFailures") or 0)
        next_attempt_at = int(remote_record_pre.get("nextAttemptAt") or 0)
        is_host_down = consecutive_failures_pre >= RELAY_BACKOFF_FAILURE_THRESHOLD
        now_epoch = int(time.time())
        if is_host_down and now_epoch < next_attempt_at:
            # Inside backoff window: skip SSH entirely, do not count as failure.
            remotes_skipped_backoff += 1
            append_log({
                "type": "remote_skipped_backoff",
                "remote": remote,
                "consecutiveFailures": consecutive_failures_pre,
                "nextAttemptAt": next_attempt_at,
                "secondsRemaining": next_attempt_at - now_epoch,
            })
            continue
        # Window has expired (or host not yet down): attempt SSH.

        try:
            records = ssh_json_lines(host, REMOTE_CLAIM_SCRIPT, [remote_root, str(max_events), str(lease_seconds)], timeout)
            outbox_claim_succeeded = True
        except Exception as exc:  # noqa: BLE001 - collector must keep other remotes alive.
            failed += 1
            isolated_failures += 1
            if is_best_effort:
                best_effort_failures += 1
                best_effort_isolated_failures += 1
            error = str(exc)
            outbox_claim_failed = True
            reachability_lines, reachability_diagnostics = remote_failure_context(host, error)
            remote_record = remote_state.setdefault(remote, {})
            remote_record["consecutiveSuccesses"] = 0
            remote_record["outboxRecoveryConsecutiveSuccesses"] = 0
            remote_record["lastError"] = error
            remote_record["lastFailureAt"] = int(time.time())
            remote_record["lastFailureIso"] = now_iso()
            update_failure_retention(remote_record, exc, error)
            if reachability_diagnostics:
                remote_record["lastReachability"] = reachability_diagnostics
                skip_writefail_claim = skip_writefail_after_outbox_failure(reachability_diagnostics)
            # Update consecutive-failure counter and backoff schedule.
            new_consecutive_failures = consecutive_failures_pre + 1
            remote_record["consecutiveFailures"] = new_consecutive_failures
            # --- HD-11b capture-failure escalation ladder ---
            # Three tiers, each SUPERSEDING the prior (boterr-lead ruling,
            # HD-11b battery 4, extending relay_host_down's own
            # "replaces per-attempt alerts" precedent one level down):
            #   tier 1: remote-claim-failed (cooldown-gated generic meta-alert)
            #   tier 2: collector_remote_unreachable (this packet)
            #   tier 3: relay_host_down (backoff schedule entry)
            # Exactly one open incident per remote at a time: crossing a
            # tier's threshold ACTIVELY CLOSES the previous tier's open
            # incident (enqueue_meta_recovery / a typed clear) before opening
            # the new one -- not just suppressing future re-emission of the
            # old tier, which would leave it open at the dispatcher.
            #
            # This MUST be a single mutually-exclusive ladder keyed on which
            # zone new_consecutive_failures falls in (tier 3 checked FIRST,
            # unconditionally) -- not two independent "if threshold crossed"
            # checks. A remote already at/past RELAY_BACKOFF_FAILURE_THRESHOLD
            # that fails again on a LATER cycle (after the backoff window
            # expires) still has new_consecutive_failures >= escalate_threshold
            # every time; an independent tier-2 check would reopen tier 2 on
            # that later cycle (captureFailureEscalated was already reset when
            # tier 3 first opened) without ever reclosing it, since tier 3's
            # own close-tier-2 step only runs on `not is_host_down` (first
            # entry). Caught + RED-proven during HD-11b battery 4 review.
            escalate_threshold = collector_failure_escalate_threshold()
            if new_consecutive_failures >= RELAY_BACKOFF_FAILURE_THRESHOLD:
                # Advance backoff schedule index (cap at last entry).
                schedule_index_old = int(remote_record.get("backoffScheduleIndex") or 0)
                if is_host_down:
                    # Already down: move to next schedule step.
                    schedule_index_new = min(schedule_index_old + 1, len(RELAY_BACKOFF_SCHEDULE_S) - 1)
                else:
                    # First crossing of threshold: start at index 0.
                    schedule_index_new = 0
                remote_record["backoffScheduleIndex"] = schedule_index_new
                remote_record["nextAttemptAt"] = int(time.time()) + RELAY_BACKOFF_SCHEDULE_S[schedule_index_new]
                if not is_host_down:
                    # First entry into down state: close tier 2 if open --
                    # tier 3 now covers this remote's failure with the
                    # strongest signal. No-op if escalate_threshold >=
                    # RELAY_BACKOFF_FAILURE_THRESHOLD (tier 2 never opened).
                    if remote_record.get("captureFailureEscalated"):
                        remote_record["captureFailureEscalated"] = False
                        prior_error_class = str((remote_record.get("failureRetention") or {}).get("failureClass") or "")
                        emit_collector_capture_escalation_event(
                            remote,
                            "clear",
                            consecutive_failures=new_consecutive_failures,
                            threshold=escalate_threshold,
                            error_class=prior_error_class or None,
                            last_success_age_seconds=None,
                        )
                    # Then record downSince and emit event.
                    remote_record["downSince"] = int(time.time())
                    remote_record["downEventEmitted"] = True
                    emit_relay_host_state_event(
                        remote,
                        "relay_host_down",
                        (
                            f"remote={remote}\n"
                            f"consecutive_failures={new_consecutive_failures}\n"
                            f"threshold={RELAY_BACKOFF_FAILURE_THRESHOLD}\n"
                            f"error={error}\n"
                            f"next_attempt_delay_s={RELAY_BACKOFF_SCHEDULE_S[schedule_index_new]}\n"
                            f"collector_log={state_root() / 'logs/collector.jsonl'}"
                        ),
                        state,
                        best_effort=is_best_effort,
                    )
                # While host is in down state (including subsequent cycles
                # after the backoff window expires and re-fails), do NOT fire
                # per-attempt meta-alerts OR reopen tier 2. The relay_host_down
                # event replaces them for the whole down episode.
            elif new_consecutive_failures >= escalate_threshold:
                if not remote_record.get("captureFailureEscalated"):
                    remote_record["captureFailureEscalated"] = True
                    # Close tier 1 if open -- tier 2 now covers this remote's
                    # failure with a stronger, more specific signal. No-op
                    # (enqueue_meta_recovery returns immediately) if tier 1
                    # never opened, e.g. escalate_threshold=1.
                    enqueue_meta_recovery(
                        remote,
                        "remote-claim-failed",
                        f"BOT ERRORS collector remote-claim alert superseded by escalation: {remote}",
                        f"remote={remote}\nsuperseded_by=collector_remote_unreachable\ncollector_log={state_root() / 'logs/collector.jsonl'}",
                        state,
                    )
                    last_success_at = remote_record.get("lastSuccessAt")
                    last_success_age = int(time.time()) - int(last_success_at) if last_success_at else None
                    failure_class = str((remote_record.get("failureRetention") or {}).get("failureClass") or "")
                    emit_collector_capture_escalation_event(
                        remote,
                        "alert",
                        consecutive_failures=new_consecutive_failures,
                        threshold=escalate_threshold,
                        error_class=failure_class or None,
                        last_error=error,
                        last_success_age_seconds=last_success_age,
                        reachability_diagnosis_value=(reachability_diagnostics or {}).get("reachabilityDiagnosis"),
                    )
                else:
                    # Escalated (tier 2 open) but not yet backed off: the
                    # escalation event already covers this failure -- do not
                    # ALSO fire the generic per-attempt alert (tier 1). This
                    # is what keeps exactly one open incident per remote at a
                    # time; enqueue_meta_alert's own cooldown/open-incident
                    # tracking is bypassed entirely rather than relied on,
                    # since it has no notion of the escalation tier.
                    append_log({
                        "type": "remote_claim_failed_suppressed_escalated",
                        "remote": remote,
                        "error": error,
                        "reachability": reachability_diagnostics,
                    })
            else:
                # Below both thresholds: normal per-attempt alert.
                append_log({
                    "type": "remote_claim_failed",
                    "remote": remote,
                    "error": error,
                    "reachability": reachability_diagnostics,
                })
                enqueue_meta_alert(
                    remote,
                    "remote-claim-failed",
                    f"BOT ERRORS collector cannot claim remote outbox: {remote}",
                    "\n".join([
                        f"remote={remote}",
                        f"remote_root={remote_root}",
                        f"error={error}",
                        *reachability_lines,
                        f"collector_log={state_root() / 'logs/collector.jsonl'}",
                    ]),
                    state,
                    alert_cooldown,
                    reachability_diagnostics,
                    best_effort=is_best_effort,
                )
            records = []

        # --- Backoff recovery keyed on OUTBOX-CLAIM reachability ---
        # The outbox claim is the authoritative host-reachability signal; the
        # writefail harvest below is a secondary best-effort op whose failure must
        # NOT veto recovery (otherwise a half-up host — outbox OK, writefail broken —
        # would stay pinned in down state forever and re-storm via the writefail
        # surface). So clear the backoff/down state here, before the writefail try.
        if outbox_claim_succeeded:
            remote_record = remote_state.setdefault(remote, {})
            # --- HD-11b capture-failure escalation clear ---
            # Independent of the down/backoff recovery gate below (was_down /
            # recovered_from_down / recovery_successes): the escalate threshold
            # (default 2) is lower than RELAY_BACKOFF_FAILURE_THRESHOLD (3), so
            # a remote can be escalated without ever having entered backoff/down
            # state. Clears on the literal next successful claim per contract
            # (not gated by consecutive-success count) -- this is a distinct,
            # earlier-firing signal, so its clear condition is correspondingly
            # simpler than the backoff recovery's N-successes requirement.
            if remote_record.get("captureFailureEscalated"):
                prior_error_class = str((remote_record.get("failureRetention") or {}).get("failureClass") or "")
                emit_collector_capture_escalation_event(
                    remote,
                    "clear",
                    consecutive_failures=0,
                    threshold=collector_failure_escalate_threshold(),
                    error_class=prior_error_class or None,
                    last_success_age_seconds=0,
                )
                remote_record["captureFailureEscalated"] = False
            was_down = bool(remote_record.get("downEventEmitted"))
            outbox_recovery_successes = int(remote_record.get("outboxRecoveryConsecutiveSuccesses") or 0) + 1
            remote_record["outboxRecoveryConsecutiveSuccesses"] = outbox_recovery_successes
            remote_record["outboxRecoverySuccessesRequired"] = recovery_successes
            recovered_from_down = (not was_down) or outbox_recovery_successes >= recovery_successes
            if was_down and not recovered_from_down:
                append_log({
                    "type": "relay_host_recovery_deferred",
                    "remote": remote,
                    "consecutiveSuccesses": outbox_recovery_successes,
                    "requiredSuccesses": recovery_successes,
                })
            if was_down and recovered_from_down:
                emit_relay_host_state_event(
                    remote,
                    "relay_host_recovered",
                    (
                        f"remote={remote}\n"
                        f"down_since={remote_record.get('downSince')}\n"
                        f"prior_consecutive_failures={remote_record.get('consecutiveFailures')}\n"
                        f"outbox_recovery_consecutive_successes={outbox_recovery_successes}\n"
                        f"recovery_successes_required={recovery_successes}\n"
                        f"collector_log={state_root() / 'logs/collector.jsonl'}"
                    ),
                    state,
                )
            if recovered_from_down:
                remote_record["consecutiveFailures"] = 0
                remote_record["backoffScheduleIndex"] = 0
                remote_record["nextAttemptAt"] = None
                remote_record["downSince"] = None
                remote_record["downEventEmitted"] = False
                remote_record["outboxRecoveryConsecutiveSuccesses"] = 0
                remote_record["outboxRecoverySuccessesRequired"] = recovery_successes

        if skip_writefail_claim:
            writefail_records = []
            append_log({
                "type": "remote_writefail_claim_skipped_unreachable",
                "remote": remote,
                "reason": reachability_diagnosis(remote_state.setdefault(remote, {}).get("lastReachability", {})) or "outbox_claim_unreachable",
            })
        else:
            try:
                writefail_records = ssh_json_lines(
                    host,
                    REMOTE_WRITEFAIL_CLAIM_SCRIPT,
                    [remote_root, str(max_events), str(lease_seconds)],
                    timeout,
                )
            except Exception as exc:  # noqa: BLE001 - outbox relay must not be blocked by B6 harvest.
                failed += 1
                if is_best_effort:
                    best_effort_failures += 1
                writefail_claim_failed = True
                if outbox_claim_failed:
                    isolated_failures += 1
                    if is_best_effort:
                        best_effort_isolated_failures += 1
                writefail_records = []
                error = str(exc)
                reachability_lines, reachability_diagnostics = remote_failure_context(host, error)
                remote_record = remote_state.setdefault(remote, {})
                remote_record["consecutiveSuccesses"] = 0
                remote_record["lastError"] = error
                remote_record["lastFailureAt"] = int(time.time())
                remote_record["lastFailureIso"] = now_iso()
                update_failure_retention(remote_record, exc, error)
                if reachability_diagnostics:
                    remote_record["lastReachability"] = reachability_diagnostics
                clear_meta_recovery_progress(state, remote, "remote-claim-failed")
                clear_meta_recovery_progress(state, remote, "remote-drain-stale")
                # Check current down state (may have been updated by outbox claim failure above).
                cur_consecutive_failures = int(remote_record.get("consecutiveFailures") or 0)
                is_now_host_down = cur_consecutive_failures >= RELAY_BACKOFF_FAILURE_THRESHOLD
                append_log({
                    "type": "remote_writefail_claim_failed",
                    "remote": remote,
                    "error": error,
                    "reachability": reachability_diagnostics,
                })
                if not outbox_claim_failed and not is_now_host_down:
                    enqueue_meta_alert(
                        remote,
                        "remote-writefail-harvest-failed",
                        f"BOT ERRORS collector cannot claim remote writefail crumbs: {remote}",
                        "\n".join([
                            f"remote={remote}",
                            f"remote_root={remote_root}",
                            f"error={error}",
                            *reachability_lines,
                            f"collector_log={state_root() / 'logs/collector.jsonl'}",
                        ]),
                        state,
                        alert_cooldown,
                        reachability_diagnostics,
                    )
        if outbox_claim_succeeded and not writefail_claim_failed:
            remotes_succeeded += 1
            if not is_best_effort:
                hard_remotes_succeeded += 1
            remote_record = remote_state.setdefault(remote, {})
            consecutive_successes = int(remote_record.get("consecutiveSuccesses") or 0) + 1
            remote_record["consecutiveSuccesses"] = consecutive_successes
            remote_record["lastSuccessAt"] = int(time.time())
            remote_record["lastSuccessIso"] = now_iso()
            remote_record["lastError"] = None
            record_recovery_retention(remote_record)
            # NOTE: relay_host_recovered emission + backoff-field reset already
            # happened above, keyed on outbox-claim reachability (intentionally
            # decoupled from the writefail harvest). Here we only handle the
            # full-success meta-recovery path.
            recovery_evidence = (
                f"remote={remote}\n"
                f"remote_root={remote_root}\n"
                f"claim_status=success\n"
                f"writefail_claim_status=success\n"
                f"consecutive_successes={consecutive_successes}\n"
                f"recovery_successes_required={recovery_successes}"
            )
            if consecutive_successes >= recovery_successes:
                enqueue_meta_recovery(
                    remote,
                    "remote-claim-failed",
                    f"BOT ERRORS collector remote recovered: {remote}",
                    recovery_evidence,
                    state,
                )
            else:
                defer_meta_recovery(
                    remote,
                    "remote-claim-failed",
                    state,
                    consecutive_successes,
                    recovery_successes,
                    recovery_evidence,
                )
        for record in records:
            # #2427: the local durable write and the remote acknowledgement
            # are separate failure domains. A relay_event failure means the
            # claim was never consumed (requeue is correct); an ack-phase
            # failure AFTER the local write may be pure response loss — the
            # remote may have already archived the claim — so it gets a
            # read-only existence probe before any requeue or alert.
            # (Bounded residual, documented not engineered: a lease expiring
            # DURING the sub-second local publish can hand the claim to a
            # second collector; the durable-publish-before-ack ordering plus
            # dedupe converges the record on the next offer.)
            def _relay_record_failed(exc: Exception) -> None:
                nonlocal outbox_relay_failed, failed, best_effort_failures
                outbox_relay_failed = True
                failed += 1
                if is_best_effort:
                    best_effort_failures += 1
                try:
                    remote_ack(host, str(record["claim"]), remote_root, "requeue", timeout)
                except Exception as ack_exc:  # noqa: BLE001
                    append_log({"type": "remote_requeue_failed", "remote": remote, "claim": record.get("claim"), "error": str(ack_exc)})
                append_log({"type": "relay_failed", "remote": remote, "claim": record.get("claim"), "error": str(exc)})
                enqueue_meta_alert(
                    remote,
                    "remote-relay-failed",
                    f"BOT ERRORS collector cannot relay remote event: {remote}",
                    f"remote={remote}\nremote_root={remote_root}\nremote_name={record.get('name')}\nremote_claim={record.get('claim')}\nerror={exc}\ncollector_log={state_root() / 'logs/collector.jsonl'}",
                    state,
                    alert_cooldown,
                )

            try:
                local_path = relay_event(host, remote_root, record)
            except Exception as exc:  # noqa: BLE001
                _relay_record_failed(exc)
                continue
            try:
                ack_path = remote_ack(host, str(record["claim"]), remote_root, "ack", timeout)
            except Exception as exc:  # noqa: BLE001
                claim_absent = False
                try:
                    claim_absent = not remote_claim_exists(host, str(record["claim"]), timeout)
                except Exception:  # noqa: BLE001
                    # Probe unreachable — indistinguishable from a failed
                    # ack; stay conservative (requeue + alert as before).
                    pass
                if claim_absent:
                    # Claim absent ⇒ either the ack archived it, or lease
                    # recovery already returned it to the remote outbox. In
                    # BOTH cases the local record is durable and any reoffer
                    # dedupes to it, so marking processed is safe — but
                    # absence alone does not prove the ack landed; the
                    # dedupe inventory is the backstop, not a redundancy.
                    append_log({
                        "type": "ack_response_lost_claim_absent",
                        "remote": remote,
                        "remoteClaim": record["claim"],
                        "localPath": str(local_path),
                    })
                    processed += 1
                else:
                    _relay_record_failed(exc)
                continue
            append_log({
                "type": "relayed",
                "remote": remote,
                "remoteClaim": record["claim"],
                "remoteAckPath": ack_path,
                "localPath": str(local_path),
            })
            processed += 1
        if not outbox_claim_failed and not outbox_relay_failed:
            remote_record = remote_state.setdefault(remote, {})
            remote_record["lastDrainAt"] = int(time.time())
            remote_record["lastDrainIso"] = now_iso()
            remote_record["lastDrainError"] = None
            drain_recovery_evidence = f"remote={remote}\nremote_root={remote_root}\noutbox_drain_status=success"
            enqueue_meta_recovery(
                remote,
                "remote-drain-stale",
                f"BOT ERRORS collector remote drain recovered: {remote}",
                drain_recovery_evidence,
                state,
            )
            enqueue_meta_recovery(
                remote,
                "remote-relay-failed",
                f"BOT ERRORS collector remote relay recovered: {remote}",
                f"remote={remote}\nremote_root={remote_root}\nrelay_status=success",
                state,
            )
        for record in writefail_records:
            if str(record.get("sourceDurability") or "") == "non_durable":
                writefail_nondurable += 1
                append_log({
                    "type": "remote_writefail_nondurable_source",
                    "remote": remote,
                    "remoteClaim": record.get("claim"),
                    "sourceDir": record.get("sourceDir"),
                    "sourceDurabilityReason": record.get("sourceDurabilityReason"),
                })
                enqueue_meta_alert(
                    remote,
                    "remote-writefail-nondurable",
                    f"BOT ERRORS collector harvested volatile remote writefail: {remote}",
                    (
                        f"remote={remote}\n"
                        f"remote_root={remote_root}\n"
                        f"source_dir={record.get('sourceDir')}\n"
                        f"source_durability={record.get('sourceDurability')}\n"
                        f"source_durability_reason={record.get('sourceDurabilityReason')}\n"
                        f"remote_name={record.get('name')}\n"
                        f"collector_log={state_root() / 'logs/collector.jsonl'}"
                    ),
                    state,
                    alert_cooldown,
                )
            try:
                local_path, status = relay_writefail(host, remote_root, record)
                if status == "poison":
                    writefail_poison += 1
                    try:
                        ack_path = remote_writefail_ack(host, str(record["claim"]), remote_root, "ack", timeout)
                        append_log({
                            "type": "writefail_harvest_poison_acked",
                            "remote": remote,
                            "remoteClaim": record["claim"],
                            "remoteAckPath": ack_path,
                            "remoteAckDegraded": remote_writefail_ack_degraded(ack_path),
                            "localPath": str(local_path),
                        })
                        clear_writefail_ack_failure(remote, record, state)
                    except Exception as ack_exc:  # noqa: BLE001 - poison is already quarantined locally.
                        failed += 1
                        if is_best_effort:
                            best_effort_failures += 1
                        append_log({
                            "type": "writefail_harvest_poison_ack_failed",
                            "remote": remote,
                            "remoteClaim": record.get("claim"),
                            "localPath": str(local_path),
                            "error": str(ack_exc),
                        })
                        enqueue_writefail_ack_failure(remote, remote_root, record, status, local_path, ack_exc, state, alert_cooldown)
                elif status == "duplicate":
                    writefail_duplicates += 1
                    try:
                        ack_path = remote_writefail_ack(host, str(record["claim"]), remote_root, "ack", timeout)
                        append_log({
                            "type": "writefail_harvest_duplicate_acked",
                            "remote": remote,
                            "remoteClaim": record["claim"],
                            "remoteAckPath": ack_path,
                            "remoteAckDegraded": remote_writefail_ack_degraded(ack_path),
                            "localPath": str(local_path),
                        })
                        clear_writefail_ack_failure(remote, record, state)
                    except Exception as ack_exc:  # noqa: BLE001 - duplicate is already safe locally.
                        failed += 1
                        if is_best_effort:
                            best_effort_failures += 1
                        append_log({
                            "type": "writefail_harvest_duplicate_ack_failed",
                            "remote": remote,
                            "remoteClaim": record.get("claim"),
                            "error": str(ack_exc),
                        })
                        enqueue_writefail_ack_failure(remote, remote_root, record, status, local_path, ack_exc, state, alert_cooldown)
                else:
                    writefail_harvested += 1
                    try:
                        ack_path = remote_writefail_ack(host, str(record["claim"]), remote_root, "ack", timeout)
                        append_log({
                            "type": "writefail_harvest_acked",
                            "remote": remote,
                            "remoteClaim": record["claim"],
                            "remoteAckPath": ack_path,
                            "remoteAckDegraded": remote_writefail_ack_degraded(ack_path),
                            "localPath": str(local_path),
                        })
                        clear_writefail_ack_failure(remote, record, state)
                    except Exception as ack_exc:  # noqa: BLE001 - exact-id dedup makes retry safe.
                        failed += 1
                        if is_best_effort:
                            best_effort_failures += 1
                        append_log({
                            "type": "writefail_harvest_ack_failed",
                            "remote": remote,
                            "remoteClaim": record.get("claim"),
                            "localPath": str(local_path),
                            "error": str(ack_exc),
                        })
                        enqueue_writefail_ack_failure(remote, remote_root, record, status, local_path, ack_exc, state, alert_cooldown)
            except Exception as exc:  # noqa: BLE001
                failed += 1
                if is_best_effort:
                    best_effort_failures += 1
                append_log({"type": "writefail_harvest_failed", "remote": remote, "claim": record.get("claim"), "error": str(exc)})
                enqueue_meta_alert(
                    remote,
                    "remote-writefail-harvest-failed",
                    f"BOT ERRORS collector cannot harvest remote writefail: {remote}",
                    f"remote={remote}\nremote_root={remote_root}\nerror={exc}\ncollector_log={state_root() / 'logs/collector.jsonl'}",
                    state,
                    alert_cooldown,
                )
        # #2420: recovery is here (AFTER the writefail records loop), not in
        # the claim try block — a successful claim cannot clear a still-leased
        # record that failed harvest in a prior cycle.
        if writefail_harvested > 0:
            enqueue_meta_recovery(
                remote,
                "remote-writefail-harvest-failed",
                f"BOT ERRORS collector remote writefail harvest recovered: {remote}",
                f"remote={remote}\nremote_root={remote_root}\nharvest_status=success",
                state,
            )
        if outbox_claim_failed:
            continue
        drain_record = remote_state.get(remote, {})
        last_drain = int(drain_record.get("lastDrainAt") or drain_record.get("lastSuccessAt") or 0)
        last_drain_iso = drain_record.get("lastDrainIso") or drain_record.get("lastSuccessIso")
        last_drain_error = drain_record.get("lastDrainError") or drain_record.get("lastError")
        age = int(time.time()) - last_drain if last_drain else remote_sla + 1
        if age > remote_sla:
            enqueue_meta_alert(
                remote,
                "remote-drain-stale",
                f"BOT ERRORS collector has not drained remote within SLA: {remote}",
                f"remote={remote}\nage_seconds={age}\nremote_sla_seconds={remote_sla}\nlast_drain={last_drain_iso}\nlast_error={last_drain_error}\ncollector_log={state_root() / 'logs/collector.jsonl'}",
                state,
                alert_cooldown,
            )
    save_collector_state(session, state, capability)
    return {
        "processed": processed,
        "writefailHarvested": writefail_harvested,
        "writefailDuplicates": writefail_duplicates,
        "writefailPoison": writefail_poison,
        "writefailNondurable": writefail_nondurable,
        "remotesSucceeded": remotes_succeeded,
        "isolatedFailures": isolated_failures,
        "bestEffortFailures": best_effort_failures,
        "bestEffortIsolatedFailures": best_effort_isolated_failures,
        "hardRemotesSucceeded": hard_remotes_succeeded,
        "failed": failed,
        "remotesSkippedBackoff": remotes_skipped_backoff,
    }


def run_daemon(
    remotes: list[str],
    best_effort_remotes: set[str],
    max_events: int,
    interval: int,
    timeout: int,
    lease_seconds: int,
    remote_sla: int,
    alert_cooldown: int,
    recovery_successes: int,
) -> None:
    while True:
        result = run_once(
            remotes,
            best_effort_remotes,
            max_events,
            timeout,
            lease_seconds,
            remote_sla,
            alert_cooldown,
            recovery_successes,
        )
        print(json.dumps({"time": now_iso(), **result}), flush=True)
        time.sleep(interval)


def exit_code_for_result(result: dict[str, Any]) -> int:
    hard_failed = int(result.get("failed") or 0) - int(result.get("bestEffortFailures") or 0)
    if hard_failed <= 0:
        return 0
    hard_isolated = int(result.get("isolatedFailures") or 0) - int(result.get("bestEffortIsolatedFailures") or 0)
    hard_remotes_succeeded = int(result.get("hardRemotesSucceeded") or 0)
    return 1 if not hard_remotes_succeeded or hard_failed > hard_isolated else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Relay remote BOT ERRORS outboxes into the local outbox")
    parser.add_argument("--remote", action="append", default=[])
    parser.add_argument("--best-effort-remote", action="append", default=[])
    parser.add_argument("--max-events", type=int, default=25)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--lease-seconds", type=int, default=300)
    parser.add_argument("--remote-sla", type=int, default=300)
    parser.add_argument("--alert-cooldown", type=int, default=900)
    parser.add_argument("--recovery-successes", type=int, default=default_recovery_successes())
    parser.add_argument("--daemon", action="store_true")
    parser.add_argument("--allow-empty-roster", action="store_true")
    args = parser.parse_args()

    if args.daemon and args.allow_empty_roster:
        # A declared-empty retirement is one-shot by definition, so this pair is
        # refused at the usage boundary rather than reconciled. Parked in a
        # unit's ExecStart it would look harmless while a roster existed and
        # degrade the moment one emptied: the cycle would succeed, exit, and be
        # restarted on the service manager's schedule, rewriting state every
        # cycle instead of retiring once. Checked first because it reads only
        # argv, so the answer cannot depend on the environment, and checked
        # above the state session, so the ledger is never opened.
        print(
            "--allow-empty-roster is a one-shot retirement and cannot be combined with --daemon",
            file=sys.stderr,
        )
        return 64
    # None (never set, or an environment file that failed to load) is NOT the
    # same as "" (an operator emptying the list), and reading with a default
    # collapses the two. Keep the distinction: only a PRESENT variable can be
    # declared empty.
    roster_env = os.environ.get("BOT_ERRORS_RELAY_REMOTES")
    remotes = args.remote or [r for r in (roster_env or "").split(",") if r]
    declared_empty_roster = args.allow_empty_roster and roster_env is not None
    if not remotes and not declared_empty_roster:
        # Unchanged fail-closed default, now covering one more case. An absent
        # or unreadable poll list is inconclusive configuration, not a decision
        # to poll nothing, and that stays true when --allow-empty-roster is
        # standing: the flag declares an EMPTY roster, never a MISSING one, so
        # a broken environment file cannot retire the whole ledger. EX_USAGE,
        # and no state work at all.
        print("no remotes configured", file=sys.stderr)
        return 64
    best_effort_remotes = set(args.best_effort_remote or [])
    recovery_successes = max(1, int(args.recovery_successes))
    try:
        # A declared empty roster is a retirement, not a poll: it runs exactly
        # one cycle so prune_state_to_configured_remotes can disposition every
        # open record the departed remotes still own, then stops. The two
        # guards above make that exact, so no third check is needed here:
        # reaching this line with args.daemon set proves the roster is
        # non-empty, because --daemon over an empty roster is either the
        # fail-closed 64 or the refused combination. The cycle reaches the
        # state session and nothing else, because _run_once_with_state's only
        # work between the prune and the save is `for remote in remotes`, so an
        # empty roster performs no remote, probe, claim or acknowledgement
        # effect. It is not silent, though: the prune emits one info-severity
        # observation per retired (remote, source) pair, which the dispatcher
        # delivers as a BOT INFO line. That is not one per open record --
        # acknowledgement membership is digest-keyed and collapses to a single
        # disposition per remote carrying the count of records it retires.
        # An unregistered bucket key still fails the whole cycle
        # closed, which matters most here: retiring every remote at once is the
        # widest reach the pruning validation pass ever has.
        if args.daemon:
            run_daemon(
                remotes,
                best_effort_remotes,
                args.max_events,
                args.interval,
                args.timeout,
                args.lease_seconds,
                args.remote_sla,
                args.alert_cooldown,
                recovery_successes,
            )
            return 0
        result = run_once(
            remotes,
            best_effort_remotes,
            args.max_events,
            args.timeout,
            args.lease_seconds,
            args.remote_sla,
            args.alert_cooldown,
            recovery_successes,
        )
    except ControllerStateRequired as exc:
        # Process boundary: one-shot returns 78; daemon mode exits 78 so the
        # service manager's restart throttle owns retries. The once-per-process
        # fallback line is the only stderr output and carries no state content.
        emit_state_recovery_fallback(exc.diagnostic)
        return STATE_RECOVERY_REQUIRED_EXIT
    except UnregisteredAlertSourceError as exc:
        # Same process boundary and the same exit code as
        # ControllerStateRequired: 78 is this estate's typed "state needs an
        # operator decision" code across collector, dispatcher and watchdog.
        # It does NOT suppress restarts for this process -- the collector runs
        # under deploy/bot-errors-collector.service (Restart=always,
        # RestartSec=10, no RestartPreventExitStatus); the unit that holds 78
        # out of its restart loop is deploy/whatsoup@.service, a different
        # unit. What this replaces is therefore the bare traceback, not the
        # loop: an operator gets a typed exit code and one bounded line instead
        # of a stack trace every ten seconds. The line is the exception's own
        # message, a count and an opaque digest, never a key, a remote
        # identity, or a remote root.
        print(f"bot-errors-collector: {exc}", file=sys.stderr)
        return STATE_RECOVERY_REQUIRED_EXIT
    print(json.dumps(result, sort_keys=True))
    return exit_code_for_result(result)


if __name__ == "__main__":
    raise SystemExit(main())
