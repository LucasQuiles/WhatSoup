"""A stale reminder for an awaiting_physical incident asks a person to act.

The stale sweep builds its reminder from the incident record, so the record's
awaiting_physical status is trusted dispatcher state. The card's physical
owner action is selected only by the in-process physical-action token; the
sweep must install it from that trusted status, or a confirmed manual-relink
incident renders "No action is needed." and "Nothing now."
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path


_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_clean_env = dispatcher_fixtures.make_env_scrub_fixture(["BOT_ERRORS_STATE_DIR"])


def _load(state_dir: Path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_stale_physical", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_stale_reminder_for_awaiting_physical_incident_asks_a_person(tmp_path):
    mod = _load(tmp_path)
    now = int(time.time())
    key = "host-a|whatsoup-bot|whatsapp_auth_bond_local_failure"
    path = mod.state_paths()["incident_state"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "lastSentAt": {}, "openIncidents": {key: {
        "status": "awaiting_physical",
        "openedAt": now - 10 * 86400,
        "lastSeenAt": now - 8 * 86400,
        "lastSummary": "WhatsApp line needs a relink",
        "physicalCandidateCount": 1,
    }}}))
    path.chmod(0o600)
    sends = dispatcher_fixtures.capture_sends(mod)

    sent, failed, err = mod.sweep_stale_incidents(mod.state_paths())

    assert (sent, failed, err) == (1, 0, None)
    assert len(sends) == 1
    assert "*What we are doing:* A person needs to act." in sends[0]
    assert "*What you need to do:* Relink or retire the WhatsApp line." in sends[0]
    assert "No action is needed" not in sends[0]
