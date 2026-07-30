// src/transport/outbound-governor.ts
/**
 * PR-F — socket-seam outbound governor.
 *
 * WHY THE SEAM: the send-path census proved `ConnectionManager.sendMessage` is
 * NOT the universal outbound path — MCP tools reach `sendRaw`/`sendMedia`/
 * `sendPollMessage` (Tier B), and raw tools (forward_message, share/request
 * phone, product) call `getSock().sendMessage(...)` directly (Tier C). The ONE
 * convergence point is the Baileys socket's `sendMessage`. So the governor is
 * installed there — once, in-place — and every tier funnels through it.
 *
 * SS1 (why NOT a Proxy): `registerEventHandlers` captures the RAW socket and
 * guards its event loop / keepalive / reconnect with `if (this.sock !== sock)
 * return`. A Proxy is never `=== ` its target, so those guards would fire
 * forever → the bot goes deaf. `wrapWithOutboundGovernor` therefore OVERRIDES
 * `sock.sendMessage` on the same object and returns that same reference, keeping
 * `this.sock === sock` intact.
 *
 * SS4 (why classify): the override runs inside `withSendTimeout` (30s). Pacing a
 * MEDIA send past that ceiling would turn a deliverable into a hard timeout, so
 * only genuine `content.text` is paced; media and control ops (react/edit/delete/
 * poll/forward/…) bypass acquire entirely.
 *
 * Deliverable-safety: the DEFAULT is PACE, never drop. A legit multi-part answer
 * is smoothed to a safe cadence and delivered in full. A send is SHED (thrown,
 * rare-by-design) only past the catastrophe ceiling or when pacing would exceed
 * the bounded wait — the true-runaway backstop that feeds PR-G.
 */
import { OutboundRateLimiter } from './outbound-rate-limiter.ts';
import { WhatSoupError } from '../errors.ts';
import {
  OUTBOUND_GOVERNOR_SHED_LOG,
} from '../core/outbound-governor-shed.ts';
export {
  isOutboundGovernorShed,
  OUTBOUND_GOVERNOR_SHED_LOG,
} from '../core/outbound-governor-shed.ts';
import {
  adjudicateOutboundContent,
  OUTBOUND_CONTENT_EGRESS_REDACTED_LOG,
  type OutboundBannerClassifier,
} from './outbound-content-egress.ts';

/** Single fixed key for the aggregate per-bot bucket (breadth floods, F2). */
const GLOBAL_BUCKET_KEY = '__bot_global__';

/** Baileys content keys that mark a MEDIA send (paced-exempt, SS4). */
const MEDIA_KEYS = ['image', 'video', 'audio', 'document', 'sticker'] as const;
/**
 * Baileys content keys that mark a CONTROL op (paced-exempt, SS3). Checked
 * BEFORE the text test because some control shapes ALSO carry `.text` — most
 * importantly `edit` (`{ text, edit }`), which must NOT be treated as prose.
 */
const CONTROL_KEYS = [
  'edit',
  'delete',
  'react',
  'protocolMessage',
  'poll',
  'forward',
  'contacts',
  'contact',
  'location',
  'liveLocation',
  'sharePhoneNumber',
  'requestPhoneNumber',
  'product',
  'limitSharing',
  'pin',
] as const;

export type OutboundClass = 'text' | 'media' | 'control';

function hasKey(content: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const k of keys) {
    if (content[k] !== undefined) return true;
  }
  return false;
}

/**
 * Classify an outbound Baileys content object. Only `text` is paced; `media`
 * and `control` bypass the governor. Defaults to `control` (exempt) for any
 * shape that is neither media nor a genuine string-`text` send (SS3).
 */
export function classifyOutbound(content: unknown): OutboundClass {
  if (content === null || typeof content !== 'object') return 'control';
  const c = content as Record<string, unknown>;
  if (hasKey(c, MEDIA_KEYS)) return 'media';
  if (hasKey(c, CONTROL_KEYS)) return 'control';
  if (typeof c['text'] === 'string') return 'text';
  return 'control';
}

export interface OutboundGovernorConfig {
  /** Pacing window (ms) and cap — the normal cadence a conversation is smoothed to. */
  windowMs: number;
  maxPerWindow: number;
  /** Max time a single paced send may wait before it sheds instead (F4). */
  maxWaitMs: number;
  /** Catastrophe backstop: hard per-conversation cap over its (long) window. */
  hardCeiling: number;
  hardCeilingWindowMs: number;
  /** Aggregate per-bot bucket (breadth floods, F2) — cap over its window. */
  globalMaxPerWindow: number;
  globalWindowMs: number;
}

/** Reason a send was shed — internal detail; the user/PR-G-facing log is uniform. */
export type ShedReason = 'ceiling' | 'pace-per-dest' | 'pace-global';

/**
 * One governor per bot, created ONCE (SS2) in the ConnectionManager constructor
 * and reused across every reconnect so a reconnect storm cannot reset the rate
 * budget. Holds the per-destination pacing window, the per-destination hard
 * ceiling, and the aggregate global bucket.
 */
export class OutboundGovernor {
  private readonly perDest: OutboundRateLimiter;
  private readonly ceiling: OutboundRateLimiter;
  private readonly global: OutboundRateLimiter;
  private readonly maxWaitMs: number;

  constructor(cfg: OutboundGovernorConfig) {
    this.perDest = new OutboundRateLimiter(cfg.maxPerWindow, cfg.windowMs);
    this.ceiling = new OutboundRateLimiter(cfg.hardCeiling, cfg.hardCeilingWindowMs);
    this.global = new OutboundRateLimiter(cfg.globalMaxPerWindow, cfg.globalWindowMs);
    this.maxWaitMs = cfg.maxWaitMs;
  }

  /**
   * Gate one paced (text) send to `dest`. Resolves `null` to send now (possibly
   * after a bounded pacing delay already awaited here), or a `ShedReason` to
   * shed (the caller throws + logs). A send must clear ALL THREE gates, in this
   * order:
   *   1. the per-destination pacing window (bounded ≤ maxWaitMs),
   *   2. the aggregate global bucket (bounded ≤ maxWaitMs),
   *   3. the hard per-conversation ceiling (sync — a runaway rejects cheaply).
   *
   * The ceiling is checked LAST, and only reserves its slot when the pacing
   * gates already passed, so its long (e.g. 1h) window counts real sends only.
   * If it went first, a BREADTH flood that sheds at the global bucket would
   * still burn a well-behaved bystander conversation's hour-long ceiling budget
   * (× Tier-A's retries), shedding that conversation on its OWN ceiling for up
   * to the ceiling window after the flood clears — cross-conversation
   * contamination in the long-memory window. The short (few-second) pacing
   * windows, by contrast, self-heal almost immediately, so a slot consumed by a
   * shed there is harmless. `tryAcquireSync` still rejects without growing any
   * wait queue, so ceiling-last does not reintroduce chain growth.
   */
  async gate(dest: string): Promise<ShedReason | null> {
    // 1. Per-destination pacing (depth floods) — short window, self-heals fast.
    const perDest = await this.perDest.acquireBounded(dest, this.maxWaitMs);
    if (perDest.capped) return 'pace-per-dest';
    // 2. Aggregate per-bot pacing (breadth floods, F2) — short window.
    const glob = await this.global.acquireBounded(GLOBAL_BUCKET_KEY, this.maxWaitMs);
    if (glob.capped) return 'pace-global';
    // 3. Catastrophe ceiling LAST — reserves only for a send that cleared pacing,
    //    so the long window never counts a shed bystander's attempts.
    if (!this.ceiling.tryAcquireSync(dest)) return 'ceiling';
    return null;
  }
}

interface GovernorLog {
  warn: (obj: unknown, msg?: string) => void;
}

export interface WrapOutboundGovernorOptions {
  /** The single, reused governor (SS2). */
  governor: OutboundGovernor;
  /** Map a raw send JID to the lid-resolved canonical destination key (H3/F3). */
  resolveDest: (jid: string) => string;
  /** Optional structured logger; the shed log line feeds PR-G. */
  log?: GovernorLog;
  /**
   * Injected send-seam content classifier (#1783). When provided, a text send
   * whose body is a raw provider-error BANNER is redacted before the wire. Wired
   * by the composition root (src/main.ts) from the runtimes classifier; absent in
   * unit tests that do not exercise content-egress.
   */
  classifyProviderBanner?: OutboundBannerClassifier;
}

/** Minimal shape the governor needs — a socket with a `sendMessage` method. */
interface Sendable {
  sendMessage: (...args: unknown[]) => unknown;
  [k: string]: unknown;
}

/**
 * Install the governor on a socket by IN-PLACE OVERRIDE of `sendMessage` (SS1).
 * Returns the SAME socket object (reference identity preserved). Re-run on every
 * reconnect (`this.sock = sock` at connection.ts:681) to re-install on the new
 * socket; the governor STATE lives in the passed-in `governor`, not here.
 *
 * Generic over the concrete socket type (the real Baileys socket has a strongly
 * typed `sendMessage` that does not unify with the internal `Sendable` shape),
 * so the caller keeps its exact socket type on the return; the override is
 * applied through a narrow internal cast.
 */
export function wrapWithOutboundGovernor<S extends object>(
  sock: S,
  opts: WrapOutboundGovernorOptions,
): S {
  const s = sock as unknown as Sendable;
  const original = s.sendMessage;
  const realSend = original.bind(s);

  const governed = async function governedSendMessage(
    jid: string,
    content: unknown,
    ...rest: unknown[]
  ): Promise<unknown> {
    let outbound = content;
    if (classifyOutbound(content) === 'text') {
      const dest = opts.resolveDest(jid);
      const shed = await opts.governor.gate(dest);
      if (shed) {
        opts.log?.warn({ dest, reason: shed }, OUTBOUND_GOVERNOR_SHED_LOG);
        throw new WhatSoupError(OUTBOUND_GOVERNOR_SHED_LOG, 'OUTBOUND_GOVERNOR_SHED');
      }
      // #1783 — send-seam content-egress: redact a raw provider-error BANNER at
      // this ONE convergence point before it reaches the wire. Positive-match
      // only; ambient prose about an error and normal text pass unchanged. Runs
      // only when the classifier is wired (composition root); no-ops otherwise.
      if (opts.classifyProviderBanner) {
        const egress = adjudicateOutboundContent(content, opts.classifyProviderBanner);
        if (egress.redacted) {
          opts.log?.warn({ dest, kind: egress.kind }, OUTBOUND_CONTENT_EGRESS_REDACTED_LOG);
          outbound = egress.content;
        }
      }
    }
    return realSend(jid, outbound, ...rest);
  };

  // Transparent wrapper: copy the underlying fn's own-property descriptors onto
  // the override. In production the real Baileys `sendMessage` carries nothing
  // load-bearing here, so this is a harmless no-op; in tests it preserves a
  // spy's mock API (`.mock`, `.mockResolvedValueOnce`, …) so socket tests keep
  // asserting through the seam without rewiring.
  try {
    Object.defineProperties(governed, Object.getOwnPropertyDescriptors(original));
  } catch {
    // best-effort — never let descriptor copying break send installation
  }

  s.sendMessage = governed as unknown as Sendable['sendMessage'];
  return sock;
}
