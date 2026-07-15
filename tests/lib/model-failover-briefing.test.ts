import { describe, expect, it } from 'vitest';

import {
  buildFailoverClearedNotice,
  buildFailoverUserNotice,
  buildModelFailoverBriefing,
  type FailoverReason,
} from '../../src/lib/model-failover-briefing.ts';

describe('buildModelFailoverBriefing', () => {
  const baseInput = {
    previousModel: 'gpt-primary',
    newModel: 'gpt-backup',
    reason: 'rate_limit' as FailoverReason,
    summary: 'User asked about the weather. Partial response was started.',
  };

  it('returns a message in the user role', () => {
    const msg = buildModelFailoverBriefing(baseInput);
    expect(msg.role).toBe('user');
  });

  it('includes a timestamp', () => {
    const msg = buildModelFailoverBriefing(baseInput);
    expect(typeof msg.timestamp).toBe('number');
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  it('mentions both model names', () => {
    const msg = buildModelFailoverBriefing(baseInput);
    expect(msg.content).toContain('gpt-primary');
    expect(msg.content).toContain('gpt-backup');
  });

  it('starts with [SYSTEM HANDOFF]', () => {
    const msg = buildModelFailoverBriefing(baseInput);
    expect(msg.content.startsWith('[SYSTEM HANDOFF]')).toBe(true);
  });

  it('includes the state summary', () => {
    const msg = buildModelFailoverBriefing(baseInput);
    expect(msg.content).toContain('CURRENT STATE SUMMARY:');
    expect(msg.content).toContain('User asked about the weather');
  });

  it('includes the reason framing', () => {
    const msg = buildModelFailoverBriefing(baseInput);
    expect(msg.content).toContain('rate limit');
  });

  it('includes pending work when provided', () => {
    const msg = buildModelFailoverBriefing({
      ...baseInput,
      pendingWork: ['Finish weather report', 'Suggest clothing'],
    });
    expect(msg.content).toContain('PENDING WORK:');
    expect(msg.content).toContain('- Finish weather report');
    expect(msg.content).toContain('- Suggest clothing');
  });

  it('omits pending work section when not provided', () => {
    const msg = buildModelFailoverBriefing(baseInput);
    expect(msg.content).not.toContain('PENDING WORK:');
  });

  it('omits pending work section when empty array', () => {
    const msg = buildModelFailoverBriefing({ ...baseInput, pendingWork: [] });
    expect(msg.content).not.toContain('PENDING WORK:');
  });

  it('omits blank pending work items', () => {
    const msg = buildModelFailoverBriefing({
      ...baseInput,
      pendingWork: ['real task', '   ', ''],
    });
    expect(msg.content).toContain('- real task');
    // Only one pending item line should appear.
    const pendingLines = msg.content.split('\n').filter((l) => l.startsWith('- '));
    expect(pendingLines).toHaveLength(1);
  });

  it('trims pending work items', () => {
    const msg = buildModelFailoverBriefing({
      ...baseInput,
      pendingWork: ['  spaced task  '],
    });
    expect(msg.content).toContain('- spaced task');
  });

  it('includes the three instructions', () => {
    const msg = buildModelFailoverBriefing(baseInput);
    expect(msg.content).toContain('INSTRUCTIONS:');
    expect(msg.content).toContain('1. Review the state summary above.');
    expect(msg.content).toContain('Do not repeat work');
  });

  it('handles empty summary gracefully', () => {
    const msg = buildModelFailoverBriefing({ ...baseInput, summary: '' });
    expect(msg.content).toContain('(no summary provided)');
  });

  it('handles whitespace-only summary', () => {
    const msg = buildModelFailoverBriefing({ ...baseInput, summary: '   \n  ' });
    expect(msg.content).toContain('(no summary provided)');
  });

  it('uses unknown framing for unknown reason', () => {
    const msg = buildModelFailoverBriefing({
      ...baseInput,
      reason: 'unknown',
    });
    expect(msg.content).toContain('became unavailable');
  });
});

describe('buildModelFailoverBriefing — reason framing', () => {
  const reasons: FailoverReason[] = [
    'rate_limit',
    'overloaded',
    'timeout',
    'auth_error',
    'permanent_error',
    'unknown',
  ];

  for (const reason of reasons) {
    it(`includes framing for ${reason}`, () => {
      const msg = buildModelFailoverBriefing({
        previousModel: 'a',
        newModel: 'b',
        reason,
        summary: 's',
      });
      expect(msg.content).toContain('[SYSTEM HANDOFF]');
      // Each reason produces a distinct framing phrase.
      expect(msg.content.length).toBeGreaterThan(50);
    });
  }

  it('rate_limit framing mentions rate limit', () => {
    expect(buildModelFailoverBriefing({
      previousModel: 'a', newModel: 'b', reason: 'rate_limit', summary: 's',
    }).content).toContain('rate limit');
  });

  it('overloaded framing mentions overloaded', () => {
    expect(buildModelFailoverBriefing({
      previousModel: 'a', newModel: 'b', reason: 'overloaded', summary: 's',
    }).content).toContain('overloaded');
  });

  it('auth_error framing mentions authentication', () => {
    expect(buildModelFailoverBriefing({
      previousModel: 'a', newModel: 'b', reason: 'auth_error', summary: 's',
    }).content).toContain('authentication error');
  });
});

describe('buildFailoverUserNotice', () => {
  it('includes both model names and the fallback arrow', () => {
    const notice = buildFailoverUserNotice({
      previousModel: 'primary',
      newModel: 'backup',
      reason: 'rate_limit',
      summary: 's',
    });
    expect(notice).toContain('↪️');
    expect(notice).toContain('backup');
    expect(notice).toContain('primary');
  });

  it('exposes detail for transient reasons', () => {
    for (const reason of ['rate_limit', 'overloaded', 'timeout'] as FailoverReason[]) {
      const notice = buildFailoverUserNotice({
        previousModel: 'p',
        newModel: 'b',
        reason,
        summary: 's',
      });
      expect(notice).toContain('(');
      expect(notice).toContain(')');
    }
  });

  it('summarizes permanent reasons without leaking provider text', () => {
    for (const reason of ['auth_error', 'permanent_error', 'unknown'] as FailoverReason[]) {
      const notice = buildFailoverUserNotice({
        previousModel: 'p',
        newModel: 'b',
        reason,
        summary: 's',
      });
      expect(notice).toContain('(service issue)');
    }
  });
});

describe('buildFailoverClearedNotice', () => {
  it('includes both model names and the cleared arrow', () => {
    const notice = buildFailoverClearedNotice({
      primaryModel: 'primary',
      wasFallback: 'backup',
    });
    expect(notice).toContain('↪️');
    expect(notice).toContain('cleared');
    expect(notice).toContain('primary');
    expect(notice).toContain('backup');
  });

  it('states the fallback is cleared and the primary is restored', () => {
    const notice = buildFailoverClearedNotice({
      primaryModel: 'gpt-4',
      wasFallback: 'gpt-3.5',
    });
    expect(notice).toContain('Model fallback cleared');
    expect(notice).toContain('was gpt-3.5');
  });
});
