// src/fleet/websocket-server.ts
// WebSocket server for real-time console updates.
// Design: invalidation-first — small events trigger React Query refetch.
// Exception: typing_update pushes full state (too latency-sensitive for refetch).
//
// Auth model (issue #237):
//   - Preferred: short-lived ?ticket=<...> validated against the in-process
//     ticket store. The browser fetches the ticket via POST /api/ws-ticket
//     (Bearer auth) so the root fleet token never travels in a URL.
//   - Legacy: ?token=<fleetToken> still works for one rollout cycle; it
//     emits a one-shot deprecation warning per server instance so operators
//     can spot tooling that hasn't migrated yet.

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';
import { createChildLogger } from '../logger.ts';
import type { TicketStore } from './ws-ticket.ts';
import { errorMessage } from '../lib/error-message.ts';
import { systemClock } from '../lib/clock.ts';
import type { RealtimePollerHealthSnapshot } from './realtime-event-poller.ts';

const log = createChildLogger('fleet:ws');

function describeAuthRejectUrl(rawUrl: string | undefined): {
  path: string;
  hasTicket: boolean;
  hasLegacyToken: boolean;
} {
  try {
    const url = new URL(rawUrl ?? '', 'http://localhost');
    return {
      path: url.pathname,
      hasTicket: url.searchParams.has('ticket'),
      hasLegacyToken: url.searchParams.has('token'),
    };
  } catch {
    return { path: '<invalid>', hasTicket: false, hasLegacyToken: false };
  }
}

// ---------------------------------------------------------------------------
// Event types — matches the realtime/WebSocket spec consensus
// ---------------------------------------------------------------------------

/** Invalidation events — trigger React Query refetch on the client. */
export interface WsInvalidationEvent {
  type:
    | 'instance_status'
    | 'message_received'
    | 'chat_updated'
    | 'log_entry'
    | 'feed_event'
    | 'access_changed'
    | 'lid_conflict';
  instance: string;
  /** Optional conversation key for scoped invalidation. */
  conversationKey?: string;
  /** Optional LID for lid_conflict invalidations. */
  lid?: string;
  /** Optional message pk for precise cache updates. */
  messagePk?: number;
}

/** Full-payload event for typing indicators (latency-sensitive). */
export interface WsTypingEvent {
  type: 'typing_update';
  instance: string;
  jid: string;
  composing: boolean;
  since: number;
}

export type WsEvent = WsInvalidationEvent | WsTypingEvent;

// ---------------------------------------------------------------------------
// FleetWebSocketServer
// ---------------------------------------------------------------------------

export interface FleetWsAuthDeps {
  /** Ticket store; ticket-mode connections are validated through this. */
  ticketStore: TicketStore;
  /** Signing keys to accept for ticket HMAC validation (active + accept[]). */
  ticketValidKeys: () => readonly string[];
  /** Verifier for the legacy `?token=` path. */
  verifyLegacyToken: (token: string) => boolean;
}

// ---------------------------------------------------------------------------
// Client lifecycle (#2521)
// ---------------------------------------------------------------------------

/** Per-client lifecycle bookkeeping. Values are bounded counters/marks only. */
interface WsClientRecord {
  /** Heartbeat pings sent since the last pong receipt. */
  missedPongs: number;
  /** Monotonic mark when bufferedAmount first exceeded the budget; null while under. */
  backpressuredSinceMs: number | null;
  /** True once at least one pong has been received (liveness CONFIRMED, not assumed). */
  confirmedLive: boolean;
}

/** Bounded per-attempt delivery outcomes (#2521). */
type WsDeliveryOutcome =
  | 'broadcast_attempted'
  | 'write_accepted'
  | 'failed'
  | 'dropped'
  | 'client_unresponsive'
  | 'client_evicted_backpressure';

export interface FleetWsLifecycleOptions {
  /** Interval between heartbeat ping sweeps. */
  heartbeatIntervalMs?: number;
  /** Missed-pong budget; a client at/over budget on a sweep is terminated. */
  missedPongBudget?: number;
  /** Per-client bufferedAmount budget in bytes; above it no frames are enqueued. */
  maxBufferedBytes?: number;
  /** How long a client may stay above the buffer budget before eviction. */
  backpressureGraceMs?: number;
  /** Rolling window for the aggregate outcome counters. */
  outcomeWindowMs?: number;
  /** Minimum spacing between logs of the same lifecycle token. */
  logThrottleMs?: number;
  /** Monotonic clock; injectable for deterministic tests. */
  monotonicNow?: () => number;
}

/** Aggregate, bounded health projection — no identities, addresses, or payloads. */
export interface FleetWsHealthSnapshot {
  clientCount: number;
  /** Clients that have answered at least one ping and have none outstanding. */
  confirmedLive: number;
  /** Adopted clients that have never answered a ping yet (liveness unproven). */
  unconfirmed: number;
  awaitingPong: number;
  backpressured: number;
  heartbeatAgeMs: number | null;
  recentOutcomes: Record<WsDeliveryOutcome, number>;
}

const OUTCOME_TOKENS: readonly WsDeliveryOutcome[] = [
  'broadcast_attempted',
  'write_accepted',
  'failed',
  'dropped',
  'client_unresponsive',
  'client_evicted_backpressure',
];

function emptyOutcomeCounts(): Record<WsDeliveryOutcome, number> {
  return Object.fromEntries(OUTCOME_TOKENS.map((token) => [token, 0])) as Record<WsDeliveryOutcome, number>;
}

export class FleetWebSocketServer {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, WsClientRecord>();
  private authDeps: FleetWsAuthDeps;
  private legacyWarningEmitted = false;
  private readonly heartbeatIntervalMs: number;
  private readonly missedPongBudget: number;
  private readonly maxBufferedBytes: number;
  private readonly backpressureGraceMs: number;
  private readonly outcomeWindowMs: number;
  private readonly logThrottleMs: number;
  private readonly monotonicNow: () => number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatAtMs: number | null = null;
  /** Stream identity (#2519 draft-1): a fresh generation per server instance, a
  monotonic per-frame sequence. Clients detect restarts (generation change) and
  gaps (non-contiguous sequence) instead of assuming a reopened socket is
  current. Draft-2 splits the counter: `durableSequence` moves only for
  non-ephemeral frames (typing is exempt), so a client can attribute a gap to
  durable loss versus missed typing indicators and reconcile proportionally. */
  private readonly streamGeneration = randomUUID();
  private sequence = 0;
  private durableSequence = 0;
  private outcomeWindowStartMs: number;
  private outcomeCounts = emptyOutcomeCounts();
  private readonly lastLogAtMs = new Map<string, number>();
  private readonly suppressedLogCounts = new Map<string, number>();
  /**
   * Late-bound accessor for the realtime event poller's health snapshot
   * (#2522). The poller is constructed AFTER this server in index.ts, so the
   * accessor is wired post-construction and read only at hello time — never a
   * live poll on connect. Null means "not wired"; the hello then carries an
   * explicit `realtime_poller: null` receipt rather than omitting the field.
   */
  private getRealtimePollerHealth: (() => RealtimePollerHealthSnapshot | null) | null = null;
  /**
   * Kept so `close()` can detach it (#2292 L6). The listener lives on the
   * SHARED httpServer, which outlives this object: without a reference there
   * is nothing to remove, so a closed server stayed subscribed to 'upgrade',
   * retained `this` (clients set, auth deps) for the process lifetime, and a
   * second instance on the same httpServer meant both handlers ran — the stale
   * one calling handleUpgrade on an already-closed WebSocketServer.
   */
  private readonly httpServer: HttpServer;
  private readonly onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(httpServer: HttpServer, authDeps: FleetWsAuthDeps, options: FleetWsLifecycleOptions = {}) {
    this.authDeps = authDeps;
    this.httpServer = httpServer;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.missedPongBudget = options.missedPongBudget ?? 2;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1_048_576;
    this.backpressureGraceMs = options.backpressureGraceMs ?? 60_000;
    this.outcomeWindowMs = options.outcomeWindowMs ?? 300_000;
    this.logThrottleMs = options.logThrottleMs ?? 30_000;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.outcomeWindowStartMs = this.monotonicNow();
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests with auth
    this.onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!this.authenticate(req)) {
        log.warn(describeAuthRejectUrl(req.url), 'ws_auth_rejected');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    };
    httpServer.on('upgrade', this.onUpgrade);

    this.wss.on('connection', (ws: WebSocket) => {
      this.adoptClient(ws);
    });

    this.heartbeatTimer = setInterval(() => this.heartbeatSweep(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  /** Adopt a socket into lifecycle tracking (single path for real and test clients). */
  private adoptClient(ws: WebSocket): void {
    this.clients.set(ws, { missedPongs: 0, backpressuredSinceMs: null, confirmedLive: false });
    log.info({ clients: this.clients.size }, 'ws_client_connected');

    ws.on('pong', () => {
      const record = this.clients.get(ws);
      if (record) {
        record.missedPongs = 0;
        record.confirmedLive = true;
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      log.info({ clients: this.clients.size }, 'ws_client_disconnected');
    });

    ws.on('error', (err) => {
      log.warn({ err: err.message }, 'ws_client_error');
      this.clients.delete(ws);
    });

    // Send initial hello so client knows connection is live; a failed local
    // write is a delivery outcome like any other, not a silent no-op. The hello
    // carries the stream identity receipt (#2519): generation plus the sequence
    // already emitted, so the client knows exactly where the stream stands and
    // can demand reconciliation instead of assuming a reopened socket is current.
    try {
      ws.send(
        JSON.stringify({
          type: 'connected',
          timestamp: Date.now(),
          schema_version: 1,
          stream_generation: this.streamGeneration,
          sequence: this.sequence,
          durable_sequence: this.durableSequence,
          realtime_poller: this.getRealtimePollerHealth?.() ?? null,
        }),
        (err) => {
          if (err) this.dropClient(ws, 'failed', 'ws_hello_send_failed');
          else this.recordOutcome('write_accepted');
        },
      );
    } catch {
      this.dropClient(ws, 'failed', 'ws_hello_send_failed');
    }
  }

  /** One heartbeat sweep: terminate clients past the missed-pong budget, ping the rest. */
  private heartbeatSweep(): void {
    for (const [ws, record] of this.clients) {
      if (record.missedPongs >= this.missedPongBudget) {
        this.dropClient(ws, 'client_unresponsive', 'ws_client_unresponsive');
        continue;
      }
      record.missedPongs += 1;
      try {
        ws.ping();
      } catch {
        this.dropClient(ws, 'failed', 'ws_ping_failed');
      }
    }
    this.lastHeartbeatAtMs = this.monotonicNow();
  }

  /** Remove a client, record one bounded outcome, and terminate the transport. */
  private dropClient(ws: WebSocket, outcome: WsDeliveryOutcome, logToken: string): void {
    if (!this.clients.delete(ws)) return;
    this.recordOutcome(outcome);
    this.throttledWarn(logToken);
    try {
      ws.terminate();
    } catch (err) {
      // The transport is already gone; removal from the set is what matters.
      log.debug({ err: errorMessage(err) }, 'ws_terminate_after_drop_failed');
    }
  }

  private recordOutcome(outcome: WsDeliveryOutcome): void {
    const now = this.monotonicNow();
    if (now - this.outcomeWindowStartMs > this.outcomeWindowMs) {
      this.outcomeCounts = emptyOutcomeCounts();
      this.outcomeWindowStartMs = now;
    }
    this.outcomeCounts[outcome] += 1;
  }

  /** Rate-bounded warn: at most one log per token per window; suppressed count carried. */
  private throttledWarn(token: string): void {
    const now = this.monotonicNow();
    const last = this.lastLogAtMs.get(token);
    if (last !== undefined && now - last < this.logThrottleMs) {
      this.suppressedLogCounts.set(token, (this.suppressedLogCounts.get(token) ?? 0) + 1);
      return;
    }
    const suppressed = this.suppressedLogCounts.get(token) ?? 0;
    this.suppressedLogCounts.set(token, 0);
    this.lastLogAtMs.set(token, now);
    log.warn({ suppressedSinceLast: suppressed }, token);
  }

  /** Broadcast an event to all connected clients (#2521 delivery contract).

  Per client: a buffer over budget means NO further frames (dropped outcome,
  eviction after the grace window); otherwise the send's asynchronous
  completion is observed and a failed write terminates exactly that client.
  Neither write acceptance nor local completion is projected to remote
  application receipt. */
  broadcast(event: WsEvent): void {
    // Counters track EMITTED events, not deliveries: they must advance even
    // with zero clients connected, or a later reconnect hello declares the
    // stale position and the client's gap judgment misses everything emitted
    // during the empty window. Only serialization and delivery are skipped.
    this.sequence += 1;
    if (event.type !== 'typing_update') this.durableSequence += 1;
    if (this.clients.size === 0) return;
    const data = JSON.stringify({
      ...event,
      schema_version: 1,
      stream_generation: this.streamGeneration,
      sequence: this.sequence,
      durable_sequence: this.durableSequence,
      emitted_at: systemClock.now(),
    });
    this.recordOutcome('broadcast_attempted');
    for (const [client, record] of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > this.maxBufferedBytes) {
        // The grace window measures CONTINUOUS over-budget time: any under-budget
        // broadcast resets it. An oscillating client therefore evades eviction —
        // deliberately: oscillation means the buffer is draining, and over-budget
        // frames are dropped (never queued), so there is no unbounded growth.
        record.backpressuredSinceMs ??= this.monotonicNow();
        this.recordOutcome('dropped');
        if (this.monotonicNow() - record.backpressuredSinceMs > this.backpressureGraceMs) {
          this.dropClient(client, 'client_evicted_backpressure', 'ws_client_backpressure_evicted');
        } else {
          this.throttledWarn('ws_client_backpressured');
        }
        continue;
      }
      record.backpressuredSinceMs = null;
      try {
        client.send(data, (err) => {
          if (err) this.dropClient(client, 'failed', 'ws_async_send_failed');
        });
        this.recordOutcome('write_accepted');
      } catch (err) {
        // Unified with the async path: one failed outcome, terminate, and ONLY
        // the throttled token — a per-throw err-carrying warn here was the one
        // unthrottled log site left in the lifecycle (#3284 review).
        log.debug({ err: errorMessage(err) }, 'ws_sync_send_error_detail');
        this.dropClient(client, 'failed', 'ws_sync_send_failed');
      }
    }
  }

  /** Raw tracked-socket count. NOT deliverable/live coverage — a half-open or
  backpressured client still counts here; use healthSnapshot() for the
  lifecycle breakdown. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Aggregate, bounded lifecycle projection (#2521): counts and ages only.
  The outcome counters use a tumbling epoch window; an expired window is
  PRESENTED as empty here without mutating state (writes own the reset). */
  healthSnapshot(): FleetWsHealthSnapshot {
    let awaitingPong = 0;
    let backpressured = 0;
    let confirmedLive = 0;
    let unconfirmed = 0;
    for (const record of this.clients.values()) {
      if (record.backpressuredSinceMs !== null) backpressured += 1;
      else if (record.missedPongs > 0) awaitingPong += 1;
      else if (record.confirmedLive) confirmedLive += 1;
      else unconfirmed += 1;
    }
    const now = this.monotonicNow();
    const windowExpired = now - this.outcomeWindowStartMs > this.outcomeWindowMs;
    return {
      clientCount: this.clients.size,
      confirmedLive,
      unconfirmed,
      awaitingPong,
      backpressured,
      heartbeatAgeMs: this.lastHeartbeatAtMs === null ? null : now - this.lastHeartbeatAtMs,
      recentOutcomes: windowExpired ? emptyOutcomeCounts() : { ...this.outcomeCounts },
    };
  }

  /**
   * Wire the realtime event poller's health accessor (#2522). Late-bound: the
   * poller is constructed after this server, so index.ts calls this once the
   * poller exists. The getter is invoked only at hello time; a null getter
   * (never wired) yields `realtime_poller: null` in the hello.
   */
  setRealtimePollerHealth(getter: () => RealtimePollerHealthSnapshot | null): void {
    this.getRealtimePollerHealth = getter;
  }

  /** Gracefully close all connections. */
  close(): void {
    // Detach FIRST: an upgrade arriving mid-close would otherwise be handed to
    // a WebSocketServer that is about to be (or already is) closed.
    this.httpServer.removeListener('upgrade', this.onUpgrade);
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients.keys()) {
      client.close(1001, 'server shutting down');
    }
    this.clients.clear();
    this.wss.close();
  }

  // ---------------------------------------------------------------------------
  // Auth — query parameter only (browser WebSocket can't send headers)
  //   - ?ticket=<...>  preferred; HMAC-signed, single-use, ~60s TTL
  //   - ?token=<...>   legacy; emits a one-shot deprecation log per server
  // ---------------------------------------------------------------------------

  private authenticate(req: IncomingMessage): boolean {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const ticket = url.searchParams.get('ticket');
      if (ticket) {
        return this.authDeps.ticketStore.redeem(ticket, this.authDeps.ticketValidKeys());
      }
      const legacyToken = url.searchParams.get('token');
      if (legacyToken) {
        const ok = this.authDeps.verifyLegacyToken(legacyToken);
        if (ok && !this.legacyWarningEmitted) {
          this.legacyWarningEmitted = true;
          log.warn({ legacy: 'ws-token-in-url' }, 'ws_legacy_token_path');
        }
        return ok;
      }
      return false;
    } catch {
      return false;
    }
  }
}
