// Predicates the runtime asks about a process or a session. Each answers from its argument alone.
import type { SessionManager } from './session.ts';
import { executionModeForProvider, isProviderId } from './providers/index.ts';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

/**
 * #2976 residual: managed-loop (API) providers advertise/execute WhatSoup
 * tools through the in-process provider MCP bridge (createProviderMcpBridge),
 * never a stdio-proxy socket. They therefore never wire a per-chat actor
 * socket, so in per_chat scope their executing turn's actor was NOT published
 * to the actor register — the bridge fell back to the stored session's stale
 * actorJid. Detect the bridge sessions so the provider boundary publishes
 * their actor into the same per-chat register (retired by the coordinator
 * post-effects seam) and the bridge resolver can read it at request time.
 */
export function sessionUsesInProcessBridge(session: SessionManager): boolean {
  const provider = session.getProviderId();
  return isProviderId(provider) && executionModeForProvider(provider) === 'managed_loop';
}
