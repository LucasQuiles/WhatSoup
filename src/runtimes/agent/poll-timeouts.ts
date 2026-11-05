import { MS_PER_HOUR } from '../../lib/time-units.ts';

// Watchdogs need the poll contract without initializing application configuration.
export const DEFAULT_POLL_TIMEOUT_MS = MS_PER_HOUR;
export const MIN_POLL_TIMEOUT_MS = 1_000;
export const MAX_POLL_TIMEOUT_MS = 86_400_000;

export function clampPollTimeoutMs(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs, MIN_POLL_TIMEOUT_MS), MAX_POLL_TIMEOUT_MS);
}

export function blockingPollWaitMs(toolName: string, toolInput: Record<string, unknown> | undefined): number {
  if (toolName !== 'send_poll' && !toolName.endsWith('__send_poll')) return 0;
  if (toolInput?.['awaitResult'] !== true) return 0;
  const timeoutMs = toolInput['timeoutMs'];
  return clampPollTimeoutMs(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_POLL_TIMEOUT_MS);
}
