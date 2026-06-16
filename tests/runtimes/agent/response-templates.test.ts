import { describe, expect, it } from 'vitest';

import { renderUserMessage, type RenderContext } from '../../../src/runtimes/agent/response-templates.ts';
import type { DiagnosticBundle, UserTemplateId } from '../../../src/runtimes/agent/response-registry.ts';

const ALL_TEMPLATES: UserTemplateId[] = [
  'usage-limit', 'rate-limit', 'auth-required', 'model-unavailable',
  'context-overflow', 'transient', 'no-fallback', 'credentials-missing', 'exhausted', 'none',
];

const fixedClock = (epochMs: number): string => `T${epochMs}`;

function bundle(over: Partial<DiagnosticBundle> = {}): DiagnosticBundle {
  return {
    errorClass: 'provider_usage_limit',
    providerKind: 'usage-limit',
    findings: [
      { id: 'health-snapshot', ok: true, confidence: 'confirmed', summary: 'healthy' },
      { id: 'account-auth-status', ok: false, confidence: 'confirmed', summary: 'auth required' },
    ],
    resetAt: 1_781_000_003_600,
    collectedAt: 1_781_000_000_000,
    ...over,
  };
}

function ctx(over: Partial<RenderContext> = {}): RenderContext {
  return {
    hasContinuation: true,
    backupCard: 'OpenCode / minimax',
    activeUntil: 1_781_000_009_999,
    bundle: bundle(),
    formatClock: fixedClock,
    ...over,
  };
}

describe('renderUserMessage — determinism & exhaustiveness', () => {
  it('renders every template id to a string without throwing', () => {
    for (const id of ALL_TEMPLATES) {
      expect(typeof renderUserMessage(id, ctx())).toBe('string');
    }
  });

  it('is byte-stable for identical inputs', () => {
    for (const id of ALL_TEMPLATES) {
      expect(renderUserMessage(id, ctx())).toBe(renderUserMessage(id, ctx()));
    }
  });

  it('none renders the empty string', () => {
    expect(renderUserMessage('none', ctx())).toBe('');
  });
});

describe('renderUserMessage — content', () => {
  it('usage-limit carries reason, ETA, backup, digest, and continuation', () => {
    const msg = renderUserMessage('usage-limit', ctx());
    expect(msg).toContain('usage/quota limit');
    expect(msg).toContain('T1781000003600'); // reset ETA via injected clock
    expect(msg).toContain('OpenCode / minimax');
    expect(msg).toContain('(diagnostics: 1 ok, 1 flagged)');
    expect(msg).toContain("I'll continue here.");
  });

  it('falls back to activeUntil for the ETA when no parsed reset exists', () => {
    const msg = renderUserMessage('usage-limit', ctx({ bundle: bundle({ resetAt: null }) }));
    expect(msg).toContain('T1781000009999');
  });

  it('omits the backup clause and ETA when none are available', () => {
    const msg = renderUserMessage('rate-limit', ctx({ backupCard: null, activeUntil: null, bundle: bundle({ resetAt: null }) }));
    expect(msg).not.toContain('Switching to');
    expect(msg).not.toContain('until about');
  });

  it('switches the continuation clause when the user must resend', () => {
    const msg = renderUserMessage('model-unavailable', ctx({ hasContinuation: false }));
    expect(msg).toContain('Please resend your last message.');
    expect(msg).not.toContain("I'll continue here.");
  });

  it('digest reads all-ok when nothing is flagged, and is omitted with no findings', () => {
    const allOk = bundle({ findings: [{ id: 'health-snapshot', ok: true, confidence: 'confirmed', summary: 'ok' }] });
    expect(renderUserMessage('usage-limit', ctx({ bundle: allOk }))).toContain('(diagnostics: 1 ok)');
    const none = bundle({ findings: [] });
    expect(renderUserMessage('usage-limit', ctx({ bundle: none }))).not.toContain('diagnostics:');
  });

  it('context-overflow matches the existing fresh-session notice', () => {
    expect(renderUserMessage('context-overflow', ctx())).toBe(
      '_Context limit reached — starting fresh session. Send your message again._',
    );
  });

  it('exhausted and credentials-missing report an operator was notified', () => {
    expect(renderUserMessage('exhausted', ctx())).toContain('operator has been notified');
    expect(renderUserMessage('credentials-missing', ctx())).toContain('operator has been notified');
  });
});
