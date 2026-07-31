import { describe, expect, it } from 'vitest';
import {
  CONTROL_PREFIXES,
  EmitHealResultSchema,
  extractPayload,
  extractProtocol,
  HealCompletePayloadSchema,
  isControlPrefix,
  LoopsHealPayloadSchema,
  normalizeErrorClass,
} from '../../src/core/heal-protocol.ts';

describe('heal protocol contracts', () => {
  it('recognizes the three control prefixes and rejects non-control content', () => {
    expect(CONTROL_PREFIXES).toEqual(['[LOOPS_HEAL]', '[HEAL_COMPLETE]', '[HEAL_ESCALATE]']);
    expect(isControlPrefix('[LOOPS_HEAL] {"reportId":"r1"}')).toBe(true);
    expect(isControlPrefix('[HEAL_COMPLETE] {"reportId":"r1"}')).toBe(true);
    expect(isControlPrefix('[HEAL_ESCALATE] {"reportId":"r1"}')).toBe(true);
    expect(isControlPrefix('plain chat message')).toBe(false);
  });

  it('extracts the control protocol from prefixed content', () => {
    expect(extractProtocol('[LOOPS_HEAL] {"reportId":"r1"}')).toBe('LOOPS_HEAL');
    expect(extractProtocol('[HEAL_COMPLETE] {"reportId":"r1"}')).toBe('HEAL_COMPLETE');
    expect(extractProtocol('[HEAL_ESCALATE] {"reportId":"r1"}')).toBe('HEAL_ESCALATE');
    expect(extractProtocol('not a control message')).toBeNull();
  });

  it('parses payload JSON after the prefix and returns null for malformed content', () => {
    expect(extractPayload('[LOOPS_HEAL] {"reportId":"r1","type":"crash"}')).toEqual({
      reportId: 'r1',
      type: 'crash',
    });
    expect(extractPayload('[LOOPS_HEAL] {"reportId":}')).toBeNull();
    expect(extractPayload('[LOOPS_HEAL] {"reportId":"r1"')).toBeNull();
    expect(extractPayload('[LOOPS_HEAL] no json here')).toBeNull();
  });

  it('normalizes equivalent error hints to the same error class', () => {
    const first = normalizeErrorClass(
      'service_crash',
      'TypeError: boom at runtime.ts:534 pid=247943 2026-03-31T19:17:46Z 0xdeadbeef',
    );
    const second = normalizeErrorClass(
      'service_crash',
      'TypeError: boom at runtime.ts:999 pid=999999 2026-03-31T19:18:10Z 0xbeadfeed',
    );

    expect(first).toBe('service_crash__TypeError_boom_at_runtime_ts');
    expect(second).toBe(first);
  });

  it('produces different error classes for materially different errors', () => {
    const crash = normalizeErrorClass('crash', 'TypeError: boom at runtime.ts:534');
    const degraded = normalizeErrorClass('degraded', 'Hook PreToolUse:Bash denied this tool');

    expect(crash).not.toBe(degraded);
  });

  it('falls back to unknown when an error hint normalizes to no stable tokens', () => {
    expect(normalizeErrorClass('crash', ':534 pid=247943 2026-03-31T19:17:46Z 0xdeadbeef'))
      .toBe('crash__unknown');
  });

  it('uses only the first normalized line and caps long error classes', () => {
    const longFirstLine = `Error ${'x'.repeat(200)}`;
    const result = normalizeErrorClass('degraded', `${longFirstLine}\nsecond line should not appear`);

    expect(result).toMatch(/^degraded__Error_x+/);
    expect(result).not.toContain('second');
    expect(result.length).toBe('degraded__'.length + 100);
  });

  it('accepts valid LOOPS_HEAL payloads and rejects missing required fields', () => {
    const valid = LoopsHealPayloadSchema.safeParse({
      reportId: 'r1',
      type: 'crash',
      errorClass: 'crash__provider_auth_required',
      attempt: 1,
      maxAttempts: 2,
      timestamp: '2026-03-31T19:17:46Z',
      evidence: {
        schemaVersion: 1,
        type: 'crash',
        source: 'automatic_crash_reporter',
        cause: 'provider_auth_required',
        stage: 'provider_session',
        impact: 'single_session',
        evidenceCoverage: 'crash_classified',
        counts: { occurrences: 1 },
        action: 'reauthenticate_provider',
        correlation: 'heal:v1:crash:provider_auth_required',
      },
    });

    expect(valid.success).toBe(true);
    expect(
      LoopsHealPayloadSchema.safeParse({
        reportId: 'r1',
      }).success,
    ).toBe(false);
  });

  it('binds the outer LOOPS_HEAL type and class to its V1 evidence', () => {
    const evidence = {
      schemaVersion: 1,
      type: 'crash',
      source: 'automatic_crash_reporter',
      cause: 'provider_auth_required',
      stage: 'provider_session',
      impact: 'single_session',
      evidenceCoverage: 'crash_classified',
      counts: { occurrences: 1 },
      action: 'reauthenticate_provider',
      correlation: 'heal:v1:crash:provider_auth_required',
    };
    const payload = {
      reportId: 'r1',
      type: 'crash',
      errorClass: 'crash__provider_auth_required',
      attempt: 1,
      maxAttempts: 2,
      timestamp: '2026-03-31T19:17:46Z',
      evidence,
    };

    expect(LoopsHealPayloadSchema.safeParse({ ...payload, type: 'degraded' }).success).toBe(false);
    expect(LoopsHealPayloadSchema.safeParse({ ...payload, errorClass: 'crash__provider_unknown' }).success).toBe(false);
  });

  it('accepts valid completion payloads and emit payloads and rejects missing fields', () => {
    const complete = HealCompletePayloadSchema.safeParse({
      reportId: 'r1',
      errorClass: 'service_crash__TypeError_boom',
      result: 'fixed',
      commitSha: 'abc123',
      diagnosis: 'Patched the null guard and restarted Loops.',
    });
    const emit = EmitHealResultSchema.safeParse({
      reportId: 'r1',
      errorClass: 'service_crash__TypeError_boom',
      result: 'escalate',
      diagnosis: 'Tests failed in the worktree; escalating.',
    });

    expect(complete.success).toBe(true);
    expect(emit.success).toBe(true);
    expect(
      HealCompletePayloadSchema.safeParse({
        reportId: 'r1',
        result: 'fixed',
      }).success,
    ).toBe(false);
    expect(
      EmitHealResultSchema.safeParse({
        reportId: 'r1',
        errorClass: 'service_crash__TypeError_boom',
      }).success,
    ).toBe(false);
  });
});
