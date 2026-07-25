import { describe, expect, it } from 'vitest';

import {
  providerTurnControlCapabilities,
} from '../../../../src/runtimes/agent/providers/turn-control-capabilities.ts';
import { PROVIDER_IDS } from '../../../../src/runtimes/agent/providers/index.ts';

describe('provider turn-control capabilities', () => {
  it('defines a closed capability row for every registered provider', () => {
    expect(Object.keys(providerTurnControlCapabilities).sort()).toEqual(
      [...PROVIDER_IDS].sort(),
    );
  });

  it('declares exact native steering only for the directly proven persistent surface', () => {
    expect(providerTurnControlCapabilities['codex-cli']).toEqual({
      startTurn: true,
      busyInput: 'steer_active_turn',
      interrupt: 'interrupt_active_turn',
      nativeTurnIdentity: 'required',
    });
  });

  it('fails closed to queue-only ordinary input for every unproven surface', () => {
    for (const provider of PROVIDER_IDS) {
      if (provider === 'codex-cli') continue;
      expect(providerTurnControlCapabilities[provider].busyInput).toBe('queue_only');
      expect(providerTurnControlCapabilities[provider].nativeTurnIdentity).toBe('none');
    }
  });
});
