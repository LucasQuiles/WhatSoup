from __future__ import annotations

import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from phonectl.asset_inventory import (
    AssetInventory,
    AssetInventoryError,
    InventoryConflict,
    SensitiveLeak,
)


def fake_phone() -> str:
    return "+1" + "555" + "010" + "0555"


def fake_admin_phone() -> str:
    return "+1" + "555" + "010" + "0666"


def fake_imei() -> str:
    return "35" + "1234567890123"


def fake_iccid() -> str:
    return "89" + "011234567890123456"


def fake_eid() -> str:
    return "89" + "012345678901234567890123456789"


class AssetInventoryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="phonectl-assets-")
        self.root = Path(self.tmp.name)
        self.db_path = self.root / "assets.sqlite3"
        self.key = b"unit-test-local-pepper"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def inventory(self) -> AssetInventory:
        return AssetInventory(self.db_path, hmac_key=self.key, actor="unit-test")

    def trust_note(self) -> Path:
        path = self.root / "trust-note.md"
        path.write_text("owner approved test assignment\n", encoding="utf-8")
        return path

    def test_migration_creates_schema_version_record_and_owner_only_wal_db(self) -> None:
        inv = self.inventory()
        inv.init_db()

        con = sqlite3.connect(self.db_path)
        try:
            tables = {
                row[0]
                for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            self.assertIn("physical_device", tables)
            self.assertIn("sim_profile", tables)
            self.assertIn("device_identifiers", tables)
            self.assertIn("bot_assignment", tables)
            self.assertIn("admin_assignment", tables)
            self.assertIn("network_topology", tables)
            self.assertIn("inventory_event", tables)
            version = con.execute("SELECT version FROM schema_migrations").fetchone()[0]
            journal_mode = con.execute("PRAGMA journal_mode").fetchone()[0].lower()
        finally:
            con.close()

        self.assertEqual(version, 1)
        self.assertEqual(journal_mode, "wal")
        self.assertEqual(stat.S_IMODE(self.db_path.stat().st_mode), 0o600)

    def test_temp_db_injection_and_physical_device_upsert_are_idempotent(self) -> None:
        inv = self.inventory()
        inv.init_db()

        first = inv.upsert_physical_device(
            adb_serial="USB-SERIAL-A",
            manufacturer="motorola",
            model="moto g play - 2026",
            android_release="16",
            android_sdk="36",
            identifiers={"imei_slot1": fake_imei(), "eid": fake_eid()},
            source="unit",
            confidence="observed",
        )
        second = inv.upsert_physical_device(
            adb_serial="USB-SERIAL-A",
            manufacturer="motorola",
            model="moto g play - 2026",
            android_release="16",
            android_sdk="36",
            identifiers={"imei_slot1": fake_imei(), "eid": fake_eid()},
            source="unit",
            confidence="observed",
        )

        self.assertEqual(first["device_id"], second["device_id"])
        self.assertEqual(inv.count("physical_device"), 1)
        self.assertEqual(inv.count("inventory_event"), 2)

    def test_identifier_collisions_fail_closed(self) -> None:
        inv = self.inventory()
        inv.init_db()
        inv.upsert_physical_device(
            adb_serial="USB-SERIAL-A",
            identifiers={"imei_slot1": fake_imei()},
            source="unit",
            confidence="observed",
        )

        with self.assertRaises(InventoryConflict):
            inv.upsert_physical_device(
                adb_serial="USB-SERIAL-B",
                identifiers={"imei_slot1": fake_imei()},
                source="unit",
                confidence="observed",
            )

        with self.assertRaises(InventoryConflict):
            inv.upsert_physical_device(
                adb_serial="USB-SERIAL-A",
                identifiers={"imei_slot1": fake_imei()[:-1] + "9"},
                source="unit",
                confidence="observed",
            )

    def test_sim_and_safe_export_store_raw_but_print_only_redacted_display_and_hmac(self) -> None:
        inv = self.inventory()
        inv.init_db()
        device_id = inv.upsert_physical_device(
            adb_serial="USB-SERIAL-A",
            identifiers={"imei_slot1": fake_imei(), "eid": fake_eid()},
            source="unit",
            confidence="observed",
        )["device_id"]
        inv.upsert_sim_profile(
            sim_kind="esim",
            slot_index=1,
            sim_state="ready",
            iccid=fake_iccid(),
            msisdn=fake_phone(),
            carrier="Tello",
            mcc="310",
            mnc="240",
            subscription_id="sub-" + "1234567890",
            activation_status="candidate",
            assigned_device_id=device_id,
            source="manual",
            confidence="attested",
        )

        raw_db = self.db_path.read_bytes()
        self.assertIn(fake_phone().encode(), raw_db)

        safe = json.dumps(inv.safe_export(), sort_keys=True)
        for raw in (fake_phone(), fake_iccid(), fake_imei(), fake_eid(), "sub-" + "1234567890"):
            self.assertNotIn(raw, safe)
        self.assertIn("ending 0555", safe)
        self.assertIn("hmac_sha256:", safe)
        inv.assert_secret_clean(safe)

    def test_redaction_guard_catches_attempted_stdout_or_artifact_leak(self) -> None:
        inv = self.inventory()
        inv.init_db()
        device_id = inv.upsert_physical_device(
            adb_serial="USB-SERIAL-A",
            identifiers={"imei_slot1": fake_imei()},
            source="unit",
            confidence="observed",
        )["device_id"]
        inv.upsert_sim_profile(
            sim_kind="physical",
            slot_index=0,
            iccid=fake_iccid(),
            msisdn=fake_phone(),
            assigned_device_id=device_id,
            source="manual",
            confidence="attested",
        )

        with self.assertRaises(SensitiveLeak):
            inv.assert_secret_clean(f"leaked line {fake_phone()}")

    def test_bot_assignment_history_closes_old_assignment_on_move(self) -> None:
        inv = self.inventory()
        inv.init_db()
        old_device = inv.upsert_physical_device(adb_serial="OLD-USB", lifecycle_status="banned")["device_id"]
        new_device = inv.upsert_physical_device(adb_serial="NEW-USB", lifecycle_status="staging")["device_id"]
        old_sim = inv.upsert_sim_profile(msisdn=fake_phone(), iccid=fake_iccid(), assigned_device_id=old_device)["sim_id"]
        new_phone = "+1" + "555" + "010" + "0777"
        new_iccid = fake_iccid()[:-1] + "7"
        new_sim = inv.upsert_sim_profile(msisdn=new_phone, iccid=new_iccid, assigned_device_id=new_device)["sim_id"]

        inv.assign_bot(
            bot_slug="ad-bot",
            phone=fake_phone(),
            device_id=old_device,
            sim_profile_id=old_sim,
            service_host="mini10",
            service_port=9097,
            service_name="com.whatsoup.ad-bot",
            status="banned",
            trust_note=self.trust_note(),
            reason_code="seed-banned-line",
        )
        inv.assign_bot(
            bot_slug="ad-bot",
            phone=new_phone,
            device_id=new_device,
            sim_profile_id=new_sim,
            service_host="mini10",
            service_port=9097,
            service_name="com.whatsoup.ad-bot",
            status="staging",
            trust_note=self.trust_note(),
            reason_code="owner-approved-move",
        )

        rows = inv.active_and_historical_assignments("ad-bot")
        self.assertEqual(len(rows), 2)
        self.assertEqual(sum(1 for row in rows if row["active"]), 1)
        self.assertIsNotNone(next(row for row in rows if not row["active"])["assignment_end_at"])

    def test_duplicate_active_bot_or_line_fails_closed_without_policy_override(self) -> None:
        inv = self.inventory()
        inv.init_db()
        d1 = inv.upsert_physical_device(adb_serial="USB-A")["device_id"]
        d2 = inv.upsert_physical_device(adb_serial="USB-B")["device_id"]
        note = self.trust_note()
        inv.assign_bot(bot_slug="ml-bot", phone=fake_phone(), device_id=d1, trust_note=note)

        with self.assertRaises(InventoryConflict):
            inv.assign_bot(bot_slug="ml-bot", phone=fake_phone()[:-1] + "8", device_id=d2, trust_note=note, close_previous=False)

        with self.assertRaises(InventoryConflict):
            inv.assign_bot(bot_slug="ew-bot", phone=fake_phone(), device_id=d2, trust_note=note)

    def test_admin_assignment_supports_unknown_and_number_without_safe_export_leak(self) -> None:
        inv = self.inventory()
        inv.init_db()
        device_id = inv.upsert_physical_device(adb_serial="USB-A")["device_id"]
        inv.upsert_admin_assignment(
            principal_name="Aron",
            admin_phone=fake_admin_phone(),
            role="principal_admin",
            device_id=device_id,
            source="manual",
            verified_at="2026-06-29T12:00:00Z",
        )
        inv.upsert_admin_assignment(
            principal_name=None,
            admin_phone=None,
            role="unknown",
            device_id=device_id,
            source="manual",
            verified_at=None,
        )

        safe = json.dumps(inv.safe_export(), sort_keys=True)
        self.assertIn("Aron", safe)
        self.assertIn("unknown", safe)
        self.assertNotIn(fake_admin_phone(), safe)
        self.assertIn("ending 0666", safe)

    def test_network_endpoint_history_and_wifi_proof_resolution(self) -> None:
        inv = self.inventory()
        inv.init_db()
        device_id = inv.upsert_physical_device(adb_serial="USB-A")["device_id"]

        inv.record_network_topology(device_id=device_id, controlling_host="operator-host", usb_transport_present=True)
        self.assertFalse(inv.wifi_adb_proof(device_id=device_id)["wifi_mandatory_satisfied"])

        inv.record_network_topology(
            device_id=device_id,
            controlling_host="operator-host",
            lan_ip="192.0.2.10",
            port=5555,
            wifi_adb_endpoint="192.0.2.10:5555",
            usb_transport_present=True,
            transport_proof_status="observed",
        )
        proof = inv.wifi_adb_proof(device_id=device_id)
        self.assertTrue(proof["wifi_mandatory_satisfied"])
        self.assertEqual(proof["endpoint"], "192.0.2.10:5555")
        self.assertEqual(inv.count("network_topology"), 2)

    def test_banned_or_retired_device_remains_queryable(self) -> None:
        inv = self.inventory()
        inv.init_db()
        device_id = inv.upsert_physical_device(adb_serial="OLD-AD", lifecycle_status="banned", notes="operator-confirmed banned line")["device_id"]

        row = inv.get_device(device_id)
        self.assertEqual(row["lifecycle_status"], "banned")
        self.assertIn(device_id, [item["device_id"] for item in inv.devices_by_status("banned")])

    def test_artifact_pack_contains_only_safe_inventory_evidence(self) -> None:
        inv = self.inventory()
        inv.init_db()
        device_id = inv.upsert_physical_device(adb_serial="USB-A", identifiers={"imei_slot1": fake_imei()})["device_id"]
        sim_id = inv.upsert_sim_profile(msisdn=fake_phone(), iccid=fake_iccid(), assigned_device_id=device_id)["sim_id"]
        inv.assign_bot(bot_slug="ad-bot", phone=fake_phone(), device_id=device_id, sim_profile_id=sim_id, trust_note=self.trust_note())

        manifest = inv.artifact_pack(self.root / "artifact-pack", bot="ad-bot")
        manifest_text = Path(manifest["manifest_path"]).read_text(encoding="utf-8")
        for raw in (fake_phone(), fake_iccid(), fake_imei()):
            self.assertNotIn(raw, manifest_text)
        self.assertIn("ad-bot", manifest_text)
        self.assertEqual(stat.S_IMODE(Path(manifest["manifest_path"]).stat().st_mode), 0o600)

    def test_cli_bad_args_missing_db_and_corrupt_db_fail_closed_without_traceback(self) -> None:
        env = os.environ.copy()
        env["PYTHONPATH"] = str(Path.cwd())
        env["PHONECTL_ASSET_HMAC_KEY"] = "unit-test-local-pepper"

        bad_args = subprocess.run(
            [sys.executable, "-m", "phonectl.asset_inventory", "--db", str(self.db_path), "assign-bot", "--bot", "ad-bot"],
            cwd=Path.cwd(),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(bad_args.returncode, 64)
        self.assertNotIn("Traceback", bad_args.stderr)

        missing = subprocess.run(
            [sys.executable, "-m", "phonectl.asset_inventory", "--db", str(self.db_path), "export", "--safe-json"],
            cwd=Path.cwd(),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(missing.returncode, 66)
        self.assertNotIn("Traceback", missing.stderr)

        self.db_path.write_text("not sqlite", encoding="utf-8")
        corrupt = subprocess.run(
            [sys.executable, "-m", "phonectl.asset_inventory", "--db", str(self.db_path), "export", "--safe-json"],
            cwd=Path.cwd(),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(corrupt.returncode, 75)
        self.assertNotIn("Traceback", corrupt.stderr)

        mismatch_db = self.root / "mismatch.sqlite3"
        con = sqlite3.connect(mismatch_db)
        con.execute("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)")
        con.execute("INSERT INTO schema_migrations(version, name, applied_at) VALUES (999, 'future', 'now')")
        con.commit()
        con.close()
        mismatch = subprocess.run(
            [sys.executable, "-m", "phonectl.asset_inventory", "--db", str(mismatch_db), "export", "--safe-json"],
            cwd=Path.cwd(),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(mismatch.returncode, 75)
        self.assertNotIn("Traceback", mismatch.stderr)

    def test_cli_proof_gate_reports_inventory_stage_and_wifi_dependency(self) -> None:
        inv = self.inventory()
        inv.init_db()
        device_id = inv.upsert_physical_device(adb_serial="USB-A")["device_id"]
        inv.assign_bot(bot_slug="ad-bot", phone=fake_phone(), device_id=device_id, trust_note=self.trust_note())
        env = os.environ.copy()
        env["PYTHONPATH"] = str(Path.cwd())
        env["PHONECTL_ASSET_HMAC_KEY"] = "unit-test-local-pepper"

        proof = subprocess.run(
            [sys.executable, "-m", "phonectl.asset_inventory", "--db", str(self.db_path), "proof-gate", "--bot", "ad-bot", "--json"],
            cwd=Path.cwd(),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(proof.returncode, 0, proof.stderr)
        payload = json.loads(proof.stdout)
        self.assertEqual(payload["stages"]["inventory_presence"], "PASS")
        self.assertEqual(payload["stages"]["wifi_adb_proof"], "DEPENDENCY")
        self.assertNotIn(fake_phone(), proof.stdout)

    def test_cli_assign_bot_resolves_device_serial_to_canonical_device_id(self) -> None:
        env = os.environ.copy()
        env["PYTHONPATH"] = str(Path.cwd())
        env["PHONECTL_ASSET_HMAC_KEY"] = "unit-test-local-pepper"
        trust_note = self.trust_note()

        init = subprocess.run(
            [sys.executable, "-m", "phonectl.asset_inventory", "--db", str(self.db_path), "init"],
            cwd=Path.cwd(),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(init.returncode, 0, init.stderr)
        upsert = subprocess.run(
            [
                sys.executable,
                "-m",
                "phonectl.asset_inventory",
                "--db",
                str(self.db_path),
                "upsert-device",
                "--adb-serial",
                "USB-SERIAL-A",
                "--lifecycle-status",
                "staging",
                "--json",
            ],
            cwd=Path.cwd(),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(upsert.returncode, 0, upsert.stderr)
        device_id = json.loads(upsert.stdout)["device_id"]

        assign = subprocess.run(
            [
                sys.executable,
                "-m",
                "phonectl.asset_inventory",
                "--db",
                str(self.db_path),
                "assign-bot",
                "--bot",
                "ad-bot",
                "--device",
                "USB-SERIAL-A",
                "--phone",
                fake_phone(),
                "--trust-note",
                str(trust_note),
                "--json",
            ],
            cwd=Path.cwd(),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(assign.returncode, 0, assign.stderr)
        self.assertNotIn(fake_phone(), assign.stdout)

        con = sqlite3.connect(self.db_path)
        try:
            row = con.execute("SELECT device_id FROM bot_assignment WHERE bot_slug='ad-bot' AND active=1").fetchone()
        finally:
            con.close()
        self.assertEqual(row[0], device_id)

    def test_cli_init_discover_export_and_verify_print_safe_json(self) -> None:
        fake_adb = self.root / "adb"
        fake_adb.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import sys
                prop = sys.argv[-1]
                values = {
                    "ro.product.manufacturer": "motorola",
                    "ro.product.model": "moto g play - 2026",
                    "ro.build.version.release": "16",
                    "ro.build.version.sdk": "36",
                    "ro.build.fingerprint": "motorola/nevada_g/nevada:16/BUILD/test:user/release-keys",
                    "ro.boot.hardware.sku": "XT2615V",
                    "ro.product.name": "nevada_g_sys",
                    "ro.product.board": "nevada",
                    "ro.serialno": "USB-SERIAL-A",
                }
                print(values.get(prop, ""))
                """
            ),
            encoding="utf-8",
        )
        fake_adb.chmod(0o700)
        env = os.environ.copy()
        env["PYTHONPATH"] = str(Path.cwd())
        env["PHONECTL_ASSET_HMAC_KEY"] = "unit-test-local-pepper"
        env["PHONECTL_ADB"] = str(fake_adb)

        init = subprocess.run(
            [sys.executable, "-m", "phonectl.asset_inventory", "--db", str(self.db_path), "init"],
            cwd=Path.cwd(),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(init.returncode, 0, init.stderr)

        discover = subprocess.run(
            [
                sys.executable,
                "-m",
                "phonectl.asset_inventory",
                "--db",
                str(self.db_path),
                "discover",
                "--adb-target",
                "USB-SERIAL-A",
                "--host",
                "operator-host",
                "--json",
            ],
            cwd=Path.cwd(),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(discover.returncode, 0, discover.stderr)
        payload = json.loads(discover.stdout)
        self.assertEqual(payload["device"]["adb_serial"], "USB-SERIAL-A")

        safe = subprocess.run(
            [sys.executable, "-m", "phonectl.asset_inventory", "--db", str(self.db_path), "export", "--safe-json"],
            cwd=Path.cwd(),
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(safe.returncode, 0, safe.stderr)
        self.assertIn("moto g play - 2026", safe.stdout)

    def test_discover_treats_wifi_adb_endpoint_as_transport_not_identity(self) -> None:
        fake_adb = self.root / "adb"
        fake_adb.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import sys
                prop = sys.argv[-1]
                values = {
                    "ro.product.manufacturer": "motorola",
                    "ro.product.model": "moto g play - 2026",
                    "ro.build.version.release": "16",
                    "ro.build.version.sdk": "36",
                    "ro.serialno": "USB-SERIAL-A",
                }
                print(values.get(prop, ""))
                """
            ),
            encoding="utf-8",
        )
        fake_adb.chmod(0o700)
        inv = self.inventory()
        inv.init_db()

        usb = inv.discover(adb_target="USB-SERIAL-A", host="operator-host", adb_path=str(fake_adb))
        wifi = inv.discover(adb_target="192.0.2.44:5555", host="operator-host", adb_path=str(fake_adb))

        self.assertEqual(usb["device"]["device_id"], wifi["device"]["device_id"])
        proof = inv.wifi_adb_proof(device_id=usb["device"]["device_id"])
        self.assertTrue(proof["wifi_mandatory_satisfied"])
        self.assertEqual(proof["endpoint"], "192.0.2.44:5555")
        self.assertEqual(inv.count("physical_device"), 1)

    def test_adb_getprop_wraps_missing_binary_as_asset_inventory_error(self) -> None:
        # L4 falsifier: a missing/non-executable adb binary must surface as the typed
        # AssetInventoryError, never as a raw OSError/FileNotFoundError escaping the method.
        inv = self.inventory()
        inv.init_db()
        missing_adb = str(self.root / "no-such-adb-binary")

        with self.assertRaises(AssetInventoryError):
            inv._adb_getprop(missing_adb, "USB-SERIAL-A", "ro.product.manufacturer")

    def test_discover_wraps_missing_adb_binary_as_asset_inventory_error(self) -> None:
        # Same falsifier through the real call path (discover() -> _adb_getprop()).
        inv = self.inventory()
        inv.init_db()
        missing_adb = str(self.root / "no-such-adb-binary")

        with self.assertRaises(AssetInventoryError):
            inv.discover(adb_target="USB-SERIAL-A", host="operator-host", adb_path=missing_adb)

    def test_secure_export_fails_closed_until_encryption_backend_is_implemented(self) -> None:
        inv = self.inventory()
        inv.init_db()
        out = self.root / "secure-export.json"

        with self.assertRaises(NotImplementedError):
            inv.secure_export(out)
        self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
