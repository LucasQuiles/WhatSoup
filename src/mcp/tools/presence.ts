// src/mcp/tools/presence.ts
// Presence tools: send_typing, subscribe_presence, get_presence.

import { z } from 'zod';
import { toolError, type ToolDeclaration } from '../types.ts';
import type { ExtendedBaileysSocket } from '../types.ts';
import type { PresenceCache } from '../../transport/presence-cache.ts';
import { type SockToolConfig, registerSockTools } from './sock-tool-factory.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- configs have heterogeneous ZodRawShape types; shared array requires any; expires 2026-12-31
const presenceSockConfigs: SockToolConfig<any>[] = [
  {
    name: 'send_typing',
    description:
      'Send a typing indicator to the current chat. Use composing, recording, or paused.',
    schema: z.object({
      chatJid: z.string(),
      type: z.enum(['composing', 'recording', 'paused']),
    }),
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    call: async ({ chatJid, type }, sock) => {
      await sock.sendPresenceUpdate(type, chatJid);
      return { success: true, type };
    },
  },
  {
    name: 'subscribe_presence',
    description:
      'Subscribe to presence updates for a WhatsApp contact or group JID (global). After subscribing, presence status will be available via get_presence.',
    schema: z.object({
      jid: z.string(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid }, sock) => {
      await sock.presenceSubscribe(jid);
      return { success: true, jid };
    },
  },
];

// ---------------------------------------------------------------------------
// get_presence
// ---------------------------------------------------------------------------

const GetPresenceSchema = z.object({
  jid: z.string(),
});

function makeGetPresence(presenceCache: PresenceCache): ToolDeclaration {
  return {
    name: 'get_presence',
    description:
      'Get the cached presence status for a WhatsApp contact JID (global). Returns null if no presence has been received yet.',
    schema: GetPresenceSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const parsed = GetPresenceSchema.safeParse(params);
      if (!parsed.success) {
        return toolError({ error: 'invalid_params', message: parsed.error.message });
      }
      const { jid } = parsed.data;

      const entry = presenceCache.get(jid);
      if (!entry) {
        return { jid, status: null, lastSeen: null, stale: null };
      }

      return {
        jid,
        status: entry.status,
        lastSeen: entry.lastSeen ?? null,
        stale: entry.stale,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerPresenceTools(
  getSock: () => ExtendedBaileysSocket | null,
  presenceCache: PresenceCache,
  register: (tool: ToolDeclaration) => void,
): void {
  registerSockTools(getSock, presenceSockConfigs, register);
  register(makeGetPresence(presenceCache));
}
