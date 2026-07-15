/**
 * Task status snapshot.
 *
 * Categorizes a list of tasks into active / recently-failed / recently-completed
 * and formats compact headlines + UTF-16-safe detail lines for operator display.
 *
 * ── Scope note ──────────────────────────────────────────────────────────
 * WhatSoup has NO background-task system today. This module is a FORMATTER
 * only: it formats any caller-supplied task list. It does not create, store,
 * schedule, or track tasks. Integration with a future task runner is a
 * separate concern. Building the formatter now (against a forward-compatible
 * input shape) means a future task system gets display for free.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Lifecycle status of a single task. */
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed';

/** A single task, as supplied by a (future) task runner. */
export interface TaskStatusInput {
  /** Stable task identifier. */
  id: string;
  /** Current lifecycle status. */
  status: TaskStatus;
  /** Human-readable title / summary. */
  title: string;
  /** Epoch ms when the task started (queued→running transition). Optional. */
  startedAt?: number;
  /** Epoch ms when the task reached a terminal state (completed/failed). Optional. */
  finishedAt?: number;
  /** Error text for failed tasks. Optional. */
  errorText?: string;
}

/** Options for {@link buildTaskStatusSnapshot}. */
export interface TaskSnapshotOptions {
  /** Injected clock for testing. Default Date.now. */
  now?: () => number;
  /** Window (ms) within which a failed task counts as "recent". Default 300_000 (5 min). */
  recentFailureWindowMs?: number;
  /** Window (ms) within which a completed task counts as "recent". Default 300_000 (5 min). */
  recentCompletionWindowMs?: number;
}

/** A categorized snapshot of the task list. */
export interface TaskStatusSnapshot {
  /** Tasks that are queued or running. */
  active: TaskStatusInput[];
  /** Tasks that failed within the recent-failure window. */
  recentlyFailed: TaskStatusInput[];
  /** Tasks that completed within the recent-completion window. */
  recentlyCompleted: TaskStatusInput[];
  /** Total task count across all categories. */
  total: number;
  /** Compact one-line headline for display. */
  headline: string;
}

/** Default 5-minute window for "recent" failures and completions. */
const DEFAULT_RECENT_WINDOW_MS = 300_000;

/**
 * Categorize tasks into active / recently-failed / recently-completed and
 * build a compact headline.
 *
 * Headline rules:
 *  - If there are recent failures: `"N recent failure(s)"` (failures are most actionable).
 *  - Else if there is active work: `"N active · M total"`.
 *  - Else if there are recent completions: `"recently finished"`.
 *  - Else: `"idle"`.
 */
export function buildTaskStatusSnapshot(
  tasks: readonly TaskStatusInput[],
  options: TaskSnapshotOptions = {},
): TaskStatusSnapshot {
  const now = (options.now ?? Date.now)();
  const failWindow = options.recentFailureWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const doneWindow = options.recentCompletionWindowMs ?? DEFAULT_RECENT_WINDOW_MS;

  const active: TaskStatusInput[] = [];
  const recentlyFailed: TaskStatusInput[] = [];
  const recentlyCompleted: TaskStatusInput[] = [];

  for (const task of tasks) {
    if (task.status === 'queued' || task.status === 'running') {
      active.push(task);
    } else if (task.status === 'failed') {
      if (typeof task.finishedAt === 'number' && now - task.finishedAt <= failWindow) {
        recentlyFailed.push(task);
      }
    } else if (task.status === 'completed') {
      if (typeof task.finishedAt === 'number' && now - task.finishedAt <= doneWindow) {
        recentlyCompleted.push(task);
      }
    }
  }

  const total = tasks.length;
  let headline: string;
  if (recentlyFailed.length > 0) {
    headline = `${recentlyFailed.length} recent failure${recentlyFailed.length === 1 ? '' : 's'}`;
  } else if (active.length > 0) {
    headline = `${active.length} active · ${total} total`;
  } else if (recentlyCompleted.length > 0) {
    headline = 'recently finished';
  } else {
    headline = 'idle';
  }

  return { active, recentlyFailed, recentlyCompleted, total, headline };
}

/**
 * Truncate text to `maxLen` UTF-16 code units, appending `…` if truncated.
 * Surrogate-safe: never splits a surrogate pair (rounds down to a whole pair).
 */
export function truncateUtf16Safe(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  // Avoid splitting a surrogate pair: if the char at the cut point is a high
  // surrogate (0xD800–0xDBFF), back up one.
  let cut = maxLen;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    cut -= 1;
  }
  return text.slice(0, cut) + '…';
}

/** Format a task title for compact display (UTF-16-safe truncation). */
export function formatTaskStatusTitle(task: TaskStatusInput, maxLen = 60): string {
  return truncateUtf16Safe(task.title || task.id, maxLen);
}

/** Format a task detail line: title + status + optional error. UTF-16-safe. */
export function formatTaskStatusDetail(task: TaskStatusInput, maxLen = 120): string {
  const parts: string[] = [`[${task.status}]`, task.title || task.id];
  if (task.status === 'failed' && task.errorText) {
    parts.push(`— ${task.errorText}`);
  }
  return truncateUtf16Safe(parts.join(' '), maxLen);
}
