/**
 * Behavior tests for console/src/hooks/use-fleet.ts
 *
 * Tests all exported query-option factories and hooks:
 *   getLinesQueryOptions, getLineQueryOptions, getChatsQueryOptions,
 *   getMessagesQueryOptions, useLines, useLine, useChats, useMessages,
 *   useAccess, useLogs, useTyping, useFeed, useProviderStatus, computeKpis,
 *   query-key-isolation
 *
 * Source surprises:
 *   - useRealtime().connected gates polling: connected=true → refetchInterval=false,
 *     EXCEPT useLines/useLine, which drop to a bounded POLL_LINES_WS_BACKSTOP
 *     (15s) instead of disabling entirely — #1877: a successful online→online
 *     poll updates server health/counters with no WS event, so a connected
 *     tab needs a backstop refresh.
 *   - All hooks with a `name` (or name+conversationKey) arg use `enabled: !!name`
 *   - api module wraps every call in withFallback (dev build auto-fallback)
 *   - computeKpis is re-exported from use-fleet (pass-through export)
 *   - Structural sharing functions are wired per query but return the same data shape
 *
 * Mock strategy:
 *   - vi.mock('../../console/src/lib/api') to control api return values
 *   - vi.mock('../../console/src/hooks/use-websocket') to control connected flag
 *   - Per-test fresh QueryClient (retry:0, gcTime:0) prevents cache leakage
 *
 * @vitest-environment jsdom
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Shared realtime state (mutable per test)
// ---------------------------------------------------------------------------

let wsConnected = false;

vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: wsConnected }),
}));

// ---------------------------------------------------------------------------
// API mock — use vi.hoisted so the factory closure captures the mocks object
// before the module graph is evaluated (vi.mock is hoisted to top of file).
// ---------------------------------------------------------------------------

const apiMocks = vi.hoisted(() => ({
  getLines: vi.fn(),
  getLine: vi.fn(),
  getChats: vi.fn(),
  getMessages: vi.fn(),
  getAccess: vi.fn(),
  getLogs: vi.fn(),
  getTyping: vi.fn(),
  getFeed: vi.fn(),
  getProviderStatus: vi.fn(),
}));

vi.mock('../../console/src/lib/api', () => ({
  api: apiMocks,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  getLinesQueryOptions,
  getLineQueryOptions,
  getChatsQueryOptions,
  getMessagesQueryOptions,
  useLines,
  useLine,
  useChats,
  useMessages,
  useAccess,
  useLogs,
  useTyping,
  useFeed,
  useProviderStatus,
  computeKpis,
} from '../../console/src/hooks/use-fleet';

import type {
  LineInstance,
  ChatItem,
  Message,
  AccessEntry,
  LogEntry,
  FeedEvent,
  ProviderStatus,
} from '../../console/src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 0,
        gcTime: 0,
      },
    },
  });
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

async function advanceQueryTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const LINE_1: LineInstance = {
  name: 'alpha',
  phone: '+15550001000',
  mode: 'agent',
  status: 'online',
  accessMode: 'open',
  healthPort: 9001,
  uptime: '1h',
  messagesTotal: 50,
  health: {
    status: 'ok',
    uptime_seconds: 3600,
    messages_total: 50,
    whatsapp: { connection: { state: 'open' } },
    sqlite: { messages_total: 50, schema_version: 7 },
  },
  heartbeat: ['up', 'up'],
  lastActive: '2026-05-12T00:00:00Z',
  error: null,
};

const LINE_2: LineInstance = {
  ...LINE_1,
  name: 'beta',
  status: 'degraded',
  error: 'timeout',
};

const CHAT_1: ChatItem = {
  conversationKey: 'ck-001',
  name: 'Alice',
  lastMessagePreview: 'hello',
  lastMessageAt: '2026-05-12T00:00:00Z',
  unreadCount: 2,
  isGroup: false,
};

const MSG_1: Message = {
  pk: 1,
  conversationKey: 'ck-001',
  senderName: 'Alice',
  senderJid: '15550001001@s.whatsapp.net',
  content: 'hello',
  timestamp: '2026-05-12T00:00:00Z',
  fromMe: false,
  type: 'text',
};

const ACCESS_1: AccessEntry = {
  subjectType: 'phone',
  subjectId: '15550001002@s.whatsapp.net',
  subjectName: 'Bob',
  status: 'allowed',
  updatedAt: '2026-05-12T00:00:00Z',
};

const LOG_1: LogEntry = {
  timestamp: '2026-05-12T00:00:00Z',
  level: 'info',
  msg: 'connected',
  source: 'transport',
};

const FEED_1: FeedEvent = {
  time: '2026-05-12T00:00:00Z',
  mode: 'agent',
  text: 'agent started',
};

const PROVIDER_STATUS_1: ProviderStatus = {
  primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
  fallback: {
    provider: 'openai-api',
    model: 'gpt-4o',
    keyPresent: true,
    active: false,
    activeUntil: null,
    effectiveProvider: null,
    turnsServed: 0,
    turnsEmpty: 0,
    probeAttempts: null,
    lastFallbackTurnAt: null,
    activeEntry: null,
    chain: [],
  },
  lineReachable: true,
};

beforeEach(() => {
  wsConnected = false;
  Object.values(apiMocks).forEach((m) => m.mockReset());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Query option factories
// ---------------------------------------------------------------------------

describe('getLinesQueryOptions', () => {
  it('returns query key ["lines"]', () => {
    const opts = getLinesQueryOptions();
    expect(opts.queryKey).toEqual(['lines']);
  });

  it('uses POLL_LINES (5000) as default refetchInterval', () => {
    const opts = getLinesQueryOptions();
    expect(opts.refetchInterval).toBe(5000);
  });

  it('accepts false to disable polling', () => {
    const opts = getLinesQueryOptions(false);
    expect(opts.refetchInterval).toBe(false);
  });

  it('accepts a custom interval', () => {
    const opts = getLinesQueryOptions(1000);
    expect(opts.refetchInterval).toBe(1000);
  });

  it('queryFn calls api.getLines', async () => {
    apiMocks.getLines.mockResolvedValue([LINE_1]);
    const opts = getLinesQueryOptions();
    // queryFn is bound to api.getLines
    const result = await (opts.queryFn as () => Promise<LineInstance[]>)();
    expect(result).toEqual([LINE_1]);
    expect(apiMocks.getLines).toHaveBeenCalledTimes(1);
  });
});

describe('getLineQueryOptions', () => {
  it('returns query key ["lines", name]', () => {
    const opts = getLineQueryOptions('alpha');
    expect(opts.queryKey).toEqual(['lines', 'alpha']);
  });

  it('is enabled when name is non-empty', () => {
    expect(getLineQueryOptions('alpha').enabled).toBe(true);
  });

  it('is disabled when name is empty string', () => {
    expect(getLineQueryOptions('').enabled).toBe(false);
  });

  it('queryFn calls api.getLine with the correct name', async () => {
    apiMocks.getLine.mockResolvedValue(LINE_1);
    const opts = getLineQueryOptions('alpha');
    const result = await (opts.queryFn as () => Promise<LineInstance>)();
    expect(result).toEqual(LINE_1);
    expect(apiMocks.getLine).toHaveBeenCalledWith('alpha');
  });

  it('uses POLL_LINES (5000) as default refetchInterval', () => {
    expect(getLineQueryOptions('alpha').refetchInterval).toBe(5000);
  });
});

describe('getChatsQueryOptions', () => {
  it('returns query key ["chats", name]', () => {
    expect(getChatsQueryOptions('alpha').queryKey).toEqual(['chats', 'alpha']);
  });

  it('is disabled when name is empty', () => {
    expect(getChatsQueryOptions('').enabled).toBe(false);
  });

  it('uses POLL_CHATS (5000) as default', () => {
    expect(getChatsQueryOptions('alpha').refetchInterval).toBe(5000);
  });

  it('accepts false to disable polling', () => {
    const opts = getChatsQueryOptions('alpha', false);
    expect(opts.refetchInterval).toBe(false);
  });

  it('accepts a custom interval', () => {
    const opts = getChatsQueryOptions('alpha', 1000);
    expect(opts.refetchInterval).toBe(1000);
  });

  it('queryFn calls api.getChats with the correct name', async () => {
    apiMocks.getChats.mockResolvedValue([CHAT_1]);
    const opts = getChatsQueryOptions('alpha');
    const result = await (opts.queryFn as () => Promise<ChatItem[]>)();
    expect(result).toEqual([CHAT_1]);
    expect(apiMocks.getChats).toHaveBeenCalledWith('alpha');
  });
});

describe('getMessagesQueryOptions', () => {
  it('returns query key ["messages", name, conversationKey]', () => {
    expect(getMessagesQueryOptions('alpha', 'ck-001').queryKey).toEqual([
      'messages',
      'alpha',
      'ck-001',
    ]);
  });

  it('is enabled when both name and conversationKey are non-empty', () => {
    expect(getMessagesQueryOptions('alpha', 'ck-001').enabled).toBe(true);
  });

  it('is disabled when name is empty', () => {
    expect(getMessagesQueryOptions('', 'ck-001').enabled).toBe(false);
  });

  it('is disabled when conversationKey is empty', () => {
    expect(getMessagesQueryOptions('alpha', '').enabled).toBe(false);
  });

  it('uses POLL_MESSAGES (3000) as default', () => {
    expect(getMessagesQueryOptions('alpha', 'ck-001').refetchInterval).toBe(3000);
  });

  it('accepts false to disable polling', () => {
    const opts = getMessagesQueryOptions('alpha', 'ck-001', false);
    expect(opts.refetchInterval).toBe(false);
  });

  it('accepts a custom interval', () => {
    const opts = getMessagesQueryOptions('alpha', 'ck-001', 1500);
    expect(opts.refetchInterval).toBe(1500);
  });

  it('queryFn calls api.getMessages with correct args', async () => {
    apiMocks.getMessages.mockResolvedValue([MSG_1]);
    const opts = getMessagesQueryOptions('alpha', 'ck-001');
    const result = await (opts.queryFn as () => Promise<Message[]>)();
    expect(result).toEqual([MSG_1]);
    expect(apiMocks.getMessages).toHaveBeenCalledWith('alpha', 'ck-001');
  });
});

// ---------------------------------------------------------------------------
// Hook: useLines
// ---------------------------------------------------------------------------

describe('useLines', () => {
  it('returns loading state initially with no data or error', async () => {
    apiMocks.getLines.mockReturnValue(new Promise(() => {})); // never resolves
    const client = makeClient();
    const { result } = renderHook(() => useLines(), { wrapper: wrapper(client) });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isError).toBe(false);
    expect(result.current.fetchStatus).toBe('fetching');
  });

  it('returns data on success', async () => {
    apiMocks.getLines.mockResolvedValue([LINE_1, LINE_2]);
    const client = makeClient();
    const { result } = renderHook(() => useLines(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([LINE_1, LINE_2]);
    expect(result.current.data).toHaveLength(2);
  });

  it('returns error state when api rejects', async () => {
    apiMocks.getLines.mockRejectedValue(new Error('network error'));
    const client = makeClient();
    const { result } = renderHook(() => useLines(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('network error');
  });

  it('keeps a bounded WS backstop poll when connected instead of disabling refetch (#1877 crit 1)', async () => {
    // Supersedes the old "disables polling when WS is connected" contract:
    // an online→online poll updates server health/counters with no WS event
    // (#1877), so a connected tab still needs a bounded backstop refetch.
    // The advance window (20s) is deliberately NOT the 15s bound itself, to
    // avoid a boundary race, while staying under 2x the bound so exactly one
    // extra fetch is expected.
    vi.useFakeTimers();
    wsConnected = true;
    apiMocks.getLines.mockResolvedValue([LINE_1]);
    const client = makeClient();
    const { result } = renderHook(() => useLines(), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getLines).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(20_000);
    expect(apiMocks.getLines).toHaveBeenCalledTimes(2);
  });

  it('refetches after 5000ms when WS is disconnected', async () => {
    vi.useFakeTimers();
    wsConnected = false;
    apiMocks.getLines.mockResolvedValue([LINE_1]);
    const client = makeClient();
    const { result } = renderHook(() => useLines(), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getLines).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(5_000);
    expect(apiMocks.getLines).toHaveBeenCalledTimes(2);
  });

  it('delivers a refreshed healthObservedAt/health/counters after the WS backstop bound (#1877 crit 3)', async () => {
    vi.useFakeTimers();
    wsConnected = true;
    const initial: LineInstance = {
      ...LINE_1,
      healthObservedAt: '2026-05-12T00:00:00Z',
      messagesTotal: 50,
    };
    const refreshed: LineInstance = {
      ...LINE_1,
      healthObservedAt: '2026-05-12T00:05:00Z',
      messagesTotal: 62,
    };
    apiMocks.getLines.mockResolvedValueOnce([initial]).mockResolvedValueOnce([refreshed]);
    const client = makeClient();
    const { result } = renderHook(() => useLines(), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.data).toEqual([initial]));
    await advanceQueryTimers(20_000);
    await vi.waitFor(() => expect(result.current.data).toEqual([refreshed]));
    expect(apiMocks.getLines).toHaveBeenCalledTimes(2);
  });

  it('does not burst-fetch across a reconnect flicker — cadence changes alone never trigger a fetch (#1877 crit 4)', async () => {
    vi.useFakeTimers();
    wsConnected = true;
    apiMocks.getLines.mockResolvedValue([LINE_1]);
    const client = makeClient();
    const { result, rerender } = renderHook(() => useLines(), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getLines).toHaveBeenCalledTimes(1);

    // Flicker disconnect -> reconnect several times with no time elapsed.
    // Only elapsed time against the active interval should ever cause a
    // fetch — re-deriving refetchInterval on every render must not.
    wsConnected = false;
    rerender();
    wsConnected = true;
    rerender();
    wsConnected = false;
    rerender();
    wsConnected = true;
    rerender();
    expect(apiMocks.getLines).toHaveBeenCalledTimes(1);

    // Settled reconnected: still bounded to one fetch per backstop window,
    // not one per flicker.
    await advanceQueryTimers(20_000);
    expect(apiMocks.getLines).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Hook: useLine
// ---------------------------------------------------------------------------

describe('useLine', () => {
  it('does not fetch when name is empty', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useLine(''), { wrapper: wrapper(client) });
    // enabled=false → stays in loading state without calling api
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiMocks.getLine).not.toHaveBeenCalled();
  });

  it('fetches successfully for a valid name', async () => {
    apiMocks.getLine.mockResolvedValue(LINE_1);
    const client = makeClient();
    const { result } = renderHook(() => useLine('alpha'), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(LINE_1);
    expect(result.current.data?.name).toBe('alpha');
  });

  it('surfaces API errors', async () => {
    apiMocks.getLine.mockRejectedValue(new Error('not found'));
    const client = makeClient();
    const { result } = renderHook(() => useLine('missing'), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('not found');
  });

  it('keeps a bounded WS backstop poll when connected instead of disabling refetch (#1877 crit 1)', async () => {
    // Mirrors the useLines rewrite above — the 20s advance is deliberately
    // NOT the 15s bound itself, to avoid a boundary race.
    vi.useFakeTimers();
    wsConnected = true;
    apiMocks.getLine.mockResolvedValue(LINE_1);
    const client = makeClient();
    const { result } = renderHook(() => useLine('alpha'), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getLine).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(20_000);
    expect(apiMocks.getLine).toHaveBeenCalledTimes(2);
  });

  it('refetches after 5000ms when WS disconnected', async () => {
    vi.useFakeTimers();
    wsConnected = false;
    apiMocks.getLine.mockResolvedValue(LINE_1);
    const client = makeClient();
    const { result } = renderHook(() => useLine('alpha'), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getLine).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(5_000);
    expect(apiMocks.getLine).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Hook: useChats
// ---------------------------------------------------------------------------

describe('useChats', () => {
  it('does not fetch when name is empty', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useChats(''), { wrapper: wrapper(client) });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiMocks.getChats).not.toHaveBeenCalled();
  });

  it('returns chat list on success', async () => {
    apiMocks.getChats.mockResolvedValue([CHAT_1]);
    const client = makeClient();
    const { result } = renderHook(() => useChats('alpha'), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].conversationKey).toBe('ck-001');
    expect(result.current.data?.[0].name).toBe('Alice');
    expect(result.current.data?.[0].unreadCount).toBe(2);
  });

  it('surfaces API errors', async () => {
    apiMocks.getChats.mockRejectedValue(new Error('forbidden'));
    const client = makeClient();
    const { result } = renderHook(() => useChats('alpha'), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('forbidden');
  });

  it('disables polling when WS connected', async () => {
    vi.useFakeTimers();
    wsConnected = true;
    apiMocks.getChats.mockResolvedValue([CHAT_1]);
    const client = makeClient();
    const { result } = renderHook(() => useChats('alpha'), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getChats).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(15_000);
    expect(apiMocks.getChats).toHaveBeenCalledTimes(1);
  });

  it('refetches after 5000ms when WS disconnected', async () => {
    vi.useFakeTimers();
    wsConnected = false;
    apiMocks.getChats.mockResolvedValue([CHAT_1]);
    const client = makeClient();
    const { result } = renderHook(() => useChats('alpha'), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getChats).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(5_000);
    expect(apiMocks.getChats).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Hook: useMessages
// ---------------------------------------------------------------------------

describe('useMessages', () => {
  it('does not fetch when name is empty', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useMessages('', 'ck-001'), {
      wrapper: wrapper(client),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiMocks.getMessages).not.toHaveBeenCalled();
  });

  it('does not fetch when conversationKey is empty', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useMessages('alpha', ''), {
      wrapper: wrapper(client),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiMocks.getMessages).not.toHaveBeenCalled();
  });

  it('returns messages on success', async () => {
    apiMocks.getMessages.mockResolvedValue([MSG_1]);
    const client = makeClient();
    const { result } = renderHook(() => useMessages('alpha', 'ck-001'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].pk).toBe(1);
    expect(result.current.data?.[0].content).toBe('hello');
    expect(result.current.data?.[0].fromMe).toBe(false);
  });

  it('returns empty array when API returns empty', async () => {
    apiMocks.getMessages.mockResolvedValue([]);
    const client = makeClient();
    const { result } = renderHook(() => useMessages('alpha', 'ck-001'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(0);
  });

  it('refetches after 3000ms when WS disconnected', async () => {
    vi.useFakeTimers();
    wsConnected = false;
    apiMocks.getMessages.mockResolvedValue([MSG_1]);
    const client = makeClient();
    const { result } = renderHook(() => useMessages('alpha', 'ck-001'), {
      wrapper: wrapper(client),
    });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getMessages).toHaveBeenCalledWith('alpha', 'ck-001');
    expect(apiMocks.getMessages).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(3_000);
    expect(apiMocks.getMessages).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Hook: useAccess
// ---------------------------------------------------------------------------

describe('useAccess', () => {
  it('does not fetch when name is empty', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useAccess(''), { wrapper: wrapper(client) });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiMocks.getAccess).not.toHaveBeenCalled();
  });

  it('returns access list on success', async () => {
    apiMocks.getAccess.mockResolvedValue([ACCESS_1]);
    const client = makeClient();
    const { result } = renderHook(() => useAccess('alpha'), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].subjectType).toBe('phone');
    expect(result.current.data?.[0].status).toBe('allowed');
  });

  it('uses query key ["access", name]', async () => {
    apiMocks.getAccess.mockResolvedValue([ACCESS_1]);
    const client = makeClient();
    renderHook(() => useAccess('alpha'), { wrapper: wrapper(client) });
    // Verify cache key by checking what the client has cached after success
    await waitFor(() =>
      expect(client.getQueryState(['access', 'alpha'])).toBeDefined(),
    );
  });

  it('has no polling interval configured (no WS dependency)', async () => {
    vi.useFakeTimers();
    apiMocks.getAccess.mockResolvedValue([]);
    const client = makeClient();
    const { result } = renderHook(() => useAccess('alpha'), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
    expect(apiMocks.getAccess).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(60_000);
    expect(apiMocks.getAccess).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Hook: useLogs
// ---------------------------------------------------------------------------

describe('useLogs', () => {
  it('does not fetch when name is empty', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useLogs(''), { wrapper: wrapper(client) });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiMocks.getLogs).not.toHaveBeenCalled();
  });

  it('returns logs on success', async () => {
    apiMocks.getLogs.mockResolvedValue([LOG_1]);
    const client = makeClient();
    const { result } = renderHook(() => useLogs('alpha'), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].level).toBe('info');
    expect(result.current.data?.[0].msg).toBe('connected');
  });

  it('surfaces API errors', async () => {
    apiMocks.getLogs.mockRejectedValue(new Error('unauthorized'));
    const client = makeClient();
    const { result } = renderHook(() => useLogs('alpha'), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('unauthorized');
  });

  it('disables polling when WS connected', async () => {
    vi.useFakeTimers();
    wsConnected = true;
    apiMocks.getLogs.mockResolvedValue([LOG_1]);
    const client = makeClient();
    const { result } = renderHook(() => useLogs('alpha'), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getLogs).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(9_000);
    expect(apiMocks.getLogs).toHaveBeenCalledTimes(1);
  });

  it('refetches after 3000ms when WS disconnected', async () => {
    vi.useFakeTimers();
    wsConnected = false;
    apiMocks.getLogs.mockResolvedValue([LOG_1]);
    const client = makeClient();
    const { result } = renderHook(() => useLogs('alpha'), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getLogs).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(3_000);
    expect(apiMocks.getLogs).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Hook: useTyping
// ---------------------------------------------------------------------------

describe('useTyping', () => {
  it('returns typing data on success', async () => {
    const typing = [{ instance: 'alpha', jid: '15550001003@s.whatsapp.net', since: 1715000000 }];
    apiMocks.getTyping.mockResolvedValue(typing);
    const client = makeClient();
    const { result } = renderHook(() => useTyping(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].instance).toBe('alpha');
  });

  it('uses query key ["typing"]', async () => {
    apiMocks.getTyping.mockResolvedValue([]);
    const client = makeClient();
    renderHook(() => useTyping(), { wrapper: wrapper(client) });
    await waitFor(() => expect(client.getQueryState(['typing'])).toBeDefined());
  });

  it('is always enabled (no name gate)', async () => {
    apiMocks.getTyping.mockResolvedValue([]);
    const client = makeClient();
    const { result } = renderHook(() => useTyping(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getTyping).toHaveBeenCalledTimes(1);
  });

  it('disables polling when WS connected', async () => {
    vi.useFakeTimers();
    wsConnected = true;
    apiMocks.getTyping.mockResolvedValue([]);
    const client = makeClient();
    const { result } = renderHook(() => useTyping(), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getTyping).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(6_000);
    expect(apiMocks.getTyping).toHaveBeenCalledTimes(1);
  });

  it('refetches after 2000ms when WS disconnected', async () => {
    vi.useFakeTimers();
    wsConnected = false;
    apiMocks.getTyping.mockResolvedValue([]);
    const client = makeClient();
    const { result } = renderHook(() => useTyping(), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getTyping).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(2_000);
    expect(apiMocks.getTyping).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Hook: useFeed
// ---------------------------------------------------------------------------

describe('useFeed', () => {
  it('returns feed events on success', async () => {
    apiMocks.getFeed.mockResolvedValue([FEED_1]);
    const client = makeClient();
    const { result } = renderHook(() => useFeed(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].text).toBe('agent started');
    expect(result.current.data?.[0].mode).toBe('agent');
  });

  it('uses query key ["feed"]', async () => {
    apiMocks.getFeed.mockResolvedValue([]);
    const client = makeClient();
    renderHook(() => useFeed(), { wrapper: wrapper(client) });
    await waitFor(() => expect(client.getQueryState(['feed'])).toBeDefined());
  });

  it('is always enabled (no name gate)', async () => {
    apiMocks.getFeed.mockResolvedValue([]);
    const client = makeClient();
    const { result } = renderHook(() => useFeed(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getFeed).toHaveBeenCalledTimes(1);
  });

  it('disables polling when WS connected', async () => {
    vi.useFakeTimers();
    wsConnected = true;
    apiMocks.getFeed.mockResolvedValue([FEED_1]);
    const client = makeClient();
    const { result } = renderHook(() => useFeed(), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getFeed).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(15_000);
    expect(apiMocks.getFeed).toHaveBeenCalledTimes(1);
  });

  it('refetches after 5000ms when WS disconnected', async () => {
    vi.useFakeTimers();
    wsConnected = false;
    apiMocks.getFeed.mockResolvedValue([FEED_1]);
    const client = makeClient();
    const { result } = renderHook(() => useFeed(), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getFeed).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(5_000);
    expect(apiMocks.getFeed).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Hook: useProviderStatus
// ---------------------------------------------------------------------------

describe('useProviderStatus', () => {
  it('does not fetch when name is empty', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useProviderStatus(''), { wrapper: wrapper(client) });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiMocks.getProviderStatus).not.toHaveBeenCalled();
  });

  it('returns provider status on success', async () => {
    apiMocks.getProviderStatus.mockResolvedValue(PROVIDER_STATUS_1);
    const client = makeClient();
    const { result } = renderHook(() => useProviderStatus('alpha'), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.fallback.provider).toBe('openai-api');
    expect(apiMocks.getProviderStatus).toHaveBeenCalledWith('alpha');
  });

  it('keeps polling while WS is connected because fallback health changes do not always emit instance_status', async () => {
    vi.useFakeTimers();
    wsConnected = true;
    apiMocks.getProviderStatus.mockResolvedValue(PROVIDER_STATUS_1);
    const client = makeClient();
    const { result } = renderHook(() => useProviderStatus('alpha'), { wrapper: wrapper(client) });
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMocks.getProviderStatus).toHaveBeenCalledTimes(1);
    await advanceQueryTimers(5_000);
    expect(apiMocks.getProviderStatus).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// computeKpis re-export
// ---------------------------------------------------------------------------

describe('computeKpis (re-exported from use-fleet)', () => {
  it('counts connected lines by status=online', () => {
    const kpis = computeKpis([LINE_1, LINE_2]);
    expect(kpis.connected).toBe(1);
  });

  it('counts needAttention for degraded+error lines', () => {
    const kpis = computeKpis([LINE_1, LINE_2]);
    // LINE_2 is degraded AND has error — counts once per needAttention logic
    expect(kpis.needAttention).toBe(1);
  });

  it('returns zero kpis for empty array', () => {
    const kpis = computeKpis([]);
    expect(kpis.connected).toBe(0);
    expect(kpis.needAttention).toBe(0);
    expect(kpis.unread).toBe(0);
    expect(kpis.agentSessions).toBe(0);
    expect(kpis.totalSent).toBe(0);
    expect(kpis.totalReceived).toBe(0);
    expect(kpis.totalMedia).toBe(0);
  });

  it('sums messageStats across lines', () => {
    const lineWithStats: LineInstance = {
      ...LINE_1,
      messageStats: { sent: 10, received: 20, images: 1, audio: 2, documents: 3 },
    };
    const kpis = computeKpis([lineWithStats]);
    expect(kpis.totalSent).toBe(10);
    expect(kpis.totalReceived).toBe(20);
    expect(kpis.totalMedia).toBe(6);
  });

  it('sums unread from passive runtime health', () => {
    const lineWithUnread: LineInstance = {
      ...LINE_1,
      health: {
        ...LINE_1.health!,
        runtime: {
          passive: { unreadCount: 5, lastActivityAt: null },
        },
      },
    };
    const kpis = computeKpis([lineWithUnread]);
    expect(kpis.unread).toBe(5);
  });

  it('sums agentSessions from agent runtime health', () => {
    const lineWithAgent: LineInstance = {
      ...LINE_1,
      health: {
        ...LINE_1.health!,
        runtime: {
          agent: { activeSessions: 3, lastSessionStatus: null, lastSessionStartedAt: null },
        },
      },
    };
    const kpis = computeKpis([lineWithAgent]);
    expect(kpis.agentSessions).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Query key isolation — parallel hooks don't share cache
// ---------------------------------------------------------------------------

describe('query key isolation', () => {
  it('useChats("alpha") and useChats("beta") use distinct cache entries', async () => {
    apiMocks.getChats
      .mockResolvedValueOnce([CHAT_1])
      .mockResolvedValueOnce([{ ...CHAT_1, conversationKey: 'ck-002', name: 'Beta Chat' }]);
    const client = makeClient();
    const { result: r1 } = renderHook(() => useChats('alpha'), { wrapper: wrapper(client) });
    const { result: r2 } = renderHook(() => useChats('beta'), { wrapper: wrapper(client) });
    await waitFor(() => expect(r1.current.isSuccess && r2.current.isSuccess).toBe(true));
    expect(r1.current.data?.[0].name).toBe('Alice');
    expect(r2.current.data?.[0].name).toBe('Beta Chat');
  });

  it('useLine("alpha") and useLines() share no cache (different keys)', async () => {
    apiMocks.getLine.mockResolvedValue(LINE_1);
    apiMocks.getLines.mockResolvedValue([LINE_1, LINE_2]);
    const client = makeClient();
    const { result: rSingle } = renderHook(() => useLine('alpha'), { wrapper: wrapper(client) });
    const { result: rAll } = renderHook(() => useLines(), { wrapper: wrapper(client) });
    await waitFor(() => expect(rSingle.current.isSuccess && rAll.current.isSuccess).toBe(true));
    expect(rSingle.current.data?.name).toBe('alpha');
    expect(rAll.current.data).toHaveLength(2);
  });
});
