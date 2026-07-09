import { describe, it, expect } from 'vitest';
import { parsePinoLine } from '../../src/fleet/routes/feed.ts';

// Best-effort cross-bot visibility for PR-G. The in-bot seam counter
// (connection.ts) is authoritative; these fleet-feed parser extensions give the
// aggregator cross-bot signal. Task 5 = parse the non-text "Sending media" line
// (the feed was text-only before, blind to media floods). Task 4 = recognize
// PR-E/PR-F prevention WARN logs so a *prevented* flood still surfaces.

function makeLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ level: 30, time: 1700000000000, ...fields });
}

const ctx = { instanceName: 'operator-agent', instanceType: 'agent' as const };

describe('parsePinoLine — media outbound parse (Task 5, G1)', () => {
  it('parses "Sending media" as an outbound message event with conversationKey + contentType', () => {
    const line = makeLine({ msg: 'Sending media', chatJid: '15551239999@s.whatsapp.net', mediaType: 'image' });
    const ev = parsePinoLine(line, ctx);
    expect(ev?.detail).toMatchObject({
      type: 'message',
      direction: 'outbound',
      chatJid: '15551239999@s.whatsapp.net',
      conversationKey: '15551239999',
      contentType: 'image',
    });
  });

  it('still parses "Sending message" as an outbound text event (regression)', () => {
    const line = makeLine({ msg: 'Sending message', chatJid: '15551239999@s.whatsapp.net', messageId: 'wamid.1' });
    const ev = parsePinoLine(line, ctx);
    expect(ev?.detail).toMatchObject({
      type: 'message',
      direction: 'outbound',
      conversationKey: '15551239999',
      messageId: 'wamid.1',
    });
  });
});

describe('parsePinoLine — E/F prevention-log escalation (Task 4)', () => {
  it('recognizes a PR-F ceiling-exceeded WARN as an outbound_flood_signal', () => {
    const line = makeLine({ level: 40, msg: 'outbound governor ceiling exceeded', chatJid: '15551239999@s.whatsapp.net', count: 25 });
    const ev = parsePinoLine(line, ctx);
    expect(ev?.detail).toMatchObject({ type: 'outbound_flood_signal', conversationKey: '15551239999', count: 25 });
    expect(ev?.isError).toBe(true); // warn-level → surfaced, not suppressed
  });

  it('recognizes a PR-E flood-guard WARN as an outbound_flood_signal', () => {
    const line = makeLine({ level: 40, msg: 'outbound flood-guard tripped', chatJid: '15551239999@s.whatsapp.net' });
    const ev = parsePinoLine(line, ctx);
    expect(ev?.detail?.type).toBe('outbound_flood_signal');
    expect((ev?.detail as { signal?: string }).signal).toContain('flood-guard');
  });

  it('does not misclassify an ordinary outbound send as a flood signal', () => {
    const line = makeLine({ msg: 'Sending message', chatJid: '15551239999@s.whatsapp.net' });
    const ev = parsePinoLine(line, ctx);
    expect(ev?.detail?.type).toBe('message');
  });
});
