import { describe, expect, it } from 'vitest';
import { formatAlert } from '../../src/transport/format.ts';

/**
 * Spec: docs/specs/2026-05-08-whatsoup-protection-layer-design.md
 *   §6.5 "propose_fix - Same as alert, with a copy-pasteable fix command in the alert body."
 *   §7.4 "action taken (`observe` / `alert` / `propose_fix:<command>` / `meta_alert`)"
 *
 * Two rendering paths exist for propose_fix:
 *   1. `propose_fix` with a deterministic shell command -> `propose_fix: <command>` line.
 *   2. `propose_fix` without a shell command (no payload fields, non-shell remediation)
 *      -> `remediation_hint: <text>` line referencing a documented runbook path.
 *
 * Both must NEVER leave the alert with a bare `action: propose_fix` line and no follow-up.
 */
describe('formatAlert propose_fix rendering', () => {
  const base = {
    eventId: 1,
    severity: 'high' as const,
    scopeId: 'scope-a',
    probeId: 'probe.x',
    domain: 'credential' as const,
    ts: '2026-05-08T14:32:11.000Z',
    diff: { added: {}, removed: {}, changed: {} },
    fingerprint: 'f'.repeat(64),
  };

  it('emits propose_fix: <command> when fixCommand is present', () => {
    const text = formatAlert({
      ...base,
      actionLabel: 'propose_fix',
      fixCommand: "chmod 0600 '/etc/wsoup/alert-sink.env'",
    });

    const proposeLine = text.split('\n').find((line) => line.startsWith('propose_fix:'));
    expect(proposeLine).toBeDefined();
    expect(proposeLine!).toBe(
      "propose_fix: chmod 0600 '/etc/wsoup/alert-sink.env'",
    );
    // Action line stays as the canonical label so log parsers stay simple.
    expect(text).toContain('action:  propose_fix');
  });

  it('emits remediation_hint: <text> when remediationHint is present', () => {
    const text = formatAlert({
      ...base,
      actionLabel: 'propose_fix',
      remediationHint:
        'see docs/specs/2026-05-08-whatsoup-protection-layer-design.md §4.2 for credential rotation',
    });

    const hintLine = text.split('\n').find((line) => line.startsWith('remediation_hint:'));
    expect(hintLine).toBeDefined();
    expect(hintLine!).toBe(
      'remediation_hint: see docs/specs/2026-05-08-whatsoup-protection-layer-design.md §4.2 for credential rotation',
    );
    expect(text).toContain('action:  propose_fix');
    expect(text).not.toMatch(/^propose_fix:/m);
  });

  it('prefers fixCommand over remediationHint when both are present', () => {
    const text = formatAlert({
      ...base,
      actionLabel: 'propose_fix',
      fixCommand: 'chmod 0600 /tmp/x',
      remediationHint: 'fallback hint',
    });

    expect(text).toMatch(/^propose_fix: chmod 0600 \/tmp\/x$/m);
    expect(text).not.toMatch(/^remediation_hint:/m);
  });

  it('does not emit propose_fix/remediation_hint lines for non-propose_fix actions', () => {
    const text = formatAlert({
      ...base,
      actionLabel: 'alert',
      fixCommand: 'chmod 0600 /tmp/x',
      remediationHint: 'should be ignored',
    });

    expect(text).not.toMatch(/^propose_fix:/m);
    expect(text).not.toMatch(/^remediation_hint:/m);
    expect(text).toContain('action:  alert');
  });

  it('preserves backward-compatible rendering when neither hint is present', () => {
    // Older callers that hand-roll a `propose_fix:<sub-label>` string still work.
    const text = formatAlert({
      ...base,
      actionLabel: 'propose_fix:review-policy',
    });

    expect(text).toContain('action:  propose_fix:review-policy');
    expect(text).not.toMatch(/^propose_fix:/m);
    expect(text).not.toMatch(/^remediation_hint:/m);
  });
});
