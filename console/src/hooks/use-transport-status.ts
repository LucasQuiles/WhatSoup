// ---------------------------------------------------------------------------
//  WhatSoup Console — Transport status hook
//
//  Derives a coarse, app-level connection state from two signals already in the
//  console:
//    1. the realtime socket (`useRealtime().connected` — the same flag
//       use-fleet.ts reads to toggle polling fallback), and
//    2. `navigator.onLine` plus the window `online`/`offline` events.
//
//  States:
//    - 'connected'    — realtime socket is up.
//    - 'reconnecting' — the browser is online but the realtime socket is down,
//                       so the console has fallen back to polling.
//    - 'offline'      — the browser itself reports no network.
//
//  This hook is pure derivation plus the two window event listeners (cleaned up
//  on unmount). It owns no data fetching and does not reinvent the websocket
//  layer — it only reads its connection flag.
//
//  Recovery edge: the disconnected→connected transition is detected during
//  render (the React "adjusting state during render" pattern), so it fires
//  exactly once per recovery without setState-inside-effect.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import { useRealtime } from './use-websocket';

export type TransportStatus = 'connected' | 'reconnecting' | 'offline';

export interface TransportState {
  status: TransportStatus;
  /** True whenever the surface is not fully connected (reconnecting OR offline). */
  isDisconnected: boolean;
  /**
   * True for exactly the render on which a disconnected→connected recovery is
   * detected; false otherwise. Drives a one-shot recovery toast declaratively.
   * Callers that prefer a callback can pass `onReconnect` instead.
   */
  justReconnected: boolean;
}

export interface UseTransportStatusOptions {
  /**
   * Fired exactly once per disconnected→connected recovery (never on first
   * mount, never on every render). Optional — `justReconnected` covers the
   * declarative case.
   */
  onReconnect?: () => void;
}

/** SSR/jsdom-safe read of the browser's online flag (defaults to online). */
function readNavigatorOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  // Some environments expose navigator without onLine; treat absence as online.
  return navigator.onLine !== false;
}

function deriveStatus(browserOnline: boolean, socketConnected: boolean): TransportStatus {
  // Offline wins over reconnecting: no network means the socket can't recover.
  if (!browserOnline) return 'offline';
  return socketConnected ? 'connected' : 'reconnecting';
}

export function useTransportStatus(options: UseTransportStatusOptions = {}): TransportState {
  const { onReconnect } = options;
  const { connected } = useRealtime();

  const [browserOnline, setBrowserOnline] = useState<boolean>(readNavigatorOnline);

  // Window online/offline listeners. The setState here happens in event
  // handlers (not in the effect body), so it is not a render-loop hazard.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => setBrowserOnline(true);
    const handleOffline = () => setBrowserOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const status = deriveStatus(browserOnline, connected);
  const isDisconnected = status !== 'connected';

  // One-shot recovery detection using React's "adjusting state during render"
  // pattern. We hold the previous status in state and compare during render;
  // on a disconnected→connected edge we bump both the prevStatus and a
  // reconnect nonce so the effect below fires `onReconnect` exactly once.
  // State setters during render are sanctioned by the React docs for this
  // pattern and do not trip the react-hooks/refs lint rule (which only
  // forbids reading/writing `.current` on refs during render).
  const [prevStatus, setPrevStatus] = useState<TransportStatus>(status);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const firedNonceRef = useRef(0);

  let justReconnected = false;
  if (prevStatus !== status) {
    const wasConnected = prevStatus === 'connected';
    setPrevStatus(status);
    if (!wasConnected && status === 'connected') {
      justReconnected = true;
      setReconnectNonce((n) => n + 1);
    }
  }

  // Fire the callback for each recovery edge, exactly once per nonce bump.
  useEffect(() => {
    if (reconnectNonce !== firedNonceRef.current && reconnectNonce > 0) {
      firedNonceRef.current = reconnectNonce;
      onReconnect?.();
    }
  }, [reconnectNonce, onReconnect]);

  return { status, isDisconnected, justReconnected };
}
