import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    warn: loggerWarn,
  }),
}));

import { clearAlertSource, emitAlert } from '../../src/lib/emit-alert.ts';

const ALERT_SCRIPT = join(homedir(), '.claude', 'scripts', 'whatsapp-alert.sh');
const SPAWN_OPTIONS = { stdio: 'ignore', timeout: 5_000, detached: false };

function spawnedChild() {
  return vi.mocked(spawn).mock.results.at(-1)?.value;
}

describe('emitAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
  });

  it('spawns the alert script with instance, source, summary, and evidence', () => {
    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    expect(spawn).toHaveBeenCalledWith(
      ALERT_SCRIPT,
      [
        '--instance',
        'whatsoup-prod',
        '--source',
        'agent_respawn_failed',
        '--summary',
        'respawn exhausted',
        '--evidence',
        'crashed 3 times',
      ],
      SPAWN_OPTIONS,
    );
  });

  it('unrefs the child process and registers an error handler', () => {
    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    const child = spawnedChild();
    expect(child?.unref).toHaveBeenCalledOnce();
    expect(child?.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('logs child process errors without throwing', () => {
    emitAlert('whatsoup-prod', 'agent_respawn_failed', 'respawn exhausted', 'crashed 3 times');

    const child = spawnedChild();

    expect(() => child?.emit('error', new Error('spawn failed'))).not.toThrow();
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        err: 'spawn failed',
      },
      'alert emission failed',
    );
  });
});

describe('clearAlertSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerWarn.mockClear();
  });

  it('spawns the alert script with clear source arguments', () => {
    clearAlertSource('whatsoup-prod', 'agent_respawn_failed');

    expect(spawn).toHaveBeenCalledWith(
      ALERT_SCRIPT,
      ['--clear', 'repair_lane:whatsoup-prod', '--source', 'agent_respawn_failed'],
      SPAWN_OPTIONS,
    );
  });

  it('unrefs the child process and registers an error handler', () => {
    clearAlertSource('whatsoup-prod', 'agent_respawn_failed');

    const child = spawnedChild();
    expect(child?.unref).toHaveBeenCalledOnce();
    expect(child?.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('logs child process errors without throwing', () => {
    clearAlertSource('whatsoup-prod', 'agent_respawn_failed');

    const child = spawnedChild();

    expect(() => child?.emit('error', new Error('spawn failed'))).not.toThrow();
    expect(loggerWarn).toHaveBeenCalledWith(
      {
        instance: 'whatsoup-prod',
        source: 'agent_respawn_failed',
        err: 'spawn failed',
      },
      'alert clear failed',
    );
  });
});
