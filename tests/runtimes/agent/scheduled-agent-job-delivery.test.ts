import { describe, expect, it } from 'vitest';
import { isolateScheduledAgentJobPrompt } from '../../../src/runtimes/agent/scheduled-agent-job-isolation.ts';
import {
  resolveScheduledFinalAnswer,
  scheduledAgentJobDeliversFinalText,
  scheduledAgentJobTurnForProvider,
} from '../../../src/runtimes/agent/scheduled-agent-job-delivery.ts';

describe('scheduled agent-job delivery owner (#3497)', () => {
  const turn = `[Scheduled job: check]: ${isolateScheduledAgentJobPrompt('Run the date command.')}`;

  it('only OpenCode delivers its scheduled update as final text', () => {
    expect(scheduledAgentJobDeliversFinalText('opencode-cli')).toBe(true);
    for (const provider of ['claude-cli', 'codex-cli', 'gemini-cli', 'anthropic-api', null, undefined]) {
      expect(scheduledAgentJobDeliversFinalText(provider)).toBe(false);
    }
  });

  it('rewrites only the delivery instructions for OpenCode and keeps the job prompt', () => {
    const rewritten = scheduledAgentJobTurnForProvider(turn, 'opencode-cli');

    expect(rewritten.startsWith('[Scheduled job: check]: [isolated scheduled background turn]\n')).toBe(true);
    expect(rewritten).toContain('Do not call send_message.');
    expect(rewritten).toContain('final answer must be exactly NO_REPLY');
    expect(rewritten).not.toContain('deliver it with send_message');
    expect(rewritten).not.toContain('Do not place the user-facing update in plain assistant text');
    expect(rewritten.endsWith('\n\nRun the date command.')).toBe(true);
  });

  it('leaves the send_message instructions byte-identical for every other provider', () => {
    for (const provider of ['claude-cli', 'codex-cli', null]) {
      expect(scheduledAgentJobTurnForProvider(turn, provider)).toBe(turn);
    }
    expect(scheduledAgentJobTurnForProvider('plain live message', 'opencode-cli')).toBe('plain live message');
  });

  it('classifies held final text as an answer, explicit silence, or a missing answer', () => {
    expect(resolveScheduledFinalAnswer(' Scheduled OK 2026-09-27T00:00:00Z \n'))
      .toEqual({ kind: 'answer', text: 'Scheduled OK 2026-09-27T00:00:00Z' });
    expect(resolveScheduledFinalAnswer('Scheduled OK\nNO_REPLY'))
      .toEqual({ kind: 'answer', text: 'Scheduled OK' });
    expect(resolveScheduledFinalAnswer(' NO_REPLY ')).toEqual({ kind: 'no_reply' });
    expect(resolveScheduledFinalAnswer(undefined)).toEqual({ kind: 'missing' });
    expect(resolveScheduledFinalAnswer('  \n ')).toEqual({ kind: 'missing' });
  });
});
