import type { IncomingMessage } from '../../core/types.ts';
import type { DurabilityEngine, ReplayableInboundRow } from '../../core/durability.ts';
import { bareNumber, isGroupJid, toPersonalJid } from '../../core/jid-constants.ts';
import { stripSelfMentionsFrom } from '../../lib/self-mention-strip.ts';
import { emitAlertChecked } from '../../lib/emit-alert.ts';
import { createChildLogger } from '../../logger.ts';
import { checkAndRecordInterruptedBoot } from './restart-loop-guard.ts';

const log = createChildLogger('inbound-replay');

export interface InboundReplayStats {
  attempted: number;
  accepted: number;
  failed: number;
  suppressed: number;
  firstSeq: number | null;
  lastSeq: number | null;
}

const EMPTY_REPLAY_STATS: InboundReplayStats = {
  attempted: 0,
  accepted: 0,
  failed: 0,
  suppressed: 0,
  firstSeq: null,
  lastSeq: null,
};

export interface RestartRecoverySuppressionResult {
  suppressed: boolean;
  notice: { chatJid: string; text: string } | null;
}

export function evaluateRestartRecoverySuppression(options: {
  enabled: boolean;
  recoveryWorkCount: number;
  interruptedBoot: boolean;
  statePath: string;
  maxRestarts: number;
  windowMs: number;
  adminPhone?: string;
}): RestartRecoverySuppressionResult {
  if (!options.enabled || options.recoveryWorkCount < 1 || !options.interruptedBoot) {
    return { suppressed: false, notice: null };
  }
  const trip = checkAndRecordInterruptedBoot({
    statePath: options.statePath,
    maxRestarts: options.maxRestarts,
    windowMs: options.windowMs,
  });
  if (!trip.tripped) return { suppressed: false, notice: null };
  log.warn(
    {
      bootsInWindow: trip.bootsInWindow,
      recoveryWorkCount: options.recoveryWorkCount,
      windowMs: options.windowMs,
    },
    'restart-loop guard tripped — suppressing restart-time recovery for this boot',
  );
  const notice = options.adminPhone
    ? {
        chatJid: toPersonalJid(options.adminPhone),
        text:
          `*Restart-loop guard tripped* ⚠️ — ${trip.bootsInWindow} crash-interrupted boots ` +
          `inside ${Math.round(options.windowMs / 1000)}s with ${options.recoveryWorkCount} ` +
          'restart-time recovery item(s). Automatic session and queued-input replay are ' +
          'suppressed for this boot to break a possible replay loop. Check the journal for ' +
          'the implicated chat.',
      }
    : null;
  return { suppressed: true, notice };
}

const CONTENT_TYPES = new Set([
  'text', 'image', 'video', 'audio', 'document', 'sticker', 'location',
  'live_location', 'contact', 'poll', 'group_invite', 'product', 'pin',
  'interactive', 'unknown',
]);

function parseRawMessage(raw: string | null): unknown {
  if (raw === null) return undefined;
  return JSON.parse(raw) as unknown;
}

/**
 * Reconstruct the canonical runtime envelope for a definitely-undispatched
 * journal row. Queued agent rows are text-only because their replay path skips
 * media/imperative preprocessing; pending rows re-enter the full pipeline.
 */
export function reconstructReplayableInbound(row: ReplayableInboundRow): IncomingMessage {
  if (!CONTENT_TYPES.has(row.content_type)) {
    throw new Error('Replayable inbound has an unsupported content type');
  }
  if (row.processing_status === 'queued' && row.content_type !== 'text') {
    throw new Error('Prepared media inbound cannot be reconstructed exactly');
  }
  if (row.content_type === 'text' && (row.content === null || row.content.trim() === '')) {
    throw new Error('Replayable text inbound has no content');
  }

  return {
    messageId: row.message_id,
    chatJid: row.chat_jid,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    content: row.content,
    contentText: row.content_text,
    contentType: row.content_type,
    isFromMe: false,
    isGroup: isGroupJid(row.chat_jid),
    mentionedJids: [],
    timestamp: row.timestamp,
    quotedMessageId: row.quoted_message_id,
    isResponseWorthy: true,
    ...(row.processing_status === 'pending'
      ? { rawMessage: parseRawMessage(row.raw_message), durableAdmission: 'pending' as const }
      : { durableAdmission: 'queued_replay' as const }),
    inboundSeq: row.seq,
  };
}

export interface InboundReplayCoordinatorPort {
  readonly instanceName: string;
  getDurability(): DurabilityEngine | null;
  getBotJids(): Array<string | null | undefined>;
  handleMessage(msg: IncomingMessage): Promise<void>;
}

export class InboundReplayCoordinator {
  private readonly port: InboundReplayCoordinatorPort;
  private suppressed = false;
  private run = false;
  private stats: InboundReplayStats = { ...EMPTY_REPLAY_STATS };

  constructor(port: InboundReplayCoordinatorPort) {
    this.port = port;
  }

  getStats(): InboundReplayStats {
    return { ...this.stats };
  }

  isSuppressed(): boolean {
    return this.suppressed;
  }

  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
  }

  supports(msg: IncomingMessage): boolean {
    return msg.contentType === 'text' && msg.isSyntheticJob !== true;
  }

  beginPreparation(msg: IncomingMessage): void {
    if (msg.durableAdmission !== 'pending') return;
    const durability = this.port.getDurability();
    if (!durability || msg.inboundSeq === undefined) {
      throw new Error('Durable pending inbound has no durability owner');
    }
    if (!durability.beginInboundPreparation(msg.inboundSeq)) {
      throw new Error(`Durable inbound ${msg.inboundSeq} could not claim preparation`);
    }
  }

  finishPreparation(msg: IncomingMessage): void {
    if (msg.durableAdmission !== 'pending') return;
    const durability = this.port.getDurability();
    if (!durability || msg.inboundSeq === undefined) {
      throw new Error('Durable preparing inbound has no durability owner');
    }
    if (!durability.markInboundQueued(msg.inboundSeq)) {
      throw new Error(`Durable inbound ${msg.inboundSeq} could not enter the runtime queue`);
    }
    msg.durableAdmission = 'queued';
  }

  claimExecution(
    inboundSeq: number | undefined,
    durableQueued: boolean,
    scope: 'shared' | 'single' | 'per-chat' | 'local-command',
  ): void {
    if (!durableQueued) return;
    const durability = this.port.getDurability();
    if (!durability || inboundSeq === undefined) {
      throw new Error(`Durable ${scope} inbound has no durability owner`);
    }
    if (!durability.markInboundProcessing(inboundSeq)) {
      throw new Error(`Durable ${scope} inbound ${inboundSeq} could not claim execution`);
    }
  }

  async replay(limit = 100): Promise<InboundReplayStats> {
    if (this.run) return this.getStats();
    this.run = true;
    const durability = this.port.getDurability();
    if (!durability) return this.getStats();

    const rows = durability.getReplayableInbound(limit);
    if (rows.length === 0) return this.getStats();
    const firstSeq = rows[0]!.seq;
    const lastSeq = rows[rows.length - 1]!.seq;
    if (this.suppressed) {
      this.stats = {
        attempted: 0,
        accepted: 0,
        failed: 0,
        suppressed: rows.length,
        firstSeq,
        lastSeq,
      };
      emitAlertChecked(
        this.port.instanceName,
        'inbound_restart_replay_suppressed',
        `Queued inbound replay suppressed for ${this.port.instanceName}`,
        `count=${rows.length} first_seq=${firstSeq} last_seq=${lastSeq} reason=restart_loop_guard`,
        'warning',
      );
      return this.getStats();
    }

    let accepted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const msg = reconstructReplayableInbound(row);
        if (msg.isGroup && msg.content) {
          const botIds = this.port.getBotJids()
            .filter((jid): jid is string => typeof jid === 'string' && jid.length > 0)
            .flatMap((jid) => [jid, bareNumber(jid)]);
          if (botIds.length > 0) msg.content = stripSelfMentionsFrom(msg.content, botIds);
        }
        await this.port.handleMessage(msg);
        accepted += 1;
      } catch (err) {
        failed += 1;
        durability.markInboundFailed(row.seq, 'crash_recovery');
        log.error(
          { err, inboundSeq: row.seq, priorStatus: row.processing_status },
          'durable inbound restart replay failed closed',
        );
      }
    }

    this.stats = {
      attempted: rows.length,
      accepted,
      failed,
      suppressed: 0,
      firstSeq,
      lastSeq,
    };
    emitAlertChecked(
      this.port.instanceName,
      'inbound_restart_replay',
      `Queued inbound restart replay completed for ${this.port.instanceName}`,
      `attempted=${rows.length} accepted=${accepted} failed=${failed} first_seq=${firstSeq} last_seq=${lastSeq}`,
      failed > 0 ? 'warning' : 'info',
    );
    return this.getStats();
  }
}
