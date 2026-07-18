from __future__ import annotations

import json
import sys
from collections.abc import Iterable
from typing import TextIO

from .model import JsonValue, validate_json_value


def dumps_json(value: JsonValue) -> str:
    validate_json_value(value)
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def dump_jsonl(values: Iterable[dict[str, JsonValue]]) -> bytes:
    rendered: list[str] = []
    for value in values:
        if not isinstance(value, dict):
            raise TypeError("each JSONL document must be an object")
        rendered.append(dumps_json(value))
    if not rendered:
        return b""
    return ("\n".join(rendered) + "\n").encode("utf-8")


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_nonfinite_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def load_json_object(raw: bytes | str) -> dict[str, JsonValue]:
    if isinstance(raw, bytes):
        text = raw.decode("utf-8")
    elif isinstance(raw, str):
        text = raw
    else:
        raise TypeError("raw JSON must be bytes or text")
    value = json.loads(
        text,
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_reject_nonfinite_constant,
    )
    if not isinstance(value, dict):
        raise TypeError("JSON document must be an object")
    validate_json_value(value)
    return value


def write_stdout_document(
    document: dict[str, JsonValue], *, stdout: TextIO | None = None
) -> None:
    if not isinstance(document, dict):
        raise TypeError("stdout document must be an object")
    rendered = dumps_json(document) + "\n"
    target = sys.stdout if stdout is None else stdout
    target.write(rendered)
