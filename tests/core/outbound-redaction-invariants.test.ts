// tests/core/outbound-redaction-invariants.test.ts
//
// Shared acceptance set for T8 (over-redaction root-cause fix, F1-F4). Every
// F-sub-task must keep these green; a sub-task that reds an invariant here
// bounces per the packet (W1-PACKET.md § T8, OVER-REDACTION-ROOT-CAUSE.md).
//
// INV-1 (client protection intact — NOT byte-identical): in the `client` tier,
//   real secrets/tokens/emails stay masked AND the operator path/artifact
//   scrub still fires. F3 legitimately un-redacts a display-truncated
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
import { redactInternalArtifacts, resolveOutboundAudience } from '../../src/core/outbound-message-safety.ts';
import { sanitizeProviderPreviewText } from '../../src/lib/provider-preview-sanitizer.ts';

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

describe('cross-check: sanitizeProviderPreviewText agrees with redactInternalArtifacts on INV-2/INV-4(b)', () => {
  it('a full token is redacted directly by the sanitizer (SSOT for the secrets pass)', () => {
    expect(sanitizeProviderPreviewText(FULL_SESSION_TOKEN)).toContain('[REDACTED]');
  });

  it('the F3 carve-out shape survives the sanitizer directly', () => {
    expect(sanitizeProviderPreviewText(TRUNCATED_DISPLAY_ID)).toContain('4947004d');
  });
});
