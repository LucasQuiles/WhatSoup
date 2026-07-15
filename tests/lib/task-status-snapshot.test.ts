import { describe, expect, it } from 'vitest';

import {
  buildTaskStatusSnapshot,
  formatTaskStatusDetail,
  formatTaskStatusTitle,
  truncateUtf16Safe,
  type TaskStatusInput,
} from '../../src/lib/task-status-snapshot.ts';

function task(partial: Partial<TaskStatusInput> & { id: string }): TaskStatusInput {
  return { status: 'running', title: `Task ${partial.id}`, ...partial };
}

describe('buildTaskStatusSnapshot — categorization', () => {
  it('categorizes active tasks (queued + running)', () => {
    const snap = buildTaskStatusSnapshot([
      task({ id: '1', status: 'queued' }),
      task({ id: '2', status: 'running' }),
    ]);
    expect(snap.active).toHaveLength(2);
    expect(snap.recentlyFailed).toHaveLength(0);
    expect(snap.recentlyCompleted).toHaveLength(0);
    expect(snap.total).toBe(2);
  });

  it('categorizes a recent failure', () => {
    const now = 10_000;
    const snap = buildTaskStatusSnapshot(
      [task({ id: '1', status: 'failed', finishedAt: 8_000 })],
      { now: () => now },
    );
    expect(snap.recentlyFailed).toHaveLength(1);
    expect(snap.active).toHaveLength(0);
  });

  it('excludes a failure outside the window', () => {
    const now = 10_000;
    const snap = buildTaskStatusSnapshot(
      [task({ id: '1', status: 'failed', finishedAt: 0 })],
      { now: () => now, recentFailureWindowMs: 5_000 },
    );
    expect(snap.recentlyFailed).toHaveLength(0);
  });

  it('categorizes a recent completion', () => {
    const now = 10_000;
    const snap = buildTaskStatusSnapshot(
      [task({ id: '1', status: 'completed', finishedAt: 8_000 })],
      { now: () => now },
    );
    expect(snap.recentlyCompleted).toHaveLength(1);
  });

  it('excludes a completion outside the window', () => {
    const snap = buildTaskStatusSnapshot(
      [task({ id: '1', status: 'completed', finishedAt: 0 })],
      { now: () => 100_000, recentCompletionWindowMs: 5_000 },
    );
    expect(snap.recentlyCompleted).toHaveLength(0);
  });

  it('handles a failed task with no finishedAt (not recent)', () => {
    const snap = buildTaskStatusSnapshot([task({ id: '1', status: 'failed' })]);
    expect(snap.recentlyFailed).toHaveLength(0);
  });

  it('handles a completed task with no finishedAt (not recent)', () => {
    const snap = buildTaskStatusSnapshot([task({ id: '1', status: 'completed' })]);
    expect(snap.recentlyCompleted).toHaveLength(0);
  });

  it('handles empty task list', () => {
    const snap = buildTaskStatusSnapshot([]);
    expect(snap.total).toBe(0);
    expect(snap.headline).toBe('idle');
  });
});

describe('buildTaskStatusSnapshot — headline', () => {
  it('headline shows recent failures when present (most actionable)', () => {
    const snap = buildTaskStatusSnapshot(
      [
        task({ id: '1', status: 'running' }),
        task({ id: '2', status: 'failed', finishedAt: Date.now() - 1000 }),
      ],
      { now: () => Date.now() },
    );
    expect(snap.headline).toContain('recent failure');
  });

  it('headline uses singular "failure" for one', () => {
    const snap = buildTaskStatusSnapshot(
      [task({ id: '1', status: 'failed', finishedAt: Date.now() })],
      { now: () => Date.now() },
    );
    expect(snap.headline).toBe('1 recent failure');
  });

  it('headline uses plural "failures" for multiple', () => {
    const now = Date.now();
    const snap = buildTaskStatusSnapshot(
      [
        task({ id: '1', status: 'failed', finishedAt: now }),
        task({ id: '2', status: 'failed', finishedAt: now }),
      ],
      { now: () => now },
    );
    expect(snap.headline).toBe('2 recent failures');
  });

  it('headline shows active count when no failures', () => {
    const snap = buildTaskStatusSnapshot([
      task({ id: '1', status: 'running' }),
      task({ id: '2', status: 'queued' }),
      task({ id: '3', status: 'completed', finishedAt: 0 }),
    ]);
    expect(snap.headline).toBe('2 active · 3 total');
  });

  it('headline shows "recently finished" when only recent completions', () => {
    const snap = buildTaskStatusSnapshot(
      [task({ id: '1', status: 'completed', finishedAt: Date.now() - 1000 })],
      { now: () => Date.now() },
    );
    expect(snap.headline).toBe('recently finished');
  });

  it('headline is "idle" when nothing active/recent', () => {
    const snap = buildTaskStatusSnapshot([
      task({ id: '1', status: 'completed', finishedAt: 0 }),
    ]);
    expect(snap.headline).toBe('idle');
  });

  it('headline prioritizes failures over active', () => {
    const now = Date.now();
    const snap = buildTaskStatusSnapshot(
      [
        task({ id: '1', status: 'running' }),
        task({ id: '2', status: 'failed', finishedAt: now }),
      ],
      { now: () => now },
    );
    expect(snap.headline).toContain('recent failure');
    expect(snap.headline).not.toContain('active');
  });
});

describe('truncateUtf16Safe', () => {
  it('returns short text unchanged', () => {
    expect(truncateUtf16Safe('hello', 10)).toBe('hello');
  });

  it('truncates with ellipsis', () => {
    expect(truncateUtf16Safe('hello world', 5)).toBe('hello…');
  });

  it('returns exact-length text without ellipsis', () => {
    expect(truncateUtf16Safe('hello', 5)).toBe('hello');
  });

  it('does not split a surrogate pair at the boundary', () => {
    // "😀" is one surrogate pair (2 UTF-16 code units). Cutting at 1 would
    // split it; the function backs up to 0.
    const text = '😀😀😀';
    expect(truncateUtf16Safe(text, 1)).toBe('…');
    expect(truncateUtf16Safe(text, 3)).toBe('😀…');
  });

  it('handles empty string', () => {
    expect(truncateUtf16Safe('', 5)).toBe('');
  });

  it('handles maxLen of 0', () => {
    expect(truncateUtf16Safe('hello', 0)).toBe('…');
  });
});

describe('formatTaskStatusTitle', () => {
  it('formats a title', () => {
    expect(formatTaskStatusTitle(task({ id: '1', title: 'Do thing' }))).toBe('Do thing');
  });

  it('falls back to id when title empty', () => {
    expect(formatTaskStatusTitle(task({ id: 'abc', title: '' }))).toBe('abc');
  });

  it('truncates long titles', () => {
    const long = 'x'.repeat(100);
    const out = formatTaskStatusTitle(task({ id: '1', title: long }), 10);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(11); // 10 chars + ellipsis
  });

  it('respects custom maxLen', () => {
    expect(formatTaskStatusTitle(task({ id: '1', title: 'hello world' }), 5)).toBe('hello…');
  });
});

describe('formatTaskStatusDetail', () => {
  it('includes status bracket and title', () => {
    expect(
      formatTaskStatusDetail(task({ id: '1', status: 'running', title: 'Working' })),
    ).toBe('[running] Working');
  });

  it('includes error text for failed tasks', () => {
    expect(
      formatTaskStatusDetail(
        task({ id: '1', status: 'failed', title: 'Broken', errorText: 'timeout' }),
      ),
    ).toBe('[failed] Broken — timeout');
  });

  it('omits error text for non-failed tasks', () => {
    expect(
      formatTaskStatusDetail(
        task({ id: '1', status: 'completed', title: 'Done', errorText: 'ignored' }),
      ),
    ).toBe('[completed] Done');
  });

  it('truncates long details', () => {
    const long = 'y'.repeat(200);
    const out = formatTaskStatusDetail(task({ id: '1', title: long }), 20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to id when title empty', () => {
    expect(formatTaskStatusDetail(task({ id: 'x', title: '' }))).toBe('[running] x');
  });
});
