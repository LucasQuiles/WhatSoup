// Event-order instrumentation for the whatsoup_run_bounded lifecycle probes in
// credential-probe-boundedness.test.ts.
//
// observeLifecycleEventOrder rewrites a fixture-owned copy of
// deploy/lib/bounded-exec.sh so each lifecycle phase appends a line to
// $EVENT_ORDER_LOG; the probes then assert on the recorded order. It lives here
// so the lifecycle test stays under the arch.file-size line budget.
import { expect } from 'vitest';

export type EventOrderMode = 'event-order-deadline-first' | 'event-order-expired-reaped' | 'event-order-inner-deadline-command-2' | 'event-order-outcome-candidate-directory' | `event-order-natural-${0 | 2 | 143}` | `event-order-near-deadline-${'result' | 'deadline'}-first` | 'event-order-frame-gap' | 'event-order-frame-gap-control' | 'event-order-frame-fragment' | 'event-order-frame-before-liveness' | 'event-order-frame-tear' | 'event-order-frame-tmout';

// Instrument a fixture-owned string, never the production helper. Each anchor
// must remain unique so a source change cannot silently remove an observation.
export function observeLifecycleEventOrder(source: string): string {
  const insert = (anchor: string, replacement: string) => {
    expect(source.split(anchor).length, anchor).toBe(2);
    source = source.replace(anchor, () => replacement);
  };
  const event = (text: string) => `builtin printf '%s\\n' "${text}" >> "$EVENT_ORDER_LOG"`;
  insert('          sleep "$chunk" || return 2', `${event('S_OUTER budget=$budget worker=$worker_pid')}\n          sleep "$chunk" || return 2`);
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
    '        if [ "$EVENT_ORDER_MODE" = event-order-expired-reaped ] || [ "${EVENT_ORDER_MODE#event-order-near-deadline-}" != "$EVENT_ORDER_MODE" ]; then',
    '          IFS= read -r -t 2 event_release <> "$EVENT_ORDER_INNER_START" || exit 2',
    `          ${event('I_START')}`,
    '        fi',
    '        sleep "$budget" || exit 2',
  ].join('\n'));
  // Witness the publish. The EXIT trap records any exit with its status, so a
  // watchdog SIGKILLed while stalled leaves none, and bash's own errors, such
  // as a failed fork, go to a retained file instead of /dev/null.
  const [pending, link] = inner.split('\n');
  insert(inner, [
    '        exec 2>> "$TMPDIR/inner-watchdog-stderr"',
    '        trap \'inner_rc=$?; builtin printf "D_INNER_EXIT rc=%s\\n" "$inner_rc" >> "$EVENT_ORDER_LOG"\' EXIT',
    `        ${event('D_INNER_ENTER')}`,
    pending,
    `        ${event('D_INNER_PENDING')}`,
    link,
    `        ${event('D_INNER_COMMIT')}`,
  ].join('\n'));
  // The stopped-worker phases: the guard's second grace ends here.
  const endWorker = '        [ "$?" -eq 0 ] || { _bounded_guard_end_worker; guard_status=2; _bounded_guard_exit; }\n        _bounded_guard_end_worker';
  insert(endWorker, endWorker.replace('\n        _bounded_guard_end_worker', `\n        ${event('G_END_WORKER')}\n        _bounded_guard_end_worker`));
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
    '          if IFS= read -r -t 2 event_release <> "$EVENT_ORDER_CLEANUP_RELEASE" && [ "$event_release" = release ]; then',
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
    '      case "$EVENT_ORDER_MODE" in event-order-outcome-candidate-directory|event-order-inner-deadline-command-2)',
    `        IFS= read -r -t 2 event_release <> "$EVENT_ORDER_AUTHORITY_RELEASE" || { ${event('CONTROL_ERROR authority-hold')}; guard_status=2; _bounded_guard_exit; }`,
    '        ;; esac',
    '      if [ "$EVENT_ORDER_MODE" = event-order-near-deadline-result-first ]; then',
    ...park,
    '      fi',
    `      ${event('D_OUTER_ENTER worker=$worker_pid')}`,
    '      _bounded_claim_outcome deadline-outer',
    '      outcome_claim_rc=$?',
    `      ${event('O_OUTER_CLAIM rc=$outcome_claim_rc worker=$worker_pid')}`,
    '      if [ "$EVENT_ORDER_MODE" = event-order-expired-reaped ]; then',
    `        IFS= read -r -t 2 event_release <> "$EVENT_ORDER_AUTHORITY_RELEASE" || { ${event('CONTROL_ERROR authority-hold')}; guard_status=2; _bounded_guard_exit; }`,
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
  insert('      _bounded_read_deadline_bounded\n      deadline_rc=$?', `      _bounded_read_deadline_bounded\n      deadline_rc=$?\n      ${event('P_DEADLINE_READ deadline_rc=$deadline_rc cleanup_failed=$status_cleanup_failed')}`);
  insert('    wait "$guard_pid" 2>/dev/null || guard_rc=$?', `    ${event('G_WAIT worker=$worker_pid guard=$guard_pid worker_rc=$worker_rc deadline_rc=$deadline_rc')}\n    wait "$guard_pid" 2>/dev/null || guard_rc=$?\n    ${event('P_GUARD_REAPED guard=$guard_pid guard_rc=$guard_rc')}`);
  insert('    _bounded_outer_cleanup\n    trap - EXIT', `    ${event('A worker=$worker_pid worker_rc=$worker_rc guard=$guard_pid guard_rc=$guard_rc deadline_rc=$deadline_rc rc=$rc')}\n    _bounded_outer_cleanup\n    trap - EXIT`);
  return source;
}
