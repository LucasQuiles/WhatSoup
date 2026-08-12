/**
 * Backfill manifest generator — READ-ONLY, produces the reviewer-confirmed
 * approval artifact. Every ineligible entry is REPORTED with a reason (never
 * silently dropped); the manifest digest is deterministic and binds to the
 * eligible set. No insert path exists here (backfill creation + drains are
 * separately owner-gated). Real SQLite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCapabilityContract } from '../../src/core/capability-contract.ts';
import { Database } from '../../src/core/database.ts';
import {
  generateBackfillManifest,
  type BackfillReadDb,
} from '../../scripts/capability-obligation-backfill-manifest.ts';

let db: Database;

const CONTRACT = parseCapabilityContract({
  version: 'test-instance/1',
  rules: [
    { id: 'watch-url', kind: 'url_host', hosts: ['youtu.be'], capability: 'child_process_tools' },
    { id: 'watch-video', kind: 'media_class', mediaClass: 'video', capability: 'child_process_tools' },
  ],
});

function seedInbound(seq: number, messageId: string, chatJid: string): void {
  db.raw
    .prepare(
      `INSERT INTO inbound_events (seq, message_id, conversation_key, chat_jid, routed_to)
       VALUES (?, ?, ?, ?, 'agent')`,
    )
    .run(seq, messageId, `conv-${seq}`, chatJid);
}

function seedMessage(messageId: string, chatJid: string, content: string | null, mediaPath: string | null, fromMe = 0): void {
  db.raw
    .prepare(
      `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, media_path, is_from_me, timestamp)
       VALUES (?, ?, 'test-sender@s.whatsapp.net', ?, ?, ?, ?, 1000)`,
    )
    .run(chatJid, `conv-x`, messageId, content, mediaPath, fromMe);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
});

afterEach(() => {
  db.close();
});

function run(confirmed: Array<{ sourceInboundSeq: number; sourceMessageId: string; mediaClass?: string | null }>) {
  return generateBackfillManifest(db.raw as unknown as BackfillReadDb, {
    manifestId: 'MANIFEST-1',
    contract: CONTRACT,
    confirmed,
  });
}

describe('generateBackfillManifest', () => {
  it('emits eligible descriptors for a URL and a media inbound, reporting group scope', () => {
    seedInbound(7761, 'MW-7761', 'test-dm@lid');
    seedMessage('MW-7761', 'test-dm@lid', 'check this https://youtu.be/abc', null);
    seedInbound(7799, 'GRP-7799', 'test-group@g.us');
    seedMessage('GRP-7799', 'test-group@g.us', 'Weekly clip', '/media/clip.webm');

    const m = run([
      { sourceInboundSeq: 7761, sourceMessageId: 'MW-7761' },
      { sourceInboundSeq: 7799, sourceMessageId: 'GRP-7799', mediaClass: 'video' },
    ]);
    expect(m.eligibleCount).toBe(2);
    const url = m.entries.find((e) => e.sourceInboundSeq === 7761)!;
    expect(url).toMatchObject({ eligible: true, requiredCapability: 'child_process_tools', isGroup: false, mediaPresent: false });
    const media = m.entries.find((e) => e.sourceInboundSeq === 7799)!;
    expect(media).toMatchObject({ eligible: true, isGroup: true, mediaPresent: true });
    expect(m.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('REPORTS ineligible entries with reasons — never silently drops', () => {
    seedInbound(1, 'M1', 'test-dm@lid');
    seedMessage('M1', 'test-dm@lid', 'just a hello, no capability', null); // contract no_match
    seedInbound(2, 'M2', 'test-dm@lid');
    seedMessage('M2', 'test-dm@lid', 'https://youtu.be/x', null, /* fromMe */ 1); // outbound
    seedInbound(3, 'M3', 'test-dm@lid'); // inbound present, message absent

    const m = run([
      { sourceInboundSeq: 1, sourceMessageId: 'M1' },
      { sourceInboundSeq: 2, sourceMessageId: 'M2' },
      { sourceInboundSeq: 3, sourceMessageId: 'M3' },
      { sourceInboundSeq: 999, sourceMessageId: 'MISSING' }, // inbound absent
      { sourceInboundSeq: 1, sourceMessageId: 'WRONG-ID' }, // id mismatch
    ]);
    expect(m.eligibleCount).toBe(0);
    const reasons = Object.fromEntries(m.entries.map((e) => [`${e.sourceInboundSeq}:${e.sourceMessageId}`, e.reason]));
    expect(reasons['1:M1']).toBe('contract_no_match');
    expect(reasons['2:M2']).toBe('message_is_outbound');
    expect(reasons['3:M3']).toBe('message_not_found');
    expect(reasons['999:MISSING']).toBe('inbound_not_found');
    expect(reasons['1:WRONG-ID']).toBe('inbound_message_id_mismatch');
    // every confirmed entry is represented (nothing dropped)
    expect(m.entries).toHaveLength(5);
  });

  it('the digest is deterministic, order-independent over eligible entries, and binds the manifest id', () => {
    seedInbound(10, 'A', 'test-dm@lid');
    seedMessage('A', 'test-dm@lid', 'https://youtu.be/a', null);
    seedInbound(11, 'B', 'test-dm@lid');
    seedMessage('B', 'test-dm@lid', 'https://youtu.be/b', null);

    const d1 = run([{ sourceInboundSeq: 10, sourceMessageId: 'A' }, { sourceInboundSeq: 11, sourceMessageId: 'B' }]).manifestDigest;
    const d2 = run([{ sourceInboundSeq: 11, sourceMessageId: 'B' }, { sourceInboundSeq: 10, sourceMessageId: 'A' }]).manifestDigest;
    expect(d2).toBe(d1); // order-independent

    const other = generateBackfillManifest(db.raw as unknown as BackfillReadDb, {
      manifestId: 'MANIFEST-2',
      contract: CONTRACT,
      confirmed: [{ sourceInboundSeq: 10, sourceMessageId: 'A' }, { sourceInboundSeq: 11, sourceMessageId: 'B' }],
    }).manifestDigest;
    expect(other).not.toBe(d1); // a different manifest id yields a different digest
  });
});
