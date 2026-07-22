import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  redactInternalArtifacts,
  classifyAssistantTextEgress,
  classifyInfraStatusClaim,
  evaluateOutboundMessageSafety,
  resolveOutboundAudience,
  isOperatorDmPeer,
  resetSpoofWarnDedupe,
  CLIENT_TEMPORARY_ISSUE_TEXT,
} from '../../src/core/outbound-message-safety.ts';
import { Database } from '../../src/core/database.ts';
import { sanitizeProviderPreviewText } from '../../src/lib/provider-preview-sanitizer.ts';
import { E9_BARE_AT_MESSAGE } from '../fixtures/e9-strings.ts';

// T8-F1+F2: isOperatorDmPeer logs (never-silent, WG-7) via the module's own
// child logger. Hoisted so the mock factory (which vitest hoists above these
// imports) can close over a stable object the tests assert against.
const { mockAudienceLog } = vi.hoisted(() => ({
  mockAudienceLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/logger.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/logger.ts')>();
  return {
    ...actual,
    // Only the module-under-test's 'outbound-audience' child logger is
    // captured — every other component (e.g. Database's own child logger)
    // keeps the REAL logger so this mock never masks unrelated warnings.
    createChildLogger: (name: string) =>
      name === 'outbound-audience' ? mockAudienceLog : actual.createChildLogger(name),
  };
});

// All fixtures use neutral placeholders. `/Users/testuser` and `/home/testuser`
// are allow-listed by the repo-hygiene guard yet still match the guardrail's
// generic home-path shape, so they exercise redaction without leaking a real
// operator path. The tailnet IP is assembled at runtime to avoid any literal.
const TAILNET_IP = ['100', '64', '1', '1'].join('.');
// Secret/PII-shaped fixtures are assembled at runtime so no literal token,
// email, or JID appears in committed source (repo-hygiene guard), while still
// exercising redaction on the runtime value.
const FAKE_TOKEN = `sk-${'abc123def456ghi789'}`;
const FAKE_TOKEN_2 = `sk-${'zzz999yyy888'}`;
const FAKE_EMAIL = ['ops', 'example.test'].join('@');
const FAKE_JID = `${'12345678901'}@${'s.whatsapp.net'}`;
const FAKE_GROUP_JID = `${'120363000000000000'}@${'g.us'}`;
// Device-suffixed (`:N`) JIDs — the dimension the old local regex dropped, so
// they leaked verbatim before folding onto the SSOT `jidPattern()` (BEAD-048).
const FAKE_JID_DEVICE = `${'123456789'}:6@${'s.whatsapp.net'}`;
const FAKE_LID_DEVICE = `${'12345'}:6@lid`;
// Already-covered shapes — assert no regression after the swap.
const FAKE_JID_PLAIN = `${'123456'}@${'s.whatsapp.net'}`;
const FAKE_JID_DASH = `${'123456'}-2@${'s.whatsapp.net'}`;
const FAKE_PHONE = `+${'12025550143'}`;

describe('redactInternalArtifacts', () => {
  it('masks an absolute macOS-style home path including the dotfile tail', () => {
    const { text, redactions } = redactInternalArtifacts(
      'config lives at /Users/testuser/.claude/sandbox-policy.json on disk',
    );
    expect(text).not.toContain('/Users/testuser');
    expect(text).not.toContain('sandbox-policy.json');
    expect(redactions.length).toBeGreaterThan(0);
  });

  it('masks an absolute Linux-style home path', () => {
    const { text } = redactInternalArtifacts(
      'hook at /home/testuser/LAB/WhatSoup/deploy/hooks/agent-sandbox.sh failed',
    );
    expect(text).not.toContain('/home/testuser');
  });

  it('masks standalone internal identifiers without a full path', () => {
    const { text } = redactInternalArtifacts(
      'agent-sandbox.sh is failing closed and sandbox-policy.json is gone; see PreToolUse in .claude/settings.json',
    );
    expect(text).not.toContain('agent-sandbox.sh');
    expect(text).not.toContain('sandbox-policy.json');
    expect(text).not.toContain('PreToolUse');
    expect(text).not.toContain('.claude/');
    expect(text).not.toContain('settings.json');
  });

  it('masks a private tailnet (CGNAT 100.64/10) address', () => {
    const { text } = redactInternalArtifacts(`reaching the bot at ${TAILNET_IP} timed out`);
    expect(text).not.toContain(TAILNET_IP);
  });

  it('masks tilde-rooted home paths (the WhatSoup config/state tree leaks the instance label)', () => {
    const { text, redactions } = redactInternalArtifacts(
      'creds at ~/.config/whatsoup/instances/personal/auth/creds.json on disk',
    );
    expect(text).not.toContain('~/.config/whatsoup');
    expect(text).not.toContain('instances/personal');
    expect(text).not.toContain('auth/creds.json');
    expect(redactions.length).toBeGreaterThan(0);
  });

  it('masks a tilde-rooted state-dir path', () => {
    const { text } = redactInternalArtifacts('db at ~/.local/share/whatsoup/instances/x/bot.db');
    expect(text).not.toContain('~/.local/share/whatsoup');
    expect(text).not.toContain('bot.db');
  });

  it('masks the WhatSoup internal config tree even without a home prefix', () => {
    const { text } = redactInternalArtifacts('look in .config/whatsoup/instances/personal/auth here');
    expect(text).not.toContain('.config/whatsoup');
    expect(text).not.toContain('instances/personal');
  });

  it('does not treat a bare tilde or "~N" as a path', () => {
    const input = 'Your order ships in ~5 days, see you ~ thanks!';
    const { text, redactions } = redactInternalArtifacts(input);
    expect(text).toBe(input);
    expect(redactions).toHaveLength(0);
  });

  it('redacts provider tokens via the shared sanitizer; emails flow as authored (B25 chat scope)', () => {
    const { text } = redactInternalArtifacts(
      `auth failed: Bearer ${FAKE_TOKEN} for ${FAKE_EMAIL}`,
    );
    expect(text).not.toContain(FAKE_TOKEN);
    // B25 chat-scope owner ruling: email redaction is background-only and must
    // never mutate chat-visible text.
    expect(text).toContain(FAKE_EMAIL);
    expect(text).not.toContain('[REDACTED_EMAIL]');
  });

  it('leaves ordinary client text unchanged with zero redactions', () => {
    const input = 'Your appointment is confirmed for Tuesday at 3pm. See you then!';
    const { text, redactions } = redactInternalArtifacts(input);
    expect(text).toBe(input);
    expect(redactions).toHaveLength(0);
  });

  it('is idempotent — redacting already-redacted text changes nothing further', () => {
    const once = redactInternalArtifacts('path /Users/testuser/.claude/settings.json here').text;
    const twice = redactInternalArtifacts(once).text;
    expect(twice).toBe(once);
  });

  it('reports stable, categorised redaction reasons', () => {
    const { redactions } = redactInternalArtifacts(
      'see /Users/testuser/.claude/settings.json and agent-sandbox.sh',
    );
    const categories = redactions.map((r) => r.category);
    expect(categories).toContain('home_path');
    expect(categories).toContain('internal_identifier');
  });
});

describe('classifyInfraStatusClaim', () => {
  it.each([
    'All my tools are blocked right now.',
    'I cannot use any tools at the moment.',
    'The agent sandbox is failing closed.',
    'My sandbox policy is missing so nothing works.',
    'The sandbox policy file is missing and my tools are blocked.',
  ])('classifies a self-infra failure claim as true: %s', (claim) => {
    expect(classifyInfraStatusClaim(claim)).toBe(true);
  });

  it.each([
    'I cannot complete that request without the attachment.',
    "The booking tool is blocked on the client's end right now.",
    'Your scheduling tool is currently unavailable from the vendor.',
    'I can help you book that appointment today.',
  ])('does not classify benign client-facing text as an infra claim: %s', (text) => {
    expect(classifyInfraStatusClaim(text)).toBe(false);
  });

  // The classifier must be SELF-referential: the agent helping a client with the
  // CLIENT's tooling must not be misread as the agent's own infra failing — a
  // divert would replace genuine help with a generic stub.
  it.each([
    'It sounds like your tools are blocked by the firewall — try allowlisting them.',
    'Your booking tools are blocked on weekends per your settings.',
    'The CRM tools are blocked for your role; ask your admin.',
    'Those export tools are blocked until you upgrade your plan.',
  ])('does not classify a reference to the CLIENT\'s tools as a self-infra claim: %s', (text) => {
    expect(classifyInfraStatusClaim(text)).toBe(false);
  });
});

describe('evaluateOutboundMessageSafety', () => {
  it('allows ops audience text unchanged (preserves raw diagnostics)', () => {
    const raw = 'agent-sandbox.sh failing closed at /Users/testuser/.claude/sandbox-policy.json';
    const decision = evaluateOutboundMessageSafety({ text: raw, audience: 'ops' });
    expect(decision.action).toBe('allow');
    expect(decision.text).toBe(raw);
  });

  it('allows internal audience operator vocabulary unchanged (no secret to mask)', () => {
    const raw = 'PreToolUse hook missing in .claude/settings.json';
    const decision = evaluateOutboundMessageSafety({ text: raw, audience: 'internal' });
    expect(decision.action).toBe('allow');
    expect(decision.text).toBe(raw);
  });

  it('internal audience masks a secret but preserves operator vocabulary', () => {
    const decision = evaluateOutboundMessageSafety({
      text: `push done: Bearer ${FAKE_TOKEN} — config at /home/testuser/.claude/settings.json`,
      audience: 'internal',
    });
    expect(decision.action).toBe('redact');
    expect(decision.text).not.toContain(FAKE_TOKEN);
    // operator vocabulary is legitimate content in an internal agent group
    expect(decision.text).toContain('/home/testuser/.claude/settings.json');
  });

  it('does not divert an internal self-infra claim (agents discuss their own tooling)', () => {
    const decision = evaluateOutboundMessageSafety({
      text: 'All my tools are blocked because agent-sandbox.sh is failing closed.',
      audience: 'internal',
    });
    expect(decision.action).toBe('allow');
    expect(decision.text).toContain('agent-sandbox.sh');
  });

  it('redacts client text that leaks an internal path', () => {
    const decision = evaluateOutboundMessageSafety({
      text: 'Sorry, my config at /Users/testuser/.claude/settings.json is acting up.',
      audience: 'client',
    });
    expect(decision.action).toBe('redact');
    expect(decision.reason).toBe('internal_artifact');
    expect(decision.text).not.toContain('/Users/testuser');
    expect(decision.text).not.toContain('settings.json');
  });

  it('diverts client text making a false infra-block self-diagnosis', () => {
    const decision = evaluateOutboundMessageSafety({
      text: 'All tools are blocked because agent-sandbox.sh is failing closed and sandbox-policy.json is missing.',
      audience: 'client',
    });
    expect(decision.action).toBe('divert');
    expect(decision.reason).toBe('false_infra_block_claim');
    expect(decision.text).toBe(CLIENT_TEMPORARY_ISSUE_TEXT);
    // client never sees the internal details
    expect(decision.text).not.toContain('agent-sandbox.sh');
    expect(decision.text).not.toContain('sandbox-policy.json');
  });

  it('allows benign client text unchanged', () => {
    const raw = 'Your appointment is confirmed for Tuesday at 3pm.';
    const decision = evaluateOutboundMessageSafety({ text: raw, audience: 'client' });
    expect(decision.action).toBe('allow');
    expect(decision.text).toBe(raw);
  });

  it('suppresses parked acknowledgment filler for explicit non-ops sends', () => {
    const decision = evaluateOutboundMessageSafety({
      text: "Understood — deploy 6b768363 noted. Lane parked, leak messages left in place, and I won't repost the blocker until auth is available or someone asks.",
      audience: 'client',
    });

    expect(decision).toEqual({
      action: 'suppress',
      text: '',
      reason: 'ack_filler',
    });
  });

  it('attaches sanitized opsEvidence on divert — no raw path username, token, JID, or phone', () => {
    const raw =
      `All my tools are blocked. creds at /Users/testuser/.claude/x, token Bearer ${FAKE_TOKEN_2}, chat ${FAKE_JID}, call ${FAKE_PHONE}`;
    const decision = evaluateOutboundMessageSafety({ text: raw, audience: 'client' });
    expect(decision.action).toBe('divert');
    expect(decision.opsEvidence).toBeDefined();
    const evidence = decision.opsEvidence ?? '';
    // diagnostic intent preserved for ops, but PII/secrets/usernames stripped
    expect(evidence).not.toContain('testuser');
    expect(evidence).not.toContain(FAKE_TOKEN_2);
    expect(evidence).not.toContain(FAKE_JID);
    expect(evidence).not.toContain(FAKE_PHONE);
  });

  it('masks device-suffixed (`:N`) JIDs in opsEvidence — BEAD-048 (no `:N` leak)', () => {
    const raw =
      `All my tools are blocked. device chat ${FAKE_JID_DEVICE} and lid ${FAKE_LID_DEVICE}; ` +
      `plain ${FAKE_JID_PLAIN}; dash ${FAKE_JID_DASH}`;
    const decision = evaluateOutboundMessageSafety({ text: raw, audience: 'client' });
    expect(decision.action).toBe('divert');
    const evidence = decision.opsEvidence ?? '';
    // The device-suffixed JIDs (the leak this fix closes) must be fully masked.
    expect(evidence).not.toContain(FAKE_JID_DEVICE);
    expect(evidence).not.toContain(FAKE_LID_DEVICE);
    // No regression: plain and device-dash JIDs still redact.
    expect(evidence).not.toContain(FAKE_JID_PLAIN);
    expect(evidence).not.toContain(FAKE_JID_DASH);
    expect(evidence).toContain('[redacted-jid]');
  });

  it('attaches sanitized opsEvidence on redact', () => {
    const decision = evaluateOutboundMessageSafety({
      text: 'oops /Users/testuser/.claude/settings.json broke',
      audience: 'client',
    });
    expect(decision.action).toBe('redact');
    expect(decision.opsEvidence).toBeDefined();
    expect(decision.opsEvidence).not.toContain('testuser');
  });
});

describe('classifyAssistantTextEgress', () => {
  it('suppresses internal work narration without satisfying the reply guarantee', () => {
    const decision = classifyAssistantTextEgress('Now rebuild the workbook with the new trace columns.');

    expect(decision).toEqual({
      action: 'suppress',
      reason: 'internal_narration',
      satisfiesReplyGuarantee: false,
    });
  });

  it('suppresses live gate-check narration without satisfying the reply guarantee', () => {
    const decision = classifyAssistantTextEgress(
      "I'll silently check current gate state before deciding whether anything new needs surfacing.",
    );

    expect(decision).toEqual({
      action: 'suppress',
      reason: 'internal_narration',
      satisfiesReplyGuarantee: false,
    });
  });

  it('suppresses pre-send gate status narration without satisfying the reply guarantee', () => {
    const decision = classifyAssistantTextEgress(
      "The lane is still blocked at step 2 — Intuit session is UNAUTHENTICATED and the login driver can't restore it. This is the same wall as 18:36, and the two unblock actions both require Lucas or Ana. Let me send the gate-failure status to the LCP chat.",
    );

    expect(decision).toEqual({
      action: 'suppress',
      reason: 'internal_narration',
      satisfiesReplyGuarantee: false,
    });
  });

  it('suppresses send/read-back verification chatter and satisfies the reply guarantee', () => {
    const decision = classifyAssistantTextEgress('Acknowledged and delivered (verified, pk 23924).');

    expect(decision).toEqual({
      action: 'suppress',
      reason: 'send_verification',
      satisfiesReplyGuarantee: true,
    });
  });

  it('suppresses landed-cleanly verification chatter and satisfies the reply guarantee', () => {
    const decision = classifyAssistantTextEgress(
      'The gate-failure message landed cleanly (pk 23971). I also note my pre-tool line leaked.',
    );

    expect(decision).toEqual({
      action: 'suppress',
      reason: 'send_verification',
      satisfiesReplyGuarantee: true,
    });
  });

  // #1751: this text has the same surface shape as the ack/parked-status
  // filler cases below ("acknowledged ... lane stays parked") but ALSO
  // asserts a delivery happened ("confirmed delivery", "landed clean") — the
  // same claim as the send_verification cases above. It moved out of
  // ACK_FILLER_PATTERNS into SEND_VERIFICATION_PATTERNS so the origin-chat
  // evidence gate in runtime.ts applies to it; the ack/parked-status cases
  // below assert nothing was sent anywhere and stay evidence-free.
  it('suppresses acknowledgment text asserting delivery as send_verification, not ack_filler', () => {
    const decision = classifyAssistantTextEgress(
      'Acknowledged Lucas and confirmed delivery (landed clean). Lane stays parked on Intuit/QB Time auth — nothing further to do until Ana signs into Chrome on the mini or Lucas OKs the Keychain fallback.',
    );

    expect(decision).toEqual({
      action: 'suppress',
      reason: 'send_verification',
      satisfiesReplyGuarantee: true,
    });
  });

  it.each([
    "Parked per Lucas's 20:06 directive — LCP lane stays blocked on Intuit/QB Time auth (needs Ana to sign in on the mini's Chrome, or Lucas to OK the Keychain fallback). No new evidence and no user ask, so I'm not reposting the blocker status or touching the leak messages. Holding until auth is available.",
    "Understood — deploy 6b768363 noted. Lane parked, leak messages left in place, and I won't repost the blocker until auth is available or someone asks. I'll pick the LCP lane back up the moment the mini's Chrome has a live Intuit/QB Time session.",
    "Understood — holding. LCP lane parked on QB Time/TSheets auth; I'll resume the daily CSV exports (2026-05-13..05-31, 2026-06-27..07-07) the moment auth is live. No further status pings until then.",
    "Acknowledged internally — no action taken. Operator's 20:34 directive is explicit: LCP lane stays parked on QB Time/TSheets auth (missing ranges 05-13..05-31 and 06-27..07-07), and no bot action until auth changes or a user asks.",
    'No action taken.',
    'No action.',
    'No action needed.',
    '(no action)',
    'I will stay silent — the operator directive is explicit ("Do not acknowledge this status," no action until auth changes or a user asks), and there is no user request pending. No message will be sent.',
    'No action needed — staying silent per directive.',
    'No acknowledgement needed — staying silent.',
    'No action needed — LCP stays parked on QB Time/TSheets auth; no user ask pending. Standing by.',
    '(No action — status noted internally, nothing to send.)',
    'No response needed.',
    "Holding — no reply warranted per operator's control note.",
    "No outbound warranted — operator's control note explicitly says do not reply, do not ack, do not status-ping, and no user ask is pending. Staying silent; sending nothing to WhatsApp.",
  ])('suppresses ack/parked status filler and satisfies the reply guarantee: %s', (text) => {
    expect(classifyAssistantTextEgress(text)).toEqual({
      action: 'suppress',
      reason: 'ack_filler',
      satisfiesReplyGuarantee: true,
    });
  });

  it('suppresses no-op punctuation and satisfies the reply guarantee', () => {
    const decision = classifyAssistantTextEgress('.');

    expect(decision).toEqual({
      action: 'suppress',
      reason: 'noop',
      satisfiesReplyGuarantee: true,
    });
  });

  it('suppresses generic progress filler without satisfying the reply guarantee', () => {
    expect(classifyAssistantTextEgress("I'm still working on this and will follow up shortly.")).toEqual({
      action: 'suppress',
      reason: 'progress_filler',
      satisfiesReplyGuarantee: false,
    });
    expect(classifyAssistantTextEgress('_Still working..._')).toEqual({
      action: 'suppress',
      reason: 'progress_filler',
      satisfiesReplyGuarantee: false,
    });
  });

  it('allows user-facing final text', () => {
    expect(classifyAssistantTextEgress('Workbook delivered with 597 entry rows and 83 employee-week totals.')).toEqual({
      action: 'allow',
    });
  });

  it('allows normal user-facing prose that mentions verified totals', () => {
    expect(classifyAssistantTextEgress('The workbook verified the totals against the source rows.')).toEqual({
      action: 'allow',
    });
  });

  it('allows normal closing prose that begins with let me know', () => {
    expect(classifyAssistantTextEgress('Let me know if you want me to export the workbook as CSV too.')).toEqual({
      action: 'allow',
    });
  });
});

describe('redactInternalArtifacts — audience scoping', () => {
  const coordinationText =
    'bead-03 done: see /home/testuser/.claude/settings.json and the PreToolUse hook. Files: ~/.config/whatsoup/x';

  it('internal audience preserves operator vocabulary (paths, hook names, config tree)', () => {
    const { text, redactions } = redactInternalArtifacts(coordinationText, 'internal');
    expect(text).toBe(coordinationText);
    expect(redactions).toHaveLength(0);
  });

  it('internal audience still masks secrets (third-party transport); emails flow as authored (B25 chat scope)', () => {
    const { text, redactions } = redactInternalArtifacts(
      `deploy: Bearer ${FAKE_TOKEN} for ${FAKE_EMAIL} — see /home/testuser/.claude/settings.json`,
      'internal',
    );
    expect(text).not.toContain(FAKE_TOKEN);
    // B25 chat-scope owner ruling: email masking is background-only.
    expect(text).toContain(FAKE_EMAIL);
    // operator path preserved for the internal group
    expect(text).toContain('/home/testuser/.claude/settings.json');
    expect(redactions.map((r) => r.category)).toContain('provider_secret');
  });

  it('internal audience preserves WhatsApp JIDs used as operational identifiers', () => {
    const { text, redactions } = redactInternalArtifacts(
      `FINBOT target ${FAKE_GROUP_JID}; repo at /home/testuser/LAB/WhatSoup`,
      'internal',
    );
    expect(text).toContain(FAKE_GROUP_JID);
    expect(text).toContain('/home/testuser/LAB/WhatSoup');
    expect(redactions).toHaveLength(0);
  });

  it('client audience preserves outbound WhatsApp phone mentions', () => {
    expect(redactInternalArtifacts('Hi @15555550001!', 'client').text).toBe('Hi @15555550001!');
    expect(redactInternalArtifacts('Hi @alice!', 'client').text).toBe('Hi @alice!');
  });

  it('E9 (packet D5): a bare "@" used as the word "at" survives at client and internal audiences', () => {
    // Live evidence: an internal-tier DM explaining this very bug had its own
    // bare '@' re-redacted to [REDACTED_EMAIL]. A whitespace-flanked '@' has no
    // local part and no domain part — it is not email-shaped.
    const input = E9_BARE_AT_MESSAGE;
    expect(redactInternalArtifacts(input, 'client').text).toBe(input);
    expect(redactInternalArtifacts(input, 'internal').text).toBe(input);
  });

  // B25 chat scope: these email-like tokens previously redacted at internal
  // audience. Chat egress no longer runs ANY email-class transform, so they
  // pass through as authored; the redaction coverage moves to the provider
  // path (same flag set the internal audience used to pass), asserted below
  // so the sanitizer's email logic keeps this adversarial coverage.
  const EMAIL_LIKE_JID_TOKENS = [
    { label: 'nested domain', input: `${FAKE_GROUP_JID}.evil.test` },
    { label: 'hyphenated domain', input: `${FAKE_GROUP_JID}-evil.test` },
    { label: 'repeated hyphen domain', input: `${FAKE_GROUP_JID}--evil.test` },
    { label: 'mixed punctuation domain', input: `${FAKE_GROUP_JID}.-evil.test` },
    { label: 'leading plus', input: `+${FAKE_GROUP_JID}` },
    { label: 'dotted local part', input: `x.${FAKE_GROUP_JID}` },
  ];

  it.each(EMAIL_LIKE_JID_TOKENS)('chat egress (internal) passes an email-like token through as authored: $label', ({ input }) => {
      const { text, redactions } = redactInternalArtifacts(input, 'internal');
      expect(text).toBe(input);
      expect(redactions).toHaveLength(0);
  });

  it.each(EMAIL_LIKE_JID_TOKENS)('provider path still redacts a JID-shaped substring inside an email-like token: $label', ({ input }) => {
      const out = sanitizeProviderPreviewText(input, {
        preserveWhatsAppJids: true,
        preserveWhatsAppMentions: true,
      });
      expect(out).toBe('[REDACTED_EMAIL]');
      expect(out).not.toContain(FAKE_GROUP_JID);
  });

  it('internal audience does not reinterpret literal JID placeholder-shaped text', () => {
    const placeholder = '__WHATSOUP_JID_0__';
    const input = `${FAKE_GROUP_JID} literal ${placeholder}`;

    expect(redactInternalArtifacts(input, 'internal').text).toBe(input);
  });

  it.each([
    { input: `password=abc/${FAKE_GROUP_JID}/def`, expected: 'password=[REDACTED]' },
    { input: `client_secret=abc-${FAKE_GROUP_JID}-def`, expected: 'client_secret=[REDACTED]' },
  ])('internal audience redacts the complete unquoted keyed value in $input', ({ input, expected }) => {
    const { text, redactions } = redactInternalArtifacts(input, 'internal');
    expect(text).toBe(expected);
    expect(text).not.toContain(FAKE_GROUP_JID);
    expect(redactions.map((redaction) => redaction.category)).toContain('provider_secret');
  });

  it.each([
    { input: `password="abc ${FAKE_GROUP_JID} def"`, expected: 'password="[REDACTED]"' },
    { input: `client_secret='abcdefgh ${FAKE_GROUP_JID} suffix'`, expected: "client_secret='[REDACTED]'" },
    { input: `{"password":"abc ${FAKE_GROUP_JID} def"}`, expected: '{"password":"[REDACTED]"}' },
    { input: `password="abc\n${FAKE_GROUP_JID} def"`, expected: 'password="[REDACTED]"' },
    { input: `password="abc\n${FAKE_GROUP_JID} def`, expected: 'password="[REDACTED]' },
    { input: `config.password=abc/${FAKE_GROUP_JID}/def`, expected: 'config.password=[REDACTED]' },
    { input: `db-password=abc/${FAKE_GROUP_JID}/def`, expected: 'db-password=[REDACTED]' },
    { input: `obj.client_secret=abc/${FAKE_GROUP_JID}/def`, expected: 'obj.client_secret=[REDACTED]' },
    { input: `{"config.password":"abc ${FAKE_GROUP_JID} def"}`, expected: '{"config.password":"[REDACTED]"}' },
    { input: `x-api-key-header=abc/${FAKE_GROUP_JID}/def`, expected: 'x-api-key-header=[REDACTED]' },
    { input: `api_key_value=abc/${FAKE_GROUP_JID}/def`, expected: 'api_key_value=[REDACTED]' },
    { input: `myapikeyprod=abc/${FAKE_GROUP_JID}/def`, expected: 'myapikeyprod=[REDACTED]' },
    { input: `company_service_environment_openai_api_key=abc/${FAKE_GROUP_JID}/def`, expected: 'company_service_environment_openai_api_key=[REDACTED]' },
    { input: `abcdefghijklmnopqrstuapi_key=abc/${FAKE_GROUP_JID}/def`, expected: 'abcdefghijklmnopqrstuapi_key=[REDACTED]' },
    { input: 'password=@alice', expected: 'password=[REDACTED]' },
    { input: 'token=@12345', expected: 'token=[REDACTED]' },
  ])('internal audience redacts the entire quoted keyed value in $input', ({ input, expected }) => {
    const { text, redactions } = redactInternalArtifacts(input, 'internal');
    expect(text).toBe(expected);
    expect(text).not.toContain(FAKE_GROUP_JID);
    expect(redactions.map((redaction) => redaction.category)).toContain('provider_secret');
  });

  it.each([
    // B25 chat scope: quoted-local shapes previously became [REDACTED_EMAIL]
    // at internal audience; chat egress now passes them through as authored.
    { label: 'quoted local part', input: `"${FAKE_GROUP_JID}"@evil.test`, expected: `"${FAKE_GROUP_JID}"@evil.test` },
    { label: 'quoted domain literal', input: `"${FAKE_GROUP_JID}"@[127.0.0.1]`, expected: `"${FAKE_GROUP_JID}"@[127.0.0.1]` },
    { label: 'label delimiter', input: `target:${FAKE_GROUP_JID}`, expected: `target:${FAKE_GROUP_JID}` },
    { label: 'device JID', input: '12345:6@g.us', expected: '12345:6@g.us' },
    { label: 'agent and device JID', input: '12345-2:6@g.us', expected: '12345-2:6@g.us' },
  ])('chat egress leaves JID and quoted-email shapes as authored: $label', ({ input, expected }) => {
    expect(redactInternalArtifacts(input, 'internal').text).toBe(expected);
  });

  it.each([
    { label: 'quoted local part', input: `"${FAKE_GROUP_JID}"@evil.test` },
    { label: 'quoted domain literal', input: `"${FAKE_GROUP_JID}"@[127.0.0.1]` },
  ])('provider path still redacts a quoted JID local without JID-preserving it: $label', ({ input }) => {
    const out = sanitizeProviderPreviewText(input, {
      preserveWhatsAppJids: true,
      preserveWhatsAppMentions: true,
    });
    expect(out).toBe('[REDACTED_EMAIL]');
    expect(out).not.toContain(FAKE_GROUP_JID);
  });

  it('scans dotted email-local adversarial input in linear time', () => {
    const input = `${'a.'.repeat(32 * 1024)}tail`;
    const startedAt = performance.now();
    const { text } = redactInternalArtifacts(input, 'internal');
    const elapsedMs = performance.now() - startedAt;

    expect(text).toBe(input);
    expect(elapsedMs).toBeLessThan(500);
  });

  it('scans internal sensitive paths in linear time on slash-heavy input', () => {
    const input = '/'.repeat(64 * 1024);
    const startedAt = performance.now();
    const { text } = redactInternalArtifacts(input, 'internal');
    const elapsedMs = performance.now() - startedAt;

    expect(text).toBe(input);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('internal audience still masks auth material and key-file paths', () => {
    const { text, redactions } = redactInternalArtifacts(
      'creds at /home/testuser/.config/whatsoup/instances/q/auth/creds.json and key /home/testuser/.ssh/id_ed25519',
      'internal',
    );
    expect(text).not.toContain('/home/testuser/.config/whatsoup/instances/q/auth/creds.json');
    expect(text).not.toContain('/home/testuser/.ssh/id_ed25519');
    expect(text).toContain('[sensitive-path]');
    expect(redactions.map((r) => r.category)).toContain('sensitive_path');
  });

  it('masks sensitive paths before terminal punctuation and Markdown delimiters', () => {
    for (const input of [
      '/home/testuser/fleet-tokens.json.',
      '~/fleet-tokens.json:',
      '`~/fleet-tokens.json`',
      '_~/fleet-tokens.json_',
      '~~/fleet-tokens.json~',
      '/tmp/client.key.',
      'https://host/fleet-tokens.json?x=1',
    ]) {
      const { text, redactions } = redactInternalArtifacts(input, 'internal');
      expect(text).not.toContain('fleet-tokens.json');
      expect(text).not.toContain('client.key');
      expect(text).toContain('[sensitive-path]');
      expect(redactions.map((redaction) => redaction.category)).toContain('sensitive_path');
    }
  });

  it.each([
    { input: '/tmp/client.key…', expected: '[sensitive-path]…' },
    { input: '“/tmp/client.key”', expected: '“[sensitive-path]”' },
    { input: "‘/home/testuser/fleet-tokens.json’", expected: "‘[sensitive-path]’" },
    { input: '~~~/home/testuser/fleet-tokens.json~~', expected: '~~[sensitive-path]~~' },
    { input: '/home/testuser/.config/secrets/', expected: '[sensitive-path]' },
    { input: '/state/auth-bond-backups/', expected: '[sensitive-path]' },
  ])('preserves Unicode or Markdown wrappers while masking $input', ({ input, expected }) => {
    const { text, redactions } = redactInternalArtifacts(input, 'internal');
    expect(text).toBe(expected);
    expect(redactions.map((redaction) => redaction.category)).toContain('sensitive_path');
  });

  it('ops audience is fully verbatim', () => {
    const raw = `token Bearer ${FAKE_TOKEN} at /home/testuser/.claude/settings.json`;
    const { text, redactions } = redactInternalArtifacts(raw, 'ops');
    expect(text).toBe(raw);
    expect(redactions).toHaveLength(0);
  });

  it('client audience (default arg) still performs the full scrub', () => {
    const { text } = redactInternalArtifacts(coordinationText);
    expect(text).not.toContain('/home/testuser');
    expect(text).not.toContain('settings.json');
    expect(text).not.toContain('PreToolUse');
  });
});

describe('resolveOutboundAudience', () => {
  const savedBotErrors = process.env['BOT_ERRORS_JID'];
  const savedInternal = process.env['WHATSOUP_INTERNAL_JIDS'];
  const restore = (key: string, saved: string | undefined) => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  };
  afterEach(() => {
    restore('BOT_ERRORS_JID', savedBotErrors);
    restore('WHATSOUP_INTERNAL_JIDS', savedInternal);
  });

  it('returns ops for the configured BOT ERRORS channel', () => {
    process.env['BOT_ERRORS_JID'] = '000@g.us';
    expect(resolveOutboundAudience('000@g.us')).toBe('ops');
  });

  it('returns internal for a JID in the WHATSOUP_INTERNAL_JIDS allow-list (whitespace-tolerant)', () => {
    process.env['WHATSOUP_INTERNAL_JIDS'] = '111@g.us, 222@g.us';
    expect(resolveOutboundAudience('111@g.us')).toBe('internal');
    expect(resolveOutboundAudience('222@g.us')).toBe('internal');
  });

  it('defaults to client for any unlisted chat', () => {
    delete process.env['BOT_ERRORS_JID'];
    process.env['WHATSOUP_INTERNAL_JIDS'] = '111@g.us';
    expect(resolveOutboundAudience('999@g.us')).toBe('client');
  });

  it('prefers ops over internal when a JID is in both', () => {
    process.env['BOT_ERRORS_JID'] = '111@g.us';
    process.env['WHATSOUP_INTERNAL_JIDS'] = '111@g.us';
    expect(resolveOutboundAudience('111@g.us')).toBe('ops');
  });

  it('treats an empty or unset allow-list as no internal chats', () => {
    delete process.env['BOT_ERRORS_JID'];
    process.env['WHATSOUP_INTERNAL_JIDS'] = '';
    expect(resolveOutboundAudience('111@g.us')).toBe('client');
    delete process.env['WHATSOUP_INTERNAL_JIDS'];
    expect(resolveOutboundAudience('111@g.us')).toBe('client');
  });
});

// ---------------------------------------------------------------------------
// T8-F1+F2 — operator-DM audience tier, trusted-primary-only
// ---------------------------------------------------------------------------

// Neutral admin/owner fixtures — assembled at runtime so no literal phone/lid
// appears in committed source (repo-hygiene guard), matching the FAKE_* style
// above. Shapes mirror the OBSERVED-LIVE owner DM (V32): phone-form
// `@s.whatsapp.net` and lid-form `@lid` are two JIDs for the SAME operator.
const OWNER_PHONE = `${'18459780901'}`;
const OWNER_PHONE_JID = `${OWNER_PHONE}@s.whatsapp.net`;
const OWNER_LID = `${'16566225701'}`;
const OWNER_LID_JID = `${OWNER_LID}@lid`;
const UNMAPPED_LID_JID = `${'19999999901'}@lid`;
const NON_ADMIN_PHONE = `${'15559990001'}`;
const NON_ADMIN_PHONE_JID = `${NON_ADMIN_PHONE}@s.whatsapp.net`;
const ADMIN_PHONES = new Set([OWNER_PHONE]);

function openDbWithLidMapping(): Database {
  const db = new Database(':memory:');
  db.open();
  // Mirrors admin.test.ts's seed pattern: lid_mappings.phone_jid stores the
  // FULL phone JID; resolveLid/resolvePhoneFromJid strip it to bare digits.
  db.raw.prepare(
    "INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))",
  ).run(OWNER_LID, OWNER_PHONE_JID);
  return db;
}

describe('isOperatorDmPeer', () => {
  afterEach(() => {
    mockAudienceLog.warn.mockClear();
    // B21-C: the spoof-warn TTL dedupe map is module-level; reset it so each
    // test observes first-warn behavior regardless of ordering.
    resetSpoofWarnDedupe();
  });

  it('[gate test 5, phone form] returns true for the owner DM peer in phone-JID form', () => {
    const db = openDbWithLidMapping();
    try {
      expect(isOperatorDmPeer(OWNER_PHONE_JID, false, db, ADMIN_PHONES)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('binds operator-DM elevation to the configured transport namespace', () => {
    const db = openDbWithLidMapping();
    try {
      expect(isOperatorDmPeer(OWNER_PHONE_JID, false, db, ADMIN_PHONES, 'baileys')).toBe(true);
      expect(isOperatorDmPeer(OWNER_PHONE_JID, false, db, ADMIN_PHONES, 'signal')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('[gate test 5, lid form — the PRIMARY case, V32] returns true for the owner DM peer in lid-JID form via a resolveLid fixture mapping', () => {
    const db = openDbWithLidMapping();
    try {
      expect(isOperatorDmPeer(OWNER_LID_JID, false, db, ADMIN_PHONES)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('[never-silent, WG-7] an unresolved lid peer returns false AND logs outbound-audience/not-elevated (id-only, N14)', () => {
    const db = openDbWithLidMapping();
    try {
      const result = isOperatorDmPeer(UNMAPPED_LID_JID, false, db, ADMIN_PHONES);
      expect(result).toBe(false);
      expect(mockAudienceLog.warn).toHaveBeenCalledTimes(1);
      const [payload, message] = mockAudienceLog.warn.mock.calls[0] as [Record<string, unknown>, string];
      expect(payload).toMatchObject({ chatJidForm: 'lid', outcome: 'not-elevated' });
      // N14: never the raw chatJid/lid value in the log line.
      expect(JSON.stringify(payload)).not.toContain(UNMAPPED_LID_JID.split('@')[0]);
      expect(message).toMatch(/lid peer/i);
    } finally {
      db.close();
    }
  });

  it('[group] returns false for a group chat even when the sender would otherwise resolve admin', () => {
    const db = openDbWithLidMapping();
    try {
      expect(isOperatorDmPeer(OWNER_PHONE_JID, true, db, ADMIN_PHONES)).toBe(false);
      expect(isOperatorDmPeer(OWNER_LID_JID, true, db, ADMIN_PHONES)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('returns false for a non-admin phone-form DM peer, and does not log (only lid non-resolution logs)', () => {
    const db = openDbWithLidMapping();
    try {
      expect(isOperatorDmPeer(NON_ADMIN_PHONE_JID, false, db, ADMIN_PHONES)).toBe(false);
      expect(mockAudienceLog.warn).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('[ADVERSARIAL, QR-143] a spoofed <admin-digits>@sms chatJid does NOT elevate — resolvePhoneFromJid collapses it to the bare admin phone with no authenticated-JID guard', () => {
    const db = openDbWithLidMapping();
    try {
      // smsJidToPhone strips the '@sms' suffix down to the same bare digits as
      // OWNER_PHONE_JID's phone form — an attacker who can present ANY chatJid
      // ending '@sms' with the admin's digits (SMS sender-ID is spoofable, see
      // jid-constants.ts isWhatsAppAuthenticatedJid doc) must not inherit the
      // owner's operator-DM elevation.
      const spoofedSmsJid = `${OWNER_PHONE}@sms`;
      const peerIsAdmin = isOperatorDmPeer(spoofedSmsJid, false, db, ADMIN_PHONES);
      expect(peerIsAdmin).toBe(false);

      // Full path: a caller wiring peerIsAdmin into resolveOutboundAudience must
      // still land on 'client' for this chatJid — never 'internal'.
      const audience = resolveOutboundAudience(spoofedSmsJid, {
        isGroup: false,
        peerIsAdmin,
        fallbackActive: false,
      });
      expect(audience).toBe('client');

      // And at 'client' audience, operator vocabulary that would be left
      // unmasked at 'internal' (see the INV-2 test above) must be MASKED — the
      // operator path must not reach a spoofed-SMS "client".
      const operatorPathText = 'restart via /Users/testuser/LAB/whatsoup/instances/q';
      const { text } = redactInternalArtifacts(operatorPathText, audience);
      expect(text).not.toContain('/Users/testuser/LAB/whatsoup/instances/q');
      expect(text).toContain('[internal-path]');
    } finally {
      db.close();
    }
  });

  // F1F2 fast-follow (lead-required, non-blocking): the QR-143 @sms guard
  // above returns false for EVERY @sms chatJid, including a spoof attempt
  // that bears admin-like digits. That silent denial is exactly the kind of
  // audience-elevation non-event the @lid never-silent convention (WG-7) and
  // NFR-3 ("gate denials log unsampled, always") say must be observable — so
  // the spoof-attempt SUBSET (unauthenticated + admin-shaped digits) warns.
  // Every OTHER @sms rejection (a benign SMS-bridge chat, not admin-shaped)
  // must stay silent — warning there would be noise on ordinary traffic.
  it('[never-silent, WG-7 fast-follow] a spoofed <admin-digits>@sms chatJid returns false AND logs outbound-audience/spoof-attempt-denied (id-only, N14)', () => {
    const db = openDbWithLidMapping();
    try {
      const spoofedSmsJid = `${OWNER_PHONE}@sms`;
      const result = isOperatorDmPeer(spoofedSmsJid, false, db, ADMIN_PHONES);
      expect(result).toBe(false);
      expect(mockAudienceLog.warn).toHaveBeenCalledTimes(1);
      const [payload, message] = mockAudienceLog.warn.mock.calls[0] as [Record<string, unknown>, string];
      expect(payload).toMatchObject({ chatJidForm: 'sms', outcome: 'spoof-attempt-denied' });
      // N14: never the raw chatJid/phone digits in the log line.
      expect(JSON.stringify(payload)).not.toContain(OWNER_PHONE);
      // The message is static/form-neutral (B21-C); the form lives in the
      // structured chatJidForm field asserted above.
      expect(message).toMatch(/unauthenticated peer/i);
    } finally {
      db.close();
    }
  });

  it('[B21-C form fidelity] a non-@sms unauthenticated form bearing admin digits logs its ACTUAL JID form (suffix after @), not a hardcoded sms label', () => {
    const db = openDbWithLidMapping();
    try {
      // '@c.us' is unauthenticated (not @s.whatsapp.net/@lid) and its domain
      // contributes no digits, so resolvePhoneFromJid + isAdminPhone still see
      // the admin digits — the spoof-warn branch fires. The unauthenticated
      // branch catches EVERY non-authenticated form, so the logged form must
      // be the real '@' suffix, not a hardcoded 'sms' label.
      const spoofedCUsJid = `${OWNER_PHONE}@c.us`;
      const result = isOperatorDmPeer(spoofedCUsJid, false, db, ADMIN_PHONES);
      expect(result).toBe(false);
      expect(mockAudienceLog.warn).toHaveBeenCalledTimes(1);
      const [payload] = mockAudienceLog.warn.mock.calls[0] as [Record<string, unknown>, string];
      expect(payload).toMatchObject({ chatJidForm: 'c.us', outcome: 'spoof-attempt-denied' });
      // N14: still id-only — never the raw digits.
      expect(JSON.stringify(payload)).not.toContain(OWNER_PHONE);
    } finally {
      db.close();
    }
  });

  it('[noise guard] a non-admin @sms chatJid returns false and does NOT warn (benign SMS-bridge chat)', () => {
    const db = openDbWithLidMapping();
    try {
      const nonAdminSmsJid = `${NON_ADMIN_PHONE}@sms`;
      const result = isOperatorDmPeer(nonAdminSmsJid, false, db, ADMIN_PHONES);
      expect(result).toBe(false);
      expect(mockAudienceLog.warn).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  // B21-C flood guard: isOperatorDmPeer runs on EVERY outbound send
  // (messaging.ts, media.ts, runtime call sites), so a legitimate operator
  // SMS-interop DM (peer = admin digits @sms) would emit one spoof-attempt
  // warn per bot reply — a sustained flood mislabeled as an attack. The WARN
  // is deduped per chatJid on a TTL; the deny RETURN VALUE is never deduped.
  it('[B21-C dedupe] two consecutive calls for the SAME chatJid emit exactly one warn; both still return false', () => {
    const db = openDbWithLidMapping();
    try {
      const spoofedSmsJid = `${OWNER_PHONE}@sms`;
      expect(isOperatorDmPeer(spoofedSmsJid, false, db, ADMIN_PHONES)).toBe(false);
      expect(isOperatorDmPeer(spoofedSmsJid, false, db, ADMIN_PHONES)).toBe(false);
      expect(mockAudienceLog.warn).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('[B21-C dedupe] a DIFFERENT chatJid warns independently within the TTL window', () => {
    const db = openDbWithLidMapping();
    try {
      // Same admin digits, two distinct chatJid strings — dedupe keys on the
      // chatJid, so each distinct chat warns once (never-silent per chat).
      expect(isOperatorDmPeer(`${OWNER_PHONE}@sms`, false, db, ADMIN_PHONES)).toBe(false);
      expect(isOperatorDmPeer(`${OWNER_PHONE}@c.us`, false, db, ADMIN_PHONES)).toBe(false);
      expect(mockAudienceLog.warn).toHaveBeenCalledTimes(2);
      const forms = mockAudienceLog.warn.mock.calls.map(
        (call) => (call[0] as Record<string, unknown>)['chatJidForm'],
      );
      expect(forms).toEqual(['sms', 'c.us']);
    } finally {
      db.close();
    }
  });

  it('[B21-C dedupe] after resetSpoofWarnDedupe() the same chatJid warns again', () => {
    const db = openDbWithLidMapping();
    try {
      const spoofedSmsJid = `${OWNER_PHONE}@sms`;
      expect(isOperatorDmPeer(spoofedSmsJid, false, db, ADMIN_PHONES)).toBe(false);
      expect(mockAudienceLog.warn).toHaveBeenCalledTimes(1);
      resetSpoofWarnDedupe();
      expect(isOperatorDmPeer(spoofedSmsJid, false, db, ADMIN_PHONES)).toBe(false);
      expect(mockAudienceLog.warn).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });
});

describe('resolveOutboundAudience — ctx (F1+F2, operator-DM elevation)', () => {
  const savedBotErrors = process.env['BOT_ERRORS_JID'];
  const savedInternal = process.env['WHATSOUP_INTERNAL_JIDS'];
  const restore = (key: string, saved: string | undefined) => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  };
  afterEach(() => {
    restore('BOT_ERRORS_JID', savedBotErrors);
    restore('WHATSOUP_INTERNAL_JIDS', savedInternal);
  });

  it('[env-absent] WHATSOUP_INTERNAL_JIDS unset + owner DM ctx (not fallback) → internal (F1 supersedes the env stopgap)', () => {
    delete process.env['BOT_ERRORS_JID'];
    delete process.env['WHATSOUP_INTERNAL_JIDS'];
    const audience = resolveOutboundAudience(OWNER_LID_JID, {
      isGroup: false,
      peerIsAdmin: true,
      fallbackActive: false,
    });
    expect(audience).toBe('internal');
  });

  it('[gate test 4 / INV-3] fallback window active ⇒ operator DM stays client (full scrub), never elevated', () => {
    const audience = resolveOutboundAudience(OWNER_PHONE_JID, {
      isGroup: false,
      peerIsAdmin: true,
      fallbackActive: true,
    });
    expect(audience).toBe('client');
  });

  it('group + admin peer → NOT elevated (isGroup gates elevation regardless of peerIsAdmin)', () => {
    const audience = resolveOutboundAudience(OWNER_PHONE_JID, {
      isGroup: true,
      peerIsAdmin: true,
      fallbackActive: false,
    });
    expect(audience).toBe('client');
  });

  it('[gate test 6] external non-admin DM peer stays client regardless of ctx', () => {
    const audience = resolveOutboundAudience(NON_ADMIN_PHONE_JID, {
      isGroup: false,
      peerIsAdmin: false,
      fallbackActive: false,
    });
    expect(audience).toBe('client');
  });

  it('omitted ctx preserves exact pre-F1F2 behavior (non-ctx callers unaffected)', () => {
    delete process.env['BOT_ERRORS_JID'];
    delete process.env['WHATSOUP_INTERNAL_JIDS'];
    expect(resolveOutboundAudience(OWNER_PHONE_JID)).toBe('client');
  });

  it('ops (BOT_ERRORS_JID) still wins over ctx elevation', () => {
    process.env['BOT_ERRORS_JID'] = OWNER_PHONE_JID;
    const audience = resolveOutboundAudience(OWNER_PHONE_JID, {
      isGroup: false,
      peerIsAdmin: true,
      fallbackActive: false,
    });
    expect(audience).toBe('ops');
  });

  it('INV-2: elevated operator DM still masks secrets, and internal tier still masks credential paths (non-credential operator path visible)', () => {
    const audience = resolveOutboundAudience(OWNER_LID_JID, {
      isGroup: false,
      peerIsAdmin: true,
      fallbackActive: false,
    });
    expect(audience).toBe('internal');
    const secretText = `session=${'abc123def456ghi789'}`;
    expect(redactInternalArtifacts(secretText, audience).text).not.toContain('abc123def456ghi789');
    const credentialPathText = 'the key is at /Users/testuser/.ssh/id_ed25519 — check it';
    expect(redactInternalArtifacts(credentialPathText, audience).text).not.toContain('.ssh/id_ed25519');
    const operatorPathText = 'restart via /Users/testuser/LAB/whatsoup/instances/q';
    expect(redactInternalArtifacts(operatorPathText, audience).text).toContain(
      '/Users/testuser/LAB/whatsoup/instances/q',
    );
  });
});
