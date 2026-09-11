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
// Chat egress uses bounded prose exceptions; background previews keep
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

    it(`evaluateOutboundMessageSafety(${audience}) preserves the incident sentences after WhatsApp formatting`, () => {
      for (const prose of [PROSE_MARKDOWN, PROSE_NAME]) {
        const decision = evaluateOutboundMessageSafety({ text: prose, audience });
        expect(decision.action).toBe('allow');
        expect(markdownToWhatsApp(decision.text)).toBe(prose);
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
  const strictCases: Array<[string, string]> = [
    [PROSE_NAME, 'About the screen password: [REDACTED] gives you that himself, not through me, so please ask him.'],
    [PROSE_MARKDOWN, '- *If it was RustDesk asking for a password:[REDACTED] it wants a separate screen password that Sam will send you, not your Facebook one.'],
    [PROSE_SENTENCE_END, 'Type your password: [REDACTED] press Enter.'],
    ['password: unfortunately you need to ask the owner.', 'password: [REDACTED] you need to ask the owner.'],
    ['password: Alexandra will send you the instructions.', 'password: [REDACTED] will send you the instructions.'],
  ];
  for (const [input, expected] of strictCases) {
    it(`preserves strict background output for ${input}`, () => {
      expect(sanitizeProviderPreviewText(input)).toBe(expected);
      expect(sanitizeProviderPreviewText(input, { keyedSecretValues: 'always' })).toBe(expected);
    });
  }

  it("keyedSecretValues: 'prose-aware' leaves the prose alone and still masks a credential", () => {
    expect(sanitizeProviderPreviewText(PROSE_NAME, { keyedSecretValues: 'prose-aware' })).toBe(PROSE_NAME);
    expect(sanitizeProviderPreviewText(CONFIG_DIGIT, { keyedSecretValues: 'prose-aware' })).toBe('password: [REDACTED]');
  });
});

describe('chat prose exemptions keep ambiguous assignments protected', () => {
  for (const audience of ['client', 'internal'] as const) {
    const proseCases: Array<[string, string]> = [
      ['password: Lucas gives you that himself.', 'password: Lucas gives you that himself.'],
      ['password: Alexandra will send you the instructions.', 'password: Alexandra will send you the instructions.'],
      ['password: unfortunately you need to ask the owner.', 'password: unfortunately you need to ask the owner.'],
      ['password: you need to ask the owner.', 'password: you need to ask the owner.'],
      ['**password:** it wants a separate screen password.', '*password:* it wants a separate screen password.'],
      ['Type your password: then press Enter.', 'Type your password: then press Enter.'],
    ];
    for (const [input, formatted] of proseCases) {
      it(`preserves the complete sentence and formatting for ${audience}: ${input}`, () => {
        const result = evaluateOutboundMessageSafety({ text: input, audience });
        expect(result.action).toBe('allow');
        expect(result.text).toBe(input);
        expect(markdownToWhatsApp(result.text)).toBe(formatted);
      });
    }

    const assignments: Array<[string, string]> = [
      ['password: 1234', 'password: [REDACTED]'],
      ['password: apple', 'password: [REDACTED]'],
      ['password: abc123', 'password: [REDACTED]'],
      ['password: Sam', 'password: [REDACTED]'],
      ['password: it', 'password: [REDACTED]'],
      ['password=Sam gives you the instructions.', 'password=[REDACTED] gives you the instructions.'],
      ['"password": Sam gives you the instructions.', '"password": [REDACTED] gives you the instructions.'],
      ['password: "it wants"', 'password: "[REDACTED]"'],
      ['`password: Sam gives you the instructions.`', '`password: [REDACTED] gives you the instructions.`'],
      ['```text\npassword: Sam gives you the instructions.\n```', '```text\npassword: [REDACTED] gives you the instructions.\n```'],
      ['```yaml\nnote: contains ``` literally\npassword: Sam gives you the instructions.\n```', '```yaml\nnote: contains ``` literally\npassword: [REDACTED] gives you the instructions.\n```'],
      ['```yaml\n```not-a-closing-fence\npassword: Sam gives you the instructions.\n```', '```yaml\n```not-a-closing-fence\npassword: [REDACTED] gives you the instructions.\n```'],
      ['The literal \\` marker.\n```yaml\nnote: `\npassword: Sam gives you the instructions.\n```', 'The literal \\` marker.\n```yaml\nnote: `\npassword: [REDACTED] gives you the instructions.\n```'],
      ['An unmatched ` marker.\n```yaml\nnote: `\npassword: Sam gives you the instructions.\n```', 'An unmatched ` marker.\n```yaml\nnote: `\npassword: [REDACTED] gives you the instructions.\n```'],
      ['~~~text\npassword: it wants a value.\n~~~', '~~~text\npassword: [REDACTED] wants a value.\n~~~'],
      ['    password: Sam gives you the instructions.', '    password: [REDACTED] gives you the instructions.'],
      [' \tpassword: Sam gives you the instructions.', ' \tpassword: [REDACTED] gives you the instructions.'],
      ['credentials:\n  password: Sam gives you the instructions.', 'credentials:\n  password: [REDACTED] gives you the instructions.'],
      ['[credentials]\npassword: Sam gives you the instructions.', '[credentials]\npassword: [REDACTED] gives you the instructions.'],
      ['---\npassword: Sam gives you the instructions.\n...', '---\npassword: [REDACTED] gives you the instructions.\n...'],
      ['{\npassword: Sam gives you the instructions.\n}', '{\npassword: [REDACTED] gives you the instructions.\n}'],
      ['{\nvalue: "}",\npassword: Sam gives you the instructions.\n}', '{\nvalue: "}",\npassword: [REDACTED] gives you the instructions.\n}'],
      ['**password:** 1234', '**password:** [REDACTED]'],
      ['password: it wantsSomething', 'password: [REDACTED] wantsSomething'],
      ['password: Sam\ngives you the instructions.', 'password: [REDACTED]\ngives you the instructions.'],
    ];
    for (const [input, expected] of assignments) {
      it(`redacts an assignment for ${audience}: ${input}`, () => {
        const result = redactInternalArtifacts(input, audience);
        expect(result.text).toBe(expected);
        expect(result.redactions).toEqual([{ category: 'provider_secret', label: 'token-or-credential' }]);
      });
    }

    it(`still redacts a later assignment after exempt prose for ${audience}`, () => {
      const result = evaluateOutboundMessageSafety({ text: 'password: Sam gives you the instructions; token: 1234', audience });
      expect(result.action).toBe('redact');
      expect(result.text).toBe('password: Sam gives you the instructions; token: [REDACTED]');
      expect(markdownToWhatsApp(result.text)).toBe('password: Sam gives you the instructions; token: REDACTED');
    });

    it(`requires a real sentence boundary after a long name for ${audience}`, () => {
      const name = 'A' + 'a'.repeat(245);
      expect(redactInternalArtifacts(`password: ${name} gives youUnexpected`, audience).text)
        .toBe('password: [REDACTED] gives youUnexpected');
    });

    it(`limits strict configuration context to its block for ${audience}`, () => {
      const input = '{\npassword: Sam gives you the instructions.\n}\nAbout the password: Sam gives you the instructions.';
      expect(redactInternalArtifacts(input, audience).text).toBe(
        '{\npassword: [REDACTED] gives you the instructions.\n}\nAbout the password: Sam gives you the instructions.',
      );
    });

    it(`does not extend an incomplete config example beyond its code fence for ${audience}`, () => {
      const input = '```js\n{ password: Sam gives you the instructions.\n```\nAbout the password: Sam gives you the instructions.';
      expect(redactInternalArtifacts(input, audience).text).toBe(
        '```js\n{ password: [REDACTED] gives you the instructions.\n```\nAbout the password: Sam gives you the instructions.',
      );
    });
  }
});
