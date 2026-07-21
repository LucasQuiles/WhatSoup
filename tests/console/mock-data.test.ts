import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockDataModule = typeof import('../../console/src/mock-data.ts');

async function loadMockData(): Promise<MockDataModule> {
  vi.resetModules();
  return import('../../console/src/mock-data.ts');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-14T12:34:56.000Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('console mock data accessors', () => {
  it('exposes cloned line snapshots with all console status and mode families', async () => {
    const { MOCK_LINES, getLine, getLines } = await loadMockData();

    const lines = getLines();
    expect(lines).toHaveLength(10);
    expect(lines.map((line) => line.name)).toEqual([
      'personal',
      'support',
      'research',
      'devops',
      'sales',
      'intern',
      'staging',
      'archive',
      'signal-relay',
      'imessage-bridge',
    ]);
    expect(new Set(lines.map((line) => line.mode))).toEqual(new Set(['passive', 'chat', 'agent']));
    expect(new Set(lines.map((line) => line.status))).toEqual(new Set(['online', 'degraded', 'unreachable']));
    expect(new Set(lines.map((line) => line.provider))).toEqual(new Set(['claude-cli', 'anthropic-api', 'codex-cli']));

    expect(lines[0]).not.toBe(MOCK_LINES[0]);
    expect(getLine('support')).toMatchObject({
      name: 'support',
      mode: 'chat',
      provider: 'anthropic-api',
      status: 'online',
      queueDepth: 3,
    });
    expect(getLine('archive')?.heartbeat).toEqual(Array.from({ length: 20 }, () => 'up'));
    expect(getLine('missing-line')).toBeUndefined();
  });

  it('returns read-path collections and empty fallbacks for unknown keys', async () => {
    const {
      getAccess,
      getChats,
      getFeed,
      getGroupDetail,
      getGroups,
      getLogs,
      getMessages,
      getScheduled,
      getTyping,
    } = await loadMockData();

    const supportChats = getChats('support');
    expect(supportChats.length).toBeGreaterThanOrEqual(5);
    expect(getChats('unknown')).toEqual([]);

    expect(getMessages('support', 'support-alexc').map((message) => message.conversationKey)).toContain('support-alexc');
    expect(getMessages('support', 'missing-conversation')).toEqual([]);

    expect(getAccess('research').some((entry) => entry.status === 'blocked')).toBe(true);
    expect(getAccess('missing')).toEqual([]);

    expect(getLogs('sales')[0]).toMatchObject({ level: 'warn', component: 'enrichment' });
    expect(getLogs('missing')).toEqual([]);

    expect(getScheduled('support')).toMatchObject({ count: 4 });
    expect(getScheduled('archive')).toEqual({ count: 0, messages: [] });

    expect(getGroups('support').groups.length).toBeGreaterThan(0);
    expect(getGroups('missing')).toEqual({ groups: [] });

    const groupDetail = getGroupDetail('support', getGroups('support').groups[0]!.id);
    expect(groupDetail).toMatchObject({
      memberAddMode: 'all_member_add',
      joinApprovalMode: 'off',
      pendingRequests: [],
    });
    expect(groupDetail?.inviteLink).toMatch(/^https:\/\/chat\.whatsapp\.com\/mock/);
    expect(getGroupDetail('support', 'missing@g.us')).toBeUndefined();
    expect(getGroupDetail('missing', 'missing@g.us')).toBeUndefined();

    const feedTypes = new Set(getFeed().map((event) => event.detail?.type));
    expect(feedTypes).toEqual(new Set(['message', 'tool_use', 'session', 'health', 'connection', 'tool_error', 'import', 'generic']));
    expect(new Set(getFeed().map((event) => event.provider))).toEqual(new Set(['anthropic-api', 'claude-cli', 'codex-cli']));

    expect(getTyping()).toEqual([
      { instance: 'support', jid: '15550110@s.whatsapp.net', since: Date.now() - 4000 },
      { instance: 'personal', jid: '15550202@s.whatsapp.net', since: Date.now() - 1500 },
    ]);
  });

  it('searches contacts by name, notify alias, number, jid, and empty query', async () => {
    const { searchContacts } = await loadMockData();

    expect(searchContacts('support', '').contacts.length).toBeGreaterThanOrEqual(10);
    expect(searchContacts('support', 'fatima').contacts).toEqual([
      expect.objectContaining({ name: 'Fatima Al-Rashid' }),
    ]);
    expect(searchContacts('support', 'Wei').contacts).toEqual([
      expect.objectContaining({ notify: 'Wei' }),
    ]);
    expect(searchContacts('support', '15550128').contacts).toEqual([
      expect.objectContaining({ number: '15550128' }),
    ]);
    expect(searchContacts('support', '15550133@s.whatsapp.net').contacts).toEqual([
      expect.objectContaining({ jid: '15550133@s.whatsapp.net' }),
    ]);
    expect(searchContacts('support', 'no-match').contacts).toEqual([]);
    expect(searchContacts('missing', 'anything')).toEqual({ contacts: [] });
  });
});

describe('console mock metric generators', () => {
  it.each([
    ['personal', '24h', 24, false, false, ['claude-cli']],
    ['support', '7d', 7, true, false, ['anthropic-api']],
    ['research', '30d', 30, true, true, ['claude-cli']],
    ['unknown-line', '24h', 24, false, false, ['claude-cli']],
  ] as const)(
    'generates line metrics for %s over %s',
    async (name, range, bucketCount, hasTokenData, hasSessionData, providers) => {
      const { generateMetrics, getMetrics } = await loadMockData();

      const metrics = generateMetrics(name, range);
      expect(getMetrics(name, range)).toMatchObject({
        range,
        hasTokenData,
        hasSessionData,
        providers,
      });
      expect(metrics.range).toBe(range);
      expect(metrics.messageVolume).toHaveLength(bucketCount);
      expect(metrics.tokenUsage).toHaveLength(bucketCount);
      expect(metrics.sessionActivity).toHaveLength(bucketCount);
      expect(metrics.activeHours).toHaveLength(7);
      expect(metrics.activeHours.every((day) => day.length === 24)).toBe(true);
      expect(metrics.activeHoursByDate).toHaveLength(30);
      expect(metrics.hasMessageData).toBe(true);
      expect(metrics.hasTokenData).toBe(hasTokenData);
      expect(metrics.hasSessionData).toBe(hasSessionData);
      expect(metrics.providers).toEqual(providers);
      expect(Object.keys(metrics.tokenUsageByProvider)).toEqual(hasTokenData ? providers : []);
      expect(Object.keys(metrics.sessionActivityByProvider)).toEqual(hasSessionData ? providers : []);
      expect(metrics.messageVolume.every((bucket) => bucket.inbound >= 0 && bucket.outbound >= 0 && bucket.media >= 0)).toBe(true);
    },
  );

  it.each([
    ['24h', 24],
    ['7d', 7],
    ['30d', 30],
  ] as const)('generates aggregate fleet metrics for %s', async (range, bucketCount) => {
    const { generateFleetMetrics, getFleetMetrics } = await loadMockData();

    const metrics = generateFleetMetrics(range);
    expect(getFleetMetrics(range)).toMatchObject({
      range,
      meta: {
        instancesQueried: 8,
        instancesFailed: 1,
        hasMessageData: true,
        hasTokenData: true,
        hasSessionData: true,
        providers: ['claude-cli', 'anthropic-api', 'codex-cli'],
      },
    });
    expect(metrics.messageVolume).toHaveLength(bucketCount);
    expect(metrics.tokenUsage).toHaveLength(bucketCount);
    expect(metrics.sessionActivity).toHaveLength(bucketCount);
    expect(Object.keys(metrics.tokenUsageByProvider).sort()).toEqual(['anthropic-api', 'claude-cli', 'codex-cli']);
    expect(Object.keys(metrics.sessionActivityByProvider).sort()).toEqual(['claude-cli', 'codex-cli']);
    expect(metrics.messageVolume.every((bucket) => bucket.inbound >= bucket.media)).toBe(true);
  });

  it('generates aggregate fleet metrics when no lines emit token or session data', async () => {
    const { generateFleetMetrics } = await loadMockData();

    const metrics = generateFleetMetrics('24h', {
      passiveOnly: {
        provider: 'claude-cli',
        mode: 'passive',
        msgScale: 3,
        tokenInputScale: 0,
        sessionScale: 0,
      },
    });

    expect(metrics.meta).toMatchObject({
      instancesQueried: 1,
      hasMessageData: true,
      hasTokenData: false,
      hasSessionData: false,
      providers: ['claude-cli', 'anthropic-api', 'codex-cli'],
    });
    expect(metrics.tokenUsage).toEqual(metrics.messageVolume.map((bucket) => ({
      bucket: bucket.bucket,
      input: 0,
      output: 0,
    })));
    expect(metrics.sessionActivity).toEqual(metrics.messageVolume.map((bucket) => ({
      bucket: bucket.bucket,
      started: 0,
      active: 0,
    })));
    expect(metrics.tokenUsageByProvider).toEqual({});
    expect(metrics.sessionActivityByProvider).toEqual({});
  });
});
