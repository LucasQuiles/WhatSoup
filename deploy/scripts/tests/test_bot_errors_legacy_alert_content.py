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
import re
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


def test_run_under_the_conversion_limit_but_over_the_bound_renders_as_text() -> None:
    """A run CPython could convert but the grammar refuses still renders as text.

    4000 digits is under CPython's 4300-digit conversion limit, so before the
    bound this parsed and rendered canonically. It is over the 19-digit bound, so
    it is now simply not the envelope and passes through unchanged. Asserting the
    rendered text is what makes this a real case: isinstance(..., str) held for
    every possible return value and proved nothing.
    """
    mod = load_redaction()
    control = _repr_with_digit_run(_CONTROL_DIGITS)
    assert mod.alert_text(control) == control
    assert mod.alert_text_kind(control) == "string"


def test_overlong_integer_in_a_non_envelope_repr_does_not_raise() -> None:
    """int() ran before key validation, so any three-pair shape reached it."""
    mod = load_redaction()
    probe = "{'a': 'x', 'b': " + "9" * _OVERLONG_DIGITS + ", 'c': 'y'}"
    assert mod.alert_text(probe) == probe
    assert mod.alert_text_kind(probe) == "string"


def test_nineteen_digit_length_is_over_the_value_bound_and_does_not_render() -> None:
    """The repr GRAMMAR admits 19 digits; the VALUE bound does not.

    Renamed and re-aimed: the grammar's 19-digit cap exists only to keep int()
    from raising, and it is two orders of magnitude looser than any real
    character count. The value rule is what decides, so a 19-nine count is now
    unrenderable and falls through to the text path rather than rendering a
    number the producer could never have emitted.
    """
    mod = load_redaction()
    nineteen = "9" * 19
    text = (
        "{'failureClass': 'TypeError', 'length': "
        + nineteen
        + ", 'correlationDigest': '"
        + DIGEST
        + "'}"
    )
    assert int(nineteen) > mod.LEGACY_MAX_CONFINED_LENGTH
    # Superseded contract (B4): falling through to the text path handed the
    # digest-shaped field back verbatim. A string that IS this envelope's shape
    # with an out-of-bounds value is confined material, so it gets the sentinel.
    assert mod.alert_text(text) == mod.UNRENDERABLE_ALERT_CONTENT
    assert mod.alert_text_kind(text) == "unrenderable"
    assert DIGEST not in mod.alert_text(text)


# ---------------------------------------------------------------------------
# The legacy map's VALUES are bounded, not just its shape (#2386)
# ---------------------------------------------------------------------------
# The three-key shape check answers "is this the envelope". It says nothing about
# what the values hold, and `failureClass` is interpolated straight into
# operator-visible text and into the quarantine meta-alert. An unregistered class
# is therefore an open content channel wearing a field name, which is exactly what
# this issue exists to close. The producer's vocabulary is closed and enumerable,
# so the reader enforces membership rather than a lexical grammar: a grammar like
# "single-line ASCII token" still admits an unregistered content-bearing token.

_PRODUCER_VOCABULARY_TS = (
    Path(__file__).resolve().parents[3] / "src" / "lib" / "alert-evidence.ts"
)


def _producer_failure_classes() -> set[str]:
    """Extract the producer's closed vocabulary from alert-evidence.ts.

    Deliberately parses the TypeScript rather than restating it: a duplicated
    Python constant that nobody compares to its source silently rots the moment
    the producer gains a class, and the consumer then fails closed on a healthy
    alert. Coverage-asserted below so a parse that finds nothing cannot pass.
    """
    source = _PRODUCER_VOCABULARY_TS.read_text(encoding="utf-8")
    start = source.index("const FAILURE_CLASS_PATTERNS")
    end = source.index("];", start)
    block = source[start:end]

    classes: set[str] = set()
    for entry in re.finditer(r"\{\s*pattern:\s*(/.*?/),\s*label:\s*'([^']*)'\s*\}", block):
        pattern, label = entry.group(1), entry.group(2)
        if label == "$0":
            # The label IS the matched text, so every alternative is a class.
            group = re.search(r"\(\?:([^)]*)\)", pattern)
            assert group, f"a $0 label needs an alternation to enumerate: {pattern}"
            classes.update(part.strip() for part in group.group(1).split("|"))
        else:
            classes.add(label)

    # The empty-content sentinel and the extractor's fallback are emitted too,
    # and neither comes from the pattern table.
    sentinel = re.search(r"failureClass:\s*'([^']*)'", source)
    assert sentinel, "the EMPTY_CONFINED sentinel class must be present"
    classes.add(sentinel.group(1))
    fallback = re.search(r"return\s+'([^']*)';\s*\n\}", source)
    assert fallback, "the extractFailureClass fallback must be present"
    classes.add(fallback.group(1))
    return classes


def test_producer_failure_class_vocabulary_parity() -> None:
    """Cross-language parity, so drift in EITHER direction is red.

    A class the producer gains but the consumer does not know would be
    quarantined as unrenderable, turning a healthy alert into a dropped one. A
    class the consumer keeps after the producer drops it is a stale hole in the
    allowlist. Both are failures, so this asserts set equality, not containment.
    """
    mod = load_redaction()
    producer = _producer_failure_classes()
    # Coverage assertion: an extraction that silently found nothing would make
    # any containment check vacuous, and equality against an empty set would
    # only fail confusingly.
    assert len(producer) >= 15, f"vocabulary extraction looks truncated: {sorted(producer)}"
    assert set(mod.LEGACY_FAILURE_CLASSES) == producer, (
        "consumer allowlist has drifted from src/lib/alert-evidence.ts; "
        f"consumer-only={sorted(set(mod.LEGACY_FAILURE_CLASSES) - producer)} "
        f"producer-only={sorted(producer - set(mod.LEGACY_FAILURE_CLASSES))}"
    )


def test_every_producer_emitted_failure_class_is_accepted() -> None:
    """No registered class may be rejected: that would drop a healthy alert."""
    mod = load_redaction()
    for failure_class in sorted(_producer_failure_classes()):
        value = {"failureClass": failure_class, "length": 12, "correlationDigest": DIGEST}
        rendered = mod.alert_text(value)
        assert rendered == f"{failure_class} - 12 chars - digest a1b2c3d4", failure_class
        assert mod.alert_text_kind(value) == "legacy_object", failure_class


def test_the_vocabulary_members_are_single_line_ascii_tokens() -> None:
    """The allowlist implies the lexical rules, so they are asserted, not re-checked."""
    mod = load_redaction()
    for failure_class in mod.LEGACY_FAILURE_CLASSES:
        assert failure_class, "an empty class is not a token"
        assert failure_class.isascii(), failure_class
        assert failure_class.isprintable(), failure_class
        assert "\n" not in failure_class and "\r" not in failure_class, failure_class
        assert len(failure_class) <= 21, failure_class


HOSTILE_MARKER = "hostilemarker8842"

HOSTILE_FAILURE_CLASSES = {
    "empty": "",
    "unregistered": HOSTILE_MARKER,
    "multi_line": "TypeError\n" + HOSTILE_MARKER,
    "control_bearing": "TypeError\x00" + HOSTILE_MARKER,
    "over_length": "TypeError" + HOSTILE_MARKER * 40,
    "case_variant_of_a_registered_class": "typeerror",
    "registered_class_with_a_suffix": "TypeError " + HOSTILE_MARKER,
}


def test_a_hostile_failure_class_in_the_exact_shape_is_never_interpolated() -> None:
    """The EXACT three-key shape is not a licence to render the values.

    Each fixture below is a well-formed envelope by shape. The class is the only
    hostile part, and none of it may reach the rendered text: the value falls
    through to the fixed sentinel, which the caller quarantines.
    """
    mod = load_redaction()
    for name, failure_class in HOSTILE_FAILURE_CLASSES.items():
        value = {
            "failureClass": failure_class,
            "length": 54,
            "correlationDigest": DIGEST,
        }
        assert mod.legacy_confined_to_text(value) is None, name
        assert mod.alert_text_kind(value) == "unrenderable", name
        rendered = mod.alert_text(value)
        assert rendered == mod.UNRENDERABLE_ALERT_CONTENT, name
        assert HOSTILE_MARKER not in rendered, name
        assert failure_class not in rendered or not failure_class, name


def test_a_hostile_failure_class_in_a_baked_repr_is_never_interpolated() -> None:
    """Same rule on the string serialisation, which takes a different code path."""
    mod = load_redaction()
    text = (
        "{'failureClass': '" + HOSTILE_MARKER + "', 'length': 54, "
        "'correlationDigest': '" + DIGEST + "'}"
    )
    # Superseded contract (B4): this was asserted to stay verbatim on the
    # grounds that it was never parsed into a rendered class. That left the
    # hostile class and the digest in operator-visible text, and left the event
    # routable as an ordinary incident alert. It IS this envelope's shape, so it
    # is confined material and gets the fixed sentinel.
    assert mod.alert_text_kind(text) == "unrenderable"
    assert mod.alert_text(text) == mod.UNRENDERABLE_ALERT_CONTENT
    assert HOSTILE_MARKER not in mod.alert_text(text)
    assert DIGEST not in mod.alert_text(text)
    assert mod.legacy_confined_to_text(text) is None


BAD_LENGTHS = {
    "negative": -1,
    "boolean_true": True,
    "boolean_false": False,
    "string": "54",
    "float": 54.0,
    "over_the_bound": 2 ** 53,
    "none": None,
}


def test_out_of_contract_lengths_are_not_the_envelope() -> None:
    mod = load_redaction()
    for name, length in BAD_LENGTHS.items():
        value = {"failureClass": "TypeError", "length": length, "correlationDigest": DIGEST}
        assert mod.legacy_confined_to_text(value) is None, name
        assert mod.alert_text_kind(value) == "unrenderable", name


def test_the_boundary_lengths_are_accepted() -> None:
    """Both ends of the closed interval render, so the bound is not off by one."""
    mod = load_redaction()
    for length in (mod.LEGACY_MIN_CONFINED_LENGTH, mod.LEGACY_MAX_CONFINED_LENGTH):
        value = {"failureClass": "TypeError", "length": length, "correlationDigest": DIGEST}
        assert mod.alert_text(value) == f"TypeError - {length} chars - digest a1b2c3d4"


# ---------------------------------------------------------------------------
# A malformed STRUCTURAL legacy repr is not ordinary operator text (B4)
# ---------------------------------------------------------------------------
# Bounding the live mapping closed one of two doors. A string that IS the legacy
# envelope's repr, with the same three keys, is syntactically distinguishable
# from ordinary text; when its values fail the bounds the reader used to hand it
# back verbatim, so the invalid class and the digest-shaped field stayed in
# operator-visible text and the event stayed a routable incident alert.

MALFORMED_MARKER = "hostilemarker8842"


def malformed_repr(failure_class: str = MALFORMED_MARKER, length: str = "54",
                   digest: str = DIGEST) -> str:
    return (
        "{'failureClass': '" + failure_class + "', 'length': " + length
        + ", 'correlationDigest': '" + digest + "'}"
    )


def test_an_exact_malformed_legacy_repr_is_not_returned_verbatim() -> None:
    """The whole string is the envelope's repr and its class is unregistered."""
    mod = load_redaction()
    text = malformed_repr()
    rendered = mod.alert_text(text)
    assert MALFORMED_MARKER not in rendered, rendered
    assert DIGEST not in rendered, rendered
    assert rendered == mod.UNRENDERABLE_ALERT_CONTENT
    assert mod.alert_text_kind(text) == "unrenderable"


def test_an_embedded_malformed_legacy_repr_is_replaced_not_dropped() -> None:
    """Surrounding operator text is preserved; only the envelope span goes."""
    mod = load_redaction()
    text = "ESCALATED still open: " + malformed_repr() + " (first seen 10:02Z)"
    rendered = mod.alert_text(text)
    assert MALFORMED_MARKER not in rendered, rendered
    assert DIGEST not in rendered, rendered
    assert rendered.startswith("ESCALATED still open: ")
    assert rendered.endswith(" (first seen 10:02Z)")
    assert mod.UNRENDERABLE_ALERT_CONTENT in rendered


def test_an_out_of_bounds_length_is_malformed_not_ordinary_text() -> None:
    """B4 names invalid class AND length fields; the digest is shaped material."""
    mod = load_redaction()
    text = malformed_repr(failure_class="TypeError", length="9" * 19)
    rendered = mod.alert_text(text)
    assert DIGEST not in rendered, rendered
    assert rendered == mod.UNRENDERABLE_ALERT_CONTENT
    assert mod.alert_text_kind(text) == "unrenderable"


def test_a_short_digest_is_malformed_not_ordinary_text() -> None:
    mod = load_redaction()
    text = malformed_repr(failure_class="TypeError", digest="deadbeef")
    assert mod.alert_text(text) == mod.UNRENDERABLE_ALERT_CONTENT


def test_a_nested_malformed_repr_is_caught_in_BOTH_outer_key_orders() -> None:
    """The key-order permutation, as a permanent regression.

    A detector that finds a balanced outer mapping and skips to its end never
    examines a nested envelope, so acceptance turns on insertion order alone.
    Both wrappers below are logically the same mapping.
    """
    mod = load_redaction()
    inner = malformed_repr()
    orders = {
        "reserved_first": "{'failureClass': 'decoy', 'wrapper': " + inner + "}",
        "wrapper_first": "{'wrapper': " + inner + ", 'failureClass': 'decoy'}",
    }
    results = {}
    for name, text in orders.items():
        rendered = mod.alert_text(text)
        results[name] = {
            "kind": mod.alert_text_kind(text),
            "marker_present": MALFORMED_MARKER in rendered,
            "digest_present": DIGEST in rendered,
        }
    assert results["reserved_first"] == results["wrapper_first"], results
    for name, row in results.items():
        assert not row["marker_present"], (name, row)
        assert not row["digest_present"], (name, row)


def test_ordinary_text_and_valid_reprs_are_untouched() -> None:
    """Negative control: the detector must not swallow non-legacy material."""
    mod = load_redaction()
    ordinary = "restart loop: {'attempt': 3, 'code': 'EAGAIN', 'unit': 'whatsoup'}"
    assert mod.alert_text(ordinary) == ordinary
    assert mod.alert_text_kind(ordinary) == "string"

    valid = malformed_repr(failure_class="TypeError")
    assert mod.alert_text(valid) == CANONICAL
    assert mod.alert_text_kind(valid) == "baked_repr"

    plain = "queue drained, 4 alerts delivered"
    assert mod.alert_text(plain) == plain


def test_a_five_thousand_digit_length_is_still_ordinary_text() -> None:
    """The grammar bound keeps int() safe; that run is not the envelope at all."""
    mod = load_redaction()
    text = malformed_repr(failure_class="TypeError", length="9" * 5000)
    assert mod.alert_text(text) == text
    assert mod.alert_text_kind(text) == "string"
