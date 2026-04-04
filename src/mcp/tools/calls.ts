// src/mcp/tools/calls.ts
// Call tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { ExtendedBaileysSocket } from '../types.ts';

// ---------------------------------------------------------------------------
// reject_call
// ---------------------------------------------------------------------------

const RejectCallSchema = z.object({
  call_id: z.string(),
  call_from: z.string(),
});

function makeRejectCall(getSock: () => ExtendedBaileysSocket | null): ToolDeclaration {
  return {
    name: 'reject_call',
    description: 'Reject an incoming WhatsApp call by call ID and caller JID (global).',
    schema: RejectCallSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { call_id, call_from } = RejectCallSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.rejectCall(call_id, call_from);
      return { success: true, callId: call_id, callFrom: call_from };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerCallTools(
  getSock: () => ExtendedBaileysSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  register(makeRejectCall(getSock));
}
