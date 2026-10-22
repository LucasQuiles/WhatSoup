import { describe, expect, it } from 'vitest';
import {
  resolveAgentTurnMapKey,
  scheduledAgentJobBaseMapKey,
} from '../../../src/runtimes/agent/scheduled-agent-job-isolation.ts';

describe('scheduledAgentJobBaseMapKey (#3497)', () => {
  it('strips only the scheduled isolation suffix from a map key', () => {
    expect(scheduledAgentJobBaseMapKey(resolveAgentTurnMapKey('15550003497@s.whatsapp.net', true)))
      .toBe('15550003497@s.whatsapp.net');
    expect(scheduledAgentJobBaseMapKey(resolveAgentTurnMapKey('11111113497@lid', true)))
      .toBe('11111113497@lid');
    expect(scheduledAgentJobBaseMapKey('15550003497@s.whatsapp.net')).toBe('15550003497@s.whatsapp.net');
  });
});
