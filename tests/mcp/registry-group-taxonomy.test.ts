// tests/mcp/registry-group-taxonomy.test.ts
//
// QR-017 — tool group taxonomy (design #1976 §3.0).
//
// This step adds an OPTIONAL `group` tag to ToolDeclaration and populates it at
// the registration seam (ToolRegistry.withModule bracket, driven by
// register-all.ts's per-module runModule). It is a PURE metadata layer:
//   - the tag is optional; untagged tools remain valid,
//   - the bracket stamps a whole module's tools with one group, no per-tool edits,
//   - listTools() output is byte-identical to pre-taxonomy behaviour (the tag is
//     carried but NOT acted on — no filtering, no hiding),
//   - call() authorization is entirely untouched.
//
// These tests pin all four properties. The listTools byte-identity proof
// (tagged registry vs an identically-populated UNtagged registry) is the
// load-bearing one: it demonstrates the advertised surface is unchanged.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Database } from '../../src/core/database.ts';
import { PresenceCache } from '../../src/transport/presence-cache.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { registerAllTools } from '../../src/mcp/register-all.ts';
import { buildRestartSelfTool } from '../../src/runtimes/agent/self-restart.ts';
import { makeConversationBinding } from '../../src/mcp/types.ts';
import type { ToolDeclaration, ToolScope, SessionContext } from '../../src/mcp/types.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(
  name: string,
  scope: ToolScope = 'global',
  extra: Partial<ToolDeclaration> = {},
): ToolDeclaration {
  return {
    name,
    description: `desc for ${name}`,
    schema: z.object({}),
    scope,
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async () => ({ ok: true, name }),
    ...extra,
  };
}

// A representative, tier-exercising tool set. Fresh objects per call so the two
// registries never share (register stamps `group` in place).
function sampleTools(): ToolDeclaration[] {
  return [
    // injected global tool with an alias target — exercises buildListSchema's
    // injected branch across every tier.
    makeTool('send_thing', 'global', {
      targetMode: 'injected',
      schema: z.object({ chatJid: z.string(), to: z.string().optional(), text: z.string() }),
    }),
    makeTool('chat_read', 'chat'),
    makeTool('list_global', 'global'),
    // the sole CONVERSATION_SAFE_GLOBAL_TOOLS member — visible to bound sessions.
    makeTool('transcribe_audio', 'global'),
  ];
}

const globalSession: SessionContext = { tier: 'global' };
const chatScopedSession: SessionContext = {
  tier: 'chat-scoped',
  conversationKey: 'conv',
  deliveryJid: 'conv@s.whatsapp.net',
};
const boundSession: SessionContext = {
  tier: 'global',
  binding: makeConversationBinding('conv', 'conv@s.whatsapp.net'),
  conversationKey: 'conv',
  deliveryJid: 'conv@s.whatsapp.net',
};

function makeConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
    presenceCache: new PresenceCache(),
    getSocket: () => null,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as ConnectionManager;
}

// ---------------------------------------------------------------------------
// withModule bracket — the tagging mechanism
// ---------------------------------------------------------------------------

describe('ToolRegistry.withModule — group tagging (QR-017)', () => {
  it('stamps the bracket name onto every tool registered inside it', () => {
    const registry = new ToolRegistry();
    const decl = makeTool('alpha');
    registry.withModule('messaging', () => registry.register(decl));
    expect(decl.group).toBe('messaging');
  });

  it('does not overwrite a group the tool already declares (??= semantics)', () => {
    const registry = new ToolRegistry();
    const decl = makeTool('beta', 'global', { group: 'control-plane' });
    registry.withModule('messaging', () => registry.register(decl));
    expect(decl.group).toBe('control-plane');
  });

  it('leaves tools registered outside any bracket untagged, and they still register + list', () => {
    const registry = new ToolRegistry();
    const decl = makeTool('gamma');
    expect(() => registry.register(decl)).not.toThrow();
    expect(decl.group).toBeUndefined();
    expect(registry.listTools(globalSession).some((t) => t.name === 'gamma')).toBe(true);
  });

  it('restores the surrounding group after the bracket closes (brackets are isolated)', () => {
    const registry = new ToolRegistry();
    const a = makeTool('a');
    const b = makeTool('b');
    const c = makeTool('c');
    registry.withModule('mod1', () => registry.register(a));
    registry.register(b); // between brackets → no group leaks
    registry.withModule('mod2', () => registry.register(c));
    expect(a.group).toBe('mod1');
    expect(b.group).toBeUndefined();
    expect(c.group).toBe('mod2');
  });

  it('restores the previous group even when the bracketed fn throws', () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.withModule('boom', () => {
        throw new Error('module blew up');
      }),
    ).toThrow(/blew up/);
    // A subsequent bracket-less registration must not inherit 'boom'.
    const after = makeTool('after');
    registry.register(after);
    expect(after.group).toBeUndefined();
    // Strong terminal: currentGroup was truly RESTORED (not just left undefined by luck) —
    // a fresh bracket after the throw still stamps its own group correctly.
    const next = makeTool('next');
    registry.withModule('recovered', () => registry.register(next));
    expect(next.group).toBe('recovered');
  });
});

// ---------------------------------------------------------------------------
// The spine: taxonomy changes nothing that is advertised or authorized
// ---------------------------------------------------------------------------

describe('group taxonomy is inert for listTools() and call() (QR-017)', () => {
  it('listTools() output is byte-identical whether tools are tagged or not, for every tier', () => {
    const tagged = new ToolRegistry();
    tagged.withModule('demo', () => {
      for (const t of sampleTools()) tagged.register(t);
    });

    const untagged = new ToolRegistry();
    for (const t of sampleTools()) untagged.register(t);

    for (const session of [globalSession, chatScopedSession, boundSession]) {
      expect(tagged.listTools(session)).toEqual(untagged.listTools(session));
    }
  });

  it('listTools() entries never expose the group tag', () => {
    const registry = new ToolRegistry();
    registry.withModule('demo', () => {
      for (const t of sampleTools()) registry.register(t);
    });
    for (const entry of registry.listTools(globalSession)) {
      expect(Object.prototype.hasOwnProperty.call(entry, 'group')).toBe(false);
      expect(Object.keys(entry).sort()).toEqual(['description', 'inputSchema', 'name']);
    }
  });

  it('call() returns an identical result for a grouped tool vs an ungrouped one', async () => {
    const grouped = new ToolRegistry();
    grouped.withModule('demo', () =>
      grouped.register(makeTool('do_x', 'global', { handler: async () => ({ echoed: 'x' }) })),
    );
    const plain = new ToolRegistry();
    plain.register(makeTool('do_x', 'global', { handler: async () => ({ echoed: 'x' }) }));

    const r1 = await grouped.call('do_x', {}, globalSession);
    const r2 = await plain.call('do_x', {}, globalSession);
    expect(r1).toEqual(r2);
    // Strong terminal: the grouped call actually surfaced the handler's success result
    // (the handler return is JSON.stringify'd into content[0].text — registry.ts:610), not an
    // error envelope. `isError` being undefined alone would pass for any shape.
    expect(r1.isError).toBeUndefined();
    expect(r1.content[0].text).toContain('"echoed": "x"');
  });
});

// ---------------------------------------------------------------------------
// Full-surface coverage via the real registration path
// ---------------------------------------------------------------------------

describe('registerAllTools tags every module tool (QR-017)', () => {
  it('leaves no module tool untagged, and stamps the module name as the group', () => {
    const db = new Database(':memory:');
    db.open();

    const captured: ToolDeclaration[] = [];
    const registry = new ToolRegistry();
    const origRegister = registry.register.bind(registry);
    registry.register = (tool: ToolDeclaration) => {
      origRegister(tool); // stamps group from the active withModule bracket
      captured.push(tool);
    };

    registerAllTools(registry, makeConnection(), db);

    expect(captured.length).toBeGreaterThan(0);

    const untagged = captured.filter(
      (t) => typeof t.group !== 'string' || t.group.length === 0,
    );
    expect(untagged.map((t) => t.name)).toEqual([]);

    // Spot-check group == module name for tools whose owning module is known.
    const byName = new Map(captured.map((t) => [t.name, t]));
    expect(byName.get('send_message')?.group).toBe('messaging');
    expect(byName.get('post_status')?.group).toBe('status');
    expect(byName.get('schedule_message')?.group).toBe('scheduling');

    db.raw.close();
  });
});

// ---------------------------------------------------------------------------
// Inline control-plane exception: restart_self is tag-able via the bracket
// (regression guard for the "frozen return value" risk — buildRestartSelfTool
// must return a mutable declaration so register()'s in-place stamp succeeds).
// ---------------------------------------------------------------------------

describe('inline control-plane tools are tag-able (QR-017)', () => {
  it('restart_self declaration accepts a control-plane group via withModule', () => {
    const decl = buildRestartSelfTool({
      instanceName: 'test',
      dataRoot: '/tmp',
      resolveChatJid: () => undefined,
      sendAck: async () => {},
      serviceManager: {} as never,
      trigger: (async () => ({ ok: true })) as never,
      assertAdmin: () => {},
    });
    expect(decl.name).toBe('restart_self');

    const registry = new ToolRegistry();
    registry.withModule('control-plane', () => registry.register(decl));
    expect(decl.group).toBe('control-plane');
  });
});
