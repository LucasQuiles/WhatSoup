import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolRegistry } from '../../../src/mcp/registry.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { buildMemoryGuidance, memoryGuidanceSystemBlock } from '../../../src/runtimes/agent/memory-guidance.ts';

const CHAT_SESSION: SessionContext = { tier: 'chat-scoped', conversationKey: '15550002', deliveryJid: '15550002@s.whatsapp.net' };
const SHARED_SESSION: SessionContext = { tier: 'global' };

function registryWith(...names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: `${name} stand-in`,
      scope: 'chat',
      targetMode: 'injected',
      schema: z.object({ chatJid: z.string() }),
      handler: async () => ({ ok: true }),
    });
  }
  return registry;
}

describe('buildMemoryGuidance', () => {
  const text = buildMemoryGuidance({ operatorInstance: false, knowledgeSearch: true });

  it('names memory_write, says when to save, and states the chat scope', () => {
    expect(text).toContain('Save a memory with memory_write when the person states a lasting fact, preference, decision or commitment');
    expect(text).toContain('asks you to remember something');
    expect(text).toContain('Memories are saved to this chat.');
    expect(text).toContain('groups with other people cannot');
  });

  it('lists what must never be saved', () => {
    for (const item of ['passwords', 'keys', 'codes', 'payment details', 'health details', 'anyone other than the person you are talking to']) {
      expect(text).toContain(item);
    }
  });

  it('points recall at knowledge_search only when that tool is available', () => {
    expect(text).toContain('check memory with knowledge_search');
    expect(buildMemoryGuidance({ operatorInstance: false, knowledgeSearch: false })).not.toContain('knowledge_search');
  });

  it('stays within eight lines', () => {
    expect(text.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('tells the operator instance that every chat can recall its memories', () => {
    const operator = buildMemoryGuidance({ operatorInstance: true, knowledgeSearch: true });
    expect(operator).toContain('On this instance every chat can recall them.');
    expect(operator).not.toContain('groups with other people cannot');
  });
});

describe('memoryGuidanceSystemBlock', () => {
  it('returns the block when memory is ready and memory_write is listed for the session', () => {
    for (const session of [CHAT_SESSION, SHARED_SESSION]) {
      const block = memoryGuidanceSystemBlock({
        memoryReady: true, registry: registryWith('memory_write', 'knowledge_search'), session, instanceName: 'bot',
      });
      expect(block?.()).toBe(buildMemoryGuidance({ operatorInstance: false, knowledgeSearch: true }));
    }
  });

  it('returns undefined when memory was not ready at startup', () => {
    expect(memoryGuidanceSystemBlock({
      memoryReady: false, registry: registryWith('memory_write', 'knowledge_search'), session: CHAT_SESSION, instanceName: 'bot',
    })).toBeUndefined();
  });

  it('returns undefined when memory_write is not registered', () => {
    expect(memoryGuidanceSystemBlock({
      memoryReady: true, registry: registryWith('knowledge_search'), session: CHAT_SESSION, instanceName: 'bot',
    })).toBeUndefined();
  });

  it('uses the operator reach sentence for the operator instance', () => {
    const block = memoryGuidanceSystemBlock({
      memoryReady: true, registry: registryWith('memory_write'), session: CHAT_SESSION, instanceName: 'q',
    });
    expect(block?.()).toBe(buildMemoryGuidance({ operatorInstance: true, knowledgeSearch: false }));
  });
});
