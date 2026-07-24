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

async function readFailureTaxonomySource(): Promise<string> {
  return readFile(new URL('../../../src/runtimes/agent/failure-taxonomy.ts', import.meta.url), 'utf8');
}

/** chat-transport.ts holds the per-chat actor-socket lifecycle extracted out of runtime.ts (pure move, see createChatTransportHost). */
async function readChatTransportSource(): Promise<string> {
  return readFile(new URL('../../../src/runtimes/agent/chat-transport.ts', import.meta.url), 'utf8');
}

function methodSource(source: string, methodName: string): string {
  const match = source.match(
    new RegExp(`\\n  (?:private )?(?:async )?${methodName}\\([\\s\\S]*?\\n  \\}`),
  );
  expect(match).toBeTruthy();
  return match?.[0] ?? '';
}

/** Like methodSource, for a top-level `export function` (0-indent) rather than a 2-space-indented class method. */
function functionSource(source: string, functionName: string): string {
  const match = source.match(
    new RegExp(`\\nexport function ${functionName}\\([\\s\\S]*?\\n\\}`),
  );
  expect(match).toBeTruthy();
  return match?.[0] ?? '';
}

describe('AgentRuntime structural policy', () => {
  it('LEAK-02 wires cleanup into crash/deletion sites without dropping replay text', async () => {
    const source = await readRuntimeSource();
    const generationCleanup = methodSource(source, 'cleanupPerChatGenerationState');
    const terminalCleanup = methodSource(source, 'cleanupPerChatState');
    const resetOwnedSession = methodSource(source, 'resetOwnedPerChatSession');
    const idleEviction = methodSource(source, 'evictIdleSession');
    const failedWorkspaceCreation = methodSource(source, 'cleanupFailedSandboxWorkspace');
    const exhaustedSession = methodSource(source, 'terminalizeExhaustedPerChatSession');
    const lidRetirement = methodSource(source, 'handleJidAliasChanged');
    const crashBody = methodSource(source, 'cleanupPerChatCrashTurnState');

    expect(terminalCleanup).toContain('this.cleanupPerChatGenerationState(mapKey, options);');
    expect(terminalCleanup).toContain('this.teardownPerChatActorSocket(mapKey);');
    expect(resetOwnedSession).toContain('this.cleanupPerChatGenerationState(mapKey);');
    expect(resetOwnedSession).not.toContain('this.cleanupPerChatState(mapKey);');
    expect(resetOwnedSession).not.toContain('this.teardownPerChatActorSocket(mapKey);');
    expect(idleEviction).toContain('this.cleanupPerChatState(mapKey);');
    expect(failedWorkspaceCreation).toContain('this.cleanupPerChatState(workspaceKey);');
    expect(exhaustedSession).toContain(
      'this.cleanupPerChatState(releaseKey, { preserveCrashHistory: true });',
    );
    expect(lidRetirement).toContain(
      'this.cleanupPerChatState(lidKey, { preserveProviderTurnOwnership: true });',
    );

    expect(generationCleanup).toContain('this.pendingTurnText.delete(mapKey);');
    expect(crashBody).toContain('this.perChatTurnContentType.delete(mapKey);');
    expect(crashBody).toContain('this.perChatTurnText.delete(mapKey);');
    expect(crashBody).toContain('this.perChatAssistantItemText.delete(mapKey);');
    expect(crashBody).not.toContain('this.pendingTurnText.delete(mapKey);');
  });

  it('cleanupPerChatState covers all auxiliary per-chat maps', async () => {
    const source = await readRuntimeSource();
    const terminalCleanup = methodSource(source, 'cleanupPerChatState');
    const generationCleanup = methodSource(source, 'cleanupPerChatGenerationState');
    const expectedGenerationCleanup = [
      'this.crashes.forget(mapKey);',
      'this.perChatInboundSeqQueue.delete(mapKey);',
      'this.pendingSystemResults.clearScope(mapKey);',
      'this.perChatTurnSourceMessageId.delete(mapKey);',
      'this.perChatTurnContentType.delete(mapKey);',
      'this.perChatTurnText.delete(mapKey);',
      'this.perChatAssistantItemText.delete(mapKey);',
      'this.perChatTurnSuppressedReplySatisfaction.delete(mapKey);',
      'this.perChatRouteMarkerHold.delete(mapKey);',
      'this.pendingTurnText.delete(mapKey);',
      'this.pendingTurnActorJid.delete(mapKey);',
      'this.perChatExecActorQueue.delete(mapKey);',
      'this.resumeFailedHandling.delete(mapKey);',
      'this.postTurnGate.delete(mapKey);',
      'this.autoCompact.cleanupScope(mapKey);',
      'this.deletePendingPollQuestions(mapKey);',
      "this.abortImageCoalesceBuffer(mapKey, 'cleanup_aborted');",
      'tracker.shutdown();',
      'this.operationTrackers.delete(mapKey);',
    ];

    for (const expectedCleanup of expectedGenerationCleanup) {
      expect(generationCleanup).toContain(expectedCleanup);
    }

    expect(terminalCleanup).toContain('this.cleanupPerChatGenerationState(mapKey, options);');
    expect(terminalCleanup).toContain('this.teardownPerChatActorSocket(mapKey);');
    expect(terminalCleanup).toContain('this.lastSpawnRouteProvider.delete(conversationKey);');
    expect(terminalCleanup).toContain('this.lastPinBlockNotice.delete(conversationKey);');

    const helperBody = methodSource(source, 'deletePendingPollQuestions');
    expect(helperBody).toContain('clearPendingPollTimers(pending);');
    expect(helperBody).toContain('this.pendingPolls.questions.delete(mapKey);');

    // teardownPerChatActorSocket's implementation lives in chat-transport.ts (pure
    // move); runtime.ts keeps only a thin delegating wrapper, so this reads the
    // extracted module and its port-parameterized form of the same invariant.
    const teardownBody = functionSource(await readChatTransportSource(), 'teardownPerChatActorSocket');
    expect(teardownBody).toContain('port.perChatExecActorQueue.delete(mapKey);');
    expect(teardownBody).toContain('port.perChatSocketResources.delete(mapKey);');
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

  it('R14: single terminal durability completion for locally-handled commands, no pre-switch resurrection', async () => {
    const source = await readRuntimeSource();
    // #1659 R14 unified every locally-handled command (routing aliases + base
    // commands) onto ONE post-switch completeInbound call instead of a
    // per-command opt-in. A second call site would double-write the terminal
    // completion; a reintroduced pre-switch markInboundSkipped reason string
    // starting with 'local_command' would resurrect the stuck-processing gap
    // R14 closed.
    const completionMatches = source.match(/completeInbound\(msg\.inboundSeq, 'local_command_handled'\)/g) ?? [];
    const preSwitchResurrection = source.match(/markInboundSkipped\(msg\.inboundSeq, 'local_command[^']*'\)/g) ?? [];

    expect(completionMatches).toHaveLength(1);
    expect(preSwitchResurrection).toHaveLength(0);
  });

  it('QR-209: suppressStreamedProviderFailure keeps exactly two twin-handler call sites', async () => {
    const source = await readRuntimeSource();
    // QR-209 twin-handler contract: the shared-queue path and the non-shared
    // path each independently need the same silent-reply-defect suppression,
    // mirroring the register probe. If a handler is added or removed this
    // count must be consciously updated.
    const callSites = source.match(/this\.suppressStreamedProviderFailure\([^)]*\)/g) ?? [];

    expect(callSites).toHaveLength(2);
  });
});

describe('failure-taxonomy structural policy', () => {
  it('QR-209b: bareUsageLimitEvidence stays single-defined with its mirror-coupling caveat intact', async () => {
    const source = await readFailureTaxonomySource();
    // bareUsageLimitEvidence deliberately duplicates rather than reuses
    // hasTerminalLimitAssembler's and isProviderCreditBalanceLimitMessage's
    // matched substrings, round-2, so their already-verified infra-channel
    // behavior stays untouched. A future edit to either detector's
    // substrings must also update this mirror — pin both the single
    // definition and the caveat comment that carries the warning.
    const definitions = source.match(/function bareUsageLimitEvidence\([^)]*\)/g) ?? [];
    const mirrorCaveat = source.match(
      /CAUTION: because this duplicates rather than reuses[\s\S]*?update the mirrored candidate here/,
    );

    expect(definitions).toHaveLength(1);
    expect(mirrorCaveat).toBeTruthy();
  });
});
