// Moved verbatim out of runtime.ts to keep that file under its recorded size ceiling.
import type { SessionManager } from './session.ts';

/**
 * What a wedged-lane release did to the provider (#3374 C7). `reaped_child` is
 * the real-process wedge, where an intentional SIGKILL routes the exit through
 * the session's own crash machinery. `reap_skipped_no_child` is the
 * managed-provider wedge: the session holds no child, so nothing is killed and
 * the remote request is left outstanding — the release still frees the lane,
 * but it must not be recorded as a reap that happened.
 * `reap_unavailable` is a session surface that does not implement the reap.
 */
export type WedgedLaneReapOutcome = 'reaped_child' | 'reap_skipped_no_child' | 'reap_unavailable';

/**
 * Kill the wedged lane's provider child, if it has one, and report what
 * happened. `reapWedgedProviderChild` returns false when the session holds no
 * child — every managed-loop provider — so a bare call cannot distinguish a
 * reap from a no-op (#3374 C7). The absent-method case is a session surface
 * older than the reap and is named separately: it is not evidence that the
 * session had no child.
 */
export function reapWedgedLaneProvider(session: SessionManager): WedgedLaneReapOutcome {
  if (typeof session.reapWedgedProviderChild !== 'function') return 'reap_unavailable';
  return session.reapWedgedProviderChild() ? 'reaped_child' : 'reap_skipped_no_child';
}
