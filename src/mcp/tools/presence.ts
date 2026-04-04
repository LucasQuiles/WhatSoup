// src/mcp/tools/presence.ts
// Presence tools: subscribe_presence, get_presence (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { ExtendedBaileysSocket } from '../types.ts';
import type { PresenceCache } from '../../transport/presence-cache.ts';

// ---------------------------------------------------------------------------
// subscribe_presence
// ---------------------------------------------------------------------------

const SubscribePresenceSchema = z.object({
  jid: z.string(),
});

function makeSubscribePresence(getSock: () => ExtendedBaileysSocket | null): ToolDeclaration {
  return {
    name: 'subscribe_presence',
    description:
      'Subscribe to presence updates for a WhatsApp contact or group JID (global). After subscribing, presence status will be available via get_presence.',
    schema: SubscribePresenceSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid } = SubscribePresenceSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.presenceSubscribe(jid);
      return { success: true, jid };
    },
  };
}

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
      const { jid } = GetPresenceSchema.parse(params);

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
  register(makeSubscribePresence(getSock));
  register(makeGetPresence(presenceCache));
}
