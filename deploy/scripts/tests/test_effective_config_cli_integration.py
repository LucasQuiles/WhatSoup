"""Exercise the pinned CLI and record reader with synthetic private sources."""
import json
import os
from pathlib import Path
import subprocess

import pytest

WORKTREE = Path(__file__).resolve().parents[3]
from deploy.scripts.lib import durable_json, deployment_effective_config as READER


def write_private(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)


@pytest.mark.parametrize('suffix', ['a', 'b'])
def test_real_producer_record_is_accepted_then_changed_source_is_refused(tmp_path, suffix):
    root = tmp_path.resolve()
    root.chmod(0o700)
    instance_root = root / 'instances'
    instance_root.mkdir(mode=0o700)
    name = 'agent-' + suffix
    instance = instance_root / name
    instance.mkdir(mode=0o700)
    target = {
        'host_ref': 'host_' + suffix * 8,
        'user_ref': 'usr_' + suffix * 8,
        'instance_ref': 'inst_' + suffix * 8,
        'inventory_host': 'host-' + suffix,
        'instance_name': name,
    }
    context = {
        'arc_commit': '1' * 40, 'qfleet_commit': '2' * 40,
        'whatsoup_commit': '3' * 40, 'run_context_digest': '4' * 64,
    }
    config_path = instance / 'config.json'
    binding_path = root / 'binding.json'
    inventory_path = root / 'inventory.json'
    write_private(config_path, {
        'name': name, 'type': 'agent', 'accessMode': 'self_only',
        'healthPort': 8123, 'adminPhones': ['15550000001'],
        'service': {'claudeConfigDir': str(root / 'provider'), 'pathPrepend': []},
    })
    write_private(binding_path, {
        'schema_version': 'whatsoup.deployment-binding.v1', 'target': target,
        'settings': {
            'uid': os.getuid(), 'home_root': str(root), 'platform': 'macos',
            'service_manager': 'launchd', 'service_domain': 'gui',
            'token_file_relative': 'tokens.env',
        },
        'requested': {'healthPort': 8124},
        'overrides': [{'field': 'limits.timeout_seconds', 'value': 2,
                       'reason': 'Synthetic bounded observation'}],
    })
    write_private(inventory_path, {
        'version': 1, 'collector_origin': 'host-' + suffix, 'interval_minutes': 5,
        'timeouts': {'ssh_connect_seconds': 5, 'remote_command_seconds': 10},
        'debounce': {'failures_before_alert': 2, 'oks_before_recovery': 2},
        'thresholds': {},
        'hosts': {'host-' + suffix: {
            'tier': 'alert', 'probe': 'local', 'role': 'collector',
            'principal': 'user-' + suffix, 'services': [],
            'required_processes': [], 'expected_listening_ports': [8123],
        }},
    })
    paths = [config_path, binding_path, inventory_path]
    before = [(path.read_bytes(), path.stat()) for path in paths]
    output = root / 'effective.json'
    command = [
        str(WORKTREE / 'scripts/run-with-pinned-node.sh'),
        str(WORKTREE / 'scripts/resolve-deployment-effective-config.ts'),
        '--binding', str(binding_path), '--binding-root', str(root),
        '--inventory', str(inventory_path), '--inventory-root', str(root),
        '--instance-root', str(instance_root),
        '--output', str(output), '--output-root', str(root),
    ]
    for key, value in context.items():
        command.extend(['--' + key.replace('_', '-'), value])
    produced = subprocess.run(command, cwd=WORKTREE, text=True, capture_output=True, timeout=30)
    assert produced.returncode == 0, produced.stderr
    receipt = json.loads(produced.stdout)
    record_target = durable_json.durable_json_target(trusted_root=root, relative_path='effective.json')
    arguments = dict(expected_sha256=receipt['record_sha256'], expected_context=context,
                     expected_target=target)
    record = READER.load_effective_config(record_target, **arguments)
    assert record['target'] == target
    assert record['configured']['instance']['healthPort'] == 8123
    assert record['requested']['healthPort'] == 8124
    assert record['limits']['timeout_seconds'] == 2
    assert record['transport_identity'] == 'unresolved'
    assert output.stat().st_mode & 0o777 == 0o600
    for path, (raw, metadata) in zip(paths, before):
        assert path.read_bytes() == raw
        current = path.stat()
        assert (current.st_ino, current.st_mtime_ns, current.st_ctime_ns, current.st_mode) == (
            metadata.st_ino, metadata.st_mtime_ns, metadata.st_ctime_ns, metadata.st_mode)
    write_private(config_path, {'changed': True})
    with pytest.raises(READER.EffectiveConfigRefusal) as refused:
        READER.load_effective_config(record_target, **arguments)
    assert str(refused.value) == ''
