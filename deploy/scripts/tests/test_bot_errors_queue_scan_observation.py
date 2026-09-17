import importlib.util
from contextlib import contextmanager
import errno
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time

from hypothesis import given, strategies as st
import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


health = load_script('queue_observation_health', 'bot-errors-health-check.py')
watchdog = load_script('queue_observation_watchdog', 'bot-errors-heartbeat-watchdog.py')
from lib import queue_age


@pytest.fixture(params=['file', 'unreadable', 'unreadable_parent', 'broken_link', 'broken_ancestor'])
def failed_queue(request, tmp_path):
    assert os.geteuid() != 0, 'Permission fixtures require an unprivileged process'
    queue = tmp_path / 'queue'
    restore = None
    if request.param == 'file':
        queue.write_text('not a directory')
    elif request.param == 'unreadable':
        queue.mkdir()
        (queue / 'old.json').write_text('{"createdAt":"2000-01-01T00:00:00Z"}')
        restore = queue
        queue.chmod(0)
    elif request.param == 'unreadable_parent':
        parent = tmp_path / 'parent'
        parent.mkdir()
        queue = parent / 'queue'
        queue.mkdir()
        restore = parent
        parent.chmod(0)
    elif request.param == 'broken_link':
        queue.symlink_to(tmp_path / 'missing')
    else:
        parent = tmp_path / 'link-parent'
        parent.symlink_to(tmp_path / 'missing')
        queue = parent / 'queue'
    try:
        with pytest.raises(OSError):
            with os.scandir(queue) as entries:
                list(entries)
        yield queue
    finally:
        if restore is not None:
            restore.chmod(0o700)


def health_line(path):
    return health.queue_directory_line('outbox', path, '*.json', 1, 10, 60, 600)


def watchdog_problem(path):
    return watchdog.queue_backlog_problem('outbox', [path], '*.json', 10, 600)


def test_shared_scanner_rejects_failed_observation(failed_queue):
    with pytest.raises(OSError):
        queue_age.scan_directory(failed_queue, '*.json', time.time())


def test_daily_health_reports_unknown_measurements(failed_queue):
    try:
        line = health_line(failed_queue)
    except OSError as error:
        pytest.fail(f'Queue error escaped instead of becoming a failed observation: {error!r}')
    assert line.startswith('FAIL outbox:'), line
    assert 'observation=failed' in line, line
    assert 'count=unknown' in line and 'oldest_seconds=unknown' in line, line
    assert 'error_class=' in line and 'errno=' in line, line


def test_watchdog_reports_failed_scan(failed_queue):
    problem = watchdog_problem(failed_queue)
    assert problem is not None and 'scan failed' in problem, problem
    assert 'count=0' not in problem, problem


@given(depth=st.integers(min_value=1, max_value=8), present=st.booleans(), internal_lock=st.booleans())
def test_successful_empty_controls(depth, present, internal_lock):
    with TemporaryDirectory() as directory:
        queue = Path(directory).joinpath(*(f'level-{level}' for level in range(depth)))
        if present:
            queue.mkdir(parents=True)
            if internal_lock:
                (queue / '.durable-json.lock').write_text('internal lock')
        assert queue_age.scan_directory(queue, '*.json', time.time()) == (0, 0)
        assert not health_line(queue).startswith(('FAIL ', 'WARN '))
        assert watchdog_problem(queue) is None


def test_old_event_and_internal_lock_are_measured_by_both_consumers(tmp_path):
    queue = tmp_path / 'queue'
    queue.mkdir()
    (queue / 'old.json').write_text(json.dumps({'createdAt': '2000-01-01T00:00:00Z'}))
    (queue / '.durable-json.lock').write_text('internal lock')
    count, age = queue_age.scan_directory(queue, '*.json', time.time())
    assert count == 1 and age > 86400
    assert health_line(queue).startswith('FAIL outbox: count=1 ')
    assert 'backlog critical: count=1 ' in watchdog_problem(queue)


def test_multi_path_writefail_failure_does_not_hide_other_inventory(monkeypatch, tmp_path):
    state = tmp_path / 'state'
    state.mkdir()
    (state / 'writefail').write_text('invalid queue root')
    monkeypatch.setenv('BOT_ERRORS_STATE_DIR', str(state))
    monkeypatch.setenv('BOT_ERRORS_OUTBOX_DIR', str(state / 'outbox'))
    monkeypatch.setenv('TMPDIR', str(tmp_path / 'tmp'))
    monkeypatch.setattr(Path, 'home', classmethod(lambda cls: tmp_path / 'home'))
    try:
        lines = health.queue_inventory()
    except OSError as error:
        pytest.fail(f'One failed queue aborted the remaining inventory: {error!r}')
    writefail = [line for line in lines if 'writefail:' in line]
    assert len(writefail) == 1
    assert writefail[0].startswith('FAIL writefail:'), writefail
    assert 'count=unknown' in writefail[0] and 'oldest_seconds=unknown' in writefail[0]
    assert any('processing:' in line for line in lines)
    assert any('quarantine:' in line for line in lines)


@pytest.mark.parametrize('failure', ['enumeration', 'entry_disappeared'])
def test_incomplete_scan_never_returns_partial_or_empty_success(monkeypatch, tmp_path, failure):
    queue = tmp_path / 'queue'
    queue.mkdir()
    event = queue / 'old.json'
    event.write_text('{"createdAt":"2000-01-01T00:00:00Z"}')
    real_scandir = os.scandir

    @contextmanager
    def interrupted_scandir(path):
        with real_scandir(path) as entries:
            def interrupted_entries():
                for entry in entries:
                    if failure == 'entry_disappeared':
                        event.unlink()
                    yield entry
                    if failure == 'enumeration':
                        raise OSError(errno.EIO, 'controlled enumeration failure')
            yield interrupted_entries()

    monkeypatch.setattr(os, 'scandir', interrupted_scandir)
    with pytest.raises(OSError):
        queue_age.scan_directory(queue, '*.json', time.time())
