import { describe, it, expect } from 'vitest';
import {
  evaluateOutboundMessageSafety,
  redactInternalArtifacts,
} from '../../src/core/outbound-message-safety.ts';
import { sanitizeProviderPreviewText } from '../../src/lib/provider-preview-sanitizer.ts';
import { markdownToWhatsApp } from '../../src/runtimes/agent/whatsapp-format.ts';

// Live defect 2026-09-11 (mini27 `loops`, two client DMs): the keyed-secret pass
// treated prose "password: <word>" as a key/value pair, masked the word, and the
// WhatsApp formatter's bracket strip turned "[REDACTED]" into a bare "REDACTED":
//   "…asking for a password:* it wants…"  → "…password:REDACTED it wants…"
//   "…screen password: Sam gives you…"    → "…password: REDACTED gives you…"
// Chat egress now uses the 'credential-shaped' policy; background previews keep
// the unconditional default. Secret-shaped fixtures are assembled at runtime
// (repo-hygiene guard: no literal credential in committed source).
const PROSE_MARKDOWN = '- *If it was RustDesk asking for a password:* it wants a separate screen password that Sam will send you, not your Facebook one.';
const PROSE_NAME = 'About the screen password: Sam gives you that himself, not through me, so please ask him.';
const PROSE_SENTENCE_END = 'Type your password: then press Enter.';
const CONFIG_DIGIT = `password: ${'hunter'}${'2'}`;
const CONFIG_LONG_WORD = `password: ${'correcthorse'}${'batterystaple'}`;
const CONFIG_QUOTED = `password: "${'Sam'}"`;
const CONFIG_SYMBOL = `token=${'abc'}${'/'}${'def'}`;
const CONFIG_MIXED_CASE = `password: ${'exam'}${'plePassVal'}`;

describe('chat egress: prose that mentions a secret key is not rewritten', () => {
  for (const audience of ['client', 'internal'] as const) {
    it(`Markdown "*…password:* it wants…" flows to ${audience} unchanged with zero redactions`, () => {
      const { text, redactions } = redactInternalArtifacts(PROSE_MARKDOWN, audience);
      expect(text).toBe(PROSE_MARKDOWN);
      expect(redactions).toEqual([]);
    });

    it(`"screen password: <name> gives you…" flows to ${audience} unchanged with zero redactions`, () => {
      const { text, redactions } = redactInternalArtifacts(PROSE_NAME, audience);
      expect(text).toBe(PROSE_NAME);
      expect(redactions).toEqual([]);
    });

    it(`"password: then press Enter" flows to ${audience} unchanged`, () => {
      expect(redactInternalArtifacts(PROSE_SENTENCE_END, audience).text).toBe(PROSE_SENTENCE_END);
    });

    it(`evaluateOutboundMessageSafety(${audience}) allows the prose and never emits REDACTED after WhatsApp formatting`, () => {
      for (const prose of [PROSE_MARKDOWN, PROSE_NAME]) {
        const decision = evaluateOutboundMessageSafety({ text: prose, audience });
        expect(decision.action).toBe('allow');
        expect(markdownToWhatsApp(decision.text)).not.toContain('REDACTED');
      }
    });
  }
});

describe('chat egress: credential-shaped values after a secret key still mask', () => {
  const cases: Array<[string, string]> = [
    ['digit-bearing value', CONFIG_DIGIT],
    ['12+ character letter run', CONFIG_LONG_WORD],
    ['quoted value (config shape)', CONFIG_QUOTED],
    ['symbol-bearing value', CONFIG_SYMBOL],
    ['inner-capitalised value', CONFIG_MIXED_CASE],
  ];
  for (const audience of ['client', 'internal'] as const) {
    for (const [name, input] of cases) {
      it(`${name} masks at ${audience} with a provider_secret redaction`, () => {
        const { text, redactions } = redactInternalArtifacts(input, audience);
        expect(text).toContain('[REDACTED]');
        expect(text).not.toContain(input.split(/[:=]\s*/)[1]!.replace(/"/g, ''));
        expect(redactions.map((r) => r.category)).toContain('provider_secret');
      });
    }
  }
});

describe('background provider path keeps the unconditional keyed-secret policy', () => {
  it('the default sanitizer still masks a short word after "password:" (SSOT parity, no chat relaxation leaks upstream)', () => {
    expect(sanitizeProviderPreviewText(PROSE_NAME)).toContain('[REDACTED]');
    expect(sanitizeProviderPreviewText(PROSE_NAME)).not.toContain('Sam gives');
  });

  it("explicit keyedSecretValues: 'always' matches the default", () => {
    expect(sanitizeProviderPreviewText(PROSE_NAME, { keyedSecretValues: 'always' }))
      .toBe(sanitizeProviderPreviewText(PROSE_NAME));
  });

  it("keyedSecretValues: 'credential-shaped' leaves the prose alone and still masks a credential", () => {
    expect(sanitizeProviderPreviewText(PROSE_NAME, { keyedSecretValues: 'credential-shaped' })).toBe(PROSE_NAME);
    expect(sanitizeProviderPreviewText(CONFIG_DIGIT, { keyedSecretValues: 'credential-shaped' })).toBe('password: [REDACTED]');
  });
});
