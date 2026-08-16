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
  detectHelloGap,
  detectFrameGap,
  REALTIME_OWNED_QUERY_KEYS,
  type StreamCursor,
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
  // Last verified stream position (#2519). Survives reconnects so the next
  // hello can prove whether anything was missed while the socket was down.
  const streamCursor = useRef<StreamCursor>({ generation: null, sequence: null });

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

      const reconcileRealtimeCaches = () => {
        // A detected gap means displayed data cannot be assumed current:
        // invalidate EVERY realtime-owned family, not the partial disconnect
        // set — partial invalidation is exactly the staleness class #2519
        // documents (a missed log/chat/access event surviving "reconnected").
        for (const key of REALTIME_OWNED_QUERY_KEYS) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      };

      ws.onmessage = (msg) => {
        const event: WsEvent | null = parseWsEvent(msg.data);
        if (!event) return;
        wsMeter.record('instance' in event && typeof event.instance === 'string' ? event.instance : 'fleet');

        if (event.type === 'connected') {
          // The hello is a stream-position receipt, not a no-op (#2519): a
          // generation change, a sequence advance while away, or an
          // unverifiable envelope all require reconciliation before the UI
          // may treat caches as current again.
          if (detectHelloGap(streamCursor.current, event) !== null) {
            reconcileRealtimeCaches();
          }
          streamCursor.current = {
            generation: typeof event.streamGeneration === 'string' ? event.streamGeneration : null,
            sequence: typeof event.sequence === 'number' ? event.sequence : null,
          };
          return;
        }

        const frameGap = detectFrameGap(streamCursor.current, event);
        if (frameGap !== null) {
          reconcileRealtimeCaches();
        }
        if (typeof event.streamGeneration === 'string' && typeof event.sequence === 'number') {
          streamCursor.current = { generation: event.streamGeneration, sequence: event.sequence };
        }

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
