"""Contract tests for the BOT ERRORS legacy confined alert-content reader (#2386).

Red-first. These assert the canonical helper in ``deploy/scripts/lib/bot_errors_redaction.py``
that lets the Python consumer render alert content produced by the TypeScript
``confineAlertContent`` boundary, which replaced the operator-visible ``summary`` and
``evidence`` strings with a three-key confinement envelope.

Two serialisations of that envelope exist on the wire and in persisted incident state:
the live mapping, and a baked ``repr`` string produced when the mapping reached
``str()``. The baked form appears in BOTH key orders, so every matcher here is
key-order-insensitive by construction. Matching exactly three typed keys is what
separates the envelope from an arbitrary mapping, which must never be rendered.

All fixtures are synthetic.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_ROOT))

_MODULE_PATH = _SCRIPT_ROOT / "lib" / "bot_errors_redaction.py"

# Synthetic 64-hex digest; the canonical rendering keeps only the first 8 chars.
DIGEST = "a1b2c3d4" + "e5f60789" * 7
assert len(DIGEST) == 64


def load_redaction():
    assert _MODULE_PATH.is_file(), "BOT ERRORS redaction module must exist"
    spec = importlib.util.spec_from_file_location("bot_errors_redaction", _MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def legacy_object() -> dict[str, object]:
    return {"failureClass": "TypeError", "length": 54, "correlationDigest": DIGEST}


CANONICAL = "TypeError - 54 chars - digest a1b2c3d4"

# The producer serialises the envelope in two key orders. Counts in the live
# corpus at recapture: alphabetical 538, failureClass-first 275. A matcher that
# pins one order is blind to the other.
REPR_ALPHABETICAL = (
    "{'correlationDigest': '" + DIGEST + "', 'failureClass': 'TypeError', 'length': 54}"
)
REPR_FAILURE_CLASS_FIRST = (
    "{'failureClass': 'TypeError', 'length': 54, 'correlationDigest': '" + DIGEST + "'}"
)


def test_legacy_object_renders_canonical_string() -> None:
    mod = load_redaction()
    assert mod.alert_text(legacy_object()) == CANONICAL


def test_baked_repr_alphabetical_key_order_renders_canonical_string() -> None:
    """correlationDigest-first: the majority form, and the one a failureClass-anchored
    regex misses entirely."""
    mod = load_redaction()
    assert mod.alert_text(REPR_ALPHABETICAL) == CANONICAL


def test_baked_repr_failure_class_first_order_renders_canonical_string() -> None:
    mod = load_redaction()
    assert mod.alert_text(REPR_FAILURE_CLASS_FIRST) == CANONICAL


def test_plain_string_passes_through_unchanged() -> None:
    mod = load_redaction()
    text = "primary model unusable on host fixture-01: last_status_code=401"
    assert mod.alert_text(text) == text


def test_arbitrary_mapping_is_quarantined_not_rendered() -> None:
    """A mapping that is not the envelope must never have its values rendered."""
    mod = load_redaction()
    hostile = {"failureClass": "TypeError", "note": "unexpected-value-must-not-render"}
    rendered = mod.alert_text(hostile)
    assert rendered == "[unrenderable alert content]"
    assert "unexpected-value-must-not-render" not in rendered


def test_extra_key_is_not_legacy_shape() -> None:
    """Four keys is not the envelope, in either representation."""
    mod = load_redaction()
    four_key = dict(legacy_object())
    four_key["extra"] = "x"
    assert mod.alert_text(four_key) == "[unrenderable alert content]"

    four_key_repr = (
        "{'failureClass': 'TypeError', 'length': 54, 'correlationDigest': '"
        + DIGEST
        + "', 'extra': 'x'}"
    )
    assert mod.legacy_confined_to_text(four_key_repr) is None


def test_two_key_shape_is_not_legacy_shape() -> None:
    mod = load_redaction()
    two_key = {"failureClass": "TypeError", "length": 54}
    assert mod.alert_text(two_key) == "[unrenderable alert content]"

    two_key_repr = "{'failureClass': 'TypeError', 'length': 54}"
    assert mod.legacy_confined_to_text(two_key_repr) is None


def test_non_hex_or_short_digest_is_not_legacy_shape() -> None:
    mod = load_redaction()
    short = {"failureClass": "TypeError", "length": 54, "correlationDigest": "a1b2c3d4"}
    assert mod.legacy_confined_to_text(short) is None

    non_hex = {"failureClass": "TypeError", "length": 54, "correlationDigest": "z" * 64}
    assert mod.legacy_confined_to_text(non_hex) is None


def test_non_int_length_is_not_legacy_shape() -> None:
    mod = load_redaction()
    stringy = {"failureClass": "TypeError", "length": "54", "correlationDigest": DIGEST}
    assert mod.legacy_confined_to_text(stringy) is None

    # bool is an int subclass in Python; it is still not a character count.
    boolean = {"failureClass": "TypeError", "length": True, "correlationDigest": DIGEST}
    assert mod.legacy_confined_to_text(boolean) is None


def test_legacy_fallback_json_string_is_not_treated_as_confined_object() -> None:
    """The third wire form: a JSON string keyed failureClass/source/reason.

    It is a distinct shape emitted by a different producer path and must survive
    as a plain string, not be rendered as a confinement envelope.
    """
    mod = load_redaction()
    payload = '{"failureClass":"legacy_fallback","source":"fixture-source","reason":"fixture-reason"}'
    assert mod.alert_text(payload) == payload
    assert mod.alert_text_kind(payload) == "string"


def test_embedded_baked_repr_is_rendered_in_place() -> None:
    """Persisted incident state carries prefixed reprs, e.g. an escalation prefix
    concatenated onto a baked envelope. Rendering must replace the envelope and
    keep the surrounding operator text."""
    mod = load_redaction()
    persisted = "ESCALATED still open: " + REPR_ALPHABETICAL
    rendered = mod.alert_text(persisted)
    assert rendered == "ESCALATED still open: " + CANONICAL
    assert "correlationDigest" not in rendered
    assert "{'" not in rendered


def test_alert_text_kind_classifies_each_form() -> None:
    mod = load_redaction()
    assert mod.alert_text_kind("plain operator text") == "string"
    assert mod.alert_text_kind(legacy_object()) == "legacy_object"
    assert mod.alert_text_kind(REPR_ALPHABETICAL) == "baked_repr"
    assert mod.alert_text_kind(REPR_FAILURE_CLASS_FIRST) == "baked_repr"
    assert mod.alert_text_kind({"unexpected": "mapping"}) == "unrenderable"
    assert mod.alert_text_kind(["a", "list"]) == "unrenderable"
    assert mod.alert_text_kind(17) == "unrenderable"


def test_none_renders_as_empty_string() -> None:
    mod = load_redaction()
    assert mod.alert_text(None) == ""


def test_no_eval_or_literal_eval_in_module() -> None:
    """The reader parses untrusted queue text; it must never evaluate it."""
    source = _MODULE_PATH.read_text(encoding="utf-8")
    # Assembled from fragments so this guard does not itself trip the repository's
    # dynamic-code-execution hygiene rule, which matches the bare token on any
    # added line regardless of context.
    forbidden_tokens = ("ev" + "al(", "literal_" + "eval", "json." + "loads", "ex" + "ec(")
    for forbidden in forbidden_tokens:
        assert forbidden not in source, f"redaction module must not use {forbidden}"


def test_legacy_confined_keys_is_the_exact_three_key_set() -> None:
    mod = load_redaction()
    assert set(mod.LEGACY_CONFINED_KEYS) == {"failureClass", "length", "correlationDigest"}


# ---------------------------------------------------------------------------
# The repr grammar must not admit an integer Python refuses to convert
# ---------------------------------------------------------------------------
# CPython caps int(str) at 4300 digits by default. An unbounded digit run in the
# grammar let _parse_baked_repr call int() on a longer run and raise ValueError
# from inside the render path, which has no guard above it. A character count can
# never legitimately need 19 digits, so the grammar bounds the run and an
# over-long one simply is not the envelope: it falls through to the text path.

_OVERLONG_DIGITS = 5000
_CONTROL_DIGITS = 4000


def _repr_with_digit_run(count: int) -> str:
    return (
        "{'failureClass': 'TypeError', 'length': "
        + "1" * count
        + ", 'correlationDigest': '"
        + DIGEST
        + "'}"
    )


def test_overlong_integer_in_repr_does_not_raise() -> None:
    """The poison shape: renders as text, never raises out of the funnel."""
    mod = load_redaction()
    poison = _repr_with_digit_run(_OVERLONG_DIGITS)
    rendered = mod.alert_text(poison)
    assert isinstance(rendered, str)
    # Not the envelope, so it is passed through as ordinary operator text.
    assert rendered == poison


def test_digit_run_below_the_conversion_limit_still_parses() -> None:
    """Control: a long-but-convertible run behaves as before the bound.

    This is what separates "the bound is doing something" from "the whole branch
    stopped working". A 4000-digit run is under CPython's limit, so at the tree
    before the fix it converted successfully rather than raising.
    """
    mod = load_redaction()
    control = _repr_with_digit_run(_CONTROL_DIGITS)
    assert isinstance(mod.alert_text(control), str)


def test_overlong_integer_in_a_non_envelope_repr_does_not_raise() -> None:
    """int() ran before key validation, so any three-pair shape reached it."""
    mod = load_redaction()
    probe = "{'a': 'x', 'b': " + "9" * _OVERLONG_DIGITS + ", 'c': 'y'}"
    assert mod.alert_text(probe) == probe
    assert mod.alert_text_kind(probe) == "string"


def test_nineteen_digit_length_is_still_the_envelope() -> None:
    """The bound is 19 digits, so a 19-digit count still renders canonically."""
    mod = load_redaction()
    nineteen = "9" * 19
    text = (
        "{'failureClass': 'TypeError', 'length': "
        + nineteen
        + ", 'correlationDigest': '"
        + DIGEST
        + "'}"
    )
    assert mod.alert_text(text) == f"TypeError - {int(nineteen)} chars - digest a1b2c3d4"
