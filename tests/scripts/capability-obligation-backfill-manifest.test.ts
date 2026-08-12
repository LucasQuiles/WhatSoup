/**
 * Backfill manifest generator — READ-ONLY approval artifact. The digest binds
 * DESTINATION (conversationKey/deliveryJid/isGroup) + SOURCE identity
 * (sourceDigest + token/media hash) so an approval can never be reused for a
 * different destination or a swapped source; every ineligible entry is reported
 * with a reason; and a reviewer capability override makes historical audio
 * (incident-7795 shape, excluded from the contract by construction) eligible.
 * Real SQLite + real media files.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCapabilityContract } from '../../src/core/capability-contract.ts';
import { Database } from '../../src/core/database.ts';
import {
  generateBackfillManifest,
  type BackfillConfirmedEntry,
  type BackfillReadDb,
} from '../../scripts/capability-obligation-backfill-manifest.ts';

let db: Database;
let work: string;

const CONTRACT = parseCapabilityContract({
  version: 'test-instance/1',
  rules: [
    { id: 'watch-url', kind: 'url_host', hosts: ['youtu.be'], capability: 'child_process_tools' },
    { id: 'watch-video', kind: 'media_class', mediaClass: 'video', capability: 'child_process_tools' },
  ],
});

function seedInbound(seq: number, messageId: string, chatJid: string): void {
  db.raw
    .prepare(`INSERT INTO inbound_events (seq, message_id, conversation_key, chat_jid, routed_to) VALUES (?, ?, ?, ?, 'agent')`)
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

function mediaFile(name: string, bytes: string): string {
  const p = join(work, name);
  writeFileSync(p, bytes);
  return p;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  work = mkdtempSync(join(tmpdir(), 'backfill-'));
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

function run(confirmed: BackfillConfirmedEntry[], manifestId = 'MANIFEST-1') {
  return generateBackfillManifest(db.raw as unknown as BackfillReadDb, { manifestId, contract: CONTRACT, confirmed });
}

describe('generateBackfillManifest — eligibility', () => {
  it('URL (contract), media video (contract), and audio (reviewer override) are all eligible', () => {
    seedInbound(7761, 'MW-7761', 'test-dm@lid');
    seedMessage('MW-7761', 'test-dm@lid', 'check this https://youtu.be/abc', null);

    const videoBytes = 'VIDEO-BYTES-xyz';
    seedInbound(7799, 'GRP-7799', 'test-group@g.us');
    seedMessage('GRP-7799', 'test-group@g.us', 'Weekly clip', mediaFile('clip.webm', videoBytes));

    const audioBytes = 'AUDIO-OGG-BYTES';
    seedInbound(7795, 'GRP-7795', 'test-group2@g.us');
    seedMessage('GRP-7795', 'test-group2@g.us', '', mediaFile('voice.ogg', audioBytes));

    const m = run([
      { sourceInboundSeq: 7761, sourceMessageId: 'MW-7761' },
      { sourceInboundSeq: 7799, sourceMessageId: 'GRP-7799', mediaClass: 'video' },
      // audio: contract cannot classify it — reviewer supplies the capability.
      { sourceInboundSeq: 7795, sourceMessageId: 'GRP-7795', reviewerCapability: 'child_process_tools' },
    ]);
    expect(m.eligibleCount).toBe(3);
    const url = m.entries.find((e) => e.sourceInboundSeq === 7761)!;
    expect(url).toMatchObject({ eligible: true, classifiedBy: 'contract', sourceToken: 'https://youtu.be/abc', mediaSha256: null });
    expect(url.sourceDigest).toBe(createHash('sha256').update('https://youtu.be/abc').digest('hex'));
    const video = m.entries.find((e) => e.sourceInboundSeq === 7799)!;
    expect(video).toMatchObject({ eligible: true, classifiedBy: 'contract', isGroup: true });
    expect(video.sourceDigest).toBe(createHash('sha256').update(videoBytes).digest('hex'));
    const audio = m.entries.find((e) => e.sourceInboundSeq === 7795)!;
    expect(audio).toMatchObject({ eligible: true, classifiedBy: 'reviewer', requiredCapability: 'child_process_tools', isGroup: true });
    expect(audio.sourceDigest).toBe(createHash('sha256').update(audioBytes).digest('hex'));
  });

  it('audio WITHOUT a reviewer override is contract_no_match (excluded by construction)', () => {
    seedInbound(1, 'A1', 'test-group@g.us');
    seedMessage('A1', 'test-group@g.us', '', mediaFile('voice.ogg', 'x'));
    const m = run([{ sourceInboundSeq: 1, sourceMessageId: 'A1', mediaClass: 'audio' }]);
    expect(m.entries[0]).toMatchObject({ eligible: false, reason: 'contract_no_match' });
  });

  it('reports ineligible entries with reasons (outbound, missing, mismatch, media-unavailable, override-needs-media)', () => {
    seedInbound(1, 'M1', 'test-dm@lid');
    seedMessage('M1', 'test-dm@lid', 'https://youtu.be/x', null, /* fromMe */ 1);
    seedInbound(2, 'M2', 'test-dm@lid'); // message absent
    seedInbound(3, 'M3', 'test-dm@lid');
    seedMessage('M3', 'test-dm@lid', 'clip', '/nonexistent/path.webm'); // media file missing
    seedInbound(4, 'M4', 'test-dm@lid');
    seedMessage('M4', 'test-dm@lid', 'plain text no media', null); // reviewer override but no media

    const m = run([
      { sourceInboundSeq: 1, sourceMessageId: 'M1' },
      { sourceInboundSeq: 2, sourceMessageId: 'M2' },
      { sourceInboundSeq: 3, sourceMessageId: 'M3', mediaClass: 'video' },
      { sourceInboundSeq: 4, sourceMessageId: 'M4', reviewerCapability: 'child_process_tools' },
      { sourceInboundSeq: 999, sourceMessageId: 'X' },
    ]);
    const r = Object.fromEntries(m.entries.map((e) => [e.sourceInboundSeq, e.reason]));
    expect(r[1]).toBe('message_is_outbound');
    expect(r[2]).toBe('message_not_found');
    expect(r[3]).toBe('media_unavailable');
    expect(r[4]).toBe('reviewer_override_requires_media');
    expect(r[999]).toBe('inbound_not_found');
    expect(m.entries).toHaveLength(5); // nothing dropped
  });
});

describe('generateBackfillManifest — digest binding', () => {
  it('FALSIFIER: changing an eligible destination from DM to group CHANGES the digest', () => {
    seedInbound(10, 'A', 'test-dm@lid');
    seedMessage('A', 'test-dm@lid', 'https://youtu.be/a', null);
    const dmDigest = run([{ sourceInboundSeq: 10, sourceMessageId: 'A' }]).manifestDigest;

    // Re-seed the SAME source at a GROUP destination.
    db.raw.prepare('DELETE FROM inbound_events WHERE seq = 10').run();
    db.raw.prepare("DELETE FROM messages WHERE message_id = 'A'").run();
    seedInbound(10, 'A', 'test-group@g.us');
    seedMessage('A', 'test-group@g.us', 'https://youtu.be/a', null);
    const groupDigest = run([{ sourceInboundSeq: 10, sourceMessageId: 'A' }]).manifestDigest;

    expect(groupDigest).not.toBe(dmDigest);
  });

  it('is order-independent over eligible entries and binds the manifest id', () => {
    seedInbound(10, 'A', 'test-dm@lid');
    seedMessage('A', 'test-dm@lid', 'https://youtu.be/a', null);
    seedInbound(11, 'B', 'test-dm@lid');
    seedMessage('B', 'test-dm@lid', 'https://youtu.be/b', null);
    const d1 = run([{ sourceInboundSeq: 10, sourceMessageId: 'A' }, { sourceInboundSeq: 11, sourceMessageId: 'B' }]).manifestDigest;
    const d2 = run([{ sourceInboundSeq: 11, sourceMessageId: 'B' }, { sourceInboundSeq: 10, sourceMessageId: 'A' }]).manifestDigest;
    expect(d2).toBe(d1);
    const other = run([{ sourceInboundSeq: 10, sourceMessageId: 'A' }, { sourceInboundSeq: 11, sourceMessageId: 'B' }], 'MANIFEST-2').manifestDigest;
    expect(other).not.toBe(d1);
  });
});
