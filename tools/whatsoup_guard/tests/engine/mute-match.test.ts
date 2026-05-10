import { describe, expect, it } from 'vitest';
import { matchMute } from '../../src/engine/mute-match.ts';
import type { Mute } from '../../src/types.ts';

const NOW = '2026-05-08T12:00:00Z';

const baseMute: Mute = {
  id: 1,
  host: 'h1',
  domain: 'exposure',
  expires_at: '2099-01-01T00:00:00Z',
  reason: 'maintenance',
  allow_revert_suppression: false,
  created_by: 'operator',
};

describe('matchMute', () => {
  it('matches exact host and exact domain', () => {
    const result = matchMute({ host: 'h1', domain: 'exposure', isRemediation: false, now: NOW }, [baseMute]);

    expect(result).toEqual({ matched: true, byMute: baseMute, reason: 'mute matched' });
  });

  it('does not match a different host', () => {
    const result = matchMute({ host: 'h2', domain: 'exposure', isRemediation: false, now: NOW }, [baseMute]);

    expect(result).toEqual({ matched: false });
  });

  it('does not match a different domain', () => {
    const result = matchMute({ host: 'h1', domain: 'credential', isRemediation: false, now: NOW }, [baseMute]);

    expect(result).toEqual({ matched: false });
  });

  it('never matches alerting domain even when a candidate exists', () => {
    const mute: Mute = { ...baseMute, domain: 'alerting' };
    const result = matchMute({ host: 'h1', domain: 'alerting', isRemediation: false, now: NOW }, [mute]);

    expect(result).toEqual({ matched: false, reason: 'domain is forbidden from being muted' });
  });

  it('always forbids alerting regardless of policy additions', () => {
    const mute: Mute = { ...baseMute, domain: 'alerting' };
    const result = matchMute(
      { host: 'h1', domain: 'alerting', isRemediation: false, now: NOW },
      [mute],
      { additionalForbiddenDomains: [] },
    );

    expect(result).toEqual({ matched: false, reason: 'domain is forbidden from being muted' });
  });

  it('also forbids policy-declared additional domains', () => {
    const mute: Mute = { ...baseMute, domain: 'change' };
    const result = matchMute(
      { host: 'h1', domain: 'change', isRemediation: false, now: NOW },
      [mute],
      { additionalForbiddenDomains: ['change'] },
    );

    expect(result).toEqual({ matched: false, reason: 'domain is forbidden from being muted' });
  });

  it('matches wildcard domain for alerts but not remediation by default', () => {
    const mute: Mute = { ...baseMute, domain: '*' };

    expect(matchMute({ host: 'h1', domain: 'exposure', isRemediation: false, now: NOW }, [mute])).toEqual({
      matched: true,
      byMute: mute,
      reason: 'mute matched',
    });
    expect(matchMute({ host: 'h1', domain: 'exposure', isRemediation: true, now: NOW }, [mute])).toEqual({
      matched: false,
      reason: 'wildcard mute does not suppress remediation',
    });
  });

  it('matches wildcard domain for remediation only when explicitly allowed', () => {
    const mute: Mute = { ...baseMute, domain: '*', allow_revert_suppression: true };
    const result = matchMute({ host: 'h1', domain: 'exposure', isRemediation: true, now: NOW }, [mute]);

    expect(result).toEqual({ matched: true, byMute: mute, reason: 'mute matched' });
  });

  it('matches wildcard host', () => {
    const mute: Mute = { ...baseMute, host: '*' };
    const result = matchMute({ host: 'somewhere', domain: 'exposure', isRemediation: false, now: NOW }, [mute]);

    expect(result).toEqual({ matched: true, byMute: mute, reason: 'mute matched' });
  });

  it('does not match expired mutes', () => {
    const mute: Mute = { ...baseMute, expires_at: '2026-05-08T11:59:59Z' };
    const result = matchMute({ host: 'h1', domain: 'exposure', isRemediation: false, now: NOW }, [mute]);

    expect(result).toEqual({ matched: false, reason: 'candidate mute expired' });
  });

  it('prefers exact mutes over wildcard mutes regardless of input order', () => {
    const wildcard: Mute = { ...baseMute, id: 10, host: '*', domain: '*' };
    const exact: Mute = { ...baseMute, id: 2 };
    const result = matchMute({ host: 'h1', domain: 'exposure', isRemediation: false, now: NOW }, [wildcard, exact]);

    expect(result).toEqual({ matched: true, byMute: exact, reason: 'mute matched' });
  });

  it('uses the lower mute id as deterministic tie-breaker', () => {
    const later: Mute = { ...baseMute, id: 20 };
    const earlier: Mute = { ...baseMute, id: 2 };
    const result = matchMute({ host: 'h1', domain: 'exposure', isRemediation: false, now: NOW }, [later, earlier]);

    expect(result).toEqual({ matched: true, byMute: earlier, reason: 'mute matched' });
  });
});
