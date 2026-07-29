import { describe, expect, it } from 'vitest';
import { confineAlertContent } from '../../src/lib/alert-evidence.ts';
import { buildBotErrorsEvent } from '../../src/lib/bot-errors-outbox.ts';

// ─────────────────────────────────────────────────────────────────────────
// Issue #2386: BOT ERRORS evidence metadata-only emission boundary.
//
// These tests prove that buildBotErrorsEvent() and confineAlertContent()
// never carry arbitrary prose, raw errors, identifiers, or paths across
// the alert boundary. Only bounded metadata (failure class, length,
// correlation digest) survives.
// ─────────────────────────────────────────────────────────────────────────

describe('confineAlertContent (issue #2386)', () => {
  it('returns bounded metadata, not raw content', () => {
    const raw = 'SECRET_INTERNAL_PATH=/var/lib/app/secret.config TypeError: Cannot read properties of null';
    const confined = confineAlertContent('evidence', raw);
    expect(confined.failureClass).toBe('TypeError');
    expect(confined.length).toBe(raw.length);
    expect(confined.correlationDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not include the raw string in any field', () => {
    const marker = 'CANARY_PATTERN_OPAQUE_SENTENCE_xyz789';
    const confined = confineAlertContent('evidence', marker);
    const serialized = JSON.stringify(confined);
    expect(serialized).not.toContain('CANARY');
    expect(serialized).not.toContain('OPAQUE');
    expect(serialized).not.toContain('xyz789');
  });

  it('is deterministic: same input produces same digest', () => {
    const a = confineAlertContent('evidence', 'test content');
    const b = confineAlertContent('evidence', 'test content');
    expect(a.correlationDigest).toBe(b.correlationDigest);
  });

  it('is domain-separated: same value in evidence vs summary differs', () => {
    const ev = confineAlertContent('evidence', 'shared text');
    const su = confineAlertContent('summary', 'shared text');
    expect(ev.correlationDigest).not.toBe(su.correlationDigest);
  });

  it('returns empty sentinel for undefined/empty input', () => {
    expect(confineAlertContent('evidence', undefined).failureClass).toBe('none');
    expect(confineAlertContent('evidence', '').failureClass).toBe('none');
    expect(confineAlertContent('evidence', '   ').failureClass).toBe('none');
  });

  it('extracts well-known failure classes without leaking raw text', () => {
    expect(confineAlertContent('evidence', 'TypeError: bad').failureClass).toBe('TypeError');
    expect(confineAlertContent('evidence', 'RangeError: bad').failureClass).toBe('RangeError');
    expect(confineAlertContent('evidence', 'provider_unknown_terminal slice').failureClass).toBe('provider_unknown');
    expect(confineAlertContent('evidence', 'runtime_verify_failed rc=1').failureClass).toBe('runtime_verify_failed');
  });

  it('returns unknown for unrecognized content', () => {
    expect(confineAlertContent('evidence', 'some random text').failureClass).toBe('unknown');
  });

  it('produces different digests for different content', () => {
    const a = confineAlertContent('evidence', 'content A');
    const b = confineAlertContent('evidence', 'content B');
    expect(a.correlationDigest).not.toBe(b.correlationDigest);
  });
});

describe('buildBotErrorsEvent evidence boundary (issue #2386)', () => {
  const marker = 'CANARY_OPAQUE_PROSE_do_not_leak_across_boundary_xyz999';
  const secretPath = '/var/lib/bot-errors/instances/1234567890/auth/credentials.json';
  const conversationId = '1203630abcdef123456789@g.us';

  it('does not carry raw evidence prose in any event field', () => {
    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'test-instance',
      source: 'test-source',
      summary: `Failure: ${marker}`,
      evidence: `Evidence: ${marker} path=${secretPath} conv=${conversationId}`,
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain(secretPath);
    expect(serialized).not.toContain(conversationId);
  });

  it('emits bounded evidence and summary objects, not raw strings', () => {
    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'test',
      source: 'src',
      summary: 'TypeError: something broke',
      evidence: 'stderr: TypeError at line 42',
    });
    expect(typeof event.summary).toBe('object');
    expect(typeof event.evidence).toBe('object');
    expect(event.summary).toHaveProperty('failureClass');
    expect(event.summary).toHaveProperty('length');
    expect(event.summary).toHaveProperty('correlationDigest');
    expect(event.evidence).toHaveProperty('failureClass');
    expect(event.evidence).toHaveProperty('length');
    expect(event.evidence).toHaveProperty('correlationDigest');
  });

  it('uses schemaVersion 2 for the confined event shape', () => {
    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'test',
      source: 'src',
      summary: 'test',
      evidence: 'test',
    });
    expect(event.schemaVersion).toBe(2);
  });

  it('strips hostname, platform, cwd, execPath, argv, envKeys, and logHints', () => {
    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'test',
      source: 'src',
      summary: 'test',
      evidence: 'test',
    });
    expect(event).not.toHaveProperty('machine');
    expect(event).not.toHaveProperty('platform');
    expect(event.process).not.toHaveProperty('cwd');
    expect(event.process).not.toHaveProperty('execPath');
    expect(event.process).not.toHaveProperty('argv');
    expect(event.process).toHaveProperty('argvCount');
    expect(event.runtime).not.toHaveProperty('envKeys');
    expect(event.diagnostics).not.toHaveProperty('logHints');
  });

  it('write-failure breadcrumb also carries confined (not raw) evidence', () => {
    // The breadcrumb reuses the event object via redactOutboxValue. Since
    // the event now has bounded objects, the breadcrumb inherits them.
    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'test',
      source: 'src',
      summary: marker,
      evidence: marker,
    });
    // Simulate what recordBotErrorsWritefail does with the event.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(marker);
  });

  it('conversation-shaped digit strings cannot bypass the boundary', () => {
    const plainDigits = '120363012345678901234567';
    const event = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'test',
      source: 'src',
      summary: `Conv: ${plainDigits}`,
      evidence: `Evidence conv=${plainDigits}`,
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(plainDigits);
  });

  it('different evidence content produces different correlation digests', () => {
    const event1 = buildBotErrorsEvent({
      eventType: 'alert', instance: 't', source: 's',
      summary: 'first', evidence: 'evidence A',
    });
    const event2 = buildBotErrorsEvent({
      eventType: 'alert', instance: 't', source: 's',
      summary: 'second', evidence: 'evidence B',
    });
    expect(event1.evidence.correlationDigest).not.toBe(event2.evidence.correlationDigest);
    expect(event1.summary.correlationDigest).not.toBe(event2.summary.correlationDigest);
  });
});
