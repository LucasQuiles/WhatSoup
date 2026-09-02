import { describe, expect, it } from 'vitest';
import { buildBotErrorsEvent } from '../../src/lib/bot-errors-outbox.ts';
import { confineConversationScope } from '../../src/lib/alert-evidence.ts';

// A per-conversation fault (an admission rejection) must be distinguishable
// from another conversation's fault by the bot-errors dispatcher, which
// otherwise keys incidents on machine|instance|source alone and collapses
// every chat under one instance into a single incident.
//
// The conversation crosses the emission boundary as a bounded, non-reversible
// digest. The raw identifier is confined INSIDE buildBotErrorsEvent (never by
// the caller) so no emitter can accidentally ship a JID, exactly as #2386 does
// for summary and evidence.

// Reserved synthetic identifiers only (repo-hygiene 1555-prefixed form).
const RAW_JID = '15550100199@s.whatsapp.net';
const RAW_LOCAL = RAW_JID.split('@')[0] as string;
const OTHER_JID = '15550100288@s.whatsapp.net';

function alertInput(conversationKey?: string) {
  return {
    eventType: 'alert' as const,
    instance: 'instance-x',
    source: 'agent_turn_admission_rejected',
    summary: 'Journaled agent turn rejected before dispatch',
    evidence: 'inbound_seq=65062 reason=pre_dispatch_error automatic_replay=false scope=per_chat',
    severity: 'warning' as const,
    ...(conversationKey === undefined ? {} : { conversationKey }),
  };
}

describe('conversation scope at the bot-errors emission boundary', () => {
  it('projects a raw conversation identifier to a bounded hex digest', () => {
    const event = buildBotErrorsEvent(alertInput(RAW_JID));
    expect(event.conversationScope).toMatch(/^[0-9a-f]{16}$/);
  });

  it('never lets the raw identifier reach the serialized event', () => {
    const event = buildBotErrorsEvent(alertInput(RAW_JID));
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(RAW_JID);
    expect(serialized).not.toContain(RAW_LOCAL);
    expect(serialized).not.toContain('s.whatsapp.net');
  });

  it('is deterministic per conversation and distinct across conversations', () => {
    const a = buildBotErrorsEvent(alertInput(RAW_JID)).conversationScope;
    const again = buildBotErrorsEvent(alertInput(RAW_JID)).conversationScope;
    const b = buildBotErrorsEvent(alertInput(OTHER_JID)).conversationScope;
    expect(a).toBe(again);
    expect(b).not.toBe(a);
  });

  it('omits the field entirely when the emitter has no conversation', () => {
    const event = buildBotErrorsEvent(alertInput());
    expect('conversationScope' in event).toBe(false);
  });

  it('omits the field for a blank conversation identifier', () => {
    const event = buildBotErrorsEvent(alertInput('   '));
    expect('conversationScope' in event).toBe(false);
  });

  it('confineConversationScope returns null for absent input', () => {
    expect(confineConversationScope(undefined)).toBeNull();
    expect(confineConversationScope('')).toBeNull();
    expect(confineConversationScope('  ')).toBeNull();
  });

  it('confineConversationScope never returns any substring of its input', () => {
    const digest = confineConversationScope(RAW_JID);
    expect(digest).not.toBeNull();
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(RAW_JID).not.toContain(digest as string);
  });
});
