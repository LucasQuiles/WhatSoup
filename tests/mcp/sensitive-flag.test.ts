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
import { ADMIN_REQUIRED_DENIAL, ToolRegistry } from '../../src/mcp/registry.ts';
import { makeConversationBinding } from '../../src/mcp/types.ts';
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
    expect(res.content[0].text).toBe(ADMIN_REQUIRED_DENIAL('sensitive_probe'));
  });

  it('denies an actor-less session with the typed denial (list-visible, F01)', async () => {
    const registry = makeRegistry();
    // Authorizer admits only the admin; ANON (no actorJid) and GUEST
    // (actorJid, not admin) are both list-visible (global tier, unbound)
    // and receive the typed ADMIN_REQUIRED_DENIAL.
    registry.setSensitiveToolAuthorizer((s) => s.actorJid === ADMIN.actorJid);
    const anon = await registry.call('sensitive_probe', {}, ANON);
    const guest = await registry.call('sensitive_probe', {}, GUEST);
    const unknown = await registry.call('never_registered', {}, ANON);
    // List-visible sessions get the typed denial for registered sensitive tools.
    expect(anon.content[0].text).toBe(ADMIN_REQUIRED_DENIAL('sensitive_probe'));
    expect(guest.content[0].text).toBe(ADMIN_REQUIRED_DENIAL('sensitive_probe'));
    // Genuine-unknown tools still get the non-disclosing reply (no ADMIN_REQUIRED_DENIAL).
    expect(unknown.content[0].text).toBe('Unknown tool: never_registered');
    expect(anon.isError && guest.isError && unknown.isError).toBe(true);
  });

  it('authorized actors call sensitive tools (NT-5)', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer((s) => s.actorJid === ADMIN.actorJid);
    const res = await registry.call('sensitive_probe', {}, ADMIN);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe('sensitive-ok');
    // The unauthorized guest is denied with typed denial (list-visible).
    expect((await registry.call('sensitive_probe', {}, GUEST)).content[0].text).toBe(ADMIN_REQUIRED_DENIAL('sensitive_probe'));
  });

  it('an authorizer that throws denies (fail-closed), never grants', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer(() => {
      throw new Error('predicate exploded');
    });
    const res = await registry.call('sensitive_probe', {}, ADMIN);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(ADMIN_REQUIRED_DENIAL('sensitive_probe'));
  });

  it('a truthy NON-boolean authorizer return does NOT open the gate (F11 async fail-open guard)', async () => {
    const registry = makeRegistry();
    // A mistakenly-async authorizer returns a Promise (always truthy). Strict
    // === true must treat it as a deny, not a grant.
    registry.setSensitiveToolAuthorizer(((): boolean => Promise.resolve(true) as unknown as boolean));
    const res = await registry.call('sensitive_probe', {}, ADMIN);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(ADMIN_REQUIRED_DENIAL('sensitive_probe'));
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
  it('records a denied sensitive-tool attempt in the durability ledger (F07 forensic trail)', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer(() => false); // deny everyone
    const calls: Array<{ m: string; args: unknown[] }> = [];
    const durability = {
      recordToolCall: (...args: unknown[]) => { calls.push({ m: 'record', args }); return 7; },
      markToolExecuting: (...args: unknown[]) => { calls.push({ m: 'exec', args }); },
      markToolComplete: (...args: unknown[]) => { calls.push({ m: 'complete', args }); },
    };
    (registry as unknown as { setDurability: (d: unknown) => void }).setDurability(durability);
    const session = { tier: 'global', actorJid: GUEST.actorJid, conversationKey: '15550000009' } as SessionContext;
    const res = await registry.call('sensitive_probe', {}, session);
    // Caller gets typed denial (list-visible, global tier)...
    expect(res.content[0].text).toBe(ADMIN_REQUIRED_DENIAL('sensitive_probe'));
    // ...but the denied attempt is recorded and terminalized without entering execution.
    expect(calls.map((c) => c.m)).toEqual(['record', 'complete']);
    expect(String(calls[0].args[1])).toBe('sensitive_probe'); // toolName
    expect(calls[1].args[1]).toMatchObject({
      isError: true,
      failure: {
        failureCode: 'authorization_denied',
        failureStage: 'authorization',
      },
    });
  });

  it('records global calls under the global durability sentinel when conversationKey is absent', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer(() => false);
    let recorded = 0;
    const durability = {
      recordToolCall: () => { recorded++; return 1; },
      markToolExecuting: () => {},
      markToolComplete: () => {},
    };
    (registry as unknown as { setDurability: (d: unknown) => void }).setDurability(durability);
    await registry.call('sensitive_probe', {}, GUEST); // GUEST has no conversationKey
    expect(recorded).toBe(1);
  });

  // #2974 Option A G3 — visibility-gated denial shape
  it('(G3a) chat-scoped session gets uniform Unknown tool for sensitive global tool', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer((s) => s.actorJid === ADMIN.actorJid);
    const chatScoped: SessionContext = {
      tier: 'chat-scoped',
      conversationKey: '15550000009@s.whatsapp.net',
      deliveryJid: '15550000009@s.whatsapp.net',
    };
    const res = await registry.call('sensitive_probe', {}, chatScoped);
    // Chat-scoped: listing hides global-scope sensitive tools → uniform reply
    expect(res.content[0].text).toBe('Unknown tool: sensitive_probe');
    // Non-vacuity: the same tool works for an authorized global session
    expect((await registry.call('sensitive_probe', {}, ADMIN)).content[0].text).toBe('sensitive-ok');
  });

  it('(G3b) conversation-bound session gets uniform Unknown tool for non-eligible sensitive tool', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer((s) => s.actorJid === ADMIN.actorJid);
    const bound: SessionContext = {
      tier: 'global',
      actorJid: GUEST.actorJid,
      binding: makeConversationBinding('15550000009@s.whatsapp.net'),
    };
    const res = await registry.call('sensitive_probe', {}, bound);
    // Conversation-bound: only chat-scope + transcribe_audio listed → uniform reply
    expect(res.content[0].text).toBe('Unknown tool: sensitive_probe');
    // Non-vacuity: same tool succeeds for authorized global session
    expect((await registry.call('sensitive_probe', {}, ADMIN)).content[0].text).toBe('sensitive-ok');
  });

  it('(correlation) listTools(session) contains sensitive_probe ⇔ denial is typed', async () => {
    const registry = makeRegistry();
    registry.setSensitiveToolAuthorizer((s) => s.actorJid === ADMIN.actorJid);
    const chatScoped: SessionContext = {
      tier: 'chat-scoped',
      conversationKey: '15550000009@s.whatsapp.net',
      deliveryJid: '15550000009@s.whatsapp.net',
    };
    const anonList = registry.listTools(ANON);
    const chatList = registry.listTools(chatScoped);
    expect(anonList.some((t) => t.name === 'sensitive_probe')).toBe(true);
    expect(chatList.some((t) => t.name === 'sensitive_probe')).toBe(false);
  });

});
