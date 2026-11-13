import { describe, expect, it, vi } from 'vitest';

import {
  attachPollWaitOwner,
  beginPollWait,
  type PollWaitOwner,
} from '../../src/mcp/poll-wait-owner.ts';

describe('poll wait owner', () => {
  it('forwards the bounded wait and returns the owner disposal callback', () => {
    const dispose = vi.fn();
    const owner: PollWaitOwner = { begin: vi.fn(() => dispose) };
    const requestContext = {};

    attachPollWaitOwner(requestContext, owner);
    const end = beginPollWait(requestContext, 1_800_000);

    expect(owner.begin).toHaveBeenCalledOnce();
    expect(owner.begin).toHaveBeenCalledWith(1_800_000);
    expect(end).toBe(dispose);
    end?.();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps owner capability private to the request context and removes it explicitly', () => {
    const owner: PollWaitOwner = { begin: vi.fn(() => undefined) };
    const requestContext = {};

    attachPollWaitOwner(requestContext, owner);

    expect(JSON.stringify(requestContext)).toBe('{}');
    expect(Reflect.ownKeys(requestContext)).toEqual([]);

    attachPollWaitOwner(requestContext, undefined);
    expect(beginPollWait(requestContext, 60_000)).toBeUndefined();
    expect(owner.begin).not.toHaveBeenCalled();
  });

  it('does not manufacture an owner for a context that was never attached', () => {
    expect(beginPollWait({}, 60_000)).toBeUndefined();
  });
});
