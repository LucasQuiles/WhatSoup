import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

// Fixture for the stopped-worker probes in ../credential-probe-boundedness.test.ts.

export function installSleepLedgerShim(shim: string) {
  // Record each whole-second wait with its parent, so the guard's own waits
  // can be counted.
  fs.unlinkSync(path.join(shim, 'sleep'));
  fs.writeFileSync(path.join(shim, 'sleep'), [
    '#!/bin/bash',
    'case "$1" in *.*) ;; *) builtin printf "%s %s\\n" "$PPID" "$1" >> "$TMPDIR/sleep-ledger" ;; esac',
    'exec /bin/sleep "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
}

// The fields of the lifecycle driver's JSON record that the chain check reads.
interface StoppedWorkerProbeRecord {
  error?: unknown;
  events: string[];
  stopped_worker: number;
  sleep_ledger: string[];
}

// The guard's monitor resumes the worker once, from the worker's own startup
// stop, and exits. The worker writes its authorization only after that, and the
// driver stops it only after reading the authorization, so this stop has no
// resume and only the guard can end the worker: the budget, one grace for the
// worker's timeout entry, one for the recorded groups, then SIGKILL.
// W_WORKER_STATE checks that at run time, because worker_rc=137 would also fit
// a worker that was resumed and then killed. It is read before the guard's
// cleanup, whose own SIGSTOP of the group would make any later read show T.
// The fixture holds the budget until the worker is stopped, and the events show
// the call returned through that fixed chain and waited for nothing else, so
// the bound holds however slowly the host runs. A wall-clock limit here
// measured host load instead: the chain's own timers take 5 s of the 6 s it
// allowed.
export function expectGuardChainEndsStoppedWorker(result: StoppedWorkerProbeRecord) {
  const evidence = JSON.stringify(result);
  expect(result.error, evidence).toBeUndefined();
  const events: string[] = result.events;
  const index = (name: string) => events.findIndex((event) => event === name || event.startsWith(`${name} `));
  const worker = result.stopped_worker;
  expect(index('CONTROL_ERROR'), evidence).toBe(-1);
  expect(index(`H_WORKER_STOPPED worker=${worker}`), evidence).toBeGreaterThanOrEqual(0);
  expect(index(`S_OUTER budget=1 worker=${worker}`), evidence).toBeGreaterThan(index(`H_WORKER_STOPPED worker=${worker}`));
  expect(events[index('O_OUTER_CLAIM')], evidence).toBe(`O_OUTER_CLAIM rc=0 worker=${worker}`);
  expect(index('O_OUTER_CLAIM'), evidence).toBeGreaterThan(index('S_OUTER'));
  expect(index('AUTHORITY state=0'), evidence).toBeGreaterThan(index('O_OUTER_CLAIM'));
  expect(index(`G_GRACE_ELAPSED n=1 worker=${worker}`), evidence).toBeGreaterThan(index('AUTHORITY state=0'));
  expect(index(`G_GRACE_ELAPSED n=2 worker=${worker}`), evidence).toBeGreaterThan(index(`G_GRACE_ELAPSED n=1 worker=${worker}`));
  expect(index(`W_WORKER_STATE worker=${worker}`), evidence).toBeGreaterThan(index(`G_GRACE_ELAPSED n=2 worker=${worker}`));
  expect(events[index('W_WORKER_STATE')], evidence).toMatch(new RegExp(`^W_WORKER_STATE worker=${worker} stat=T`));
  expect(index(`P_WORKER_REAPED worker=${worker} worker_rc=137`), evidence).toBeGreaterThan(index(`W_WORKER_STATE worker=${worker}`));
  expect(events.filter((event) => event.startsWith('P_WORKER_REAPED ')), evidence).toHaveLength(1);
  const returned = new RegExp(`^A worker=${worker} worker_rc=137 guard=(\\d+) guard_rc=2 deadline_rc=\\d+ rc=2$`).exec(events[index('A')]);
  expect(returned, evidence).not.toBeNull();
  expect(index('A'), evidence).toBeGreaterThan(index('P_WORKER_REAPED'));
  // The guard itself waits only its two graces; the budget runs in its timer.
  const guard = returned?.[1];
  expect(result.sleep_ledger.filter((entry: string) => entry.startsWith(`${guard} `)), evidence).toEqual([`${guard} 2`, `${guard} 2`]);
}
