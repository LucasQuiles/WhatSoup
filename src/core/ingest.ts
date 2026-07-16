// src/core/ingest.ts
// Shared ingest pipeline: store → admin command routing → access policy → dispatch.
// Used by all runtimes that receive WhatsApp messages.

import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import type { IncomingMessage, Messenger } from './types.ts';
import type { Runtime } from '../runtimes/types.ts';
import type { DurabilityEngine } from './durability.ts';
import { sendTracked } from './durability.ts';
import type { CapabilityGrantManager } from '../lib/capability-grant.ts';
import { classifyErrorForInbound } from './inbound-failure-class.ts';
import { storeMessageIfNew } from './messages.ts';
import { stripLoneSurrogates } from './sanitize-surrogates.ts';
import { isAdminMessage, parseAdminCommand } from './command-router.ts';
import { handleAdminCommand, handleFallbackCommand, handleGrantCommand, sendApprovalRequest } from './admin.ts';
import { shouldRespond } from './access-policy.ts';
import { resolvePhoneFromJid } from './access-list.ts';
import { toConversationKey } from './conversation-key.ts';
import { isLidJid, bareNumber } from './jid-constants.ts';
import { stripSelfMentionsFrom } from '../lib/self-mention-strip.ts';
import { extractProtocol, extractPayload, HealCompletePayloadSchema } from './heal-protocol.ts';
import { handleHealComplete, handleHealEscalate } from './heal.ts';
import { config } from '../config.ts';
import { emitAlert } from '../lib/emit-alert.ts';

const log = createChildLogger('ingest');

// ---------------------------------------------------------------------------
// Backpressure: counting semaphore + bounded overflow queue (SP1)
// ---------------------------------------------------------------------------

// -- Backpressure counters --
let ingestActive = 0;
let ingestQueued = 0;
let ingestDropped = 0;

const DISPLACEMENT_INCIDENT_WINDOW_MS = 15 * 60 * 1000;
const DISPLACEMENT_INCIDENT_LIMITER_MAX_ENTRIES = 256;
const displacementIncidentNextAttemptAt = new Map<string, number>();

/** Returns a snapshot of ingest backpressure counters. */
export function getIngestStats(): { active: number; queued: number; dropped: number } {
  return { active: ingestActive, queued: ingestQueued, dropped: ingestDropped };
}

/**
 * Simple counting semaphore with an external bounded FIFO overflow queue.
 *
 * When all slots are busy, callers are placed in the overflow queue instead of
 * an unbounded internal waiter list. If the overflow queue is full, the oldest
 * group (non-DM) message is dropped; if none, the oldest entry is dropped.
 */
let _activeSlots = 0;

interface QueuedItem {
  msg: IncomingMessage;
  resolve: (result: AdmissionResult) => void;
}

const waitQueue: QueuedItem[] = [];

type AdmissionResult =
  | { status: 'acquired' }
  | { status: 'displaced' };

interface DisplacementIncidentResult {
  accepted: boolean;
  status: 'durably_queued' | 'legacy_accepted_unconfirmed' | 'failed' | 'rate_limited' | 'threw';
}

interface StoredIncomingMessage {
  conversationKey: string;
  isNew: boolean;
}

function persistIncomingMessage(db: Database, msg: IncomingMessage): StoredIncomingMessage | null {
  try {
    const conversationKey = !msg.isGroup && isLidJid(msg.chatJid)
      ? resolvePhoneFromJid(msg.chatJid, db)
      : toConversationKey(msg.chatJid);
    const isNew = storeMessageIfNew(db, {
      chatJid: msg.chatJid,
      conversationKey,
      senderJid: msg.senderJid,
      senderName: msg.senderName,
      messageId: msg.messageId,
      content: msg.content,
      contentText: msg.contentText ?? null,
      contentType: msg.contentType,
      isFromMe: msg.isFromMe,
      timestamp: msg.timestamp,
      quotedMessageId: msg.quotedMessageId,
      rawMessage: msg.rawMessage != null ? JSON.stringify(msg.rawMessage) : null,
    });
    return { conversationKey, isNew };
  } catch (err) {
    log.error({ err, messageId: msg.messageId }, 'failed to store message');
    return null;
  }
}

function reserveDisplacementIncidentWindow(conversationKey: string, now: number): boolean {
  const nextAttemptAt = displacementIncidentNextAttemptAt.get(conversationKey);
  if (nextAttemptAt !== undefined) {
    displacementIncidentNextAttemptAt.delete(conversationKey);
    if (now < nextAttemptAt) {
      displacementIncidentNextAttemptAt.set(conversationKey, nextAttemptAt);
      return false;
    }
  }

  if (displacementIncidentNextAttemptAt.size >= DISPLACEMENT_INCIDENT_LIMITER_MAX_ENTRIES) {
    const leastRecentlyUsed = displacementIncidentNextAttemptAt.keys().next().value;
    if (leastRecentlyUsed !== undefined) displacementIncidentNextAttemptAt.delete(leastRecentlyUsed);
  }
  displacementIncidentNextAttemptAt.set(conversationKey, now + DISPLACEMENT_INCIDENT_WINDOW_MS);
  return true;
}

function emitDisplacementIncident(msg: IncomingMessage, queueDepth: number): DisplacementIncidentResult {
  const now = Date.now();
  const conversationKey = toConversationKey(msg.chatJid);
  if (!reserveDisplacementIncidentWindow(conversationKey, now)) {
    return { accepted: false, status: 'rate_limited' };
  }

  try {
    const result = emitAlert(
      config.botName,
      'ingest_queue_displacement',
      'ingest queue displaced a pre-journal message',
      JSON.stringify({
        chatJid: msg.chatJid,
        messageId: msg.messageId,
        evictionReason: 'wait_queue_capacity',
        queueDepth,
      }),
      'warning',
    );
    return {
      accepted: result.status === 'durably_queued',
      status: result.status,
    };
  } catch (err) {
    log.error({ err, chatJid: msg.chatJid, messageId: msg.messageId }, 'ingest displacement incident emission threw');
    return { accepted: false, status: 'threw' };
  }
}

/**
 * Try to acquire a concurrency slot. The result distinguishes an acquired
 * slot from a message displaced out of the overflow queue while waiting.
 */
function acquireSlot(msg: IncomingMessage): Promise<AdmissionResult> {
  const maxConcurrent = config.ingest?.maxConcurrent ?? 20;
  const maxQueueDepth = config.ingest?.maxQueueDepth ?? 500;

  // Fast path: slot available
  if (_activeSlots < maxConcurrent) {
    _activeSlots++;
    ingestActive++;
    return Promise.resolve({ status: 'acquired' });
  }

  // Slow path: queue is full — need to drop something
  if (waitQueue.length >= maxQueueDepth) {
    // Prefer dropping group messages (lower priority) over DMs
    const queueDepth = waitQueue.length;
    const groupIdx = waitQueue.findIndex((q) => q.msg.isGroup === true);
    const dropIdx = groupIdx !== -1 ? groupIdx : 0;
    const dropped = waitQueue.splice(dropIdx, 1)[0];

    dropped.resolve({ status: 'displaced' }); // unblock the dropped task so it can exit
    ingestDropped++;
    ingestQueued--;
    const displacementIncident = emitDisplacementIncident(dropped.msg, queueDepth);

    log.warn(
      {
        droppedMessageId: dropped.msg.messageId,
        chatJid: dropped.msg.chatJid,
        isGroup: dropped.msg.isGroup,
        queueDepth,
        displacementIncidentAccepted: displacementIncident.accepted,
        displacementIncidentStatus: displacementIncident.status,
      },
      'ingest queue full, dropped message',
    );
  }

  // Enqueue this message
  return new Promise<AdmissionResult>((resolve) => {
    const item: QueuedItem = {
      msg,
      resolve,
    };
    waitQueue.push(item);
    ingestQueued++;
  });
}

/** Release a concurrency slot, waking the next queued item if any. */
function releaseSlot(): void {
  const next = waitQueue.shift();
  if (next) {
    ingestQueued--;
    ingestActive++;
    // Slot transfers directly — _activeSlots stays the same
    next.resolve({ status: 'acquired' });
  } else {
    _activeSlots--;
  }
}

/**
 * Create a fire-and-forget ingest handler that routes incoming messages
 * through the shared pipeline before dispatching eligible messages to the
 * given runtime.
 *
 * Steps (in order):
 *   pre-admission. Sanitize every message; correlate and store self echoes before displacement
 *   0. Control plane intercept — if extractProtocol matches and sender is a controlPeer, store in
 *      control_messages (NOT messages), journal as skipped, and return
 *   1. Store the message (always, even if later rejected)
 *   1b. Echo short-circuit — if isFromMe, return after its pre-admission storage
 *   1c. Passive short-circuit — journal as complete, return (no runtime dispatch)
 *   2. Check admin commands — consumed here, not forwarded to runtime
 *   3. Apply access policy (shouldRespond)
 *   4. Send approval request for unknown senders
 *   5. Journal inbound event via durabilityEngine.journalInbound
 *   6. Dispatch eligible messages to runtime.handleMessage(msg)
 */
export function createIngestHandler(
  db: Database,
  messenger: Messenger,
  runtime: Runtime,
  getBotJid: () => string,
  getBotLid: () => string | null,
  durability?: DurabilityEngine,
  instanceType?: string,
  grantManager?: CapabilityGrantManager,
): (msg: IncomingMessage) => void {
  return function ingestMessage(msg: IncomingMessage): void {
    void (async () => {
      let slotAcquired = false;
      try {
        // QR-056 / QR-074: strip lone surrogates from inbound text at the shared
        // ingestion chokepoint. Lone surrogates (a crafted WhatsApp pushName /
        // senderName per QR-056, or a crafted UCS-2 SMS body / Twilio content per
        // QR-074) otherwise reach the spawned-CLI provider sink unsanitized, where
        // server-side JSON parsers (Python/Rust) reject them → turn-level DoS.
        // Sanitizing here covers every ingress (the WhatsApp message-parser already
        // strips content but not senderName; the Twilio bridge strips neither) and
        // cleans the in-memory msg before BOTH storage and runtime dispatch.
        // stripLoneSurrogates fast-paths strings with no surrogates (no realloc).
        if (msg.content !== null) msg.content = stripLoneSurrogates(msg.content);
        if (msg.senderName !== null) msg.senderName = stripLoneSurrogates(msg.senderName);
        if (msg.contentText !== null) msg.contentText = stripLoneSurrogates(msg.contentText);

        // Correlate and idempotently store outbound echoes without consuming
        // bounded admission capacity. The shared helper below keeps the normal
        // downstream storage path behavior-identical without double writes.
        if (msg.isFromMe && durability) {
          try {
            durability.matchEcho(msg.messageId);
          } catch (err) {
            log.error({ err, messageId: msg.messageId }, 'failed to correlate outbound echo');
          }
        }
        if (msg.isFromMe) {
          const storedEcho = persistIncomingMessage(db, msg);
          if (!storedEcho) return;
          if (!storedEcho.isNew) {
            log.debug({ messageId: msg.messageId, reason: 'duplicate' }, 'skipping duplicate message delivery');
          }
          return;
        }

        // --- Backpressure gate (SP1) ---
        const admission = await acquireSlot(msg);
        if (admission.status === 'displaced') return;
        slotAcquired = true;

        // 0. Control plane intercept — before any normal storage
        if (msg.content && extractProtocol(msg.content) !== null) {
          const phone = resolvePhoneFromJid(msg.senderJid, db);
          const isPeer = [...config.controlPeers.values()].includes(phone);
          if (isPeer) {
            const protocol = extractProtocol(msg.content);
            // Store in control_messages, NOT messages
            try {
              db.raw.prepare(`
                INSERT OR IGNORE INTO control_messages (message_id, direction, peer_jid, protocol, payload)
                VALUES (?, 'inbound', ?, ?, ?)
              `).run(msg.messageId, msg.senderJid, protocol, msg.content);
            } catch (err) {
              log.error({ err, messageId: msg.messageId }, 'failed to store control message');
            }

            log.debug({ protocol, peer: msg.senderJid, messageId: msg.messageId }, 'control message intercepted');

            // Route HEAL_COMPLETE and HEAL_ESCALATE to the heal state machine
            if (protocol === 'HEAL_COMPLETE' || protocol === 'HEAL_ESCALATE') {
              try {
                const payload = extractPayload(msg.content);
                if (payload) {
                  const parsed = HealCompletePayloadSchema.parse(payload);
                  if (protocol === 'HEAL_COMPLETE') {
                    handleHealComplete(db, parsed);
                  } else {
                    handleHealEscalate(db, parsed);
                  }
                }
              } catch (err) {
                log.error({ err, messageId: msg.messageId, protocol }, 'failed to handle control message payload');
              }
            }

            if (durability) {
              const seq = durability.journalInbound(msg.messageId, toConversationKey(msg.chatJid), msg.chatJid, 'control');
              durability.markInboundSkipped(seq, 'control_message');
            }
            return;
          }
        }

        // 1. Store the incoming message — always, even if we later reject it.
        //    Atomic insert: INSERT OR IGNORE returns false if message_id already exists.
        //    For LID DMs, resolve to the phone-based conversation key so messages from
        //    the same person (via LID or JID) share one conversation thread.
        const storedMessage = persistIncomingMessage(db, msg);
        if (!storedMessage) return;
        const { conversationKey } = storedMessage;
        if (!storedMessage.isNew) {
          log.debug({ messageId: msg.messageId, reason: 'duplicate' }, 'skipping duplicate message delivery');
          return;
        }

        // 1b+. Feed-visible inbound log -- carries messageId + chatJid for preview enrichment.
        // Guard: !isFromMe is guaranteed here (isFromMe returns above).
        log.info(
          { messageId: msg.messageId, chatJid: msg.chatJid, senderName: msg.senderName, contentType: msg.contentType },
          'inbound message received',
        );

        let parsedAdminCommand: ReturnType<typeof parseAdminCommand> | null | undefined;
        const getAdminCommand = (): ReturnType<typeof parseAdminCommand> | null => {
          if (!msg.content || !isAdminMessage(msg, db)) return null;
          if (parsedAdminCommand === undefined) {
            parsedAdminCommand = parseAdminCommand(msg.content);
          }
          return parsedAdminCommand;
        };
        const pausedChats = config.pausedChats ?? new Set<string>();

        // 1b++. Paused chat short-circuit — message stored above, skip dispatch entirely.
        if ((pausedChats.has(conversationKey) || pausedChats.has(msg.chatJid)) && !getAdminCommand()) {
          log.info({ chatJid: msg.chatJid, messageId: msg.messageId }, 'chat paused — skipping dispatch');
          if (durability) {
            const seq = durability.journalInbound(msg.messageId, conversationKey, msg.chatJid, 'none');
            durability.markInboundSkipped(seq, 'chat_paused');
          }
          return;
        }

        // 1c. Passive short-circuit — store message, journal as complete, no dispatch
        if (instanceType === 'passive') {
          if (durability) {
            const seq = durability.journalInbound(msg.messageId, conversationKey, msg.chatJid, 'passive');
            durability.markInboundSkipped(seq, 'passive_instance');
          }
          return;
        }

        // 2. Check admin commands FIRST (before trigger check)
        const cmd = getAdminCommand();
        if (cmd) {
          let seq: number | undefined;
          if (durability) {
            seq = durability.journalInbound(msg.messageId, conversationKey, msg.chatJid, 'admin');
          }
          try {
            if (cmd.action === 'fallback') {
              await handleFallbackCommand(runtime, messenger, cmd, msg.chatJid, durability);
            } else if (cmd.action === 'grant') {
              if (grantManager) {
                await handleGrantCommand(grantManager, messenger, cmd, msg.chatJid, durability);
              } else {
                await sendTracked(messenger, msg.chatJid, 'Capability grants are not enabled on this instance.', durability, { replayPolicy: 'safe', isTerminal: true });
              }
            } else {
              await handleAdminCommand(
                db,
                messenger,
                cmd.action,
                cmd.subjectType,
                cmd.subjectId,
                msg.chatJid,
                (m) => runtime.handleMessage(m),
                durability,
              );
            }
          } catch (err) {
            log.error({ err, messageId: msg.messageId }, 'failed to handle admin command');
          }
          if (durability && seq !== undefined) {
            durability.markInboundSkipped(seq, 'admin_command');
          }
          return;
        }

        // 3. Access policy / trigger check
        const triggerResult = shouldRespond(msg, getBotJid(), getBotLid(), db);
        if (!triggerResult.respond) {
          log.info(
            { messageId: msg.messageId, reason: triggerResult.reason, accessStatus: triggerResult.accessStatus },
            'ingest: not dispatching',
          );

          // 4. Send approval request for unknown senders
          if (triggerResult.accessStatus === 'unknown') {
            const approvalPhone = resolvePhoneFromJid(msg.senderJid, db);
            try {
              await sendApprovalRequest(db, messenger, approvalPhone, msg.senderName ?? '', msg.content ?? '', durability);
            } catch (err) {
              log.error({ err, phone: approvalPhone }, 'failed to send approval request');
            }
          }

          if (durability) {
            const seq = durability.journalInbound(msg.messageId, conversationKey, msg.chatJid, 'none');
            durability.markInboundSkipped(seq, 'access_denied');
          }

          return;
        }

        // 5. Journal inbound event before dispatch so runtime can link outbound ops
        const routedTo = runtime.constructor?.name?.toLowerCase() ?? 'runtime';
        let seq: number | undefined;
        if (durability) {
          seq = durability.journalInbound(msg.messageId, conversationKey, msg.chatJid, routedTo);
          msg.inboundSeq = seq;  // Thread seq into runtime for lifecycle tracking
        }

        // Strip the bot's own @mention token from inbound GROUP text so the agent
        // sees the user's intent, not the bot's own identifier (WhatsApp embeds the
        // raw `@<jid-digits>` at the mention point). The stored copy was persisted
        // above with the raw text; only the runtime-bound content is cleaned. #1854
        if (msg.isGroup && msg.content) {
          const botIds: string[] = [];
          const bj = getBotJid();
          if (bj) botIds.push(bj, bareNumber(bj));
          const bl = getBotLid();
          if (bl) botIds.push(bl, bareNumber(bl));
          if (botIds.length > 0) {
            msg.content = stripSelfMentionsFrom(msg.content, botIds);
          }
        }

        // 6. Dispatch to runtime
        try {
          await runtime.handleMessage(msg);
        } catch (err) {
          log.error({ err, messageId: msg.messageId }, 'runtime.handleMessage threw');
          if (durability && seq !== undefined) {
            durability.markInboundFailed(seq, classifyErrorForInbound(err));
          }
        }
      } catch (err) {
        log.error({ err, messageId: msg.messageId }, 'unhandled error in ingest handler');
      } finally {
        if (slotAcquired) {
          ingestActive--;
          try {
            releaseSlot();
          } catch (releaseErr) {
            log.error({ err: releaseErr, messageId: msg.messageId }, 'releaseSlot failed — slot may be permanently consumed');
          }
        }
      }
    })();
  };
}
