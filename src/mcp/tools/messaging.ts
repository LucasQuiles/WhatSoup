// src/mcp/tools/messaging.ts
// Chat-scoped messaging tools: send, reply, react, edit, delete, location,
// contact, poll, pin.

import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolRegistry } from '../registry.ts';
import { errorResult, toolError, type SessionContext } from '../types.ts';
import type { RuntimeConnection } from '../../transport/runtime-connection.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import {
  AliasNotFoundError,
  MissingTargetError,
  MutuallyExclusiveError,
  createChatResolver,
} from '../../core/chats-resolver.ts';
import {
  InvalidSendRequestError,
  MissingTextError,
  createSendPipeline,
  type PreparedTextSend,
} from '../../core/send-pipeline.ts';
import { UnknownProfileError, type ProfileRegistry } from '../../core/profiles.ts';
import {
  evaluateOutboundMessageSafety,
  redactInternalArtifacts,
  resolveOutboundAudience,
  type OutboundMessageSafetyDecision,
} from '../../core/outbound-message-safety.ts';
import { emitAlertChecked } from '../../lib/emit-alert.ts';
import type { OutboundSendsWriter } from '../../core/outbound-sends.ts';
import { formatMentions } from '../../core/mentions.ts';
import type { MessageRow } from '../../core/messages.ts';
import type { ResolutionStrategy } from '../../runtimes/agent/runtime.ts';
import { errorMessage } from '../../lib/error-message.ts';

// ---------------------------------------------------------------------------
// Error sanitization — prevent raw API/protocol errors from leaking to agents
// ---------------------------------------------------------------------------

function sanitizeError(err: unknown): string {
  const raw = errorMessage(err);
  // Map known error patterns to user-friendly messages
  if (/not connected|connection closed|socket|ECONNRESET/i.test(raw)) {
    return 'WhatsApp is temporarily disconnected. Try again in a moment.';
  }
  if (/timeout|ETIMEDOUT/i.test(raw)) {
    return 'The request timed out. Try again.';
  }
  if (/rate.?limit|429|too many/i.test(raw)) {
    return 'Too many requests. Wait a moment and try again.';
  }
  if (/not found|404/i.test(raw)) {
    return 'The requested resource was not found.';
  }
  if (/unauthorized|forbidden|403|401/i.test(raw)) {
    return 'Permission denied for this operation.';
  }
  // Generic fallback — don't expose raw error details
  return 'Operation failed. Try again.';
}

// ---------------------------------------------------------------------------
// Client-safety: route diverted false-claim evidence to ops
// ---------------------------------------------------------------------------

// When a client-bound message is diverted (the agent made a false infra-block
// self-diagnosis), route the sanitized original diagnostic to BOT ERRORS so ops
// learns the agent malfunctioned. The original incident was invisible to ops
// until the client reported it; this closes that loop. emitAlert is sync, never
// throws, and durably queues — safe to call inline on the send path.
function routeDivertToOps(
  decision: OutboundMessageSafetyDecision | null,
  instanceName: string | undefined,
): void {
  if (!decision || decision.action !== 'divert' || !decision.opsEvidence) return;
  // emitAlertChecked (not raw emitAlert) per the BOT ERRORS governance contract —
  // production callers must use the checked wrapper (adds emission telemetry).
  emitAlertChecked(
    instanceName ?? 'unknown',
    'outbound_message_guard',
    'agent emitted a false infra-status claim to a client; diverted to a generic reply',
    decision.opsEvidence,
    'warning',
  );
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface PollRegistrar {
  register(
    pollId: string,
    chatJid: string,
    options: string[],
    resolution: ResolutionStrategy,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<string>;
}

export interface MessagingDeps {
  connection: RuntimeConnection;
  db: DatabaseSync;
  profiles?: ProfileRegistry;
  auditWriter?: OutboundSendsWriter;
  pollRegistrar?: PollRegistrar;
  /** Instance/bot name, used to attribute outbound-guard ops alerts. */
  instanceName?: string;
}

const POLL_QUESTION_MAX_CHARS = 900;
const POLL_OPTION_MAX_CHARS = 95;

type OwnershipRow = Pick<MessageRow, 'conversation_key' | 'is_from_me' | 'chat_jid' | 'message_id' | 'sender_jid' | 'content'>;

interface OwnershipResult {
  row?: OwnershipRow;
  error?: string;
}

function validateMessageOwnership(
  db: DatabaseSync,
  messageId: string,
  session: SessionContext,
): OwnershipResult {
  if (session.conversationKey) {
    const row = db
      .prepare(
        `SELECT conversation_key, is_from_me, chat_jid, message_id, sender_jid, content
         FROM messages
         WHERE message_id = ? AND conversation_key = ?`,
      )
      .get(messageId, session.conversationKey) as OwnershipRow | undefined;

    if (!row) {
      return { error: 'Message not found' };
    }

    return { row };
  }

  if (session.tier === 'chat-scoped') {
    return { error: 'Chat-scoped session has no conversation key' };
  }

  const row = db
    .prepare('SELECT conversation_key, is_from_me, chat_jid, message_id, sender_jid, content FROM messages WHERE message_id = ?')
    .get(messageId) as OwnershipRow | undefined;

  if (!row) {
    return { error: 'Message not found' };
  }

  return { row };
}

// ---------------------------------------------------------------------------
// Register all messaging tools
// ---------------------------------------------------------------------------

export function registerMessagingTools(
  registry: ToolRegistry,
  deps: MessagingDeps,
): void {
  const { connection, db } = deps;
  const sendPipeline = createSendPipeline({
    resolver: createChatResolver({ db }),
    profiles: deps.profiles,
    auditWriter: deps.auditWriter,
    caller: 'mcp',
  });

  // ── send_message ──────────────────────────────────────────────────────────

  registry.register({
    name: 'send_message',
    description: 'Send a text message to the current chat. Supports @name and @number mentions.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string().optional(),
      to: z.string().optional().describe('Per-instance chat alias to resolve against this line database. Mutually exclusive with chatJid.'),
      text: z.string(),
      profile: z.string().optional().describe('Optional per-instance send profile for text decoration and link preview policy.'),
      viewOnce: z.boolean().optional().describe('Send as a view-once message that disappears after viewing.'),
      link_preview: z.enum(['auto', 'off']).optional().describe('Control link preview generation. "auto" (default) uses Baileys auto-preview. "off" suppresses the preview entirely.'),
    }),
    handler: async (params, session: SessionContext) => {
      let formattedText = '';
      let guardDecision: OutboundMessageSafetyDecision | null = null;
      try {
        await sendPipeline.executeSend(params, async (prepared) => {
          const viewOnce = params['viewOnce'] as boolean | undefined;
          const { text: formatted, jids: mentions, hasMentions } = formatMentions(
            prepared.text,
            connection.contactsDir.contacts,
            connection.contactsDir.getLidMappings(),
          );
          formattedText = formatted;

          const content: Record<string, unknown> = hasMentions
            ? { text: formatted, mentions }
            : { text: formatted };
          if (prepared.linkPreviewMode === 'off') content['linkPreview'] = null;
          if (viewOnce) content['viewOnce'] = true;
          const receipt = await connection.sendRaw(prepared.chatJid, content);
          return { transportId: receipt.waMessageId };
        }, {
          // Client-safety guardrail: never let agent free-text leak internal
          // artifacts or a false infra-block self-diagnosis to a client. Sends
          // addressed to the configured BOT ERRORS ops channel are treated as
          // ops (verbatim). Everything else defaults to `client` — the
          // conservative direction (a false-positive redaction on an operator
          // message is low-harm; a leak to a client is high-harm). On divert,
          // routeDivertToOps (after the send) routes the sanitized diagnostic to
          // BOT ERRORS so ops learns the agent malfunctioned.
          transformPrepared(prepared: PreparedTextSend): PreparedTextSend {
            const audience = resolveOutboundAudience(prepared.chatJid);
            const decision = evaluateOutboundMessageSafety({ text: prepared.text, audience });
            guardDecision = decision;
            if (decision.action === 'allow') return prepared;
            return {
              ...prepared,
              text: decision.text,
              audit: { ...prepared.audit, textLength: decision.text.length },
            };
          },
          beforeAudit(prepared: PreparedTextSend): void {
            if (session.tier !== 'global' || !session.conversationKey) return;

            let resolvedConversationKey: string;
            try {
              resolvedConversationKey = toConversationKey(prepared.chatJid);
            } catch {
              throw new Error(`Invalid chatJid "${prepared.chatJid}": must be a valid JID`);
            }
            if (resolvedConversationKey !== session.conversationKey) {
              throw new Error(
                `chatJid "${prepared.chatJid}" resolves to conversation "${resolvedConversationKey}" which does not match session conversation "${session.conversationKey}"`,
              );
            }
          },
        });
      } catch (err) {
        if (
          err instanceof AliasNotFoundError ||
          err instanceof MissingTargetError ||
          err instanceof MutuallyExclusiveError ||
          err instanceof InvalidSendRequestError ||
          err instanceof MissingTextError ||
          err instanceof UnknownProfileError
        ) {
          return errorResult(err.message);
        }
        if (err instanceof Error && (err.message.startsWith('chatJid "') || err.message.startsWith('Invalid chatJid "'))) {
          return errorResult(err.message);
        }
        return errorResult(sanitizeError(err));
      }

      routeDivertToOps(guardDecision, deps.instanceName);
      return { sent: true, text: formattedText };
    },
  });

  // ── reply_message ─────────────────────────────────────────────────────────

  registry.register({
    name: 'reply_message',
    description: 'Reply to a specific message by its ID.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string(),
      messageId: z.string(),
      text: z.string(),
      link_preview: z.enum(['auto', 'off']).optional().describe('Control link preview generation. "auto" (default) uses Baileys auto-preview. "off" suppresses the preview entirely.'),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const messageId = params['messageId'] as string;
      const text = params['text'] as string;
      const linkPreviewMode = (params['link_preview'] as string | undefined) ?? 'auto';

      const { row, error } = validateMessageOwnership(db, messageId, session);
      if (error) return errorResult(error);

      // Client-safety guardrail: reply_message sends agent free-text straight to
      // transport (it does not use the send pipeline), so it must apply the same
      // guard as send_message or it is a trivial bypass.
      const replyDecision = evaluateOutboundMessageSafety({
        text,
        audience: resolveOutboundAudience(chatJid),
      });

      try {
        const content: Record<string, unknown> = {
          text: replyDecision.text,
          contextInfo: {
            stanzaId: row!.message_id,
            participant: row!.sender_jid,
            quotedMessage: { conversation: row!.content ?? '' },
          },
        };
        if (linkPreviewMode === 'off') content['linkPreview'] = null;
        await connection.sendRaw(chatJid, content);
      } catch (err) {
        return errorResult(sanitizeError(err));
      }

      routeDivertToOps(replyDecision, deps.instanceName);
      return { sent: true, quotedMessageId: messageId };
    },
  });

  // ── react_message ─────────────────────────────────────────────────────────

  registry.register({
    name: 'react_message',
    description: 'React to a message with an emoji. Pass empty string to remove reaction. When messageId is omitted, reacts to the most recent inbound message in the chat.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    schema: z.object({
      chatJid: z.string(),
      messageId: z.string().optional().describe('Message ID to react to. Omit to react to the most recent inbound message in the chat.'),
      emoji: z.string(),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      let messageId = params['messageId'] as string | undefined;
      const emoji = params['emoji'] as string;

      // When messageId is omitted, resolve to most recent inbound message in the chat.
      // Uses chat_jid (raw JID) for lookup — works for both global sessions
      // (where conversationKey is undefined) and chat-scoped sessions.
      // conversation_key uses normalized form (e.g. "123_at_g.us") which won't
      // match the raw chatJid ("123@g.us") in global sessions.
      if (!messageId) {
        const recent = db
          .prepare(
            `SELECT message_id, is_from_me, chat_jid, sender_jid, content, conversation_key
             FROM messages
             WHERE chat_jid = ? AND is_from_me = 0
             ORDER BY timestamp DESC
             LIMIT 1`,
          )
          .get(chatJid) as OwnershipRow | undefined;
        if (!recent) {
          return errorResult('No recent inbound message found in this chat to react to');
        }
        messageId = recent.message_id;
        // Skip ownership validation — we just queried it directly
        try {
          await connection.sendRaw(chatJid, {
            react: {
              text: emoji,
              key: {
                remoteJid: chatJid,
                id: recent.message_id,
                fromMe: Boolean(recent.is_from_me),
              },
            },
          });
        } catch (err) {
          return errorResult(sanitizeError(err));
        }
        return { sent: true, emoji, messageId, resolved: 'last_inbound' };
      }

      const { row, error } = validateMessageOwnership(db, messageId, session);
      if (error) return errorResult(error);

      try {
        await connection.sendRaw(chatJid, {
          react: {
            text: emoji,
            key: {
              remoteJid: chatJid,
              id: row!.message_id,
              fromMe: Boolean(row!.is_from_me),
            },
          },
        });
      } catch (err) {
        return errorResult(sanitizeError(err));
      }

      return { sent: true, emoji, messageId };
    },
  });

  // ── edit_message ──────────────────────────────────────────────────────────

  registry.register({
    name: 'edit_message',
    description: 'Edit a message you previously sent.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    schema: z.object({
      chatJid: z.string(),
      messageId: z.string(),
      newText: z.string(),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const messageId = params['messageId'] as string;
      const newText = params['newText'] as string;

      const { row, error } = validateMessageOwnership(db, messageId, session);
      if (error) return errorResult(error);

      if (!row!.is_from_me) {
        return errorResult('Can only edit your own messages');
      }

      // Client-safety guardrail: an edit replaces sent client text, so it is
      // another agent free-text vector and must apply the same guard.
      const editDecision = evaluateOutboundMessageSafety({
        text: newText,
        audience: resolveOutboundAudience(chatJid),
      });
      const safeText = editDecision.text;

      try {
        await connection.sendRaw(chatJid, {
          text: safeText,
          edit: {
            remoteJid: chatJid,
            id: row!.message_id,
            fromMe: true,
          },
        });
      } catch (err) {
        return errorResult(sanitizeError(err));
      }

      routeDivertToOps(editDecision, deps.instanceName);
      return { edited: true, messageId, newText: safeText };
    },
  });

  // ── delete_message ────────────────────────────────────────────────────────

  registry.register({
    name: 'delete_message',
    description: 'Delete a message (for everyone). Only works on your own messages unless you are a group admin.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    schema: z.object({
      chatJid: z.string(),
      messageId: z.string(),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const messageId = params['messageId'] as string;

      const { row, error } = validateMessageOwnership(db, messageId, session);
      if (error) return errorResult(error);

      try {
        await connection.sendRaw(chatJid, {
          delete: {
            remoteJid: chatJid,
            id: row!.message_id,
            fromMe: Boolean(row!.is_from_me),
          },
        });
      } catch (err) {
        return errorResult(sanitizeError(err));
      }

      return { deleted: true, messageId };
    },
  });

  // ── send_location ─────────────────────────────────────────────────────────

  registry.register({
    name: 'send_location',
    description: 'Send a location pin to the current chat.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string(),
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().optional(),
      address: z.string().optional(),
      viewOnce: z.boolean().optional().describe('Send as a view-once message that disappears after viewing.'),
    }),
    handler: async (params, _session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const latitude = params['latitude'] as number;
      const longitude = params['longitude'] as number;
      const name = params['name'] as string | undefined;
      const address = params['address'] as string | undefined;
      const viewOnce = params['viewOnce'] as boolean | undefined;

      try {
        const content: Record<string, unknown> = {
          location: {
            degreesLatitude: latitude,
            degreesLongitude: longitude,
            name,
            address,
          },
        };
        if (viewOnce) content['viewOnce'] = true;
        await connection.sendRaw(chatJid, content);
      } catch (err) {
        return errorResult(sanitizeError(err));
      }

      return { sent: true, latitude, longitude };
    },
  });

  // ── send_contact ──────────────────────────────────────────────────────────

  registry.register({
    name: 'send_contact',
    description: 'Send one or more contact cards to the current chat.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string(),
      contacts: z
        .array(
          z.object({
            displayName: z.string().describe('Contact display name'),
            phone: z.string().describe('Phone number (digits, optionally with +)'),
          }),
        )
        .min(1)
        .describe('One or more contacts to send'),
      viewOnce: z.boolean().optional().describe('Send as a view-once message that disappears after viewing.'),
    }),
    handler: async (params, _session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const contacts = params['contacts'] as Array<{ displayName: string; phone: string }>;
      const viewOnce = params['viewOnce'] as boolean | undefined;

      const contactCards = contacts.map((c) => {
        const digits = c.phone.replace(/\D/g, '');
        return {
          vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${c.displayName}\nTEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`,
        };
      });

      const displayName =
        contactCards.length === 1 ? contacts[0].displayName : `${contactCards.length} contacts`;

      try {
        const content: Record<string, unknown> = {
          contacts: { displayName, contacts: contactCards },
        };
        if (viewOnce) content['viewOnce'] = true;
        await connection.sendRaw(chatJid, content);
      } catch (err) {
        return errorResult(sanitizeError(err));
      }

      return { sent: true, count: contactCards.length };
    },
  });

  // ── send_poll ─────────────────────────────────────────────────────────────

  registry.register({
    name: 'send_poll',
    description: 'Send a poll to the current chat. Use for lightweight decisions or surveys; for blocking user input, prefer AskUserQuestion when available.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string().describe('Target WhatsApp chat JID. Injected automatically in chat-scoped sessions.'),
      question: z.string().describe('Poll question text. Keep it concise; send long context in a normal message before the poll.'),
      options: z.array(
        z.string().describe('Short poll option label. Keep under the WhatsApp option limit; send paragraph details before the poll.'),
      ).describe('Poll options. Must contain 2-12 unique, non-empty labels.'),
      selectableCount: z.number().optional().describe('Whole number of options the voter may select. Defaults to 1; use values above 1 for multi-select polls and never exceed options.length.'),
      resolution: z.enum(['first-vote-wins', 'admin-only', 'admin-wins', 'majority-after-timeout']).optional()
        .describe('Resolution strategy. Defaults to first-vote-wins.'),
      timeoutMs: z.number().int().min(1000).max(86_400_000).optional()
        .describe('Timeout in ms. Min 1000 (1s), default 3600000 (1 hour), max 86400000 (24 hours).'),
      awaitResult: z.boolean().optional().describe('If true, block until poll resolves. Default false.'),
    }),
    handler: async (params, _session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const question = (params['question'] as string).trim();
      const options = (params['options'] as string[]).map((option) => option.trim());
      const selectableCount = params['selectableCount'] as number | undefined;

      if (!question) {
        return errorResult('Poll question is required');
      }

      if (question.length > POLL_QUESTION_MAX_CHARS) {
        return errorResult(`Poll question must be ${POLL_QUESTION_MAX_CHARS} characters or fewer. Send context as a separate message before the poll.`);
      }

      if (options.length < 2) {
        return errorResult('Poll requires at least 2 options');
      }

      if (options.length > 12) {
        return errorResult('Poll allows at most 12 options');
      }

      const blankOptionIndex = options.findIndex((option) => option.length === 0);
      if (blankOptionIndex !== -1) {
        return errorResult(`Poll option ${blankOptionIndex + 1} is blank`);
      }

      const longOption = options.find((option) => option.length > POLL_OPTION_MAX_CHARS);
      if (longOption) {
        return errorResult(`Poll options must be ${POLL_OPTION_MAX_CHARS} characters or fewer. Keep options concise and send longer context before the poll.`);
      }

      const normalized = new Set<string>();
      for (const option of options) {
        const key = option.toLowerCase();
        if (normalized.has(key)) {
          return errorResult(`Poll options must be unique: ${option}`);
        }
        normalized.add(key);
      }

      const resolvedSelectableCount = selectableCount ?? 1;
      if (!Number.isInteger(resolvedSelectableCount)) {
        return errorResult('selectableCount must be a whole number');
      }
      if (resolvedSelectableCount < 1) {
        return errorResult('selectableCount must be at least 1');
      }
      if (resolvedSelectableCount > options.length) {
        return errorResult('selectableCount cannot exceed the number of poll options');
      }

      // Client-safety guardrail: poll question and options are agent free-text.
      // Redaction-only — diverting a poll to a generic sentence is nonsensical,
      // so we mask internal artifacts but keep the poll structure. Ops-channel
      // polls are left verbatim.
      const pollAudience = resolveOutboundAudience(chatJid);
      const safeQuestion = pollAudience === 'client' ? redactInternalArtifacts(question).text : question;
      const safeOptions = pollAudience === 'client'
        ? options.map((option) => redactInternalArtifacts(option).text)
        : options;

      const resolvedResolution = (params['resolution'] as ResolutionStrategy | undefined) ?? 'first-vote-wins';
      // Defense in depth: even though the zod schema enforces [1000, 86_400_000],
      // clamp at the handler too so any path that bypasses validation still gets safe bounds.
      const resolvedTimeoutMs = Math.min(
        Math.max((params['timeoutMs'] as number | undefined) ?? 3_600_000, 1_000),
        86_400_000,
      );
      const awaitResult = (params['awaitResult'] as boolean | undefined) ?? false;

      try {
        const result = await connection.sendPollMessage(chatJid, safeQuestion, safeOptions, resolvedSelectableCount);

        if (awaitResult && result.waMessageId && result.hasSecret && deps.pollRegistrar) {
          const abortSignal = _session.abortSignal;
          if (abortSignal?.aborted) {
            return { sent: true, pollId: result.waMessageId, question: safeQuestion, options: safeOptions, selectableCount: resolvedSelectableCount, error: 'Poll cancelled before await began', awaitFailed: true };
          }
          try {
            const answer = await deps.pollRegistrar.register(
              result.waMessageId, chatJid, safeOptions,
              resolvedResolution, resolvedTimeoutMs, abortSignal,
            );
            return { sent: true, pollId: result.waMessageId, question: safeQuestion, options: safeOptions, selectableCount: resolvedSelectableCount, answer };
          } catch (err) {
            return { sent: true, pollId: result.waMessageId, question: safeQuestion, options: safeOptions, selectableCount: resolvedSelectableCount, error: 'Poll timed out or was cancelled', awaitFailed: true };
          }
        }

        if (awaitResult && !(result.waMessageId && result.hasSecret && deps.pollRegistrar)) {
          return { sent: true, pollId: result.waMessageId, question: safeQuestion, options: safeOptions, selectableCount: resolvedSelectableCount,
                   awaitFailed: true, error: 'Poll sent but vote tracking unavailable — cannot await result' };
        }

        return { sent: true, pollId: result.waMessageId, question: safeQuestion, options: safeOptions, selectableCount: resolvedSelectableCount };
      } catch (err) {
        return errorResult(sanitizeError(err));
      }
    },
  });

  // ── pin_message ───────────────────────────────────────────────────────────

  registry.register({
    name: 'pin_message',
    description: 'Pin or unpin a message in the current chat.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    schema: z.object({
      chatJid: z.string(),
      messageId: z.string(),
      pin: z.boolean(),
      duration: z.enum(['24h', '7d', '30d']).optional(),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const messageId = params['messageId'] as string;
      const pin = params['pin'] as boolean;
      const duration = (params['duration'] as string | undefined) ?? '7d';

      const { row, error } = validateMessageOwnership(db, messageId, session);
      if (error) return errorResult(error);

      // Duration in seconds mapping
      const durationSeconds: Record<string, 86400 | 604800 | 2592000> = {
        '24h': 86400,
        '7d': 604800,
        '30d': 2592000,
      };

      // proto.PinInChat.Type — 1 = pin, 2 = unpin
      const pinType = pin ? 1 : 2;

      try {
        await connection.sendRaw(chatJid, {
          pin: {
            remoteJid: chatJid,
            id: row!.message_id,
            fromMe: Boolean(row!.is_from_me),
          },
          type: pinType,
          time: pin ? durationSeconds[duration] : undefined,
        });
      } catch (err) {
        return errorResult(sanitizeError(err));
      }

      return { pinned: pin, messageId, duration: pin ? duration : undefined };
    },
  });
}
