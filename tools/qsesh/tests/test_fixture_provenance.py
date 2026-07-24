from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import pytest
from qsesh.extractors.claude import (
    CLAUDE_OBSERVED_MODERN_CONTROL_TYPES,
    CLAUDE_OBSERVED_MODERN_SYSTEM_SUBTYPES,
)

FIXTURE_ROOT = Path(__file__).parent / "fixtures"
PROVENANCE_PATH = FIXTURE_ROOT / "provenance.json"
HARNESSES = ("claude", "codex", "opencode")
CANONICAL_KINDS = {
    "assistant_msg",
    "compaction",
    "meta",
    "reasoning",
    "session_meta",
    "skill_invocation",
    "subagent_activity",
    "tool_call",
    "tool_result",
    "user_msg",
}
COVERAGE_CASES = {
    "attachment_meta",
    "compaction",
    "malformed",
    "mcp_tool",
    "missing_cost_token",
    "skill",
    "subagent",
    "timestamp_offset",
    "tool",
    "unknown_kind",
}
FIXED_IDENTITIES = {
    "claude": "session-claude-001",
    "codex": "session-codex-001",
    "opencode": "ses_opencode_001",
}
ALLOWED_TEXT_VALUES = {
    "/brainstorming",
    "ASSISTANT_BETA",
    "REASONING_GAMMA",
    "USER_ALPHA",
    "invoked /brainstorming",
}
PROSE_KEYS = {
    "content",
    "description",
    "message",
    "output",
    "prompt",
    "result",
    "summary",
    "text",
    "thinking",
    "title",
}
ABSENCE_CHECKS = {
    "absolute-home-or-work-path",
    "credential-pattern",
    "live-native-id",
    "non-allowlisted-prose",
    "raw-source-hash",
    "raw-source-path",
}
INPUT_KEYS = {
    "claude": {
        "agent",
        "attachments",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "command",
        "compact_metadata",
        "content",
        "cwd",
        "data",
        "file",
        "gitBranch",
        "id",
        "input",
        "input_tokens",
        "isSidechain",
        "message",
        "model",
        "name",
        "output_tokens",
        "parentUuid",
        "reason",
        "role",
        "sourceToolAssistantUUID",
        "subtype",
        "text",
        "thinking",
        "timestamp",
        "toolUseResult",
        "tool_use_id",
        "type",
        "usage",
        "userType",
        "uuid",
        "version",
    },
    "codex": {
        "arguments",
        "attachment",
        "call_id",
        "content",
        "cwd",
        "id",
        "input",
        "kind",
        "message",
        "model",
        "name",
        "output",
        "payload",
        "role",
        "session_id",
        "summary",
        "text",
        "timestamp",
        "type",
    },
    "opencode": {
        "agent",
        "cost",
        "created",
        "description",
        "directory",
        "file",
        "id",
        "info",
        "input",
        "messageID",
        "messages",
        "modelID",
        "name",
        "output",
        "parentID",
        "parts",
        "projectID",
        "prompt",
        "providerID",
        "role",
        "sessionID",
        "state",
        "status",
        "synthetic",
        "text",
        "time",
        "title",
        "tokens",
        "tool",
        "type",
        "updated",
        "version",
    },
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def strict_json(data: bytes) -> object:
    def no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = value
        return result

    return json.loads(data, object_pairs_hook=no_duplicates)


def load_json(path: Path) -> object:
    return strict_json(path.read_bytes())


def walk(value: object) -> list[tuple[str, object]]:
    found: list[tuple[str, object]] = []

    def visit(child: object, key: str) -> None:
        found.append((key, child))
        if isinstance(child, dict):
            for nested_key, nested_value in child.items():
                visit(nested_value, nested_key)
        elif isinstance(child, list):
            for nested_value in child:
                visit(nested_value, key)

    visit(value, "$")
    return found


def test_fixture_contract_is_present_before_extractor_implementation() -> None:
    expected = {
        FIXTURE_ROOT / harness / name
        for harness in HARNESSES
        for name in ("expected-semantics.json", "malformed.json", "session.json")
    }
    expected.add(PROVENANCE_PATH)

    missing = sorted(
        path.relative_to(FIXTURE_ROOT).as_posix()
        for path in expected
        if not path.is_file()
    )
    assert missing == []


def test_provenance_has_exact_harness_and_observation_matrix() -> None:
    provenance = load_json(PROVENANCE_PATH)
    assert isinstance(provenance, dict)
    assert set(provenance) == {
        "corpus",
        "observations",
        "sanitizer_version",
        "schema_version",
    }
    assert provenance["schema_version"] == 1
    assert provenance["sanitizer_version"] == "structural-allowlist-v1"

    observations = provenance["observations"]
    assert isinstance(observations, dict)
    assert set(observations) == set(HARNESSES)
    assert set(observations["claude"]) == {
        "fingerprint_sha256",
        "receipt",
        "record_count",
    }
    assert set(observations["codex"]) == {
        "fingerprint_sha256",
        "receipt",
        "record_count",
    }
    assert set(observations["opencode"]) == {
        "fingerprint_sha256",
        "parts_fingerprint_sha256",
        "parts_receipt",
        "receipt",
        "version",
    }
    assert observations["claude"]["record_count"] == 93
    assert observations["codex"]["record_count"] == 805
    assert observations["opencode"]["version"] == "1.17.15"
    for observation in observations.values():
        assert re.fullmatch(r"[0-9a-f]{64}", observation["fingerprint_sha256"])
        assert observation["receipt"].startswith("commands/T06-1-")
    assert re.fullmatch(
        r"[0-9a-f]{64}", observations["opencode"]["parts_fingerprint_sha256"]
    )
    assert observations["opencode"]["parts_receipt"].startswith("commands/T06-1-")
    corpus = provenance["corpus"]
    assert isinstance(corpus, list)
    assert [entry["harness"] for entry in corpus] == list(HARNESSES)
    for entry in corpus:
        expected_keys = {
            "absence_checks",
            "coverage",
            "expected_path",
            "expected_result_derivation",
            "expected_sha256",
            "harness",
            "input_format",
            "input_path",
            "input_sha256",
            "malformed_path",
            "malformed_sha256",
            "observed_schema_fingerprint",
            "provenance_type",
            "representativeness",
            "reviewer",
            "source_kind",
        }
        if entry["harness"] == "claude":
            expected_keys.update(
                {
                    "modern_schema_observation_derivation",
                    "modern_schema_observation_path",
                    "modern_schema_observation_sha256",
                }
            )
        assert set(entry) == expected_keys
        assert entry["absence_checks"] == sorted(ABSENCE_CHECKS)
        assert set(entry["coverage"]) <= COVERAGE_CASES
        assert entry["provenance_type"] == "production-derived"
        assert entry["reviewer"] == "lead-byte-review"
        assert entry["source_kind"] == "owner-scoped metadata-only schema observation"
        assert entry["expected_result_derivation"] == "hand-authored-before-extractor"
        assert (
            entry["observed_schema_fingerprint"]
            == observations[entry["harness"]]["fingerprint_sha256"]
        )
        expected = load_json(FIXTURE_ROOT / entry["expected_path"])
        assert isinstance(expected, dict)
        assert entry["coverage"] == expected["coverage"]
    assert {case for entry in corpus for case in entry["coverage"]} == COVERAGE_CASES

    claude = next(entry for entry in corpus if entry["harness"] == "claude")
    assert claude["modern_schema_observation_derivation"] == (
        "metadata-only structural allowlist from owner-scoped local no-init sessions"
    )
    observation_path = FIXTURE_ROOT / claude["modern_schema_observation_path"]
    assert observation_path.is_file()
    assert sha256(observation_path) == claude["modern_schema_observation_sha256"]


@pytest.mark.parametrize("harness", HARNESSES)
def test_sanitized_inputs_are_strictly_parseable_and_key_allowlisted(
    harness: str,
) -> None:
    input_path = FIXTURE_ROOT / harness / "session.json"
    payload = input_path.read_bytes()
    if harness in {"claude", "codex"}:
        records = [strict_json(line) for line in payload.splitlines() if line]
        parsed: object = records
    else:
        parsed = strict_json(payload)
    assert payload.endswith(b"\n")
    assert parsed

    observed_keys = {key for key, _ in walk(parsed) if key != "$"}
    assert observed_keys <= INPUT_KEYS[harness]


@pytest.mark.parametrize("harness", HARNESSES)
def test_designated_malformed_inputs_have_one_parse_failure(harness: str) -> None:
    malformed_path = FIXTURE_ROOT / harness / "malformed.json"
    payload = malformed_path.read_bytes()
    assert payload.endswith(b"\n")
    with pytest.raises((json.JSONDecodeError, ValueError)):
        strict_json(payload)


@pytest.mark.parametrize("harness", HARNESSES)
def test_expected_semantics_are_complete_and_hand_authored(harness: str) -> None:
    expected = load_json(FIXTURE_ROOT / harness / "expected-semantics.json")
    assert isinstance(expected, dict)
    assert set(expected) == {
        "coverage",
        "derivation",
        "events",
        "harness",
        "identity",
        "schema_version",
    }
    assert expected["schema_version"] == 1
    assert expected["harness"] == harness
    assert expected["identity"] == FIXED_IDENTITIES[harness]
    assert expected["derivation"] == "hand-authored-before-extractor"
    assert set(expected["coverage"]) <= COVERAGE_CASES
    events = expected["events"]
    assert isinstance(events, list)
    assert [event["event_index"] for event in events] == list(range(len(events)))
    assert {event["kind"] for event in events} == CANONICAL_KINDS
    for event in events:
        assert set(event) == {
            "data",
            "event_index",
            "kind",
            "source_ref",
            "text",
            "timestamp_utc",
        }


def test_provenance_hashes_match_every_corpus_file() -> None:
    provenance = load_json(PROVENANCE_PATH)
    assert isinstance(provenance, dict)
    for entry in provenance["corpus"]:
        for path_key, digest_key in (
            ("input_path", "input_sha256"),
            ("expected_path", "expected_sha256"),
            ("malformed_path", "malformed_sha256"),
        ):
            path = FIXTURE_ROOT / entry[path_key]
            assert path.is_file()
            assert sha256(path) == entry[digest_key]


def test_modern_claude_runtime_allowlists_match_sanitized_observation() -> None:
    observation = load_json(FIXTURE_ROOT / "claude/modern-schema-observation.json")
    assert isinstance(observation, dict)
    assert set(observation["observed_control_types"]) == (
        CLAUDE_OBSERVED_MODERN_CONTROL_TYPES
    )
    assert set(observation["observed_system_subtypes"]) == (
        CLAUDE_OBSERVED_MODERN_SYSTEM_SUBTYPES | {"compact_boundary"}
    )
    assert observation["content_identity"] == {
        "all_no_init_content_rows_had_nonempty_session_id": True,
        "no_init_session_count": 5273,
    }
    assert observation["classification_policy"] == (
        "explicit-observed-kind-allowlist-v1"
    )


def test_session_fixture_bytes_contain_no_private_paths_credentials_or_live_ids() -> (
    None
):
    files = [PROVENANCE_PATH]
    files.extend(
        path
        for harness in HARNESSES
        for path in sorted((FIXTURE_ROOT / harness).iterdir())
        if path.is_file()
    )
    assert files
    absolute_path = re.compile(rb"(?:/Users/|/home/|/private/|[A-Za-z]:\\\\)")
    credential = re.compile(
        rb"(?i)(?:password\s*[:=]|api[_-]?key\s*[:=]|bearer\s+|-----BEGIN|sk-[A-Za-z0-9]{10})"
    )
    live_id = re.compile(
        rb"(?i)(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"
    )
    for path in files:
        payload = path.read_bytes()
        assert absolute_path.search(payload) is None
        assert credential.search(payload) is None
        assert live_id.search(payload) is None
        assert b"raw_source_sha256" not in payload
        assert b"source_path" not in payload
        if path.name == "distilled.json":
            derived = load_json(path)
            assert isinstance(derived, dict)
            record = derived["record"]
            assert isinstance(record, dict)
            assert record["native_id"] == FIXED_IDENTITIES[path.parent.name]
        else:
            assert b"native_id" not in payload


def test_prose_is_sanitized_and_skill_command_is_the_only_extra_literal() -> None:
    paths = [PROVENANCE_PATH]
    paths.extend(
        path
        for harness in HARNESSES
        for path in sorted((FIXTURE_ROOT / harness).glob("*.json"))
    )
    skill_command_count = 0
    for path in paths:
        if path.name == "malformed.json":
            continue
        if path.name != "session.json" or path.parent.name == "opencode":
            value = load_json(path)
        else:
            value = [
                strict_json(line) for line in path.read_bytes().splitlines() if line
            ]
        prose = {
            child
            for key, child in walk(value)
            if key in PROSE_KEYS and isinstance(child, str)
        }
        assert prose <= ALLOWED_TEXT_VALUES
        skill_command_count += sum(value == "/brainstorming" for value in prose)
    assert skill_command_count == 1
