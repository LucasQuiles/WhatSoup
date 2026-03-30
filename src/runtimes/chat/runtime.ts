import { randomBytes } from 'node:crypto';
import type { Database } from '../../core/database.ts';
import type { IncomingMessage, Messenger, RuntimeHealth } from '../../core/types.ts';
import type { LLMProvider, GenerateRequest, ChatMessage } from './providers/types.ts';
import type { PineconeMemory } from './providers/pinecone.ts';
import type { Runtime } from '../types.ts';
// Bot reply storage is handled by the Baileys echo via ingest → storeMessageIfNew
import { recordResponse } from './rate-limits-db.ts';
import { config } from '../../config.ts';
import { createChildLogger } from '../../logger.ts';
import { checkRateLimit } from './rate-limiter.ts';
import { loadConversationWindow } from './window.ts';
import { loadContext } from './context.ts';
import { ChatQueue } from './queue.ts';
import { processMedia } from './media/processor.ts';
import type { ProcessedMedia } from './media/processor.ts';
import { EnrichmentPoller } from './enrichment/poller.ts';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

const log = createChildLogger('conversation');

/** Full jitter: delay = base * 2^attempt * random(0.75, 1.25), capped at maxMs */
export function jitteredDelay(baseMs: number, attempt: number, maxMs = 30_000): number {
  const exp = baseMs * Math.pow(2, attempt);
  const capped = Math.min(exp, maxMs);
  return capped * (0.75 + Math.random() * 0.5);
}

const CHAT_DDL = `
CREATE TABLE IF NOT EXISTS rate_limits (
  sender_jid TEXT NOT NULL,
  response_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_sender ON rate_limits(sender_jid, response_at);

CREATE TABLE IF NOT EXISTS enrichment_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  messages_processed INTEGER DEFAULT 0,
  facts_extracted INTEGER DEFAULT 0,
  facts_upserted INTEGER DEFAULT 0,
  error TEXT
);
`;

/** Ensure chat-specific tables exist in the given database. Idempotent. */
export function ensureChatSchema(db: Database): void {
  db.raw.exec(CHAT_DDL);
}

export class ChatRuntime implements Runtime {
  private rateLimitNotified = new Set<string>();
  private db: Database;
  private messenger: Messenger;
  private pinecone: PineconeMemory;
  private primaryProvider: LLMProvider;
  private fallbackProvider: LLMProvider;
  private chatQueue: ChatQueue;
  private enrichmentPoller: EnrichmentPoller | null;

  constructor(
    db: Database,
    messenger: Messenger,
    pinecone: PineconeMemory,
    primaryProvider: LLMProvider,
    fallbackProvider: LLMProvider,
    options?: { enableEnrichment?: boolean },
  ) {
    this.db = db;
    this.messenger = messenger;
    this.pinecone = pinecone;
    this.primaryProvider = primaryProvider;
    this.fallbackProvider = fallbackProvider;
    this.chatQueue = new ChatQueue(3);
    this.enrichmentPoller = (options?.enableEnrichment ?? true)
      ? new EnrichmentPoller(db, pinecone, primaryProvider, primaryProvider)
      : null;
  }

  async start(): Promise<void> {
    ensureChatSchema(this.db);
    if (this.enrichmentPoller) {
      this.enrichmentPoller.start();
      log.info('ChatRuntime started (enrichment poller running)');
    } else {
      log.info('ChatRuntime started (enrichment disabled)');
    }
  }

  getHealthSnapshot(): RuntimeHealth {
    const queue = this.chatQueue.stats;
    return {
      status: 'healthy',
      details: {
        queue,
        enrichmentLastRunAt: this.enrichmentPoller?.lastRunAt ?? null,
      },
    };
  }

  async shutdown(): Promise<void> {
    this.enrichmentPoller?.stop();
    log.info('ChatRuntime shutdown complete');
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const traceId = randomBytes(4).toString('hex');
    const startTime = Date.now();

    // Enqueue via chatQueue for per-chat sequential processing
    this.chatQueue.enqueue(msg.chatJid, () => this.processMessage(msg, traceId, startTime));
  }

  private async processMessage(msg: IncomingMessage, traceId: string, startTime: number): Promise<void> {
    // 1. Rate limit check
    const { allowed, remaining } = checkRateLimit(this.db, msg.senderJid);

    if (!allowed) {
      if (!this.rateLimitNotified.has(msg.senderJid)) {
        this.rateLimitNotified.add(msg.senderJid);
        setTimeout(
          () => this.rateLimitNotified.delete(msg.senderJid),
          config.rateLimitNoticeWindowMs,
        );

        log.info({ traceId, senderJid: msg.senderJid }, 'rate limit hit — sending notice');
        try {
          await this.messenger.sendMessage(msg.chatJid, 'chill, I need a minute');
        } catch (err) {
          log.error({ traceId, err, chatJid: msg.chatJid }, 'failed to send rate limit notice');
        }
      }
      return;
    }

    log.info({ traceId, senderJid: msg.senderJid, remaining }, 'rate limit check passed');

    // 2. Media processing
    const downloadFn = msg.rawMessage
      ? () => downloadMediaMessage(msg.rawMessage as any, 'buffer', {})
      : null;
    const media: ProcessedMedia = await processMedia(msg, downloadFn);
    const mediaContent = media.content;
    const mediaImages = media.images;

    // 3. Context + window (use mediaContent for Pinecone query)
    // Pinecone is wrapped in a 5-second timeout race; on any failure we continue
    // with null context so the user still gets a response.
    const contextStart = Date.now();
    let contextBlock: string | null = null;
    try {
      const contextRace = Promise.race([
        loadContext(this.pinecone, msg.chatJid, msg.senderJid, mediaContent),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PINECONE_TIMEOUT')), 5_000),
        ),
      ]);
      contextBlock = await contextRace;
    } catch (err) {
      log.warn({ traceId, err }, 'context retrieval failed — proceeding without memory context');
      contextBlock = null;
    }
    const conversationWindow = loadConversationWindow(this.db, msg.chatJid);
    const contextDurationMs = Date.now() - contextStart;

    // 4. Build system prompt and apply token budget trimming
    const systemPrompt = contextBlock
      ? `${config.systemPrompt}\n\n${contextBlock}`
      : config.systemPrompt;

    const window: ChatMessage[] = [...conversationWindow];

    const estimateTokens = (): number => {
      const windowContentLength = window.reduce((sum, m) => sum + m.content.length, 0);
      return (systemPrompt.length + windowContentLength) / 4 + mediaImages.length * 1000;
    };

    let trimmedMessages = 0;
    while (estimateTokens() > config.tokenBudget && window.length > 1) {
      window.shift();
      trimmedMessages = trimmedMessages + 1;
    }

    if (trimmedMessages > 0) {
      log.info(
        { traceId, trimmedMessages, estimatedTokens: estimateTokens() },
        'token budget: trimmed messages from window',
      );
    }

    // 5. Add current message to window
    // Include sender phone/LID in group messages so the LLM can @mention them back
    const senderPhone = msg.senderJid.split('@')[0];
    const senderLabel = msg.isGroup && msg.senderName
      ? `[${msg.senderName} (@${senderPhone})]: `
      : msg.senderName ? `[${msg.senderName}]: ` : '';
    const currentMessage: ChatMessage = {
      role: 'user',
      content: senderLabel + mediaContent,
      ...(mediaImages.length > 0 ? { images: mediaImages } : {}),
    };
    window.push(currentMessage);

    // 6. Build the generate request
    const request: GenerateRequest = {
      model: config.models.conversation,
      maxTokens: config.maxTokens,
      systemPrompt,
      messages: window,
    };

    // 7. LLM call with retry + fallback
    let responseText: string | null = null;
    let modelUsed: string = config.models.conversation;
    let llmDurationMs = 0;

    const llmStart = Date.now();

    // Primary provider: try once, wait, retry once
    try {
      const result = await this.primaryProvider.generate(request);
      responseText = result.content;
      llmDurationMs = Date.now() - llmStart;
      log.info(
        { traceId, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
        'primary provider response',
      );
    } catch (primaryErr) {
      log.error({ traceId, err: primaryErr }, 'primary provider failed — retrying after delay');

      await new Promise((resolve) => setTimeout(resolve, jitteredDelay(config.apiRetryDelayMs, 0)));

      try {
        const result = await this.primaryProvider.generate(request);
        responseText = result.content;
        llmDurationMs = Date.now() - llmStart;
        log.info(
          { traceId, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
          'primary provider response (retry)',
        );
      } catch (retryErr) {
        log.error({ traceId, err: retryErr }, 'primary provider retry failed — trying fallback');

        const fallbackRequest: GenerateRequest = { ...request, model: config.models.fallback };
        try {
          const result = await this.fallbackProvider.generate(fallbackRequest);
          responseText = result.content;
          modelUsed = config.models.fallback;
          llmDurationMs = Date.now() - llmStart;
          log.info(
            { traceId, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
            'fallback provider response',
          );
        } catch (fallbackErr) {
          log.error({ traceId, err: fallbackErr }, 'fallback provider also failed');
          llmDurationMs = Date.now() - llmStart;
          responseText = null;
        }
      }
    }

    // 8. On total failure: send fallback message (not stored, not rate-limited)
    if (!responseText) {
      try {
        await this.messenger.sendMessage(msg.chatJid, 'lol my brain just broke, give me a sec');
      } catch (fallbackSendErr) {
        log.error({ traceId, err: fallbackSendErr, chatJid: msg.chatJid }, 'failed to send fallback message');
      }
      return;
    }

    // 9. Send the response (with one retry on failure)
    const sendStart = Date.now();
    try {
      await this.messenger.sendMessage(msg.chatJid, responseText);
    } catch (err) {
      log.warn({ traceId, err, chatJid: msg.chatJid }, 'send failed — retrying in 2s');
      try {
        await new Promise(r => setTimeout(r, 2000));
        await this.messenger.sendMessage(msg.chatJid, responseText);
      } catch (retryErr) {
        log.error({ traceId, err: retryErr, chatJid: msg.chatJid }, 'send retry failed — response lost');
        return;
      }
    }
    const sendDurationMs = Date.now() - sendStart;

    // 10. Bot reply storage: handled by the Baileys messages.upsert echo
    //     (via ingest → storeMessageIfNew). The echo carries the real WhatsApp
    //     message_id and arrives within milliseconds of messenger.send().
    //     Removed: redundant storeMessage with synthetic ID that caused
    //     duplicate rows in the conversation window.

    // 11. Record rate limit
    try {
      recordResponse(this.db, msg.senderJid);
    } catch (err) {
      log.error({ traceId, err }, 'failed to record rate limit response');
    }

    // 12. Update message content in DB if media processed it differently
    if (mediaContent !== msg.content) {
      try {
        this.db.raw
          .prepare('UPDATE messages SET content = ? WHERE message_id = ?')
          .run(mediaContent, msg.messageId);
      } catch (err) {
        log.error({ traceId, err, messageId: msg.messageId }, 'failed to update message content in DB');
      }
    }

    // 13. Log completion with all timings
    const totalDurationMs = Date.now() - startTime;
    log.info(
      {
        traceId,
        chatJid: msg.chatJid,
        senderJid: msg.senderJid,
        model: modelUsed,
        contextDurationMs,
        llmDurationMs,
        sendDurationMs,
        totalDurationMs,
      },
      'message handled successfully',
    );
  }
}

/** @deprecated Use ChatRuntime instead */
export const ConversationHandler = ChatRuntime;
