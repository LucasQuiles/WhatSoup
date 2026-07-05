// Branch-coverage tests — ImageCoalescer (src/runtimes/agent/image-coalescer.ts).
//
// The class is partially exercised through runtime.test.ts (coalesce timer
// flush paths, representative-seq marking, abort on resume failure, etc.),
// but the residual defensive branches — durability-not-wired early returns,
// the optional-chain disarm short-circuit, and the per-seq catch-and-continue
// guards — are not reached there. This file installs typed stub thunks for
// the durability and reply-guarantee getters, drives each branch directly,
// and asserts on concrete call counts/args/map state (no terminal weak
// assertions).
//
// Fake timers wrap the test bodies so the coalesce timer the helper installs
// into `coalescer.buffers` never fires; abort() always calls clearTimeout
// before any potential tick. No wall-clock waits, no real sleep.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageCoalescer } from '../../../src/runtimes/agent/image-coalescer.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';
import type { ReplyGuaranteeManager } from '../../../src/core/reply-guarantee.ts';
import type { IncomingMessage } from '../../../src/core/types.ts';

// ─── Stubs ───────────────────────────────────────────────────────────────────

interface DurabilityStub extends Pick<DurabilityEngine, 'markInboundSkipped' | 'markInboundFailed'> {}

interface ReplyGuaranteeStub extends Pick<ReplyGuaranteeManager, 'disarm'> {}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Install a coalesce buffer directly into the public `buffers` map so we can
 * drive `abort()` without exercising the turn-pipeline methods that own entry
 * lifecycle. The coalesce timer is faked by vi.useFakeTimers() (set in
 * beforeEach); abort()'s clearTimeout is the only thing that ever touches it.
 */
function installBuffer(
  coalescer: ImageCoalescer,
  mapKey: string,
  inboundSeqs: number[],
): void {
  const timer = setTimeout(() => {
    // Intentionally empty — abort clears the timer before it can fire.
  }, 60_000);
  timer.unref?.();
  coalescer.buffers.set(mapKey, {
    texts: [],
    timer,
    msg: {} as IncomingMessage,
    inboundSeqs,
  });
}

// ─── Setup ───────────────────────────────────────────────────────────────────

let durability: DurabilityStub;
let replyGuarantee: ReplyGuaranteeStub;
let coalescer: ImageCoalescer;
let noDurabilityCoalescer: ImageCoalescer;

beforeEach(() => {
  vi.useFakeTimers();
  durability = {
    markInboundSkipped: vi.fn(),
    markInboundFailed: vi.fn(),
  } as unknown as DurabilityStub;
  replyGuarantee = {
    disarm: vi.fn(),
  } as unknown as ReplyGuaranteeStub;
  coalescer = new ImageCoalescer(
    () => durability as unknown as DurabilityEngine,
    () => replyGuarantee as unknown as ReplyGuaranteeManager,
  );
  noDurabilityCoalescer = new ImageCoalescer(() => null, () => null);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── markSeqsSkipped ─────────────────────────────────────────────────────────

describe('ImageCoalescer.markSeqsSkipped — branch coverage', () => {
  it('returns early when durability thunk resolves to null', () => {
    noDurabilityCoalescer.markSeqsSkipped('chat-1', [10, 11], 'coalesced');

    expect(replyGuarantee.disarm).not.toHaveBeenCalled();
  });

  it('disarms each seq and marks it skipped when both thunks resolve', () => {
    coalescer.markSeqsSkipped('chat-1', [10, 11], 'coalesced');

    expect(replyGuarantee.disarm).toHaveBeenCalledTimes(2);
    expect(replyGuarantee.disarm).toHaveBeenNthCalledWith(1, 10);
    expect(replyGuarantee.disarm).toHaveBeenNthCalledWith(2, 11);
    expect(durability.markInboundSkipped).toHaveBeenCalledTimes(2);
    expect(durability.markInboundSkipped).toHaveBeenNthCalledWith(1, 10, 'coalesced');
    expect(durability.markInboundSkipped).toHaveBeenNthCalledWith(2, 11, 'coalesced');
  });

  it('short-circuits the optional-chain disarm when replyGuarantee thunk is null', () => {
    const coalescerWithoutRG = new ImageCoalescer(
      () => durability as unknown as DurabilityEngine,
      () => null,
    );

    coalescerWithoutRG.markSeqsSkipped('chat-1', [10], 'coalesced');

    expect(durability.markInboundSkipped).toHaveBeenCalledTimes(1);
    expect(durability.markInboundSkipped).toHaveBeenCalledWith(10, 'coalesced');
  });

  it('continues the loop when markInboundSkipped throws on a seq', () => {
    vi.mocked(durability.markInboundSkipped)
      .mockImplementationOnce(() => {
        throw new Error('durability write failed');
      });

    coalescer.markSeqsSkipped('chat-1', [10, 11], 'coalesced');

    // Both seqs were attempted: first threw (caught), second completed.
    expect(durability.markInboundSkipped).toHaveBeenCalledTimes(2);
    expect(durability.markInboundSkipped).toHaveBeenNthCalledWith(2, 11, 'coalesced');
  });
});

// ─── markSeqFailed ───────────────────────────────────────────────────────────

describe('ImageCoalescer.markSeqFailed — branch coverage', () => {
  it('returns early when durability thunk resolves to null', () => {
    noDurabilityCoalescer.markSeqFailed('chat-1', 42, 'transport_send_failed');

    expect(replyGuarantee.disarm).not.toHaveBeenCalled();
  });

  it('disarms and forwards the caller-classified failure class to durability', () => {
    coalescer.markSeqFailed('chat-1', 42, 'transport_send_failed');

    expect(replyGuarantee.disarm).toHaveBeenCalledTimes(1);
    expect(replyGuarantee.disarm).toHaveBeenCalledWith(42);
    expect(durability.markInboundFailed).toHaveBeenCalledTimes(1);
    expect(durability.markInboundFailed).toHaveBeenCalledWith(42, 'transport_send_failed');
  });

  it('does not rethrow when markInboundFailed throws', () => {
    vi.mocked(durability.markInboundFailed).mockImplementationOnce(() => {
      throw new Error('durability write failed');
    });

    coalescer.markSeqFailed('chat-1', 42, 'db_error');

    expect(durability.markInboundFailed).toHaveBeenCalledTimes(1);
    expect(durability.markInboundFailed).toHaveBeenCalledWith(42, 'db_error');
  });
});

// ─── abort ───────────────────────────────────────────────────────────────────

describe('ImageCoalescer.abort — branch coverage', () => {
  it('returns false and does not touch durability when no buffer exists for the key', () => {
    const result = coalescer.abort('1555XXXXXXX@s.whatsapp.net', 'resume-failed');

    expect(result).toBe(false);
    expect(durability.markInboundSkipped).not.toHaveBeenCalled();
    expect(coalescer.buffers.has('1555XXXXXXX@s.whatsapp.net')).toBe(false);
  });

  it('clears the timer, removes the buffer, and marks each inbound seq skipped', () => {
    installBuffer(coalescer, 'chat-1', [10, 11]);

    const result = coalescer.abort('chat-1', 'resume-failed');

    expect(result).toBe(true);
    expect(coalescer.buffers.has('chat-1')).toBe(false);
    expect(durability.markInboundSkipped).toHaveBeenCalledTimes(2);
    expect(durability.markInboundSkipped).toHaveBeenNthCalledWith(1, 10, 'resume-failed');
    expect(durability.markInboundSkipped).toHaveBeenNthCalledWith(2, 11, 'resume-failed');
  });
});
