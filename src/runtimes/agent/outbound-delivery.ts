import { jitteredDelay, MAX_TIMER_DELAY_MS } from '../../core/retry.ts';
import {
  classifyOutboundFailure,
  createInternalOutboundFailureEvidence,
  outboundFailureWarrantsUserNotice,
  type OutboundFailureEvidenceV1,
} from '../../core/outbound-failure-disposition.ts';
import {
  persistOutboundFailureDisposition,
  type DurabilityEngine,
} from '../../core/durability.ts';
import type { Messenger } from '../../core/types.ts';

export const SEND_TIMEOUT_MS = 15_000;
export const OUTBOUND_SHUTDOWN_DEADLINE = Symbol('outbound_shutdown_deadline');

export type QueueDeliveryOutcome =
  | { readonly outcome: 'submitted' }
  | { readonly outcome: 'failed'; readonly error: unknown }
  | { readonly outcome: 'not_sent' };

export async function waitForOutboundDelayOrShutdown(
  delayMs: number,
  shutdownDeadlineReached: () => boolean,
  shutdownDeadlineSignal: Promise<typeof OUTBOUND_SHUTDOWN_DEADLINE>,
): Promise<boolean> {
  if (shutdownDeadlineReached()) return true;
  if (!Number.isFinite(delayMs)) throw new RangeError('Outbound retry delay must be finite');
  let remainingMs = Math.max(0, delayMs);
  while (remainingMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const shutdown = await Promise.race([
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.min(remainingMs, MAX_TIMER_DELAY_MS)); }),
        shutdownDeadlineSignal.then(() => true as const),
      ]);
      if (shutdown) return true;
    } finally {
      clearTimeout(timer);
    }
    remainingMs -= Math.min(remainingMs, MAX_TIMER_DELAY_MS);
  }
  return false;
}

interface DeliveryChunk {
  readonly text: string;
  readonly chatJid: string;
  readonly conversationKey: string;
  readonly sourceInboundSeq: number | undefined;
}

interface DeliveryLogger {
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface OutboundDeliveryDependencies<Chunk extends DeliveryChunk> {
  readonly messenger: Messenger;
  readonly durability: DurabilityEngine | undefined;
  readonly shutdownDeadlineReached: () => boolean;
  readonly shutdownDeadlineSignal: Promise<typeof OUTBOUND_SHUTDOWN_DEADLINE>;
  readonly waitForDelayOrShutdown: (delayMs: number) => Promise<boolean>;
  readonly terminalTextDedupeKey: (chatJid: string, text: string) => string;
  readonly recordTurnOp: (chunk: Chunk, opId: number) => void;
  readonly setLastOpId: (opId: number) => void;
  readonly setLastSubmittedTextDedupeKey: (key: string) => void;
  readonly log: DeliveryLogger;
}

export async function sendOutboundWithRetry<Chunk extends DeliveryChunk>(
  dependencies: OutboundDeliveryDependencies<Chunk>,
  chunk: Chunk,
): Promise<QueueDeliveryOutcome> {
  const { messenger, durability, log } = dependencies;
  const textDedupeKey = dependencies.terminalTextDedupeKey(chunk.chatJid, chunk.text);
  let opId: number | undefined;
  if (durability) {
    opId = durability.createOutboundOp({
      conversationKey: chunk.conversationKey,
      chatJid: chunk.chatJid,
      opType: 'text',
      payload: JSON.stringify({ text: chunk.text }),
      replayPolicy: 'unsafe',
      sourceInboundSeq: chunk.sourceInboundSeq,
    });
    dependencies.setLastOpId(opId);
    dependencies.recordTurnOp(chunk, opId);
    durability.markSending(opId);
  }

  const stableMessageId = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  let lastEvidence: OutboundFailureEvidenceV1 | undefined;
  let lastError: unknown;
  let shutdownDeadlineExpired = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (dependencies.shutdownDeadlineReached()) {
      shutdownDeadlineExpired = true;
      break;
    }
    try {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let receiptOrDeadline: Awaited<ReturnType<Messenger['sendMessage']>> | typeof OUTBOUND_SHUTDOWN_DEADLINE;
      try {
        receiptOrDeadline = await Promise.race([
          messenger.sendMessage(chunk.chatJid, chunk.text, { messageId: stableMessageId }),
          dependencies.shutdownDeadlineSignal,
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error('SEND_TIMEOUT')), SEND_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timeoutHandle);
      }
      if (receiptOrDeadline === OUTBOUND_SHUTDOWN_DEADLINE) {
        shutdownDeadlineExpired = true;
        lastEvidence = createInternalOutboundFailureEvidence({
          failureCode: 'outbound.shutdown_deadline',
          stage: 'provider_request',
          mutationState: 'ambiguous',
          logicalAttemptCount: (lastEvidence?.logical_attempt_count ?? 0) + 1,
          providerSubmissionCount: (lastEvidence?.provider_submission_count ?? 0) + 1,
          previousEvidence: lastEvidence,
          evidenceCoverage: 'partial',
        });
        break;
      }
      if (opId !== undefined && durability) {
        durability.markSubmitted(opId, receiptOrDeadline.waMessageId, (lastEvidence?.logical_attempt_count ?? 0) + 1);
      }
      dependencies.setLastSubmittedTextDedupeKey(textDedupeKey);
      return { outcome: 'submitted' };
    } catch (err) {
      lastError = err;
      lastEvidence = classifyOutboundFailure(err, {
        retryOwner: 'agent_queue', attemptsRemaining: 3 - attempt - 1, previousEvidence: lastEvidence,
      });
      if (
        lastEvidence.retry_decision !== 'retry_now'
        && !(lastEvidence.retry_decision === 'retry_not_before' && !durability && lastEvidence.retry_not_before !== null && attempt < 2)
      ) break;
      const delayMs = lastEvidence.retry_decision === 'retry_not_before'
        ? Math.max(1, Date.parse(lastEvidence.retry_not_before!) - Date.now())
        : jitteredDelay(1_000, attempt, 8_000);
      log.warn({ opId, attempt: attempt + 1, maxAttempts: 3, failureCode: lastEvidence.failure_code, stage: lastEvidence.stage, mutationState: lastEvidence.mutation_state, delayMs }, 'outbound send failed — retrying');
      if (await dependencies.waitForDelayOrShutdown(delayMs)) {
        shutdownDeadlineExpired = true;
        break;
      }
    }
  }
  if (shutdownDeadlineExpired) {
    lastEvidence = lastEvidence === undefined
      ? createInternalOutboundFailureEvidence({ failureCode: 'outbound.shutdown_before_send', stage: 'admission', mutationState: 'not_started', logicalAttemptCount: 0, providerSubmissionCount: 0 })
      : createInternalOutboundFailureEvidence({ failureCode: 'outbound.shutdown_deadline', stage: 'runtime', mutationState: lastEvidence.mutation_state, logicalAttemptCount: lastEvidence.logical_attempt_count, providerSubmissionCount: lastEvidence.provider_submission_count, previousEvidence: lastEvidence, evidenceCoverage: lastEvidence.evidence_coverage });
    log.warn({ opId, failureCode: lastEvidence.failure_code, stage: lastEvidence.stage, mutationState: lastEvidence.mutation_state }, 'outbound send stopped at runtime shutdown deadline');
    if (opId !== undefined && durability) {
      persistOutboundFailureDisposition(durability, opId, lastEvidence, lastEvidence.mutation_state === 'ambiguous' ? stableMessageId : undefined);
    }
    return { outcome: 'failed', error: lastError ?? new Error('outbound send stopped at runtime shutdown deadline') };
  }
  if (!lastEvidence) return { outcome: 'failed', error: new Error('outbound send stopped without a delivery outcome') };
  log.error({ opId, attempts: lastEvidence.logical_attempt_count, providerSubmissions: lastEvidence.provider_submission_count, failureCode: lastEvidence.failure_code, stage: lastEvidence.stage, mutationState: lastEvidence.mutation_state, retryDecision: lastEvidence.retry_decision }, 'outbound send stopped with bounded failure disposition');
  if (opId !== undefined && durability) persistOutboundFailureDisposition(durability, opId, lastEvidence);
  if (outboundFailureWarrantsUserNotice(lastEvidence)) {
    Promise.race([
      messenger.sendMessage(chunk.chatJid, '⚠️ A response could not be delivered after 3 attempts.'),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), SEND_TIMEOUT_MS)),
    ]).catch((err) => { log.warn({ err }, 'outbound-queue: delivery failure notification send failed'); });
  }
  return { outcome: 'failed', error: lastError ?? new Error(`outbound send failed: ${lastEvidence.failure_code}`) };
}
