
import fcntl, hashlib, json, os, pathlib, pty, select, signal, subprocess, sys, termios, time
root, helper, bash, mode, terminal = sys.argv[1:]
root = pathlib.Path(root)
# Opening a FIFO O_WRONLY|O_NONBLOCK while no reader holds it fails with ENXIO,
# so a release sent before the probe shell reaches its read would be lost as a
# harness error. Hold each release FIFO open read-write for the whole run; a
# release then waits in the pipe until the shell reads it.
release_holders = [os.open(fifo, os.O_RDWR | os.O_NONBLOCK) for fifo in (root / name for name in ('event-order-cleanup-release', 'event-order-child-release', 'event-order-inner-start', 'event-order-authority-release', 'authorization-rm-release')) if fifo.is_fifo()]
def interrupted(signum, frame):
    raise TimeoutError('outer lifecycle watchdog interrupted the fixture')
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
def members(session):
    result = subprocess.run(['/bin/ps' if os.path.exists('/bin/ps') else '/usr/bin/ps', '-axo', 'pid=,ppid=,pgid='], capture_output=True, text=True, timeout=3)
    if result.returncode: raise RuntimeError('process identity unavailable')
    found = []
    for row in result.stdout.splitlines():
        fields = row.split()
        if len(fields) < 3: continue
        pid = int(fields[0])
        try:
            if os.getsid(pid) == session: found.append({'pid': pid, 'ppid': int(fields[1]), 'pgid': int(fields[2]), 'identity': row})
        except ProcessLookupError: pass
    return found
record = {}
sentinel = subprocess.Popen(['/bin/sleep', '30'], start_new_session=True)
master, slave = pty.openpty() if terminal == 'pty' else (None, None)
with (root / 'stdout').open('w') as out, (root / 'stderr').open('w') as err:
    started = time.monotonic()
    child = subprocess.Popen([bash, str(root / 'probe.sh'), helper, bash, str(root / 'child.sh'), mode], stdin=slave if slave is not None else subprocess.PIPE, stdout=out, stderr=err, text=True, start_new_session=True, preexec_fn=(lambda: fcntl.ioctl(slave, termios.TIOCSCTTY, 0)) if slave is not None else None)
    session = os.getsid(child.pid)
    try:
        if session != child.pid: raise RuntimeError('test session ownership unavailable')
        record['root_pid'] = child.pid
        record['session_id'] = session
        record['initial'] = members(session)
        record['sentinel'] = members(os.getsid(sentinel.pid))
        record['sentinel_group'] = os.getpgid(sentinel.pid)
        record['caller_group'] = os.getpgid(child.pid)
        if master is not None:
            record['terminal_foreground_group'] = os.tcgetpgrp(master)
            os.write(master, b'go\n')
            # Darwin's terminal close can wait for undrained echo after the
            # command has already exited. The fixture owns the master reader.
            if select.select([master], [], [], 2)[0]: record['terminal_echo'] = os.read(master, 4096).decode()
        else: child.stdin.write('go\n'); child.stdin.close()
        if mode.startswith('event-order-'):
            events = root / 'event-order.log'
            record['event_observations'] = []
            observed_count = 0
            released = False
            child_released = False
            authority_released = False
            deadline = time.monotonic() + 5
            while child.poll() is None and time.monotonic() < deadline:
                lines = events.read_text().splitlines() if events.exists() else []
                for line in lines[observed_count:]:
                    record['event_observations'].append({'event': line, 'observed_monotonic_ns': time.monotonic_ns()})
                observed_count = len(lines)
                if mode == 'event-order-outcome-candidate-directory' and not authority_released and 'D_INNER_COMMIT' in lines and any(line.startswith('O_RESULT_CLAIM rc=2 ') for line in lines) and any(line.startswith('G_WAIT ') for line in lines):
                    try:
                        release = os.open(root / 'event-order-authority-release', os.O_WRONLY | os.O_NONBLOCK)
                        try: os.write(release, b'release\n')
                        finally: os.close(release)
                    except OSError as error:
                        record['outer_release_error'] = repr(error)
                    else:
                        authority_released = True
                        record['outer_released_after_parent_wait'] = True
                if mode == 'event-order-expired-reaped':
                    def release_fifo(name):
                        descriptor = os.open(root / name, os.O_WRONLY | os.O_NONBLOCK)
                        try: os.write(descriptor, b'release\n')
                        finally: os.close(descriptor)
                    if not child_released and any(line.startswith('O_OUTER_CLAIM rc=0 ') for line in lines):
                        release_fifo('event-order-inner-start')
                        release_fifo('event-order-child-release')
                        child_released = True
                    if not authority_released and any(line.startswith('C_HOLD ') for line in lines):
                        release_fifo('event-order-authority-release')
                        authority_released = True
                    if not released and 'AUTHORITY state=3' in lines:
                        release_fifo('event-order-cleanup-release')
                        released = True
                        record['cleanup_released_after_authority'] = True
                if mode.startswith('event-order-near-deadline-') and not child_released and 'D_OUTER_PARKED' in lines:
                    release = os.open(root / 'event-order-child-release', os.O_WRONLY | os.O_NONBLOCK)
                    try: os.write(release, b'release\n')
                    finally: os.close(release)
                    child_released = True
                    record['child_released_after_guard_parked'] = True
                if mode.startswith('event-order-natural-') and not released and any(line.startswith('O_OUTER_CLAIM rc=1 ') for line in lines) and any(line.startswith('C_HOLD ') for line in lines):
                    release = os.open(root / 'event-order-cleanup-release', os.O_WRONLY | os.O_NONBLOCK)
                    try: os.write(release, b'release\n')
                    finally: os.close(release)
                    released = True
                    record['cleanup_released_after_outer_deadline'] = True
                time.sleep(0.005)
            if child.poll() is None: raise RuntimeError('event-order control did not finish within its observation bound')
        if mode in ('timeout-symlink', 'timeout-existing'):
            deadline = time.monotonic() + 3
            control = None
            while time.monotonic() < deadline:
                matches = list(root.glob('whatsoup-bounded-control.*'))
                if matches:
                    control = matches[0]
                    break
                time.sleep(0.01)
            if control is None: raise RuntimeError('timeout control record unavailable')
            timeout_path = root / ('whatsoup-bounded-timeout.%s.%s' % (child.pid, control.name.rsplit('.', 1)[1]))
            victim = root / 'timeout-victim'
            victim.write_text('unchanged')
            if mode == 'timeout-symlink': timeout_path.symlink_to(victim)
            else: timeout_path.write_text('preexisting')
            (root / 'timeout-fixture-ready').write_text('ready')
            record['timeout_victim'] = str(victim)
        if mode.startswith('control-'):
            deadline = time.monotonic() + 3
            control = None
            while time.monotonic() < deadline:
                matches = list(root.glob('whatsoup-bounded-authorize.*')) or list(root.glob('whatsoup-bounded-control.*'))
                if matches and 'release=1' in matches[0].read_text():
                    control = matches[0]
                    break
                time.sleep(0.01)
            if control is None: raise RuntimeError('complete control record unavailable')
            fields = dict(line.split('=', 1) for line in control.read_text().splitlines() if '=' in line)
            target_group = {
                'control-low-group': '1',
                'control-caller-group': str(record['caller_group']),
                'control-external-group': str(record['sentinel_group']),
            }.get(mode, fields['command_group'])
            target_pid = {
                'control-low-group': '1',
                'control-caller-group': str(record['caller_group']),
                'control-external-group': str(sentinel.pid),
            }.get(mode, fields.get('command_pid', target_group))
            (root / 'dangerous-groups').write_text(','.join(('1', str(record['caller_group']), str(record['sentinel_group']))))
            replacement = [
                'directory=' + fields['directory'],
                'command_pid=' + target_pid,
                'command_group=' + target_group,
                'watchdog_pid=' + fields.get('watchdog_pid', target_pid),
                'watchdog_group=' + fields['watchdog_group'],
                'release=1',
            ]
            if mode != 'control-tokenless': replacement.insert(0, 'token=' + fields['token'])
            if mode == 'control-duplicate-token': replacement.insert(1, 'token=' + fields['token'])
            staged = root / 'replacement-control'
            staged.write_text('\n'.join(replacement) + '\n')
            staged.replace(control)
            record['control_corrupted'] = mode
        if mode in ('worker-stopped-after-authorization', 'forged-completion-worker-stopped', 'deadline-timer-descendant', 'cleanup-child-group'):
            deadline = time.monotonic() + 3
            authorization = None
            while time.monotonic() < deadline:
                matches = list(root.glob('whatsoup-bounded-authorize.*'))
                if matches and 'release=1' in matches[0].read_text():
                    authorization = matches[0]
                    break
                time.sleep(0.01)
            if authorization is None: raise RuntimeError('worker authorization unavailable')
            fields = dict(line.split('=', 1) for line in authorization.read_text().splitlines() if '=' in line)
            command_pid = int(fields['command_pid'])
            worker = next((item['ppid'] for item in members(session) if item['pid'] == command_pid), None)
            if worker is None or worker == child.pid: raise RuntimeError('worker identity unavailable')
            if mode == 'forged-completion-worker-stopped':
                token = authorization.name.rsplit('.', 1)[1]
                completion = root / ('whatsoup-bounded-cleanup-complete.%s.%s' % (child.pid, token))
                completion.write_text('token=' + token + '\ncomplete=1\n')
                record['forged_completion'] = str(completion)
            record['expected_helper_group'] = worker
            if mode != 'cleanup-child-group':
                os.kill(worker, signal.SIGSTOP)
                record['stopped_worker'] = worker
        if mode in ('dead-leader-before-authorization', 'dead-leader-clean-cleanup', 'dead-leader-finishing-cleanup', 'deadline-fifo-after-cleanup', 'authorization-unreadable-after-cleanup'):
            deadline = time.monotonic() + 3
            authorization = None
            while time.monotonic() < deadline:
                matches = list(root.glob('whatsoup-bounded-authorize.*'))
                if matches and 'release=1' in matches[0].read_text():
                    authorization = matches[0]
                    break
                time.sleep(0.01)
            if authorization is None: raise RuntimeError('outer authorization unavailable')
            fields = dict(line.split('=', 1) for line in authorization.read_text().splitlines() if '=' in line)
            command_pid = int(fields['command_pid'])
            worker = next((item['ppid'] for item in members(session) if item['pid'] == command_pid), None)
            worker_record = next((item for item in members(session) if item['pid'] == worker), None)
            if worker is None or worker_record is None: raise RuntimeError('worker identity unavailable')
            outer = worker_record['ppid']
            guard_candidates = [
                item for item in members(session)
                if item['ppid'] == outer and item['pid'] != worker and item['pgid'] != worker_record['pgid']
            ]
            if len(guard_candidates) != 1: raise RuntimeError('guard identity unavailable')
            guard = guard_candidates[0]['pid']
            (root / 'expected-guard-pid').write_text(str(guard))
            os.kill(guard, signal.SIGSTOP)
            record['stopped_guard'] = guard
            while not (root / 'authorization-rm-ready').exists() and time.monotonic() < deadline + 5:
                time.sleep(0.01)
            if not (root / 'authorization-rm-ready').exists(): raise RuntimeError('worker cleanup did not retain authorization')
            try:
                os.kill(command_pid, 0)
            except ProcessLookupError:
                record['command_pid_reaped_before_authorization'] = True
            else:
                raise RuntimeError('command leader remained present before outer authorization')
            if mode == 'dead-leader-finishing-cleanup':
                os.kill(guard, signal.SIGCONT)
                record['continued_guard'] = guard
                authority_deadline = time.monotonic() + 2
                while not (root / 'outer-authority-finished').exists() and time.monotonic() < authority_deadline:
                    time.sleep(0.01)
                record['outer_authority_finished'] = (root / 'outer-authority-finished').exists()
                if not record['outer_authority_finished']: raise RuntimeError('outer authority check did not complete')
                try:
                    release = os.open(root / 'authorization-rm-release', os.O_WRONLY | os.O_NONBLOCK)
                    try: os.write(release, b'release\n')
                    finally: os.close(release)
                    record['cleanup_released_after_authority'] = True
                except OSError as error:
                    record['cleanup_release_error'] = repr(error)
            if mode == 'deadline-fifo-after-cleanup':
                deadlines = [item for item in root.glob('whatsoup-bounded-deadline.*') if not item.name.endswith('.pending')]
                if len(deadlines) != 1: raise RuntimeError('deadline handoff unavailable')
                release = os.open(root / 'authorization-rm-release', os.O_WRONLY | os.O_NONBLOCK)
                try: os.write(release, b'release\n')
                finally: os.close(release)
                cleanup_deadline = time.monotonic() + 3
                while any(item['pid'] == worker for item in members(session)) and time.monotonic() < cleanup_deadline:
                    time.sleep(0.01)
                record['worker_cleanup_completed_before_authorization'] = not any(item['pid'] == worker for item in members(session))
                if not record['worker_cleanup_completed_before_authorization']: raise RuntimeError('worker did not finish before deadline substitution')
                while not (root / 'deadline-race-substituted').exists() and time.monotonic() < cleanup_deadline + 3:
                    time.sleep(0.01)
                record['deadline_replaced_with_fifo'] = (root / 'deadline-race-substituted').exists()
                if not record['deadline_replaced_with_fifo']: raise RuntimeError('deadline stat/open substitution was not reached')
            if mode in ('dead-leader-clean-cleanup', 'authorization-unreadable-after-cleanup'):
                if mode == 'authorization-unreadable-after-cleanup':
                    authorization.chmod(0)
                    record['authorization_unreadable'] = not os.access(authorization, os.R_OK)
                release = os.open(root / 'authorization-rm-release', os.O_WRONLY | os.O_NONBLOCK)
                try: os.write(release, b'release\n')
                finally: os.close(release)
                cleanup_deadline = time.monotonic() + 3
                while any(item['pid'] == worker for item in members(session)) and time.monotonic() < cleanup_deadline:
                    time.sleep(0.01)
                record['worker_cleanup_completed_before_authorization'] = not any(item['pid'] == worker for item in members(session))
                if not record['worker_cleanup_completed_before_authorization']: raise RuntimeError('worker did not finish clean cleanup')
            if mode == 'dead-leader-before-authorization':
                os.kill(guard, signal.SIGCONT)
                record['continued_guard'] = guard
            elif mode != 'dead-leader-finishing-cleanup':
                record['guard_left_stopped_for_deadline_reader'] = guard
        if mode == 'handshake-early-cont':
            deadline = time.monotonic() + 3
            while not (root / 'handshake-stop-entered').exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            if not (root / 'handshake-stop-entered').exists(): raise RuntimeError('worker stop entry unavailable')
            early_deadline = time.monotonic() + 0.2
            while not (root / 'handshake-early-cont').exists() and time.monotonic() < early_deadline:
                time.sleep(0.01)
            record['early_cont_before_stop'] = (root / 'handshake-early-cont').exists()
            (root / 'handshake-allow-stop').write_text('continue')
        if mode in ('parent-stopped', 'parent-terminated'):
            deadline = time.monotonic() + 3
            while not (root / 'command-started').exists() and time.monotonic() < deadline: time.sleep(0.01)
            command_pid, wrapper_pid = map(int, (root / 'command-started').read_text().split())
            wrapper = next(item for item in members(session) if item['pid'] == wrapper_pid)
            supervisor = wrapper['ppid']
            if supervisor == child.pid or not any(item['pid'] == supervisor for item in members(session)):
                raise RuntimeError('supervisor identity unavailable')
            record['command_pid'] = command_pid
            record['supervisor_pid'] = supervisor
            if mode == 'parent-stopped':
                os.kill(supervisor, signal.SIGSTOP)
                try:
                    time.sleep(1.5)
                    record['command_alive_while_parent_stopped'] = any(item['pid'] == command_pid for item in members(session))
                finally: os.kill(supervisor, signal.SIGCONT)
            else: os.kill(supervisor, signal.SIGTERM)
        if mode == 'deadline-timer-descendant':
            deadline = time.monotonic() + 8
            while not (root / 'timer-library-return').exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            if not (root / 'timer-library-return').exists(): raise RuntimeError('library return checkpoint unavailable')
            timer_group = int((root / 'timer-partial-signal').read_text())
            record['timer_survivors_after_return'] = [item for item in members(session) if item['pgid'] == timer_group]
        record['before_child_wait_ms'] = int((time.monotonic() - started) * 1000)
        child.wait(timeout=6 if mode in ('worker-stopped-after-authorization', 'forged-completion-worker-stopped') else 8)
        record['child_exit_ms'] = int((time.monotonic() - started) * 1000)
        record['exit'] = child.returncode
        record['sentinel_alive_before_cleanup'] = sentinel.poll() is None
        record['survivors_before_cleanup'] = members(session)
        record['pre_cleanup_inventory_ms'] = int((time.monotonic() - started) * 1000)
    except Exception as error:
        record['error'] = repr(error)
        record['at_error'] = members(session)
        record['stdout_at_error'] = (root / 'stdout').read_text()
        record['stderr_at_error'] = (root / 'stderr').read_text()
    finally:
        # Finish bounded cleanup if the Node-side watchdog requested shutdown.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        owned = members(session) if session == child.pid else []
        if session != child.pid: child.kill()
        record['cleanup_groups'] = sorted({item['pgid'] for item in owned})
        for group in record['cleanup_groups']:
            try: os.killpg(group, signal.SIGKILL)
            except ProcessLookupError: pass
        child.wait(timeout=3)
        deadline = time.monotonic() + 2
        while members(session) and time.monotonic() < deadline: time.sleep(0.01)
        record['survivors_after_cleanup'] = members(session)
        if sentinel.poll() is None: sentinel.kill()
        sentinel.wait(timeout=3)
        if master is not None: os.close(master)
        if slave is not None: os.close(slave)
        for holder in release_holders: os.close(holder)
record['duration_ms'] = int((time.monotonic() - started) * 1000)
record['stdout'] = (root / 'stdout').read_text()
record['stderr'] = (root / 'stderr').read_text()
record['command_started'] = (root / 'command-started').exists()
record['continued_after_stop'] = (root / 'handshake-cont-after-stop').exists()
record['verified_reader_killed'] = (root / 'reader-killed').exists()
record['command_partial_signal'] = (root / 'command-partial-signal').read_text() if (root / 'command-partial-signal').exists() else None
record['umask_groups'] = [int(value) for value in (root / 'umask-groups').read_text().split()] if (root / 'umask-groups').exists() else []
record['helper_vanished_after_probe'] = (root / 'helper-vanished-after-probe').exists()
record['helper_signal_refused'] = (root / 'helper-signal-refused').exists()
record['timer_partial_signal'] = (root / 'timer-partial-signal').read_text() if (root / 'timer-partial-signal').exists() else None
record['dangerous_kill_attempts'] = (root / 'dangerous-kill-attempts').read_text().splitlines() if (root / 'dangerous-kill-attempts').exists() else []
record['deadline_writer_armed'] = (root / 'deadline-writer-armed').exists()
record['deadline_writer_size0'] = (root / 'deadline-writer-size0').exists()
record['deadline_writer_exit'] = sorted(item.name.rsplit('.', 1)[1] for item in root.glob('deadline-writer-exit.*'))
record['deadline_marker_observed'] = (root / 'deadline-marker-observed').read_text().strip() if (root / 'deadline-marker-observed').exists() else None
record['deadline_preexisting_planted'] = (root / 'deadline-preexisting-planted').exists()
record['deadline_pending_planted'] = (root / 'deadline-pending-planted').exists()
record['pending_victim_contents'] = (root / 'pending-victim').read_text() if (root / 'pending-victim').exists() else None
record['deadline_watchdog_term'] = (root / 'deadline-watchdog-term').exists()
record['deadline_publish_limited'] = (root / 'deadline-publish-limited').exists()
record['deadline_absent_before_publish'] = (root / 'deadline-absent-before-publish').exists()
record['deadline_marker_mode'] = (root / 'deadline-marker-mode').read_text().strip() if (root / 'deadline-marker-mode').exists() else None
record['residual_bounded_files'] = sorted(item.name for item in root.glob('whatsoup-bounded*'))
if mode.startswith('event-order-') or os.environ.get('EVENT_ORDER_TRACE') == '1':
    record['events'] = (root / 'event-order.log').read_text().splitlines()
    record.setdefault('event_observations', [])
    for line in record['events'][len(record['event_observations']):]:
        record['event_observations'].append({'event': line, 'observed_monotonic_ns': time.monotonic_ns()})
    record['transport'] = terminal
    record['helper_sha256'] = hashlib.sha256(pathlib.Path(helper).read_bytes()).hexdigest()
    record['probe_sha256'] = hashlib.sha256((root / 'probe.sh').read_bytes()).hexdigest()
if (root / 'cleanup-residual-polls').exists():
    polls = (root / 'cleanup-residual-polls').read_text().splitlines()
    record['cleanup_residual_polls_raw'] = polls
    record['cleanup_residual_capture_valid'] = all(value.isdecimal() for value in polls)
    record['cleanup_residual_polls'] = len(polls)
if 'timeout_victim' in record: record['timeout_victim_contents'] = pathlib.Path(record['timeout_victim']).read_text()
if (root / 'outcome-fixture-ready').exists():
    record['outcome_substitution'] = (root / 'outcome-fixture-ready').read_text()
    record['outcome_paths'] = (root / 'outcome-fixture-paths').read_text().splitlines()
    record['outcome_claims'] = (root / 'outcome-claims').read_text().splitlines() if (root / 'outcome-claims').exists() else []
    record['outcome_victim_contents'] = (root / 'outcome-victim').read_text()
    record['outcome_directory_children'] = [str(child.relative_to(root)) for directory in root.glob('whatsoup-bounded-outcome.*') if directory.is_dir() for child in directory.iterdir()]
print(json.dumps(record))
