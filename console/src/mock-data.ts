// ---------------------------------------------------------------------------
//  WhatSoup Console — Mock Data
//  Deterministic sample data for documentation screenshots and demos.
//  All phone numbers use +1 555-01xx range. All names are fictional.
// ---------------------------------------------------------------------------

import type {
  Mode,
  LineInstance,
  ChatItem,
  Message,
  AccessEntry,
  LogEntry,
  FeedEvent,
  FeedDetail,
  LineMetrics,
  FleetMetrics,
  MetricsRange,
  MessageVolumeBucket,
  TokenUsageBucket,
  SessionActivityBucket,
  ScheduledMessage,
  GroupInfo,
  GroupDetail,
  ContactResult,
} from './types';

export type { Mode, LineInstance, ChatItem, Message, AccessEntry, LogEntry, FeedEvent };

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function hb(pattern: ('up' | 'down' | 'slow')[]): ('up' | 'down' | 'slow')[] {
  const out = [...pattern];
  while (out.length < 20) out.push('up');
  return out.slice(0, 20);
}

function ago(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function uptimeStr(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** ISO bucket string offset from now by N hours, rounded to hour boundary */
function bucketHoursAgo(n: number): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() - n);
  return d.toISOString();
}

/** ISO bucket string offset from now by N days, rounded to day boundary */
function bucketDaysAgo(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/** Business-hours activity multiplier for an hour-of-day (0-23) */
function hourActivity(h: number): number {
  if (h >= 9 && h <= 11) return 1.0;
  if (h >= 13 && h <= 17) return 0.85;
  if (h === 8 || h === 12 || h === 18) return 0.5;
  if (h >= 19 && h <= 22) return 0.3;
  return 0.05; // overnight
}

// ---------------------------------------------------------------------------
//  MOCK_LINES — 8 instances
// ---------------------------------------------------------------------------

export const MOCK_LINES: LineInstance[] = [
  // ── personal ── passive / claude-cli / online
  {
    name: 'personal',
    phone: '+1 555-0100',
    mode: 'passive',
    provider: 'claude-cli',
    status: 'online',
    accessMode: 'allowAll',
    healthPort: 3100,
    uptime: uptimeStr(518400),
    messagesTotal: 21347,
    health: {
      status: 'ok',
      uptime_seconds: 518400,
      messages_total: 21347,
      whatsapp: { connection: { state: 'open' } },
      sqlite: { messages_total: 21347, schema_version: 5 },
      runtime: {
        passive: { unreadCount: 47, lastActivityAt: ago(120) },
      },
      instance: {
        name: 'personal',
        mode: 'passive',
        accessMode: 'allowAll',
        socketPath: '/run/whatsoup/personal.sock',
        provider: 'claude-cli',
      },
    },
    heartbeat: hb(['up']),
    lastActive: ago(120),
    error: null,
    unread: 47,
    messagesToday: 937,
    messageStats: { sent: 312, received: 625, images: 47, audio: 8, documents: 3 },
    group: 'Personal',
    linkedStatus: 'linked',
    totalSessions: 0,
    models: null,
    sandboxPerChat: false,
    chatCounts: { chats: 34, groups: 8 },
    tokenUsage: { input: 0, output: 0 },
  },

  // ── support ── chat / anthropic-api / online
  {
    name: 'support',
    phone: '+1 555-0101',
    mode: 'chat',
    provider: 'anthropic-api',
    status: 'online',
    accessMode: 'allowList',
    healthPort: 3101,
    uptime: uptimeStr(259200),
    messagesTotal: 14823,
    health: {
      status: 'ok',
      uptime_seconds: 259200,
      messages_total: 14823,
      whatsapp: { connection: { state: 'open' } },
      sqlite: { messages_total: 14823, schema_version: 5 },
      runtime: {
        chat: { queueDepth: 3, enrichmentUnprocessed: 12 },
      },
      instance: {
        name: 'support',
        mode: 'chat',
        accessMode: 'allowList',
        socketPath: '/run/whatsoup/support.sock',
        provider: 'anthropic-api',
      },
    },
    heartbeat: hb([
      'up','up','up','up','up','up','up','up','up','up',
      'up','up','up','up','up','up','up','up','up','up',
    ]),
    lastActive: ago(20),
    error: null,
    queueDepth: 3,
    enrichmentUnprocessed: 12,
    messagesToday: 1840,
    messageStats: { sent: 902, received: 938, images: 18, audio: 0, documents: 62 },
    group: 'Bots',
    linkedStatus: 'linked',
    totalSessions: 0,
    models: {
      conversation: 'claude-sonnet-4-6',
      fallback: 'claude-haiku-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
    },
    sandboxPerChat: false,
    chatCounts: { chats: 67, groups: 4 },
    tokenUsage: { input: 3_120_000, output: 1_040_000 },
  },

  // ── research ── agent / claude-cli / online
  {
    name: 'research',
    phone: '+1 555-0102',
    mode: 'agent',
    provider: 'claude-cli',
    status: 'online',
    accessMode: 'denyAll',
    healthPort: 3102,
    uptime: uptimeStr(172800),
    messagesTotal: 8941,
    health: {
      status: 'ok',
      uptime_seconds: 172800,
      messages_total: 8941,
      whatsapp: { connection: { state: 'open' } },
      sqlite: { messages_total: 8941, schema_version: 5 },
      runtime: {
        agent: {
          activeSessions: 2,
          lastSessionStatus: 'running',
          lastSessionStartedAt: ago(900),
        },
      },
      instance: {
        name: 'research',
        mode: 'agent',
        accessMode: 'denyAll',
        socketPath: '/run/whatsoup/research.sock',
        provider: 'claude-cli',
      },
    },
    heartbeat: hb([
      'up','up','up','up','up','up','up','up','up','up',
      'up','up','up','up','up','up','up','up','up','up',
    ]),
    lastActive: ago(8),
    error: null,
    activeSessions: 2,
    lastSessionStatus: 'running',
    messagesToday: 743,
    messageStats: { sent: 298, received: 445, images: 11, audio: 0, documents: 28 },
    group: 'Agents',
    linkedStatus: 'linked',
    totalSessions: 182,
    models: {
      conversation: 'claude-opus-4-6',
      extraction: 'claude-sonnet-4-6',
      validation: 'claude-haiku-4-5',
    },
    sandboxPerChat: false,
    chatCounts: { chats: 13, groups: 2 },
    tokenUsage: { input: 71_400_000, output: 23_500_000 },
  },

  // ── devops ── agent / codex-cli / online
  {
    name: 'devops',
    phone: '+1 555-0103',
    mode: 'agent',
    provider: 'codex-cli',
    status: 'online',
    accessMode: 'denyAll',
    healthPort: 3103,
    uptime: uptimeStr(86400),
    messagesTotal: 4312,
    health: {
      status: 'ok',
      uptime_seconds: 86400,
      messages_total: 4312,
      whatsapp: { connection: { state: 'open' } },
      sqlite: { messages_total: 4312, schema_version: 5 },
      runtime: {
        agent: {
          activeSessions: 1,
          lastSessionStatus: 'running',
          lastSessionStartedAt: ago(1200),
        },
      },
      instance: {
        name: 'devops',
        mode: 'agent',
        accessMode: 'denyAll',
        socketPath: '/run/whatsoup/devops.sock',
        provider: 'codex-cli',
      },
    },
    heartbeat: hb([
      'up','up','up','up','up','up','up','up','up','up',
      'up','up','up','slow','up','up','up','up','up','up',
    ]),
    lastActive: ago(35),
    error: null,
    activeSessions: 1,
    lastSessionStatus: 'running',
    messagesToday: 381,
    messageStats: { sent: 147, received: 234, images: 4, audio: 0, documents: 19 },
    group: 'Agents',
    linkedStatus: 'linked',
    totalSessions: 94,
    models: {
      conversation: 'codex-mini',
      extraction: 'codex-mini',
      validation: 'codex-mini',
    },
    sandboxPerChat: true,
    chatCounts: { chats: 8, groups: 3 },
    tokenUsage: { input: 12_800_000, output: 4_200_000 },
  },

  // ── sales ── chat / anthropic-api / degraded
  {
    name: 'sales',
    phone: '+1 555-0104',
    mode: 'chat',
    provider: 'anthropic-api',
    status: 'degraded',
    accessMode: 'allowList',
    healthPort: 3104,
    uptime: uptimeStr(43200),
    messagesTotal: 6109,
    health: {
      status: 'degraded',
      uptime_seconds: 43200,
      messages_total: 6109,
      whatsapp: { connection: { state: 'open' } },
      sqlite: { messages_total: 6109, schema_version: 5 },
      runtime: {
        chat: { queueDepth: 7, enrichmentUnprocessed: 31 },
      },
      instance: {
        name: 'sales',
        mode: 'chat',
        accessMode: 'allowList',
        socketPath: '/run/whatsoup/sales.sock',
        provider: 'anthropic-api',
      },
    },
    heartbeat: hb([
      'up','up','up','up','up','slow','slow','up','slow','up',
      'slow','up','up','slow','slow','up','up','slow','up','slow',
    ]),
    lastActive: ago(90),
    error: 'enrichment stalled — 31 messages pending contact resolution',
    queueDepth: 7,
    enrichmentUnprocessed: 31,
    messagesToday: 512,
    messageStats: { sent: 244, received: 268, images: 7, audio: 0, documents: 14 },
    group: 'Bots',
    linkedStatus: 'linked',
    totalSessions: 0,
    models: {
      conversation: 'claude-sonnet-4-6',
      fallback: 'claude-haiku-4-5',
      extraction: 'claude-haiku-4-5',
    },
    sandboxPerChat: false,
    chatCounts: { chats: 41, groups: 2 },
    tokenUsage: { input: 1_890_000, output: 620_000 },
  },

  // ── intern ── agent / claude-cli / unreachable
  {
    name: 'intern',
    phone: '+1 555-0105',
    mode: 'agent',
    provider: 'claude-cli',
    status: 'unreachable',
    accessMode: 'denyAll',
    healthPort: 3105,
    uptime: uptimeStr(0),
    messagesTotal: 1203,
    health: null,
    heartbeat: hb([
      'up','up','up','up','up','up','up','up','up','up',
      'slow','slow','down','down','down','down','down','down','down','down',
    ]),
    lastActive: ago(7200),
    error: 'auth expired — re-scan QR to reconnect',
    activeSessions: 0,
    lastSessionStatus: 'auth_expired',
    messagesToday: 0,
    messageStats: { sent: 0, received: 0, images: 0, audio: 0, documents: 0 },
    group: 'Agents',
    linkedStatus: 'linked',
    totalSessions: 37,
    models: {
      conversation: 'claude-sonnet-4-6',
      extraction: 'claude-haiku-4-5',
    },
    sandboxPerChat: true,
    chatCounts: { chats: 5, groups: 1 },
    tokenUsage: { input: 4_100_000, output: 1_350_000 },
  },

  // ── staging ── agent / codex-cli / online
  {
    name: 'staging',
    phone: '+1 555-0106',
    mode: 'agent',
    provider: 'codex-cli',
    status: 'online',
    accessMode: 'denyAll',
    healthPort: 3106,
    uptime: uptimeStr(28800),
    messagesTotal: 412,
    health: {
      status: 'ok',
      uptime_seconds: 28800,
      messages_total: 412,
      whatsapp: { connection: { state: 'open' } },
      sqlite: { messages_total: 412, schema_version: 5 },
      runtime: {
        agent: {
          activeSessions: 0,
          lastSessionStatus: 'completed',
          lastSessionStartedAt: ago(3600),
        },
      },
      instance: {
        name: 'staging',
        mode: 'agent',
        accessMode: 'denyAll',
        socketPath: '/run/whatsoup/staging.sock',
        provider: 'codex-cli',
      },
    },
    heartbeat: hb([
      'up','up','up','up','up','up','up','up','up','up',
      'up','up','up','up','up','up','up','up','up','up',
    ]),
    lastActive: ago(3600),
    error: null,
    activeSessions: 0,
    lastSessionStatus: 'completed',
    messagesToday: 47,
    messageStats: { sent: 19, received: 28, images: 1, audio: 0, documents: 2 },
    group: 'Dev',
    linkedStatus: 'linked',
    totalSessions: 12,
    models: {
      conversation: 'codex-mini',
      extraction: 'codex-mini',
    },
    sandboxPerChat: true,
    chatCounts: { chats: 3, groups: 1 },
    tokenUsage: { input: 820_000, output: 270_000 },
  },

  // ── archive ── passive / claude-cli / online (unlinked, zero activity)
  {
    name: 'archive',
    phone: '+1 555-0107',
    mode: 'passive',
    provider: 'claude-cli',
    status: 'online',
    accessMode: 'allowAll',
    healthPort: 3107,
    uptime: uptimeStr(604800),
    messagesTotal: 5820,
    health: {
      status: 'ok',
      uptime_seconds: 604800,
      messages_total: 5820,
      whatsapp: { connection: { state: 'open' } },
      sqlite: { messages_total: 5820, schema_version: 5 },
      runtime: {
        passive: { unreadCount: 0, lastActivityAt: null },
      },
      instance: {
        name: 'archive',
        mode: 'passive',
        accessMode: 'allowAll',
        socketPath: '/run/whatsoup/archive.sock',
        provider: 'claude-cli',
      },
    },
    heartbeat: hb([
      'up','up','up','up','up','up','up','up','up','up',
      'up','up','up','up','up','up','up','up','up','up',
    ]),
    lastActive: ago(604800),
    error: null,
    unread: 0,
    messagesToday: 0,
    messageStats: { sent: 0, received: 0, images: 0, audio: 0, documents: 0 },
    group: 'Personal',
    linkedStatus: 'unlinked',
    totalSessions: 0,
    models: null,
    sandboxPerChat: false,
    chatCounts: { chats: 0, groups: 0 },
    tokenUsage: { input: 0, output: 0 },
  },
];

// ---------------------------------------------------------------------------
//  Time-series metrics generators
// ---------------------------------------------------------------------------

/**
 * Build hourly message volume buckets for the given range.
 * Activity concentrated during business hours, quiet overnight.
 */
function buildMessageVolume(buckets: number, isHourly: boolean, scale: number): MessageVolumeBucket[] {
  return Array.from({ length: buckets }, (_, i) => {
    const offset = buckets - 1 - i;
    const bucket = isHourly ? bucketHoursAgo(offset) : bucketDaysAgo(offset);

    let h: number;
    if (isHourly) {
      const d = new Date();
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() - offset);
      h = d.getHours();
    } else {
      // daily — simulate afternoon peak
      h = 14;
    }

    const mult = hourActivity(h);
    // weekend dip for multi-day ranges
    const dayOfWeek = isHourly ? new Date().getDay() : (new Date().getDay() - offset + 70) % 7;
    const weekendMult = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.4 : 1.0;

    const base = Math.round(scale * mult * weekendMult);
    const inbound = Math.max(0, base + Math.round((Math.random() - 0.5) * base * 0.3));
    const outbound = Math.max(0, Math.round(inbound * 0.85 + Math.random() * 5));
    const media = Math.max(0, Math.round(inbound * 0.08));

    return { bucket, inbound, outbound, media };
  });
}

function buildTokenUsage(buckets: number, isHourly: boolean, inputScale: number): TokenUsageBucket[] {
  return Array.from({ length: buckets }, (_, i) => {
    const offset = buckets - 1 - i;
    const bucket = isHourly ? bucketHoursAgo(offset) : bucketDaysAgo(offset);

    let h = 14;
    if (isHourly) {
      const d = new Date();
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() - offset);
      h = d.getHours();
    }

    const mult = hourActivity(h);
    const input = Math.max(0, Math.round(inputScale * mult * (0.85 + Math.random() * 0.3)));
    const output = Math.max(0, Math.round(input * 0.32 + Math.random() * 1000));

    return { bucket, input, output };
  });
}

function buildSessionActivity(buckets: number, isHourly: boolean, scale: number): SessionActivityBucket[] {
  return Array.from({ length: buckets }, (_, i) => {
    const offset = buckets - 1 - i;
    const bucket = isHourly ? bucketHoursAgo(offset) : bucketDaysAgo(offset);

    let h = 14;
    if (isHourly) {
      const d = new Date();
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() - offset);
      h = d.getHours();
    }

    const mult = hourActivity(h);
    const started = Math.max(0, Math.round(scale * mult * (0.7 + Math.random() * 0.6)));
    const active = Math.max(0, Math.round(started * 0.4));

    return { bucket, started, active };
  });
}

/** 7x24 matrix of activity weights (row=day 0=Sun, col=hour) */
function buildActiveHours(scale: number): number[][] {
  return Array.from({ length: 7 }, (_, day) => {
    const weekendMult = (day === 0 || day === 6) ? 0.35 : 1.0;
    return Array.from({ length: 24 }, (_, h) => {
      return Math.max(0, Math.round(scale * hourActivity(h) * weekendMult * (0.7 + Math.random() * 0.6)));
    });
  });
}

type LineConfig = {
  provider: string;
  mode: Mode;
  msgScale: number;       // messages per hour at peak
  tokenInputScale: number; // tokens per hour at peak
  sessionScale: number;   // sessions per hour at peak
};

const LINE_CONFIGS: Record<string, LineConfig> = {
  personal:  { provider: 'claude-cli',     mode: 'passive', msgScale: 30,  tokenInputScale: 0,         sessionScale: 0 },
  support:   { provider: 'anthropic-api',  mode: 'chat',    msgScale: 80,  tokenInputScale: 140_000,   sessionScale: 0 },
  research:  { provider: 'claude-cli',     mode: 'agent',   msgScale: 35,  tokenInputScale: 620_000,   sessionScale: 2.5 },
  devops:    { provider: 'codex-cli',      mode: 'agent',   msgScale: 18,  tokenInputScale: 280_000,   sessionScale: 1.2 },
  sales:     { provider: 'anthropic-api',  mode: 'chat',    msgScale: 22,  tokenInputScale: 95_000,    sessionScale: 0 },
  intern:    { provider: 'claude-cli',     mode: 'agent',   msgScale: 8,   tokenInputScale: 55_000,    sessionScale: 0.4 },
  staging:   { provider: 'codex-cli',      mode: 'agent',   msgScale: 4,   tokenInputScale: 22_000,    sessionScale: 0.3 },
  archive:   { provider: 'claude-cli',     mode: 'passive', msgScale: 0,   tokenInputScale: 0,         sessionScale: 0 },
};

export function generateMetrics(name: string, range: MetricsRange): LineMetrics {
  const cfg = LINE_CONFIGS[name] ?? { provider: 'claude-cli', mode: 'passive', msgScale: 5, tokenInputScale: 0, sessionScale: 0 };

  const isHourly = range === '24h';
  const buckets = range === '24h' ? 24 : range === '7d' ? 7 : 30;

  const messageVolume = buildMessageVolume(buckets, isHourly, cfg.msgScale);
  const tokenUsage = cfg.tokenInputScale > 0
    ? buildTokenUsage(buckets, isHourly, cfg.tokenInputScale)
    : messageVolume.map(b => ({ bucket: b.bucket, input: 0, output: 0 }));
  const sessionActivity = cfg.sessionScale > 0
    ? buildSessionActivity(buckets, isHourly, cfg.sessionScale)
    : messageVolume.map(b => ({ bucket: b.bucket, started: 0, active: 0 }));

  const hasTokenData = cfg.mode !== 'passive';
  const hasSessionData = cfg.mode === 'agent';
  const hasMessageData = cfg.msgScale > 0;

  const tokenUsageByProvider: Record<string, TokenUsageBucket[]> = {};
  const sessionActivityByProvider: Record<string, SessionActivityBucket[]> = {};

  if (hasTokenData) {
    tokenUsageByProvider[cfg.provider] = tokenUsage;
  }
  if (hasSessionData) {
    sessionActivityByProvider[cfg.provider] = sessionActivity;
  }

  return {
    range,
    messageVolume,
    tokenUsage,
    sessionActivity,
    tokenUsageByProvider,
    sessionActivityByProvider,
    activeHours: buildActiveHours(cfg.msgScale),
    activeHoursByDate: Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.now() - (29 - i) * 86400000);
      return {
        date: d.toISOString().slice(0, 10),
        hours: Array.from({ length: 24 }, () => Math.floor(Math.random() * cfg.msgScale * 3)),
      };
    }),
    hasMessageData,
    hasTokenData,
    hasSessionData,
    providers: [cfg.provider],
  };
}

export function generateFleetMetrics(range: MetricsRange, configs: Record<string, LineConfig> = LINE_CONFIGS): FleetMetrics {
  const allCfgs = Object.values(configs);
  const isHourly = range === '24h';
  const buckets = range === '24h' ? 24 : range === '7d' ? 7 : 30;

  // Aggregate message volume across all lines
  const allMsgVolumes = Object.values(configs).map(c => buildMessageVolume(buckets, isHourly, c.msgScale));
  const messageVolume: MessageVolumeBucket[] = allMsgVolumes[0].map((_, bi) => ({
    bucket: allMsgVolumes[0][bi].bucket,
    inbound: allMsgVolumes.reduce((s, v) => s + v[bi].inbound, 0),
    outbound: allMsgVolumes.reduce((s, v) => s + v[bi].outbound, 0),
    media: allMsgVolumes.reduce((s, v) => s + v[bi].media, 0),
  }));

  // Aggregate token usage
  const tokenLines = Object.entries(configs).filter(([, c]) => c.tokenInputScale > 0);
  const allTokenData = tokenLines.map(([, c]) => buildTokenUsage(buckets, isHourly, c.tokenInputScale));
  const tokenUsage: TokenUsageBucket[] = allTokenData[0]?.map((_, bi) => ({
    bucket: allTokenData[0][bi].bucket,
    input: allTokenData.reduce((s, v) => s + v[bi].input, 0),
    output: allTokenData.reduce((s, v) => s + v[bi].output, 0),
  })) ?? messageVolume.map(b => ({ bucket: b.bucket, input: 0, output: 0 }));

  // Aggregate session activity
  const sessionLines = Object.entries(configs).filter(([, c]) => c.sessionScale > 0);
  const allSessionData = sessionLines.map(([, c]) => buildSessionActivity(buckets, isHourly, c.sessionScale));
  const sessionActivity: SessionActivityBucket[] = allSessionData[0]?.map((_, bi) => ({
    bucket: allSessionData[0][bi].bucket,
    started: allSessionData.reduce((s, v) => s + v[bi].started, 0),
    active: allSessionData.reduce((s, v) => s + v[bi].active, 0),
  })) ?? messageVolume.map(b => ({ bucket: b.bucket, started: 0, active: 0 }));

  // Per-provider breakdown
  const providers = ['claude-cli', 'anthropic-api', 'codex-cli'];

  const tokenUsageByProvider: Record<string, TokenUsageBucket[]> = {};
  const sessionActivityByProvider: Record<string, SessionActivityBucket[]> = {};

  for (const prov of providers) {
    const provCfgs = Object.values(configs).filter(c => c.provider === prov);
    const totalTokenScale = provCfgs.reduce((s, c) => s + c.tokenInputScale, 0);
    const totalSessionScale = provCfgs.reduce((s, c) => s + c.sessionScale, 0);
    if (totalTokenScale > 0) {
      tokenUsageByProvider[prov] = buildTokenUsage(buckets, isHourly, totalTokenScale);
    }
    if (totalSessionScale > 0) {
      sessionActivityByProvider[prov] = buildSessionActivity(buckets, isHourly, totalSessionScale);
    }
  }

  const hasAnyAgent = allCfgs.some(c => c.mode === 'agent');
  const hasAnyToken = allCfgs.some(c => c.tokenInputScale > 0);

  return {
    range,
    meta: {
      instancesQueried: Object.keys(configs).length,
      instancesFailed: 1,
      hasMessageData: true,
      hasTokenData: hasAnyToken,
      hasSessionData: hasAnyAgent,
      providers,
    },
    messageVolume,
    tokenUsage,
    sessionActivity,
    tokenUsageByProvider,
    sessionActivityByProvider,
  };
}

// ---------------------------------------------------------------------------
//  MOCK_FEED — 20 events covering all FeedDetail variants
// ---------------------------------------------------------------------------

function feedEvent(
  secondsAgo: number,
  mode: Mode,
  instance: string,
  text: string,
  level: 'info' | 'warn' | 'error',
  detail: FeedDetail,
  provider?: string,
): FeedEvent {
  return { time: ago(secondsAgo), mode, instance, text, level, detail, provider };
}

export const MOCK_FEED: FeedEvent[] = [
  // message — inbound
  feedEvent(5, 'chat', 'support', 'support: Inbound message from Alex Chen', 'info', {
    type: 'message', direction: 'inbound', chatJid: '15550110@s.whatsapp.net',
    messageId: 'msg-001', preview: 'Hi, I need help with my order #4921', senderName: 'Alex Chen', contentType: 'text',
  }, 'anthropic-api'),
  // message — outbound
  feedEvent(18, 'chat', 'support', 'support: Reply sent to Alex Chen', 'info', {
    type: 'message', direction: 'outbound', chatJid: '15550110@s.whatsapp.net',
    messageId: 'msg-002', preview: 'Hi Alex! I can help you with order #4921...', contentType: 'text',
  }, 'anthropic-api'),
  // tool_use
  feedEvent(22, 'agent', 'research', 'research: Tool call — search_contacts', 'info', {
    type: 'tool_use', toolName: 'search_contacts', toolId: 'tool-001',
  }, 'claude-cli'),
  // message — inbound image
  feedEvent(35, 'passive', 'personal', 'personal: New message from Family Group', 'info', {
    type: 'message', direction: 'inbound', chatJid: '120363001@g.us',
    messageId: 'msg-003', senderName: 'Mom', contentType: 'image',
  }, 'claude-cli'),
  // session — started
  feedEvent(50, 'agent', 'research', 'research: Agent session started', 'info', {
    type: 'session', action: 'started', sessionId: 'sess-a1b2', chatJid: '15550112@s.whatsapp.net',
  }, 'claude-cli'),
  // tool_use — send_message
  feedEvent(65, 'agent', 'devops', 'devops: Tool call — send_message', 'info', {
    type: 'tool_use', toolName: 'send_message', toolId: 'tool-002',
  }, 'codex-cli'),
  // health — status change
  feedEvent(88, 'chat', 'sales', 'sales: Status changed to degraded', 'warn', {
    type: 'health', status: 'degraded', previousStatus: 'online', error: 'enrichment stalled',
  }, 'anthropic-api'),
  // connection — reconnecting
  feedEvent(120, 'agent', 'intern', 'intern: Attempting reconnection', 'warn', {
    type: 'connection', reconnecting: true, state: 'connecting',
  }, 'claude-cli'),
  // tool_error
  feedEvent(145, 'agent', 'intern', 'intern: Tool error — send_message failed', 'error', {
    type: 'tool_error', toolName: 'send_message', toolId: 'tool-003',
    error: 'Connection closed: auth token expired',
  }, 'claude-cli'),
  // message — outbound document
  feedEvent(170, 'chat', 'support', 'support: Document sent to James Wong', 'info', {
    type: 'message', direction: 'outbound', chatJid: '15550113@s.whatsapp.net',
    messageId: 'msg-004', senderName: 'James Wong', contentType: 'document',
  }, 'anthropic-api'),
  // session — ended
  feedEvent(210, 'agent', 'devops', 'devops: Agent session completed (12 tool calls)', 'info', {
    type: 'session', action: 'ended', sessionId: 'sess-c3d4', reason: 'task_complete',
  }, 'codex-cli'),
  // connection — connected
  feedEvent(270, 'agent', 'devops', 'devops: Connection established', 'info', {
    type: 'connection', state: 'connected',
  }, 'codex-cli'),
  // import
  feedEvent(340, 'passive', 'personal', 'personal: Imported 142 messages', 'info', {
    type: 'import', table: 'messages', count: 142, skipped: false,
  }, 'claude-cli'),
  // session — resumed
  feedEvent(400, 'agent', 'research', 'research: Session resumed after context reload', 'info', {
    type: 'session', action: 'resumed', sessionId: 'sess-e5f6',
  }, 'claude-cli'),
  // tool_error
  feedEvent(460, 'agent', 'research', 'research: Tool error — list_groups timed out', 'error', {
    type: 'tool_error', toolName: 'list_groups', toolId: 'tool-004',
    error: 'Upstream timeout after 10000ms',
  }, 'claude-cli'),
  // health — recovered
  feedEvent(540, 'agent', 'staging', 'staging: Status recovered to online', 'info', {
    type: 'health', status: 'online', previousStatus: 'degraded',
  }, 'codex-cli'),
  // connection — disconnected
  feedEvent(620, 'agent', 'intern', 'intern: Connection lost', 'error', {
    type: 'connection', state: 'disconnected', statusCode: 401, reason: 'auth_failure',
  }, 'claude-cli'),
  // import — with skipped
  feedEvent(720, 'passive', 'archive', 'archive: Import completed (14 skipped)', 'info', {
    type: 'import', table: 'contacts', count: 89, skipped: true,
  }, 'claude-cli'),
  // generic
  feedEvent(900, 'passive', 'personal', 'personal: SQLite WAL checkpoint completed', 'info', {
    type: 'generic',
  }, 'claude-cli'),
  // generic — system
  feedEvent(1200, 'agent', 'research', 'research: Fleet health check passed', 'info', {
    type: 'generic',
  }, 'claude-cli'),
];

// ---------------------------------------------------------------------------
//  MOCK_CHATS — 5-15 per line
// ---------------------------------------------------------------------------

export const MOCK_CHATS: Record<string, ChatItem[]> = {
  personal: [
    { conversationKey: 'personal-family', name: 'Family Group', lastMessagePreview: 'Mom: Don\'t forget Sunday dinner!', lastMessageAt: ago(120), unreadCount: 8, isGroup: true },
    { conversationKey: 'personal-alex', name: 'Alex Chen', lastMessagePreview: 'See you at 3pm', lastMessageAt: ago(600), unreadCount: 2, isGroup: false },
    { conversationKey: 'personal-marco', name: 'Marco Rivera', lastMessagePreview: 'Flight confirmed for Thursday', lastMessageAt: ago(1800), unreadCount: 5, isGroup: false },
    { conversationKey: 'personal-gym', name: 'Gym Crew', lastMessagePreview: 'Jake: Anyone up for 6am tomorrow?', lastMessageAt: ago(3600), unreadCount: 12, isGroup: true },
    { conversationKey: 'personal-priya', name: 'Priya Sharma', lastMessagePreview: 'Thanks for the recipe!', lastMessageAt: ago(7200), unreadCount: 0, isGroup: false },
    { conversationKey: 'personal-neighbors', name: 'Neighborhood Watch', lastMessagePreview: 'Linda: Package stolen from porch again', lastMessageAt: ago(14400), unreadCount: 19, isGroup: true },
    { conversationKey: 'personal-sam', name: 'Sam Taylor', lastMessagePreview: 'Let me check and get back to you', lastMessageAt: ago(21600), unreadCount: 1, isGroup: false },
    { conversationKey: 'personal-bookclub', name: 'Book Club', lastMessagePreview: 'Next meeting on the 28th?', lastMessageAt: ago(43200), unreadCount: 0, isGroup: true },
  ],

  support: [
    { conversationKey: 'support-alexc', name: 'Alex Chen', lastMessagePreview: 'Bot: Your order has shipped!', lastMessageAt: ago(20), unreadCount: 0, isGroup: false },
    { conversationKey: 'support-james', name: 'James Wong', lastMessagePreview: 'What are your hours on Saturday?', lastMessageAt: ago(45), unreadCount: 1, isGroup: false },
    { conversationKey: 'support-fatima', name: 'Fatima Al-Rashid', lastMessagePreview: 'Can I reschedule my appointment?', lastMessageAt: ago(200), unreadCount: 1, isGroup: false },
    { conversationKey: 'support-tom', name: 'Tom Anderson', lastMessagePreview: 'Bot: Rating submitted — thanks!', lastMessageAt: ago(800), unreadCount: 0, isGroup: false },
    { conversationKey: 'support-diana', name: 'Diana Reyes', lastMessagePreview: 'Bot: Here are our pricing options...', lastMessageAt: ago(1400), unreadCount: 0, isGroup: false },
    { conversationKey: 'support-ops', name: 'Support Ops', lastMessagePreview: 'New lead: +1 555-0199', lastMessageAt: ago(3600), unreadCount: 0, isGroup: true },
    { conversationKey: 'support-wei', name: 'Wei Zhang', lastMessagePreview: 'I got your message, thanks', lastMessageAt: ago(7200), unreadCount: 0, isGroup: false },
  ],

  research: [
    { conversationKey: 'research-owner', name: 'Owner', lastMessagePreview: 'Start research on topic A', lastMessageAt: ago(8), unreadCount: 0, isGroup: false },
    { conversationKey: 'research-alerts', name: 'Research Alerts', lastMessagePreview: 'Session completed: 22 tool calls', lastMessageAt: ago(900), unreadCount: 0, isGroup: true },
    { conversationKey: 'research-nina', name: 'Nina Park', lastMessagePreview: 'Great summary, thanks', lastMessageAt: ago(3600), unreadCount: 0, isGroup: false },
    { conversationKey: 'research-ben', name: 'Ben Okafor', lastMessagePreview: 'Can you pull the Q1 data?', lastMessageAt: ago(7200), unreadCount: 0, isGroup: false },
    { conversationKey: 'research-team', name: 'Research Team', lastMessagePreview: 'Weekly digest sent', lastMessageAt: ago(14400), unreadCount: 0, isGroup: true },
    { conversationKey: 'research-logs', name: 'Debug Channel', lastMessagePreview: 'Session sess-a1b2 started', lastMessageAt: ago(28800), unreadCount: 0, isGroup: true },
    { conversationKey: 'research-jade', name: 'Jade Morris', lastMessagePreview: 'Please summarize the report', lastMessageAt: ago(43200), unreadCount: 0, isGroup: false },
    { conversationKey: 'research-luca', name: 'Luca Ferrari', lastMessagePreview: 'Done — results posted', lastMessageAt: ago(57600), unreadCount: 0, isGroup: false },
    { conversationKey: 'research-ops', name: 'Ops Channel', lastMessagePreview: 'Deploy complete', lastMessageAt: ago(72000), unreadCount: 0, isGroup: true },
    { conversationKey: 'research-kai', name: 'Kai Nakamura', lastMessagePreview: 'Token report attached', lastMessageAt: ago(86400), unreadCount: 0, isGroup: false },
    { conversationKey: 'research-anna', name: 'Anna Petrov', lastMessagePreview: 'Noted, will follow up', lastMessageAt: ago(90000), unreadCount: 0, isGroup: false },
    { conversationKey: 'research-cmd', name: 'Command Channel', lastMessagePreview: 'Awaiting next task', lastMessageAt: ago(100800), unreadCount: 0, isGroup: true },
    { conversationKey: 'research-mat', name: 'Mateo Lopez', lastMessagePreview: 'Analysis looks good', lastMessageAt: ago(115200), unreadCount: 0, isGroup: false },
  ],

  devops: [
    { conversationKey: 'devops-owner', name: 'Owner', lastMessagePreview: 'Deploy the patch please', lastMessageAt: ago(35), unreadCount: 0, isGroup: false },
    { conversationKey: 'devops-ci', name: 'CI Notifications', lastMessagePreview: 'Build #512 passed', lastMessageAt: ago(900), unreadCount: 0, isGroup: true },
    { conversationKey: 'devops-pr', name: 'PR Reviews', lastMessagePreview: 'PR #87 approved', lastMessageAt: ago(3600), unreadCount: 0, isGroup: true },
    { conversationKey: 'devops-oncall', name: 'On-Call Alerts', lastMessagePreview: 'No active incidents', lastMessageAt: ago(7200), unreadCount: 0, isGroup: true },
    { conversationKey: 'devops-jake', name: 'Jake Kim', lastMessagePreview: 'Pushed the hotfix', lastMessageAt: ago(14400), unreadCount: 0, isGroup: false },
    { conversationKey: 'devops-rita', name: 'Rita Flores', lastMessagePreview: 'Infra report attached', lastMessageAt: ago(21600), unreadCount: 0, isGroup: false },
    { conversationKey: 'devops-deploy', name: 'Deploy Channel', lastMessagePreview: 'v2.3.1 deployed to prod', lastMessageAt: ago(43200), unreadCount: 0, isGroup: true },
    { conversationKey: 'devops-debug', name: 'Debug Log', lastMessagePreview: 'Memory spike resolved', lastMessageAt: ago(57600), unreadCount: 0, isGroup: true },
  ],

  sales: [
    { conversationKey: 'sales-lead1', name: 'David Park', lastMessagePreview: 'Bot: Following up on your demo...', lastMessageAt: ago(90), unreadCount: 0, isGroup: false },
    { conversationKey: 'sales-lead2', name: 'Emma Johnson', lastMessagePreview: 'What integrations do you support?', lastMessageAt: ago(400), unreadCount: 1, isGroup: false },
    { conversationKey: 'sales-lead3', name: 'Raj Patel', lastMessagePreview: 'Bot: Your free trial is active!', lastMessageAt: ago(1200), unreadCount: 0, isGroup: false },
    { conversationKey: 'sales-lead4', name: 'Sofia Martinez', lastMessagePreview: 'Let me check with my team', lastMessageAt: ago(3600), unreadCount: 1, isGroup: false },
    { conversationKey: 'sales-pipeline', name: 'Sales Pipeline', lastMessagePreview: 'Weekly: 8 new leads, 2 conversions', lastMessageAt: ago(7200), unreadCount: 0, isGroup: true },
    { conversationKey: 'sales-ops', name: 'Sales Ops', lastMessagePreview: 'Enrichment backlog alert', lastMessageAt: ago(14400), unreadCount: 0, isGroup: true },
  ],

  intern: [
    { conversationKey: 'intern-owner', name: 'Owner', lastMessagePreview: 'Your auth expired, re-scan QR', lastMessageAt: ago(7200), unreadCount: 0, isGroup: false },
    { conversationKey: 'intern-test1', name: 'Test User A', lastMessagePreview: 'Hello?', lastMessageAt: ago(14400), unreadCount: 0, isGroup: false },
    { conversationKey: 'intern-test2', name: 'Test User B', lastMessagePreview: 'Is this thing on?', lastMessageAt: ago(28800), unreadCount: 0, isGroup: false },
    { conversationKey: 'intern-testgrp', name: 'Test Group', lastMessagePreview: 'Last session ended abruptly', lastMessageAt: ago(36000), unreadCount: 0, isGroup: true },
    { conversationKey: 'intern-debug', name: 'Debug Log', lastMessagePreview: 'Auth failure logged', lastMessageAt: ago(43200), unreadCount: 0, isGroup: true },
  ],

  staging: [
    { conversationKey: 'staging-test1', name: 'Tester A', lastMessagePreview: 'Test message 1', lastMessageAt: ago(3600), unreadCount: 0, isGroup: false },
    { conversationKey: 'staging-test2', name: 'Tester B', lastMessagePreview: 'Smoke test passed', lastMessageAt: ago(7200), unreadCount: 0, isGroup: false },
    { conversationKey: 'staging-grp', name: 'QA Channel', lastMessagePreview: 'All tests green', lastMessageAt: ago(14400), unreadCount: 0, isGroup: true },
  ],

  archive: [],
};

// ---------------------------------------------------------------------------
//  MOCK_MESSAGES — 10-20 per conversation
// ---------------------------------------------------------------------------

let _pk = 1000;
function msg(
  conversationKey: string,
  senderName: string,
  senderJid: string,
  content: string,
  secondsAgo: number,
  fromMe: boolean,
  type = 'text',
): Message {
  return {
    pk: _pk++,
    conversationKey,
    senderName,
    senderJid,
    content,
    timestamp: ago(secondsAgo),
    fromMe,
    type,
  };
}

export const MOCK_MESSAGES: Record<string, Message[]> = {
  'personal-family': [
    msg('personal-family', 'Mom', '15550200@s.whatsapp.net', 'Don\'t forget Sunday dinner!', 7200, false),
    msg('personal-family', 'Me', '15550100@s.whatsapp.net', 'I\'ll be there at 6!', 6800, true),
    msg('personal-family', 'Dad', '15550201@s.whatsapp.net', 'Great, I\'ll make the roast', 6400, false),
    msg('personal-family', 'Mom', '15550200@s.whatsapp.net', 'Should I invite Aunt Rosa?', 6000, false),
    msg('personal-family', 'Me', '15550100@s.whatsapp.net', 'Yes, definitely!', 5600, true),
    msg('personal-family', 'Dad', '15550201@s.whatsapp.net', 'Check out the garden', 3600, false, 'image'),
    msg('personal-family', 'Mom', '15550200@s.whatsapp.net', 'Picked up dessert from the bakery', 2400, false),
    msg('personal-family', 'Me', '15550100@s.whatsapp.net', 'That looks amazing!', 2200, true),
    msg('personal-family', 'Mom', '15550200@s.whatsapp.net', 'See everyone Sunday', 1200, false),
    msg('personal-family', 'Dad', '15550201@s.whatsapp.net', '👍', 900, false),
    msg('personal-family', 'Mom', '15550200@s.whatsapp.net', 'Don\'t forget Sunday dinner!', 120, false),
  ],

  'personal-alex': [
    msg('personal-alex', 'Alex Chen', '15550202@s.whatsapp.net', 'Hey, are we still on for tomorrow?', 14400, false),
    msg('personal-alex', 'Me', '15550100@s.whatsapp.net', 'Yes! 3pm at the usual place', 14000, true),
    msg('personal-alex', 'Alex Chen', '15550202@s.whatsapp.net', 'Perfect. I\'ll book the table', 13600, false),
    msg('personal-alex', 'Me', '15550100@s.whatsapp.net', 'Thanks! See you then', 13200, true),
    msg('personal-alex', 'Alex Chen', '15550202@s.whatsapp.net', 'Quick question — should we invite Sam?', 3600, false),
    msg('personal-alex', 'Me', '15550100@s.whatsapp.net', 'Good idea, I\'ll text them', 3400, true),
    msg('personal-alex', 'Alex Chen', '15550202@s.whatsapp.net', 'See you at 3pm', 600, false),
  ],

  'support-alexc': [
    msg('support-alexc', 'Alex Chen', '15550110@s.whatsapp.net', 'Hi, I need help with my order #4921', 3600, false),
    msg('support-alexc', 'Bot', '15550101@s.whatsapp.net', 'Hi Alex! I can help with order #4921. Let me check that for you.', 3580, true),
    msg('support-alexc', 'Alex Chen', '15550110@s.whatsapp.net', 'It says delivered but I haven\'t received it', 3500, false),
    msg('support-alexc', 'Bot', '15550101@s.whatsapp.net', 'I can see it was delivered on Monday at 2:47pm. Was anyone home?', 3480, true),
    msg('support-alexc', 'Alex Chen', '15550110@s.whatsapp.net', 'No, I was at work. Could it be with a neighbor?', 3400, false),
    msg('support-alexc', 'Bot', '15550101@s.whatsapp.net', 'The carrier left it with unit 4B according to the delivery notes.', 3380, true),
    msg('support-alexc', 'Alex Chen', '15550110@s.whatsapp.net', 'Oh! I\'ll check there. Thanks', 3200, false),
    msg('support-alexc', 'Bot', '15550101@s.whatsapp.net', 'Great! Let me know if you need anything else.', 3180, true),
    msg('support-alexc', 'Alex Chen', '15550110@s.whatsapp.net', 'Got it, thanks so much!', 100, false),
    msg('support-alexc', 'Bot', '15550101@s.whatsapp.net', 'Your order has shipped!', 20, true),
  ],

  'support-james': [
    msg('support-james', 'James Wong', '15550113@s.whatsapp.net', 'What are your hours on Saturday?', 3600, false),
    msg('support-james', 'Bot', '15550101@s.whatsapp.net', 'We\'re open Saturday 9am–5pm.', 3580, true),
    msg('support-james', 'James Wong', '15550113@s.whatsapp.net', 'And Sunday?', 3400, false),
    msg('support-james', 'Bot', '15550101@s.whatsapp.net', 'Closed Sunday, back Monday 8am.', 3380, true),
    msg('support-james', 'James Wong', '15550113@s.whatsapp.net', 'Great, I\'ll come Saturday', 3000, false),
    msg('support-james', 'Bot', '15550101@s.whatsapp.net', '[document: hours-schedule.pdf]', 2800, true, 'document'),
    msg('support-james', 'James Wong', '15550113@s.whatsapp.net', 'What are your hours on Saturday?', 45, false),
  ],

  'research-owner': [
    msg('research-owner', 'Owner', '15550115@s.whatsapp.net', 'Start research on the Q2 market report', 3600, false),
    msg('research-owner', 'Agent', '15550102@s.whatsapp.net', 'Starting research session. I\'ll analyze market data and compile findings.', 3590, true),
    msg('research-owner', 'Agent', '15550102@s.whatsapp.net', 'Pulling data from 14 sources...', 3400, true),
    msg('research-owner', 'Owner', '15550115@s.whatsapp.net', 'Focus on APAC region', 3200, false),
    msg('research-owner', 'Agent', '15550102@s.whatsapp.net', 'Noted. Refining scope to APAC...', 3180, true),
    msg('research-owner', 'Agent', '15550102@s.whatsapp.net', 'Initial findings: APAC market grew 14% YoY. Draft attached.', 2400, true, 'document'),
    msg('research-owner', 'Owner', '15550115@s.whatsapp.net', 'Good. Add a competitive analysis section', 1800, false),
    msg('research-owner', 'Agent', '15550102@s.whatsapp.net', 'Expanding analysis with competitor breakdown...', 1780, true),
    msg('research-owner', 'Agent', '15550102@s.whatsapp.net', 'Updated draft with competitive analysis. 3 key competitors identified.', 900, true),
    msg('research-owner', 'Owner', '15550115@s.whatsapp.net', 'Start research on topic A', 8, false),
  ],

  'devops-owner': [
    msg('devops-owner', 'Owner', '15550116@s.whatsapp.net', 'Deploy the patch please', 3600, false),
    msg('devops-owner', 'Agent', '15550103@s.whatsapp.net', 'Starting deployment of patch v2.3.1-hotfix...', 3590, true),
    msg('devops-owner', 'Agent', '15550103@s.whatsapp.net', 'Build passed. Running pre-deploy checks...', 3200, true),
    msg('devops-owner', 'Agent', '15550103@s.whatsapp.net', 'All checks passed. Deploying to production...', 2800, true),
    msg('devops-owner', 'Owner', '15550116@s.whatsapp.net', 'How long will this take?', 2600, false),
    msg('devops-owner', 'Agent', '15550103@s.whatsapp.net', 'Estimated 4 minutes. 70% complete.', 2400, true),
    msg('devops-owner', 'Agent', '15550103@s.whatsapp.net', 'Deployment complete. v2.3.1-hotfix is live.', 1800, true),
    msg('devops-owner', 'Owner', '15550116@s.whatsapp.net', 'Thanks, monitoring now', 1600, false),
    msg('devops-owner', 'Agent', '15550103@s.whatsapp.net', 'I\'ll alert you if any anomalies detected in the next 30 min.', 1580, true),
    msg('devops-owner', 'Owner', '15550116@s.whatsapp.net', 'Deploy the patch please', 35, false),
  ],

  'sales-lead1': [
    msg('sales-lead1', 'Bot', '15550104@s.whatsapp.net', 'Hi David! Following up on your demo request from last week.', 7200, true),
    msg('sales-lead1', 'David Park', '15550120@s.whatsapp.net', 'Yes, I\'m interested. Can we schedule for next week?', 7000, false),
    msg('sales-lead1', 'Bot', '15550104@s.whatsapp.net', 'Absolutely! I have Tuesday at 2pm or Thursday at 10am available.', 6980, true),
    msg('sales-lead1', 'David Park', '15550120@s.whatsapp.net', 'Thursday 10am works for me', 6800, false),
    msg('sales-lead1', 'Bot', '15550104@s.whatsapp.net', 'Booked! You\'ll receive a calendar invite shortly.', 6780, true),
    msg('sales-lead1', 'Bot', '15550104@s.whatsapp.net', 'Following up on your demo request...', 90, true),
  ],

  'intern-owner': [
    msg('intern-owner', 'Owner', '15550117@s.whatsapp.net', 'Your auth expired, please re-scan QR code', 7200, false),
    msg('intern-owner', 'Agent', '15550105@s.whatsapp.net', '[no response — instance unreachable]', 7199, true),
  ],

  'staging-test1': [
    msg('staging-test1', 'Tester A', '15550130@s.whatsapp.net', 'Test message 1', 7200, false),
    msg('staging-test1', 'Agent', '15550106@s.whatsapp.net', 'Acknowledged. Test response 1.', 7190, true),
    msg('staging-test1', 'Tester A', '15550130@s.whatsapp.net', 'Test message 2', 5400, false),
    msg('staging-test1', 'Agent', '15550106@s.whatsapp.net', 'Acknowledged. Test response 2.', 5390, true),
    msg('staging-test1', 'Tester A', '15550130@s.whatsapp.net', 'Smoke test passed', 3600, false),
    msg('staging-test1', 'Agent', '15550106@s.whatsapp.net', 'All checks nominal.', 3590, true),
    msg('staging-test1', 'Tester A', '15550130@s.whatsapp.net', 'Test message 1', 3600, false),
  ],
};

// ---------------------------------------------------------------------------
//  MOCK_ACCESS — 5-10 entries per line
// ---------------------------------------------------------------------------

export const MOCK_ACCESS: Record<string, AccessEntry[]> = {
  personal: [
    { subjectType: 'phone', subjectId: '+15550200', subjectName: 'Mom', status: 'allowed', updatedAt: '2025-01-15T10:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550201', subjectName: 'Dad', status: 'allowed', updatedAt: '2025-01-15T10:00:00Z' },
    { subjectType: 'group', subjectId: '120363001@g.us', subjectName: 'Family Group', status: 'allowed', updatedAt: '2025-01-15T10:00:00Z' },
    { subjectType: 'group', subjectId: '120363042@g.us', subjectName: 'Gym Crew', status: 'allowed', updatedAt: '2025-06-10T09:00:00Z' },
    { subjectType: 'phone', subjectId: '+15555550199', subjectName: 'Unknown Caller', status: 'blocked', updatedAt: '2026-03-15T14:00:00Z' },
    { subjectType: 'phone', subjectId: '+15555550188', subjectName: 'Spam Number', status: 'blocked', updatedAt: '2026-02-20T11:30:00Z' },
  ],

  support: [
    { subjectType: 'phone', subjectId: '+15550110', subjectName: 'Alex Chen', status: 'allowed', updatedAt: '2026-03-20T10:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550113', subjectName: 'James Wong', status: 'allowed', updatedAt: '2026-03-22T14:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550114', subjectName: 'Fatima Al-Rashid', status: 'allowed', updatedAt: '2026-03-25T08:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550118', subjectName: 'Tom Anderson', status: 'allowed', updatedAt: '2026-03-28T12:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550119', subjectName: 'Diana Reyes', status: 'allowed', updatedAt: '2026-03-29T09:00:00Z' },
    { subjectType: 'group', subjectId: '120363200@g.us', subjectName: 'Support Ops', status: 'allowed', updatedAt: '2026-01-15T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15555550177', subjectName: 'Unknown Number', status: 'pending', updatedAt: '2026-03-31T22:00:00Z' },
    { subjectType: 'phone', subjectId: '+15555550166', subjectName: 'Suspected Spam', status: 'blocked', updatedAt: '2026-03-27T15:00:00Z' },
  ],

  research: [
    { subjectType: 'phone', subjectId: '+15550115', subjectName: 'Owner', status: 'allowed', updatedAt: '2025-06-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363300@g.us', subjectName: 'Research Alerts', status: 'allowed', updatedAt: '2025-06-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363301@g.us', subjectName: 'Debug Channel', status: 'allowed', updatedAt: '2025-06-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550121', subjectName: 'Nina Park', status: 'allowed', updatedAt: '2025-07-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550122', subjectName: 'Ben Okafor', status: 'allowed', updatedAt: '2025-07-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+447700999999', subjectName: 'Unknown (EU)', status: 'blocked', updatedAt: '2026-03-31T18:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550123', subjectName: 'Jade Morris', status: 'seen', updatedAt: '2026-03-30T10:00:00Z' },
  ],

  devops: [
    { subjectType: 'phone', subjectId: '+15550116', subjectName: 'Owner', status: 'allowed', updatedAt: '2025-06-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363400@g.us', subjectName: 'CI Notifications', status: 'allowed', updatedAt: '2025-10-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363401@g.us', subjectName: 'PR Reviews', status: 'allowed', updatedAt: '2025-10-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363402@g.us', subjectName: 'Deploy Channel', status: 'allowed', updatedAt: '2025-10-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550124', subjectName: 'Jake Kim', status: 'allowed', updatedAt: '2025-10-15T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550125', subjectName: 'Rita Flores', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550199', subjectName: 'Unknown', status: 'pending', updatedAt: '2026-04-01T08:00:00Z' },
  ],

  sales: [
    { subjectType: 'phone', subjectId: '+15550120', subjectName: 'David Park', status: 'allowed', updatedAt: '2026-03-01T10:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550126', subjectName: 'Emma Johnson', status: 'allowed', updatedAt: '2026-03-05T14:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550127', subjectName: 'Raj Patel', status: 'allowed', updatedAt: '2026-03-10T08:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550128', subjectName: 'Sofia Martinez', status: 'allowed', updatedAt: '2026-03-15T12:00:00Z' },
    { subjectType: 'group', subjectId: '120363500@g.us', subjectName: 'Sales Pipeline', status: 'allowed', updatedAt: '2026-01-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550188', subjectName: 'Unverified Lead', status: 'pending', updatedAt: '2026-03-31T20:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550177', subjectName: 'Spam Lead', status: 'blocked', updatedAt: '2026-03-28T09:00:00Z' },
  ],

  intern: [
    { subjectType: 'phone', subjectId: '+15550117', subjectName: 'Owner', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550130', subjectName: 'Test User A', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550131', subjectName: 'Test User B', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363600@g.us', subjectName: 'Test Group', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550166', subjectName: 'Unknown', status: 'blocked', updatedAt: '2026-03-20T11:00:00Z' },
  ],

  staging: [
    { subjectType: 'phone', subjectId: '+15550130', subjectName: 'Tester A', status: 'allowed', updatedAt: '2026-01-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550131', subjectName: 'Tester B', status: 'allowed', updatedAt: '2026-01-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363700@g.us', subjectName: 'QA Channel', status: 'allowed', updatedAt: '2026-01-01T00:00:00Z' },
  ],

  archive: [
    { subjectType: 'group', subjectId: '120363800@g.us', subjectName: 'Old Team Chat', status: 'allowed', updatedAt: '2024-01-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363801@g.us', subjectName: 'Conference 2024', status: 'allowed', updatedAt: '2024-06-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15550140', subjectName: 'Maria (old number)', status: 'allowed', updatedAt: '2024-01-01T00:00:00Z' },
  ],
};

// ---------------------------------------------------------------------------
//  MOCK_LOGS — 15-25 entries per line
// ---------------------------------------------------------------------------

function logEntries(lineName: string, mode: Mode): LogEntry[] {
  const base: LogEntry[] = [
    { timestamp: ago(5),    level: 'info',  msg: 'Health check OK', source: 'system', component: 'health' },
    { timestamp: ago(10),   level: 'debug', msg: 'WebSocket ping/pong completed (12ms)', source: 'connection', component: 'connection' },
    { timestamp: ago(30),   level: 'info',  msg: 'SQLite WAL checkpoint completed', source: 'system', component: 'sqlite' },
    { timestamp: ago(60),   level: 'info',  msg: 'Health endpoint responded in 3ms', source: 'system', component: 'health' },
    { timestamp: ago(120),  level: 'debug', msg: 'Connection state: open', source: 'connection', component: 'connection' },
    { timestamp: ago(180),  level: 'info',  msg: `Message received from +15550200`, source: 'message', component: 'receiver' },
    { timestamp: ago(300),  level: 'info',  msg: `SQLite: ${lineName} database size: 24.3 MB`, source: 'system', component: 'sqlite' },
    { timestamp: ago(600),  level: 'debug', msg: 'Heartbeat sent to supervisor', source: 'system', component: 'supervisor' },
    { timestamp: ago(900),  level: 'info',  msg: `Access list loaded: ${MOCK_ACCESS[lineName]?.length ?? 0} entries`, source: 'auth', component: 'access' },
    { timestamp: ago(1200), level: 'info',  msg: `Instance ${lineName} started in ${mode} mode`, source: 'system', component: 'lifecycle' },
  ];

  if (mode === 'passive') {
    base.push(
      { timestamp: ago(15),   level: 'info',  msg: 'Unread count updated: 47', source: 'message', component: 'passive' },
      { timestamp: ago(45),   level: 'debug', msg: 'Message stored without processing', source: 'message', component: 'passive' },
      { timestamp: ago(150),  level: 'info',  msg: 'New message archived to SQLite', source: 'message', component: 'passive' },
      { timestamp: ago(240),  level: 'debug', msg: 'Group metadata refreshed', source: 'message', component: 'passive' },
      { timestamp: ago(500),  level: 'info',  msg: 'Contact sync completed', source: 'message', component: 'passive' },
      { timestamp: ago(700),  level: 'debug', msg: 'Media download queued', source: 'message', component: 'passive' },
      { timestamp: ago(850),  level: 'info',  msg: 'Presence update: available', source: 'message', component: 'passive' },
      { timestamp: ago(1000), level: 'debug', msg: 'Read receipts disabled per config', source: 'message', component: 'passive' },
      { timestamp: ago(1100), level: 'info',  msg: 'Passive listener initialized', source: 'message', component: 'passive' },
      { timestamp: ago(1300), level: 'debug', msg: `Socket path: /run/whatsoup/${lineName}.sock`, source: 'system', component: 'lifecycle' },
    );
  } else if (mode === 'chat') {
    base.push(
      { timestamp: ago(15),   level: 'info',  msg: 'Message queued for processing', source: 'pipeline', component: 'chat' },
      { timestamp: ago(45),   level: 'info',  msg: 'Reply generated (340 tokens, 1.2s)', source: 'pipeline', component: 'chat' },
      { timestamp: ago(90),   level: 'debug', msg: 'Enrichment: contact resolved via cache', source: 'enrichment', component: 'enrichment' },
      { timestamp: ago(200),  level: 'info',  msg: 'Reply sent successfully', source: 'pipeline', component: 'chat' },
      { timestamp: ago(350),  level: 'debug', msg: `Queue depth: 3`, source: 'pipeline', component: 'chat' },
      { timestamp: ago(500),  level: 'info',  msg: 'Template matched: order_status_inquiry', source: 'pipeline', component: 'chat' },
      { timestamp: ago(700),  level: 'debug', msg: 'Rate limiter: 47/100 messages this hour', source: 'pipeline', component: 'chat' },
      { timestamp: ago(850),  level: 'info',  msg: 'Auto-reply: business hours response', source: 'pipeline', component: 'chat' },
      { timestamp: ago(1000), level: 'debug', msg: 'Webhook delivered to integration endpoint', source: 'pipeline', component: 'chat' },
      { timestamp: ago(1100), level: 'info',  msg: 'Chat engine initialized', source: 'pipeline', component: 'chat' },
    );
  } else {
    // agent
    base.push(
      { timestamp: ago(15),   level: 'info',  msg: 'Agent session active — processing', source: 'agent', component: 'agent' },
      { timestamp: ago(45),   level: 'debug', msg: 'Tool call: send_message', source: 'agent', component: 'agent' },
      { timestamp: ago(90),   level: 'info',  msg: 'Session started for inbound from owner', source: 'agent', component: 'agent' },
      { timestamp: ago(200),  level: 'debug', msg: 'Context loaded: 14 previous messages', source: 'agent', component: 'agent' },
      { timestamp: ago(350),  level: 'info',  msg: 'Tool call: list_chats (completed in 340ms)', source: 'agent', component: 'agent' },
      { timestamp: ago(500),  level: 'debug', msg: 'Token usage: 2,847 input / 412 output', source: 'agent', component: 'agent' },
      { timestamp: ago(700),  level: 'info',  msg: 'Session completed — 14 tool calls', source: 'agent', component: 'agent' },
      { timestamp: ago(850),  level: 'debug', msg: 'Session cost: $0.042', source: 'agent', component: 'agent' },
      { timestamp: ago(1000), level: 'info',  msg: 'Agent executor ready', source: 'agent', component: 'agent' },
      { timestamp: ago(1100), level: 'debug', msg: `Model: claude-opus-4-6, max_tokens: 8192`, source: 'agent', component: 'agent' },
    );
  }

  return base.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function salesLogs(): LogEntry[] {
  const entries = logEntries('sales', 'chat');
  entries.unshift(
    { timestamp: ago(2),  level: 'warn',  msg: 'Enrichment pipeline stalled — 31 messages pending contact resolution', source: 'enrichment', component: 'enrichment' },
    { timestamp: ago(30), level: 'error', msg: 'Contact resolution API returned 429 (rate limited)', source: 'enrichment', component: 'enrichment' },
    { timestamp: ago(60), level: 'warn',  msg: 'Enrichment backlog growing: 31 unprocessed', source: 'enrichment', component: 'enrichment' },
  );
  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function internLogs(): LogEntry[] {
  const entries: LogEntry[] = [
    { timestamp: ago(7200),  level: 'error', msg: 'Auth token expired — connection closed by server', source: 'connection', component: 'connection' },
    { timestamp: ago(7140),  level: 'warn',  msg: 'Reconnection attempt 1/5 failed', source: 'connection', component: 'connection' },
    { timestamp: ago(7080),  level: 'warn',  msg: 'Reconnection attempt 2/5 failed', source: 'connection', component: 'connection' },
    { timestamp: ago(7020),  level: 'warn',  msg: 'Reconnection attempt 3/5 failed', source: 'connection', component: 'connection' },
    { timestamp: ago(6960),  level: 'error', msg: 'Reconnection attempt 4/5 failed — backoff 30s', source: 'connection', component: 'connection' },
    { timestamp: ago(6900),  level: 'error', msg: 'Reconnection attempt 5/5 failed — giving up', source: 'connection', component: 'connection' },
    { timestamp: ago(6840),  level: 'error', msg: 'Instance marked as unreachable — manual intervention required', source: 'system', component: 'lifecycle' },
    { timestamp: ago(6800),  level: 'info',  msg: 'Notifying owner of auth failure', source: 'system', component: 'lifecycle' },
    { timestamp: ago(6700),  level: 'info',  msg: 'Supervisor acknowledged unreachable state', source: 'system', component: 'supervisor' },
    { timestamp: ago(6600),  level: 'warn',  msg: '2 pending tasks paused', source: 'agent', component: 'agent' },
    { timestamp: ago(7300),  level: 'info',  msg: 'Health check OK', source: 'system', component: 'health' },
    { timestamp: ago(7350),  level: 'debug', msg: 'WebSocket ping/pong completed (15ms)', source: 'connection', component: 'connection' },
    { timestamp: ago(7400),  level: 'info',  msg: 'Agent session completed — 8 tool calls', source: 'agent', component: 'agent' },
    { timestamp: ago(7500),  level: 'debug', msg: 'Token usage: 1,923 input / 287 output', source: 'agent', component: 'agent' },
    { timestamp: ago(7600),  level: 'info',  msg: 'SQLite WAL checkpoint completed', source: 'system', component: 'sqlite' },
    { timestamp: ago(7800),  level: 'info',  msg: 'Instance intern started in agent mode', source: 'system', component: 'lifecycle' },
    { timestamp: ago(8000),  level: 'debug', msg: 'Socket path: /run/whatsoup/intern.sock', source: 'system', component: 'lifecycle' },
    { timestamp: ago(8200),  level: 'info',  msg: 'Access list loaded: 5 entries', source: 'auth', component: 'access' },
    { timestamp: ago(8400),  level: 'debug', msg: 'Model: claude-sonnet-4-6, max_tokens: 8192', source: 'agent', component: 'agent' },
    { timestamp: ago(8600),  level: 'info',  msg: 'Agent executor ready', source: 'agent', component: 'agent' },
  ];
  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export const MOCK_LOGS: Record<string, LogEntry[]> = {
  personal: logEntries('personal', 'passive'),
  support:  logEntries('support', 'chat'),
  research: logEntries('research', 'agent'),
  devops:   logEntries('devops', 'agent'),
  sales:    salesLogs(),
  intern:   internLogs(),
  staging:  logEntries('staging', 'agent'),
  archive:  logEntries('archive', 'passive'),
};

// ---------------------------------------------------------------------------
//  MOCK_SCHEDULED — 3-5 per applicable line
// ---------------------------------------------------------------------------

const NOW_SEC = Math.floor(Date.now() / 1000);

export const MOCK_SCHEDULED: Record<string, ScheduledMessage[]> = {
  support: [
    {
      id: 1, chatJid: '15550110@s.whatsapp.net', chatName: 'Alex Chen',
      contentType: 'text', payload: { text: 'Hi Alex, following up on your support ticket. Is your issue resolved?' },
      scheduledAt: NOW_SEC + 3600, recurrence: undefined,
      nextRunAt: NOW_SEC + 3600, runCount: 0, status: 'pending',
      createdAt: NOW_SEC - 7200, retryCount: 0,
    },
    {
      id: 2, chatJid: '120363200@g.us', chatName: 'Support Ops',
      contentType: 'text', payload: { text: 'Daily support summary: 47 tickets handled, avg response 3.2 min' },
      scheduledAt: NOW_SEC + 28800, recurrence: 'daily',
      nextRunAt: NOW_SEC + 28800, runCount: 14, status: 'pending',
      createdAt: NOW_SEC - 1209600, retryCount: 0,
    },
    {
      id: 3, chatJid: '15550114@s.whatsapp.net', chatName: 'Fatima Al-Rashid',
      contentType: 'text', payload: { text: 'Your appointment reminder: tomorrow at 10am.' },
      scheduledAt: NOW_SEC - 3600, runCount: 1, status: 'sent',
      createdAt: NOW_SEC - 14400, sentAt: NOW_SEC - 3600, retryCount: 0,
    },
    {
      id: 4, chatJid: '15550177@s.whatsapp.net', chatName: 'Unknown',
      contentType: 'text', payload: { text: 'Your order update' },
      scheduledAt: NOW_SEC - 7200, runCount: 0, status: 'failed',
      createdAt: NOW_SEC - 10800, error: 'Recipient not in allowlist', retryCount: 2,
    },
  ],

  research: [
    {
      id: 10, chatJid: '15550115@s.whatsapp.net', chatName: 'Owner',
      contentType: 'text', payload: { text: 'Weekly research digest: 3 reports completed, 2 in progress.' },
      scheduledAt: NOW_SEC + 172800, recurrence: 'daily',
      nextRunAt: NOW_SEC + 172800, runCount: 7, status: 'pending',
      createdAt: NOW_SEC - 604800, retryCount: 0,
    },
    {
      id: 11, chatJid: '120363301@g.us', chatName: 'Debug Channel',
      contentType: 'text', payload: { text: 'Session token refresh — re-authenticating agent credentials' },
      scheduledAt: NOW_SEC + 86400, runCount: 0, status: 'pending',
      createdAt: NOW_SEC - 3600, retryCount: 0,
    },
    {
      id: 12, chatJid: '15550121@s.whatsapp.net', chatName: 'Nina Park',
      contentType: 'text', payload: { text: 'Q2 APAC analysis complete — review when available' },
      scheduledAt: NOW_SEC - 1800, runCount: 1, status: 'sent',
      createdAt: NOW_SEC - 7200, sentAt: NOW_SEC - 1800, retryCount: 0,
    },
  ],

  devops: [
    {
      id: 20, chatJid: '120363402@g.us', chatName: 'Deploy Channel',
      contentType: 'text', payload: { text: 'Scheduled maintenance window starts in 1 hour. Expect brief downtime.' },
      scheduledAt: NOW_SEC + 3600, runCount: 0, status: 'pending',
      createdAt: NOW_SEC - 1800, retryCount: 0,
    },
    {
      id: 21, chatJid: '120363400@g.us', chatName: 'CI Notifications',
      contentType: 'text', payload: { text: 'Nightly build summary will post at midnight.' },
      scheduledAt: NOW_SEC + 43200, recurrence: 'daily',
      nextRunAt: NOW_SEC + 43200, runCount: 31, status: 'pending',
      createdAt: NOW_SEC - 2678400, retryCount: 0,
    },
    {
      id: 22, chatJid: '15550116@s.whatsapp.net', chatName: 'Owner',
      contentType: 'text', payload: { text: 'Weekly infra cost report' },
      scheduledAt: NOW_SEC - 86400, runCount: 0, status: 'cancelled',
      createdAt: NOW_SEC - 172800, retryCount: 0,
    },
    {
      id: 23, chatJid: '15550124@s.whatsapp.net', chatName: 'Jake Kim',
      contentType: 'text', payload: { text: 'Reminder: code freeze at 5pm Friday' },
      scheduledAt: NOW_SEC + 7200, runCount: 0, status: 'pending',
      createdAt: NOW_SEC - 3600, retryCount: 0,
    },
  ],

  sales: [
    {
      id: 30, chatJid: '15550120@s.whatsapp.net', chatName: 'David Park',
      contentType: 'text', payload: { text: 'Demo reminder: tomorrow at 10am!' },
      scheduledAt: NOW_SEC + 86400, runCount: 0, status: 'pending',
      createdAt: NOW_SEC - 3600, retryCount: 0,
    },
    {
      id: 31, chatJid: '120363500@g.us', chatName: 'Sales Pipeline',
      contentType: 'text', payload: { text: 'Weekly pipeline digest: 8 new leads, 2 conversions this week.' },
      scheduledAt: NOW_SEC + 259200, recurrence: 'daily',
      nextRunAt: NOW_SEC + 259200, runCount: 5, status: 'pending',
      createdAt: NOW_SEC - 2678400, retryCount: 0,
    },
    {
      id: 32, chatJid: '15550177@s.whatsapp.net', chatName: 'Spam Lead',
      contentType: 'text', payload: { text: 'Follow-up message' },
      scheduledAt: NOW_SEC - 3600, runCount: 0, status: 'failed',
      createdAt: NOW_SEC - 7200, error: 'Recipient blocked', retryCount: 3,
    },
  ],

  staging: [
    {
      id: 40, chatJid: '15550130@s.whatsapp.net', chatName: 'Tester A',
      contentType: 'text', payload: { text: 'Scheduled test message from staging' },
      scheduledAt: NOW_SEC + 1800, runCount: 0, status: 'pending',
      createdAt: NOW_SEC - 900, retryCount: 0,
    },
    {
      id: 41, chatJid: '120363700@g.us', chatName: 'QA Channel',
      contentType: 'text', payload: { text: 'Automated test run completed' },
      scheduledAt: NOW_SEC - 3600, runCount: 1, status: 'sent',
      createdAt: NOW_SEC - 7200, sentAt: NOW_SEC - 3600, retryCount: 0,
    },
  ],
};

// ---------------------------------------------------------------------------
//  MOCK_GROUPS — 3-5 per applicable line
// ---------------------------------------------------------------------------

export const MOCK_GROUPS: Record<string, GroupInfo[]> = {
  personal: [
    {
      id: '120363001@g.us', subject: 'Family Group',
      participants: [
        { id: '15550100@s.whatsapp.net', admin: 'superadmin' },
        { id: '15550200@s.whatsapp.net', admin: 'admin' },
        { id: '15550201@s.whatsapp.net' },
        { id: '15550202@s.whatsapp.net' },
      ],
      creation: Math.floor(Date.now() / 1000) - 31536000,
      desc: 'Keep in touch',
      owner: '15550200@s.whatsapp.net',
    },
    {
      id: '120363042@g.us', subject: 'Gym Crew',
      participants: [
        { id: '15550100@s.whatsapp.net', admin: 'admin' },
        { id: '15550210@s.whatsapp.net' },
        { id: '15550211@s.whatsapp.net' },
        { id: '15550212@s.whatsapp.net' },
        { id: '15550213@s.whatsapp.net' },
      ],
      creation: Math.floor(Date.now() / 1000) - 7776000,
      desc: '5am club',
      owner: '15550100@s.whatsapp.net',
    },
    {
      id: '120363043@g.us', subject: 'Neighborhood Watch',
      participants: [
        { id: '15550100@s.whatsapp.net' },
        { id: '15550220@s.whatsapp.net', admin: 'superadmin' },
        { id: '15550221@s.whatsapp.net', admin: 'admin' },
        { id: '15550222@s.whatsapp.net' },
        { id: '15550223@s.whatsapp.net' },
        { id: '15550224@s.whatsapp.net' },
      ],
      creation: Math.floor(Date.now() / 1000) - 15552000,
      owner: '15550220@s.whatsapp.net',
    },
    {
      id: '120363044@g.us', subject: 'Book Club',
      participants: [
        { id: '15550100@s.whatsapp.net', admin: 'admin' },
        { id: '15550230@s.whatsapp.net' },
        { id: '15550231@s.whatsapp.net' },
        { id: '15550232@s.whatsapp.net' },
      ],
      creation: Math.floor(Date.now() / 1000) - 5184000,
      desc: 'Monthly book club — fiction and non-fiction',
      owner: '15550100@s.whatsapp.net',
    },
  ],

  support: [
    {
      id: '120363200@g.us', subject: 'Support Ops',
      participants: [
        { id: '15550101@s.whatsapp.net', admin: 'superadmin' },
        { id: '15550240@s.whatsapp.net', admin: 'admin' },
        { id: '15550241@s.whatsapp.net' },
      ],
      creation: Math.floor(Date.now() / 1000) - 7776000,
      desc: 'Internal support operations channel',
      owner: '15550101@s.whatsapp.net',
    },
  ],

  research: [
    {
      id: '120363300@g.us', subject: 'Research Alerts',
      participants: [
        { id: '15550102@s.whatsapp.net', admin: 'superadmin' },
        { id: '15550115@s.whatsapp.net', admin: 'admin' },
        { id: '15550121@s.whatsapp.net' },
        { id: '15550122@s.whatsapp.net' },
      ],
      creation: Math.floor(Date.now() / 1000) - 15552000,
      desc: 'Research agent notifications',
      owner: '15550115@s.whatsapp.net',
    },
    {
      id: '120363301@g.us', subject: 'Debug Channel',
      participants: [
        { id: '15550102@s.whatsapp.net', admin: 'superadmin' },
        { id: '15550115@s.whatsapp.net', admin: 'admin' },
      ],
      creation: Math.floor(Date.now() / 1000) - 7776000,
      desc: 'Low-level agent debug log',
      owner: '15550115@s.whatsapp.net',
    },
  ],

  devops: [
    {
      id: '120363400@g.us', subject: 'CI Notifications',
      participants: [
        { id: '15550103@s.whatsapp.net', admin: 'superadmin' },
        { id: '15550116@s.whatsapp.net', admin: 'admin' },
        { id: '15550124@s.whatsapp.net' },
        { id: '15550125@s.whatsapp.net' },
      ],
      creation: Math.floor(Date.now() / 1000) - 10368000,
      desc: 'CI/CD pipeline alerts',
      owner: '15550116@s.whatsapp.net',
    },
    {
      id: '120363401@g.us', subject: 'PR Reviews',
      participants: [
        { id: '15550103@s.whatsapp.net', admin: 'superadmin' },
        { id: '15550124@s.whatsapp.net', admin: 'admin' },
        { id: '15550125@s.whatsapp.net' },
      ],
      creation: Math.floor(Date.now() / 1000) - 10368000,
      desc: 'Pull request review notifications',
      owner: '15550116@s.whatsapp.net',
    },
    {
      id: '120363402@g.us', subject: 'Deploy Channel',
      participants: [
        { id: '15550103@s.whatsapp.net', admin: 'superadmin' },
        { id: '15550116@s.whatsapp.net', admin: 'admin' },
        { id: '15550124@s.whatsapp.net' },
        { id: '15550125@s.whatsapp.net' },
      ],
      creation: Math.floor(Date.now() / 1000) - 10368000,
      desc: 'Deployment notifications',
      owner: '15550116@s.whatsapp.net',
    },
  ],

  sales: [
    {
      id: '120363500@g.us', subject: 'Sales Pipeline',
      participants: [
        { id: '15550104@s.whatsapp.net', admin: 'superadmin' },
        { id: '15550250@s.whatsapp.net', admin: 'admin' },
        { id: '15550251@s.whatsapp.net' },
        { id: '15550252@s.whatsapp.net' },
      ],
      creation: Math.floor(Date.now() / 1000) - 5184000,
      desc: 'Active pipeline and lead tracking',
      owner: '15550250@s.whatsapp.net',
    },
  ],

  staging: [
    {
      id: '120363700@g.us', subject: 'QA Channel',
      participants: [
        { id: '15550106@s.whatsapp.net', admin: 'superadmin' },
        { id: '15550130@s.whatsapp.net', admin: 'admin' },
        { id: '15550131@s.whatsapp.net' },
      ],
      creation: Math.floor(Date.now() / 1000) - 2592000,
      desc: 'Staging QA testing channel',
      owner: '15550130@s.whatsapp.net',
    },
  ],
};

// ---------------------------------------------------------------------------
//  MOCK_CONTACTS — 10 per line, filterable
// ---------------------------------------------------------------------------

const CONTACTS_BY_LINE: Record<string, ContactResult[]> = {
  personal: [
    { jid: '15550200@s.whatsapp.net', name: 'Mom', notify: 'Mom', number: '15550200' },
    { jid: '15550201@s.whatsapp.net', name: 'Dad', notify: 'Dad', number: '15550201' },
    { jid: '15550202@s.whatsapp.net', name: 'Alex Chen', notify: 'Alex', number: '15550202' },
    { jid: '15550203@s.whatsapp.net', name: 'Marco Rivera', notify: 'Marco', number: '15550203' },
    { jid: '15550210@s.whatsapp.net', name: 'Jake Morris', notify: 'Jake', number: '15550210' },
    { jid: '15550211@s.whatsapp.net', name: 'Priya Sharma', notify: 'Priya', number: '15550211' },
    { jid: '15550212@s.whatsapp.net', name: 'Sam Taylor', notify: 'Sam', number: '15550212' },
    { jid: '15550220@s.whatsapp.net', name: 'Linda Ross', notify: 'Linda', number: '15550220' },
    { jid: '15550230@s.whatsapp.net', name: 'Diana Wu', notify: 'Diana', number: '15550230' },
    { jid: '15550231@s.whatsapp.net', name: 'Emma Davis', notify: 'Emma', number: '15550231' },
  ],
  support: [
    { jid: '15550110@s.whatsapp.net', name: 'Alex Chen', notify: 'Alex', number: '15550110' },
    { jid: '15550113@s.whatsapp.net', name: 'James Wong', notify: 'James', number: '15550113' },
    { jid: '15550114@s.whatsapp.net', name: 'Fatima Al-Rashid', notify: 'Fatima', number: '15550114' },
    { jid: '15550118@s.whatsapp.net', name: 'Tom Anderson', notify: 'Tom', number: '15550118' },
    { jid: '15550119@s.whatsapp.net', name: 'Diana Reyes', notify: 'Diana', number: '15550119' },
    { jid: '15550126@s.whatsapp.net', name: 'Wei Zhang', notify: 'Wei', number: '15550126' },
    { jid: '15550127@s.whatsapp.net', name: 'Carlos Mendez', notify: 'Carlos', number: '15550127' },
    { jid: '15550128@s.whatsapp.net', name: 'Aisha Williams', notify: 'Aisha', number: '15550128' },
    { jid: '15550129@s.whatsapp.net', name: 'Liam O\'Brien', notify: 'Liam', number: '15550129' },
    { jid: '15550133@s.whatsapp.net', name: 'Sofia Gomez', notify: 'Sofia', number: '15550133' },
  ],
  research: [
    { jid: '15550115@s.whatsapp.net', name: 'Owner', notify: 'Owner', number: '15550115' },
    { jid: '15550121@s.whatsapp.net', name: 'Nina Park', notify: 'Nina', number: '15550121' },
    { jid: '15550122@s.whatsapp.net', name: 'Ben Okafor', notify: 'Ben', number: '15550122' },
    { jid: '15550123@s.whatsapp.net', name: 'Jade Morris', notify: 'Jade', number: '15550123' },
    { jid: '15550134@s.whatsapp.net', name: 'Luca Ferrari', notify: 'Luca', number: '15550134' },
    { jid: '15550135@s.whatsapp.net', name: 'Kai Nakamura', notify: 'Kai', number: '15550135' },
    { jid: '15550136@s.whatsapp.net', name: 'Anna Petrov', notify: 'Anna', number: '15550136' },
    { jid: '15550137@s.whatsapp.net', name: 'Mateo Lopez', notify: 'Mateo', number: '15550137' },
    { jid: '15550138@s.whatsapp.net', name: 'Yuna Kim', notify: 'Yuna', number: '15550138' },
    { jid: '15550139@s.whatsapp.net', name: 'Theo Brennan', notify: 'Theo', number: '15550139' },
  ],
  devops: [
    { jid: '15550116@s.whatsapp.net', name: 'Owner', notify: 'Owner', number: '15550116' },
    { jid: '15550124@s.whatsapp.net', name: 'Jake Kim', notify: 'Jake', number: '15550124' },
    { jid: '15550125@s.whatsapp.net', name: 'Rita Flores', notify: 'Rita', number: '15550125' },
    { jid: '15550140@s.whatsapp.net', name: 'Chris Patel', notify: 'Chris', number: '15550140' },
    { jid: '15550141@s.whatsapp.net', name: 'Morgan Lee', notify: 'Morgan', number: '15550141' },
    { jid: '15550142@s.whatsapp.net', name: 'Arun Sharma', notify: 'Arun', number: '15550142' },
    { jid: '15550143@s.whatsapp.net', name: 'Priya Nair', notify: 'Priya', number: '15550143' },
    { jid: '15550144@s.whatsapp.net', name: 'Danny Walsh', notify: 'Danny', number: '15550144' },
    { jid: '15550145@s.whatsapp.net', name: 'Zara Ahmed', notify: 'Zara', number: '15550145' },
    { jid: '15550146@s.whatsapp.net', name: 'Felix Torres', notify: 'Felix', number: '15550146' },
  ],
  sales: [
    { jid: '15550120@s.whatsapp.net', name: 'David Park', notify: 'David', number: '15550120' },
    { jid: '15550126@s.whatsapp.net', name: 'Emma Johnson', notify: 'Emma', number: '15550126' },
    { jid: '15550127@s.whatsapp.net', name: 'Raj Patel', notify: 'Raj', number: '15550127' },
    { jid: '15550128@s.whatsapp.net', name: 'Sofia Martinez', notify: 'Sofia', number: '15550128' },
    { jid: '15550150@s.whatsapp.net', name: 'Chris Taylor', notify: 'Chris', number: '15550150' },
    { jid: '15550151@s.whatsapp.net', name: 'Aisha Brown', notify: 'Aisha', number: '15550151' },
    { jid: '15550152@s.whatsapp.net', name: 'James Liu', notify: 'James', number: '15550152' },
    { jid: '15550153@s.whatsapp.net', name: 'Nadia Kowalski', notify: 'Nadia', number: '15550153' },
    { jid: '15550154@s.whatsapp.net', name: 'Omar Hassan', notify: 'Omar', number: '15550154' },
    { jid: '15550155@s.whatsapp.net', name: 'Tina Yuen', notify: 'Tina', number: '15550155' },
  ],
  intern: [
    { jid: '15550117@s.whatsapp.net', name: 'Owner', notify: 'Owner', number: '15550117' },
    { jid: '15550130@s.whatsapp.net', name: 'Test User A', notify: 'Test A', number: '15550130' },
    { jid: '15550131@s.whatsapp.net', name: 'Test User B', notify: 'Test B', number: '15550131' },
  ],
  staging: [
    { jid: '15550130@s.whatsapp.net', name: 'Tester A', notify: 'Tester A', number: '15550130' },
    { jid: '15550131@s.whatsapp.net', name: 'Tester B', notify: 'Tester B', number: '15550131' },
  ],
  archive: [],
};

// ---------------------------------------------------------------------------
//  Accessor functions (match API read-path shape)
// ---------------------------------------------------------------------------

function enrichLine(line: LineInstance): LineInstance {
  return { ...line };
}

export function getLines(): LineInstance[] {
  return MOCK_LINES.map(enrichLine);
}

export function getLine(name: string): LineInstance | undefined {
  const line = MOCK_LINES.find(l => l.name === name);
  return line ? enrichLine(line) : undefined;
}

export function getChats(name: string): ChatItem[] {
  return MOCK_CHATS[name] ?? [];
}

export function getMessages(_name: string, conversationKey: string): Message[] {
  return MOCK_MESSAGES[conversationKey] ?? [];
}

export function getAccess(name: string): AccessEntry[] {
  return MOCK_ACCESS[name] ?? [];
}

export function getLogs(name: string): LogEntry[] {
  return MOCK_LOGS[name] ?? [];
}

export function getScheduled(name: string): { count: number; messages: ScheduledMessage[] } {
  const messages = MOCK_SCHEDULED[name] ?? [];
  return { count: messages.length, messages };
}

export function getGroups(name: string): { groups: GroupInfo[] } {
  return { groups: MOCK_GROUPS[name] ?? [] };
}

export function getGroupDetail(name: string, jid: string): GroupDetail | undefined {
  const groups = MOCK_GROUPS[name] ?? [];
  const group = groups.find(g => g.id === jid);
  if (!group) return undefined;
  return {
    ...group,
    inviteLink: `https://chat.whatsapp.com/mock${jid.replace('@g.us', '')}`,
    memberAddMode: 'all_member_add',
    joinApprovalMode: 'off',
    pendingRequests: [],
  };
}

export function searchContacts(name: string, query: string): { contacts: ContactResult[] } {
  const all = CONTACTS_BY_LINE[name] ?? [];
  if (!query) return { contacts: all };
  const q = query.toLowerCase();
  const contacts = all.filter(c =>
    c.name?.toLowerCase().includes(q) ||
    c.notify?.toLowerCase().includes(q) ||
    c.number?.includes(q) ||
    c.jid.includes(q),
  );
  return { contacts };
}

export function getTyping(): { instance: string; jid: string; since: number }[] {
  return [
    { instance: 'support', jid: '15550110@s.whatsapp.net', since: Date.now() - 4000 },
    { instance: 'personal', jid: '15550202@s.whatsapp.net', since: Date.now() - 1500 },
  ];
}

export function getFeed(): FeedEvent[] {
  return MOCK_FEED;
}

export function getMetrics(name: string, range: MetricsRange): LineMetrics {
  return generateMetrics(name, range);
}

export function getFleetMetrics(range: MetricsRange): FleetMetrics {
  return generateFleetMetrics(range);
}
