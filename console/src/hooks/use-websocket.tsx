/* eslint-disable react-refresh/only-export-components */
// ---------------------------------------------------------------------------
//  WebSocket provider — single connection, invalidation-first architecture.
//
//  While connected: invalidates React Query caches on server events.
//  While disconnected: falls back to polling (existing refetchInterval).
// ---------------------------------------------------------------------------

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
import { getFleetToken } from '../lib/api';

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
    function connect() {
      const token = getFleetToken();
      const url = getFleetWebSocketUrl(window.location, token);
      if (!url) return;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectDelay.current = RECONNECT_BASE_MS;
      };

      ws.onmessage = (msg) => {
        const event: WsEvent | null = parseWsEvent(msg.data);
        if (!event) return;

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

    connect();

    return () => {
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
