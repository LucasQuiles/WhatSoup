// Live-registry probe for #1976 per-tier budgets — prints the LIVE advertised
// counts before any budget is pinned. Mirrors the mock + registration path of
// tests/mcp/register-all.test.ts exactly.
import { Database } from '../src/core/database.ts';
import { ToolRegistry } from '../src/mcp/registry.ts';
import { PresenceCache } from '../src/transport/presence-cache.ts';
import { registerAllTools } from '../src/mcp/register-all.ts';
import type { ConnectionManager } from '../src/transport/connection.ts';
import type { SessionContext } from '../src/mcp/types.ts';

function makeConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
    presenceCache: new PresenceCache(),
    getSocket: () => null,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as ConnectionManager;
}

const db = new Database(':memory:');
db.open();
const registry = new ToolRegistry();
// Control the memory_write registration gate explicitly so the probe measures
// BOTH canonical surfaces: gate OFF (CI-default: no pinecone env) and gate ON.
const cfgMod = await import('../src/config.ts');
const hadKey = process.env.PINECONE_API_KEY;
delete process.env.PINECONE_API_KEY;
const hadIndex = (cfgMod.config as { pineconeIndex?: string }).pineconeIndex;
(cfgMod.config as { pineconeIndex?: string }).pineconeIndex = undefined;
registerAllTools(registry, makeConnection(), db);

const globalSession: SessionContext = { tier: 'global' };
const chatSession: SessionContext = { tier: 'chat-scoped' };
const boundSession: SessionContext = {
  tier: 'global',
  binding: { kind: 'conversation-bound', conversationKey: 'k@s.whatsapp.net', deliveryJid: 'k@s.whatsapp.net' } as never,
};

const g = registry.listTools(globalSession);
const c = registry.listTools(chatSession);
const b = registry.listTools(boundSession);

// Second pass: gate ON (memory_write registers) — a fresh registry.
process.env.PINECONE_API_KEY = hadKey ?? 'probe-dummy-key';
(cfgMod.config as { pineconeIndex?: string }).pineconeIndex = hadIndex ?? 'probe-index';
const registry2 = new ToolRegistry();
registerAllTools(registry2, makeConnection(), db);
const c2 = registry2.listTools(chatSession);
const b2 = registry2.listTools(boundSession);

console.log(JSON.stringify({
  gateOff: {
    global: g.length,
    chatScoped: c.length,
    conversationBound: b.length,
    memoryWrite: c.some((t) => t.name === 'memory_write'),
  },
  gateOn: {
    chatScoped: c2.length,
    conversationBound: b2.length,
    memoryWrite: c2.some((t) => t.name === 'memory_write'),
  },
  boundExtra: b2.map((t) => t.name).filter((n) => !c2.some((x) => x.name === n)),
}, null, 2));
if (hadKey === undefined) delete process.env.PINECONE_API_KEY;
(cfgMod.config as { pineconeIndex?: string }).pineconeIndex = hadIndex;
db.raw.close();
