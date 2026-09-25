/**
 * #3149 — managed-loop fallback capability disclosure.
 *
 * When a chat is served by a managed-loop API fallback (an API provider
 * standing in for a configured CLI primary), the ambient child-process tool
 * surface silently disappears. This module owns the three pieces that make
 * that degradation visible: the pure eligibility predicate, the user/model
 * copy factories, and the deduped user-notice emit. Kept out of
 * runtime-fallback.ts deliberately — the coordinator is at its file-size
 * budget and none of this needs coordinator state.
 */
import { systemClock } from '../../lib/clock.ts';
import { executionModeForProvider, isProviderId } from './providers/index.ts';
import type { IOutboundQueue } from './outbound-queue.ts';

/**
 * A session is a DEGRADED managed-loop fallback exactly when the provider
 * about to serve it is a managed-loop API provider that is NOT the configured
 * primary and was NOT chosen by an explicit route policy. Only then does the
 * child-process tool surface silently differ from what the operator
 * configured — which is what the disclosure exists for. A route-selected
 * managed-loop provider and a managed-loop PRIMARY are deliberate
 * configurations, not degradations; an unknown provider string never earns a
 * disclosure by guesswork.
 */
export function isManagedLoopFallbackDegraded(
  sessionProvider: string,
  configuredPrimary: string,
  hasRoutePolicy: boolean,
): boolean {
  if (hasRoutePolicy) return false;
  if (sessionProvider === configuredPrimary) return false;
  return isProviderId(sessionProvider)
    && executionModeForProvider(sessionProvider) === 'managed_loop';
}

/**
 * Copy for the user-visible degraded-capabilities disclosure. Names the absent
 * capability CLASSES only — generic by design (seam-6: no secrets, no provider
 * internals, no PII).
 */
export function managedLoopDegradedNotice(): string {
  return "_Heads up: I'm running on a backup connection with reduced abilities."
    + ' I can still chat, but local files, shell commands, and skills are'
    + ' unavailable until my primary access is restored._';
}

/**
 * The same degradation fact for the MODEL's turn context, so it cannot
 * honestly claim child-process work while serving on a managed-loop fallback.
 * The session injects it as a system-prompt source only when the runtime
 * marks the session degraded; every other prompt stays byte-identical.
 */
export function managedLoopDegradedSystemBlock(): string {
  return [
    'DEGRADED CAPABILITIES — this conversation is currently served over a backup',
    'API connection with NO child process: no shell, no local file access, no',
    'skills or plugins. The only tools that exist are the ones explicitly listed',
    'for this conversation. Do not claim to run commands, read or write local',
    'files, or start background work; if asked, say the capability is unavailable',
    'until primary access is restored.',
  ].join('\n');
}

/**
 * Enqueue the user disclosure at most once per chat per dedup window
 * (prune→check→set→capDedupeMap, the emitNoFallbackReauthNotice idiom). The
 * window intentionally re-notifies during a days-long degradation.
 */
export function emitManagedLoopDegradedNotice(opts: {
  queue: IOutboundQueue;
  recentNotices: Map<string, number>;
  noticeDedupMs: number;
  capDedupeMap: (map: Map<string, number>) => void;
}): void {
  const now = systemClock.now();
  for (const [key, recordedAt] of opts.recentNotices) {
    if (now - recordedAt > opts.noticeDedupMs) {
      opts.recentNotices.delete(key);
    }
  }
  const noticeKey = [opts.queue.targetChatJid, 'managed-loop-degraded'].join(':');
  if (opts.recentNotices.has(noticeKey)) return;
  opts.queue.enqueueText(managedLoopDegradedNotice());
  opts.recentNotices.set(noticeKey, now);
  opts.capDedupeMap(opts.recentNotices);
}
