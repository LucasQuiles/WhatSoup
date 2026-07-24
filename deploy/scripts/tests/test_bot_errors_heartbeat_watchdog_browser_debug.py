from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-heartbeat-watchdog.py"
SPEC = importlib.util.spec_from_file_location("bot_errors_heartbeat_watchdog_browser_debug", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
WATCHDOG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WATCHDOG)


class BrowserDebugSnapshotTests(unittest.TestCase):
    def test_live_snapshot_aggregates_only_the_root_descendant_tree(self) -> None:
        private_profile = "/private/operator/browser-profile"
        records = {
            100: {
                "pid": 100,
                "ppid": 1,
                "args": [
                    "/opt/browser/chrome",
                    "--remote-debugging-port=9334",
                    f"--user-data-dir={private_profile}",
                ],
                "ageSeconds": 4200.0,
                "rssMb": 500.0,
            },
            101: {
                "pid": 101,
                "ppid": 100,
                "args": ["/opt/browser/chrome", "--type=zygote"],
                "ageSeconds": 4199.0,
                "rssMb": 100.0,
            },
            102: {
                "pid": 102,
                "ppid": 101,
                "args": ["/opt/browser/chrome", "--type=renderer"],
                "ageSeconds": 4198.0,
                "rssMb": 700.0,
            },
            200: {
                "pid": 200,
                "ppid": 1,
                "args": ["/opt/browser/chrome", "--type=renderer"],
                "ageSeconds": 3000.0,
                "rssMb": 900.0,
            },
        }

        with (
            patch.object(WATCHDOG, "_proc_processes", return_value=(records, None)),
            patch.object(WATCHDOG, "_established_debug_connections", return_value=({9334: 0}, None)),
        ):
            rows, error = WATCHDOG.browser_debug_snapshot()

        self.assertIsNone(error)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["pid"], 100)
        self.assertEqual(rows[0]["processCount"], 3)
        self.assertEqual(rows[0]["rssMb"], 1300.0)
        self.assertEqual(rows[0]["controllerConnections"], 0)
        self.assertNotIn(private_profile, str(rows[0]))
        self.assertRegex(rows[0]["profileHash"], r"^[0-9a-f]{12}$")

    def test_connection_inventory_failure_preserves_uncertainty(self) -> None:
        records = {
            100: {
                "pid": 100,
                "ppid": 1,
                "args": ["/opt/browser/chrome", "--remote-debugging-port", "9334"],
                "ageSeconds": 4200.0,
                "rssMb": 700.0,
            },
        }
        with (
            patch.object(WATCHDOG, "_proc_processes", return_value=(records, None)),
            patch.object(
                WATCHDOG,
                "_established_debug_connections",
                return_value=({9334: 0}, "controller connection inventory unavailable"),
            ),
        ):
            rows, error = WATCHDOG.browser_debug_snapshot()

        self.assertEqual(error, "controller connection inventory unavailable")
        self.assertIsNone(rows[0]["controllerConnections"])
        with patch.object(WATCHDOG, "browser_debug_snapshot", return_value=(rows, error)):
            problems = WATCHDOG.browser_debug_problems()
        self.assertEqual(list(problems), [WATCHDOG.BROWSER_DEBUG_PROBE_KEY])
        self.assertNotIn("session unattended", problems[WATCHDOG.BROWSER_DEBUG_PROBE_KEY])

    def test_process_inventory_failure_is_visible_without_claiming_an_orphan(self) -> None:
        error = "browser process inventory unavailable"
        with patch.object(WATCHDOG, "browser_debug_snapshot", return_value=([], error)):
            problems = WATCHDOG.browser_debug_problems()

        self.assertEqual(list(problems), [WATCHDOG.BROWSER_DEBUG_PROBE_KEY])
        self.assertIn("process inventory unavailable", problems[WATCHDOG.BROWSER_DEBUG_PROBE_KEY])
        self.assertIn("controller_connections=unknown", problems[WATCHDOG.BROWSER_DEBUG_PROBE_KEY])
        self.assertNotIn("session unattended", problems[WATCHDOG.BROWSER_DEBUG_PROBE_KEY])

    def test_many_controlled_sessions_do_not_create_alerts(self) -> None:
        rows = [
            {
                "pid": 1000 + index,
                "ageSeconds": 7200.0,
                "rssMb": 1024.0,
                "processCount": 8,
                "debugPort": 10000 + index,
                "controllerConnections": 1,
                "profileHash": f"profile{index}",
            }
            for index in range(500)
        ]
        with patch.object(WATCHDOG, "browser_debug_snapshot", return_value=(rows, None)):
            self.assertEqual(WATCHDOG.browser_debug_problems(), {})

    def test_controller_inventory_counts_only_the_local_debug_endpoint(self) -> None:
        result = SimpleNamespace(
            returncode=0,
            stdout=(
                "0 0 127.0.0.1:50000 127.0.0.1:9334\n"
                "0 0 127.0.0.1:9334 127.0.0.1:50001\n"
            ),
        )
        with patch.object(WATCHDOG.subprocess, "run", return_value=result):
            counts, error = WATCHDOG._established_debug_connections({9334})

        self.assertIsNone(error)
        self.assertEqual(counts, {9334: 1})


if __name__ == "__main__":
    unittest.main()
