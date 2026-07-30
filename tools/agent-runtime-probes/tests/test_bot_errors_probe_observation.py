#!/usr/bin/env python3
"""Contract tests for bounded BOT ERRORS probe observations."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bot_errors_probe_observation import observation, report_verdict, strict_exit_code  # noqa: E402


def test_observed_zero_is_distinct_from_missing_and_invalid():
    observed = observation("managed_components", "observed", observed_valid=0)
    missing = observation("managed_components", "missing", observed_valid=None, unknown=1)
    invalid = observation("managed_components", "invalid_shape", error_class="root_not_object")

    assert observed["counts"]["observed_valid"] == 0, observed
    assert observed["status"] == "observed", observed
    assert missing["status"] == "missing", missing
    assert missing["counts"]["observed_valid"] is None, missing
    assert invalid["error_class"] == "root_not_object", invalid


def test_report_verdict_never_certifies_missing_or_invalid_source():
    assert report_verdict({"policy": observation("policy", "observed")}) == "valid"
    assert report_verdict({"policy": observation("policy", "missing", unknown=1)}) == "inconclusive"
    assert report_verdict({"policy": observation("policy", "invalid_json")}) == "invalid"


def test_strict_exit_code_only_accepts_valid_report_verdict():
    assert strict_exit_code({"reportVerdict": "valid"}) == 0
    assert strict_exit_code({"reportVerdict": "inconclusive"}) == 2
    assert strict_exit_code({"reportVerdict": "invalid"}) == 2


def test_observation_rejects_absolute_or_traversal_artifact_references():
    for reference in ("/private/root/file.json", "../private/file.json", "dir\\private.json"):
        try:
            observation("policy", "observed", artifact_refs=(reference,))
        except ValueError as exc:
            assert "artifact reference" in str(exc), exc
        else:
            raise AssertionError(f"unsafe reference was accepted: {reference}")


if __name__ == "__main__":
    tests = [value for key, value in sorted(globals().items()) if key.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print("PASS", test.__name__)
    print(f"\nall {len(tests)} BOT ERRORS probe-observation tests passed")
