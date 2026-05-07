import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/mcp/registry.ts';

describe('ToolRegistry.listTools ordering', () => {
  function makeRegistry() {
    const registry = new ToolRegistry();
    const makeTool = (name: string) => ({
      name,
      description: `${name} tool`,
      scope: 'chat' as const,
      targetMode: 'caller-supplied' as const,
      schema: z.object({}),
      handler: async () => ({ content: [{ type: 'text' as const, text: '' }] }),
    });
    // Register in non-alphabetical order
    registry.register(makeTool('zebra_tool'));
    registry.register(makeTool('alpha_tool'));
    registry.register(makeTool('middle_tool'));
    return registry;
  }

  it('returns tools sorted alphabetically by name', () => {
    const registry = makeRegistry();
    const session = { tier: 'global' as const, deliveryJid: '', conversationKey: '' };
    const tools = registry.listTools(session);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['alpha_tool', 'middle_tool', 'zebra_tool']);
  });

  it('maintains sort stability across multiple calls', () => {
    const registry = makeRegistry();
    const session = { tier: 'global' as const, deliveryJid: '', conversationKey: '' };
    const first = registry.listTools(session).map((t) => t.name);
    const second = registry.listTools(session).map((t) => t.name);
    expect(first).toEqual(second);
  });

  it('does not depend on the runtime default locale for tool ordering', () => {
    const registry = makeRegistry();
    const session = { tier: 'global' as const, deliveryJid: '', conversationKey: '' };
    const nativeLocaleCompare = String.prototype.localeCompare;
    const localeSpy = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(function (
        this: string,
        compareString: string,
        locales?: Intl.LocalesArgument,
        options?: Intl.CollatorOptions,
      ) {
        if (locales === 'en' && options?.sensitivity === 'base') {
          return nativeLocaleCompare.call(this, compareString, locales, options);
        }
        return -nativeLocaleCompare.call(this, compareString, 'en', { sensitivity: 'base' });
      });

    try {
      const names = registry.listTools(session).map((t) => t.name);
      expect(names).toEqual(['alpha_tool', 'middle_tool', 'zebra_tool']);
    } finally {
      localeSpy.mockRestore();
    }
  });
});
