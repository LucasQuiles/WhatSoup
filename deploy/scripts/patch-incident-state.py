#!/usr/bin/env python3
"""Patch incident state payload through the session save path.

Usage: python3 deploy/scripts/patch-incident-state.py <state_dir> <patch_json>

Opens the ControllerStateSession, loads, patches payload, saves.
For bare files (virgin), creates envelope via bootstrap session.
For enveloped files (post-adoption), patches payload and saves.
"""
import json, sys, os, importlib.util

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))

from controller_state import open_controller_state

# Load the dispatcher module (hyphen in name requires importlib)
spec = importlib.util.spec_from_file_location(
    'bot_errors_dispatcher',
    os.path.join(os.path.dirname(__file__), 'bot-errors-dispatcher.py'),
)
disp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disp)

state_dir = sys.argv[1]
patch = json.loads(sys.argv[2])
anchor = os.path.join(state_dir, 'incident-state.json')

session = open_controller_state(
    anchor,
    component='dispatcher-incident',
    bootstrap=disp.dispatcher_bootstrap_state,
    validate_payload=disp.validate_dispatcher_state,
    lock_timeout_seconds=10,
)

with session:
    result = session.load()
    payload = dict(result.payload)
    payload.update(patch)
    cr = session.save(payload, result.capability)
