#!/usr/bin/env python3
"""Property-based tests for the CAPE masker (prompt_sanitizer) — OUT-OF-BAND test lane.

WHY this lives outside the stdlib `tests/test_*.py` suite: it requires Hypothesis (vetted +
hash-verified into `.venv-test`, NOT a probe-runtime dependency). Run it explicitly with the
verified interpreter:

    .venv-test/bin/python tests/property/masker_properties.py

What it buys over the example-based suite: Hypothesis generates thousands of adversarial
inputs and, on any failure, SHRINKS to a minimal counterexample — turning the masker's
load-bearing security invariant into an ungameable check rather than a handful of fixtures.

Invariants under test:
  P1 (no fail-open leak): for ANY input, residual_scan(mask(text)) == []  — the masker never
     leaves a sensitive shape behind.
  P2 (bijection on the normalized form): rehydrate(mask(text)) == _normalize(text)  — masking
     is losslessly reversible (B1/round-trip safety).
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from hypothesis import given, settings, strategies as st  # noqa: E402
from hypothesis.database import InMemoryExampleDatabase  # noqa: E402

import prompt_sanitizer as ps  # noqa: E402
import sensitive_pattern_loader as spl  # noqa: E402

PATTERNS = spl.load_patterns()
NONCE = ps.session_nonce("property-test-session-key")

# Inputs that interleave arbitrary text with REAL sensitive shapes the masker must catch,
# so the invariant is exercised on hard cases, not just empty prose.
_emails = st.builds(
    lambda u, d: f"{u}@{d}.com",
    st.text("abcdefghijk._-", min_size=1, max_size=6),
    st.text("abcdefghij", min_size=1, max_size=6),
)
_paths = st.builds(lambda p: f"/Users/{p}/secret/notes.txt", st.text("abcdefgh", min_size=1, max_size=6))
_fragments = st.lists(st.one_of(st.text(max_size=24), _emails, _paths), max_size=10)
_texts = st.builds(lambda frags: " ".join(frags), _fragments)

_SETTINGS = settings(database=InMemoryExampleDatabase(), max_examples=400, deadline=None)


@_SETTINGS
@given(_texts)
def test_p1_masker_never_leaves_residual(text):
    masked, _swap = ps.mask(text, NONCE, PATTERNS)
    residual = ps.residual_scan(masked, PATTERNS)
    assert residual == [], f"FAIL-OPEN LEAK: residual={residual} for masked input"


@_SETTINGS
@given(_texts)
def test_p2_masker_roundtrip_is_lossless(text):
    masked, swap = ps.mask(text, NONCE, PATTERNS)
    restored = ps.rehydrate(masked, swap)
    assert restored == ps._normalize(text), "round-trip diverged from normalized input"


if __name__ == "__main__":
    import hypothesis
    print(f"Hypothesis {hypothesis.__version__} | patterns status={PATTERNS.status}")
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} masker property tests passed (400 examples each, shrinking enabled)")
