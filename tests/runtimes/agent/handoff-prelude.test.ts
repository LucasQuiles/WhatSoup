import { describe, expect, it } from 'vitest';

import {
  buildHandoffPrelude,
  type BuildHandoffPreludeArgs,
  type HandoffArtifact,
  type HandoffMessage,
} from '../../../src/runtimes/agent/handoff-prelude.ts';

const NOW = 1_781_000_000_000;
const STALE_MS = 120_000;

function artifact(over: Partial<HandoffArtifact> = {}): HandoffArtifact {
  return {
    conversationKey: 'c1',
    summary: 'User is debugging a fallback bug.',
    seededArtifacts: null,
    updatedAt: NOW - 1_000,
    sourceProvider: 'claude-cli',
    sourceModel: 'claude-opus-4-8',
    tokenBaseline: 1000,
    ...over,
  };
}

function msg(content: string | null, isFromMe = false, senderName: string | null = 'Lucas'): HandoffMessage {
  return { content, isFromMe, senderName };
}

function args(over: Partial<BuildHandoffPreludeArgs> = {}): BuildHandoffPreludeArgs {
  return {
    artifact: artifact(),
    recentMessages: [msg('hi'), msg('reply', true, null), msg('thanks')],
    verbatimN: 10,
    isFirstStandInTurn: true,
    backupContextWindow: 'larger',
    now: NOW,
    staleAfterMs: STALE_MS,
    redact: (t) => t,
    ...over,
  };
}

describe('buildHandoffPrelude — happy path', () => {
  it('fresh artifact + first turn + larger window → both blocks', () => {
    const p = buildHandoffPrelude(args());
    expect(p.systemBlock).toContain('User is debugging');
    expect(p.firstTurnBlock).toContain('[Recent chat context');
    expect(p.firstTurnBlock).toContain('Lucas: hi');
    expect(p.firstTurnBlock).toContain('Assistant: reply');
  });

  it('includes seeded artifacts in the system block when present', () => {
    const p = buildHandoffPrelude(args({ artifact: artifact({ seededArtifacts: 'open PRs: #1, #2' }) }));
    expect(p.systemBlock).toContain('User is debugging');
    expect(p.systemBlock).toContain('open PRs');
  });
});

describe('buildHandoffPrelude — cost-compression', () => {
  it('not the first turn → verbatim suppressed (summary-only thereafter)', () => {
    const p = buildHandoffPrelude(args({ isFirstStandInTurn: false }));
    expect(p.firstTurnBlock).toBeNull();
    expect(p.systemBlock).toContain('User is debugging');
  });

  it('same-or-smaller backup window → verbatim suppressed even on the first turn', () => {
    const p = buildHandoffPrelude(args({ backupContextWindow: 'same_or_smaller' }));
    expect(p.firstTurnBlock).toBeNull();
    expect(p.systemBlock).toContain('User is debugging');
  });

  it('caps the verbatim window to N most-recent messages', () => {
    const recentMessages = Array.from({ length: 20 }, (_, i) => msg(`m${i}`));
    const p = buildHandoffPrelude(args({ recentMessages, verbatimN: 3 }));
    expect(p.firstTurnBlock).toContain('m17');
    expect(p.firstTurnBlock).toContain('m19');
    expect(p.firstTurnBlock).not.toContain('m16');
  });
});

describe('buildHandoffPrelude — staleness & degradation', () => {
  it('stale artifact → system block dropped, verbatim still provided', () => {
    const p = buildHandoffPrelude(args({ artifact: artifact({ updatedAt: NOW - STALE_MS - 1 }) }));
    expect(p.systemBlock).toBeNull();
    expect(p.firstTurnBlock).toContain('Lucas: hi');
  });

  it('missing artifact → degrade to verbatim-only', () => {
    const p = buildHandoffPrelude(args({ artifact: null }));
    expect(p.systemBlock).toBeNull();
    expect(p.firstTurnBlock).toContain('Lucas: hi');
  });

  it('empty artifact (no summary, no seeded) → null system block, verbatim still provided', () => {
    const p = buildHandoffPrelude(args({ artifact: artifact({ summary: '   ', seededArtifacts: null }) }));
    expect(p.systemBlock).toBeNull();
    expect(p.firstTurnBlock).toContain('Lucas: hi');
  });

  it('no usable content anywhere → both null', () => {
    const p = buildHandoffPrelude(args({ artifact: null, recentMessages: [msg('  '), msg(null)] }));
    expect(p).toEqual({ systemBlock: null, firstTurnBlock: null });
  });
});

describe('buildHandoffPrelude — safety & hygiene', () => {
  it('applies redaction to both the summary and every verbatim line', () => {
    const redact = (t: string) => t.replace(/SENSITIVE/g, '[REDACTED]');
    const p = buildHandoffPrelude(args({
      artifact: artifact({ summary: 'token is SENSITIVE' }),
      recentMessages: [msg('my key is SENSITIVE')],
      redact,
    }));
    expect(p.systemBlock).toContain('[REDACTED]');
    expect(p.systemBlock).not.toContain('SENSITIVE');
    expect(p.firstTurnBlock).toContain('[REDACTED]');
    expect(p.firstTurnBlock).not.toContain('SENSITIVE');
  });

  it('skips empty/whitespace messages and drops exact-adjacent duplicates', () => {
    const p = buildHandoffPrelude(args({
      recentMessages: [msg('dup'), msg('dup'), msg('   '), msg('next')],
    }));
    const lines = p.firstTurnBlock!.split('\n');
    // header + 'Lucas: dup' (once) + 'Lucas: next'
    expect(lines.filter((l) => l === 'Lucas: dup')).toHaveLength(1);
    expect(p.firstTurnBlock).toContain('Lucas: next');
  });
});
