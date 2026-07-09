import { describe, it, expect, afterEach } from 'vitest';
import {
  redactInternalArtifacts,
  classifyAssistantTextEgress,
  classifyInfraStatusClaim,
  evaluateOutboundMessageSafety,
  resolveOutboundAudience,
  CLIENT_TEMPORARY_ISSUE_TEXT,
} from '../../src/core/outbound-message-safety.ts';

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

  it('redacts provider tokens and emails via the shared sanitizer', () => {
    const { text } = redactInternalArtifacts(
      `auth failed: Bearer ${FAKE_TOKEN} for ${FAKE_EMAIL}`,
    );
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(FAKE_EMAIL);
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

  it.each([
    "Parked per Lucas's 20:06 directive — LCP lane stays blocked on Intuit/QB Time auth (needs Ana to sign in on the mini's Chrome, or Lucas to OK the Keychain fallback). No new evidence and no user ask, so I'm not reposting the blocker status or touching the leak messages. Holding until auth is available.",
    "Understood — deploy 6b768363 noted. Lane parked, leak messages left in place, and I won't repost the blocker until auth is available or someone asks. I'll pick the LCP lane back up the moment the mini's Chrome has a live Intuit/QB Time session.",
    "Understood — holding. LCP lane parked on QB Time/TSheets auth; I'll resume the daily CSV exports (2026-05-13..05-31, 2026-06-27..07-07) the moment auth is live. No further status pings until then.",
    'Acknowledged Lucas and confirmed delivery (landed clean). Lane stays parked on Intuit/QB Time auth — nothing further to do until Ana signs into Chrome on the mini or Lucas OKs the Keychain fallback.',
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

  it('internal audience still masks secrets and emails (third-party transport)', () => {
    const { text, redactions } = redactInternalArtifacts(
      `deploy: Bearer ${FAKE_TOKEN} for ${FAKE_EMAIL} — see /home/testuser/.claude/settings.json`,
      'internal',
    );
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(FAKE_EMAIL);
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
