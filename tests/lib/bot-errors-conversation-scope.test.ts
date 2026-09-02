import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBotErrorsEvent } from '../../src/lib/bot-errors-outbox.ts';
import { emitAlertChecked } from '../../src/lib/emit-alert.ts';
import { confineAlertContent, confineConversationScope } from '../../src/lib/alert-evidence.ts';

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

  // The docstring claims domain separation keeps a conversation digest from
  // colliding with an evidence or summary digest of the same bytes. Nothing
  // pinned that: swapping the salt to 'evidence' left the whole suite green.
  it('separates the conversation domain from the evidence and summary domains', () => {
    const conversation = confineConversationScope(RAW_JID) as string;
    const asEvidence = confineAlertContent('evidence', RAW_JID).correlationDigest;
    const asSummary = confineAlertContent('summary', RAW_JID).correlationDigest;

    // Same input bytes, three domains, three distinct digests. Compared over
    // the conversation digest's own width, since it is the truncated one.
    const width = conversation.length;
    expect(asEvidence.slice(0, width)).not.toBe(conversation);
    expect(asSummary.slice(0, width)).not.toBe(conversation);
    expect(asEvidence).not.toBe(asSummary);
  });
});

// The tests above exercise the event builder directly. This one crosses the
// path production actually uses — emitAlertChecked -> emitAlert -> the event
// written to the queue — so a slip in the argument forwarding between them
// cannot pass unnoticed.
describe('conversation scope survives the real emission path', () => {
  let dir: string | null = null;

  afterEach(() => {
    delete process.env['WHATSOUP_ALERT_SINK'];
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function emittedEvent(conversationKey?: string): Record<string, unknown> {
    dir = mkdtempSync(join(tmpdir(), 'q3-alert-sink-'));
    const sink = join(dir, 'alerts.jsonl');
    process.env['WHATSOUP_ALERT_SINK'] = sink;
    emitAlertChecked(
      'instance-x',
      'agent_turn_admission_rejected',
      'Journaled agent turn rejected before dispatch',
      'inbound_seq=65062 reason=pre_dispatch_error automatic_replay=false scope=per_chat',
      'warning',
      undefined,
      undefined,
      conversationKey === undefined ? undefined : { conversationKey },
    );
    const lines = readFileSync(sink, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] as string) as Record<string, unknown>;
  }

  it('forwards the conversation from emitAlertChecked to the emitted event', () => {
    const event = emittedEvent(RAW_JID);
    expect(event['conversationScope']).toBe(confineConversationScope(RAW_JID));
    expect(event['conversationScope']).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the raw identifier out of the emitted event on that path', () => {
    const serialized = JSON.stringify(emittedEvent(RAW_JID));
    expect(serialized).not.toContain(RAW_JID);
    expect(serialized).not.toContain(RAW_LOCAL);
    expect(serialized).not.toContain('s.whatsapp.net');
  });

  it('emits the unchanged shape when no conversation is named', () => {
    expect('conversationScope' in emittedEvent()).toBe(false);
  });
});
