// tests/core/outbound-redaction-invariants.test.ts
//
// Shared acceptance set for T8 (over-redaction root-cause fix, F1-F4). Every
// F-sub-task must keep these green; a sub-task that reds an invariant here
// bounces per the packet (W1-PACKET.md § T8, OVER-REDACTION-ROOT-CAUSE.md).
//
// INV-1 (client protection intact — NOT byte-identical): in the `client` tier,
//   real secrets/tokens stay masked AND the operator path/artifact
//   scrub still fires. (Emails are no longer masked on chat egress — B25
//   chat-scope owner ruling; see INV-5 below.) F3 legitimately un-redacts a display-truncated
//   NON-secret even in client tier, so this is framed as "protection intact,"
//   never "output unchanged".
// INV-2 (secrets masked EVERY tier): session=<full-token>, Authorization:
//   Bearer x, api keys → masked in client AND internal AND after F3,
//   including operator DMs (WhatsApp is third-party transport).
// INV-3 (fallback = full scrub): an operator/admin DM while a FALLBACK
//   provider is active gets the full client scrub — the exact leak scenario
//   F2 guards.
// INV-4 (only these relaxed): (a) operator/admin 1:1 DM on the trusted
//   primary → operator vocabulary + ids visible; (b) display-truncated
//   NON-secrets of the narrow E4 shape → visible in all tiers.

import { describe, it, expect } from 'vitest';
import {
  evaluateOutboundMessageSafety,
  redactInternalArtifacts,
  resolveOutboundAudience,
} from '../../src/core/outbound-message-safety.ts';
import { sanitizeProviderPreviewText } from '../../src/lib/provider-preview-sanitizer.ts';
import { E9_BARE_AT_MESSAGE } from '../fixtures/e9-strings.ts';

// Runtime-assembled fixtures — no literal secret/token/JID in committed source
// (repo-hygiene guard), matching the convention in outbound-message-safety.test.ts.
const FULL_SESSION_TOKEN = `session=${'abc123def456ghi789jkl012'}`;
const BEARER_TOKEN = `Authorization: Bearer ${'x'.repeat(24)}`;
const API_KEY = `apikey=sk-${'0123456789abcdef0123456789'}`;
const OPERATOR_HOME_PATH = '/Users/testuser/.claude/settings.json';
const TRUNCATED_DISPLAY_ID = `Session: \`${'4947004d'}...\``; // 8-char base — the E4 shape (F3 carve-out)
const OWNER_LID_JID = `${'16566225701'}@lid`;

const OPERATOR_CTX = { isGroup: false, peerIsAdmin: true, fallbackActive: false } as const;
const FALLBACK_CTX = { isGroup: false, peerIsAdmin: true, fallbackActive: true } as const;

describe('INV-1: client-tier protection intact (not byte-identical)', () => {
  it('a real secret in an otherwise-plain client message stays masked', () => {
    const { text } = redactInternalArtifacts(`the token is ${FULL_SESSION_TOKEN}`, 'client');
    expect(text).not.toContain('abc123def456ghi789jkl012');
  });

  it('the operator path/artifact scrub still fires at client tier', () => {
    const { text, redactions } = redactInternalArtifacts(`see ${OPERATOR_HOME_PATH}`, 'client');
    expect(text).not.toContain(OPERATOR_HOME_PATH);
    expect(redactions.length).toBeGreaterThan(0);
  });

  it('F3 legitimately un-redacts the narrow display-truncated shape even in client tier (not byte-identical, by design)', () => {
    const { text } = redactInternalArtifacts(TRUNCATED_DISPLAY_ID, 'client');
    expect(text).toContain('4947004d');
  });
});

describe('INV-2: secrets masked in every tier, including after F3 and in operator DMs', () => {
  const tiers = ['client', 'internal'] as const;

  for (const tier of tiers) {
    it(`session=<full-token> is masked at ${tier} tier`, () => {
      const { text } = redactInternalArtifacts(`login state ${FULL_SESSION_TOKEN} persisted`, tier);
      expect(text).not.toContain('abc123def456ghi789jkl012');
    });

    it(`Authorization: Bearer <token> is masked at ${tier} tier`, () => {
      const { text } = redactInternalArtifacts(BEARER_TOKEN, tier);
      expect(text).not.toContain('x'.repeat(24));
    });

    it(`a long truncated API-key prefix stays masked at ${tier} tier (F3 does not open this leak)`, () => {
      const { text } = redactInternalArtifacts(API_KEY, tier);
      expect(text).not.toContain(`sk-${'0123456789abcdef0123456789'}`);
      expect(text).toContain('[REDACTED]');
    });
  }

  it('an elevated operator DM (internal via F1) still masks a real secret — WhatsApp is third-party transport', () => {
    const audience = resolveOutboundAudience(OWNER_LID_JID, OPERATOR_CTX);
    expect(audience).toBe('internal');
    const { text } = redactInternalArtifacts(`session token: ${FULL_SESSION_TOKEN}`, audience);
    expect(text).not.toContain('abc123def456ghi789jkl012');
  });
});

describe('INV-3: fallback window forces full client scrub (F2 leak guard)', () => {
  it('operator/admin DM while a fallback provider is active resolves to client, not internal', () => {
    const audience = resolveOutboundAudience(OWNER_LID_JID, FALLBACK_CTX);
    expect(audience).toBe('client');
  });

  it('the full client scrub fires for that operator DM — the exact leak scenario F2 guards', () => {
    const audience = resolveOutboundAudience(OWNER_LID_JID, FALLBACK_CTX);
    const { text } = redactInternalArtifacts(`see ${OPERATOR_HOME_PATH}`, audience);
    expect(text).not.toContain(OPERATOR_HOME_PATH);
  });
});

describe('INV-4: only the two named relaxations are permitted', () => {
  it('(a) operator/admin 1:1 DM on the trusted primary → operator vocabulary + ids visible', () => {
    const audience = resolveOutboundAudience(OWNER_LID_JID, OPERATOR_CTX);
    expect(audience).toBe('internal');
    const { text } = redactInternalArtifacts(`restart via ${OPERATOR_HOME_PATH}`, audience);
    expect(text).toContain(OPERATOR_HOME_PATH);
  });

  it('(b) display-truncated non-secrets of the narrow E4 shape are visible in all tiers', () => {
    for (const tier of ['client', 'internal'] as const) {
      const { text } = redactInternalArtifacts(TRUNCATED_DISPLAY_ID, tier);
      expect(text).toContain('4947004d');
    }
  });

  it('no relaxation applies to a group chat even with an admin sender', () => {
    const audience = resolveOutboundAudience(OWNER_LID_JID, { isGroup: true, peerIsAdmin: true, fallbackActive: false });
    expect(audience).toBe('client');
  });

  it('no relaxation applies to a non-admin peer', () => {
    const audience = resolveOutboundAudience('15559990001@s.whatsapp.net', {
      isGroup: false,
      peerIsAdmin: false,
      fallbackActive: false,
    });
    expect(audience).toBe('client');
  });
});

// INV-5 (B25 chat-scope, owner ruling 2026-07-19): email redaction is a
// BACKGROUND-ONLY function — for text handed to third-party PROVIDERS
// (previews, structured logs, handoff summarizers). It must NEVER mutate
// chat-visible message text. Live evidence behind the ruling: 121 outbound
// chat messages carrying the literal '[REDACTED_EMAIL]' marker since 07-03
// (30 in the owner's own DM). The marker string itself is the tripwire: NO
// chat-egress path may emit it. Chat egress funnels through
// redactInternalArtifacts / evaluateOutboundMessageSafety at client AND
// internal audiences (chat runtime, agent outbound queue, MCP messaging/media
// captions, poll resolution). The provider/background path
// (sanitizeProviderPreviewText DEFAULT, incl. sanitizeOpsEvidence) keeps FULL
// email redaction — asserted in the pairing block below so the scope split
// cannot silently widen in either direction.
const EMAIL_MARKER = '[REDACTED_EMAIL]';
// Runtime-assembled fixtures — no literal email address in committed source
// (repo-hygiene guard), same convention as the fixtures at the top of file.
const CHAT_EMAIL = ['billing', 'example.test'].join('@');
const EMAIL_SENTENCE = `Your invoice was sent to ${CHAT_EMAIL} today.`;
const DANGLING_LOCAL = `${'15551234567'}@`;
const DANGLING_LOCAL_SENTENCE = `reach them at ${DANGLING_LOCAL} soon`;
const QUOTED_LOCAL_SENTENCE = `forward "billing"${'@'}example.test to the team`;
const SECRET_VALUE = 'abc123def456ghi789jkl012';

describe('INV-5 (B25): chat egress NEVER emits the email-redaction marker', () => {
  const CHAT_AUDIENCES = ['client', 'internal'] as const;

  for (const audience of CHAT_AUDIENCES) {
    it(`email-bearing text flows to ${audience} chat as authored`, () => {
      const { text } = redactInternalArtifacts(EMAIL_SENTENCE, audience);
      expect(text).not.toContain(EMAIL_MARKER);
      expect(text).toBe(EMAIL_SENTENCE);
    });

    it(`a bare "@" (the word "at") flows to ${audience} chat as authored`, () => {
      const { text } = redactInternalArtifacts(E9_BARE_AT_MESSAGE, audience);
      expect(text).not.toContain(EMAIL_MARKER);
      expect(text).toBe(E9_BARE_AT_MESSAGE);
    });

    it(`a dangling-local fragment flows to ${audience} chat as authored`, () => {
      const { text } = redactInternalArtifacts(DANGLING_LOCAL_SENTENCE, audience);
      expect(text).not.toContain(EMAIL_MARKER);
      expect(text).toBe(DANGLING_LOCAL_SENTENCE);
    });

    it(`a quoted-local address flows to ${audience} chat as authored`, () => {
      const { text } = redactInternalArtifacts(QUOTED_LOCAL_SENTENCE, audience);
      expect(text).not.toContain(EMAIL_MARKER);
      expect(text).toBe(QUOTED_LOCAL_SENTENCE);
    });

    it(`scope split at ${audience}: the secret still masks while the email survives`, () => {
      const input = `wrote to ${CHAT_EMAIL}; do not share session=${SECRET_VALUE}`;
      const { text } = redactInternalArtifacts(input, audience);
      expect(text).not.toContain(SECRET_VALUE);
      expect(text).toContain(CHAT_EMAIL);
      expect(text).not.toContain(EMAIL_MARKER);
    });

    it(`evaluateOutboundMessageSafety(${audience}) allows email-bearing text unchanged`, () => {
      const decision = evaluateOutboundMessageSafety({ text: EMAIL_SENTENCE, audience });
      expect(decision.text).not.toContain(EMAIL_MARKER);
      expect(decision.action).toBe('allow');
      expect(decision.text).toBe(EMAIL_SENTENCE);
    });
  }
});

describe('INV-5 pairing: provider/background path keeps FULL email redaction', () => {
  it('email-bearing text still redacts on the default provider path', () => {
    const out = sanitizeProviderPreviewText(EMAIL_SENTENCE);
    expect(out).toContain(EMAIL_MARKER);
    expect(out).not.toContain(CHAT_EMAIL);
  });

  it('a dangling-local fragment still redacts on the default provider path', () => {
    const out = sanitizeProviderPreviewText(DANGLING_LOCAL_SENTENCE);
    expect(out).toContain(EMAIL_MARKER);
    expect(out).not.toContain(DANGLING_LOCAL);
  });

  it('a quoted-local address still redacts on the default provider path', () => {
    const out = sanitizeProviderPreviewText(QUOTED_LOCAL_SENTENCE);
    expect(out).toContain(EMAIL_MARKER);
  });

  it('explicit redactEmailLike: true matches the default (background callers unchanged)', () => {
    expect(sanitizeProviderPreviewText(EMAIL_SENTENCE, { redactEmailLike: true }))
      .toBe(sanitizeProviderPreviewText(EMAIL_SENTENCE));
  });

  it('redactEmailLike: false skips ONLY the email class — secrets still mask', () => {
    const input = `Authorization: Bearer ${'x'.repeat(24)} for ${CHAT_EMAIL}`;
    const out = sanitizeProviderPreviewText(input, { redactEmailLike: false });
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('x'.repeat(24));
    expect(out).toContain(CHAT_EMAIL);
    expect(out).not.toContain(EMAIL_MARKER);
  });
});

describe('cross-check: sanitizeProviderPreviewText agrees with redactInternalArtifacts on INV-2/INV-4(b)', () => {
  it('a full token is redacted directly by the sanitizer (SSOT for the secrets pass)', () => {
    expect(sanitizeProviderPreviewText(FULL_SESSION_TOKEN)).toContain('[REDACTED]');
  });

  it('the F3 carve-out shape survives the sanitizer directly', () => {
    expect(sanitizeProviderPreviewText(TRUNCATED_DISPLAY_ID)).toContain('4947004d');
  });
});
