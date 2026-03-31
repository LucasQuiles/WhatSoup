import { describe, it, expect } from 'vitest';
import { buildMcpAllowlist } from '../../src/core/workspace.ts';

describe('buildMcpAllowlist', () => {
  it('prefixes each name with mcp__whatsoup__', () => {
    const result = buildMcpAllowlist(['send_message', 'list_chats'], false);
    expect(result).toContain('mcp__whatsoup__send_message');
    expect(result).toContain('mcp__whatsoup__list_chats');
  });

  it('includes mcp__send-media__send_media when sendMedia is true', () => {
    const result = buildMcpAllowlist(['send_message'], true);
    expect(result).toContain('mcp__send-media__send_media');
  });

  it('excludes mcp__send-media__send_media when sendMedia is false', () => {
    const result = buildMcpAllowlist(['send_message'], false);
    expect(result).not.toContain('mcp__send-media__send_media');
  });

  it('no plugin MCP tools in output for a typical chat-scoped set', () => {
    const chatTools = ['send_message', 'read_messages', 'list_chats'];
    const result = buildMcpAllowlist(chatTools, false);
    // All entries should start with mcp__whatsoup__
    for (const entry of result) {
      expect(entry.startsWith('mcp__whatsoup__')).toBe(true);
    }
    expect(result).toHaveLength(chatTools.length);
  });

  it('returns empty array for empty input without sendMedia', () => {
    const result = buildMcpAllowlist([], false);
    expect(result).toEqual([]);
  });

  it('returns only send_media entry for empty input with sendMedia true', () => {
    const result = buildMcpAllowlist([], true);
    expect(result).toEqual(['mcp__send-media__send_media']);
  });
});
