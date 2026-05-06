import { z } from 'zod';
import type { OutboundSendsWriter } from '../../core/outbound-sends.ts';
import type { ToolRegistry } from '../registry.ts';

export interface OutboundAuditDeps {
  writer: OutboundSendsWriter;
}

export function registerOutboundAuditTools(registry: ToolRegistry, deps: OutboundAuditDeps): void {
  registry.register({
    name: 'read_outbound_sends',
    description: 'Read recent outbound send audit rows for this WhatsApp instance without returning message text.',
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    schema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Maximum rows to return. Defaults to 50 and clamps to 100.'),
      chatJid: z
        .string()
        .min(1)
        .optional()
        .describe('Optional raw chat JID filter. Aliases are not resolved on reads.'),
    }).strict(),
    handler: async (params) => ({
      outbound_sends: deps.writer.listRecent({
        limit: params['limit'] as number | undefined,
        chatJid: params['chatJid'] as string | undefined,
      }),
    }),
  });
}
