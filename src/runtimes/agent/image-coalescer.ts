/**
 * ImageCoalescer — per-chat image coalesce buffer + durability marking for
 * AgentRuntime.
 *
 * Extracted from AgentRuntime as a slice of the god-class decomposition. Owns
 * the per-chat coalesce buffer map (the texts/timer/msg/inboundSeqs entries) and
 * the durability bookkeeping for buffered inbound sequences: marking the
 * non-representative seqs skipped, marking a representative seq failed, and the
 * abort path that clears a buffer's timer and reports its seqs skipped.
 *
 * The TURN-PIPELINE methods intentionally stay in AgentRuntime
 * (coalesceImageTurn / flushImageCoalesce and the LID-rekey path): they arm the
 * coalesce timer against AgentRuntime.flushImageCoalesce, drive sendTurnPerChat,
 * and manipulate the per-chat turn/seq-queue maps — none of which belong to this
 * buffer-ownership responsibility. Those methods read/write `buffers` directly
 * and call markSeqsSkipped / markSeqFailed / abort here. AgentRuntime keeps a thin
 * abortImageCoalesceBuffer delegator so the existing call sites are unchanged.
 *
 * durability and replyGuarantee are late-bound on AgentRuntime (assigned at start;
 * durability is never nulled, replyGuarantee may be reset to null — see runtime.ts:4740),
 * so they are read through getter thunks rather than captured
 * at construction. Behavior is identical to the previous inline implementation —
 * see the image-coalescing characterization suite in
 * tests/runtimes/agent/runtime.test.ts (timer-batch flush, flush-before-text,
 * representative-seq queue/consume, multi-image single turn, max-batch immediate
 * flush, resume-failed abort, send-failure marking, LID rekey, cleanup skip).
 */
import type { IncomingMessage } from '../../core/types.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import type { ReplyGuaranteeManager } from '../../core/reply-guarantee.ts';
import { createChildLogger } from '../../logger.ts';

// Same component name as AgentRuntime: the skip/fail warnings keep their existing
// `component: 'agent-runtime'` log binding (no observable change).
const log = createChildLogger('agent-runtime');

/** A pending coalesce buffer for one chat. */
export interface ImageCoalesceEntry {
  texts: string[];
  timer: ReturnType<typeof setTimeout>;
  msg: IncomingMessage;
  inboundSeqs: number[];
}

export class ImageCoalescer {
  /**
   * mapKey → pending coalesce buffer. Public readonly: AgentRuntime's turn-pipeline
   * methods (coalesceImageTurn / flushImageCoalesce / LID rekey) own the lifecycle
   * of arming timers and constructing entries; this class owns the marking + abort
   * helpers that operate over the same map.
   */
  readonly buffers = new Map<string, ImageCoalesceEntry>();

  private readonly getDurability: () => DurabilityEngine | null;
  private readonly getReplyGuarantee: () => ReplyGuaranteeManager | null;

  constructor(
    getDurability: () => DurabilityEngine | null,
    getReplyGuarantee: () => ReplyGuaranteeManager | null,
  ) {
    this.getDurability = getDurability;
    this.getReplyGuarantee = getReplyGuarantee;
  }

  /**
   * Mark the given buffered inbound seqs skipped in durability (they will not get
   * their own turn). No-op when durability is unset (only before startup wiring or in durability-free test construction; production wires it before any inbound message). Each seq is disarmed
   * from the reply guarantee first; failures are logged and do not abort the loop.
   */
  markSeqsSkipped(mapKey: string, inboundSeqs: number[], reason: string): void {
    const durability = this.getDurability();
    if (!durability) return;
    for (const seq of inboundSeqs) {
      try {
        this.getReplyGuarantee()?.disarm(seq);
        durability.markInboundSkipped(seq, reason);
      } catch (err) {
        log.warn({ err, mapKey, seq, reason }, 'failed to mark image coalesce seq skipped');
      }
    }
  }

  /** Mark the representative seq failed in durability after a failed coalesced send. */
  markSeqFailed(mapKey: string, seq: number): void {
    const durability = this.getDurability();
    if (!durability) return;
    try {
      this.getReplyGuarantee()?.disarm(seq);
      durability.markInboundFailed(seq);
    } catch (err) {
      log.warn({ err, mapKey, seq }, 'failed to mark image coalesce representative seq failed');
    }
  }

  /**
   * Cancel a pending coalesce buffer: clear its timer, drop it from the map, and
   * mark its buffered inbound seqs skipped with the given reason. Returns true if a
   * buffer existed, false otherwise.
   */
  abort(mapKey: string, reason: string): boolean {
    const imgBuf = this.buffers.get(mapKey);
    if (!imgBuf) return false;
    clearTimeout(imgBuf.timer);
    this.buffers.delete(mapKey);
    this.markSeqsSkipped(mapKey, imgBuf.inboundSeqs, reason);
    return true;
  }
}
