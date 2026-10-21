import { expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BOUNDED_LIB = 'deploy/lib/bounded-exec.sh';
export const SHIM_SEARCH_PATH = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'];

export function resolveBinary(name: string): string | undefined {
  for (const dir of SHIM_SEARCH_PATH) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// A fresh session identifies every owned group, including Bash job-control
// groups. Capture survivors before finally cleans them; cleanup cannot make a
// lifecycle assertion pass. Processes that create a new session are outside
// this boundary and are not claimed as covered by these probes.
export type EventOrderMode = 'event-order-deadline-first' | 'event-order-expired-reaped' | 'event-order-inner-deadline-command-2' | 'event-order-outcome-candidate-directory' | 'event-order-stopped-worker-hard-cut' | `event-order-natural-${0 | 2 | 143}` | `event-order-near-deadline-${'result' | 'deadline'}-first` | 'event-order-frame-gap' | 'event-order-frame-gap-control' | 'event-order-frame-fragment' | 'event-order-frame-before-liveness' | 'event-order-frame-tear' | 'event-order-frame-tmout';

// Instrument a fixture-owned string, never the production helper. Each anchor
// must remain unique so a source change cannot silently remove an observation.
function observeLifecycleEventOrder(source: string): string {
  const insert = (anchor: string, replacement: string) => {
    expect(source.split(anchor).length, anchor).toBe(2);
    source = source.replace(anchor, () => replacement);
  };
  const event = (text: string) => `builtin printf '%s\\n' "${text}" >> "$EVENT_ORDER_LOG"`;
  insert('          sleep "$chunk" || return 2', [
    '          case "$EVENT_ORDER_MODE" in event-order-natural-*)',
    '            IFS= read -r event_release <> "$EVENT_ORDER_AUTHORITY_RELEASE" || return 2',
    '            [ "$event_release" = release ] || return 2',
    '            ;; esac',
    `          ${event('S_OUTER budget=$budget worker=$worker_pid')}`,
    '          sleep "$chunk" || return 2',
  ].join('\n'));
  insert('        [ "$start" = run ] || exit 2\n        trap', `        [ "$start" = run ] || exit 2\n        ${event('L_COMMAND')}\n        trap`);
  // D_INNER_COMMIT follows the link: that is when the reader can see the token.
  const inner = [
    '        ( umask 077; set -C; builtin printf \'%s\\n\' "$control_token" > "$deadline_file.pending" ) || exit 2',
    '        command -p link "$deadline_file.pending" "$deadline_file" 2>/dev/null || exit 2',
  ].join('\n');
  // A parked guard polls with an external sleep, not a FIFO read, so a TERM
  // trap runs within one poll on every bash, including one that retries a read.
  const park = [
    `        ${event('D_OUTER_PARKED')}`,
    '        event_polls=0; while [ "$event_polls" -lt 200 ]; do sleep 0.01; event_polls=$((event_polls + 1)); done',
    `        ${event('CONTROL_ERROR guard-park')}`,
  ];
  insert('        sleep "$budget" || exit 2', [
    // Result-first controls park the inner watchdog until worker cleanup reaps
    // it. The driver bounds the fixture independently of either watchdog.
    '        case "$EVENT_ORDER_MODE" in event-order-natural-*)',
    '          IFS= read -r event_release <> "$EVENT_ORDER_INNER_START" || exit 2',
    '          ;; esac',
    '        if [ "$EVENT_ORDER_MODE" = event-order-expired-reaped ] || [ "${EVENT_ORDER_MODE#event-order-near-deadline-}" != "$EVENT_ORDER_MODE" ]; then',
    '          IFS= read -r -t 2 event_release <> "$EVENT_ORDER_INNER_START" || exit 2',
    `          ${event('I_START')}`,
    '        fi',
    '        sleep "$budget" || exit 2',
  ].join('\n'));
  insert(inner, `        ${event('D_INNER_ENTER')}\n${inner}\n        ${event('D_INNER_COMMIT')}`);
  // A whole frame sets rc in _bounded_take_frame; raw is the status digits.
  const result = '        rc="$completed_rc"';
  insert(result, `${result}\n        ${event('R_FIFO rc=$rc raw=$completed_rc command=$cmd_pid group=$cmd_group')}`);
  const rejected = '      _bounded_wait_written_command() {';
  insert(rejected, `${rejected}\n        ${event('R_REJECT raw=$completed_frame')}`);
  const drained = '      _bounded_drain_frame() {';
  insert(drained, `${drained}\n        ${event('R_DRAIN command=$cmd_pid')}`);
  // The TMOUT case holds the tick source; only the fix has one.
  const ticker = '      ticker_pid=$!';
  insert(ticker, `${ticker}\n      case "$EVENT_ORDER_MODE" in event-order-frame-tmout) ${event('R_TICKER ticker=$ticker_pid')} ;; esac`);
  const resultClaim = '        _bounded_claim_outcome result "$rc"\n        outcome_claim_rc=$?';
  insert(resultClaim, `${resultClaim}\n        ${event('O_RESULT_CLAIM rc=$outcome_claim_rc result=$rc')}`);
  insert('          wait "$cmd_pid" 2>/dev/null || rc=$?', `          wait "$cmd_pid" 2>/dev/null || rc=$?\n          ${event('R_WAIT rc=$rc command=$cmd_pid group=$cmd_group')}`);
  // Frame modes act at the worker's first poll, before its read: the hold
  // modes park there; the tear and TMOUT modes only mark that the read comes
  // next.
  insert('        completed_rc=""', [
    '        completed_rc=""',
    '        case "$EVENT_ORDER_MODE" in',
    '          event-order-frame-gap|event-order-frame-gap-control|event-order-frame-fragment)',
    '            if [ -z "${event_poll_held-}" ]; then',
    '              event_poll_held=1',
    `              ${event('R_POLL_HOLD command=$cmd_pid')}`,
    '              if IFS= read -r -t 4 event_release <> "$EVENT_ORDER_POLL_RELEASE" && [ "$event_release" = release ]; then',
    `                ${event('R_POLL_RELEASE')}`,
    '              else',
    `                ${event('CONTROL_ERROR poll-hold')}`,
    '              fi',
    '            fi',
    '            ;;',
    '          event-order-frame-tear|event-order-frame-tmout)',
    '            if [ -z "${event_read_armed-}" ]; then',
    '              event_read_armed=1',
    `              ${event('R_READ_ARMED command=$cmd_pid')}`,
    '            fi',
    '            ;;',
    '        esac',
  ].join('\n'));
  // The command's frame is in the FIFO once this event is logged.
  insert('        exit "$rc"', [
    '        case "$EVENT_ORDER_MODE" in event-order-frame-*)',
    `          ${event('R_WRITTEN rc=$rc')}`,
    '          ;; esac',
    '        exit "$rc"',
  ].join('\n'));
  // Before-liveness holds the worker after a poll and before its liveness
  // check, so the command can write, exit and be reaped in that window.
  insert('        if ! kill -0 "$cmd_pid" 2>/dev/null; then', [
    '        if [ "$EVENT_ORDER_MODE" = event-order-frame-before-liveness ] && [ -z "${event_liveness_held-}" ]; then',
    '          event_liveness_held=1',
    `          ${event('R_LIVENESS_HOLD command=$cmd_pid')}`,
    '          if IFS= read -r -t 4 event_release <> "$EVENT_ORDER_POLL_RELEASE" && [ "$event_release" = release ]; then',
    `            ${event('R_LIVENESS_RELEASE')}`,
    '          else',
    `            ${event('CONTROL_ERROR liveness-hold')}`,
    '          fi',
    '        fi',
    '        if ! kill -0 "$cmd_pid" 2>/dev/null; then',
  ].join('\n'));
  insert('        rm -f "$timeout_file"', [
    '        case "$EVENT_ORDER_MODE" in event-order-natural-*|event-order-expired-reaped)',
    `          ${event('C_HOLD cleanup=$cleanup_rc command=$cmd_pid group=$cmd_group')}`,
    '          if IFS= read -r event_release <> "$EVENT_ORDER_CLEANUP_RELEASE" && [ "$event_release" = release ]; then',
    `            ${event('C_RELEASE')}`,
    '          else',
    `            ${event('CONTROL_ERROR cleanup-release')}`,
    '            cleanup_rc=2',
    '          fi',
    '          ;; esac',
    '        rm -f "$timeout_file"',
  ].join('\n'));
  insert('        [ "$cleanup_rc" -ne 0 ] || rm -f "$cleanup_file"', `        [ "$cleanup_rc" -ne 0 ] || rm -f "$cleanup_file"\n        ${event('C_COMPLETE cleanup=$cleanup_rc')}`);
  insert('      _bounded_claim_outcome deadline-outer\n      outcome_claim_rc=$?', [
    // Let the real parent end this guard after the worker returns. A second
    // fixture deadline could otherwise manufacture protocol failure first.
    '      if [ "$EVENT_ORDER_MODE" = event-order-inner-deadline-command-2 ]; then',
    `        ${event('D_OUTER_PARKED')}`,
    '        while :; do sleep 0.01; done',
    '      fi',
    '      case "$EVENT_ORDER_MODE" in event-order-outcome-candidate-directory)',
    '        IFS= read -r -t 2 event_release <> "$EVENT_ORDER_AUTHORITY_RELEASE" || { guard_status=2; _bounded_guard_exit; }',
    '        ;; esac',
    '      if [ "$EVENT_ORDER_MODE" = event-order-near-deadline-result-first ]; then',
    ...park,
    '      fi',
    `      ${event('D_OUTER_ENTER worker=$worker_pid')}`,
    '      _bounded_claim_outcome deadline-outer',
    '      outcome_claim_rc=$?',
    `      ${event('O_OUTER_CLAIM rc=$outcome_claim_rc worker=$worker_pid')}`,
    '      if [ "$EVENT_ORDER_MODE" = event-order-expired-reaped ]; then',
    '        IFS= read -r -t 2 event_release <> "$EVENT_ORDER_AUTHORITY_RELEASE" || { guard_status=2; _bounded_guard_exit; }',
    '      fi',
    '      if [ "$EVENT_ORDER_MODE" = event-order-near-deadline-deadline-first ]; then',
    ...park,
    '      fi',
  ].join('\n'));
  insert('      esac\n      _bounded_read_authorization\n      authorization_state=$?\n      if [ "$authorization_state" -eq 0 ]; then', [
    '      esac',
    '      _bounded_read_authorization',
    '      authorization_state=$?',
    `      ${event('AUTHORITY state=$authorization_state')}`,
    '      if [ "$authorization_state" -eq 0 ]; then',
  ].join('\n'));
  insert('    wait "$worker_pid" 2>/dev/null || worker_rc=$?', `    wait "$worker_pid" 2>/dev/null || worker_rc=$?\n    ${event('P_WORKER_REAPED worker=$worker_pid worker_rc=$worker_rc')}`);
  insert('        _bounded_end_worker_groups || guard_status=2', [
    '        _bounded_end_worker_groups || guard_status=2',
    '        if [ "$EVENT_ORDER_MODE" = event-order-stopped-worker-hard-cut ]; then',
    `          ${event('G_HARD_CUT worker=$worker_pid guard_status=$guard_status')}`,
    // Give the real parent its reaping/TERM boundary before this call returns.
    '          event_polls=0; while [ "$event_polls" -lt 100 ]; do sleep 0.01; event_polls=$((event_polls + 1)); done',
    `          ${event('CONTROL_ERROR hard-cut-parent-term')}`,
    '        fi',
  ].join('\n'));
  insert('              kill -CONT "$worker_pid" 2>/dev/null || kill -USR2 0 2>/dev/null', `              ${event('G_MONITOR_CONT worker=$worker_pid')}\n              kill -CONT "$worker_pid" 2>/dev/null || kill -USR2 0 2>/dev/null`);
  insert('      _bounded_read_deadline_bounded\n      deadline_rc=$?', `      _bounded_read_deadline_bounded\n      deadline_rc=$?\n      ${event('P_DEADLINE_READ deadline_rc=$deadline_rc cleanup_failed=$status_cleanup_failed')}`);
  insert('    _bounded_wait_guard "$guard_term_sent"', `    ${event('G_WAIT worker=$worker_pid guard=$guard_pid worker_rc=$worker_rc deadline_rc=$deadline_rc')}\n    _bounded_wait_guard "$guard_term_sent"\n    ${event('P_GUARD_REAPED guard=$guard_pid guard_rc=$guard_rc')}`);
  insert('    _bounded_outer_cleanup\n    trap - EXIT', `    ${event('A worker=$worker_pid worker_rc=$worker_rc guard=$guard_pid guard_rc=$guard_rc deadline_rc=$deadline_rc rc=$rc')}\n    _bounded_outer_cleanup\n    trap - EXIT`);
  return source;
}
const LIFECYCLE_DRIVER = fs.readFileSync(path.resolve('tests/deploy/fixtures/bounded-exec-lifecycle-driver.py'), 'utf8');
export function runLifecycleProbe(mode: EventOrderMode | 'guard-job-control-unavailable' | 'fast' | 'near-deadline' | 'printf-override' | 'leader-exits' | 'nested' | 'nonzero' | 'ordinary-exit-0' | 'ordinary-exit-2' | 'ordinary-exit-143' | 'status-255' | 'ownership-command' | 'ownership-watchdog' | 'ownership-caller-group' | 'reader-killed-after-verification' | 'watchdog-reader-killed-after-verification' | 'parent-stopped' | 'parent-terminated' | 'worker-stopped-after-authorization' | 'forged-completion-worker-stopped' | 'dead-leader-before-authorization' | 'dead-leader-clean-cleanup' | 'dead-leader-finishing-cleanup' | 'command-group-descendant' | 'cleanup-child-group' | 'deadline-timer-descendant' | 'deadline-helper-vanished' | 'deadline-helper-signal-refused' | 'deadline-fifo-after-cleanup' | 'authorization-unreadable-after-cleanup' | 'authorization-unreadable-guard-stuck' | 'authorized-guard-stuck' | 'setup-mktemp-term-ignoring' | 'setup-mkfifo-term-ignoring' | 'setup-ps-term-ignoring' | 'setup-timer-sleep-failure' | 'cleanup-residual' | 'handshake-early-cont' | 'control-tokenless' | 'control-duplicate-token' | 'control-low-group' | 'control-caller-group' | 'control-external-group' | 'control-tokenless-worker-stopped' | 'control-tokenless-cleanup-interrupted' | 'authorization-unreadable-cleanup-interrupted' | 'authorization-valid-cleanup-interrupted' | 'authorization-valid-outer-terminated-after-reap' | 'guard-terminated' | 'outer-terminated' | 'timeout-symlink' | 'timeout-existing' | 'outcome-symlink' | 'outcome-existing' | 'outcome-fifo' | 'outcome-directory' | 'outcome-candidate-symlink' | 'outcome-candidate-existing' | 'outcome-candidate-fifo' | 'outcome-candidate-directory' | 'outcome-candidate-fork-race-symlink' | 'guard-trap-in-record-read' | 'deadline-writer-interrupted' | 'deadline-writer-preexisting' | 'deadline-writer-publish-limited' | 'deadline-writer-pending-planted' | 'job-control-unavailable' | 'guard-first-grace-term-boundary' | 'zero', terminal = false, startup: 'normal' | 'delayed' | 'stalled' | 'stalled-after-release' = 'normal', helperReadiness: 'normal' | 'delayed' | 'stalled' = 'normal') {
  const nearDeadlineTrace = mode === 'near-deadline' && process.env.WHATSOUP_NEAR_DEADLINE_EVENT_TRACE === '1';
  const outcomeTrace = mode === 'outcome-candidate-directory' && process.env.WHATSOUP_OUTCOME_EVENT_TRACE === '1';
  const stoppedWorkerTrace = (mode === 'worker-stopped-after-authorization' || mode === 'forged-completion-worker-stopped') && process.env.WHATSOUP_STOPPED_WORKER_EVENT_TRACE === '1';
  // near-deadline always records its events: its expected result follows the claim order.
  const eventTrace = mode.startsWith('event-order-') || mode === 'near-deadline' || outcomeTrace || stoppedWorkerTrace;
  const eventOrderSource = eventTrace ? observeLifecycleEventOrder(fs.readFileSync(BOUNDED_LIB, 'utf8')) : undefined;
  let guardGroupSource: string | undefined;
  if (mode === 'guard-job-control-unavailable') {
    const source = fs.readFileSync(BOUNDED_LIB, 'utf8');
    const launch = '    worker_group="$worker_candidate"\n\n    (';
    const captured = '    guard_pid=$!\n';
    expect(source.split(launch)).toHaveLength(2);
    expect(source.split(captured)).toHaveLength(2);
    // Model a failed setpgid for only the guard; keep all other groups real.
    guardGroupSource = source.replace(launch, () => launch.replace('\n\n', '\n    set +m\n'))
      .replace(captured, () => captured + '    set -m\n');
  }
  let outcomeSource: string | undefined;
  if (mode.startsWith('outcome-') || mode === 'event-order-outcome-candidate-directory') {
    const source = eventOrderSource ?? fs.readFileSync(BOUNDED_LIB, 'utf8');
    const anchor = '    local outcome_file="${TMPDIR:-/tmp}/whatsoup-bounded-outcome.$$.$control_token"\n';
    const claimAnchor = '    _bounded_claim_outcome() {\n';
    expect(source.split(anchor)).toHaveLength(2);
    expect(source.split(claimAnchor)).toHaveLength(2);
    outcomeSource = source.replace(anchor, () => anchor + [
      '    local fixture_target',
      '    local fixture_targets=("$outcome_file")',
      '    case "$EVENT_ORDER_MODE" in outcome-candidate-*|event-order-outcome-candidate-*) fixture_targets=("$outcome_file.result" "$outcome_file.deadline-outer") ;; esac',
      '    for fixture_target in "${fixture_targets[@]}"; do',
      '      case "$EVENT_ORDER_MODE" in',
      '        *-symlink) command -p ln -s "$TMPDIR/outcome-victim" "$fixture_target" ;;',
      '        *-fifo) command -p mkfifo "$fixture_target" ;;',
      '        *-directory) command -p mkdir "$fixture_target" ;;',
      '        *-existing) builtin printf preexisting > "$fixture_target" ;;',
      '      esac',
      '      [ "$?" -eq 0 ] || exit 99',
      '      builtin printf "%s\\n" "$fixture_target" >> "$TMPDIR/outcome-fixture-paths"',
      '    done',
      '    builtin printf "%s" "$EVENT_ORDER_MODE" > "$TMPDIR/outcome-fixture-ready"',
      '',
    ].join('\n')).replace(claimAnchor, () => claimAnchor + '      builtin printf "%s\\n" "$1" >> "$TMPDIR/outcome-claims"\n');
    expect(outcomeSource.split(anchor)).toHaveLength(2);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded lifecycle '));
  const shim = path.join(root, 'bin');
  fs.mkdirSync(shim);
  if (outcomeSource) fs.writeFileSync(path.join(root, 'outcome-victim'), 'unchanged');
  const authorizationRmRelease = path.join(root, 'authorization-rm-release');
  if (eventTrace) {
    fs.writeFileSync(path.join(root, 'event-order.log'), '', { mode: 0o600 });
    if (mode.startsWith('event-order-')) {
      execFileSync(resolveBinary('mkfifo')!, ['event-order-cleanup-release', 'event-order-child-release', 'event-order-inner-start', 'event-order-authority-release', 'event-order-poll-release'].map((name) => path.join(root, name)));
    }
  }
  if (mode === 'dead-leader-before-authorization' || mode === 'dead-leader-clean-cleanup' || mode === 'dead-leader-finishing-cleanup' || mode === 'deadline-fifo-after-cleanup' || mode === 'authorization-unreadable-after-cleanup' || mode === 'authorization-unreadable-guard-stuck' || mode === 'authorized-guard-stuck') {
    execFileSync(resolveBinary('mkfifo')!, [authorizationRmRelease]);
  }
  for (const name of ['sleep', 'mktemp', 'mkfifo', 'rm', 'rmdir', 'cat', 'false', 'ps']) {
    const binary = resolveBinary(name);
    if (binary) fs.symlinkSync(binary, path.join(shim, name));
  }
  if (mode === 'cleanup-child-group') {
    fs.writeFileSync(path.join(root, 'umask-capture.sh'), [
      '#!/bin/bash',
      '"$REAL_PS" -o pgid= -p "$$" >> "$TMPDIR/umask-groups"',
      'builtin umask',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode === 'deadline-timer-descendant' || mode === 'deadline-helper-vanished' || mode === 'deadline-helper-signal-refused') {
    if (mode.startsWith('deadline-helper-')) {
      execFileSync(resolveBinary('mkfifo')!, ['status-helper-ready', 'status-helper-injected'].map((name) => path.join(root, name)));
    }
    fs.unlinkSync(path.join(shim, 'sleep'));
    fs.writeFileSync(path.join(shim, 'sleep'), [
      '#!/bin/bash',
      'group="$("$REAL_PS" -o pgid= -p "$$")" || exit 2',
      'group="${group//[[:space:]]/}"; [[ "$group" =~ ^[0-9]+$ ]] || exit 2',
      'builtin printf "%s\\n" "$$" > "$TMPDIR/sleep-child.$group"',
      'if [ "${STATUS_HELPER_READY-}" = 1 ]; then builtin printf "ready\\n" > "$TMPDIR/status-helper-ready"; fi',
      'exec /bin/sleep "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode === 'dead-leader-finishing-cleanup') {
    fs.unlinkSync(path.join(shim, 'sleep'));
    fs.writeFileSync(path.join(shim, 'sleep'), [
      '#!/bin/bash',
      'guard=""; [ ! -r "$TMPDIR/expected-guard-pid" ] || IFS= read -r guard < "$TMPDIR/expected-guard-pid"',
      'if [ "$1" = 2 ] && [ "$PPID" = "$guard" ]; then builtin printf ready > "$TMPDIR/outer-authority-finished"; fi',
      'exec /bin/sleep "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode.startsWith('ownership-') || mode.endsWith('reader-killed-after-verification')) {
    fs.unlinkSync(path.join(shim, 'ps'));
    fs.writeFileSync(path.join(shim, 'ps'), [
      '#!/bin/bash',
      'count=0; [ ! -f "$PS_COUNTER" ] || read -r count < "$PS_COUNTER"',
      'count=$((count + 1)); printf "%s\\n" "$count" > "$PS_COUNTER"',
      '[ "$count" -ne "$PS_FAIL_AT" ] || exit 1',
      'if [ "$PS_BORROW_GROUP" = 1 ]; then',
      '  if [ "$count" -eq 1 ]; then "$REAL_PS" "$@" > "$PS_CALLER_GROUP" || exit $?; cat "$PS_CALLER_GROUP"; exit; fi',
      '  if [ "$count" -eq 2 ]; then cat "$PS_CALLER_GROUP"; exit; fi',
      'fi',
      '"$REAL_PS" "$@"',
      'rc=$?',
      'if [ "$rc" -eq 0 ] && [ "$count" -eq "$PS_KILL_AT" ]; then',
      '  target=""; for argument in "$@"; do target="$argument"; done',
      '  kill -9 "$target" || exit 1',
      '  printf killed > "$PS_KILL_RECEIPT"',
      'fi',
      'exit "$rc"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode.startsWith('timeout-')) {
    fs.unlinkSync(path.join(shim, 'ps'));
    fs.writeFileSync(path.join(shim, 'ps'), [
      '#!/bin/bash',
      'control_file=""',
      'for candidate in "$TMPDIR"/whatsoup-bounded-control.*; do [ -f "$candidate" ] || continue; control_file="$candidate"; break; done',
      'if [ -n "$control_file" ] && [ ! -e "$TIMEOUT_PS_BLOCKED" ]; then',
      '  : > "$TIMEOUT_PS_BLOCKED"',
      '  while [ ! -f "$TIMEOUT_FIXTURE_READY" ]; do /bin/sleep 0.01; done',
      'fi',
      'exec "$REAL_PS" "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  const stalledSetupBinary = mode === 'setup-mktemp-term-ignoring' || mode === 'setup-timer-sleep-failure'
    ? 'mktemp'
    : mode === 'setup-mkfifo-term-ignoring'
      ? 'mkfifo'
      : mode === 'setup-ps-term-ignoring'
        ? 'ps'
        : undefined;
  if (stalledSetupBinary) {
    fs.unlinkSync(path.join(shim, stalledSetupBinary));
    fs.writeFileSync(path.join(shim, stalledSetupBinary), [
      '#!/bin/bash',
      'printf "%s\\n" "$$" > "$SETUP_PID"',
      'trap "" TERM HUP USR1',
      mode === 'setup-timer-sleep-failure' ? '/bin/sleep 30 &' : 'sleep 30 &',
      'child=$!',
      'printf "%s\\n" "$child" > "$SETUP_CHILD_PID"',
      'wait "$child"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode === 'setup-timer-sleep-failure') {
    fs.unlinkSync(path.join(shim, 'sleep'));
    fs.writeFileSync(path.join(shim, 'sleep'), [
      '#!/bin/bash',
      '[ "$1" != 1 ] || exit 1',
      'exec /bin/sleep "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  if (mode === 'cleanup-residual') {
    fs.unlinkSync(path.join(shim, 'sleep'));
    fs.writeFileSync(path.join(shim, 'sleep'), [
      '#!/bin/bash',
      'if [ "$1" = 0.01 ] && [ -e "$CLEANUP_RESIDUAL_ACTIVE" ]; then exec /bin/sleep 0.05; fi',
      'exec /bin/sleep "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  fs.writeFileSync(path.join(root, 'lifecycle.py'), LIFECYCLE_DRIVER);
  fs.writeFileSync(path.join(root, 'probe.sh'), [
    'cleanup_mode="$4"',
    'case "$4" in control-*|cleanup-residual)',
    '  kill() {',
    '    groups=""; [ ! -r "$KILL_INTERCEPT_GROUPS" ] || IFS= read -r groups < "$KILL_INTERCEPT_GROUPS"',
    '    if [ "$cleanup_mode" = cleanup-residual ] && [ "$1" = -0 ] && [ "$2" = -- ]; then',
    '      [ -n "$cleanup_group" ] || cleanup_group="$3"',
    '      if [ "$3" = "$cleanup_group" ]; then cleanup_group_checks=$((cleanup_group_checks + 1)); builtin printf active > "$CLEANUP_RESIDUAL_ACTIVE"; builtin printf "%s\\n" "$cleanup_group_checks" >> "$CLEANUP_RESIDUAL_POLLS"; [ "$cleanup_group_checks" -le 200 ] && return 0; fi',
    '    fi',
    '    for argument in "$@"; do',
    '      case "$argument" in -[0-9]*) case ",$groups," in *,"${argument#-}",*) builtin printf "%s\\n" "$argument" >> "$KILL_INTERCEPT_LOG"; return 0;; esac;; esac',
    '    done',
    '    builtin kill "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in dead-leader-before-authorization|dead-leader-clean-cleanup|dead-leader-finishing-cleanup|deadline-fifo-after-cleanup|authorization-unreadable-after-cleanup|authorization-unreadable-guard-stuck|authorized-guard-stuck)',
    '  rm() {',
    '    local argument marker_rc',
    '    for argument in "$@"; do',
    '      case "$argument" in',
    '        "$TMPDIR"/whatsoup-bounded-timeout.*)',
    '          set -C; : > "$AUTHORIZATION_RM_USED" 2>/dev/null; marker_rc=$?; set +C',
    '          if [ "$marker_rc" -eq 0 ] && [ "$cleanup_mode" = deadline-fifo-after-cleanup ]; then',
    '            "$REAL_RM" "$@"',
    '            builtin printf ready > "$AUTHORIZATION_RM_READY"',
    '            IFS= read -r _ < "$AUTHORIZATION_RM_RELEASE"',
    '            return 0',
    '          elif [ "$marker_rc" -eq 0 ]; then',
    '            builtin printf ready > "$AUTHORIZATION_RM_READY"',
    '            IFS= read -r _ < "$AUTHORIZATION_RM_RELEASE"',
    '          fi',
    '          ;;',
    '      esac',
    '    done',
    '    "$REAL_RM" "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in handshake-early-cont|job-control-unavailable)',
    '  set() { if [ "$cleanup_mode" = job-control-unavailable ] && [ "$#" -eq 1 ] && [ "$1" = -m ]; then : > "$TMPDIR/job-control-monitor-refused"; return 0; fi;',
    '    builtin set "$@"',
    '  }',
    '  kill() {',
    '    if [ "$cleanup_mode" = job-control-unavailable ] && [ "$1" = -STOP ] && [ "$2" = 0 ]; then',
    '      local self_pid="" self_group=""',
    '      self_pid="$(exec /bin/sh -c \'printf %s "$PPID"\')"',
    '      self_group="$("$REAL_PS" -o pgid= -p "$self_pid")" || return 2',
    '      self_group="${self_group//[[:space:]]/}"; builtin printf "%s %s\\n" "$self_pid" "$self_group" > "$TMPDIR/job-control-stop-witness"',
    '    elif [ "$cleanup_mode" = handshake-early-cont ] && [ "$1" = -STOP ] && [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -gt 1 ]; then',
    '      builtin printf entered > "$HANDSHAKE_STOP_ENTERED"',
    '      while [ ! -f "$HANDSHAKE_EARLY_CONT" ] && [ ! -f "$HANDSHAKE_ALLOW_STOP" ]; do /bin/sleep 0.01; done',
    '      builtin printf stopped > "$HANDSHAKE_STOPPED"',
    '    elif [ "$cleanup_mode" = handshake-early-cont ] && [ "$1" = -CONT ]; then',
    '      if [ -f "$HANDSHAKE_STOPPED" ]; then builtin printf continued > "$HANDSHAKE_CONT_AFTER_STOP"; else builtin printf early > "$HANDSHAKE_EARLY_CONT"; fi',
    '    fi',
    '    builtin kill "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in deadline-fifo-after-cleanup)',
    '  function [ {',
    '    target=""; builtin [ "$1" = -f ] && target="$2"; builtin [ "$1" = ! ] && builtin [ "$2" = -f ] && target="$3"',
    '    builtin [ "$@"; bracket_rc=$?',
    '    case "$target" in "$TMPDIR"/whatsoup-bounded-deadline.*)',
    '      if builtin [ ! -e "$DEADLINE_RACE_SUBSTITUTED" ] && builtin [ -f "$target" ]; then',
    '        "$REAL_RM" -f "$target"; mkfifo "$target"; builtin printf substituted > "$DEADLINE_RACE_SUBSTITUTED"',
    '      fi',
    '      ;; esac',
    '    return "$bracket_rc"',
    '  }',
    '  ;; esac',
    'case "$4" in command-group-descendant)',
    '  kill() {',
    '    if [ "$1" = -9 ] && [ -n "$cmd_group" ] && [ "$3" = "-$cmd_group" ] && [ ! -f "$TMPDIR/command-partial-signal" ]; then',
    '      builtin printf "%s\\n" "$cmd_group" > "$TMPDIR/command-partial-signal"',
    '      builtin kill -9 "$cmd_pid" 2>/dev/null; return 0',
    '    fi',
    '    builtin kill "$@"',
    '  }',
    '  ;; esac',
    // Classify the deadline marker at the outer existence check. `[` is the only
    // hook that runs there; every nested test uses `builtin [` to avoid recursion.
    'case "$4" in deadline-writer-*)',
    '  function [ {',
    '    case "$1" in -e)',
    '      case "${2##*/}" in *.pending) ;; whatsoup-bounded-deadline.*)',
    '        local observed=absent line=""',
    '        if builtin [ -L "$2" ] || builtin [ -e "$2" ]; then',
    '          observed=other',
    '          if builtin [ -f "$2" ] && ! builtin [ -s "$2" ]; then observed=empty',
    '          elif builtin [ -f "$2" ] && IFS= read -r line < "$2" && builtin [ "$line" = "$control_token" ]; then observed=token; fi',
    '        fi',
    '        builtin printf "%s\\n" "$observed" > "$DEADLINE_MARKER_OBSERVED"',
    '        if builtin [ "$observed" = token ]; then',
    '          if builtin [ -n "$(command -p find "$2" -prune -perm 600 2>/dev/null)" ]; then builtin printf "600\\n" > "$DEADLINE_MARKER_MODE"; else builtin printf "other\\n" > "$DEADLINE_MARKER_MODE"; fi',
    '        fi',
    '        ;; esac',
    '      ;; esac',
    '    builtin [ "$@"',
    '  }',
    '  ;; esac',
    // Interrupt the real watchdog writer after its exclusive create and before
    // its token write: the writer subshell calls `umask 077` first, and with a
    // zero file-size limit the create still succeeds while the write fails.
    // XFSZ is ignored so the write returns an error instead of dumping core.
    // The EXIT trap proves the size-0 state was reached; files it creates stay
    // empty, so the limit cannot block them. The other modes only record that
    // the writer was reached, except publish-limited, which lifts the soft
    // limit the watchdog set after its sleep so only the publish step runs
    // under it: link writes no data, while any copy leaves an empty marker.
    'case "$4" in deadline-writer-*)',
    '  umask() {',
    '    if builtin [ "$#" -eq 1 ] && builtin [ "${start-}" = run ] && builtin [ "${FUNCNAME[1]}" = whatsoup_run_bounded ]; then',
    '      builtin umask "$@" || return',
    '      : > "$DEADLINE_WRITER_ARMED" || return 2',
    // Lift it for the pending write only: a later umask, as in a copying
    // publish subshell, finds the pending file and keeps the limit.
    '      if builtin [ "$cleanup_mode" = deadline-writer-publish-limited ] && ! builtin [ -e "$deadline_file.pending" ] && ! builtin [ -L "$deadline_file.pending" ]; then',
    '        builtin [ -e "$deadline_file" ] || builtin [ -L "$deadline_file" ] || : > "$DEADLINE_ABSENT_BEFORE_PUBLISH"',
    '        ulimit -S -f "$(ulimit -H -f)" || return 2',
    '      fi',
    '      builtin [ "$cleanup_mode" = deadline-writer-interrupted ] || return 0',
    '      trap \'writer_status=$?; for marker in "$TMPDIR"/whatsoup-bounded-deadline.*; do if builtin [ -f "$marker" ] && ! builtin [ -s "$marker" ]; then : > "$DEADLINE_WRITER_SIZE0"; fi; done; : > "$DEADLINE_WRITER_EXIT.$writer_status"\' EXIT',
    '      trap "" XFSZ',
    '      ulimit -f 0',
    '      return 0',
    '    fi',
    '    builtin umask "$@"',
    '  }',
    // Record a watchdog TERM: it must follow only a published marker.
    '  kill() {',
    '    if builtin [ "$1" = -TERM ] && builtin [ "${start-}" = run ] && builtin [ "${FUNCNAME[1]}" = whatsoup_run_bounded ]; then : > "$DEADLINE_WATCHDOG_TERM"; fi',
    '    builtin kill "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in deadline-writer-publish-limited)',
    '  sleep() {',
    '    command sleep "$@" || return',
    '    if builtin [ "${start-}" = run ] && builtin [ "${FUNCNAME[1]}" = whatsoup_run_bounded ] && builtin [ -z "${publish_limit-}" ]; then',
    '      publish_limit=1; trap "" XFSZ; ulimit -S -f 0 || return 2',
    '      : > "$DEADLINE_PUBLISH_LIMITED"',
    '    fi',
    '  }',
    '  ;; esac',
    'case "$4" in cleanup-child-group)',
    '  umask() { if [ "$#" -eq 0 ]; then /bin/bash "$TMPDIR/umask-capture.sh"; else builtin umask "$@"; fi; }',
    '  ;; esac',
    // Mark the watchdog's budget sleep as the driver's readiness signal. Except
    // when the guard or the outer is signalled, also stretch it, so the command
    // and watchdog groups outlive the worker unless the guard ends them. With a
    // valid record, keep the guard in its grace until the outer has sent it
    // TERM, so that TERM always reaches it there. Every hold in these modes
    // leaves a barrier-expired marker if it runs out, which fails the case.
    'case "$4" in control-tokenless-worker-stopped|control-tokenless-cleanup-interrupted|authorization-*-cleanup-interrupted|authorization-valid-outer-terminated-after-reap|guard-terminated|outer-terminated|outcome-candidate-fork-race-symlink|guard-trap-in-record-read)',
    '  sleep() {',
    '    if [ "${start-}" = run ] && [ "${FUNCNAME[1]}" = whatsoup_run_bounded ] && [ "$1" = "$budget" ]; then',
    '      : > "$WATCHDOG_SLEEP_STARTED"',
    '      case "$cleanup_mode" in guard-terminated|outer-terminated) ;; *) : > "$WATCHDOG_SLEEP_STRETCHED"; command sleep 10; return;; esac',
    '    fi',
    '    if [ "$cleanup_mode" = authorization-unreadable-cleanup-interrupted ] && [ -z "${start-}" ] && [ -n "${guard_status-}" ] && [ "${FUNCNAME[1]}" = _bounded_wait_for_budget ] && [ "$1" = "$budget" ]; then',
    '      : > "$GUARD_TIMER_ENTERED"; local polls=0',
    '      while [ ! -e "$AUTHORIZATION_UNREADABLE_RELEASE" ] && [ "$polls" -lt 400 ]; do /bin/sleep 0.01; polls=$((polls + 1)); done',
    '      [ -e "$AUTHORIZATION_UNREADABLE_RELEASE" ] || : > "$BARRIER_EXPIRED-authorization-unreadable"',
    '    fi',
    '    if [ "${cleanup_mode#authorization-valid-}" != "$cleanup_mode" ] && [ -z "${start-}" ] && [ -n "${guard_status-}" ] && [ "${FUNCNAME[1]}" = whatsoup_run_bounded ] && [ "$1" = "$grace" ]; then',
    '      local polls=0',
    '      while [ ! -e "$OUTER_TERM_SENT" ] && [ "$polls" -lt 400 ]; do /bin/sleep 0.01; polls=$((polls + 1)); done',
    '      [ -e "$OUTER_TERM_SENT" ] || : > "$BARRIER_EXPIRED-guard-grace"',
    '    fi',
    '    command sleep "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in setup-*-term-ignoring)',
    '  sleep() {',
    '    if [ -n "${guard_status-}" ] && [ "$1" = "$grace" ]; then builtin printf "%s\\n" "$grace" > "$GUARD_GRACE_ENTERED"; fi',
    '    command sleep "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in guard-first-grace-term-boundary)',
    '  sleep() {',
    '    if [ -n "${guard_status-}" ] && [ "$1" = "$grace" ]; then',
    '      builtin printf "%s\\n" "$grace" > "$GUARD_GRACE_ENTERED"',
    '      command sleep 10',
    '    else',
    '      command sleep "$@"',
    '    fi',
    '  }',
    '  ;; esac',
    // Record the guard's USR1 to the worker. Valid-record cases require it;
    // the unreadable-record diagnostic requires its absence. Record the outer's
    // TERM to the guard as well. After the reap, the outer-terminated mode holds
    // the outer at its first resume of the guard until the driver sends TERM.
    // Every status passes through.
    'case "$4" in authorization-valid-*|authorization-unreadable-cleanup-interrupted|authorization-unreadable-guard-stuck)',
    '  kill() {',
    '    local kill_rc=0 polls=0',
    '    if [ "$cleanup_mode" = authorization-valid-outer-terminated-after-reap ] && [ -z "${outer_held-}" ] && [ "$1" = -CONT ] && [ -n "${guard_pid-}" ] && [ "$2" = "$guard_pid" ]; then',
    '      outer_held=1',
    '      : > "$OUTER_HOLDING"',
    '      while [ "$polls" -lt 400 ]; do /bin/sleep 0.01; polls=$((polls + 1)); done',
    '      : > "$BARRIER_EXPIRED-outer-hold"',
    '    fi',
    '    builtin kill "$@" || kill_rc=$?',
    '    if [ "$1" = -USR1 ] && [ -n "${worker_pid-}" ] && [ "$2" = "$worker_pid" ]; then : > "$GUARD_USR1_SENT"; fi',
    '    if [ "$1" = -TERM ] && [ -n "${guard_pid-}" ] && [ "$2" = "$guard_pid" ]; then : > "$OUTER_TERM_SENT"; fi',
    '    return "$kill_rc"',
    '  }',
    '  ;; esac',
    'case "$4" in authorization-unreadable-guard-stuck|authorized-guard-stuck)',
    '  sleep() {',
    '    if [ -n "${guard_status-}" ] && [ "$1" = "$grace" ]; then',
    '      : > "$GUARD_SLEEP_HELD"',
    '      while [ ! -e "$GUARD_SLEEP_RELEASE" ]; do /bin/sleep 0.01; done',
    '    fi',
    '    command sleep "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in authorization-unreadable-guard-stuck|authorized-guard-stuck)',
    '  kill() {',
    '    if [ "$1" = -TERM ] && [ -n "${guard_pid-}" ] && [ "$2" = "$guard_pid" ]; then',
    '      : > "$GUARD_TERM_HELD"',
    '      return 0',
    '    fi',
    '    builtin kill "$@"',
    '  }',
    '  ;; esac',
    // Hold the worker's cleanup at its first step, the ticker wait, or the
    // cleanup marker's umask where there is no ticker, until the driver has
    // sent the worker a trapped signal.
    'case "$4" in control-tokenless-cleanup-interrupted|authorization-*-cleanup-interrupted|authorization-valid-outer-terminated-after-reap)',
    '  cleanup_hold() {',
    '    [ -z "${cleanup_held-}" ] || return 0',
    '    cleanup_held=1',
    '    : > "$CLEANUP_HOLD"',
    '    local polls=0',
    '    while [ ! -e "$CLEANUP_HOLD_RELEASE" ] && [ "$polls" -lt 500 ]; do /bin/sleep 0.01; polls=$((polls + 1)); done',
    '    [ -e "$CLEANUP_HOLD_RELEASE" ] || : > "$BARRIER_EXPIRED-cleanup-hold"',
    '  }',
    '  wait() {',
    '    if [ "${FUNCNAME[1]}" = _bounded_worker_cleanup ] && [ -n "${ticker_pid-}" ] && [ "$1" = "$ticker_pid" ]; then cleanup_hold; fi',
    '    builtin wait "$@"',
    '  }',
    '  umask() {',
    '    if [ "$#" -eq 1 ] && [ "${FUNCNAME[1]}" = _bounded_reserve_cleanup_marker ] && [ "${FUNCNAME[2]}" = _bounded_worker_cleanup ]; then cleanup_hold; fi',
    '    builtin umask "$@"',
    '  }',
    '  ;; esac',
    'case "$4" in deadline-timer-descendant|deadline-helper-vanished|deadline-helper-signal-refused)',
    // The driver bounds these fixture barriers. Injection starts only after a
    // real status-timer child exists; setup scheduling is not a kill failure.
    '  case "$4" in deadline-helper-*)',
    '  sleep() {',
    '    if [[ "$cleanup_mode" = deadline-helper-* ]] && [ "${FUNCNAME[1]}" = _bounded_wait_for_budget ]; then',
    '      local injected',
    '      IFS= builtin read -r injected <> "$TMPDIR/status-helper-injected" || return 2',
    '      [ "$injected" = injected ] || return 2',
    '    fi',
    '    if [ "${FUNCNAME[1]}" = _bounded_read_deadline_bounded ]; then',
    helperReadiness === 'delayed' ? '      /bin/sleep 2' : helperReadiness === 'stalled' ? '      exec /bin/sleep 30' : '',
    '      STATUS_HELPER_READY=1 command sleep "$@"',
    '    else',
    '      command sleep "$@"',
    '    fi',
    '  }',
    '  ;; esac',
    '  kill() {',
    '    if [ "$1" = -9 ] && [ -n "$status_timer_pid" ] && [ "$3" = "-$status_timer_pid" ] && [ ! -f "$TMPDIR/timer-partial-signal" ]; then',
    '      if [[ "$cleanup_mode" = deadline-helper-* ]]; then',
    '        local ready',
    '        IFS= builtin read -r ready <> "$TMPDIR/status-helper-ready" || return 2',
    '        [ "$ready" = ready ] || return 2',
    '      else',
    '        count=0; while [ ! -s "$TMPDIR/sleep-child.$status_timer_pid" ] && [ "$count" -lt 100 ]; do /bin/sleep 0.01; count=$((count + 1)); done',
    '      fi',
    '      [ -s "$TMPDIR/sleep-child.$status_timer_pid" ] || return 2',
    '      builtin printf "%s\\n" "$status_timer_pid" > "$TMPDIR/timer-partial-signal"',
    '      if [[ "$cleanup_mode" = deadline-helper-* ]]; then builtin printf "injected\\n" > "$TMPDIR/status-helper-injected"; fi',
    // Model the observed fork race: the first signal catches the leader while its child survives.
    '      builtin kill -9 "$status_timer_pid"; return "$?"',
    '    fi',
    '    if [ "$cleanup_mode" = deadline-helper-vanished ] && [ "$1" = -0 ] && [ "$2" = -- ] && [ "$3" = "-$status_timer_pid" ] && [ -f "$TMPDIR/timer-partial-signal" ] && [ ! -f "$TMPDIR/helper-vanished-after-probe" ]; then',
    '      builtin kill "$@" || return "$?"',
    '      builtin kill -9 -- "-$status_timer_pid" || return 2',
    '      count=0; while builtin kill -0 -- "-$status_timer_pid" 2>/dev/null; do count=$((count + 1)); [ "$count" -lt 200 ] || return 2; /bin/sleep 0.01; done',
    '      builtin printf vanished > "$TMPDIR/helper-vanished-after-probe"',
    '      return 0',
    '    fi',
    '    if [ "$cleanup_mode" = deadline-helper-signal-refused ] && [ "$1" = -9 ] && [ "$3" = "-$status_timer_pid" ] && [ -f "$TMPDIR/timer-partial-signal" ]; then',
    '      builtin kill -0 -- "-$status_timer_pid" || return "$?"',
    '      builtin printf refused > "$TMPDIR/helper-signal-refused"',
    '      return 1',
    '    fi',
    '    builtin kill "$@"',
    '  }',
    '  ;; esac',
    // Model the fork race behind a one-shot group kill: the first SIGKILL of the
    // watchdog's group, named in this call's own record, reaches its leader only,
    // as a member forked at that instant would miss it. It records the caller.
    'case "$4" in outcome-candidate-fork-race-symlink)',
    '  kill() {',
    '    local file key value group=""',
    '    if [ "$#" -eq 3 ] && [ "$1" = -9 ] && [ "$2" = -- ] && [ ! -e "$TMPDIR/fork-race-intercept" ]; then',
    '      for file in "$TMPDIR"/whatsoup-bounded-authorize.*; do',
    '        [ -f "$file" ] || continue',
    '        while IFS="=" read -r key value; do [ "$key" != watchdog_group ] || group="$value"; done < "$file"',
    '      done',
    '      if [[ "$group" =~ ^[0-9]+$ ]] && [ "$group" -gt 1 ] && [ "$3" = "-$group" ] && ( set -C; builtin printf "%s %s\\n" "$group" "${FUNCNAME[1]}" > "$TMPDIR/fork-race-intercept" ) 2>/dev/null; then',
    '        builtin kill -9 "$group"; return',
    '      fi',
    '    fi',
    '    builtin kill "$@"',
    '  }',
    '  ;; esac',
    // TERM the guard inside its first record read, so its trap runs while that
    // read's `IFS='='` is in effect. It records the IFS length the trap sees.
    'case "$4" in guard-trap-in-record-read)',
    '  read() {',
    '    if [ "${FUNCNAME[1]}" = _bounded_read_authorization ] && [ -n "${guard_status+x}" ] && ( set -C; builtin printf "%s\\n" "${#IFS}" > "$TMPDIR/record-read-trap" ) 2>/dev/null; then',
    '      builtin kill -TERM "$(exec /bin/sh -c \'echo "$PPID"\')"',
    '    fi',
    '    builtin read "$@"',
    '  }',
    '  ;; esac',
    startup === 'delayed' ? '/bin/sleep 3.25' : startup === 'stalled' ? 'exec /bin/sleep 30' : '',
    outcomeSource ?? eventOrderSource ?? guardGroupSource ?? '. "$1"',
    'before_options="$-"',
    '[ "$4" != printf-override ] || printf() { return 91; }',
    'budget=6; case "$4" in event-order-frame-*) ;; event-order-*|nested|near-deadline|ordinary-exit-*|watchdog-reader-killed-after-verification|parent-stopped|worker-stopped-after-authorization|forged-completion-worker-stopped|dead-leader-before-authorization|dead-leader-clean-cleanup|dead-leader-finishing-cleanup|deadline-fifo-after-cleanup|authorization-unreadable-after-cleanup|authorization-unreadable-guard-stuck|authorized-guard-stuck|setup-*-term-ignoring|setup-timer-sleep-failure|cleanup-residual|handshake-early-cont|timeout-*|outcome-*|deadline-writer-*|guard-trap-in-record-read|job-control-unavailable|guard-first-grace-term-boundary) budget=1;; deadline-timer-descendant|deadline-helper-*|cleanup-child-group) budget=1;; control-*|authorization-*-cleanup-interrupted|authorization-valid-outer-terminated-after-reap) budget=1;; guard-terminated) budget=3;; zero) budget=0;; esac',
    '[ "$4" != event-order-frame-tmout ] || { TMOUT=1; export -n TMOUT; }',
    // These modes count groups that outlive the call. Such a group would hold a
    // capture pipe open and keep the probe from returning, so they use a file.
    'case "$4" in control-tokenless-worker-stopped|control-tokenless-cleanup-interrupted|authorization-*-cleanup-interrupted|authorization-valid-outer-terminated-after-reap|guard-terminated|outer-terminated|outcome-candidate-fork-race-symlink|guard-trap-in-record-read|guard-first-grace-term-boundary) capture_file="$TMPDIR/bounded-output";; *) capture_file="";; esac',
    'builtin printf prepared > "$TMPDIR/probe-prepared"',
    'IFS= builtin read -r go || exit 98',
    startup === 'stalled-after-release' ? 'exec /bin/sleep 30' : '',
    'if [ "$4" = deadline-timer-descendant ]; then',
    '  if out="$(builtin printf "payload\\n" | { whatsoup_run_bounded "$budget" "$2" "$3" "$4"; bounded_rc=$?; builtin printf returned > "$TMPDIR/timer-library-return"; exit "$bounded_rc"; })"; then rc=0; else rc=$?; fi',
    'elif [ -n "$capture_file" ]; then',
    '  if builtin printf "payload\\n" | whatsoup_run_bounded "$budget" "$2" "$3" "$4" > "$capture_file"; then rc=0; else rc=$?; fi',
    '  out="$(< "$capture_file")"',
    'else',
    'if out="$(builtin printf "payload\\n" | whatsoup_run_bounded "$budget" "$2" "$3" "$4")"; then rc=0; else rc=$?; fi',
    'fi',
    'case "$4" in guard-first-grace-term-boundary) if [ -e "$GUARD_GRACE_ENTERED" ]; then out="$out guard_grace_entered=true"; else out="$out guard_grace_entered=false"; fi ;; esac',
    'builtin printf "rc=%s output=%s options=%s/%s\\n" "$rc" "$out" "$before_options" "$-"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'child.sh'), [
    'printf "%s %s" "$$" "$PPID" > "$COMMAND_STARTED"',
    'if [ "$1" = event-order-stopped-worker-hard-cut ]; then value="$(sleep 30)"; printf "%s" "$value"; exit; fi',
    'case "$1" in event-order-*)',
    '  if declare -p control_token outcome_file >/dev/null 2>&1; then',
    '    builtin printf "%s\\n" "CHILD_SECRET_EXPORTED" >> "$EVENT_ORDER_LOG"',
    '    exit 99',
    '  fi',
    '  builtin printf "%s\\n" "CHILD_SECRET_ABSENT" >> "$EVENT_ORDER_LOG"',
    '  IFS= read -r payload',
    '  builtin printf "%s" "$payload"',
    '  builtin printf "%s\\n" "P_PAYLOAD" >> "$EVENT_ORDER_LOG"',
    '  case "$1" in event-order-frame-*)',
    '    if IFS= read -r -t 4 event_release <> "$EVENT_ORDER_CHILD_RELEASE" && [ "$event_release" = release ]; then',
    '      builtin printf "%s\\n" "CHILD_RELEASED" >> "$EVENT_ORDER_LOG"',
    '    else',
    '      builtin printf "%s\\n" "CONTROL_ERROR child-release" >> "$EVENT_ORDER_LOG"',
    '    fi',
    '    exit 0',
    '    ;; esac',
    '  case "$1" in event-order-inner-deadline-command-2|event-order-outcome-candidate-directory)',
    '    trap "exit 2" TERM',
    '    IFS= read -r -t 4 event_release <> "$EVENT_ORDER_CHILD_RELEASE"',
    '    exit 2',
    '    ;; esac',
    '  if [ "$1" = event-order-deadline-first ] || [ "$1" = event-order-expired-reaped ] || [ "${1#event-order-near-deadline-}" != "$1" ]; then',
    '    IFS= read -r -t 4 event_release <> "$EVENT_ORDER_CHILD_RELEASE"',
    '    exit 0',
    '  fi',
    '  exit "${1##*-}"',
    '  ;; esac',
    'if [ "$1" = leader-exits ]; then sleep 30 & kill -9 "$PPID"; wait; exit; fi',
    'if [ "$1" = command-group-descendant ]; then sleep 30 & exit 0; fi',
    'if [ "$1" = deadline-writer-preexisting ]; then',
    '  for control in "$TMPDIR"/whatsoup-bounded-control.*; do builtin printf "preexisting\\n" > "$TMPDIR/whatsoup-bounded-deadline.${control##*/whatsoup-bounded-control.}" && : > "$TMPDIR/deadline-preexisting-planted"; done',
    'fi',
    'if [ "$1" = deadline-writer-pending-planted ]; then',
    '  builtin printf "victim\\n" > "$TMPDIR/pending-victim"',
    '  for control in "$TMPDIR"/whatsoup-bounded-control.*; do command -p ln -s "$TMPDIR/pending-victim" "$TMPDIR/whatsoup-bounded-deadline.${control##*/whatsoup-bounded-control.}.pending" && : > "$TMPDIR/deadline-pending-planted"; done',
    'fi',
    // Ignore TERM so the command outlives the watchdog budget and the real
    // watchdog writer is reached instead of being reaped before it runs, or,
    // with a valid record, outlives the guard's TERM and the worker's.
    'if [ "$1" = authorized-guard-stuck ] || [ "$1" = authorization-unreadable-guard-stuck ]; then printf payload; : > "$AUTHORIZED_GUARD_STUCK_COMMAND_HELD"; while [ ! -e "$AUTHORIZED_GUARD_STUCK_COMMAND_RELEASE" ]; do /bin/sleep 0.01; done; exit; fi',
    'case "$1" in deadline-writer-*|authorization-valid-*) trap "" TERM; value="$(sleep 30)"; printf "%s" "$value"; exit;; esac',
    'case "$1" in cleanup-child-group|deadline-timer-descendant|deadline-helper-*|control-*|timeout-*|outcome-*|cleanup-residual|worker-stopped-after-authorization|forged-completion-worker-stopped|dead-leader-before-authorization|dead-leader-clean-cleanup|dead-leader-finishing-cleanup|deadline-fifo-after-cleanup|authorization-unreadable-after-cleanup|authorization-unreadable-cleanup-interrupted|guard-terminated|outer-terminated|guard-trap-in-record-read|guard-first-grace-term-boundary) value="$(sleep 30)"; printf "%s" "$value"; exit;; esac',
    'if [ "$1" != nested ] && [ "$1" != zero ] && [ "$1" != watchdog-reader-killed-after-verification ] && [ "$1" != parent-stopped ] && [ "$1" != parent-terminated ]; then',
    '  IFS= read -r payload',
    '  if [ "$1" = near-deadline ]; then sleep 0.75; else sleep 0.05; fi',
    '  printf "%s" "$payload"',
    '  [ "$1" != nonzero ] || exit 7',
    '  [ "$1" != ordinary-exit-2 ] || exit 2',
    '  [ "$1" != ordinary-exit-143 ] || exit 143',
    '  [ "$1" != status-255 ] || exit 255',
    'else',
    '  value="$(sleep 30)"',
    '  printf "%s" "$value"',
    'fi',
    '',
  ].join('\n'));
  try {
    const result = spawnSync(resolveBinary('python3')!, [
      path.join(root, 'lifecycle.py'), root, path.resolve(BOUNDED_LIB), resolveBinary('bash')!, mode, terminal ? 'pty' : 'pipe',
    ], { encoding: 'utf8', timeout: 15_000, env: {
      ...process.env, PATH: shim, TMPDIR: root,
      EVENT_ORDER_MODE: mode,
      EVENT_ORDER_TRACE: eventTrace ? '1' : '0',
      EVENT_ORDER_LOG: path.join(root, 'event-order.log'),
      EVENT_ORDER_CLEANUP_RELEASE: path.join(root, 'event-order-cleanup-release'),
      EVENT_ORDER_CHILD_RELEASE: path.join(root, 'event-order-child-release'),
      EVENT_ORDER_INNER_START: path.join(root, 'event-order-inner-start'),
      EVENT_ORDER_AUTHORITY_RELEASE: path.join(root, 'event-order-authority-release'),
      EVENT_ORDER_POLL_RELEASE: path.join(root, 'event-order-poll-release'),
      COMMAND_STARTED: path.join(root, 'command-started'),
      REAL_PS: resolveBinary('ps')!, PS_COUNTER: path.join(root, 'ps-counter'),
      PS_FAIL_AT: mode === 'ownership-command' ? '2' : mode === 'ownership-watchdog' ? '3' : '0',
      PS_KILL_AT: mode === 'reader-killed-after-verification' ? '2' : mode === 'watchdog-reader-killed-after-verification' ? '3' : '0',
      PS_BORROW_GROUP: mode === 'ownership-caller-group' || mode === 'guard-job-control-unavailable' ? '1' : '0',
      PS_CALLER_GROUP: path.join(root, 'caller-group'),
      PS_KILL_RECEIPT: path.join(root, 'reader-killed'),
      TIMEOUT_FIXTURE_READY: path.join(root, 'timeout-fixture-ready'),
      TIMEOUT_PS_BLOCKED: path.join(root, 'timeout-ps-blocked'),
      AUTHORIZED_GUARD_STUCK_COMMAND_HELD: path.join(root, 'authorized-guard-stuck-command-held'),
      AUTHORIZED_GUARD_STUCK_COMMAND_RELEASE: path.join(root, 'authorized-guard-stuck-command-release'),
      SETUP_PID: path.join(root, 'setup-pid'),
      SETUP_CHILD_PID: path.join(root, 'setup-child-pid'),
      KILL_INTERCEPT_GROUPS: path.join(root, 'dangerous-groups'),
      KILL_INTERCEPT_LOG: path.join(root, 'dangerous-kill-attempts'),
      REAL_RM: resolveBinary('rm')!,
      AUTHORIZATION_RM_READY: path.join(root, 'authorization-rm-ready'),
      AUTHORIZATION_RM_USED: path.join(root, 'authorization-rm-used'),
      AUTHORIZATION_RM_RELEASE: authorizationRmRelease,
      DEADLINE_RACE_SUBSTITUTED: path.join(root, 'deadline-race-substituted'),
      HANDSHAKE_STOP_ENTERED: path.join(root, 'handshake-stop-entered'),
      HANDSHAKE_STOPPED: path.join(root, 'handshake-stopped'),
      HANDSHAKE_EARLY_CONT: path.join(root, 'handshake-early-cont'),
      HANDSHAKE_ALLOW_STOP: path.join(root, 'handshake-allow-stop'),
      HANDSHAKE_CONT_AFTER_STOP: path.join(root, 'handshake-cont-after-stop'),
      CLEANUP_RESIDUAL_ACTIVE: path.join(root, 'cleanup-residual-active'),
      CLEANUP_RESIDUAL_POLLS: path.join(root, 'cleanup-residual-polls'),
      DEADLINE_WRITER_ARMED: path.join(root, 'deadline-writer-armed'),
      DEADLINE_WRITER_SIZE0: path.join(root, 'deadline-writer-size0'),
      DEADLINE_WRITER_EXIT: path.join(root, 'deadline-writer-exit'),
      DEADLINE_MARKER_OBSERVED: path.join(root, 'deadline-marker-observed'),
      DEADLINE_MARKER_MODE: path.join(root, 'deadline-marker-mode'),
      DEADLINE_WATCHDOG_TERM: path.join(root, 'deadline-watchdog-term'),
      DEADLINE_PUBLISH_LIMITED: path.join(root, 'deadline-publish-limited'),
      DEADLINE_ABSENT_BEFORE_PUBLISH: path.join(root, 'deadline-absent-before-publish'),
      WATCHDOG_SLEEP_STARTED: path.join(root, 'watchdog-sleep-started'),
      WATCHDOG_SLEEP_STRETCHED: path.join(root, 'watchdog-sleep-stretched'),
      GUARD_GRACE_ENTERED: path.join(root, 'guard-grace-entered'),
      GUARD_USR1_SENT: path.join(root, 'guard-usr1-sent'),
      GUARD_TIMER_ENTERED: path.join(root, 'guard-timer-entered'),
      AUTHORIZATION_UNREADABLE_RELEASE: path.join(root, 'authorization-unreadable-release'),
      OUTER_TERM_SENT: path.join(root, 'outer-term-sent'),
      GUARD_TERM_HELD: path.join(root, 'guard-term-held'),
      GUARD_SLEEP_HELD: path.join(root, 'guard-sleep-held'),
      GUARD_SLEEP_RELEASE: path.join(root, 'guard-sleep-release'),
      OUTER_HOLDING: path.join(root, 'outer-holding'),
      BARRIER_EXPIRED: path.join(root, 'barrier-expired'),
      CLEANUP_HOLD: path.join(root, 'cleanup-hold'),
      CLEANUP_HOLD_RELEASE: path.join(root, 'cleanup-hold-release'),
    } });
    if (result.error) throw new Error(`${result.error.message}\n${result.stdout}\n${result.stderr}`);
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout);
    if (outcomeTrace) process.stderr.write('OUTCOME_EVENT_TRACE ' + JSON.stringify(record) + '\n');
    if (stoppedWorkerTrace) process.stderr.write('STOPPED_WORKER_EVENT_TRACE ' + JSON.stringify(record) + '\n');
    if (nearDeadlineTrace) {
      const events = Array.isArray(record.events)
        ? record.events.filter((event: unknown) => typeof event === 'string' && /^(R_FIFO |O_RESULT_CLAIM |D_OUTER_ENTER|O_OUTER_CLAIM |A )/.test(event))
        : [];
      process.stderr.write('NEAR_DEADLINE_EVENT_TRACE ' + JSON.stringify({
        stdout: record.stdout,
        stderr: record.stderr,
        events,
      }) + '\n');
    }
    return record;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
export function expectLifecycleIsolation(result: ReturnType<typeof runLifecycleProbe>) {
  const evidence = JSON.stringify(result);
  expect(result.sentinel_alive_before_cleanup, evidence).toBe(true);
  expect(result.survivors_before_cleanup, evidence).toEqual([]);
  expect(result.survivors_after_cleanup, evidence).toEqual([]);
}
