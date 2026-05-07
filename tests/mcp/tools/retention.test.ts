import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../../src/config.ts';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerRetentionTools } from '../../../src/mcp/tools/retention.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function chatSession(conversationKey: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid: `${conversationKey}@s.whatsapp.net` };
}

function setAgeHours(path: string, ageHours: number): void {
  const past = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  utimesSync(path, past, past);
}

describe('retention tools', () => {
  let registry: ToolRegistry;
  let db: Database;
  let tempRoot: string;
  let originalMediaDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'whatsoup-retention-'));
    mkdirSync(join(tempRoot, 'tmp'), { recursive: true });
    mkdirSync(join(tempRoot, 'cache'), { recursive: true });

    originalMediaDir = config.mediaDir;
    (config as { mediaDir: string }).mediaDir = join(tempRoot, 'tmp');

    registry = new ToolRegistry();
    db = new Database(':memory:');
    db.open();
    registerRetentionTools(registry, { db });
  });

  afterEach(() => {
    (config as { mediaDir: string }).mediaDir = originalMediaDir;
    db.raw.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('cleanup_media is global-only', () => {
    const tools = registry.listTools(chatSession('111'));
    expect(tools.find((tool) => tool.name === 'cleanup_media')).toBeUndefined();
  });

  it('dry_run reports expired files without deleting or nullifying media_path', async () => {
    const filePath = join(tempRoot, 'tmp', 'stale.jpg');
    writeFileSync(filePath, Buffer.from('stale-file'));
    setAgeHours(filePath, 96);

    db.raw.prepare(`
      INSERT INTO messages (
        chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, media_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '111@s.whatsapp.net',
      '111',
      '111@s.whatsapp.net',
      'msg-1',
      'image',
      0,
      1_700_000_000,
      filePath,
    );

    const result = await registry.call('cleanup_media', { dry_run: true }, globalSession());
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as {
      deleted: number;
      bytes_freed: number;
      dry_run: boolean;
    };

    expect(body.dry_run).toBe(true);
    expect(body.deleted).toBe(1);
    expect(body.bytes_freed).toBe(statSync(filePath).size);
    expect(existsSync(filePath)).toBe(true);

    const row = db.raw
      .prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get('msg-1') as { media_path: string | null };
    expect(row.media_path).toBe(filePath);
  });

  it('deletes expired files and nullifies matching media_path rows', async () => {
    const filePath = join(tempRoot, 'tmp', 'old.ogg');
    writeFileSync(filePath, Buffer.from('very old voice note'));
    setAgeHours(filePath, 80);

    db.raw.prepare(`
      INSERT INTO messages (
        chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, media_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '111@s.whatsapp.net',
      '111',
      '111@s.whatsapp.net',
      'msg-2',
      'audio',
      0,
      1_700_000_001,
      filePath,
    );

    const result = await registry.call('cleanup_media', {}, globalSession());
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as {
      deleted: number;
      skipped: number;
      bytes_freed: number;
      dry_run: boolean;
    };

    expect(body.dry_run).toBe(false);
    expect(body.deleted).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.bytes_freed).toBeGreaterThan(0);
    expect(existsSync(filePath)).toBe(false);

    const row = db.raw
      .prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get('msg-2') as { media_path: string | null };
    expect(row).toEqual({ media_path: null });
  });

  it('respects max_age_hours override and leaves newer files untouched', async () => {
    const filePath = join(tempRoot, 'tmp', 'recent.mp4');
    writeFileSync(filePath, Buffer.from('fresh'));
    setAgeHours(filePath, 2);

    const result = await registry.call('cleanup_media', { max_age_hours: 4 }, globalSession());
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as { deleted: number; dry_run: boolean };

    expect(body.deleted).toBe(0);
    expect(body.dry_run).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });
});
