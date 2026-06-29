import { describe, it, expect } from 'vitest';
import { watchdogHardMsForProvider } from '../../../../src/runtimes/agent/providers/watchdog-policy.ts';
import { anthropicApiDescriptor } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import { openaiApiDescriptor } from '../../../../src/runtimes/agent/providers/openai-api.ts';
import { claudeDescriptor } from '../../../../src/runtimes/agent/providers/claude.ts';

// L1-F1: armWatchdog historically hardcoded the 30-min module constant for every
// provider, so API providers (whose descriptors declare a 10-min hard timeout) were
// silently given 30 min. These tests pin watchdogHardMsForProvider to the descriptors'
// defaultWatchdog.hardMs so the policy table cannot drift away from the SSOT.
describe('watchdogHardMsForProvider — honors ProviderDescriptor.defaultWatchdog.hardMs', () => {
  it('anthropic-api resolves to its descriptor hardMs (10 min)', () => {
    expect(watchdogHardMsForProvider('anthropic-api')).toBe(anthropicApiDescriptor.defaultWatchdog.hardMs);
    expect(watchdogHardMsForProvider('anthropic-api')).toBe(600_000);
  });

  it('openai-api resolves to its descriptor hardMs (10 min)', () => {
    expect(watchdogHardMsForProvider('openai-api')).toBe(openaiApiDescriptor.defaultWatchdog.hardMs);
    expect(watchdogHardMsForProvider('openai-api')).toBe(600_000);
  });

  it('claude-cli resolves to its descriptor hardMs (30 min — unchanged default)', () => {
    expect(watchdogHardMsForProvider('claude-cli')).toBe(claudeDescriptor.defaultWatchdog.hardMs);
    expect(watchdogHardMsForProvider('claude-cli')).toBe(1_800_000);
  });

  it('an unknown provider falls back to the 30-min default (behavior-preserving)', () => {
    expect(watchdogHardMsForProvider('some-future-provider')).toBe(1_800_000);
  });
});
