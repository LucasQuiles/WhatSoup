import { z } from 'zod';
import { DEFAULT_DATABASE_RETENTION } from '../../core/database-retention.ts';
import type { OutboundSendsWriter } from '../../core/outbound-sends.ts';
import type { ToolRegistry } from '../registry.ts';

export interface OutboundAuditDeps {
  writer: OutboundSendsWriter;
}

export function registerOutboundAuditTools(registry: ToolRegistry, deps: OutboundAuditDeps): void {
  registry.register({
    name: 'read_outbound_sends',
    description: 'Read recent metadata-only outbound send evidence, optionally by opaque audit receipt.',
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
      auditReceipt: z
        .string()
        .regex(/^[0-9a-f]{32}$/)
        .optional()
        .describe('Optional exact 32-character lowercase hexadecimal audit receipt.'),
    }).strict(),
    handler: async (params) => ({
      outbound_sends: deps.writer.listRecent({
        limit: params['limit'] as number | undefined,
        auditReceipt: params['auditReceipt'] as string | undefined,
      }),
    }),
  });

  registry.register({
    name: 'maintain_outbound_audit',
    description: 'Preview or apply bounded retention to terminal metadata-only outbound audit rows.',
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    sensitive: true,
    schema: z.object({
      dry_run: z.boolean(),
    }).strict(),
    handler: async (params) => {
      const dryRun = params['dry_run'] as boolean;
      const result = deps.writer.maintain({
        mode: dryRun ? 'preview' : 'apply',
        terminalDays: DEFAULT_DATABASE_RETENTION.outboundSendDays,
        terminalMaxRows: DEFAULT_DATABASE_RETENTION.outboundSendMaxRows,
      });
      return {
        dry_run: dryRun,
        retention_days: DEFAULT_DATABASE_RETENTION.outboundSendDays,
        eligible: result.eligibleRows,
        deleted: result.deletedRows,
      };
    },
  });
}
