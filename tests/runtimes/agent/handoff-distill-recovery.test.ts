import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ensureHandoffArtifactSchema, getHandoffArtifact } from '../../../src/runtimes/agent/handoff-artifact.ts';

const { rows, tokens, distill, alert, clear } = vi.hoisted(() => ({
  rows: vi.fn(),
  tokens: vi.fn(),
  distill: vi.fn(),
  alert: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  listActiveSessionRows: rows,
  getSessionTokenSnapshot: tokens,
}));
vi.mock('../../../src/runtimes/agent/handoff-summarizer.ts', () => ({
  buildHandoffDistill: ({ conversationKey }: { conversationKey: string }) => () => distill(conversationKey),
}));
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: alert,
  clearAlertSourceChecked: clear,
}));

import { HandoffDistillCoordinator } from '../../../src/runtimes/agent/handoff-distill-coordinator.ts';

describe('handoff distiller recovery through the real runner and artifact store', () => {
  let db: Database;
  let coordinator: HandoffDistillCoordinator;
  const success = { summary: 'persisted recovery', seededArtifacts: null, tokensUsed: 10 };

  function sweep(): Promise<void> {
    return (coordinator as unknown as { sweep(): Promise<void> }).sweep();
  }

  async function failOnce(): Promise<void> {
    distill.mockRejectedValueOnce(new Error('provider unavailable'));
    await sweep();
    expect(alert).toHaveBeenCalledWith('test', 'handoff-distill:test', expect.any(String), expect.any(String), 'warning');
    expect(getHandoffArtifact(db, 'c1')).toBeNull();
    expect(clear).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    vi.resetAllMocks();
    rows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
    tokens.mockReturnValue({ totalInputTokens: 5000, totalOutputTokens: 0, lastCompactInputTokens: 0, lastCompactOutputTokens: 0 });
    distill.mockResolvedValue(success);
    alert.mockReturnValue(true);
    clear.mockReturnValue(true);
    db = new Database(':memory:');
    db.open();
    ensureHandoffArtifactSchema(db);
    coordinator = new HandoffDistillCoordinator({ db, instanceName: 'test', isEnabled: () => true, getModel: () => 'deepseek-chat' });
    coordinator.start();
  });

  afterEach(() => {
    coordinator.shutdown();
    db.close();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('clears the incident after a failed conversation successfully persists its next artifact', async () => {
    await failOnce();
    clear.mockImplementation(() => {
      expect(getHandoffArtifact(db, 'c1')?.summary).toBe(success.summary);
      return true;
    });
    await sweep();
    expect(distill).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalledExactlyOnceWith('test', 'handoff-distill:test');
    await sweep();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('waits for every degraded conversation to recover', async () => {
    rows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }, { conversationKey: 'c2', rowId: 2 }]);
    const failures = new Set(['c1', 'c2']);
    distill.mockImplementation(async (key: string) => {
      if (failures.has(key)) throw new Error('provider unavailable');
      return success;
    });
    await sweep();
    expect(alert).toHaveBeenCalledTimes(2);
    failures.delete('c1');
    await sweep();
    expect(getHandoffArtifact(db, 'c1')?.summary).toBe(success.summary);
    expect(getHandoffArtifact(db, 'c2')).toBeNull();
    expect(clear).not.toHaveBeenCalled();
    failures.delete('c2');
    await sweep();
    expect(getHandoffArtifact(db, 'c2')?.summary).toBe(success.summary);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('does not interpret low token growth as recovery', async () => {
    await failOnce();
    tokens.mockReturnValue(null);
    await sweep();
    expect(distill).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
  });

  it('does not interpret a breaker-denied tick as recovery', async () => {
    distill.mockRejectedValue(new Error('provider unavailable'));
    await sweep();
    await sweep();
    await sweep();
    expect(distill).toHaveBeenCalledTimes(3);
    distill.mockResolvedValue(success);
    await sweep();
    expect(distill).toHaveBeenCalledTimes(3);
    expect(clear).not.toHaveBeenCalled();
  });

  it('requires successful persistence before reporting recovery', async () => {
    await failOnce();
    db.raw.exec("CREATE TRIGGER reject_handoff BEFORE INSERT ON agent_handoff_artifacts BEGIN SELECT RAISE(FAIL, 'storage unavailable'); END");
    await sweep();
    expect(distill).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(getHandoffArtifact(db, 'c1')).toBeNull();
    expect(clear).not.toHaveBeenCalled();
    db.raw.exec('DROP TRIGGER reject_handoff');
    await sweep();
    expect(getHandoffArtifact(db, 'c1')?.summary).toBe(success.summary);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('retains unresolved degradation when enumeration fails or the conversation disappears', async () => {
    await failOnce();
    rows.mockImplementationOnce(() => { throw new Error('enumeration unavailable'); });
    await sweep();
    rows.mockReturnValue([]);
    await sweep();
    expect(distill).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    rows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
    await sweep();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it.each(['refused', 'threw'])('retries a recovery notification that %s', async (failure) => {
    await failOnce();
    if (failure === 'refused') clear.mockReturnValueOnce(false);
    else clear.mockImplementationOnce(() => { throw new Error('outbox unavailable'); });
    await sweep();
    expect(getHandoffArtifact(db, 'c1')?.summary).toBe(success.summary);
    expect(clear).toHaveBeenCalledTimes(1);
    tokens.mockReturnValue(null);
    await sweep();
    expect(distill).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalledTimes(2);
    await sweep();
    expect(clear).toHaveBeenCalledTimes(2);
  });
});
