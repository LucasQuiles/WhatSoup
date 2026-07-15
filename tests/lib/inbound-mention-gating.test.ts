import { describe, expect, it } from 'vitest';

import { resolveInboundMentionDecision } from '../../src/lib/inbound-mention-gating.ts';

const groupPolicy = {
  isGroup: true,
  requireMention: true,
  allowTextCommands: true,
  hasControlCommand: false,
  commandAuthorized: false,
};

describe('resolveInboundMentionDecision — explicit mention', () => {
  it('responds when explicitly mentioned in a require-mention group', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: true },
      policy: groupPolicy,
    });
    expect(d.effectiveWasMentioned).toBe(true);
    expect(d.shouldSkip).toBe(false);
  });

  it('skips when not mentioned in a require-mention group', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false },
      policy: groupPolicy,
    });
    expect(d.effectiveWasMentioned).toBe(false);
    expect(d.shouldSkip).toBe(true);
  });

  it('does not skip when mention detection is unavailable', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: false, wasMentioned: false },
      policy: groupPolicy,
    });
    // canDetectMention false → shouldSkip false (fail-open: can't prove no mention)
    expect(d.shouldSkip).toBe(false);
  });
});

describe('resolveInboundMentionDecision — no require-mention', () => {
  it('responds when mention is not required', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false },
      policy: { ...groupPolicy, requireMention: false },
    });
    expect(d.shouldSkip).toBe(false);
  });
});

describe('resolveInboundMentionDecision — implicit mention', () => {
  it('counts an allowed implicit mention as effective', () => {
    const d = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ['reply_to_bot'],
      },
      policy: {
        ...groupPolicy,
        allowedImplicitMentionKinds: ['reply_to_bot'],
      },
    });
    expect(d.implicitMention).toBe(true);
    expect(d.effectiveWasMentioned).toBe(true);
    expect(d.shouldSkip).toBe(false);
    expect(d.matchedImplicitMentionKinds).toEqual(['reply_to_bot']);
  });

  it('ignores an implicit mention kind not in the allowed set', () => {
    const d = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ['bot_thread_participant'],
      },
      policy: {
        ...groupPolicy,
        allowedImplicitMentionKinds: ['reply_to_bot', 'quoted_bot'],
      },
    });
    expect(d.implicitMention).toBe(false);
    expect(d.effectiveWasMentioned).toBe(false);
    expect(d.shouldSkip).toBe(true);
    expect(d.matchedImplicitMentionKinds).toEqual([]);
  });

  it('matches multiple allowed implicit kinds', () => {
    const d = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ['reply_to_bot', 'quoted_bot', 'native'],
      },
      policy: {
        ...groupPolicy,
        allowedImplicitMentionKinds: ['reply_to_bot', 'quoted_bot', 'bot_thread_participant'],
      },
    });
    expect(d.matchedImplicitMentionKinds).toEqual(['reply_to_bot', 'quoted_bot']);
    expect(d.implicitMention).toBe(true);
  });

  it('ignores implicit mentions when no allowed set provided', () => {
    const d = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ['reply_to_bot'],
      },
      policy: groupPolicy,
    });
    expect(d.implicitMention).toBe(false);
    expect(d.shouldSkip).toBe(true);
  });
});

describe('resolveInboundMentionDecision — text-command bypass', () => {
  const bypassPolicy = {
    isGroup: true,
    requireMention: true,
    allowTextCommands: true,
    hasControlCommand: true,
    commandAuthorized: true,
  };

  it('bypasses mention requirement for authorized text command', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false, hasAnyMention: false },
      policy: bypassPolicy,
    });
    expect(d.shouldBypassMention).toBe(true);
    expect(d.effectiveWasMentioned).toBe(true);
    expect(d.shouldSkip).toBe(false);
  });

  it('does not bypass when command is not authorized', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false, hasAnyMention: false },
      policy: { ...bypassPolicy, commandAuthorized: false },
    });
    expect(d.shouldBypassMention).toBe(false);
    expect(d.shouldSkip).toBe(true);
  });

  it('does not bypass when text commands are disallowed', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false, hasAnyMention: false },
      policy: { ...bypassPolicy, allowTextCommands: false },
    });
    expect(d.shouldBypassMention).toBe(false);
  });

  it('does not bypass in a DM (isGroup false)', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false, hasAnyMention: false },
      policy: { ...bypassPolicy, isGroup: false },
    });
    expect(d.shouldBypassMention).toBe(false);
  });

  it('does not bypass when mention is not required', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false, hasAnyMention: false },
      policy: { ...bypassPolicy, requireMention: false },
    });
    expect(d.shouldBypassMention).toBe(false);
  });

  it('does not bypass when any mention is present (hasAnyMention true)', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false, hasAnyMention: true },
      policy: bypassPolicy,
    });
    expect(d.shouldBypassMention).toBe(false);
  });

  it('does not bypass when already explicitly mentioned', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: true, hasAnyMention: false },
      policy: bypassPolicy,
    });
    expect(d.shouldBypassMention).toBe(false);
    expect(d.effectiveWasMentioned).toBe(true);
  });

  it('does not bypass when no control command present', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false, hasAnyMention: false },
      policy: { ...bypassPolicy, hasControlCommand: false },
    });
    expect(d.shouldBypassMention).toBe(false);
  });
});

describe('resolveInboundMentionDecision — combined', () => {
  it('explicit mention wins even if bypass would also apply', () => {
    const d = resolveInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: true, hasAnyMention: false },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: true,
        commandAuthorized: true,
      },
    });
    expect(d.effectiveWasMentioned).toBe(true);
    expect(d.shouldBypassMention).toBe(false); // bypass only when NOT mentioned
    expect(d.shouldSkip).toBe(false);
  });

  it('implicit + bypass both contribute to effective', () => {
    const d = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: false,
        implicitMentionKinds: ['reply_to_bot'],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: true,
        commandAuthorized: true,
        allowedImplicitMentionKinds: ['reply_to_bot'],
      },
    });
    expect(d.implicitMention).toBe(true);
    expect(d.shouldBypassMention).toBe(true);
    expect(d.effectiveWasMentioned).toBe(true);
  });
});
