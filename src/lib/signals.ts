// src/lib/signals.ts
// Shared signal-name constants for cross-platform child-process control.
//
// `child.kill()` and related APIs accept POSIX signal-name strings. Those
// names were previously spread across the codebase as bare 'SIGTERM' /
// 'SIGKILL' literals at each call site (see #2643). Centralizing them here
// is a pure rename/alias — the emitted signal strings are unchanged — but
// gives any future Windows-portability work one place to adapt kill
// semantics instead of a multi-file find-and-replace.

/** POSIX signal names used for graceful/forceful child-process termination. */
export const SIGNAL = {
  /** Graceful termination request; the target may catch or ignore it. */
  TERM: 'SIGTERM',
  /** Immediate, uncatchable termination. */
  KILL: 'SIGKILL',
} as const;

export type SignalName = (typeof SIGNAL)[keyof typeof SIGNAL];
