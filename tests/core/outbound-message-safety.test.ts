import { describe, it, expect } from 'vitest';
import {
  redactInternalArtifacts,
  classifyInfraStatusClaim,
  evaluateOutboundMessageSafety,
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
    'The policy file is missing and tools are blocked.',
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
});

describe('evaluateOutboundMessageSafety', () => {
  it('allows ops audience text unchanged (preserves raw diagnostics)', () => {
    const raw = 'agent-sandbox.sh failing closed at /Users/testuser/.claude/sandbox-policy.json';
    const decision = evaluateOutboundMessageSafety({ text: raw, audience: 'ops' });
    expect(decision.action).toBe('allow');
    expect(decision.text).toBe(raw);
  });

  it('allows internal audience text unchanged', () => {
    const raw = 'PreToolUse hook missing in .claude/settings.json';
    const decision = evaluateOutboundMessageSafety({ text: raw, audience: 'internal' });
    expect(decision.action).toBe('allow');
    expect(decision.text).toBe(raw);
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

  it('attaches sanitized opsEvidence on divert — no raw path username, token, JID, or phone', () => {
    const raw =
      `All tools are blocked. creds at /Users/testuser/.claude/x, token Bearer ${FAKE_TOKEN_2}, chat ${FAKE_JID}, call ${FAKE_PHONE}`;
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
