import type { ChildProcess } from 'node:child_process';
import { SIGNAL } from '../lib/signals.ts';

/** A signal request never establishes that an authentication writer has stopped. */
export function trackAuthHelper(child: ChildProcess) {
  let spawned = false;
  let confirmedClosed = false;
  let phase: 'running' | 'stopping' | 'unconfirmed' | 'closed' = 'running';
  let confirmClose!: () => void;
  const closed = new Promise<void>((resolve) => { confirmClose = resolve; });
  let stopping: Promise<'closed' | 'unconfirmed'> | undefined;
  const finish = () => {
    if (confirmedClosed) return;
    confirmedClosed = true;
    phase = 'closed';
    confirmClose();
  };
  child.once('spawn', () => { spawned = true; });
  child.once('close', finish);
  child.on('error', () => {
    // A failed spawn has no process to reconcile; a running child's error does.
    if (!spawned && child.pid === undefined) finish();
  });
  return {
    child,
    closed,
    get confirmedClosed() { return confirmedClosed; },
    get phase() { return phase; },
    stop(): Promise<'closed' | 'unconfirmed'> {
      if (confirmedClosed) return Promise.resolve('closed');
      if (stopping) return stopping;
      phase = 'stopping';
      stopping = new Promise((resolve) => {
        let settled = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const complete = (outcome: 'closed' | 'unconfirmed') => {
          if (settled) return;
          settled = true;
          clearTimeout(escalation);
          if (deadline) clearTimeout(deadline);
          if (!confirmedClosed) phase = 'unconfirmed';
          resolve(outcome);
        };
        const escalation = setTimeout(() => {
          try { child.kill(SIGNAL.KILL); } catch { /* intentional: Exit remains unconfirmed until close. */ }
          deadline = setTimeout(() => complete(confirmedClosed ? 'closed' : 'unconfirmed'), 5000);
        }, 5000);
        void closed.then(() => complete('closed'));
        try { child.kill(SIGNAL.TERM); } catch { /* intentional: Retain ownership and the bounded confirmation wait. */ }
      });
      return stopping;
    },
  };
}

export type AuthHelper = ReturnType<typeof trackAuthHelper>;
