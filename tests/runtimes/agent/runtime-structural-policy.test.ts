/**
 * Runtime structural policy checks.
 *
 * These assertions intentionally read production source to pin cleanup and
 * timer lifecycle invariants that are difficult to observe without duplicating
 * private runtime state transitions in every behavior test.
 *
 * test-integrity: source-string-ok
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

async function readRuntimeSource(): Promise<string> {
  return readFile(new URL('../../../src/runtimes/agent/runtime.ts', import.meta.url), 'utf8');
}

describe('AgentRuntime structural policy', () => {
  it('LEAK-02 wires cleanup into crash/deletion sites without dropping replay text', async () => {
    const source = await readRuntimeSource();
    const mapKeyCleanupMatches = source.match(/this\.cleanupPerChatState\(mapKey\);/g) ?? [];
    const workspaceCleanupMatches = source.match(/this\.cleanupPerChatState\(workspaceKey\);/g) ?? [];
    const crashMatch = source.match(/private cleanupPerChatCrashTurnState\(mapKey: string\): void \{([\s\S]*?)\n  \}/);

    expect(mapKeyCleanupMatches.length).toBeGreaterThanOrEqual(2);
    expect(workspaceCleanupMatches).toHaveLength(2);
    expect(source).toContain('this.cleanupPerChatState(lidKey);');
    expect(crashMatch).toBeTruthy();

    const crashBody = crashMatch?.[1] ?? '';
    expect(crashBody).toContain('this.perChatTurnContentType.delete(mapKey);');
    expect(crashBody).toContain('this.perChatTurnText.delete(mapKey);');
    expect(crashBody).toContain('this.perChatAssistantItemText.delete(mapKey);');
    expect(crashBody).not.toContain('this.pendingTurnText.delete(mapKey);');
  });

  it('cleanupPerChatState covers all auxiliary per-chat maps', async () => {
    const source = await readRuntimeSource();
    const match = source.match(/private cleanupPerChatState\(mapKey: string\): void \{([\s\S]*?)\n  \}/);

    expect(match).toBeTruthy();

    const methodBody = match?.[1] ?? '';
    const expectedDeletes = [
      'this.perChatCrashCount.delete(mapKey);',
      'this.perChatInboundSeqQueue.delete(mapKey);',
      'this.perChatPendingSystemResults.delete(mapKey);',
      'this.perChatTurnContentType.delete(mapKey);',
      'this.perChatTurnText.delete(mapKey);',
      'this.perChatAssistantItemText.delete(mapKey);',
      'this.pendingTurnText.delete(mapKey);',
      'this.resumeFailedHandling.delete(mapKey);',
      'this.postTurnGate.delete(mapKey);',
      'this.compactBoundaryScopes.delete(mapKey);',
      'this.autoCompactCooldownUntil.delete(mapKey);',
      'this.operationTrackers.delete(mapKey);',
      'this.deletePendingPollQuestions(mapKey);',
    ];

    for (const expectedDelete of expectedDeletes) {
      expect(methodBody).toContain(expectedDelete);
    }

    expect(methodBody.match(/\.delete\(mapKey\)/g)).toHaveLength(expectedDeletes.length - 1);

    const pendingHelper = source.match(/private deletePendingPollQuestions\(mapKey: string\): void \{([\s\S]*?)\n  \}/);
    expect(pendingHelper).toBeTruthy();
    const helperBody = pendingHelper?.[1] ?? '';
    expect(helperBody).toContain('this.clearPendingPollTimers(pending);');
    expect(helperBody).toContain('this.pendingPollQuestions.delete(mapKey);');
    expect(methodBody).toContain("this.abortImageCoalesceBuffer(mapKey, 'cleanup_aborted');");
  });

  it('shared queue sweep timer is unrefd and cleared structurally', async () => {
    const source = await readRuntimeSource();

    expect(source).toContain('this.queueSweepTimer.unref?.();');
    expect(source).toContain('clearInterval(this.queueSweepTimer);');
  });

  it('sandboxPerChat workspace sweep timer is unrefd and cleared structurally', async () => {
    const source = await readRuntimeSource();

    expect(source).toContain('this.workspaceSweepTimer.unref?.();');
    expect(source).toContain('clearInterval(this.workspaceSweepTimer);');
  });
});
