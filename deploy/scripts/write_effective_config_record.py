"""Publish a private effective-config record through the durable event writer.

The durable writer owns descriptor-relative locking and exclusive publication. This
adapter does not create directories, chmod paths, or implement another writer. Its
authority ends after the strict readback; a later filesystem change is outside this
one-shot CLI's finite authority window.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Any, BinaryIO, TextIO

try:
    from deploy.scripts.lib import durable_json
except ModuleNotFoundError:  # pragma: no cover - direct script execution
    from lib import durable_json


_MAX_INPUT_BYTES = 8 * 1024 * 1024
_INPUT_SCHEMA_VERSION = "whatsoup.effective-config.v1"
_OUTPUT_SCHEMA_VERSION = "whatsoup.effective-config-write.v1"
_COMPONENT = "whatsoup.effective-config"


class EffectiveConfigWriteError(RuntimeError):
    """Content-free public failure for this CLI boundary."""


def _parse_options(argv: list[str]) -> tuple[str, str]:
    if len(argv) != 4:
        raise EffectiveConfigWriteError()
    values: dict[str, str] = {}
    for index in range(0, len(argv), 2):
        name = argv[index]
        value = argv[index + 1]
        if name not in {"--output-root", "--output-relative"} or name in values:
            raise EffectiveConfigWriteError()
        values[name] = value
    root = values.get("--output-root")
    relative = values.get("--output-relative")
    if not isinstance(root, str) or not isinstance(relative, str):
        raise EffectiveConfigWriteError()
    return root, relative


def _parse_record(raw: bytes) -> dict[str, Any]:
    if not isinstance(raw, bytes) or len(raw) > _MAX_INPUT_BYTES:
        raise EffectiveConfigWriteError()
    try:
        payload = durable_json._load_json(raw, strict=True)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise EffectiveConfigWriteError() from None
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != _INPUT_SCHEMA_VERSION
    ):
        raise EffectiveConfigWriteError()
    return payload


def write_effective_config_record(
    *,
    raw: bytes,
    output_root: str | Path,
    output_relative: str | Path,
) -> dict[str, str]:
    payload = _parse_record(raw)
    try:
        target = durable_json.durable_json_target(
            trusted_root=output_root,
            relative_path=output_relative,
        )
        predecessor = durable_json.JsonVersion(False, None, None, None)
        operation = durable_json.operation_id(
            target,
            payload,
            component=_COMPONENT,
            predecessor=predecessor,
        )
        result = durable_json.publish_event_json(
            target,
            payload,
            component=_COMPONENT,
            operation_id=operation,
        )
        if not result.advance_allowed:
            raise EffectiveConfigWriteError()
        observation = durable_json.observe_json(target, strict=True)
    except durable_json.DurableWriteError:
        raise EffectiveConfigWriteError() from None
    if (
        observation.payload != payload
        or not observation.version.exists
        or observation.version.raw_sha256 is None
        or observation.identity is None
    ):
        raise EffectiveConfigWriteError()
    return {
        "schema_version": _OUTPUT_SCHEMA_VERSION,
        "record_sha256": observation.version.raw_sha256,
    }


def main(
    argv: list[str],
    *,
    stdin: BinaryIO = sys.stdin.buffer,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    try:
        output_root, output_relative = _parse_options(argv)
        raw = stdin.read(_MAX_INPUT_BYTES + 1)
        receipt = write_effective_config_record(
            raw=raw,
            output_root=output_root,
            output_relative=output_relative,
        )
    except Exception:
        stderr.write("INPUT_INVALID\n")
        return 2
    stdout.write(json.dumps(receipt, separators=(",", ":"), sort_keys=True))
    stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
