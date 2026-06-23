import ast
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


def _return_strings(script: str, function_name: str) -> set[str]:
    path = ROOT / "deploy" / "scripts" / script
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == function_name:
            values: set[str] = set()
            for sub in ast.walk(node):
                if isinstance(sub, ast.Return) and isinstance(sub.value, ast.Constant) and isinstance(sub.value.value, str):
                    values.add(sub.value.value)
            return values
    raise AssertionError(f"{script}:{function_name} not found")


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

        emitted = set()
        emitted |= _return_strings("bot-errors-health-check.py", "classify_source_update_failure")
        emitted |= _return_strings("bot-errors-health-check.py", "classify_provider_probe_failure")
        emitted |= {
            "git_unavailable",
            "provider_compatibility_degraded",
            "provider_compatibility_unsupported",
            "provider_credential_missing",
        }

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


if __name__ == "__main__":
    unittest.main()
