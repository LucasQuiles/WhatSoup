import { describe, expect, it } from 'vitest';

import {
  autoSwitchNoticeMessage,
  providerServerErrorNoFallbackNotice,
  providerUnknownTerminalNotice,
  renderUserMessage,
  type RenderContext,
} from '../../../src/runtimes/agent/response-templates.ts';
import type { DiagnosticBundle, UserTemplateId } from '../../../src/runtimes/agent/response-registry.ts';

const ALL_TEMPLATES: UserTemplateId[] = [
  'usage-limit', 'rate-limit', 'auth-required', 'model-unavailable',
  'context-overflow', 'transient', 'no-fallback', 'credentials-missing', 'exhausted',
  'tool-activity-blocked', 'none',
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

  it('omits both continuation clauses when suppressContinuation is set', () => {
    const msg = renderUserMessage('usage-limit', ctx({ suppressContinuation: true }));
    expect(msg).not.toContain('resend');
    expect(msg).not.toContain('continue here');
    // The message still carries the reason and backup, and ends right after the
    // backup/digest clause (no dangling continuation).
    expect(msg).toContain('usage/quota limit');
    expect(msg).toContain('Switching to OpenCode / minimax.');
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

describe('renderUserMessage — tool-activity-blocked variant', () => {
  it('the blockedByToolActivity flag replaces the continue/resend clause with the blocked directive', () => {
    const msg = renderUserMessage('usage-limit', ctx({ blockedByToolActivity: true }));
    expect(msg).toContain('usage/quota limit'); // reason still rendered
    expect(msg).toContain('Switching to OpenCode / minimax.'); // backup still rendered
    expect(msg).toContain(
      'The first attempt already started an action, so I will not replay it automatically. '
      + 'Please confirm or resend the next step.',
    );
    // It must NOT also carry a continue/resend clause (avoids a double-directive).
    expect(msg).not.toContain("I'll continue here.");
    expect(msg).not.toContain('Please resend your last message.');
  });

  it('blockedByToolActivity takes precedence over hasContinuation and suppressContinuation', () => {
    const cont = renderUserMessage('rate-limit', ctx({ blockedByToolActivity: true, hasContinuation: true }));
    const resend = renderUserMessage('rate-limit', ctx({ blockedByToolActivity: true, hasContinuation: false }));
    const suppressed = renderUserMessage('rate-limit', ctx({ blockedByToolActivity: true, suppressContinuation: true }));
    const directive = 'so I will not replay it automatically';
    expect(cont).toContain(directive);
    expect(resend).toContain(directive);
    expect(suppressed).toContain(directive);
  });

  it('the standalone tool-activity-blocked id renders the directive with reason-context clauses', () => {
    const msg = renderUserMessage('tool-activity-blocked', ctx());
    expect(msg).toContain('Switching to OpenCode / minimax.');
    expect(msg).toContain('(diagnostics: 1 ok, 1 flagged)');
    expect(msg).toContain(
      'The first attempt already started an action, so I will not replay it automatically. '
      + 'Please confirm or resend the next step.',
    );
    // No leading whitespace even though the backup clause starts with a space.
    expect(msg).toBe(msg.trimStart());
  });

  it('preserves byte-for-byte the previously inline-composed blocked message', () => {
    // The old call site rendered the reason template with suppressContinuation
    // then appended the directive after a trimEnd + single space. Reproduce that
    // exactly and assert the new flag path yields the identical string.
    const base = renderUserMessage('usage-limit', ctx({ suppressContinuation: true }));
    const expected = `${base.trimEnd()} The first attempt already started an action, `
      + 'so I will not replay it automatically. Please confirm or resend the next step.';
    expect(renderUserMessage('usage-limit', ctx({ blockedByToolActivity: true }))).toBe(expected);
  });
});

describe('providerServerErrorNoFallbackNotice', () => {
  // Gap 3: on the no-fallback path, a server-error terminal result previously
  // fell to the generic providerUnknownTerminalNotice ("operator has been
  // notified"), but NO ops alert fires on that path — so that claim is unbacked
  // and the "terminal fault" framing is wrong for a transient backend error.
  // This class-appropriate notice names the transient cause and asks the user to
  // resend, WITHOUT claiming an operator was notified.
  it('names a transient backend error and asks the user to resend', () => {
    const msg = providerServerErrorNoFallbackNotice();
    expect(msg.toLowerCase()).toContain('temporary error');
    expect(msg.toLowerCase()).toContain('resend');
  });

  it('does not claim an operator was notified/alerted (no alert fires on this path)', () => {
    const msg = providerServerErrorNoFallbackNotice();
    expect(msg).not.toMatch(/operator has been (notified|alerted)/i);
  });

  it('is byte-stable and deterministic', () => {
    expect(providerServerErrorNoFallbackNotice()).toBe(providerServerErrorNoFallbackNotice());
  });
});

describe('standalone notices — redaction safety', () => {
  // The notice layer is content-free by contract: it consumes the failure CLASS,
  // never raw provider text, and must never leak a phone number or JID.
  const PII = /@s\.whatsapp\.net|@lid|\+?\d{7,}/;
  it('no standalone notice embeds a phone/JID pattern', () => {
    for (const msg of [
      providerServerErrorNoFallbackNotice(),
      providerUnknownTerminalNotice(),
    ]) {
      expect(msg).not.toMatch(PII);
    }
  });
});

describe('autoSwitchNoticeMessage', () => {
  it('renders the high-demand source and target models deterministically', () => {
    expect(autoSwitchNoticeMessage({
      from: 'Opus 4.8',
      to: 'Opus 4.7',
      reason: 'high-demand',
    })).toBe('_Model auto-switched from Opus 4.8 to Opus 4.7 (high demand). Continuing normally._');
  });

  it('renders no-source auto-routed notices deterministically', () => {
    expect(autoSwitchNoticeMessage({
      from: null,
      to: 'Sonnet 4.6',
      reason: 'auto-routed',
    })).toBe('_Model auto-switched to Sonnet 4.6 (auto routed). Continuing normally._');
  });
});
