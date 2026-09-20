"""Read a digest-bound deployment effective-configuration record.

This module deliberately validates the producer's private-record contract.  It does
not resolve deployment policy or load an instance configuration from ambient state.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
import math
from pathlib import Path
import re
import time
from typing import Any

from . import durable_json


_SCHEMA_VERSION = "whatsoup.effective-config.v1"
_SOURCE_NAMES = ("binding", "inventory", "instance_config")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_OPAQUE_REF = re.compile(r"^(?:host|usr|inst)_[a-z0-9]{8,32}$")
_CLEAN_STRING = re.compile(r"^\S(?:.*\S)?$")


class EffectiveConfigRefusal(RuntimeError):
    """Content-free refusal of an unbound or invalid private record."""


def _refuse() -> None:
    raise EffectiveConfigRefusal()


def _as_mapping(value: object) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or any(not isinstance(key, str) for key in value):
        _refuse()
    return value


def _is_clean_string(value: object, *, maximum: int = 4096) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= maximum
        and value == value.strip()
        and _CLEAN_STRING.fullmatch(value) is not None
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
    )


def _is_absolute_path(value: object) -> bool:
    if not _is_clean_string(value):
        return False
    try:
        return durable_json.durable_json_target(
            trusted_root=value,
            relative_path="probe",
        ).trusted_root.as_posix() == value
    except (OSError, durable_json.DurableWriteError):
        return False


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and _SHA256.fullmatch(value) is not None


def _is_integer(value: object, *, minimum: int, maximum: int | None = None) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and value >= minimum
        and (maximum is None or value <= maximum)
    )


def _identity_from_observation(identity: durable_json.JsonFileIdentity | None) -> dict[str, object]:
    if identity is None:
        _refuse()
    return {
        "device": str(identity.device),
        "inode": str(identity.inode),
        "size": identity.size,
        "mode": identity.mode,
        "uid": identity.uid,
        "links": identity.nlink,
        "modifiedNs": str(identity.mtime_ns),
        "changedNs": str(identity.ctime_ns),
    }


def _validate_identity(value: object) -> Mapping[str, Any]:
    identity = _as_mapping(value)
    if set(identity) != {
        "device",
        "inode",
        "size",
        "mode",
        "uid",
        "links",
        "modifiedNs",
        "changedNs",
    }:
        _refuse()
    if (
        not all(
            isinstance(identity[key], str) and identity[key].isdigit()
            for key in ("device", "inode", "modifiedNs", "changedNs")
        )
        or not _is_integer(identity["size"], minimum=0)
        or not _is_integer(identity["mode"], minimum=0)
        or not _is_integer(identity["uid"], minimum=0)
        or not _is_integer(identity["links"], minimum=1)
    ):
        _refuse()
    return identity


def _validate_context(value: object) -> Mapping[str, Any]:
    context = _as_mapping(value)
    expected_lengths = {
        "arc_commit": 40,
        "qfleet_commit": 40,
        "whatsoup_commit": 40,
        "run_context_digest": 64,
    }
    if set(context) != set(expected_lengths):
        _refuse()
    if any(
        not isinstance(context[key], str)
        or len(context[key]) != length
        or not all(character in "0123456789abcdef" for character in context[key])
        for key, length in expected_lengths.items()
    ):
        _refuse()
    return context


def _validate_target(value: object) -> Mapping[str, Any]:
    target = _as_mapping(value)
    if set(target) != {
        "host_ref",
        "user_ref",
        "instance_ref",
        "inventory_host",
        "instance_name",
    }:
        _refuse()
    if (
        not isinstance(target["host_ref"], str)
        or not target["host_ref"].startswith("host_")
        or _OPAQUE_REF.fullmatch(target["host_ref"]) is None
        or not isinstance(target["user_ref"], str)
        or not target["user_ref"].startswith("usr_")
        or _OPAQUE_REF.fullmatch(target["user_ref"]) is None
        or not isinstance(target["instance_ref"], str)
        or not target["instance_ref"].startswith("inst_")
        or _OPAQUE_REF.fullmatch(target["instance_ref"]) is None
        or not _is_clean_string(target["inventory_host"])
        or not _is_clean_string(target["instance_name"])
    ):
        _refuse()
    return target


def _validate_limits(value: object) -> Mapping[str, Any]:
    limits = _as_mapping(value)
    if set(limits) != {"timeout_seconds", "max_bytes", "freshness_seconds"}:
        _refuse()
    timeout = limits["timeout_seconds"]
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or not math.isfinite(timeout)
        or timeout < 0.01
        or timeout > 5
        or not _is_integer(limits["max_bytes"], minimum=1, maximum=65536)
        or not _is_integer(limits["freshness_seconds"], minimum=1, maximum=300)
    ):
        _refuse()
    return limits


def _validate_deployment(value: object) -> None:
    deployment = _as_mapping(value)
    required = {
        "uid",
        "home_root",
        "principal",
        "platform",
        "service_manager",
        "service_domain",
        "token_file_relative",
        "token_file",
    }
    if not required.issubset(deployment):
        _refuse()
    if (
        not _is_integer(deployment["uid"], minimum=0)
        or not _is_absolute_path(deployment["home_root"])
        or not _is_clean_string(deployment["principal"])
        or deployment["platform"] != "macos"
        or deployment["service_manager"] != "launchd"
        or deployment["service_domain"] not in {"gui", "user"}
        or not _is_relative_path(deployment["token_file_relative"])
        or not _is_absolute_path(deployment["token_file"])
    ):
        _refuse()


def _is_relative_path(value: object) -> bool:
    if not _is_clean_string(value) or not isinstance(value, str):
        return False
    return not value.startswith("/") and "\\" not in value and all(
        component not in {"", ".", ".."} for component in value.split("/")
    )


def _validate_configured(value: object) -> None:
    configured = _as_mapping(value)
    if not {"host", "instance", "service", "agentOptions", "deployment"}.issubset(configured):
        _refuse()
    if not isinstance(configured["host"], Mapping):
        _refuse()
    instance = _as_mapping(configured["instance"])
    if (
        not {"name", "type", "accessMode", "healthPort"}.issubset(instance)
        or not all(_is_clean_string(instance[key]) for key in ("name", "type", "accessMode"))
        or not _is_integer(instance["healthPort"], minimum=1024, maximum=65535)
        or not isinstance(configured["service"], Mapping)
        or not isinstance(configured["agentOptions"], Mapping)
    ):
        _refuse()
    _validate_deployment(configured["deployment"])


def _validate_fields(value: object, *, source_digests: set[str], policy_digest: str) -> None:
    if not isinstance(value, list) or not value:
        _refuse()
    owners = {
        "whatsoup_instance",
        "qualification_binding",
        "qfleet_inventory",
        "qualification_policy",
    }
    for entry in value:
        field = _as_mapping(entry)
        if not {"field", "owner", "source_raw_sha256", "presence", "override_reason"}.issubset(field):
            _refuse()
        if (
            not _is_clean_string(field["field"])
            or field["owner"] not in owners
            or not _is_sha256(field["source_raw_sha256"])
            or field["source_raw_sha256"] not in source_digests | {policy_digest}
            or field["presence"] not in {"absent", "null", "value"}
            or (field["override_reason"] is not None and not _is_clean_string(field["override_reason"]))
        ):
            _refuse()
        if field["presence"] == "value" and "value" not in field:
            _refuse()
        if field["presence"] == "absent" and "value" in field:
            _refuse()
        if "derived_from" in field and (
            not isinstance(field["derived_from"], list)
            or not all(_is_clean_string(item) for item in field["derived_from"])
        ):
            _refuse()


def _parse_generated_at(value: object, *, now_ms: object, freshness_seconds: int) -> None:
    if not isinstance(value, str) or not value.endswith("Z"):
        _refuse()
    try:
        generated = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        _refuse()
    if generated.tzinfo != timezone.utc:
        _refuse()
    if now_ms is None:
        current_ms = time.time_ns() // 1_000_000
    elif _is_integer(now_ms, minimum=0):
        current_ms = now_ms
    else:
        _refuse()
    generated_ms = int(generated.timestamp() * 1_000)
    if generated_ms > current_ms or current_ms - generated_ms > freshness_seconds * 1_000:
        _refuse()


def _source_target(source: Mapping[str, Any]) -> durable_json.DurableJsonTarget:
    if set(source) != {"root", "path", "raw_sha256", "identity"}:
        _refuse()
    root = source["root"]
    path = source["path"]
    if not _is_absolute_path(root) or not _is_absolute_path(path) or not _is_sha256(source["raw_sha256"]):
        _refuse()
    root_text = str(root)
    path_text = str(path)
    try:
        relative = Path(path_text).relative_to(Path(root_text)).as_posix()
    except ValueError:
        _refuse()
    if not _is_relative_path(relative):
        _refuse()
    _validate_identity(source["identity"])
    try:
        return durable_json.durable_json_target(
            trusted_root=root_text,
            relative_path=relative,
        )
    except (OSError, durable_json.DurableWriteError):
        _refuse()
    raise AssertionError("unreachable")


def _validate_record(payload: Mapping[str, Any], *, expected_context: object, expected_target: object, now_ms: object) -> tuple[Mapping[str, Any], Mapping[str, Mapping[str, Any]]]:
    required = {
        "schema_version",
        "generated_at",
        "context",
        "target",
        "sources",
        "requested",
        "configured",
        "fields",
        "limits",
        "policy_digest",
        "transport_identity",
    }
    if not required.issubset(payload) or payload["schema_version"] != _SCHEMA_VERSION:
        _refuse()
    context = _validate_context(payload["context"])
    target = _validate_target(payload["target"])
    if not isinstance(expected_context, Mapping) or not isinstance(expected_target, Mapping):
        _refuse()
    if dict(context) != dict(expected_context) or dict(target) != dict(expected_target):
        _refuse()
    limits = _validate_limits(payload["limits"])
    _parse_generated_at(payload["generated_at"], now_ms=now_ms, freshness_seconds=limits["freshness_seconds"])
    if not _is_sha256(payload["policy_digest"]) or payload["transport_identity"] != "unresolved":
        _refuse()
    if not isinstance(payload["requested"], Mapping):
        _refuse()
    _validate_configured(payload["configured"])
    sources_raw = _as_mapping(payload["sources"])
    if set(sources_raw) != set(_SOURCE_NAMES):
        _refuse()
    sources = {name: _as_mapping(sources_raw[name]) for name in _SOURCE_NAMES}
    for source in sources.values():
        _source_target(source)
    source_digests = {source["raw_sha256"] for source in sources.values()}
    _validate_fields(payload["fields"], source_digests=source_digests, policy_digest=payload["policy_digest"])
    return payload, sources


def _observe_strict(target: durable_json.DurableJsonTarget) -> durable_json.JsonObservation:
    observation = durable_json.observe_json(target, strict=True)
    if observation.payload is None or observation.version.raw_sha256 is None:
        _refuse()
    return observation


def load_effective_config(
    target: durable_json.DurableJsonTarget,
    *,
    expected_sha256: str,
    expected_context: Mapping[str, object],
    expected_target: Mapping[str, object],
    now_ms: int | None = None,
) -> Mapping[str, Any]:
    """Return a strictly observed record after its private bindings are rechecked."""
    try:
        if not isinstance(target, durable_json.DurableJsonTarget) or not _is_sha256(expected_sha256):
            _refuse()
        first = _observe_strict(target)
        if first.version.raw_sha256 != expected_sha256:
            _refuse()
        payload, sources = _validate_record(
            first.payload,
            expected_context=expected_context,
            expected_target=expected_target,
            now_ms=now_ms,
        )
        for _ in range(2):
            for name in _SOURCE_NAMES:
                source = sources[name]
                source_observation = _observe_strict(_source_target(source))
                if (
                    source_observation.version.raw_sha256 != source["raw_sha256"]
                    or _identity_from_observation(source_observation.identity) != source["identity"]
                ):
                    _refuse()
        final = _observe_strict(target)
        if (
            final.version.raw_sha256 != first.version.raw_sha256
            or final.identity != first.identity
            or final.payload != payload
        ):
            _refuse()
        _parse_generated_at(payload["generated_at"], now_ms=now_ms,
                            freshness_seconds=payload["limits"]["freshness_seconds"])
        return payload
    except EffectiveConfigRefusal:
        raise
    except Exception:
        raise EffectiveConfigRefusal() from None
