import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { InboundTurnCompletionTracker } from '../../../src/runtimes/agent/inbound-turn-completion.ts';

describe('inbound completion ownership', () => {
  it('holds completion across publication until non-dispatch admission settles', async () => {
    const tracker = new InboundTurnCompletionTracker();
    tracker.begin('local');
    let settled = false;
    const completion = tracker.await('local').then(() => { settled = true; });
    const finishAdmission = tracker.holdForAdmission('local')!;
    tracker.settleUnadopted('local');
    await setImmediate();
    expect(settled).toBe(false);
    finishAdmission();
    await completion;
    expect(settled).toBe(true);
  });

  it('leaves completion with the queue after admission binds a turn', async () => {
    const tracker = new InboundTurnCompletionTracker();
    tracker.begin('queued');
    let settled = false;
    const completion = tracker.await('queued').then(() => { settled = true; });
    const finishAdmission = tracker.holdForAdmission('queued')!;
    const finishTurn = tracker.bind('queued')!;
    finishAdmission();
    tracker.settleUnadopted('queued');
    await setImmediate();
    expect(settled).toBe(false);
    finishTurn();
    await completion;
    expect(settled).toBe(true);
  });

  it('does not let a late admission callback settle a replacement entry', async () => {
    const tracker = new InboundTurnCompletionTracker();
    tracker.begin('reused');
    const staleFinish = tracker.holdForAdmission('reused')!;
    tracker.settle('reused');
    await tracker.await('reused');
    tracker.begin('reused');
    let settled = false;
    const completion = tracker.await('reused').then(() => { settled = true; });
    const currentFinish = tracker.holdForAdmission('reused')!;
    staleFinish();
    await setImmediate();
    expect(settled).toBe(false);
    currentFinish();
    await completion;
    expect(settled).toBe(true);
  });
});
