import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerProfileTools } from '../../../src/mcp/tools/profile.ts';
import { Database } from '../../../src/core/database.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../../src/transport/connection.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function chatSession(conversationKey: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid: `${conversationKey}@s.whatsapp.net` };
}

function makeMockSock(): WhatsAppSocket {
  return {
    profilePictureUrl: vi.fn().mockResolvedValue('https://example.com/pic.jpg'),
    fetchStatus: vi.fn().mockResolvedValue([{ status: { status: 'Available!' } }]),
    onWhatsApp: vi.fn().mockResolvedValue([{ jid: '111@s.whatsapp.net', exists: true }]),
    updateBlockStatus: vi.fn().mockResolvedValue(undefined),
    updateProfilePicture: vi.fn().mockResolvedValue(undefined),
    removeProfilePicture: vi.fn().mockResolvedValue(undefined),
    updateProfileStatus: vi.fn().mockResolvedValue(undefined),
    updateProfileName: vi.fn().mockResolvedValue(undefined),
    updateLastSeenPrivacy: vi.fn().mockResolvedValue(undefined),
    updateOnlinePrivacy: vi.fn().mockResolvedValue(undefined),
    updateProfilePicturePrivacy: vi.fn().mockResolvedValue(undefined),
    updateStatusPrivacy: vi.fn().mockResolvedValue(undefined),
    updateReadReceiptsPrivacy: vi.fn().mockResolvedValue(undefined),
    updateGroupsAddPrivacy: vi.fn().mockResolvedValue(undefined),
    updateCallPrivacy: vi.fn().mockResolvedValue(undefined),
    updateMessagesPrivacy: vi.fn().mockResolvedValue(undefined),
    updateDisableLinkPreviewsPrivacy: vi.fn().mockResolvedValue(undefined),
    updateDefaultDisappearingMode: vi.fn().mockResolvedValue(undefined),
    fetchPrivacySettings: vi.fn().mockResolvedValue({ lastSeen: 'contacts', online: 'all' }),
    fetchBlocklist: vi.fn().mockResolvedValue(['111@s.whatsapp.net', '222@s.whatsapp.net']),
    addOrEditContact: vi.fn().mockResolvedValue(undefined),
    removeContact: vi.fn().mockResolvedValue(undefined),
    fetchDisappearingDuration: vi.fn().mockResolvedValue({ '111@s.whatsapp.net': 86400 }),
  } as unknown as WhatsAppSocket;
}

describe('profile tools', () => {
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;
  let db: Database;

  beforeEach(() => {
    mockSock = makeMockSock();
    db = makeDb();
    registry = new ToolRegistry();
    registerProfileTools(() => mockSock, db, (tool) => registry.register(tool));
  });

  const globalTools = [
    'get_profile_picture',
    'get_contact_status',
    'check_whatsapp',
    'block_contact',
    'update_profile_picture',
    'remove_profile_picture',
    'update_profile_status',
    'update_profile_name',
    'update_privacy_settings',
    'get_privacy_settings',
    'get_blocklist',
    'add_or_edit_contact',
    'remove_contact',
    'fetch_disappearing_duration',
  ];

  it.each(globalTools)('%s is global-only (not visible in chat-scoped session)', (name) => {
    const tools = registry.listTools(chatSession('111'));
    expect(tools.find((t) => t.name === name)).toBeUndefined();
  });

  it.each(globalTools)('%s is rejected when called from chat-scoped session', async (name) => {
    const params: Record<string, unknown> = { jid: '111@s.whatsapp.net' };
    if (name === 'check_whatsapp') params['phone_numbers'] = ['111'];
    if (name === 'block_contact') params['action'] = 'block';
    if (name === 'update_profile_picture') params['content'] = 'aGVsbG8=';
    if (name === 'update_profile_status') { delete params['jid']; params['status'] = 'hello'; }
    if (name === 'update_profile_name') { delete params['jid']; params['name'] = 'Test'; }
    if (name === 'update_privacy_settings') { delete params['jid']; params['setting'] = 'last_seen'; params['value'] = 'all'; }
    if (name === 'get_privacy_settings') delete params['jid'];
    if (name === 'get_blocklist') delete params['jid'];
    if (name === 'add_or_edit_contact') params['firstName'] = 'Test';
    if (name === 'remove_contact') { /* jid already set */ }
    if (name === 'fetch_disappearing_duration') { delete params['jid']; params['jids'] = ['111@s.whatsapp.net']; }
    const result = await registry.call(name, params, chatSession('111'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
  });

  // --- get_profile_picture ---

  describe('get_profile_picture', () => {
    it('calls sock.profilePictureUrl and returns url', async () => {
      const result = await registry.call(
        'get_profile_picture',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.profilePictureUrl).toHaveBeenCalledWith('111@s.whatsapp.net', 'preview');
      const data = JSON.parse(result.content[0].text) as { url: string };
      expect(data.url).toBe('https://example.com/pic.jpg');
    });

    it('returns null url when profilePictureUrl returns undefined', async () => {
      (mockSock.profilePictureUrl as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const result = await registry.call(
        'get_profile_picture',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { url: null };
      expect(data.url).toBeNull();
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('get_profile_picture', { jid: '111@s.whatsapp.net' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // --- get_contact_status ---

  describe('get_contact_status', () => {
    it('calls sock.fetchStatus and returns status', async () => {
      const result = await registry.call(
        'get_contact_status',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.fetchStatus).toHaveBeenCalledWith('111@s.whatsapp.net');
    });

    it('returns null status when fetchStatus returns empty array', async () => {
      (mockSock.fetchStatus as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const result = await registry.call(
        'get_contact_status',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { status: null };
      expect(data.status).toBeNull();
    });
  });

  // --- check_whatsapp ---

  describe('check_whatsapp', () => {
    it('calls sock.onWhatsApp with phone numbers', async () => {
      const result = await registry.call(
        'check_whatsapp',
        { phone_numbers: ['111', '222'] },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.onWhatsApp).toHaveBeenCalledWith('111', '222');
    });
  });

  // --- block_contact ---

  describe('block_contact', () => {
    it('calls sock.updateBlockStatus with block action', async () => {
      const result = await registry.call(
        'block_contact',
        { jid: '111@s.whatsapp.net', action: 'block' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.updateBlockStatus).toHaveBeenCalledWith('111@s.whatsapp.net', 'block');
    });

    it('calls sock.updateBlockStatus with unblock action', async () => {
      await registry.call(
        'block_contact',
        { jid: '111@s.whatsapp.net', action: 'unblock' },
        globalSession(),
      );
      expect(mockSock.updateBlockStatus).toHaveBeenCalledWith('111@s.whatsapp.net', 'unblock');
    });

    it('rejects invalid action', async () => {
      const result = await registry.call(
        'block_contact',
        { jid: '111@s.whatsapp.net', action: 'invalid' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- update_profile_picture ---

  describe('update_profile_picture', () => {
    it('calls sock.updateProfilePicture with decoded buffer', async () => {
      const content = Buffer.from('fake-image-data').toString('base64');
      const result = await registry.call(
        'update_profile_picture',
        { jid: '111@s.whatsapp.net', content },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const sock = mockSock as any;
      expect(sock.updateProfilePicture).toHaveBeenCalledWith(
        '111@s.whatsapp.net',
        Buffer.from(content, 'base64'),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean };
      expect(data.success).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'update_profile_picture',
        { jid: '111@s.whatsapp.net', content: 'aGVsbG8=' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- remove_profile_picture ---

  describe('remove_profile_picture', () => {
    it('calls sock.removeProfilePicture with jid', async () => {
      const result = await registry.call(
        'remove_profile_picture',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const sock = mockSock as any;
      expect(sock.removeProfilePicture).toHaveBeenCalledWith('111@s.whatsapp.net');
      const data = JSON.parse(result.content[0].text) as { success: boolean };
      expect(data.success).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('remove_profile_picture', { jid: '111@s.whatsapp.net' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // --- update_profile_status ---

  describe('update_profile_status', () => {
    it('calls sock.updateProfileStatus with status text', async () => {
      const result = await registry.call(
        'update_profile_status',
        { status: 'Available for chats' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const sock = mockSock as any;
      expect(sock.updateProfileStatus).toHaveBeenCalledWith('Available for chats');
      const data = JSON.parse(result.content[0].text) as { success: boolean; status: string };
      expect(data.success).toBe(true);
      expect(data.status).toBe('Available for chats');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('update_profile_status', { status: 'hi' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // --- update_profile_name ---

  describe('update_profile_name', () => {
    it('calls sock.updateProfileName with new name', async () => {
      const result = await registry.call(
        'update_profile_name',
        { name: 'Test Bot' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const sock = mockSock as any;
      expect(sock.updateProfileName).toHaveBeenCalledWith('Test Bot');
      const data = JSON.parse(result.content[0].text) as { success: boolean; name: string };
      expect(data.success).toBe(true);
      expect(data.name).toBe('Test Bot');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('update_profile_name', { name: 'X' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // --- update_privacy_settings ---

  describe('update_privacy_settings', () => {
    it('calls correct Baileys method per setting', async () => {
      const result = await registry.call(
        'update_privacy_settings',
        { setting: 'last_seen', value: 'contacts' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const sock = mockSock as any;
      expect(sock.updateLastSeenPrivacy).toHaveBeenCalledWith('contacts');
      const data = JSON.parse(result.content[0].text) as { success: boolean; setting: string; value: string };
      expect(data.success).toBe(true);
      expect(data.setting).toBe('last_seen');
      expect(data.value).toBe('contacts');
    });

    it('dispatches link_previews as boolean', async () => {
      const result = await registry.call(
        'update_privacy_settings',
        { setting: 'link_previews', value: 'true' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).updateDisableLinkPreviewsPrivacy).toHaveBeenCalledWith(true);
    });

    it('dispatches default_disappearing as number', async () => {
      const result = await registry.call(
        'update_privacy_settings',
        { setting: 'default_disappearing', value: '86400' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).updateDefaultDisappearingMode).toHaveBeenCalledWith(86400);
    });

    it('rejects invalid setting enum', async () => {
      const result = await registry.call(
        'update_privacy_settings',
        { setting: 'invalid_setting', value: 'all' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });

    it.each([
      'last_seen', 'online', 'profile_picture', 'status',
      'read_receipts', 'groups_add', 'call', 'messages',
    ] as const)('accepts setting "%s"', async (setting) => {
      const result = await registry.call(
        'update_privacy_settings',
        { setting, value: 'all' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'update_privacy_settings',
        { setting: 'last_seen', value: 'all' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- get_privacy_settings ---

  describe('get_privacy_settings', () => {
    it('calls sock.fetchPrivacySettings and returns settings', async () => {
      const result = await registry.call('get_privacy_settings', {}, globalSession());
      expect(result.isError).toBeUndefined();
      const sock = mockSock as any;
      expect(sock.fetchPrivacySettings).toHaveBeenCalled();
      const data = JSON.parse(result.content[0].text) as { settings: Record<string, string> };
      expect(data.settings).toEqual({ lastSeen: 'contacts', online: 'all' });
    });

    it('returns null settings when fetchPrivacySettings returns undefined', async () => {
      const sock = mockSock as any;
      sock.fetchPrivacySettings.mockResolvedValue(undefined);
      const result = await registry.call('get_privacy_settings', {}, globalSession());
      const data = JSON.parse(result.content[0].text) as { settings: null };
      expect(data.settings).toBeNull();
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('get_privacy_settings', {}, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // --- get_blocklist ---

  describe('get_blocklist', () => {
    it('calls sock.fetchBlocklist and returns list with source=live', async () => {
      const result = await registry.call('get_blocklist', {}, globalSession());
      expect(result.isError).toBeUndefined();
      const sock = mockSock as any;
      expect(sock.fetchBlocklist).toHaveBeenCalled();
      const data = JSON.parse(result.content[0].text) as { blocklist: string[]; source: string };
      expect(data.blocklist).toEqual(['111@s.whatsapp.net', '222@s.whatsapp.net']);
      expect(data.source).toBe('live');
    });

    it('returns empty array when fetchBlocklist returns undefined', async () => {
      const sock = mockSock as any;
      sock.fetchBlocklist.mockResolvedValue(undefined);
      const result = await registry.call('get_blocklist', {}, globalSession());
      const data = JSON.parse(result.content[0].text) as { blocklist: string[]; source: string };
      expect(data.blocklist).toEqual([]);
      expect(data.source).toBe('live');
    });

    it('falls back to DB when sock is null and returns cached data', async () => {
      // Seed blocklist table with known entries
      db.raw.prepare(`INSERT INTO blocklist (jid) VALUES (?)`).run('cached1@s.whatsapp.net');
      db.raw.prepare(`INSERT INTO blocklist (jid) VALUES (?)`).run('cached2@s.whatsapp.net');

      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('get_blocklist', {}, globalSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { blocklist: string[]; source: string };
      expect(data.source).toBe('cached');
      expect(data.blocklist).toContain('cached1@s.whatsapp.net');
      expect(data.blocklist).toContain('cached2@s.whatsapp.net');
    });

    it('falls back to DB (empty) when sock is null and blocklist table is empty', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('get_blocklist', {}, globalSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { blocklist: string[]; source: string };
      expect(data.source).toBe('cached');
      expect(data.blocklist).toEqual([]);
    });
  });

  // --- add_or_edit_contact ---

  describe('add_or_edit_contact', () => {
    it('calls sock.addOrEditContact with jid and contact fields', async () => {
      const result = await registry.call(
        'add_or_edit_contact',
        { jid: '111@s.whatsapp.net', firstName: 'Alice', lastName: 'Smith', company: 'ACME' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const sock = mockSock as any;
      expect(sock.addOrEditContact).toHaveBeenCalledWith('111@s.whatsapp.net', {
        firstName: 'Alice',
        lastName: 'Smith',
        company: 'ACME',
      });
      const data = JSON.parse(result.content[0].text) as { success: boolean };
      expect(data.success).toBe(true);
    });

    it('omits undefined optional fields from contactAction', async () => {
      await registry.call(
        'add_or_edit_contact',
        { jid: '111@s.whatsapp.net', firstName: 'Bob' },
        globalSession(),
      );
      const sock = mockSock as any;
      expect(sock.addOrEditContact).toHaveBeenCalledWith('111@s.whatsapp.net', { firstName: 'Bob' });
    });

    it('passes phone field when provided', async () => {
      await registry.call(
        'add_or_edit_contact',
        { jid: '111@s.whatsapp.net', phone: '+1234567890' },
        globalSession(),
      );
      const sock = mockSock as any;
      expect(sock.addOrEditContact).toHaveBeenCalledWith('111@s.whatsapp.net', { phone: '+1234567890' });
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('add_or_edit_contact', { jid: '111@s.whatsapp.net' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // --- remove_contact ---

  describe('remove_contact', () => {
    it('calls sock.removeContact with jid', async () => {
      const result = await registry.call(
        'remove_contact',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const sock = mockSock as any;
      expect(sock.removeContact).toHaveBeenCalledWith('111@s.whatsapp.net');
      const data = JSON.parse(result.content[0].text) as { success: boolean };
      expect(data.success).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('remove_contact', { jid: '111@s.whatsapp.net' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // --- fetch_disappearing_duration ---

  describe('fetch_disappearing_duration', () => {
    it('calls sock.fetchDisappearingDuration with spread jids', async () => {
      const result = await registry.call(
        'fetch_disappearing_duration',
        { jids: ['111@s.whatsapp.net', '222@s.whatsapp.net'] },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const sock = mockSock as any;
      expect(sock.fetchDisappearingDuration).toHaveBeenCalledWith(
        '111@s.whatsapp.net',
        '222@s.whatsapp.net',
      );
      const data = JSON.parse(result.content[0].text) as { result: Record<string, number> };
      expect(data.result).toEqual({ '111@s.whatsapp.net': 86400 });
    });

    it('rejects empty jids array', async () => {
      const result = await registry.call(
        'fetch_disappearing_duration',
        { jids: [] },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });

    it('returns null when fetchDisappearingDuration returns undefined', async () => {
      const sock = mockSock as any;
      sock.fetchDisappearingDuration.mockResolvedValue(undefined);
      const result = await registry.call(
        'fetch_disappearing_duration',
        { jids: ['111@s.whatsapp.net'] },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { result: null };
      expect(data.result).toBeNull();
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, db, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'fetch_disappearing_duration',
        { jids: ['111@s.whatsapp.net'] },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });
});
