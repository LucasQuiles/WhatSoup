import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS,
  ToolRegistry,
} from '../../../src/mcp/registry.ts';
import {
  isolateScheduledAgentJobPrompt,
  resolveAgentTurnMapKey,
  isScheduledAgentJobMapKey,
} from '../../../src/runtimes/agent/scheduled-agent-job-isolation.ts';

describe('scheduled agent-job isolation', () => {
  const chatMapKey = 'test-scheduled-group@g.us';

  it('keeps interactive turns on the canonical chat scope', () => {
    expect(resolveAgentTurnMapKey(chatMapKey, false)).toBe(chatMapKey);
    expect(isScheduledAgentJobMapKey(chatMapKey)).toBe(false);
  });

  it('routes scheduled turns to a stable scope distinct from the interactive session', () => {
    const scheduled = resolveAgentTurnMapKey(chatMapKey, true);

    expect(scheduled).not.toBe(chatMapKey);
    expect(resolveAgentTurnMapKey(chatMapKey, true)).toBe(scheduled);
    expect(isScheduledAgentJobMapKey(scheduled)).toBe(true);
  });

  it('requires explicit user-facing delivery and forbids plain scheduled stdout', () => {
    const prompt = isolateScheduledAgentJobPrompt('Check for a scholarship reply.');

    expect(prompt).toContain('isolated scheduled background turn');
    expect(prompt).toContain('send_message');
    expect(prompt).toContain('NO_REPLY');
    expect(prompt).toContain('Check for a scholarship reply.');
    expect(prompt).toContain('Never expose reasoning');
  });

  it('hides and rejects chat-history mutation tools while retaining send capability', async () => {
    const registry = new ToolRegistry();
    const destructiveHandler = async () => ({ deleted: true });
    for (const name of SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS) {
      registry.register({
        name,
        description: name,
        scope: 'chat',
        targetMode: 'caller-supplied',
        schema: z.object({}),
        handler: destructiveHandler,
      });
    }
    registry.register({
      name: 'send_message',
      description: 'send',
      scope: 'chat',
      targetMode: 'caller-supplied',
      schema: z.object({}),
      handler: async () => ({ sent: true }),
    });
    const session = { tier: 'global' as const, purpose: 'scheduled-agent-job' as const };

    expect(registry.listTools(session).map((tool) => tool.name)).toEqual(['send_message']);
    for (const name of SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS) {
      await expect(registry.call(name, {}, session)).resolves.toMatchObject({
        isError: true,
        content: [{ text: `Unknown tool: ${name}` }],
      });
    }
    await expect(registry.call('send_message', {}, session)).resolves.toMatchObject({
      content: [{ text: expect.stringContaining('"sent": true') }],
    });
  });
});
