/* eslint-disable react-refresh/only-export-components -- waiver:WVR-008 file exports the RealtimeProvider component alongside the useRealtime hook so HMR cannot tell them apart; safe because the provider is stable and rarely edited; expires 2026-12-31 */
// ---------------------------------------------------------------------------
//  WebSocket provider — single connection, invalidation-first architecture.
//
//  While connected: invalidates React Query caches on server events.
//  While disconnected: falls back to polling (existing refetchInterval).
// ---------------------------------------------------------------------------

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { wsMeter } from '../lib/perf';
import {
  getFleetWebSocketUrl,
  getInvalidationKeys,
  applyTypingUpdate,
  parseWsEvent,
  type WsEvent,
  type WsInvalidationEvent,
  type WsTypingEvent,
  type TypingEntry,
} from '../lib/realtime-events';
import { api, isProductionConsole } from '../lib/api';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface RealtimeState {
  connected: boolean;
}

const RealtimeContext = createContext<RealtimeState>({ connected: false });

export function useRealtime(): RealtimeState {
  return useContext(RealtimeContext);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function connect() {
      // Ticket minting needs the production session flow (fleet-auth-mode
      // meta); in dev there is nothing to mint against, so bail out early.
      if (!isProductionConsole()) return;
      const url = await getFleetWebSocketUrl(window.location, () => api.getWsTicket());
      if (cancelled) return;
      if (!url) {
        // Ticket mint failed — schedule a retry on the same backoff curve.
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, RECONNECT_MAX_MS);
        reconnectTimer.current = setTimeout(connect, delay);
        return;
      }

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectDelay.current = RECONNECT_BASE_MS;
      };

      ws.onmessage = (msg) => {
        const event: WsEvent | null = parseWsEvent(msg.data);
        if (!event) return;
        wsMeter.record('instance' in event && typeof event.instance === 'string' ? event.instance : 'fleet');

        if (event.type === 'connected') return;

        if (event.type === 'typing_update') {
          queryClient.setQueryData<TypingEntry[]>(['typing'], (prev) =>
            applyTypingUpdate(prev, event as WsTypingEvent),
          );
          return;
        }

        // Invalidation events
        const keys = getInvalidationKeys(event as WsInvalidationEvent);
        for (const key of keys) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;

        // Invalidate stale caches on disconnect
        queryClient.invalidateQueries({ queryKey: ['lines'] });
        queryClient.invalidateQueries({ queryKey: ['feed'] });
        queryClient.invalidateQueries({ queryKey: ['typing'] });

        // Reconnect with exponential backoff
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, RECONNECT_MAX_MS);
        reconnectTimer.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on cleanup
        wsRef.current.close();
      }
    };
  }, [queryClient]);

  return (
    <RealtimeContext.Provider value={{ connected }}>
      {children}
    </RealtimeContext.Provider>
  );
}
