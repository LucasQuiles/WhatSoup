// Session providerConfig override merge (QR-247 per-chat wire × instance config).
//
// The per-chat actor-socket wire returns a providerConfigOverride of
// `{ mcpConfig: [perChatCfgPath], strictMcpConfig: true }`, and the session
// spawn site merged it with a shallow spread — so an instance that declared
// its own `providerConfig.mcpConfig` (e.g. a host-local MCP server config such
// as mini11's agent365 keyring server) silently LOST that declaration for
// every per-chat session. That clobber is why mini11 needed a claude-shim to
// re-merge its M365 server into the generated per-session config. These tests
// pin the contract: override wins per-key, EXCEPT mcpConfig, which is the
// union (override paths first, then instance paths, deduplicated).
import { describe, expect, it } from 'vitest';
import { mergeSessionProviderConfig } from '../../src/core/provider-mcp-config.ts';

const PER_CHAT_CFG = '/tmp/x/.claude/whatsoup-abc.mcp.json';
const INSTANCE_CFG = '/tmp/x/agent365.mcp.json';

describe('mergeSessionProviderConfig', () => {
  it('unions mcpConfig: per-chat override paths first, then instance-declared paths', () => {
    const merged = mergeSessionProviderConfig(
      { mcpConfig: [INSTANCE_CFG], permissionMode: 'bypassPermissions' },
      { mcpConfig: [PER_CHAT_CFG], strictMcpConfig: true },
    );
    expect(merged['mcpConfig']).toEqual([PER_CHAT_CFG, INSTANCE_CFG]);
    expect(merged['strictMcpConfig']).toBe(true);
    expect(merged['permissionMode']).toBe('bypassPermissions');
  });

  it('accepts a string-valued instance mcpConfig (the schema allows string | string[])', () => {
    const merged = mergeSessionProviderConfig(
      { mcpConfig: INSTANCE_CFG },
      { mcpConfig: [PER_CHAT_CFG], strictMcpConfig: true },
    );
    expect(merged['mcpConfig']).toEqual([PER_CHAT_CFG, INSTANCE_CFG]);
  });

  it('deduplicates a path present in both', () => {
    const merged = mergeSessionProviderConfig(
      { mcpConfig: [PER_CHAT_CFG, INSTANCE_CFG] },
      { mcpConfig: [PER_CHAT_CFG] },
    );
    expect(merged['mcpConfig']).toEqual([PER_CHAT_CFG, INSTANCE_CFG]);
  });

  it('keeps the override mcpConfig alone when the instance declares none', () => {
    const merged = mergeSessionProviderConfig(
      { permissionMode: 'default' },
      { mcpConfig: [PER_CHAT_CFG], strictMcpConfig: true },
    );
    expect(merged['mcpConfig']).toEqual([PER_CHAT_CFG]);
  });

  it('keeps the instance mcpConfig when the override has no mcpConfig key', () => {
    const merged = mergeSessionProviderConfig(
      { mcpConfig: [INSTANCE_CFG] },
      { strictMcpConfig: true },
    );
    expect(merged['mcpConfig']).toEqual([INSTANCE_CFG]);
  });

  it('handles an undefined base (no instance providerConfig at all)', () => {
    const merged = mergeSessionProviderConfig(undefined, { mcpConfig: [PER_CHAT_CFG] });
    expect(merged['mcpConfig']).toEqual([PER_CHAT_CFG]);
  });

  it('override wins per-key for everything except mcpConfig (plain spread semantics preserved)', () => {
    const merged = mergeSessionProviderConfig(
      { permissionMode: 'default', tools: ['a'] },
      { permissionMode: 'bypassPermissions' },
    );
    expect(merged['permissionMode']).toBe('bypassPermissions');
    expect(merged['tools']).toEqual(['a']);
  });
});
