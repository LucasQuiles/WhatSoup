import { z } from 'zod';
import { DEFAULT_DATABASE_RETENTION } from '../../core/database-retention.ts';
import type { Database } from '../../core/database.ts';
import type { OutboundSendsWriter } from '../../core/outbound-sends.ts';
import { listFactExportQueueRedacted } from '../../core/fact-export-read.ts';
import type { ToolRegistry } from '../registry.ts';
import { EXTERNAL_EFFECT_CONTRACT_VERSION } from '../external-effect.ts';

export interface OutboundAuditDeps {
  writer: OutboundSendsWriter;
  /** Needed by list_fact_export_queue; the tool is skipped when absent. */
  db?: Database;
}

export function registerOutboundAuditTools(registry: ToolRegistry, deps: OutboundAuditDeps): void {
  registry.register({
    name: 'read_outbound_sends',
    description: 'Read recent metadata-only outbound send evidence, optionally by opaque audit receipt.',
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'none' },
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
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'external' },
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

  const db = deps.db;
  if (db) {
    registry.register({
      name: 'list_fact_export_queue',
      description:
        'Redacted fact-export queue evidence (#2567): summary counts by state, oldest-pending and '
        + 'latest-ack ages, attempt distribution, and bounded per-row records keyed by the opaque '
        + 'fact_uid. Fact text, payload JSON, chat/sender identities, the legacy fact_id, and lease '
        + 'owners never cross this projection.',
      scope: 'global',
      targetMode: 'caller-supplied',
      replayPolicy: 'read_only',
      externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'none' },
      schema: z.object({
        state: z.enum(['pending', 'leased', 'retry_wait', 'exported', 'quarantined', 'retry_exhausted', 'legacy_unclassified']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }).strict(),
      handler: async (params) => listFactExportQueueRedacted(db, {
        state: params['state'] as string | undefined,
        limit: params['limit'] as number | undefined,
      }),
    });
  }
}
