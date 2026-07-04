/**
 * R1 sensitive-tool gate (registry mechanics): declarative `sensitive` flag,
 * central fail-closed enforcement in ToolRegistry.call, and listTools
 * invisibility for unauthorized sessions. The real instance admin predicate
 * is exercised at the substrate integration level (substrate.test.ts); here
 * the authorizer is a controllable stub.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import type { SessionContext } from '../../src/mcp/types.ts';

const ADMIN: SessionContext = { tier: 'global', actorJid: '15550000001@s.whatsapp.net' };
const GUEST: SessionContext = { tier: 'global', actorJid: '15550000002@s.whatsapp.net' };
const ANON: SessionContext = { tier: 'global' };

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'sensitive_probe',
    description: 'sensitive test tool',
    schema: z.object({}),
    scope: 'chat',
    targetMode: 'caller-supplied',
    sensitive: true,
    handler: async () => 'sensitive-ok',
  });
  registry.register({
    name: 'harmless_echo',
    description: 'plain test tool',
    schema: z.object({}),
    scope: 'chat',
    targetMode: 'caller-supplied',
    handler: async () => 'echo-ok',
  });
  return registry;
}

describe('R1 sensitive-tool gate', () => {
  it('denies and hides sensitive tools when NO authorizer is installed (fail-closed by construction)', async () => {
    const registry = makeRegistry();
    expect(registry.listTools(ADMIN).map((t) => t.name)).toEqual(['harmless_echo']);
    const res = await registry.call('sensitive_probe', {}, ADMIN);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Unknown tool: sensitive_probe');
  });

  it('denies a session without actorJid even when the authorizer allows everyone (NT-4)', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer(() => true);
    expect(registry.listTools(ANON).map((t) => t.name)).toEqual(['harmless_echo']);
    const res = await registry.call('sensitive_probe', {}, ANON);
    expect(res.isError).toBe(true);
    // Internal wiring fault, not an untrusted probe — stays actionable.
    expect(res.content[0].text).toContain('no actorJid');
  });

  it('authorized actors see and call sensitive tools (NT-5)', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer((s) => s.actorJid === ADMIN.actorJid);
    expect(registry.listTools(ADMIN).map((t) => t.name)).toEqual(['harmless_echo', 'sensitive_probe']);
    const res = await registry.call('sensitive_probe', {}, ADMIN);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe('sensitive-ok');
  });

  it('an unauthorized actor gets a reply indistinguishable from a nonexistent tool (NT-1/NT-3)', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer((s) => s.actorJid === ADMIN.actorJid);
    expect(registry.listTools(GUEST).map((t) => t.name)).toEqual(['harmless_echo']);
    const denied = await registry.call('sensitive_probe', {}, GUEST);
    const unknown = await registry.call('never_registered', {}, GUEST);
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toBe('Unknown tool: sensitive_probe');
    expect(unknown.content[0].text).toBe('Unknown tool: never_registered');
  });

  it('an authorizer that throws denies (fail-closed), never grants', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer(() => {
      throw new Error('predicate exploded');
    });
    expect(registry.listTools(ADMIN).map((t) => t.name)).toEqual(['harmless_echo']);
    const res = await registry.call('sensitive_probe', {}, ADMIN);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Unknown tool: sensitive_probe');
  });

  it('non-sensitive tools are unaffected in every authorizer state', async () => {
    const registry = makeRegistry();
    expect((await registry.call('harmless_echo', {}, ANON)).content[0].text).toBe('echo-ok');
    registry.setSensitiveToolAuthorizer(() => false);
    expect((await registry.call('harmless_echo', {}, GUEST)).content[0].text).toBe('echo-ok');
  });
});
