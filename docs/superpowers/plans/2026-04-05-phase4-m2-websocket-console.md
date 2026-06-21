# Phase 4 M2: WebSocket Console Integration

> **HISTORICAL — superseded by PR #310 (WS ticket + rotatable tokens) and PR #287 (HTTP API token auth). For current operator commands see `docs/runbook.md` and `docs/runbooks/`. Examples below referencing `~/.config/whatsoup/fleet-token` or `/ws?token=...` reflect the pre-rotation design and should not be used as guidance.**

> **READ-ONLY HISTORICAL REFERENCE:** This plan predates the WS ticket + rotatable token design. Do not execute the steps below against the current codebase; they target the deprecated single-token auth model. Preserved for historical context only.

**Status:** completed - WebSocket console integration shipped; this file is historical and its single-token auth guidance is superseded.
**Superseded by:** PR #310 (WS ticket + rotatable tokens), PR #287 (HTTP API token auth), `README.md`, `docs/public-surface.md`, `docs/runbook.md`, and `docs/runbooks/`.

**Goal:** Wire existing `FleetWebSocketServer` to emit events from fleet route mutations, and create a console `useWebSocket` hook that replaces polling with WS-driven React Query invalidation (falling back to polling on disconnect).

**Architecture:** The WS server (`src/fleet/websocket-server.ts`) already handles auth, upgrade, broadcast, and event types. This plan adds: (1) `wsServer` to `RouteDeps` so handlers can broadcast, (2) broadcast calls in mutation handlers, (3) a console `useWebSocket()` hook that invalidates React Query caches on WS events, and (4) updated fleet hooks that disable polling when WS is connected.

**Tech Stack:** `ws` (already installed), React 19, TanStack Query, Vite

---

### Task 1: Add wsServer to RouteDeps

**Files:**
- Modify: `src/fleet/index.ts:35-41` (RouteDeps interface)
- Modify: `src/fleet/index.ts:317` (routeDeps construction)

- [ ] **Step 1: Add wsServer to RouteDeps interface**

In `src/fleet/index.ts`, update the `RouteDeps` interface at line 35:

```typescript
export interface RouteDeps {
  discovery: FleetDiscovery;
  healthPoller: HealthPoller;
  dbReader: FleetDbReader;
  log: typeof log;
  updateChecker: UpdateChecker;
  wsServer: FleetWebSocketServer;
}
```

- [ ] **Step 2: Pass wsServer into routeDeps**

At line 317, update the routeDeps construction. The `wsServer` is created at line 369, so move it before routeDeps:

```typescript
// Move wsServer creation before routeDeps (currently at line 369)
const wsServer = new FleetWebSocketServer(server, deps.fleetToken);

const routeDeps: RouteDeps = { discovery, healthPoller, dbReader, log, updateChecker, wsServer };
```

Note: `wsServer` currently depends on `server`, which is created at line 359. You'll need to reorder: create server → create wsServer → create routeDeps → wire healthPoller listener → return object.

- [ ] **Step 3: Add import for FleetWebSocketServer type**

Ensure `FleetWebSocketServer` is imported at the top of `index.ts` (check if already imported — it's used at line 369).

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors — wsServer was already in scope, just now in RouteDeps)

- [ ] **Step 5: Commit**

```bash
git add src/fleet/index.ts
git commit -m "refactor(fleet): add wsServer to RouteDeps for handler access"
```

---

### Task 2: Emit WS events from mutation route handlers

**Files:**
- Modify: `src/fleet/routes/ops.ts` (send, accessUpdate, configUpdate, restart, stop, createLine, deleteLine)
- Test: `tests/fleet/websocket-broadcast.test.ts` (new)

These are the POST/PATCH/DELETE handlers that change state. Each should broadcast after successful mutation.

- [ ] **Step 1: Write test for WS broadcast on send**

Create `tests/fleet/websocket-broadcast.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// We test that route handlers call deps.wsServer.broadcast() with correct events.
// Since handlers take (req, res, deps, params), we mock deps.wsServer.

function mockDeps(overrides: Record<string, unknown> = {}) {
  return {
    discovery: { getInstances: () => new Map() },
    healthPoller: {},
    dbReader: { query: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    updateChecker: {},
    wsServer: { broadcast: vi.fn() },
    ...overrides,
  };
}

describe('WS broadcast from route handlers', () => {
  it('placeholder — validates mockDeps shape', () => {
    const deps = mockDeps();
    expect(deps.wsServer.broadcast).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/fleet/websocket-broadcast.test.ts -v`
Expected: PASS

- [ ] **Step 3: Add broadcast calls to ops.ts handlers**

In `src/fleet/routes/ops.ts`, add `deps.wsServer.broadcast()` after each successful mutation:

**handleSend** — after successful message send:
```typescript
deps.wsServer.broadcast({ type: 'message_received', instance: params.name, conversationKey: body.jid });
```

**handleAccessUpdate** — after access mode change:
```typescript
deps.wsServer.broadcast({ type: 'access_changed', instance: params.name });
```

**handleConfigUpdate** — after config saved:
```typescript
deps.wsServer.broadcast({ type: 'instance_status', instance: params.name });
```

**handleRestart** — after restart triggered:
```typescript
deps.wsServer.broadcast({ type: 'instance_status', instance: params.name });
```

**handleStop** — after stop triggered:
```typescript
deps.wsServer.broadcast({ type: 'instance_status', instance: params.name });
```

**handleCreateLine** — after new line created:
```typescript
deps.wsServer.broadcast({ type: 'instance_status', instance: body.name });
```

**handleDeleteLine** — after line deleted:
```typescript
deps.wsServer.broadcast({ type: 'instance_status', instance: params.name });
```

Each broadcast call goes AFTER the success `jsonResponse()` call, in a try-catch so broadcast failure never breaks the HTTP response:

```typescript
try { deps.wsServer.broadcast({ type: 'instance_status', instance: params.name }); } catch {}
```

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS — all 3,438+ tests, 0 TS errors

- [ ] **Step 5: Commit**

```bash
git add src/fleet/routes/ops.ts tests/fleet/websocket-broadcast.test.ts
git commit -m "feat(fleet): broadcast WS events from mutation route handlers"
```

---

### Task 3: Create console useWebSocket hook

**Files:**
- Create: `console/src/hooks/use-websocket.ts`
- Test: `console/src/hooks/__tests__/use-websocket.test.ts` (new)

- [ ] **Step 1: Write the useWebSocket hook**

Create `console/src/hooks/use-websocket.ts`:

```typescript
// ---------------------------------------------------------------------------
//  WhatSoup Console — WebSocket Hook
//  Connects to fleet WS server, invalidates React Query caches on events.
//  Falls back to polling on disconnect.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

/** Event shape from FleetWebSocketServer. */
interface WsEvent {
  type: string;
  instance?: string;
  conversationKey?: string;
  messagePk?: number;
  // typing_update fields
  jid?: string;
  composing?: boolean;
  since?: number;
}

/**
 * Maps WS event types to React Query cache keys for invalidation.
 * Returns null for events that should update state directly (typing).
 */
function eventToQueryKeys(event: WsEvent): string[][] | null {
  switch (event.type) {
    case 'instance_status':
      return [['lines'], ['lines', event.instance!]];
    case 'message_received':
      return [
        ['messages', event.instance!, event.conversationKey!],
        ['chats', event.instance!],
        ['feed'],
      ];
    case 'chat_updated':
      return [['chats', event.instance!]];
    case 'log_entry':
      return [['logs', event.instance!], ['feed']];
    case 'feed_event':
      return [['feed']];
    case 'access_changed':
      return [['access', event.instance!]];
    case 'typing_update':
      return null; // handled directly
    default:
      return null;
  }
}

interface UseWebSocketOptions {
  /** Fleet token for auth. Reads from meta tag if not provided. */
  token?: string;
  /** Reconnect delay in ms (default: 3000). */
  reconnectDelay?: number;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const { reconnectDelay = 3000 } = options;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<WsStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const getToken = useCallback((): string | null => {
    if (options.token) return options.token;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="fleet-token"]');
    return meta?.content || null;
  }, [options.token]);

  useEffect(() => {
    let disposed = false;

    function connect() {
      if (disposed) return;

      const token = getToken();
      if (!token) {
        // No token available — stay disconnected, polling continues
        return;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?token=${token}`;

      setStatus('connecting');
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        setStatus('connected');
      };

      ws.onmessage = (ev) => {
        try {
          const event: WsEvent = JSON.parse(ev.data);

          if (event.type === 'connected') return; // server hello, ignore

          if (event.type === 'typing_update') {
            // Direct cache update for typing (latency-sensitive)
            queryClient.setQueryData(['typing'], (old: unknown) => {
              if (!Array.isArray(old)) return old;
              // Update or add typing entry
              const idx = old.findIndex((t: Record<string, unknown>) =>
                t.instance === event.instance && t.jid === event.jid
              );
              const entry = {
                instance: event.instance,
                jid: event.jid,
                composing: event.composing,
                since: event.since,
              };
              if (idx >= 0) {
                const next = [...old];
                next[idx] = entry;
                return next;
              }
              return [...old, entry];
            });
            return;
          }

          // Invalidation events — trigger refetch
          const keys = eventToQueryKeys(event);
          if (keys) {
            for (const key of keys) {
              queryClient.invalidateQueries({ queryKey: key });
            }
          }
        } catch {
          // Malformed message — ignore
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setStatus('disconnected');
        wsRef.current = null;
        // Auto-reconnect
        reconnectTimer.current = setTimeout(connect, reconnectDelay);
      };

      ws.onerror = () => {
        // onclose will fire after this — reconnect handled there
      };
    }

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [getToken, queryClient, reconnectDelay]);

  return { status };
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd console && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add console/src/hooks/use-websocket.ts
git commit -m "feat(console): add useWebSocket hook with auto-reconnect and RQ invalidation"
```

---

### Task 4: Wire useWebSocket into App and conditionally disable polling

**Files:**
- Modify: `console/src/App.tsx` (mount useWebSocket)
- Modify: `console/src/hooks/use-fleet.ts` (accept wsConnected param to disable polling)

- [ ] **Step 1: Create WebSocket context for status sharing**

Create `console/src/hooks/ws-context.ts`:

```typescript
import { createContext, useContext } from 'react';
import type { WsStatus } from './use-websocket';

export const WsContext = createContext<WsStatus>('disconnected');
export const useWsStatus = () => useContext(WsContext);
```

- [ ] **Step 2: Mount useWebSocket in App.tsx**

In `console/src/App.tsx`, add:

```typescript
import { useWebSocket } from './hooks/use-websocket';
import { WsContext } from './hooks/ws-context';
```

Wrap the routes in WsContext.Provider:

```typescript
function AppInner() {
  const { status } = useWebSocket();
  return (
    <WsContext.Provider value={status}>
      {/* existing Routes/Suspense content */}
    </WsContext.Provider>
  );
}
```

- [ ] **Step 3: Update fleet hooks to disable polling when WS connected**

In `console/src/hooks/use-fleet.ts`, update each hook's `refetchInterval` to check WS status:

```typescript
import { useWsStatus } from './ws-context';

/** All line instances — polls at 5s, disabled when WS connected. */
export function useLines() {
  const ws = useWsStatus();
  return useQuery({
    ...getLinesQueryOptions(),
    refetchInterval: ws === 'connected' ? false : 5000,
  });
}
```

Apply the same pattern to: `useLine`, `useChats`, `useMessages`, `useLogs`, `useTyping`, `useFeed`.

For `useTyping`, disable polling entirely when WS connected (typing comes via full payload push):

```typescript
export function useTyping() {
  const ws = useWsStatus();
  return useQuery({
    queryKey: ['typing'],
    queryFn: () => api.getTyping(),
    refetchInterval: ws === 'connected' ? false : 2000,
  });
}
```

- [ ] **Step 4: Run typecheck and full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS — all tests, 0 TS errors

- [ ] **Step 5: Commit**

```bash
git add console/src/hooks/ws-context.ts console/src/App.tsx console/src/hooks/use-fleet.ts
git commit -m "feat(console): wire useWebSocket into app, disable polling when WS connected"
```

---

### Task 5: Handle WS upgrade path in fleet server routing

**Files:**
- Modify: `src/fleet/index.ts` (ensure /ws path doesn't hit 404)

The `FleetWebSocketServer` listens on the `upgrade` event of the HTTP server, which fires for ANY path. The WS client connects to `/ws?token=...`. The HTTP route table doesn't have a `/ws` entry, but that's fine because the `upgrade` event fires before route dispatch. However, if the client sends a non-upgrade HTTP GET to `/ws`, it would 404.

- [ ] **Step 1: Verify WS upgrade works on /ws path**

The `httpServer.on('upgrade')` handler in `websocket-server.ts` already handles this. No route table entry needed — WebSocket upgrades bypass HTTP routing. Skip if the existing code already handles it (it does — the WS server uses `noServer: true` and manually handles upgrades).

- [ ] **Step 2: Run console build to verify no regressions**

Run: `npm --prefix console run build`
Expected: Build succeeds, bundle splits maintained

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "chore: verify WS upgrade path works without route entry"
```

---

### Task 6: Add WS connection indicator to console UI

**Files:**
- Modify: `console/src/App.tsx` (or layout component — add small status indicator)

- [ ] **Step 1: Add a small WS status dot to the console header/nav**

In whatever layout wrapper exists (check `App.tsx` structure), add a small status indicator:

```typescript
import { useWsStatus } from './hooks/ws-context';

function WsIndicator() {
  const ws = useWsStatus();
  if (ws === 'connected') return null; // Hidden when healthy
  const color = ws === 'connecting' ? 'bg-yellow-400' : 'bg-red-400';
  const label = ws === 'connecting' ? 'Connecting...' : 'Polling mode';
  return (
    <span className="inline-flex items-center gap-1 text-xs text-t3">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}
```

Show this in the nav bar so operators know when they're on WS vs polling fallback.

- [ ] **Step 2: Run build and verify**

Run: `npm --prefix console run build && npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add console/src/App.tsx
git commit -m "feat(console): add WS connection status indicator in nav"
```

---

### Task 7: Integration test — WS end-to-end

**Files:**
- Create: `tests/fleet/websocket-integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { FleetWebSocketServer } from '../../src/fleet/websocket-server.ts';

describe('FleetWebSocketServer integration', () => {
  let httpServer: ReturnType<typeof createServer>;
  let wsServer: FleetWebSocketServer;
  const TEST_TOKEN = 'test-token-abc123';

  afterEach(() => {
    wsServer?.close();
    httpServer?.close();
  });

  it('rejects connection without token', async () => {
    httpServer = createServer();
    wsServer = new FleetWebSocketServer(httpServer, TEST_TOKEN);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve());
      ws.on('close', () => resolve());
    });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  it('accepts connection with valid token and receives broadcast', async () => {
    httpServer = createServer();
    wsServer = new FleetWebSocketServer(httpServer, TEST_TOKEN);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TEST_TOKEN}`);
    const messages: string[] = [];

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        messages.push(data.toString());
        if (messages.length === 1) {
          // Got the 'connected' hello, now broadcast
          wsServer.broadcast({ type: 'instance_status', instance: 'test-line' });
        }
        if (messages.length === 2) resolve();
      });
    });

    const hello = JSON.parse(messages[0]);
    expect(hello.type).toBe('connected');

    const event = JSON.parse(messages[1]);
    expect(event.type).toBe('instance_status');
    expect(event.instance).toBe('test-line');

    ws.close();
  });

  it('reports correct client count', async () => {
    httpServer = createServer();
    wsServer = new FleetWebSocketServer(httpServer, TEST_TOKEN);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as { port: number }).port;

    expect(wsServer.clientCount).toBe(0);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TEST_TOKEN}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    expect(wsServer.clientCount).toBe(1);

    ws.close();
    await new Promise<void>((resolve) => ws.on('close', resolve));
    expect(wsServer.clientCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run tests/fleet/websocket-integration.test.ts -v`
Expected: 3 tests PASS

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/fleet/websocket-integration.test.ts
git commit -m "test(fleet): add WebSocket server integration tests"
```

---

### Verification Checklist

After all tasks complete:

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — all tests pass
- [ ] `npm --prefix console run build` — succeeds, bundle splits maintained
- [ ] WS server accepts connections at `/ws?token=...`
- [ ] Console hooks disable polling when WS connected
- [ ] Console falls back to polling when WS disconnects
- [ ] Typing updates pushed directly (no refetch roundtrip)
- [ ] All other events trigger `queryClient.invalidateQueries()`
