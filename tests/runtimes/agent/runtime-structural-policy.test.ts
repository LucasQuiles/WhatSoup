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
    expect(workspaceCleanupMatches.length).toBeGreaterThanOrEqual(3);
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
      'this.crashes.forget(mapKey);',
      'this.perChatInboundSeqQueue.delete(mapKey);',
      'this.pendingSystemResults.counts.delete(mapKey);',
      'this.perChatTurnContentType.delete(mapKey);',
      'this.perChatTurnText.delete(mapKey);',
      'this.perChatAssistantItemText.delete(mapKey);',
      'this.perChatRouteMarkerHold.delete(mapKey);',
      'this.pendingTurnText.delete(mapKey);',
      'this.pendingTurnActorJid.delete(mapKey);',
      // F-STICKY-ACTOR (QR-247 hardening): the exec-queue + per-chat socket clears
      // are delegated to teardownPerChatActorSocket (reused by the non-claude
      // fallback path in wirePerChatActorSocket). The delegation target is verified
      // to clear BOTH maps below, so the leak-guard invariant is preserved.
      'this.teardownPerChatActorSocket(mapKey);',
      'this.resumeFailedHandling.delete(mapKey);',
      'this.postTurnGate.delete(mapKey);',
      'this.lastSpawnRouteProvider.delete(conversationKey);',
      'this.lastPinBlockNotice.delete(conversationKey);',
      'this.autoCompact.cleanupScope(mapKey);',
      'this.operationTrackers.delete(mapKey);',
      'this.deletePendingPollQuestions(mapKey);',
    ];

    for (const expectedDelete of expectedDeletes) {
      expect(methodBody).toContain(expectedDelete);
    }

    // Six listed entries are not raw `.delete(mapKey)` calls: the crash count
    // routes through this.crashes.forget(mapKey) (extracted CrashTracker), the
    // auto-compact bookkeeping (cooldown/last-success/rapid-rearm/measure/boundary
    // + waiter + silent timer) routes through this.autoCompact.cleanupScope(mapKey)
    // (extracted AutoCompactController), the pending-poll cleanup goes through
    // this.deletePendingPollQuestions(mapKey), the exec-queue + per-chat socket
    // clears route through this.teardownPerChatActorSocket(mapKey), and the two
    // slice-4 route maps are keyed by conversationKey (not mapKey), deleting under
    // the reconciled conversationKey derived from mapKey.
    expect(methodBody.match(/\.delete\(mapKey\)/g)).toHaveLength(expectedDeletes.length - 6);

    const pendingHelper = source.match(/private deletePendingPollQuestions\(mapKey: string\): void \{([\s\S]*?)\n  \}/);
    expect(pendingHelper).toBeTruthy();
    const helperBody = pendingHelper?.[1] ?? '';
    expect(helperBody).toContain('clearPendingPollTimers(pending);');
    expect(helperBody).toContain('this.pendingPolls.questions.delete(mapKey);');
    expect(methodBody).toContain("this.abortImageCoalesceBuffer(mapKey, 'cleanup_aborted');");

    // F-STICKY-ACTOR (QR-247 hardening): the delegated teardown MUST clear both the
    // executing-actor queue AND the per-chat socket (stop + map delete), else moving
    // them out of cleanupPerChatState above would silently reopen a leak.
    const teardownHelper = source.match(/private teardownPerChatActorSocket\(mapKey: string\): void \{([\s\S]*?)\n  \}/);
    expect(teardownHelper).toBeTruthy();
    const teardownBody = teardownHelper?.[1] ?? '';
    expect(teardownBody).toContain('this.perChatExecActorQueue.delete(mapKey);');
    expect(teardownBody).toContain('this.perChatSocketResources.delete(mapKey);');
    expect(teardownBody).toContain('sockRes.socketServer.stop();');
  });

  it('QR-247: the global-broadcast gate is INSTANCE-GLOBAL (usesPerChatActorSocket), never presence-based on a per-chat socket', async () => {
    const source = await readRuntimeSource();
    // Security invariant: the shared global socket MUST stay actor-less for claude-cli
    // per_chat so a non-claude fallback subprocess reading it is fail-closed (deny). The
    // skip must be instance-global — a presence gate (perChatSocketResources.has) would
    // broadcast the first-message sender onto the global socket before that chat's
    // per-chat socket exists, reopening the QR-247 confused-deputy race for the fallback
    // path. Pin the gate form AND the single-writer invariant on the global actor.
    expect(source).toContain('if (!this.usesPerChatActorSocket()) {');
    const globalActorWrites = source.match(/globalSocketServer\?\.updateActorJid\(msg\.senderJid\)/g) ?? [];
    expect(globalActorWrites).toHaveLength(1);
  });

  it('shared queue sweep timer is unrefd and cleared structurally', async () => {
    const source = await readRuntimeSource();

    expect(source).toContain('this.queueSweepTimer.unref?.();');
    expect(source).toContain('clearInterval(this.queueSweepTimer);');
  });

  it('QR-049: the @lid->canonical rekey block migrates operationTrackers (no leaked timer / lost stall-state)', async () => {
    const source = await readRuntimeSource();
    // The "All co-keyed maps must be migrated atomically" rekey block moves every
    // per-chat map from the LID key to the canonical JID. operationTrackers holds a
    // setInterval progress timer + slow/stall setTimeouts cleared only by shutdown()
    // keyed on the canonical mapKey, so omitting it leaks the timer and loses the
    // chat's in-flight progress/stall-detection state on canonicalization. Pin the
    // migration so it cannot regress. (`this.operationTrackers.set(canonical` appears
    // ONLY in this rekey path.)
    expect(source).toContain('this.operationTrackers.delete(lidKey);');
    expect(source).toContain('this.operationTrackers.set(canonical,');
  });

  it('sandboxPerChat workspace sweep timer is unrefd and cleared structurally', async () => {
    const source = await readFile(
      new URL('../../../src/runtimes/agent/workspace-sweeper.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('this.timer.unref?.();');
    expect(source).toContain('clearInterval(this.timer);');
  });
});
