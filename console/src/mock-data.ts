// ---------------------------------------------------------------------------
//  WhatSoup Console — Mock Data
//  Simulates what GET /api/lines (and related endpoints) would return.
// ---------------------------------------------------------------------------

export type Mode = 'passive' | 'chat' | 'agent';
export type Status = 'online' | 'degraded' | 'unreachable';

export interface LineInstance {
  name: string;
  phone: string;
  mode: Mode;
  status: Status;
  accessMode: string;
  healthPort: number;
  uptime: string;
  messagesTotal: number;
  health: {
    status: string;
    uptime_seconds: number;
    messages_total: number;
    connection: { state: string };
    sqlite: { messages_total: number; schema_version: number };
    runtime?: {
      passive?: { unreadCount: number; lastActivityAt: string | null };
      chat?: { queueDepth: number; enrichmentUnprocessed: number };
      agent?: {
        activeSessions: number;
        lastSessionStatus: string | null;
        lastSessionStartedAt: string | null;
      };
    };
    instance?: {
      name: string;
      mode: Mode;
      accessMode: string;
      socketPath: string | null;
    };
  } | null;
  heartbeat: ('up' | 'down' | 'slow')[];
  lastActive: string;
  error: string | null;
  unread?: number;
  queueDepth?: number;
  enrichmentUnprocessed?: number;
  activeSessions?: number;
  lastSessionStatus?: string | null;
  messagesToday?: number;
  group?: string;
}

export interface ChatItem {
  conversationKey: string;
  name: string;
  lastMessagePreview: string;
  lastMessageAt: string;
  unreadCount: number;
  isGroup: boolean;
}

export interface Message {
  pk: number;
  conversationKey: string;
  senderName: string;
  senderJid: string;
  content: string;
  timestamp: string;
  fromMe: boolean;
  type: string;
}

export interface AccessEntry {
  subjectType: 'phone' | 'group';
  subjectId: string;
  subjectName: string;
  status: 'allowed' | 'blocked' | 'pending' | 'seen';
  updatedAt: string;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  msg: string;
  source: string;
  component?: string;
}

export interface FeedEvent {
  time: string;
  mode: Mode;
  text: string;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function hb(pattern: ('up' | 'down' | 'slow')[]): ('up' | 'down' | 'slow')[] {
  const out = [...pattern];
  while (out.length < 20) out.push('up');
  return out.slice(0, 20);
}

function ago(seconds: number): string {
  const d = new Date(Date.now() - seconds * 1000);
  return d.toISOString();
}

function uptimeStr(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
//  MOCK_LINES — 11 instances
// ---------------------------------------------------------------------------

export const MOCK_LINES: LineInstance[] = [
  {
    name: 'personal',
    phone: '+1 656-622-5768',
    group: 'Personal',
    mode: 'passive',
    status: 'online',
    accessMode: 'allowAll',
    healthPort: 3100,
    uptime: uptimeStr(432000),
    messagesTotal: 18742,
    health: {
      status: 'ok',
      uptime_seconds: 432000,
      messages_total: 18742,
      connection: { state: 'open' },
      sqlite: { messages_total: 18742, schema_version: 5 },
      runtime: {
        passive: { unreadCount: 47, lastActivityAt: ago(120) },
      },
      instance: {
        name: 'personal',
        mode: 'passive',
        accessMode: 'allowAll',
        socketPath: '/run/whatsoup/personal.sock',
      },
    },
    heartbeat: hb([
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
    ]),
    lastActive: ago(120),
    error: null,
    unread: 47,
    messagesToday: 937,
  },
  {
    name: 'work',
    phone: '+1 555-0101',
    group: 'Personal',
    mode: 'passive',
    status: 'online',
    accessMode: 'allowAll',
    healthPort: 3101,
    uptime: uptimeStr(345600),
    messagesTotal: 9321,
    health: {
      status: 'ok',
      uptime_seconds: 345600,
      messages_total: 9321,
      connection: { state: 'open' },
      sqlite: { messages_total: 9321, schema_version: 5 },
      runtime: {
        passive: { unreadCount: 23, lastActivityAt: ago(300) },
      },
      instance: {
        name: 'work',
        mode: 'passive',
        accessMode: 'allowAll',
        socketPath: '/run/whatsoup/work.sock',
      },
    },
    heartbeat: hb([
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
      'up', 'up', 'up', 'up', 'up', 'up', 'slow', 'up', 'up', 'up',
    ]),
    lastActive: ago(300),
    error: null,
    unread: 23,
    messagesToday: 466,
  },
  {
    name: 'backup',
    phone: '+1 555-0102',
    group: 'Personal',
    mode: 'passive',
    status: 'online',
    accessMode: 'allowAll',
    healthPort: 3102,
    uptime: uptimeStr(518400),
    messagesTotal: 4105,
    health: {
      status: 'ok',
      uptime_seconds: 518400,
      messages_total: 4105,
      connection: { state: 'open' },
      sqlite: { messages_total: 4105, schema_version: 5 },
      runtime: {
        passive: { unreadCount: 24, lastActivityAt: ago(900) },
      },
      instance: {
        name: 'backup',
        mode: 'passive',
        accessMode: 'allowAll',
        socketPath: '/run/whatsoup/backup.sock',
      },
    },
    heartbeat: hb([
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
    ]),
    lastActive: ago(900),
    error: null,
    unread: 24,
    messagesToday: 205,
  },
  {
    name: 'besbot',
    phone: '+1 555-0200',
    group: 'BES Support',
    mode: 'chat',
    status: 'online',
    accessMode: 'allowList',
    healthPort: 3200,
    uptime: uptimeStr(172800),
    messagesTotal: 31504,
    health: {
      status: 'ok',
      uptime_seconds: 172800,
      messages_total: 31504,
      connection: { state: 'open' },
      sqlite: { messages_total: 31504, schema_version: 5 },
      runtime: {
        chat: { queueDepth: 2, enrichmentUnprocessed: 0 },
      },
      instance: {
        name: 'besbot',
        mode: 'chat',
        accessMode: 'allowList',
        socketPath: '/run/whatsoup/besbot.sock',
      },
    },
    heartbeat: hb([
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
    ]),
    lastActive: ago(15),
    error: null,
    queueDepth: 2,
    enrichmentUnprocessed: 0,
    messagesToday: 2520,
  },
  {
    name: 'salesbot',
    phone: '+1 555-0201',
    group: 'BES Support',
    mode: 'chat',
    status: 'online',
    accessMode: 'allowList',
    healthPort: 3201,
    uptime: uptimeStr(259200),
    messagesTotal: 12089,
    health: {
      status: 'ok',
      uptime_seconds: 259200,
      messages_total: 12089,
      connection: { state: 'open' },
      sqlite: { messages_total: 12089, schema_version: 5 },
      runtime: {
        chat: { queueDepth: 0, enrichmentUnprocessed: 0 },
      },
      instance: {
        name: 'salesbot',
        mode: 'chat',
        accessMode: 'allowList',
        socketPath: '/run/whatsoup/salesbot.sock',
      },
    },
    heartbeat: hb([
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
    ]),
    lastActive: ago(45),
    error: null,
    queueDepth: 0,
    enrichmentUnprocessed: 0,
    messagesToday: 967,
  },
  {
    name: 'q-agent',
    phone: '+1 555-0202',
    group: 'BES Support',
    mode: 'agent',
    status: 'online',
    accessMode: 'denyAll',
    healthPort: 3202,
    uptime: uptimeStr(86400),
    messagesTotal: 5672,
    health: {
      status: 'ok',
      uptime_seconds: 86400,
      messages_total: 5672,
      connection: { state: 'open' },
      sqlite: { messages_total: 5672, schema_version: 5 },
      runtime: {
        agent: {
          activeSessions: 1,
          lastSessionStatus: 'running',
          lastSessionStartedAt: ago(1800),
        },
      },
      instance: {
        name: 'q-agent',
        mode: 'agent',
        accessMode: 'denyAll',
        socketPath: '/run/whatsoup/q-agent.sock',
      },
    },
    heartbeat: hb([
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
    ]),
    lastActive: ago(5),
    error: null,
    activeSessions: 1,
    lastSessionStatus: 'running',
    messagesToday: 567,
  },
  {
    name: 'alex',
    phone: '+44 7700-0300',
    group: 'Friends',
    mode: 'passive',
    status: 'online',
    accessMode: 'allowAll',
    healthPort: 3300,
    uptime: uptimeStr(604800),
    messagesTotal: 2310,
    health: {
      status: 'ok',
      uptime_seconds: 604800,
      messages_total: 2310,
      connection: { state: 'open' },
      sqlite: { messages_total: 2310, schema_version: 5 },
      runtime: {
        passive: { unreadCount: 0, lastActivityAt: ago(7200) },
      },
      instance: {
        name: 'alex',
        mode: 'passive',
        accessMode: 'allowAll',
        socketPath: '/run/whatsoup/alex.sock',
      },
    },
    heartbeat: hb([
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
    ]),
    lastActive: ago(7200),
    error: null,
    unread: 0,
    messagesToday: 115,
  },
  {
    name: 'loops',
    phone: '+44 7700-0301',
    group: 'Friends',
    mode: 'agent',
    status: 'unreachable',
    accessMode: 'denyAll',
    healthPort: 3301,
    uptime: uptimeStr(0),
    messagesTotal: 870,
    health: null,
    heartbeat: hb([
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
      'up', 'up', 'up', 'slow', 'slow', 'down', 'down', 'down', 'down', 'down',
    ]),
    lastActive: ago(14400),
    error: 'auth token expired — re-scan QR to reconnect',
    activeSessions: 0,
    lastSessionStatus: 'auth_expired',
    messagesToday: 0,
  },
  {
    name: 'jordan',
    phone: '+44 7700-0302',
    group: 'Friends',
    mode: 'chat',
    status: 'online',
    accessMode: 'allowList',
    healthPort: 3302,
    uptime: uptimeStr(129600),
    messagesTotal: 7425,
    health: {
      status: 'ok',
      uptime_seconds: 129600,
      messages_total: 7425,
      connection: { state: 'open' },
      sqlite: { messages_total: 7425, schema_version: 5 },
      runtime: {
        chat: { queueDepth: 0, enrichmentUnprocessed: 0 },
      },
      instance: {
        name: 'jordan',
        mode: 'chat',
        accessMode: 'allowList',
        socketPath: '/run/whatsoup/jordan.sock',
      },
    },
    heartbeat: hb([
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
    ]),
    lastActive: ago(600),
    error: null,
    queueDepth: 0,
    enrichmentUnprocessed: 0,
    messagesToday: 594,
  },
  {
    name: 'devbot',
    phone: '+1 555-0203',
    group: 'DevOps',
    mode: 'chat',
    status: 'degraded',
    accessMode: 'allowList',
    healthPort: 3203,
    uptime: uptimeStr(43200),
    messagesTotal: 2198,
    health: {
      status: 'degraded',
      uptime_seconds: 43200,
      messages_total: 2198,
      connection: { state: 'open' },
      sqlite: { messages_total: 2198, schema_version: 5 },
      runtime: {
        chat: { queueDepth: 0, enrichmentUnprocessed: 34 },
      },
      instance: {
        name: 'devbot',
        mode: 'chat',
        accessMode: 'allowList',
        socketPath: '/run/whatsoup/devbot.sock',
      },
    },
    heartbeat: hb([
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'slow',
      'slow', 'slow', 'up', 'up', 'slow', 'up', 'slow', 'up', 'up', 'slow',
    ]),
    lastActive: ago(60),
    error: 'enrichment stale — 34 messages pending contact resolution',
    queueDepth: 0,
    enrichmentUnprocessed: 34,
    messagesToday: 176,
  },
  {
    name: 'lucy',
    phone: '+44 7700-0303',
    group: 'Family',
    mode: 'passive',
    status: 'online',
    accessMode: 'allowAll',
    healthPort: 3303,
    uptime: uptimeStr(259200),
    messagesTotal: 3410,
    health: {
      status: 'ok',
      uptime_seconds: 259200,
      messages_total: 3410,
      connection: { state: 'open' },
      sqlite: { messages_total: 3410, schema_version: 5 },
      runtime: {
        passive: { unreadCount: 12, lastActivityAt: ago(1800) },
      },
      instance: {
        name: 'lucy',
        mode: 'passive',
        accessMode: 'allowAll',
        socketPath: '/run/whatsoup/lucy.sock',
      },
    },
    heartbeat: hb([
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
      'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up',
    ]),
    lastActive: ago(1800),
    error: null,
    unread: 12,
    messagesToday: 170,
  },
];

// ---------------------------------------------------------------------------
//  MOCK_FEED — ~15 recent events
// ---------------------------------------------------------------------------

export const MOCK_FEED: FeedEvent[] = [
  { time: ago(12), mode: 'agent', text: 'q-agent: Session started — processing inbound from +1 656-622-5768' },
  { time: ago(30), mode: 'chat', text: 'besbot: Reply sent to Maria Garcia (queue depth 2 -> 1)' },
  { time: ago(45), mode: 'passive', text: 'personal: 3 new messages from "Family Group"' },
  { time: ago(90), mode: 'chat', text: 'besbot: Incoming message queued from +1 323-555-0142' },
  { time: ago(120), mode: 'passive', text: 'work: New message from Sarah Chen — "Q4 budget review attached"' },
  { time: ago(180), mode: 'chat', text: 'salesbot: Auto-reply sent to lead #4821 (follow-up sequence 2/5)' },
  { time: ago(300), mode: 'agent', text: 'loops: Health check failed — connection timeout after 10s', isError: true },
  { time: ago(360), mode: 'agent', text: 'loops: Attempting reconnection (attempt 3/5)', isError: true },
  { time: ago(420), mode: 'passive', text: 'lucy: 4 new messages from "Book Club" group' },
  { time: ago(600), mode: 'chat', text: 'jordan: Enrichment completed for 12 contacts' },
  { time: ago(900), mode: 'passive', text: 'backup: Sync completed — 24 messages archived' },
  { time: ago(1200), mode: 'agent', text: 'loops: Auth token expired — instance marked unreachable', isError: true },
  { time: ago(1800), mode: 'chat', text: 'devbot: Enrichment pipeline stalled — 34 messages pending', isError: true },
  { time: ago(2400), mode: 'passive', text: 'alex: Last activity 2h ago — no new messages' },
  { time: ago(3600), mode: 'agent', text: 'q-agent: Previous session completed — 14 tool calls, 3 WhatsApp messages sent' },
];

// ---------------------------------------------------------------------------
//  MOCK_CHATS — keyed by line name, 5-8 chats each
// ---------------------------------------------------------------------------

export const MOCK_CHATS: Record<string, ChatItem[]> = {
  personal: [
    { conversationKey: '16566225768-family', name: 'Family Group', lastMessagePreview: 'Mom: Don\'t forget Sunday dinner!', lastMessageAt: ago(120), unreadCount: 8, isGroup: true },
    { conversationKey: '16566225768-sarah', name: 'Sarah Chen', lastMessagePreview: 'See you at 3pm', lastMessageAt: ago(600), unreadCount: 2, isGroup: false },
    { conversationKey: '16566225768-marco', name: 'Marco Rossi', lastMessagePreview: 'The flight is confirmed for Thursday', lastMessageAt: ago(1800), unreadCount: 5, isGroup: false },
    { conversationKey: '16566225768-gym', name: 'Gym Buddies', lastMessagePreview: 'Jake: Anyone up for 6am tomorrow?', lastMessageAt: ago(3600), unreadCount: 12, isGroup: true },
    { conversationKey: '16566225768-priya', name: 'Priya Sharma', lastMessagePreview: 'Thanks for the recipe!', lastMessageAt: ago(7200), unreadCount: 0, isGroup: false },
    { conversationKey: '16566225768-alex', name: 'Alex Thompson', lastMessagePreview: 'Let me check and get back to you', lastMessageAt: ago(14400), unreadCount: 1, isGroup: false },
    { conversationKey: '16566225768-neighborhood', name: 'Neighborhood Watch', lastMessagePreview: 'Linda: Package stolen from my porch again', lastMessageAt: ago(21600), unreadCount: 19, isGroup: true },
  ],
  work: [
    { conversationKey: '15550101-team', name: 'Engineering Team', lastMessagePreview: 'Dave: PR #482 is ready for review', lastMessageAt: ago(300), unreadCount: 6, isGroup: true },
    { conversationKey: '15550101-boss', name: 'Rachel Kim (Manager)', lastMessagePreview: 'Can we sync at 2?', lastMessageAt: ago(600), unreadCount: 1, isGroup: false },
    { conversationKey: '15550101-ops', name: 'DevOps Alerts', lastMessagePreview: 'Deployment v3.2.1 successful', lastMessageAt: ago(1200), unreadCount: 4, isGroup: true },
    { conversationKey: '15550101-hr', name: 'HR Department', lastMessagePreview: 'Benefits enrollment deadline Friday', lastMessageAt: ago(7200), unreadCount: 1, isGroup: false },
    { conversationKey: '15550101-standup', name: 'Daily Standup', lastMessagePreview: 'You: Wrapping up the fleet module today', lastMessageAt: ago(14400), unreadCount: 0, isGroup: true },
    { conversationKey: '15550101-client', name: 'Acme Corp - Integration', lastMessagePreview: 'Their API is returning 502 again', lastMessageAt: ago(28800), unreadCount: 11, isGroup: true },
  ],
  backup: [
    { conversationKey: '15550102-archive1', name: 'Old Team Chat', lastMessagePreview: 'Archived conversation', lastMessageAt: ago(86400), unreadCount: 3, isGroup: true },
    { conversationKey: '15550102-archive2', name: 'Conference 2025', lastMessagePreview: 'Photos uploaded to drive', lastMessageAt: ago(172800), unreadCount: 7, isGroup: true },
    { conversationKey: '15550102-archive3', name: 'Project Alpha', lastMessagePreview: 'Final deliverables sent', lastMessageAt: ago(259200), unreadCount: 0, isGroup: true },
    { conversationKey: '15550102-archive4', name: 'Maria (old number)', lastMessagePreview: 'I switched to a new number', lastMessageAt: ago(345600), unreadCount: 1, isGroup: false },
    { conversationKey: '15550102-archive5', name: 'Book Recommendations', lastMessagePreview: 'Definitely read "Project Hail Mary"', lastMessageAt: ago(432000), unreadCount: 13, isGroup: true },
  ],
  besbot: [
    { conversationKey: 'besbot-maria', name: 'Maria Garcia', lastMessagePreview: 'Bot: Your appointment is confirmed for Tuesday at 10am', lastMessageAt: ago(15), unreadCount: 0, isGroup: false },
    { conversationKey: 'besbot-james', name: 'James Wilson', lastMessagePreview: 'What are your hours on Saturday?', lastMessageAt: ago(60), unreadCount: 1, isGroup: false },
    { conversationKey: 'besbot-chen', name: 'Wei Chen', lastMessagePreview: 'Bot: Here are our pricing options...', lastMessageAt: ago(300), unreadCount: 0, isGroup: false },
    { conversationKey: 'besbot-fatima', name: 'Fatima Al-Rashid', lastMessagePreview: 'Can I reschedule my appointment?', lastMessageAt: ago(900), unreadCount: 1, isGroup: false },
    { conversationKey: 'besbot-tom', name: 'Tom Anderson', lastMessagePreview: 'Bot: Thanks for your feedback! Rating: 5/5', lastMessageAt: ago(1800), unreadCount: 0, isGroup: false },
    { conversationKey: 'besbot-leads', name: 'Besbot Leads Group', lastMessagePreview: 'New lead: +1 415-555-0199', lastMessageAt: ago(3600), unreadCount: 0, isGroup: true },
  ],
  salesbot: [
    { conversationKey: 'salesbot-lead1', name: 'David Park (Lead)', lastMessagePreview: 'Bot: Following up on your demo request...', lastMessageAt: ago(45), unreadCount: 0, isGroup: false },
    { conversationKey: 'salesbot-lead2', name: 'Emma Johnson (Lead)', lastMessagePreview: 'What integrations do you support?', lastMessageAt: ago(600), unreadCount: 0, isGroup: false },
    { conversationKey: 'salesbot-lead3', name: 'Raj Patel (Lead)', lastMessagePreview: 'Bot: Great question! We integrate with...', lastMessageAt: ago(1200), unreadCount: 0, isGroup: false },
    { conversationKey: 'salesbot-lead4', name: 'Sofia Martinez (Lead)', lastMessagePreview: 'Bot: Your free trial has been activated!', lastMessageAt: ago(3600), unreadCount: 0, isGroup: false },
    { conversationKey: 'salesbot-pipeline', name: 'Sales Pipeline', lastMessagePreview: 'Bot: Weekly summary — 12 new leads, 3 conversions', lastMessageAt: ago(7200), unreadCount: 0, isGroup: true },
    { conversationKey: 'salesbot-lead5', name: 'Chris Taylor (Lead)', lastMessagePreview: 'Interested in the enterprise plan', lastMessageAt: ago(14400), unreadCount: 0, isGroup: false },
    { conversationKey: 'salesbot-lead6', name: 'Aisha Williams (Lead)', lastMessagePreview: 'Bot: Scheduling your demo for next Monday...', lastMessageAt: ago(28800), unreadCount: 0, isGroup: false },
  ],
  'q-agent': [
    { conversationKey: 'q-owner', name: 'Owner (DM)', lastMessagePreview: 'Agent: Task completed — deployed v3.2.1 to staging', lastMessageAt: ago(5), unreadCount: 0, isGroup: false },
    { conversationKey: 'q-alerts', name: 'Agent Alerts', lastMessagePreview: 'Agent: Health check passed for all 9 online instances', lastMessageAt: ago(300), unreadCount: 0, isGroup: true },
    { conversationKey: 'q-debug', name: 'Debug Channel', lastMessagePreview: 'Agent: Repair protocol completed for devbot enrichment', lastMessageAt: ago(1800), unreadCount: 0, isGroup: true },
    { conversationKey: 'q-admin', name: 'Admin Group', lastMessagePreview: 'Agent: Access request from +44 7700-9999 — auto-blocked', lastMessageAt: ago(3600), unreadCount: 0, isGroup: true },
    { conversationKey: 'q-logs', name: 'Session Logs', lastMessagePreview: 'Agent: Session #847 — 14 tool calls, 2m 34s', lastMessageAt: ago(7200), unreadCount: 0, isGroup: true },
  ],
  alex: [
    { conversationKey: 'alex-personal', name: 'Mum', lastMessagePreview: 'Call me when you get a chance', lastMessageAt: ago(7200), unreadCount: 0, isGroup: false },
    { conversationKey: 'alex-flatmates', name: 'Flatmates', lastMessagePreview: 'Alex: I\'ll grab milk on the way home', lastMessageAt: ago(14400), unreadCount: 0, isGroup: true },
    { conversationKey: 'alex-uni', name: 'Uni Friends', lastMessagePreview: 'Pub quiz Thursday?', lastMessageAt: ago(28800), unreadCount: 0, isGroup: true },
    { conversationKey: 'alex-work', name: 'Alex Work Chat', lastMessagePreview: 'Meeting moved to 3pm', lastMessageAt: ago(43200), unreadCount: 0, isGroup: true },
    { conversationKey: 'alex-dan', name: 'Dan', lastMessagePreview: 'See you at the match Saturday', lastMessageAt: ago(86400), unreadCount: 0, isGroup: false },
  ],
  loops: [
    { conversationKey: 'loops-cmd', name: 'Command Channel', lastMessagePreview: 'Agent: Connection lost — retrying...', lastMessageAt: ago(14400), unreadCount: 0, isGroup: true },
    { conversationKey: 'loops-notify', name: 'Notification Queue', lastMessagePreview: 'Agent: 3 tasks paused due to disconnect', lastMessageAt: ago(14400), unreadCount: 0, isGroup: true },
    { conversationKey: 'loops-owner', name: 'Owner (DM)', lastMessagePreview: 'Are you still running?', lastMessageAt: ago(16200), unreadCount: 1, isGroup: false },
    { conversationKey: 'loops-debug', name: 'Debug Log', lastMessagePreview: 'Agent: Auth token refresh failed (HTTP 401)', lastMessageAt: ago(14400), unreadCount: 0, isGroup: true },
    { conversationKey: 'loops-cron', name: 'Cron Results', lastMessagePreview: 'Agent: Last successful cron: 4h ago', lastMessageAt: ago(14400), unreadCount: 0, isGroup: true },
  ],
  jordan: [
    { conversationKey: 'jordan-support', name: 'Customer Support', lastMessagePreview: 'Bot: Ticket #2847 resolved', lastMessageAt: ago(600), unreadCount: 0, isGroup: true },
    { conversationKey: 'jordan-cust1', name: 'Michael Brown', lastMessagePreview: 'Bot: Your refund has been processed', lastMessageAt: ago(1800), unreadCount: 0, isGroup: false },
    { conversationKey: 'jordan-cust2', name: 'Lisa Wang', lastMessagePreview: 'When will my order arrive?', lastMessageAt: ago(3600), unreadCount: 0, isGroup: false },
    { conversationKey: 'jordan-cust3', name: 'Ahmed Hassan', lastMessagePreview: 'Bot: Tracking number: WS482910284GB', lastMessageAt: ago(7200), unreadCount: 0, isGroup: false },
    { conversationKey: 'jordan-team', name: 'Support Team', lastMessagePreview: 'Jordan handled 47 tickets today', lastMessageAt: ago(14400), unreadCount: 0, isGroup: true },
    { conversationKey: 'jordan-escalation', name: 'Escalations', lastMessagePreview: 'No open escalations', lastMessageAt: ago(28800), unreadCount: 0, isGroup: true },
  ],
  devbot: [
    { conversationKey: 'devbot-ci', name: 'CI Notifications', lastMessagePreview: 'Bot: Build #1847 passed (main)', lastMessageAt: ago(60), unreadCount: 0, isGroup: true },
    { conversationKey: 'devbot-pr', name: 'PR Reviews', lastMessagePreview: 'Bot: PR #482 approved by 2 reviewers', lastMessageAt: ago(300), unreadCount: 0, isGroup: true },
    { conversationKey: 'devbot-deploy', name: 'Deploy Channel', lastMessagePreview: 'Bot: v3.2.1 rolled out to 100% of production', lastMessageAt: ago(1200), unreadCount: 0, isGroup: true },
    { conversationKey: 'devbot-oncall', name: 'On-Call Alerts', lastMessagePreview: 'Bot: P2 alert — enrichment pipeline latency > 5s', lastMessageAt: ago(900), unreadCount: 2, isGroup: true },
    { conversationKey: 'devbot-dev1', name: 'Jake (Developer)', lastMessagePreview: 'Can you check the staging logs?', lastMessageAt: ago(3600), unreadCount: 1, isGroup: false },
    { conversationKey: 'devbot-dev2', name: 'Priya (Developer)', lastMessagePreview: 'Bot: Here\'s the error trace...', lastMessageAt: ago(7200), unreadCount: 0, isGroup: false },
  ],
  lucy: [
    { conversationKey: 'lucy-bookclub', name: 'Book Club', lastMessagePreview: 'Next month: "Klara and the Sun"', lastMessageAt: ago(1800), unreadCount: 4, isGroup: true },
    { conversationKey: 'lucy-yoga', name: 'Yoga Class', lastMessagePreview: 'Class cancelled tomorrow — instructor ill', lastMessageAt: ago(3600), unreadCount: 3, isGroup: true },
    { conversationKey: 'lucy-sister', name: 'Emma (Sister)', lastMessagePreview: 'Happy birthday to the kids!', lastMessageAt: ago(7200), unreadCount: 1, isGroup: false },
    { conversationKey: 'lucy-school', name: 'School Parents', lastMessagePreview: 'Sports day moved to next Friday', lastMessageAt: ago(14400), unreadCount: 4, isGroup: true },
    { conversationKey: 'lucy-recipe', name: 'Recipe Exchange', lastMessagePreview: 'Lucy: Try this sourdough starter method', lastMessageAt: ago(28800), unreadCount: 0, isGroup: true },
    { conversationKey: 'lucy-partner', name: 'Tom', lastMessagePreview: 'Pick up the dry cleaning?', lastMessageAt: ago(43200), unreadCount: 0, isGroup: false },
  ],
};

// ---------------------------------------------------------------------------
//  MOCK_MESSAGES — keyed by conversationKey, 10-15 messages each
// ---------------------------------------------------------------------------

function msg(
  pk: number,
  conversationKey: string,
  senderName: string,
  senderJid: string,
  content: string,
  secondsAgo: number,
  fromMe: boolean,
  type = 'text',
): Message {
  return {
    pk,
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
  '16566225768-family': [
    msg(1001, '16566225768-family', 'Mom', '16505551234@s.whatsapp.net', 'Is everyone coming Sunday?', 7200, false),
    msg(1002, '16566225768-family', 'You', '16566225768@s.whatsapp.net', 'I\'ll be there!', 7100, true),
    msg(1003, '16566225768-family', 'Dad', '16505551235@s.whatsapp.net', 'I\'m making my famous lasagna', 6900, false),
    msg(1004, '16566225768-family', 'Sister', '16505551236@s.whatsapp.net', 'Can I bring a friend?', 6600, false),
    msg(1005, '16566225768-family', 'Mom', '16505551234@s.whatsapp.net', 'Of course! The more the merrier', 6500, false),
    msg(1006, '16566225768-family', 'You', '16566225768@s.whatsapp.net', 'I\'ll bring wine', 6000, true),
    msg(1007, '16566225768-family', 'Dad', '16505551235@s.whatsapp.net', 'Get that Malbec from last time', 5400, false),
    msg(1008, '16566225768-family', 'Brother', '16505551237@s.whatsapp.net', 'Running late, save me a plate', 3600, false),
    msg(1009, '16566225768-family', 'Mom', '16505551234@s.whatsapp.net', 'Dinner is at 6pm sharp', 1800, false),
    msg(1010, '16566225768-family', 'Sister', '16505551236@s.whatsapp.net', 'My friend is vegetarian, is that ok?', 900, false),
    msg(1011, '16566225768-family', 'Dad', '16505551235@s.whatsapp.net', 'I\'ll make a veggie option too', 600, false),
    msg(1012, '16566225768-family', 'Mom', '16505551234@s.whatsapp.net', 'Don\'t forget Sunday dinner!', 120, false),
  ],
  '15550101-team': [
    msg(2001, '15550101-team', 'Dave Chen', '15551110001@s.whatsapp.net', 'PR #482 is ready — fleet module refactor', 3600, false),
    msg(2002, '15550101-team', 'You', '15550101@s.whatsapp.net', 'Looking at it now', 3500, true),
    msg(2003, '15550101-team', 'Sarah Kim', '15551110002@s.whatsapp.net', 'The CI is green on that branch', 3400, false),
    msg(2004, '15550101-team', 'You', '15550101@s.whatsapp.net', 'Nice work on the health endpoint types', 3000, true),
    msg(2005, '15550101-team', 'Dave Chen', '15551110001@s.whatsapp.net', 'Thanks! The runtime union type was tricky', 2700, false),
    msg(2006, '15550101-team', 'Mike Torres', '15551110003@s.whatsapp.net', 'Do we need a migration for the new schema?', 2400, false),
    msg(2007, '15550101-team', 'Sarah Kim', '15551110002@s.whatsapp.net', 'No, it\'s backward compatible', 2100, false),
    msg(2008, '15550101-team', 'You', '15550101@s.whatsapp.net', 'Let\'s merge after lunch and deploy to staging', 1800, true),
    msg(2009, '15550101-team', 'Dave Chen', '15551110001@s.whatsapp.net', 'Sounds good. I\'ll monitor the rollout', 1200, false),
    msg(2010, '15550101-team', 'Mike Torres', '15551110003@s.whatsapp.net', 'Heads up — staging had a memory spike earlier', 900, false),
    msg(2011, '15550101-team', 'You', '15550101@s.whatsapp.net', 'Was that from the enrichment batch job?', 600, true),
    msg(2012, '15550101-team', 'Dave Chen', '15551110001@s.whatsapp.net', 'PR #482 is ready for review', 300, false),
  ],
  'besbot-maria': [
    msg(3001, 'besbot-maria', 'Maria Garcia', '13235550142@s.whatsapp.net', 'Hi, I\'d like to book an appointment', 1800, false),
    msg(3002, 'besbot-maria', 'Besbot', '15550200@s.whatsapp.net', 'Hello Maria! I\'d be happy to help you book an appointment. What service are you looking for?', 1790, true),
    msg(3003, 'besbot-maria', 'Maria Garcia', '13235550142@s.whatsapp.net', 'A haircut and color please', 1700, false),
    msg(3004, 'besbot-maria', 'Besbot', '15550200@s.whatsapp.net', 'Great choice! We have availability:\n\n- Tuesday 10am\n- Wednesday 2pm\n- Thursday 11am\n\nWhich works best?', 1690, true),
    msg(3005, 'besbot-maria', 'Maria Garcia', '13235550142@s.whatsapp.net', 'Tuesday at 10 works', 1500, false),
    msg(3006, 'besbot-maria', 'Besbot', '15550200@s.whatsapp.net', 'Perfect! I\'ve booked you for:\n\nHaircut & Color\nTuesday, April 2nd at 10:00 AM\nStylist: Jessica\n\nWe\'ll send a reminder 24h before. Is there anything else I can help with?', 1490, true),
    msg(3007, 'besbot-maria', 'Maria Garcia', '13235550142@s.whatsapp.net', 'How much will it cost?', 1200, false),
    msg(3008, 'besbot-maria', 'Besbot', '15550200@s.whatsapp.net', 'Haircut & color starts at $85. Final price depends on hair length and color complexity. Jessica will confirm before starting.', 1190, true),
    msg(3009, 'besbot-maria', 'Maria Garcia', '13235550142@s.whatsapp.net', 'That sounds good, thanks!', 900, false),
    msg(3010, 'besbot-maria', 'Besbot', '15550200@s.whatsapp.net', 'You\'re welcome! See you Tuesday. Have a great day!', 890, true),
    msg(3011, 'besbot-maria', 'Maria Garcia', '13235550142@s.whatsapp.net', 'Actually, can I add a blowout too?', 60, false),
    msg(3012, 'besbot-maria', 'Besbot', '15550200@s.whatsapp.net', 'Your appointment is confirmed for Tuesday at 10am', 15, true),
  ],
  'q-owner': [
    msg(4001, 'q-owner', 'Owner', '16566225768@s.whatsapp.net', 'Deploy the latest to staging', 7200, false),
    msg(4002, 'q-owner', 'Q Agent', '15550202@s.whatsapp.net', 'Starting deployment of v3.2.1 to staging...', 7190, true),
    msg(4003, 'q-owner', 'Q Agent', '15550202@s.whatsapp.net', 'Build completed. Running integration tests...', 6600, true),
    msg(4004, 'q-owner', 'Q Agent', '15550202@s.whatsapp.net', 'All 47 tests passed. Deploying to staging-1 and staging-2...', 6000, true),
    msg(4005, 'q-owner', 'Q Agent', '15550202@s.whatsapp.net', 'Deployment complete. Health checks passing on both instances.\n\nstaging-1: v3.2.1 (healthy)\nstaging-2: v3.2.1 (healthy)\n\n14 tool calls, 2m 34s total.', 5400, true),
    msg(4006, 'q-owner', 'Owner', '16566225768@s.whatsapp.net', 'Check if the enrichment pipeline is working', 3600, false),
    msg(4007, 'q-owner', 'Q Agent', '15550202@s.whatsapp.net', 'Checking enrichment pipeline status across all chat instances...', 3590, true),
    msg(4008, 'q-owner', 'Q Agent', '15550202@s.whatsapp.net', 'Found issue: devbot has 34 unprocessed messages in enrichment queue. All other instances are clear.\n\nRoot cause: Contact resolution service returned 429 (rate limited) at 11:42 UTC. Pipeline stalled.\n\nShall I restart the enrichment worker for devbot?', 3300, true),
    msg(4009, 'q-owner', 'Owner', '16566225768@s.whatsapp.net', 'Yes, restart it', 1800, false),
    msg(4010, 'q-owner', 'Q Agent', '15550202@s.whatsapp.net', 'Restarting devbot enrichment worker...\n\nWorker restarted. Processing backlog: 34 messages.\nRate limit cooldown respected (60s delay between batches).\n\nWill report when complete.', 1790, true),
    msg(4011, 'q-owner', 'Q Agent', '15550202@s.whatsapp.net', 'Task completed — deployed v3.2.1 to staging', 5, true),
  ],
  'devbot-ci': [
    msg(5001, 'devbot-ci', 'Devbot', '15550203@s.whatsapp.net', 'Build #1843 started (feature/fleet-console)', 14400, true),
    msg(5002, 'devbot-ci', 'Devbot', '15550203@s.whatsapp.net', 'Build #1843 passed (2m 14s)', 14100, true),
    msg(5003, 'devbot-ci', 'Devbot', '15550203@s.whatsapp.net', 'Build #1844 started (main — merge PR #479)', 10800, true),
    msg(5004, 'devbot-ci', 'Devbot', '15550203@s.whatsapp.net', 'Build #1844 passed (1m 58s)', 10500, true),
    msg(5005, 'devbot-ci', 'Devbot', '15550203@s.whatsapp.net', 'Build #1845 started (fix/enrichment-timeout)', 7200, true),
    msg(5006, 'devbot-ci', 'Devbot', '15550203@s.whatsapp.net', 'Build #1845 FAILED — test timeout in enrichment.spec.ts', 6900, true),
    msg(5007, 'devbot-ci', 'Devbot', '15550203@s.whatsapp.net', 'Build #1846 started (fix/enrichment-timeout — retry)', 3600, true),
    msg(5008, 'devbot-ci', 'Devbot', '15550203@s.whatsapp.net', 'Build #1846 passed (2m 31s)', 3300, true),
    msg(5009, 'devbot-ci', 'Devbot', '15550203@s.whatsapp.net', 'Build #1847 started (main — merge PR #481)', 600, true),
    msg(5010, 'devbot-ci', 'Devbot', '15550203@s.whatsapp.net', 'Build #1847 passed (1m 47s)', 300, true),
    msg(5011, 'devbot-ci', 'Devbot', '15550203@s.whatsapp.net', 'Build #1847 passed (main)', 60, true),
  ],
  'lucy-bookclub': [
    msg(6001, 'lucy-bookclub', 'Sarah', '447700110001@s.whatsapp.net', 'Has everyone finished "The Midnight Library"?', 86400, false),
    msg(6002, 'lucy-bookclub', 'Lucy', '447700303@s.whatsapp.net', 'Just finished it last night — loved it!', 82800, true),
    msg(6003, 'lucy-bookclub', 'Emma', '447700110002@s.whatsapp.net', 'Same! The parallel lives concept was brilliant', 79200, false),
    msg(6004, 'lucy-bookclub', 'Kate', '447700110003@s.whatsapp.net', 'I cried at the end, not gonna lie', 75600, false),
    msg(6005, 'lucy-bookclub', 'Sarah', '447700110001@s.whatsapp.net', 'Ok so for next month I propose "Klara and the Sun"', 72000, false),
    msg(6006, 'lucy-bookclub', 'Lucy', '447700303@s.whatsapp.net', 'Ooh Ishiguro! Great pick', 68400, true),
    msg(6007, 'lucy-bookclub', 'Emma', '447700110002@s.whatsapp.net', 'I have it already, been meaning to read it', 64800, false),
    msg(6008, 'lucy-bookclub', 'Kate', '447700110003@s.whatsapp.net', 'Is it sci-fi? I\'m not big on sci-fi', 43200, false),
    msg(6009, 'lucy-bookclub', 'Sarah', '447700110001@s.whatsapp.net', 'It\'s more literary fiction with a sci-fi premise. You\'ll love it.', 36000, false),
    msg(6010, 'lucy-bookclub', 'Lucy', '447700303@s.whatsapp.net', 'Trust us Kate, it\'s beautiful', 28800, true),
    msg(6011, 'lucy-bookclub', 'Kate', '447700110003@s.whatsapp.net', 'Ok fine, I\'m in!', 14400, false),
    msg(6012, 'lucy-bookclub', 'Sarah', '447700110001@s.whatsapp.net', 'Meeting at Lucy\'s on the 28th? Same time?', 7200, false),
    msg(6013, 'lucy-bookclub', 'Emma', '447700110002@s.whatsapp.net', 'Works for me', 3600, false),
    msg(6014, 'lucy-bookclub', 'Sarah', '447700110001@s.whatsapp.net', 'Next month: "Klara and the Sun"', 1800, false),
  ],
};

// ---------------------------------------------------------------------------
//  MOCK_ACCESS — keyed by line name, 5-10 entries each
// ---------------------------------------------------------------------------

export const MOCK_ACCESS: Record<string, AccessEntry[]> = {
  personal: [
    { subjectType: 'phone', subjectId: '+16505551234', subjectName: 'Mom', status: 'allowed', updatedAt: '2025-01-15T10:00:00Z' },
    { subjectType: 'phone', subjectId: '+16505551235', subjectName: 'Dad', status: 'allowed', updatedAt: '2025-01-15T10:00:00Z' },
    { subjectType: 'group', subjectId: '120363001@g.us', subjectName: 'Family Group', status: 'allowed', updatedAt: '2025-01-15T10:00:00Z' },
    { subjectType: 'phone', subjectId: '+13235550199', subjectName: 'Unknown Caller', status: 'blocked', updatedAt: '2026-03-15T14:00:00Z' },
    { subjectType: 'group', subjectId: '120363042@g.us', subjectName: 'Gym Buddies', status: 'allowed', updatedAt: '2025-06-10T09:00:00Z' },
    { subjectType: 'phone', subjectId: '+14155550188', subjectName: 'Spam Number', status: 'blocked', updatedAt: '2026-02-20T11:30:00Z' },
  ],
  work: [
    { subjectType: 'group', subjectId: '120363100@g.us', subjectName: 'Engineering Team', status: 'allowed', updatedAt: '2025-09-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15551110001', subjectName: 'Dave Chen', status: 'allowed', updatedAt: '2025-09-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15551110002', subjectName: 'Sarah Kim', status: 'allowed', updatedAt: '2025-09-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363101@g.us', subjectName: 'DevOps Alerts', status: 'allowed', updatedAt: '2025-09-15T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15551110003', subjectName: 'Mike Torres', status: 'allowed', updatedAt: '2025-10-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+442071230000', subjectName: 'Unknown (Acme UK)', status: 'pending', updatedAt: '2026-03-30T16:00:00Z' },
    { subjectType: 'group', subjectId: '120363150@g.us', subjectName: 'Acme Corp - Integration', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
  ],
  besbot: [
    { subjectType: 'phone', subjectId: '+13235550142', subjectName: 'Maria Garcia', status: 'allowed', updatedAt: '2026-03-20T10:00:00Z' },
    { subjectType: 'phone', subjectId: '+14155550111', subjectName: 'James Wilson', status: 'allowed', updatedAt: '2026-03-22T14:00:00Z' },
    { subjectType: 'phone', subjectId: '+8613800138000', subjectName: 'Wei Chen', status: 'allowed', updatedAt: '2026-03-25T08:00:00Z' },
    { subjectType: 'phone', subjectId: '+971501234567', subjectName: 'Fatima Al-Rashid', status: 'allowed', updatedAt: '2026-03-28T12:00:00Z' },
    { subjectType: 'phone', subjectId: '+12125550199', subjectName: 'Tom Anderson', status: 'allowed', updatedAt: '2026-03-29T09:00:00Z' },
    { subjectType: 'phone', subjectId: '+14085550177', subjectName: 'Unknown Number', status: 'pending', updatedAt: '2026-03-31T22:00:00Z' },
    { subjectType: 'phone', subjectId: '+12025550166', subjectName: 'Suspected Spam', status: 'blocked', updatedAt: '2026-03-27T15:00:00Z' },
    { subjectType: 'group', subjectId: '120363200@g.us', subjectName: 'Besbot Leads Group', status: 'allowed', updatedAt: '2026-01-15T00:00:00Z' },
  ],
  salesbot: [
    { subjectType: 'phone', subjectId: '+14155550201', subjectName: 'David Park', status: 'allowed', updatedAt: '2026-03-01T10:00:00Z' },
    { subjectType: 'phone', subjectId: '+14155550202', subjectName: 'Emma Johnson', status: 'allowed', updatedAt: '2026-03-05T14:00:00Z' },
    { subjectType: 'phone', subjectId: '+919876543210', subjectName: 'Raj Patel', status: 'allowed', updatedAt: '2026-03-10T08:00:00Z' },
    { subjectType: 'phone', subjectId: '+5215512345678', subjectName: 'Sofia Martinez', status: 'allowed', updatedAt: '2026-03-15T12:00:00Z' },
    { subjectType: 'phone', subjectId: '+61412345678', subjectName: 'Chris Taylor', status: 'seen', updatedAt: '2026-03-28T16:00:00Z' },
    { subjectType: 'phone', subjectId: '+12025550303', subjectName: 'Aisha Williams', status: 'allowed', updatedAt: '2026-03-20T09:00:00Z' },
    { subjectType: 'group', subjectId: '120363210@g.us', subjectName: 'Sales Pipeline', status: 'allowed', updatedAt: '2026-01-01T00:00:00Z' },
  ],
  'q-agent': [
    { subjectType: 'phone', subjectId: '+16566225768', subjectName: 'Owner', status: 'allowed', updatedAt: '2025-06-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363300@g.us', subjectName: 'Agent Alerts', status: 'allowed', updatedAt: '2025-06-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+447700999999', subjectName: 'Unknown', status: 'blocked', updatedAt: '2026-03-31T18:00:00Z' },
    { subjectType: 'group', subjectId: '120363301@g.us', subjectName: 'Debug Channel', status: 'allowed', updatedAt: '2025-06-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363302@g.us', subjectName: 'Admin Group', status: 'allowed', updatedAt: '2025-06-01T00:00:00Z' },
  ],
  alex: [
    { subjectType: 'phone', subjectId: '+447700440001', subjectName: 'Mum', status: 'allowed', updatedAt: '2025-08-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363400@g.us', subjectName: 'Flatmates', status: 'allowed', updatedAt: '2025-09-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+447700440002', subjectName: 'Dan', status: 'allowed', updatedAt: '2025-08-15T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363401@g.us', subjectName: 'Uni Friends', status: 'allowed', updatedAt: '2025-09-15T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+447700999888', subjectName: 'Recruiter Spam', status: 'blocked', updatedAt: '2026-03-10T09:00:00Z' },
  ],
  loops: [
    { subjectType: 'group', subjectId: '120363500@g.us', subjectName: 'Command Channel', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+447700301001', subjectName: 'Owner', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363501@g.us', subjectName: 'Notification Queue', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363502@g.us', subjectName: 'Debug Log', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363503@g.us', subjectName: 'Cron Results', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
  ],
  jordan: [
    { subjectType: 'phone', subjectId: '+447700550001', subjectName: 'Michael Brown', status: 'allowed', updatedAt: '2026-02-01T10:00:00Z' },
    { subjectType: 'phone', subjectId: '+8618600001111', subjectName: 'Lisa Wang', status: 'allowed', updatedAt: '2026-02-15T14:00:00Z' },
    { subjectType: 'phone', subjectId: '+201001234567', subjectName: 'Ahmed Hassan', status: 'allowed', updatedAt: '2026-03-01T08:00:00Z' },
    { subjectType: 'group', subjectId: '120363600@g.us', subjectName: 'Support Team', status: 'allowed', updatedAt: '2025-12-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363601@g.us', subjectName: 'Escalations', status: 'allowed', updatedAt: '2025-12-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+33612345678', subjectName: 'Unknown (France)', status: 'pending', updatedAt: '2026-03-31T20:00:00Z' },
    { subjectType: 'group', subjectId: '120363602@g.us', subjectName: 'Customer Support', status: 'allowed', updatedAt: '2025-12-01T00:00:00Z' },
  ],
  devbot: [
    { subjectType: 'group', subjectId: '120363700@g.us', subjectName: 'CI Notifications', status: 'allowed', updatedAt: '2025-10-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363701@g.us', subjectName: 'PR Reviews', status: 'allowed', updatedAt: '2025-10-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363702@g.us', subjectName: 'Deploy Channel', status: 'allowed', updatedAt: '2025-10-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363703@g.us', subjectName: 'On-Call Alerts', status: 'allowed', updatedAt: '2025-10-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15551110004', subjectName: 'Jake (Developer)', status: 'allowed', updatedAt: '2025-10-15T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+15551110005', subjectName: 'Priya (Developer)', status: 'allowed', updatedAt: '2025-11-01T00:00:00Z' },
  ],
  lucy: [
    { subjectType: 'group', subjectId: '120363800@g.us', subjectName: 'Book Club', status: 'allowed', updatedAt: '2025-07-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363801@g.us', subjectName: 'Yoga Class', status: 'allowed', updatedAt: '2025-08-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+447700880001', subjectName: 'Emma (Sister)', status: 'allowed', updatedAt: '2025-07-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363802@g.us', subjectName: 'School Parents', status: 'allowed', updatedAt: '2025-09-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+447700880002', subjectName: 'Tom', status: 'allowed', updatedAt: '2025-07-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363803@g.us', subjectName: 'Recipe Exchange', status: 'allowed', updatedAt: '2025-10-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+447700999777', subjectName: 'PPI Scam', status: 'blocked', updatedAt: '2026-03-20T11:00:00Z' },
    { subjectType: 'phone', subjectId: '+447700999666', subjectName: 'Energy Scam', status: 'blocked', updatedAt: '2026-03-25T15:00:00Z' },
  ],
  backup: [
    { subjectType: 'group', subjectId: '120363900@g.us', subjectName: 'Old Team Chat', status: 'allowed', updatedAt: '2025-06-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363901@g.us', subjectName: 'Conference 2025', status: 'allowed', updatedAt: '2025-06-15T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363902@g.us', subjectName: 'Project Alpha', status: 'allowed', updatedAt: '2025-03-01T00:00:00Z' },
    { subjectType: 'phone', subjectId: '+14155550300', subjectName: 'Maria (old number)', status: 'allowed', updatedAt: '2025-01-01T00:00:00Z' },
    { subjectType: 'group', subjectId: '120363903@g.us', subjectName: 'Book Recommendations', status: 'allowed', updatedAt: '2025-04-01T00:00:00Z' },
  ],
};

// ---------------------------------------------------------------------------
//  MOCK_LOGS — keyed by line name, 20 entries each
// ---------------------------------------------------------------------------

function logEntries(lineName: string, mode: Mode): LogEntry[] {
  const base: LogEntry[] = [
    { timestamp: ago(5), level: 'info', msg: 'Health check OK', source: 'system', component: 'health' },
    { timestamp: ago(10), level: 'debug', msg: 'WebSocket ping/pong completed (12ms)', source: 'connection', component: 'connection' },
    { timestamp: ago(30), level: 'info', msg: 'SQLite WAL checkpoint completed', source: 'system', component: 'sqlite' },
    { timestamp: ago(60), level: 'info', msg: 'Health endpoint responded in 3ms', source: 'system', component: 'health' },
    { timestamp: ago(120), level: 'debug', msg: 'Connection state: open', source: 'connection', component: 'connection' },
    { timestamp: ago(180), level: 'info', msg: `Message received from ${lineName === 'personal' ? '+16505551234' : '+1555000XXXX'}`, source: 'message', component: 'receiver' },
    { timestamp: ago(300), level: 'info', msg: `SQLite: ${lineName} database size: 24.3 MB`, source: 'system', component: 'sqlite' },
    { timestamp: ago(600), level: 'debug', msg: 'Heartbeat sent to supervisor', source: 'system', component: 'supervisor' },
    { timestamp: ago(900), level: 'info', msg: `Access list loaded: ${MOCK_ACCESS[lineName]?.length ?? 0} entries`, source: 'auth', component: 'access' },
    { timestamp: ago(1200), level: 'info', msg: `Instance ${lineName} started in ${mode} mode`, source: 'system', component: 'lifecycle' },
  ];

  if (mode === 'passive') {
    base.push(
      { timestamp: ago(15), level: 'info', msg: 'Unread count updated', source: 'message', component: 'passive' },
      { timestamp: ago(45), level: 'debug', msg: 'Message stored without processing', source: 'message', component: 'passive' },
      { timestamp: ago(150), level: 'info', msg: 'New message archived to SQLite', source: 'message', component: 'passive' },
      { timestamp: ago(240), level: 'debug', msg: 'Group metadata refreshed', source: 'message', component: 'passive' },
      { timestamp: ago(500), level: 'info', msg: 'Contact sync completed', source: 'message', component: 'passive' },
      { timestamp: ago(700), level: 'debug', msg: 'Media download queued', source: 'message', component: 'passive' },
      { timestamp: ago(850), level: 'info', msg: 'Presence update: available', source: 'message', component: 'passive' },
      { timestamp: ago(1000), level: 'debug', msg: 'Read receipts disabled per config', source: 'message', component: 'passive' },
      { timestamp: ago(1100), level: 'info', msg: 'Passive listener initialized', source: 'message', component: 'passive' },
      { timestamp: ago(1300), level: 'debug', msg: `Socket path: /run/whatsoup/${lineName}.sock`, source: 'system', component: 'lifecycle' },
    );
  } else if (mode === 'chat') {
    base.push(
      { timestamp: ago(15), level: 'info', msg: 'Message queued for processing', source: 'pipeline', component: 'chat' },
      { timestamp: ago(45), level: 'info', msg: 'Reply generated (340 tokens, 1.2s)', source: 'pipeline', component: 'chat' },
      { timestamp: ago(90), level: 'debug', msg: 'Enrichment: contact resolved via API', source: 'enrichment', component: 'enrichment' },
      { timestamp: ago(200), level: 'info', msg: 'Reply sent successfully', source: 'pipeline', component: 'chat' },
      { timestamp: ago(350), level: 'debug', msg: `Queue depth: ${lineName === 'besbot' ? 2 : 0}`, source: 'pipeline', component: 'chat' },
      { timestamp: ago(500), level: 'info', msg: 'Template matched: appointment_booking', source: 'pipeline', component: 'chat' },
      { timestamp: ago(700), level: 'debug', msg: 'Rate limiter: 47/100 messages this hour', source: 'pipeline', component: 'chat' },
      { timestamp: ago(850), level: 'info', msg: 'Auto-reply: business hours response', source: 'pipeline', component: 'chat' },
      { timestamp: ago(1000), level: 'debug', msg: 'Webhook delivered to integration endpoint', source: 'pipeline', component: 'chat' },
      { timestamp: ago(1100), level: 'info', msg: 'Chat engine initialized', source: 'pipeline', component: 'chat' },
    );
  } else {
    base.push(
      { timestamp: ago(15), level: 'info', msg: 'Agent session active — processing', source: 'agent', component: 'agent' },
      { timestamp: ago(45), level: 'debug', msg: 'Tool call: send_message', source: 'agent', component: 'agent' },
      { timestamp: ago(90), level: 'info', msg: 'Session started for inbound from owner', source: 'agent', component: 'agent' },
      { timestamp: ago(200), level: 'debug', msg: 'Context loaded: 14 previous messages', source: 'agent', component: 'agent' },
      { timestamp: ago(350), level: 'info', msg: 'Tool call: list_chats (completed in 340ms)', source: 'agent', component: 'agent' },
      { timestamp: ago(500), level: 'debug', msg: 'Token usage: 2,847 input / 412 output', source: 'agent', component: 'agent' },
      { timestamp: ago(700), level: 'info', msg: 'Session completed — 14 tool calls', source: 'agent', component: 'agent' },
      { timestamp: ago(850), level: 'debug', msg: 'Session cost: $0.042', source: 'agent', component: 'agent' },
      { timestamp: ago(1000), level: 'info', msg: 'Agent executor ready', source: 'agent', component: 'agent' },
      { timestamp: ago(1100), level: 'debug', msg: 'Model: claude-opus-4-6, max_tokens: 8192', source: 'agent', component: 'agent' },
    );
  }

  return base.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function devbotLogs(): LogEntry[] {
  const entries = logEntries('devbot', 'chat');
  entries.unshift(
    { timestamp: ago(2), level: 'warn', msg: 'Enrichment pipeline stalled — 34 messages pending contact resolution', source: 'enrichment', component: 'enrichment' },
    { timestamp: ago(30), level: 'error', msg: 'Contact resolution API returned 429 (rate limited)', source: 'enrichment', component: 'enrichment' },
    { timestamp: ago(60), level: 'warn', msg: 'Enrichment backlog growing: 34 unprocessed', source: 'enrichment', component: 'enrichment' },
  );
  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function loopsLogs(): LogEntry[] {
  const entries: LogEntry[] = [
    { timestamp: ago(14400), level: 'error', msg: 'Auth token expired — connection closed by server', source: 'connection', component: 'connection' },
    { timestamp: ago(14340), level: 'warn', msg: 'Reconnection attempt 1/5 failed', source: 'connection', component: 'connection' },
    { timestamp: ago(14280), level: 'warn', msg: 'Reconnection attempt 2/5 failed', source: 'connection', component: 'connection' },
    { timestamp: ago(14220), level: 'warn', msg: 'Reconnection attempt 3/5 failed', source: 'connection', component: 'connection' },
    { timestamp: ago(14160), level: 'error', msg: 'Reconnection attempt 4/5 failed — backoff 30s', source: 'connection', component: 'connection' },
    { timestamp: ago(14100), level: 'error', msg: 'Reconnection attempt 5/5 failed — giving up', source: 'connection', component: 'connection' },
    { timestamp: ago(14040), level: 'error', msg: 'Instance marked as unreachable — manual intervention required', source: 'system', component: 'lifecycle' },
    { timestamp: ago(14000), level: 'info', msg: 'Notifying owner of auth failure', source: 'system', component: 'lifecycle' },
    { timestamp: ago(13900), level: 'info', msg: 'Supervisor acknowledged unreachable state', source: 'system', component: 'supervisor' },
    { timestamp: ago(13800), level: 'warn', msg: '3 pending tasks paused', source: 'agent', component: 'agent' },
    { timestamp: ago(14500), level: 'info', msg: 'Health check OK', source: 'system', component: 'health' },
    { timestamp: ago(14550), level: 'debug', msg: 'WebSocket ping/pong completed (15ms)', source: 'connection', component: 'connection' },
    { timestamp: ago(14600), level: 'info', msg: 'Agent session completed — 8 tool calls', source: 'agent', component: 'agent' },
    { timestamp: ago(14700), level: 'debug', msg: 'Token usage: 1,923 input / 287 output', source: 'agent', component: 'agent' },
    { timestamp: ago(14800), level: 'info', msg: 'SQLite WAL checkpoint completed', source: 'system', component: 'sqlite' },
    { timestamp: ago(15000), level: 'info', msg: 'Instance loops started in agent mode', source: 'system', component: 'lifecycle' },
    { timestamp: ago(15200), level: 'debug', msg: 'Socket path: /run/whatsoup/loops.sock', source: 'system', component: 'lifecycle' },
    { timestamp: ago(15400), level: 'info', msg: 'Access list loaded: 5 entries', source: 'auth', component: 'access' },
    { timestamp: ago(15600), level: 'debug', msg: 'Model: claude-opus-4-6, max_tokens: 8192', source: 'agent', component: 'agent' },
    { timestamp: ago(15800), level: 'info', msg: 'Agent executor ready', source: 'agent', component: 'agent' },
  ];
  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export const MOCK_LOGS: Record<string, LogEntry[]> = {
  personal: logEntries('personal', 'passive'),
  work: logEntries('work', 'passive'),
  backup: logEntries('backup', 'passive'),
  besbot: logEntries('besbot', 'chat'),
  salesbot: logEntries('salesbot', 'chat'),
  'q-agent': logEntries('q-agent', 'agent'),
  alex: logEntries('alex', 'passive'),
  loops: loopsLogs(),
  jordan: logEntries('jordan', 'chat'),
  devbot: devbotLogs(),
  lucy: logEntries('lucy', 'passive'),
};

// ---------------------------------------------------------------------------
//  Helper / accessor functions
// ---------------------------------------------------------------------------

export function getLines(): LineInstance[] {
  return MOCK_LINES;
}

export function getLine(name: string): LineInstance | undefined {
  return MOCK_LINES.find((l) => l.name === name);
}

export function getChats(name: string): ChatItem[] {
  return MOCK_CHATS[name] ?? [];
}

export function getMessages(_name: string, conversationKey: string): Message[] {
  if (MOCK_MESSAGES[conversationKey]) {
    return MOCK_MESSAGES[conversationKey];
  }
  return [];
}

export function getAccess(name: string): AccessEntry[] {
  return MOCK_ACCESS[name] ?? [];
}

export function getLogs(name: string): LogEntry[] {
  return MOCK_LOGS[name] ?? [];
}

export function getFeed(): FeedEvent[] {
  return MOCK_FEED;
}

export function computeKpis(lines: LineInstance[]): {
  connected: number;
  needAttention: number;
  unread: number;
  agentSessions: number;
  messagesToday: number;
  avgResponseMs: number;
} {
  let connected = 0;
  let needAttention = 0;
  let unread = 0;
  let agentSessions = 0;
  let messagesToday = 0;

  for (const line of lines) {
    if (line.status === 'online') connected++;
    if (line.status === 'degraded' || line.status === 'unreachable' || line.error) {
      needAttention++;
    }

    const rt = line.health?.runtime;
    if (rt?.passive) unread += rt.passive.unreadCount;
    if (rt?.agent) agentSessions += rt.agent.activeSessions;

    messagesToday += line.messagesToday ?? 0;
  }

  // Mock avg response — Phase 2 will compute from real latency data
  const avgResponseMs = 247;

  return { connected, needAttention, unread, agentSessions, messagesToday, avgResponseMs };
}
