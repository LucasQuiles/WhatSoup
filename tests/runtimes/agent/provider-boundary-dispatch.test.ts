import { describe, expect, it, vi } from 'vitest';

import { dispatchProviderTurn } from '../../../src/runtimes/agent/provider-boundary-dispatch.ts';

describe('dispatchProviderTurn', () => {
  it('uses exact-boundary dispatch when the session exposes it', async () => {
    const order: string[] = [];
    const session = {
      sendTurn: vi.fn(async () => { order.push('legacy'); }),
      sendTurnAtProviderBoundary: vi.fn(async (_text: string, onReady?: () => void) => {
        order.push('admitted');
        onReady?.();
        order.push('sent');
      }),
    };

    await dispatchProviderTurn(session, 'hello', () => { order.push('ready'); });

    expect(order).toEqual(['admitted', 'ready', 'sent']);
    expect(session.sendTurn).not.toHaveBeenCalled();
  });

  it('preserves legacy injected sessions without losing the ready callback', async () => {
    const order: string[] = [];
    const session = {
      sendTurn: vi.fn(async () => { order.push('sent'); }),
    };

    await dispatchProviderTurn(session, 'hello', () => { order.push('ready'); });

    expect(order).toEqual(['ready', 'sent']);
  });
});
