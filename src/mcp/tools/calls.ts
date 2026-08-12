// src/mcp/tools/calls.ts
// Call tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { ExtendedBaileysSocket } from '../types.ts';
import { type SockToolConfig, registerSockTools } from './sock-tool-factory.ts';
import { EXTERNAL_EFFECT_CONTRACT_VERSION } from '../external-effect.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- configs have heterogeneous ZodRawShape types; shared array requires any; expires 2026-12-31
const callConfigs: SockToolConfig<any>[] = [
  {
    name: 'reject_call',
    description: 'Reject an incoming WhatsApp call by call ID and caller JID (global).',
    schema: z.object({
      call_id: z.string(),
      call_from: z.string(),
    }),
    replayPolicy: 'safe',
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'external' },
    call: async ({ call_id, call_from }, sock) => {
      await sock.rejectCall(call_id, call_from);
      return { success: true, callId: call_id, callFrom: call_from };
    },
  },
];

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerCallTools(
  getSock: () => ExtendedBaileysSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  registerSockTools(getSock, callConfigs, register);
}
