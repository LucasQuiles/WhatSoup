from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
import subprocess
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable


SCHEMA_VERSION = 1
DEFAULT_DB_PATH = Path.home() / ".phonectl" / "state" / "assets.sqlite3"
DEFAULT_HMAC_KEY_PATH = Path.home() / ".phonectl" / "state" / "assets.hmac.key"

EXIT_USAGE = 64
EXIT_CONFLICT = 65
EXIT_NOT_FOUND = 66
EXIT_SECRET_LEAK = 70
EXIT_DB = 75
EXIT_CONFIG = 78

SENSITIVE_COLUMNS = {
    "msisdn",
    "iccid",
    "imei_slot1",
    "imei_slot2",
    "esim_imei",
    "eid",
    "meid",
    "subscription_id",
    "admin_phone",
    "assigned_phone",
    "auth_dir_path",
    "whatsapp_jid",
    "whatsapp_lid",
}

LIFECYCLE_STATUSES = {"active", "staging", "spare", "banned", "retired", "lost", "repair", "unknown"}
BOT_STATUSES = {"active", "staging", "banned", "degraded", "retired", "unknown"}
CONFIDENCE_LEVELS = {"observed", "attested", "inferred", "unknown"}


class AssetInventoryError(Exception):
    exit_code = EXIT_CONFIG


class InventoryConflict(AssetInventoryError):
    exit_code = EXIT_CONFLICT


class InventoryNotFound(AssetInventoryError):
    exit_code = EXIT_NOT_FOUND


class InventoryDatabaseError(AssetInventoryError):
    exit_code = EXIT_DB


class SensitiveLeak(AssetInventoryError):
    exit_code = EXIT_SECRET_LEAK


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_blank(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def canonical_sensitive(value: str | None) -> str | None:
    text = normalize_blank(value)
    if text is None:
        return None
    return re.sub(r"[\s().-]+", "", text).lower()


def display_value(value: str | None) -> str | None:
    text = normalize_blank(value)
    if text is None:
        return None
    digits = re.sub(r"\D", "", text)
    if len(digits) >= 4:
        return f"ending {digits[-4:]}"
    if len(text) <= 4:
        return f"ending {text}"
    return f"ending {text[-4:]}"


def safe_segment(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "-", value.strip()).strip("-")
    return cleaned[:96] if cleaned else "unknown"


def parse_adb_wifi_endpoint(value: str) -> tuple[str, int] | None:
    match = re.fullmatch(r"([^:\s]+):(\d{1,5})", value.strip())
    if not match:
        return None
    port = int(match.group(2))
    if port < 1 or port > 65535:
        return None
    return match.group(1), port


def private_mkdir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise AssetInventoryError(f"refusing to use private directory through symlink: {path}")
    if not path.is_dir():
        raise AssetInventoryError(f"refusing to use private directory over non-directory path: {path}")
    os.chmod(path, 0o700)


def write_private_json(path: Path, value: Any) -> None:
    private_mkdir(path.parent)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
        raise


def load_hmac_key(explicit: bytes | str | None = None) -> bytes:
    if isinstance(explicit, bytes):
        return explicit
    if isinstance(explicit, str):
        return explicit.encode("utf-8")
    env = os.environ.get("PHONECTL_ASSET_HMAC_KEY")
    if env:
        return env.encode("utf-8")
    private_mkdir(DEFAULT_HMAC_KEY_PATH.parent)
    if DEFAULT_HMAC_KEY_PATH.exists():
        return DEFAULT_HMAC_KEY_PATH.read_bytes().strip()
    key = base64.urlsafe_b64encode(os.urandom(32))
    fd = os.open(DEFAULT_HMAC_KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(key + b"\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(DEFAULT_HMAC_KEY_PATH, 0o600)
    return key


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


@dataclass(frozen=True)
class AdbFact:
    prop: str
    field: str


ADB_PROPS = [
    AdbFact("ro.product.manufacturer", "manufacturer"),
    AdbFact("ro.product.model", "model"),
    AdbFact("ro.build.version.release", "android_release"),
    AdbFact("ro.build.version.sdk", "android_sdk"),
    AdbFact("ro.build.fingerprint", "build_fingerprint"),
    AdbFact("ro.boot.hardware.sku", "hardware_sku"),
    AdbFact("ro.product.name", "product"),
    AdbFact("ro.product.board", "board"),
    AdbFact("ro.serialno", "ro_serialno"),
]


class AssetInventory:
    def __init__(
        self,
        db_path: str | Path | None = None,
        *,
        hmac_key: bytes | str | None = None,
        actor: str = "phonectl",
        now: Callable[[], str] = utc_now,
    ) -> None:
        self.db_path = Path(db_path) if db_path is not None else Path(os.environ.get("PHONECTL_ASSET_DB", DEFAULT_DB_PATH))
        self.hmac_key = load_hmac_key(hmac_key)
        self.actor = actor
        self.now = now

    def hmac_value(self, value: str | None) -> str | None:
        canonical = canonical_sensitive(value)
        if canonical is None:
            return None
        digest = hmac.new(self.hmac_key, canonical.encode("utf-8"), hashlib.sha256).hexdigest()
        return f"hmac_sha256:{digest}"

    def init_db(self) -> None:
        private_mkdir(self.db_path.parent)
        con = self._connect(create=True)
        try:
            self._apply_migrations(con)
            con.commit()
        finally:
            con.close()
        self._chmod_sqlite_files()

    def _connect(self, *, create: bool = False) -> sqlite3.Connection:
        if not create and not self.db_path.exists():
            raise InventoryNotFound(f"inventory database missing: {self.db_path}")
        try:
            con = sqlite3.connect(self.db_path)
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA foreign_keys=ON")
            con.execute("PRAGMA busy_timeout=5000")
            con.execute("PRAGMA journal_mode=WAL")
            return con
        except sqlite3.DatabaseError as exc:
            raise InventoryDatabaseError(f"inventory database unavailable: {exc}") from exc

    def _require_ready(self) -> sqlite3.Connection:
        con = self._connect(create=False)
        try:
            row = con.execute(
                "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
            ).fetchone()
        except sqlite3.DatabaseError as exc:
            con.close()
            raise InventoryDatabaseError(f"inventory migration table unavailable: {exc}") from exc
        if row is None or int(row["version"]) != SCHEMA_VERSION:
            con.close()
            observed = "none" if row is None else row["version"]
            raise InventoryDatabaseError(f"inventory schema version mismatch: expected={SCHEMA_VERSION} observed={observed}")
        return con

    def _apply_migrations(self, con: sqlite3.Connection) -> None:
        try:
            con.executescript(MIGRATION_1)
            con.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                (SCHEMA_VERSION, "asset-inventory-v1", self.now()),
            )
        except sqlite3.DatabaseError as exc:
            raise InventoryDatabaseError(f"inventory migration failed: {exc}") from exc

    def _chmod_sqlite_files(self) -> None:
        for path in (self.db_path, Path(f"{self.db_path}-wal"), Path(f"{self.db_path}-shm")):
            if path.exists():
                os.chmod(path, 0o600)

    def count(self, table: str) -> int:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", table):
            raise AssetInventoryError("invalid table name")
        con = self._require_ready()
        try:
            return int(con.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"])
        finally:
            con.close()

    def upsert_physical_device(
        self,
        *,
        adb_serial: str | None = None,
        asset_tag: str | None = None,
        manufacturer: str | None = None,
        model: str | None = None,
        android_release: str | None = None,
        android_sdk: str | None = None,
        build_fingerprint: str | None = None,
        hardware_sku: str | None = None,
        product: str | None = None,
        board: str | None = None,
        ro_serialno: str | None = None,
        lifecycle_status: str = "unknown",
        notes: str | None = None,
        source: str = "manual",
        confidence: str = "unknown",
        identifiers: dict[str, str | None] | None = None,
    ) -> dict[str, Any]:
        lifecycle_status = self._validate_choice(lifecycle_status, LIFECYCLE_STATUSES, "lifecycle_status")
        confidence = self._validate_choice(confidence, CONFIDENCE_LEVELS, "confidence")
        identifiers = identifiers or {}
        con = self._require_ready()
        try:
            con.execute("BEGIN IMMEDIATE")
            existing_id = self._resolve_existing_device(con, adb_serial, ro_serialno, identifiers)
            now = self.now()
            before = self._device_snapshot(con, existing_id) if existing_id else None
            device_id = existing_id or str(uuid.uuid4())
            if existing_id:
                con.execute(
                    """
                    UPDATE physical_device
                       SET asset_tag=COALESCE(?, asset_tag),
                           manufacturer=COALESCE(?, manufacturer),
                           model=COALESCE(?, model),
                           android_release=COALESCE(?, android_release),
                           android_sdk=COALESCE(?, android_sdk),
                           build_fingerprint=COALESCE(?, build_fingerprint),
                           hardware_sku=COALESCE(?, hardware_sku),
                           product=COALESCE(?, product),
                           board=COALESCE(?, board),
                           adb_serial=COALESCE(?, adb_serial),
                           ro_serialno=COALESCE(?, ro_serialno),
                           lifecycle_status=?,
                           notes=COALESCE(?, notes),
                           source=?,
                           confidence=?,
                           last_seen=?,
                           updated_at=?
                     WHERE device_id=?
                    """,
                    (
                        asset_tag,
                        manufacturer,
                        model,
                        android_release,
                        android_sdk,
                        build_fingerprint,
                        hardware_sku,
                        product,
                        board,
                        adb_serial,
                        ro_serialno,
                        lifecycle_status,
                        notes,
                        source,
                        confidence,
                        now,
                        now,
                        device_id,
                    ),
                )
            else:
                con.execute(
                    """
                    INSERT INTO physical_device(
                        device_id, asset_tag, manufacturer, model, android_release, android_sdk,
                        build_fingerprint, hardware_sku, product, board, adb_serial, ro_serialno,
                        lifecycle_status, notes, source, confidence, first_seen, last_seen, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        device_id,
                        asset_tag,
                        manufacturer,
                        model,
                        android_release,
                        android_sdk,
                        build_fingerprint,
                        hardware_sku,
                        product,
                        board,
                        adb_serial,
                        ro_serialno,
                        lifecycle_status,
                        notes,
                        source,
                        confidence,
                        now,
                        now,
                        now,
                        now,
                    ),
                )
            if adb_serial:
                con.execute(
                    "INSERT OR IGNORE INTO device_usb_serial(device_id, adb_serial, first_seen, last_seen, source) VALUES (?, ?, ?, ?, ?)",
                    (device_id, adb_serial, now, now, source),
                )
                con.execute(
                    "UPDATE device_usb_serial SET last_seen=?, source=? WHERE device_id=? AND adb_serial=?",
                    (now, source, device_id, adb_serial),
                )
            self._upsert_device_identifiers(con, device_id, identifiers | {"serial_number": ro_serialno})
            after = self._device_snapshot(con, device_id)
            self._record_event(
                con,
                event_type="device_upsert",
                entity_type="physical_device",
                entity_id=device_id,
                before=before,
                after=after,
                source=source,
                confidence=confidence,
                reason_code="upsert-device",
            )
            con.commit()
            return {"device_id": device_id, "adb_serial": adb_serial, "lifecycle_status": lifecycle_status}
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def _resolve_existing_device(
        self,
        con: sqlite3.Connection,
        adb_serial: str | None,
        ro_serialno: str | None,
        identifiers: dict[str, str | None],
    ) -> str | None:
        candidates: set[str] = set()
        if adb_serial:
            row = con.execute("SELECT device_id FROM physical_device WHERE adb_serial=?", (adb_serial,)).fetchone()
            if row:
                candidates.add(row["device_id"])
        if ro_serialno:
            row = con.execute("SELECT device_id FROM physical_device WHERE ro_serialno=?", (ro_serialno,)).fetchone()
            if row:
                candidates.add(row["device_id"])
        for field in ("imei_slot1", "imei_slot2", "esim_imei", "eid", "meid", "serial_number", "android_id"):
            digest = self.hmac_value(identifiers.get(field))
            if digest:
                row = con.execute(f"SELECT device_id FROM device_identifiers WHERE {field}_hash=?", (digest,)).fetchone()
                if row:
                    candidates.add(row["device_id"])
        if len(candidates) > 1:
            raise InventoryConflict(f"device identity collision across candidates: {sorted(candidates)}")
        device_id = next(iter(candidates), None)
        if device_id:
            physical = con.execute("SELECT adb_serial, ro_serialno FROM physical_device WHERE device_id=?", (device_id,)).fetchone()
            if physical:
                if adb_serial and physical["adb_serial"] and adb_serial != physical["adb_serial"]:
                    raise InventoryConflict(f"conflicting adb_serial for existing device {device_id}")
                if ro_serialno and physical["ro_serialno"] and ro_serialno != physical["ro_serialno"]:
                    raise InventoryConflict(f"conflicting ro_serialno for existing device {device_id}")
            existing = con.execute("SELECT * FROM device_identifiers WHERE device_id=?", (device_id,)).fetchone()
            if existing:
                for field in ("imei_slot1", "imei_slot2", "esim_imei", "eid", "meid", "serial_number", "android_id"):
                    new_hash = self.hmac_value(identifiers.get(field))
                    old_hash = existing[f"{field}_hash"]
                    if new_hash and old_hash and new_hash != old_hash:
                        raise InventoryConflict(f"conflicting {field} for existing device {device_id}")
        return device_id

    def _resolve_device_reference(self, con: sqlite3.Connection, reference: str | None) -> str | None:
        ref = normalize_blank(reference)
        if ref is None:
            return None
        rows = []
        for sql, params in (
            ("SELECT device_id FROM physical_device WHERE device_id=?", (ref,)),
            ("SELECT device_id FROM physical_device WHERE asset_tag=?", (ref,)),
            ("SELECT device_id FROM physical_device WHERE adb_serial=?", (ref,)),
            ("SELECT device_id FROM physical_device WHERE ro_serialno=?", (ref,)),
            ("SELECT device_id FROM device_usb_serial WHERE adb_serial=?", (ref,)),
        ):
            rows.extend(con.execute(sql, params).fetchall())
        candidates = {row["device_id"] for row in rows}
        if len(candidates) > 1:
            raise InventoryConflict(f"device reference is ambiguous: {ref}")
        if not candidates:
            raise InventoryNotFound(f"device reference not found: {ref}")
        return next(iter(candidates))

    def _resolve_sim_reference(self, con: sqlite3.Connection, reference: str | None) -> str | None:
        ref = normalize_blank(reference)
        if ref is None:
            return None
        candidates: set[str] = set()
        row = con.execute("SELECT sim_id FROM sim_profile WHERE sim_id=?", (ref,)).fetchone()
        if row:
            candidates.add(row["sim_id"])
        ref_hash = self.hmac_value(ref)
        if ref_hash:
            for field in ("iccid_hash", "msisdn_hash", "subscription_id_hash"):
                row = con.execute(f"SELECT sim_id FROM sim_profile WHERE {field}=?", (ref_hash,)).fetchone()
                if row:
                    candidates.add(row["sim_id"])
        if len(candidates) > 1:
            raise InventoryConflict("SIM reference is ambiguous")
        if not candidates:
            raise InventoryNotFound("SIM reference not found")
        return next(iter(candidates))

    def _upsert_device_identifiers(self, con: sqlite3.Connection, device_id: str, identifiers: dict[str, str | None]) -> None:
        fields = ("imei_slot1", "imei_slot2", "esim_imei", "eid", "meid", "serial_number", "android_id")
        payload: dict[str, Any] = {"device_id": device_id}
        for field in fields:
            value = normalize_blank(identifiers.get(field))
            payload[field] = value
            payload[f"{field}_hash"] = self.hmac_value(value)
            payload[f"{field}_display"] = display_value(value)
        existing = con.execute("SELECT device_id FROM device_identifiers WHERE device_id=?", (device_id,)).fetchone()
        if existing:
            assignments = ", ".join([f"{field}=COALESCE(?, {field}), {field}_hash=COALESCE(?, {field}_hash), {field}_display=COALESCE(?, {field}_display)" for field in fields])
            values: list[Any] = []
            for field in fields:
                values.extend([payload[field], payload[f"{field}_hash"], payload[f"{field}_display"]])
            con.execute(f"UPDATE device_identifiers SET {assignments}, updated_at=? WHERE device_id=?", (*values, self.now(), device_id))
        else:
            columns = ["device_id"]
            values = [device_id]
            for field in fields:
                columns.extend([field, f"{field}_hash", f"{field}_display"])
                values.extend([payload[field], payload[f"{field}_hash"], payload[f"{field}_display"]])
            columns.extend(["created_at", "updated_at"])
            values.extend([self.now(), self.now()])
            con.execute(
                f"INSERT INTO device_identifiers({', '.join(columns)}) VALUES ({', '.join(['?'] * len(columns))})",
                values,
            )

    def upsert_sim_profile(
        self,
        *,
        sim_kind: str = "unknown",
        slot_index: int | None = None,
        sim_state: str | None = None,
        iccid: str | None = None,
        msisdn: str | None = None,
        carrier: str | None = None,
        mcc: str | None = None,
        mnc: str | None = None,
        subscription_id: str | None = None,
        activation_status: str = "unknown",
        assigned_device_id: str | None = None,
        source: str = "manual",
        confidence: str = "unknown",
    ) -> dict[str, Any]:
        confidence = self._validate_choice(confidence, CONFIDENCE_LEVELS, "confidence")
        con = self._require_ready()
        try:
            con.execute("BEGIN IMMEDIATE")
            hashes = {
                "iccid_hash": self.hmac_value(iccid),
                "msisdn_hash": self.hmac_value(msisdn),
                "subscription_id_hash": self.hmac_value(subscription_id),
            }
            candidates: set[str] = set()
            for column, value in hashes.items():
                if not value:
                    continue
                row = con.execute(f"SELECT sim_id FROM sim_profile WHERE {column}=?", (value,)).fetchone()
                if row:
                    candidates.add(row["sim_id"])
            if len(candidates) > 1:
                raise InventoryConflict(f"SIM identity collision across candidates: {sorted(candidates)}")
            sim_id = next(iter(candidates), str(uuid.uuid4()))
            before = self._row_by_id(con, "sim_profile", "sim_id", sim_id)
            now = self.now()
            if before:
                con.execute(
                    """
                    UPDATE sim_profile
                       SET sim_kind=COALESCE(?, sim_kind),
                           slot_index=COALESCE(?, slot_index),
                           sim_state=COALESCE(?, sim_state),
                           iccid=COALESCE(?, iccid), iccid_hash=COALESCE(?, iccid_hash), iccid_display=COALESCE(?, iccid_display),
                           msisdn=COALESCE(?, msisdn), msisdn_hash=COALESCE(?, msisdn_hash), msisdn_display=COALESCE(?, msisdn_display),
                           carrier=COALESCE(?, carrier), mcc=COALESCE(?, mcc), mnc=COALESCE(?, mnc),
                           subscription_id=COALESCE(?, subscription_id), subscription_id_hash=COALESCE(?, subscription_id_hash), subscription_id_display=COALESCE(?, subscription_id_display),
                           activation_status=?, assigned_device_id=COALESCE(?, assigned_device_id),
                           source=?, confidence=?, last_seen=?, updated_at=?
                     WHERE sim_id=?
                    """,
                    (
                        sim_kind,
                        slot_index,
                        sim_state,
                        iccid,
                        hashes["iccid_hash"],
                        display_value(iccid),
                        msisdn,
                        hashes["msisdn_hash"],
                        display_value(msisdn),
                        carrier,
                        mcc,
                        mnc,
                        subscription_id,
                        hashes["subscription_id_hash"],
                        display_value(subscription_id),
                        activation_status,
                        assigned_device_id,
                        source,
                        confidence,
                        now,
                        now,
                        sim_id,
                    ),
                )
            else:
                con.execute(
                    """
                    INSERT INTO sim_profile(
                        sim_id, sim_kind, slot_index, sim_state, iccid, iccid_hash, iccid_display,
                        msisdn, msisdn_hash, msisdn_display, carrier, mcc, mnc, subscription_id,
                        subscription_id_hash, subscription_id_display, activation_status, assigned_device_id,
                        source, confidence, first_seen, last_seen, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        sim_id,
                        sim_kind,
                        slot_index,
                        sim_state,
                        iccid,
                        hashes["iccid_hash"],
                        display_value(iccid),
                        msisdn,
                        hashes["msisdn_hash"],
                        display_value(msisdn),
                        carrier,
                        mcc,
                        mnc,
                        subscription_id,
                        hashes["subscription_id_hash"],
                        display_value(subscription_id),
                        activation_status,
                        assigned_device_id,
                        source,
                        confidence,
                        now,
                        now,
                        now,
                        now,
                    ),
                )
            after = self._row_by_id(con, "sim_profile", "sim_id", sim_id)
            self._record_event(con, "sim_upsert", "sim_profile", sim_id, before, after, source, confidence, "upsert-sim")
            con.commit()
            return {"sim_id": sim_id}
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def assign_bot(
        self,
        *,
        bot_slug: str,
        phone: str | None = None,
        device_id: str | None = None,
        sim_profile_id: str | None = None,
        service_host: str | None = None,
        mini_name: str | None = None,
        service_port: int | None = None,
        service_name: str | None = None,
        auth_dir_path: str | None = None,
        registration_state: str | None = None,
        status: str = "unknown",
        trust_note: str | Path | None,
        reason_code: str = "assign-bot",
        source: str = "manual",
        confidence: str = "attested",
        close_previous: bool = True,
    ) -> dict[str, Any]:
        if not trust_note or not Path(trust_note).is_file() or Path(trust_note).read_text(encoding="utf-8").strip() == "":
            raise AssetInventoryError("bot assignment changes require a non-empty owner-approved trust note")
        status = self._validate_choice(status, BOT_STATUSES, "status")
        confidence = self._validate_choice(confidence, CONFIDENCE_LEVELS, "confidence")
        phone_hash = self.hmac_value(phone)
        con = self._require_ready()
        try:
            con.execute("BEGIN IMMEDIATE")
            resolved_device_id = self._resolve_device_reference(con, device_id)
            resolved_sim_id = self._resolve_sim_reference(con, sim_profile_id)
            active_bot = con.execute("SELECT assignment_id FROM bot_assignment WHERE bot_slug=? AND active=1", (bot_slug,)).fetchone()
            if active_bot and not close_previous:
                raise InventoryConflict(f"bot already has an active assignment: {bot_slug}")
            if phone_hash:
                active_line = con.execute(
                    "SELECT bot_slug FROM bot_assignment WHERE assigned_phone_hash=? AND active=1 AND bot_slug<>?",
                    (phone_hash, bot_slug),
                ).fetchone()
                if active_line:
                    raise InventoryConflict(f"WhatsApp line already assigned to active bot: {active_line['bot_slug']}")
            now = self.now()
            if active_bot and close_previous:
                before = self._row_by_id(con, "bot_assignment", "assignment_id", active_bot["assignment_id"])
                con.execute(
                    "UPDATE bot_assignment SET active=0, assignment_end_at=?, updated_at=? WHERE assignment_id=?",
                    (now, now, active_bot["assignment_id"]),
                )
                after = self._row_by_id(con, "bot_assignment", "assignment_id", active_bot["assignment_id"])
                self._record_event(con, "bot_assignment_closed", "bot_assignment", active_bot["assignment_id"], before, after, source, confidence, "close-previous-assignment")
            assignment_id = str(uuid.uuid4())
            auth_hash = self.hmac_value(auth_dir_path)
            con.execute(
                """
                INSERT INTO bot_assignment(
                    assignment_id, bot_slug, assigned_phone, assigned_phone_hash, assigned_phone_display,
                    device_id, sim_id, service_host, mini_name, service_port, service_name,
                    auth_dir_path, auth_dir_path_hash, auth_dir_path_display, registration_state,
                    status, assignment_start_at, assignment_end_at, active, trust_note_path,
                    source, confidence, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?)
                """,
                (
                    assignment_id,
                    bot_slug,
                    phone,
                    phone_hash,
                    display_value(phone),
                    resolved_device_id,
                    resolved_sim_id,
                    service_host,
                    mini_name,
                    service_port,
                    service_name,
                    auth_dir_path,
                    auth_hash,
                    display_value(auth_dir_path) if auth_dir_path else None,
                    registration_state,
                    status,
                    now,
                    str(trust_note),
                    source,
                    confidence,
                    now,
                    now,
                ),
            )
            after = self._row_by_id(con, "bot_assignment", "assignment_id", assignment_id)
            self._record_event(con, "bot_assignment_created", "bot_assignment", assignment_id, None, after, source, confidence, reason_code, artifact_manifest_path=str(trust_note))
            con.commit()
            return {"assignment_id": assignment_id}
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def upsert_admin_assignment(
        self,
        *,
        principal_name: str | None,
        admin_phone: str | None,
        email_or_alias: str | None = None,
        role: str = "unknown",
        bot_assignment_id: str | None = None,
        device_id: str | None = None,
        sim_id: str | None = None,
        status: str = "active",
        source: str = "manual",
        confidence: str = "unknown",
        verified_at: str | None = None,
    ) -> dict[str, Any]:
        confidence = self._validate_choice(confidence, CONFIDENCE_LEVELS, "confidence")
        con = self._require_ready()
        try:
            con.execute("BEGIN IMMEDIATE")
            assignment_id = str(uuid.uuid4())
            now = self.now()
            con.execute(
                """
                INSERT INTO admin_assignment(
                    admin_assignment_id, principal_name, admin_phone, admin_phone_hash, admin_phone_display,
                    email_or_alias, role, bot_assignment_id, device_id, sim_id, status, source, confidence,
                    verified_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    assignment_id,
                    principal_name,
                    admin_phone,
                    self.hmac_value(admin_phone),
                    display_value(admin_phone),
                    email_or_alias,
                    role,
                    bot_assignment_id,
                    device_id,
                    sim_id,
                    status,
                    source,
                    confidence,
                    verified_at,
                    now,
                    now,
                ),
            )
            after = self._row_by_id(con, "admin_assignment", "admin_assignment_id", assignment_id)
            self._record_event(con, "admin_assignment_upsert", "admin_assignment", assignment_id, None, after, source, confidence, "upsert-admin")
            con.commit()
            return {"admin_assignment_id": assignment_id}
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def record_network_topology(
        self,
        *,
        device_id: str,
        controlling_host: str | None,
        lan_ip: str | None = None,
        port: int | None = None,
        wifi_adb_endpoint: str | None = None,
        usb_transport_present: bool = False,
        ssid: str | None = None,
        bssid: str | None = None,
        transport_proof_status: str = "unknown",
        source: str = "manual",
        confidence: str = "observed",
    ) -> dict[str, Any]:
        confidence = self._validate_choice(confidence, CONFIDENCE_LEVELS, "confidence")
        con = self._require_ready()
        try:
            con.execute("BEGIN IMMEDIATE")
            endpoint_id = str(uuid.uuid4())
            now = self.now()
            wifi_ok = bool(wifi_adb_endpoint and ":" in wifi_adb_endpoint and transport_proof_status != "failed")
            con.execute(
                """
                INSERT INTO network_topology(
                    endpoint_id, device_id, controlling_host, lan_ip, port, wifi_adb_endpoint,
                    usb_transport_present, ssid, bssid, last_seen, transport_proof_status,
                    wifi_mandatory_satisfied, active, source, confidence, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
                """,
                (
                    endpoint_id,
                    device_id,
                    controlling_host,
                    lan_ip,
                    port,
                    wifi_adb_endpoint,
                    1 if usb_transport_present else 0,
                    ssid,
                    bssid,
                    now,
                    transport_proof_status,
                    1 if wifi_ok else 0,
                    source,
                    confidence,
                    now,
                    now,
                ),
            )
            after = self._row_by_id(con, "network_topology", "endpoint_id", endpoint_id)
            self._record_event(con, "network_topology_observed", "network_topology", endpoint_id, None, after, source, confidence, "record-network")
            con.commit()
            return {"endpoint_id": endpoint_id, "wifi_mandatory_satisfied": wifi_ok}
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def wifi_adb_proof(self, *, device_id: str | None = None, bot: str | None = None) -> dict[str, Any]:
        con = self._require_ready()
        try:
            if bot and not device_id:
                row = con.execute("SELECT device_id FROM bot_assignment WHERE bot_slug=? AND active=1", (bot,)).fetchone()
                if not row:
                    raise InventoryNotFound(f"no active bot assignment for {bot}")
                device_id = row["device_id"]
            if not device_id:
                raise AssetInventoryError("wifi proof requires device_id or bot")
            row = con.execute(
                """
                SELECT * FROM network_topology
                 WHERE device_id=?
                 ORDER BY wifi_mandatory_satisfied DESC, last_seen DESC, created_at DESC
                 LIMIT 1
                """,
                (device_id,),
            ).fetchone()
            if not row:
                return {"device_id": device_id, "wifi_mandatory_satisfied": False, "endpoint": None, "reason": "no-network-topology"}
            return {
                "device_id": device_id,
                "wifi_mandatory_satisfied": bool(row["wifi_mandatory_satisfied"]),
                "endpoint": row["wifi_adb_endpoint"],
                "controlling_host": row["controlling_host"],
                "transport_proof_status": row["transport_proof_status"],
                "reason": None if row["wifi_mandatory_satisfied"] else "wifi-adb-endpoint-missing",
            }
        finally:
            con.close()

    def get_device(self, device_id: str) -> dict[str, Any]:
        con = self._require_ready()
        try:
            row = self._row_by_id(con, "physical_device", "device_id", device_id)
            if not row:
                raise InventoryNotFound(f"device not found: {device_id}")
            return row
        finally:
            con.close()

    def devices_by_status(self, status: str) -> list[dict[str, Any]]:
        con = self._require_ready()
        try:
            return [dict(row) for row in con.execute("SELECT * FROM physical_device WHERE lifecycle_status=? ORDER BY created_at", (status,))]
        finally:
            con.close()

    def active_and_historical_assignments(self, bot_slug: str) -> list[dict[str, Any]]:
        con = self._require_ready()
        try:
            return [
                self._safe_assignment_dict(dict(row))
                for row in con.execute(
                    "SELECT * FROM bot_assignment WHERE bot_slug=? ORDER BY assignment_start_at",
                    (bot_slug,),
                )
            ]
        finally:
            con.close()

    def verify_bot(self, bot: str) -> dict[str, Any]:
        con = self._require_ready()
        try:
            active = con.execute("SELECT * FROM bot_assignment WHERE bot_slug=? AND active=1", (bot,)).fetchone()
            duplicates = self._duplicate_findings(con)
            result = {
                "bot": bot,
                "inventory_present": active is not None,
                "active_assignment": self._safe_assignment_dict(dict(active)) if active else None,
                "duplicate_findings": duplicates,
                "freshness": "unknown",
                "verdict": "PASS" if active and not duplicates else "FAIL",
            }
            if active and active["device_id"]:
                result["wifi_adb_proof"] = self.wifi_adb_proof(device_id=active["device_id"])
            return result
        finally:
            con.close()

    def doctor_bot(self, bot: str) -> dict[str, Any]:
        result = self.verify_bot(bot)
        result["stages"] = {
            "inventory_presence": "PASS" if result["inventory_present"] else "FAIL",
            "duplicate_policy": "PASS" if not result["duplicate_findings"] else "FAIL",
            "wifi_adb_proof": (
                "PASS"
                if result.get("wifi_adb_proof", {}).get("wifi_mandatory_satisfied")
                else "DEPENDENCY"
            ),
        }
        return result

    def safe_export(self) -> dict[str, Any]:
        con = self._require_ready()
        try:
            payload = {
                "schema_version": SCHEMA_VERSION,
                "generated_at": self.now(),
                "database": {
                    "path": str(self.db_path),
                    "path_hash": self.hmac_value(str(self.db_path)),
                    "encryption_at_rest": "not_implemented_file_permissions_0600",
                },
                "physical_devices": [self._safe_device_dict(dict(row)) for row in con.execute("SELECT * FROM physical_device ORDER BY created_at")],
                "device_identifiers": [self._safe_identifier_dict(dict(row)) for row in con.execute("SELECT * FROM device_identifiers ORDER BY created_at")],
                "sim_profiles": [self._safe_sim_dict(dict(row)) for row in con.execute("SELECT * FROM sim_profile ORDER BY created_at")],
                "bot_assignments": [self._safe_assignment_dict(dict(row)) for row in con.execute("SELECT * FROM bot_assignment ORDER BY assignment_start_at")],
                "admin_assignments": [self._safe_admin_dict(dict(row)) for row in con.execute("SELECT * FROM admin_assignment ORDER BY created_at")],
                "network_topology": [dict(row) for row in con.execute("SELECT * FROM network_topology ORDER BY created_at")],
            }
            text = json.dumps(payload, sort_keys=True)
            self.assert_secret_clean(text)
            return payload
        finally:
            con.close()

    def artifact_pack(self, output_dir: str | Path, *, bot: str | None = None) -> dict[str, Any]:
        output = Path(output_dir)
        private_mkdir(output)
        evidence: dict[str, Any] = {"safe_export": self.safe_export()}
        if bot:
            evidence["doctor"] = self.doctor_bot(bot)
        manifest = {
            "schema_version": 1,
            "created_at": self.now(),
            "bot": bot,
            "redaction_scan_result": "PASS",
            "evidence": evidence,
        }
        text = json.dumps(manifest, sort_keys=True)
        self.assert_secret_clean(text)
        manifest_path = output / "inventory-proof.manifest.json"
        write_private_json(manifest_path, manifest)
        digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        return {"manifest_path": str(manifest_path), "sha256": digest, "redaction_scan_result": "PASS"}

    def secure_export(self, encrypted_path: str | Path) -> None:
        raise NotImplementedError("secure encrypted export is not implemented in this slice; use DB file permissions and safe export")

    def assert_secret_clean(self, text: str) -> None:
        for raw in self._known_sensitive_values():
            if raw and raw in text:
                raise SensitiveLeak(f"unsafe inventory output contains raw sensitive value ending {raw[-4:]}")

    def discover(self, *, adb_target: str, host: str, adb_path: str | None = None) -> dict[str, Any]:
        adb = adb_path or os.environ.get("PHONECTL_ADB") or "adb"
        wifi_endpoint = parse_adb_wifi_endpoint(adb_target)
        identity_adb_serial = None if wifi_endpoint else adb_target
        facts: dict[str, str] = {"adb_target": adb_target}
        if identity_adb_serial:
            facts["adb_serial"] = identity_adb_serial
        for item in ADB_PROPS:
            value = self._adb_getprop(adb, adb_target, item.prop)
            if value:
                facts[item.field] = value
        device = self.upsert_physical_device(
            adb_serial=identity_adb_serial,
            manufacturer=facts.get("manufacturer"),
            model=facts.get("model"),
            android_release=facts.get("android_release"),
            android_sdk=facts.get("android_sdk"),
            build_fingerprint=facts.get("build_fingerprint"),
            hardware_sku=facts.get("hardware_sku"),
            product=facts.get("product"),
            board=facts.get("board"),
            ro_serialno=facts.get("ro_serialno"),
            lifecycle_status="staging",
            source=f"adb:{host}",
            confidence="observed",
        )
        lan_ip = wifi_endpoint[0] if wifi_endpoint else None
        port = wifi_endpoint[1] if wifi_endpoint else None
        self.record_network_topology(
            device_id=device["device_id"],
            controlling_host=host,
            lan_ip=lan_ip,
            port=port,
            wifi_adb_endpoint=adb_target if wifi_endpoint else None,
            usb_transport_present=not bool(wifi_endpoint),
            transport_proof_status="observed",
            source=f"adb:{host}",
            confidence="observed",
        )
        out = {"device": {**device, **facts}, "source": f"adb:{host}", "mutation": "asset-db-only"}
        self.assert_secret_clean(json.dumps(out, sort_keys=True))
        return out

    def _adb_getprop(self, adb: str, target: str, prop: str) -> str | None:
        try:
            result = subprocess.run(
                [adb, "-s", target, "shell", "getprop", prop],
                text=True,
                capture_output=True,
                timeout=8,
                check=False,
            )
        except OSError as exc:
            raise AssetInventoryError(f"adb invocation failed for {target}: {exc}") from exc
        if result.returncode != 0:
            raise AssetInventoryError(f"adb getprop failed for {target} {prop}: rc={result.returncode}")
        return normalize_blank(result.stdout)

    def _known_sensitive_values(self) -> list[str]:
        if not self.db_path.exists():
            return []
        con = self._require_ready()
        try:
            values: list[str] = []
            table_columns = {
                "device_identifiers": ["imei_slot1", "imei_slot2", "esim_imei", "eid", "meid"],
                "sim_profile": ["iccid", "msisdn", "subscription_id"],
                "bot_assignment": ["assigned_phone", "auth_dir_path"],
                "admin_assignment": ["admin_phone"],
            }
            for table, columns in table_columns.items():
                for row in con.execute(f"SELECT {', '.join(columns)} FROM {table}"):
                    for column in columns:
                        value = normalize_blank(row[column])
                        if value and len(value) >= 4:
                            values.append(value)
            return values
        finally:
            con.close()

    def _record_event(
        self,
        con: sqlite3.Connection,
        event_type: str,
        entity_type: str,
        entity_id: str,
        before: dict[str, Any] | None,
        after: dict[str, Any] | None,
        source: str,
        confidence: str,
        reason_code: str,
        *,
        artifact_manifest_path: str | None = None,
    ) -> None:
        before_json = json.dumps(self._safe_record(before), sort_keys=True) if before else None
        after_json = json.dumps(self._safe_record(after), sort_keys=True) if after else None
        event_id = str(uuid.uuid4())
        con.execute(
            """
            INSERT INTO inventory_event(
                event_id, event_type, entity_type, entity_id, before_json, after_json, actor,
                source, tool_surface, artifact_manifest_path, artifact_hash, redaction_scan_result,
                confidence, reason_code, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                event_type,
                entity_type,
                entity_id,
                before_json,
                after_json,
                self.actor,
                source,
                "phonectl.asset_inventory",
                artifact_manifest_path,
                hashlib.sha256((artifact_manifest_path or "").encode()).hexdigest() if artifact_manifest_path else None,
                "PASS",
                confidence,
                reason_code,
                self.now(),
            ),
        )

    def _safe_record(self, record: dict[str, Any] | None) -> dict[str, Any] | None:
        if record is None:
            return None
        return {key: self._safe_scalar(key, value) for key, value in record.items() if key not in SENSITIVE_COLUMNS}

    def _safe_scalar(self, key: str, value: Any) -> Any:
        if key in SENSITIVE_COLUMNS:
            return None
        return value

    def _safe_device_dict(self, row: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in row.items() if key not in SENSITIVE_COLUMNS}

    def _safe_identifier_dict(self, row: dict[str, Any]) -> dict[str, Any]:
        out = {"device_id": row["device_id"], "created_at": row["created_at"], "updated_at": row["updated_at"]}
        for field in ("imei_slot1", "imei_slot2", "esim_imei", "eid", "meid", "serial_number", "android_id"):
            out[f"{field}_hash"] = row[f"{field}_hash"]
            out[f"{field}_display"] = row[f"{field}_display"]
        return out

    def _safe_sim_dict(self, row: dict[str, Any]) -> dict[str, Any]:
        out = {key: value for key, value in row.items() if key not in {"iccid", "msisdn", "subscription_id"}}
        return out

    def _safe_assignment_dict(self, row: dict[str, Any]) -> dict[str, Any]:
        out = {key: value for key, value in row.items() if key not in {"assigned_phone", "auth_dir_path"}}
        out["active"] = bool(out.get("active"))
        return out

    def _safe_admin_dict(self, row: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in row.items() if key != "admin_phone"}

    def _device_snapshot(self, con: sqlite3.Connection, device_id: str | None) -> dict[str, Any] | None:
        if not device_id:
            return None
        return self._row_by_id(con, "physical_device", "device_id", device_id)

    def _row_by_id(self, con: sqlite3.Connection, table: str, pk: str, value: str) -> dict[str, Any] | None:
        row = con.execute(f"SELECT * FROM {table} WHERE {pk}=?", (value,)).fetchone()
        return row_to_dict(row)

    def _duplicate_findings(self, con: sqlite3.Connection) -> list[dict[str, Any]]:
        findings: list[dict[str, Any]] = []
        for row in con.execute("SELECT bot_slug, COUNT(*) AS n FROM bot_assignment WHERE active=1 GROUP BY bot_slug HAVING n > 1"):
            findings.append({"type": "duplicate_active_bot", "bot_slug": row["bot_slug"], "count": row["n"]})
        for row in con.execute(
            "SELECT assigned_phone_hash, COUNT(DISTINCT bot_slug) AS n FROM bot_assignment WHERE active=1 AND assigned_phone_hash IS NOT NULL GROUP BY assigned_phone_hash HAVING n > 1"
        ):
            findings.append({"type": "duplicate_active_line", "phone_hash": row["assigned_phone_hash"], "count": row["n"]})
        return findings

    def _validate_choice(self, value: str, choices: set[str], name: str) -> str:
        if value not in choices:
            raise AssetInventoryError(f"invalid {name}: {value}")
        return value


MIGRATION_1 = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS physical_device (
    device_id TEXT PRIMARY KEY,
    asset_tag TEXT,
    manufacturer TEXT,
    model TEXT,
    android_release TEXT,
    android_sdk TEXT,
    build_fingerprint TEXT,
    hardware_sku TEXT,
    product TEXT,
    board TEXT,
    adb_serial TEXT UNIQUE,
    ro_serialno TEXT UNIQUE,
    lifecycle_status TEXT NOT NULL DEFAULT 'unknown',
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    confidence TEXT NOT NULL DEFAULT 'unknown',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_usb_serial (
    device_id TEXT NOT NULL REFERENCES physical_device(device_id) ON DELETE CASCADE,
    adb_serial TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY(device_id, adb_serial)
);

CREATE TABLE IF NOT EXISTS device_identifiers (
    device_id TEXT PRIMARY KEY REFERENCES physical_device(device_id) ON DELETE CASCADE,
    imei_slot1 TEXT,
    imei_slot1_hash TEXT UNIQUE,
    imei_slot1_display TEXT,
    imei_slot2 TEXT,
    imei_slot2_hash TEXT UNIQUE,
    imei_slot2_display TEXT,
    esim_imei TEXT,
    esim_imei_hash TEXT UNIQUE,
    esim_imei_display TEXT,
    eid TEXT,
    eid_hash TEXT UNIQUE,
    eid_display TEXT,
    meid TEXT,
    meid_hash TEXT UNIQUE,
    meid_display TEXT,
    serial_number TEXT,
    serial_number_hash TEXT UNIQUE,
    serial_number_display TEXT,
    android_id TEXT,
    android_id_hash TEXT UNIQUE,
    android_id_display TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_profile (
    sim_id TEXT PRIMARY KEY,
    sim_kind TEXT NOT NULL DEFAULT 'unknown',
    slot_index INTEGER,
    sim_state TEXT,
    iccid TEXT,
    iccid_hash TEXT UNIQUE,
    iccid_display TEXT,
    msisdn TEXT,
    msisdn_hash TEXT UNIQUE,
    msisdn_display TEXT,
    carrier TEXT,
    mcc TEXT,
    mnc TEXT,
    subscription_id TEXT,
    subscription_id_hash TEXT UNIQUE,
    subscription_id_display TEXT,
    activation_status TEXT NOT NULL DEFAULT 'unknown',
    assigned_device_id TEXT REFERENCES physical_device(device_id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    confidence TEXT NOT NULL DEFAULT 'unknown',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_assignment (
    assignment_id TEXT PRIMARY KEY,
    bot_slug TEXT NOT NULL,
    assigned_phone TEXT,
    assigned_phone_hash TEXT,
    assigned_phone_display TEXT,
    device_id TEXT REFERENCES physical_device(device_id) ON DELETE SET NULL,
    sim_id TEXT REFERENCES sim_profile(sim_id) ON DELETE SET NULL,
    service_host TEXT,
    mini_name TEXT,
    service_port INTEGER,
    service_name TEXT,
    auth_dir_path TEXT,
    auth_dir_path_hash TEXT,
    auth_dir_path_display TEXT,
    registration_state TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    assignment_start_at TEXT NOT NULL,
    assignment_end_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    trust_note_path TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    confidence TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_bot_assignment_active_bot
    ON bot_assignment(bot_slug)
    WHERE active = 1;

CREATE UNIQUE INDEX IF NOT EXISTS ux_bot_assignment_active_phone
    ON bot_assignment(assigned_phone_hash)
    WHERE active = 1 AND assigned_phone_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin_assignment (
    admin_assignment_id TEXT PRIMARY KEY,
    principal_name TEXT,
    admin_phone TEXT,
    admin_phone_hash TEXT,
    admin_phone_display TEXT,
    email_or_alias TEXT,
    role TEXT NOT NULL DEFAULT 'unknown',
    bot_assignment_id TEXT REFERENCES bot_assignment(assignment_id) ON DELETE SET NULL,
    device_id TEXT REFERENCES physical_device(device_id) ON DELETE SET NULL,
    sim_id TEXT REFERENCES sim_profile(sim_id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'manual',
    confidence TEXT NOT NULL DEFAULT 'unknown',
    verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS network_topology (
    endpoint_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES physical_device(device_id) ON DELETE CASCADE,
    controlling_host TEXT,
    lan_ip TEXT,
    port INTEGER,
    wifi_adb_endpoint TEXT,
    usb_transport_present INTEGER NOT NULL DEFAULT 0,
    ssid TEXT,
    bssid TEXT,
    last_seen TEXT NOT NULL,
    transport_proof_status TEXT NOT NULL DEFAULT 'unknown',
    wifi_mandatory_satisfied INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'manual',
    confidence TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_event (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    before_json TEXT,
    after_json TEXT,
    actor TEXT NOT NULL,
    source TEXT NOT NULL,
    tool_surface TEXT NOT NULL,
    artifact_manifest_path TEXT,
    artifact_hash TEXT,
    redaction_scan_result TEXT NOT NULL,
    confidence TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def add_global_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--db", default=None, help=f"Asset DB path (default: {DEFAULT_DB_PATH})")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m phonectl.asset_inventory")
    add_global_args(parser)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init")

    discover = sub.add_parser("discover")
    discover.add_argument("--adb-target", required=True)
    discover.add_argument("--host", required=True)
    discover.add_argument("--json", action="store_true")

    upsert = sub.add_parser("upsert-device")
    upsert.add_argument("--adb-serial")
    upsert.add_argument("--asset-tag")
    upsert.add_argument("--manufacturer")
    upsert.add_argument("--model")
    upsert.add_argument("--lifecycle-status", default="unknown")
    upsert.add_argument("--bot")
    upsert.add_argument("--phone")
    upsert.add_argument("--admin-name")
    upsert.add_argument("--admin-phone")
    upsert.add_argument("--json", action="store_true")

    assign = sub.add_parser("assign-bot")
    assign.add_argument("--bot", required=True)
    assign.add_argument("--device", required=True)
    assign.add_argument("--sim")
    assign.add_argument("--phone")
    assign.add_argument("--service-host")
    assign.add_argument("--service-port", type=int)
    assign.add_argument("--service-name")
    assign.add_argument("--status", default="unknown")
    assign.add_argument("--trust-note", required=True)
    assign.add_argument("--json", action="store_true")

    topology = sub.add_parser("topology")
    topology.add_argument("--json", action="store_true")

    verify = sub.add_parser("verify")
    verify.add_argument("--bot", required=True)
    verify.add_argument("--json", action="store_true")

    export = sub.add_parser("export")
    export.add_argument("--safe-json", action="store_true", required=True)

    secure = sub.add_parser("secure-export")
    secure.add_argument("--encrypted", required=True)

    doctor = sub.add_parser("doctor")
    doctor.add_argument("--bot", required=True)
    doctor.add_argument("--json", action="store_true")

    proof_gate = sub.add_parser("proof-gate")
    proof_gate.add_argument("--bot", required=True)
    proof_gate.add_argument("--json", action="store_true")

    proof = sub.add_parser("wifi-adb-proof")
    proof.add_argument("--bot")
    proof.add_argument("--device")
    proof.add_argument("--json", action="store_true")

    artifact = sub.add_parser("artifact-pack")
    artifact.add_argument("--bot")
    artifact.add_argument("--output", required=True)
    artifact.add_argument("--json", action="store_true")

    lint = sub.add_parser("config-lint")
    lint.add_argument("--bot", required=True)
    lint.add_argument("--json", action="store_true")

    trust = sub.add_parser("trust-note-lint")
    trust.add_argument("--path", required=True)
    trust.add_argument("--json", action="store_true")

    return parser


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else 0
    inv = AssetInventory(args.db)
    try:
        if args.command == "init":
            inv.init_db()
            print_json({"status": "ok", "db": str(inv.db_path), "schema_version": SCHEMA_VERSION})
            return 0
        if args.command == "discover":
            payload = inv.discover(adb_target=args.adb_target, host=args.host)
            print_json(payload)
            return 0
        if args.command == "upsert-device":
            inv.init_db() if not inv.db_path.exists() else None
            payload = inv.upsert_physical_device(
                adb_serial=args.adb_serial,
                asset_tag=args.asset_tag,
                manufacturer=args.manufacturer,
                model=args.model,
                lifecycle_status=args.lifecycle_status,
                source="manual-cli",
                confidence="attested" if args.asset_tag or args.manufacturer or args.model else "unknown",
            )
            if args.admin_name or args.admin_phone:
                inv.upsert_admin_assignment(
                    principal_name=args.admin_name,
                    admin_phone=args.admin_phone,
                    role="unknown",
                    device_id=payload["device_id"],
                    source="manual-cli",
                    confidence="attested",
                    verified_at=utc_now(),
                )
            print_json(payload)
            return 0
        if args.command == "assign-bot":
            payload = inv.assign_bot(
                bot_slug=args.bot,
                phone=args.phone,
                device_id=args.device,
                sim_profile_id=args.sim,
                service_host=args.service_host,
                service_port=args.service_port,
                service_name=args.service_name,
                status=args.status,
                trust_note=args.trust_note,
            )
            print_json(payload)
            return 0
        if args.command == "topology":
            payload = inv.safe_export()["network_topology"]
            print_json({"network_topology": payload})
            return 0
        if args.command == "verify":
            print_json(inv.verify_bot(args.bot))
            return 0
        if args.command == "export":
            print_json(inv.safe_export())
            return 0
        if args.command == "secure-export":
            inv.secure_export(args.encrypted)
            return 0
        if args.command == "doctor":
            print_json(inv.doctor_bot(args.bot))
            return 0
        if args.command == "proof-gate":
            print_json(inv.doctor_bot(args.bot))
            return 0
        if args.command == "wifi-adb-proof":
            print_json(inv.wifi_adb_proof(device_id=args.device, bot=args.bot))
            return 0
        if args.command == "artifact-pack":
            print_json(inv.artifact_pack(args.output, bot=args.bot))
            return 0
        if args.command == "config-lint":
            result = inv.verify_bot(args.bot)
            print_json({"bot": args.bot, "verdict": result["verdict"], "inventory_present": result["inventory_present"]})
            return 0 if result["verdict"] == "PASS" else EXIT_CONFIG
        if args.command == "trust-note-lint":
            path = Path(args.path)
            ok = path.is_file() and path.read_text(encoding="utf-8").strip() != ""
            print_json({"path": str(path), "verdict": "PASS" if ok else "FAIL"})
            return 0 if ok else EXIT_CONFIG
        parser.error(f"unknown command {args.command}")
        return EXIT_USAGE
    except AssetInventoryError as exc:
        print(f"phonectl asset inventory error: {exc}", file=sys.stderr)
        return exc.exit_code
    except NotImplementedError as exc:
        print(f"phonectl asset inventory error: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    except sqlite3.DatabaseError as exc:
        print(f"phonectl asset inventory error: database failure: {exc}", file=sys.stderr)
        return EXIT_DB
    except Exception as exc:
        print(f"phonectl asset inventory error: {exc}", file=sys.stderr)
        return EXIT_CONFIG


if __name__ == "__main__":
    raise SystemExit(main())
