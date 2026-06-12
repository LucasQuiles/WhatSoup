// tests/lib/emit-alert-exit.test.ts
// Verifies that emitAlert and clearAlertSource warn on non-zero exit or signal.
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BOT_ERRORS_JID = '120363555555555000@g.us';

const loggerWarn = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    warn: loggerWarn,
  }),
}));

import { emitAlert, clearAlertSource } from '../../src/lib/emit-alert.ts';

function spawnedChild() {
  return vi.mocked(spawn).mock.results.at(-1)?.value;
}

describe('emitAlert exit handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];
  });

  afterEach(() => {
    delete process.env['BOT_ERRORS_OUTBOX_DIR'];
    delete process.env['BOT_ERRORS_JID'];
    delete process.env['BOT_ERRORS_EXPECTED_JID'];
  });

  it('warns when the child exits with a non-zero exit code', () => {
    emitAlert('primary-line', 'agent_crash', 'summary text', 'evidence text');

    const child = spawnedChild();
    child?.emit('exit', 1, null);

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent_crash', exitCode: 1, signal: null }),
      expect.stringContaining('legacy helper exited'),
    );
  });

  it('warns when the child is killed by a signal', () => {
    emitAlert('primary-line', 'agent_crash', 'summary text', 'evidence text');

    const child = spawnedChild();
    child?.emit('exit', null, 'SIGTERM');

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent_crash', exitCode: null, signal: 'SIGTERM' }),
      expect.stringContaining('legacy helper exited'),
    );
  });

  it('does not warn when the child exits cleanly (code 0, no signal)', () => {
    emitAlert('primary-line', 'agent_crash', 'summary text', 'evidence text');

    const child = spawnedChild();
    loggerWarn.mockClear();
    child?.emit('exit', 0, null);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('does not include the alert body text (summary/evidence) in the warn log', () => {
    emitAlert('primary-line', 'agent_crash', 'super secret summary', 'sensitive evidence');

    const child = spawnedChild();
    child?.emit('exit', 2, null);

    for (const call of loggerWarn.mock.calls) {
      const callStr = JSON.stringify(call);
      expect(callStr).not.toContain('super secret summary');
      expect(callStr).not.toContain('sensitive evidence');
    }
  });

  it('registers the exit handler on the child process', () => {
    emitAlert('primary-line', 'agent_crash', 'summary', 'evidence');

    const child = spawnedChild();
    expect(child?.on).toHaveBeenCalledWith('exit', expect.any(Function));
  });
});

describe('clearAlertSource exit handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    process.env['BOT_ERRORS_OUTBOX_DIR'] = '/dev/null/outbox';
    process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
    process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
    delete process.env['BOT_ERRORS_REQUIRE_EXPECTED'];
  });

  afterEach(() => {
    delete process.env['BOT_ERRORS_OUTBOX_DIR'];
    delete process.env['BOT_ERRORS_JID'];
    delete process.env['BOT_ERRORS_EXPECTED_JID'];
  });

  it('warns when the clear script exits with a non-zero code', () => {
    clearAlertSource('primary-line', 'agent_crash');

    const child = spawnedChild();
    child?.emit('exit', 1, null);

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent_crash', exitCode: 1, signal: null }),
      expect.stringContaining('legacy helper exited'),
    );
  });

  it('does not warn when the clear script exits cleanly', () => {
    clearAlertSource('primary-line', 'agent_crash');

    const child = spawnedChild();
    loggerWarn.mockClear();
    child?.emit('exit', 0, null);
    expect(loggerWarn).not.toHaveBeenCalled();
  });
});
