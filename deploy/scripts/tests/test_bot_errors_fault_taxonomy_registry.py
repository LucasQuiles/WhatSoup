from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REGISTRY = ROOT / "src" / "lib" / "fault-taxonomy-registry.json"
EXPECTED_RUNTIME_AGENT_NUMERIC_HEALTH_FIELDS = (
    "activeSessions",
    "sessionCount",
    "recentCrashes",
    "pollPersistenceErrors",
    "autoCompactIneffective",
    "autoCompactConsecutiveRapidRearmsMax",
    "autoCompactNextTurnOverThreshold",
    "autoCompactActiveBackoffScopes",
    "autoCompactWorstCurrentBackoffTier",
    "turnFinalizationDegradedScopes",
    "turnRecoveryOutstanding",
    "turnRecoveryPending",
    "turnRecoveryExpiredClaimed",
    "turnRecoveryBlockedUnsafe",
    "turnRecoveryExhausted",
    "turnRecoveryOpenRecoveries",
    "turnRecoveryQuarantinedDelivery",
    "turnRecoveryCorruptLinks",
    "turnRecoveryOrphanTransfers",
    "turnRecoveryEchoConflicts",
    "turnFinalizationRetainedRetries",
    "turnFinalizationRetryAttempts",
    "turnFinalizationRetryRecoveries",
    "turnFinalizationRetryExhaustions",
    "turnRecoveryLiveClaimed",
)


def _load_registry() -> dict:
    with REGISTRY.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _load_script_module(script: str):
    path = ROOT / "deploy" / "scripts" / script
    spec = importlib.util.spec_from_file_location(script.replace("-", "_"), path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _non_null(values: list[str | None]) -> set[str]:
    return {value for value in values if value is not None}


class FaultTaxonomyRegistryTest(unittest.TestCase):
    def test_runtime_agent_health_signals_cover_checker_inventory(self):
        registry = _load_registry()
        signals = registry["runtimeAgentHealthSignals"]
        fields = [entry["field"] for entry in signals]
        labels = [entry["label"] for entry in signals]

        self.assertEqual(registry["schema"], "whatsoup-fault-taxonomy-registry-v3")
        self.assertEqual(fields, list(EXPECTED_RUNTIME_AGENT_NUMERIC_HEALTH_FIELDS))
        self.assertEqual(len(fields), len(set(fields)))
        self.assertEqual(len(labels), len(set(labels)))
        self.assertEqual(
            {entry["kind"] for entry in signals},
            {
                "current_gauge",
                "active_episode_count",
                "terminal_audit_count",
                "cumulative_total",
                "historical_maximum",
            },
        )
        self.assertEqual(
            {entry["currentHealthEffect"] for entry in signals},
            {"positive_is_risk", "diagnostic_only"},
        )

    def test_terminal_auth_failure_classes_are_registered_and_aligned(self):
        registry = _load_registry()
        expected = set(registry["authFailureClasses"])

        health = _load_script_module("bot-errors-health-check.py")
        dispatcher = _load_script_module("bot-errors-dispatcher.py")
        watchdog = _load_script_module("bot-errors-heartbeat-watchdog.py")

        self.assertEqual(health.TERMINAL_AUTH_FAILURE_CLASSES, expected)
        self.assertEqual(dispatcher.TERMINAL_AUTH_FAILURE_CLASSES, expected)
        self.assertEqual(watchdog.TERMINAL_AUTH_FAILURE_CLASSES, expected)

    def test_provider_and_source_update_failure_classes_have_registry_dispositions(self):
        registry = _load_registry()
        dispositions = set(registry["failureClassDispositions"])
        health = _load_script_module("bot-errors-health-check.py")

        emitted = _non_null([
            health.classify_source_update_failure("", 1, True),
            health.classify_source_update_failure("", 0, False),
            health.classify_source_update_failure("Permission denied (publickey)", 1, False),
            health.classify_source_update_failure("Could not resolve host: github.com", 1, False),
            health.classify_source_update_failure("Network is unreachable", 1, False),
            health.classify_source_update_failure("fatal: not a git repository", 1, False),
            health.classify_source_update_failure("remote: Repository not found.", 1, False),
            health.classify_source_update_failure("ssh: connect failed", 1, False),
            health.classify_provider_probe_failure("", 1, True),
            health.classify_provider_probe_failure("not logged in", 1, False),
            health.classify_provider_probe_failure("usage limit reached; reset tomorrow", 1, False),
            health.classify_provider_probe_failure("rate limit 429", 1, False),
            health.classify_provider_probe_failure("unexpected failure", 1, False),
            health.classify_provider_probe_failure("", 0, False),
        ])
        # These classes are emitted as structured health lines outside the two
        # classifier helpers above. Keep the line-emission classes explicit so the
        # registry cannot silently drop their disposition metadata.
        line_embedded_classes = {
            "git_unavailable",
            "provider_compatibility_degraded",
            "provider_compatibility_unsupported",
            "provider_credential_missing",
        }
        emitted |= line_embedded_classes

        missing = sorted(emitted - dispositions)
        self.assertEqual(missing, [], f"missing failureClassDispositions: {missing}")

    def test_dispatcher_source_sets_have_registry_dispositions(self):
        registry = _load_registry()
        dispositions = set(registry["sourceDispositions"])
        dispatcher = _load_script_module("bot-errors-dispatcher.py")

        emitted = set(dispatcher.DAILY_HEALTH_WHATSAPP_RECOVERY_SOURCES)
        emitted |= set(dispatcher.DAILY_HEALTH_REQUIRES_OUTBOUND_PROOF_SOURCES)
        emitted |= set(dispatcher.SUPERSEDED_SOURCES_BY_ALERT_SOURCE)
        for symptoms in dispatcher.SUPERSEDED_SOURCES_BY_ALERT_SOURCE.values():
            emitted |= set(symptoms)
        emitted |= {dispatcher.RELAY_DOWN_SOURCE, dispatcher.RELAY_RECOVERED_SOURCE}
        emitted |= set(dispatcher.TRANSIENT_SOURCES)

        missing = sorted(emitted - dispositions)
        self.assertEqual(missing, [], f"missing sourceDispositions: {missing}")

    def test_registry_owner_and_test_references_exist(self):
        registry = _load_registry()
        missing: list[str] = []

        for entry in registry["faultClasses"]:
            owner = ROOT / entry["owner"]
            if not owner.exists():
                missing.append(f"faultClasses.{entry['id']}.owner={entry['owner']}")
            for test_path in entry["tests"]:
                if not (ROOT / test_path).exists():
                    missing.append(f"faultClasses.{entry['id']}.tests={test_path}")

        for key, entry in registry["failureDomains"].items():
            owner = ROOT / entry["owner"]
            test_path = ROOT / entry["test"]
            if not owner.exists():
                missing.append(f"failureDomains.{key}.owner={entry['owner']}")
            if not test_path.exists():
                missing.append(f"failureDomains.{key}.test={entry['test']}")

        for entry in registry["runtimeAgentHealthSignals"]:
            owner = ROOT / entry["owner"]
            test_path = ROOT / entry["test"]
            if not owner.exists():
                missing.append(
                    f"runtimeAgentHealthSignals.{entry['field']}.owner={entry['owner']}"
                )
            if not test_path.exists():
                missing.append(
                    f"runtimeAgentHealthSignals.{entry['field']}.test={entry['test']}"
                )

        for section in ("failureClassDispositions", "sourceDispositions"):
            for key, entry in registry[section].items():
                owner = ROOT / entry["owner"]
                test_path = ROOT / entry["test"]
                if not owner.exists():
                    missing.append(f"{section}.{key}.owner={entry['owner']}")
                if not test_path.exists():
                    missing.append(f"{section}.{key}.test={entry['test']}")

        self.assertEqual(missing, [], f"missing registry references: {missing}")

    def test_turn_recovery_deadman_source_has_semantic_alert_clear_owner(self):
        entry = _load_registry()["sourceDispositions"][
            "turn_recovery_supervisor_unavailable"
        ]
        self.assertEqual(
            entry,
            {
                "disposition": "recovery_consumer_unavailable_until_successful_scan",
                "owner": "src/runtimes/agent/turn-recovery-deadman.ts",
                "test": "tests/runtimes/agent/turn-recovery-deadman.test.ts",
            },
        )


if __name__ == "__main__":
    unittest.main()
