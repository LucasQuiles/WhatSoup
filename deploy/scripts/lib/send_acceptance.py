"""Validate the current send_message MCP response before recording success."""
from __future__ import annotations

import json
from typing import Any


class SendNotAccepted(RuntimeError):
    """The tool explicitly reports that it did not accept the send."""


class SendAcceptanceUnknown(RuntimeError):
    """The response does not prove acceptance for the requested target."""


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate response field")
        result[key] = value
    return result


def _invalid_constant(value: str) -> None:
    raise ValueError("non-JSON numeric constant")


def validate_send_acceptance(result: Any, expected_target: str) -> dict[str, str]:
    """Return optional opaque receipt metadata; never echo message or target."""
    if not isinstance(result, dict):
        raise SendAcceptanceUnknown("send response is not an object")
    if result.get("isError") is True:
        raise SendNotAccepted("send tool reported an error")
    if "isError" in result and result["isError"] is not False:
        raise SendAcceptanceUnknown("invalid send error flag")
    blocks = result.get("content")
    if not isinstance(blocks, list) or len(blocks) != 1:
        raise SendAcceptanceUnknown("send response requires one content block")
    block = blocks[0]
    if not isinstance(block, dict) or block.get("type") != "text" or not isinstance(block.get("text"), str):
        raise SendAcceptanceUnknown("send response requires JSON text")
    try:
        payload = json.loads(
            block["text"], object_pairs_hook=_unique_object, parse_constant=_invalid_constant
        )
    except (TypeError, ValueError, RecursionError) as exc:
        raise SendAcceptanceUnknown("invalid send response JSON") from exc
    if not isinstance(payload, dict):
        raise SendAcceptanceUnknown("send payload is not an object")
    if payload.get("sent") is False:
        raise SendNotAccepted("send tool reported no send")
    if payload.get("sent") is not True:
        raise SendAcceptanceUnknown("send acceptance is not established")
    if any(key in payload and payload[key] is not False for key in ("dryRun", "suppressed")):
        raise SendAcceptanceUnknown("contradictory send acceptance")
    if payload.get("resolved_chatJid") != expected_target or not expected_target:
        raise SendAcceptanceUnknown("send target is not confirmed")
    receipt = payload.get("audit_receipt")
    if "audit_receipt" in payload and (not isinstance(receipt, str) or not receipt.strip()):
        raise SendAcceptanceUnknown("invalid send audit receipt")
    return {"audit_receipt": receipt} if receipt is not None else {}
