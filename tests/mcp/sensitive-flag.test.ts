/**
 * R1 sensitive-tool gate (registry mechanics). Enforcement is authoritative at
 * call() time, evaluated with the turn's actor; listing is NOT a gate (all
 * sensitive substrate tools are scope:'global', so chat-scoped/untrusted
 * sessions are already blocked by the scope gate — hiding them from global
 * listings only broke admin sessions). The authorizer here is a controllable
 * stub; the real instance admin predicate is exercised in substrate.test.ts.
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
    scope: 'global',
    targetMode: 'caller-supplied',
    sensitive: true,
    handler: async () => 'sensitive-ok',
  });
  registry.register({
    name: 'harmless_echo',
    description: 'plain test tool',
    schema: z.object({}),
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async () => 'echo-ok',
  });
  return registry;
}

describe('R1 sensitive-tool gate', () => {
  it('listing is not a gate: sensitive tools are listed regardless of authorizer (enforcement is at call)', () => {
    const registry = makeRegistry();
    // No authorizer, actor-less: still LISTED (base listing behavior preserved;
    // the untrusted surface is the chat-scoped scope gate, not this filter).
    expect(registry.listTools(ANON).map((t) => t.name)).toEqual(['harmless_echo', 'sensitive_probe']);
    expect(registry.listTools(GUEST).map((t) => t.name)).toEqual(['harmless_echo', 'sensitive_probe']);
  });

  it('denies a sensitive call when NO authorizer is installed (fail-closed by construction)', async () => {
    const registry = makeRegistry();
    const res = await registry.call('sensitive_probe', {}, ADMIN);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Unknown tool: sensitive_probe');
  });

  it('denies an actor-less session with the SAME reply as an unauthorized actor (no existence oracle, F01)', async () => {
    const registry = makeRegistry();
    // Authorizer admits only the admin; ANON (no actorJid) and GUEST
    // (actorJid, not admin) are both unauthorized and must be
    // indistinguishable from an unknown tool.
    registry.setSensitiveToolAuthorizer((s) => s.actorJid === ADMIN.actorJid);
    const anon = await registry.call('sensitive_probe', {}, ANON);
    const guest = await registry.call('sensitive_probe', {}, GUEST);
    const unknown = await registry.call('never_registered', {}, ANON);
    // All three replies are byte-identical in shape: 'Unknown tool: <name>'.
    expect(anon.content[0].text).toBe('Unknown tool: sensitive_probe');
    expect(guest.content[0].text).toBe('Unknown tool: sensitive_probe');
    expect(unknown.content[0].text).toBe('Unknown tool: never_registered');
    expect(anon.isError && guest.isError && unknown.isError).toBe(true);
  });

  it('authorized actors call sensitive tools (NT-5)', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer((s) => s.actorJid === ADMIN.actorJid);
    const res = await registry.call('sensitive_probe', {}, ADMIN);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe('sensitive-ok');
    // The unauthorized guest is denied without existence disclosure (NT-1/NT-3).
    expect((await registry.call('sensitive_probe', {}, GUEST)).content[0].text).toBe('Unknown tool: sensitive_probe');
  });

  it('an authorizer that throws denies (fail-closed), never grants', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer(() => {
      throw new Error('predicate exploded');
    });
    const res = await registry.call('sensitive_probe', {}, ADMIN);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Unknown tool: sensitive_probe');
  });

  it('a truthy NON-boolean authorizer return does NOT open the gate (F11 async fail-open guard)', async () => {
    const registry = makeRegistry();
    // A mistakenly-async authorizer returns a Promise (always truthy). Strict
    // === true must treat it as a deny, not a grant.
    registry.setSensitiveToolAuthorizer(((): boolean => Promise.resolve(true) as unknown as boolean));
    const res = await registry.call('sensitive_probe', {}, ADMIN);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Unknown tool: sensitive_probe');
  });

  it('a second authorizer install throws — no silent last-write-wins clobber (F13)', () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer(() => true);
    expect(() => registry.setSensitiveToolAuthorizer(() => false)).toThrow(/already installed/);
  });

  it('non-sensitive tools are unaffected in every authorizer state', async () => {
    const registry = makeRegistry();
    expect((await registry.call('harmless_echo', {}, ANON)).content[0].text).toBe('echo-ok');
    registry.setSensitiveToolAuthorizer(() => false);
    expect((await registry.call('harmless_echo', {}, GUEST)).content[0].text).toBe('echo-ok');
  });
});
