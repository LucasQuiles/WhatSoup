from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
REGISTRY = ROOT / "src" / "lib" / "fault-taxonomy-registry.json"


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

        for section in ("failureClassDispositions", "sourceDispositions"):
            for key, entry in registry[section].items():
                owner = ROOT / entry["owner"]
                test_path = ROOT / entry["test"]
                if not owner.exists():
                    missing.append(f"{section}.{key}.owner={entry['owner']}")
                if not test_path.exists():
                    missing.append(f"{section}.{key}.test={entry['test']}")

        self.assertEqual(missing, [], f"missing registry references: {missing}")


if __name__ == "__main__":
    unittest.main()
