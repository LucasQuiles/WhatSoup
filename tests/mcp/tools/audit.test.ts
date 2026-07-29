import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { createOutboundSendsWriter } from '../../../src/core/outbound-sends.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerOutboundAuditTools } from '../../../src/mcp/tools/audit.ts';
import type { SessionContext, ToolDeclaration } from '../../../src/mcp/types.ts';

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function chatSession(conversationKey: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid: `${conversationKey}@s.whatsapp.net` };
}

describe('outbound audit tools', () => {
  let db: Database;
  let registry: ToolRegistry;
  let capturedTools: ToolDeclaration[];

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    capturedTools = [];
    const register = registry.register.bind(registry);
    registry.register = (tool: ToolDeclaration) => {
      capturedTools.push(tool);
      register(tool);
    };
    registerOutboundAuditTools(registry, {
      writer: createOutboundSendsWriter({ db: db.raw, line: 'personal' }),
    });
  });

  afterEach(() => {
    db.close();
  });

  it('registers read_outbound_sends as a global read-only tool', () => {
    const globalTools = registry.listTools(globalSession());
    const chatTools = registry.listTools(chatSession('111'));

    expect(globalTools.find((tool) => tool.name === 'read_outbound_sends')).toBeDefined();
    expect(chatTools.find((tool) => tool.name === 'read_outbound_sends')).toBeUndefined();
    expect(capturedTools.find((tool) => tool.name === 'read_outbound_sends')).toMatchObject({
      scope: 'global',
      replayPolicy: 'read_only',
    });
    expect(capturedTools.find((tool) => tool.name === 'maintain_outbound_audit')).toMatchObject({
      scope: 'global',
      replayPolicy: 'unsafe',
      sensitive: true,
    });
  });

  it('returns bounded metadata-only outbound send rows', async () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const intent = writer.writeIntent({
      caller: 'mcp',
      targetKind: 'chatJid',
    });
    writer.markSuccess(intent.id);

    const result = await registry.call('read_outbound_sends', { limit: 10 }, globalSession());

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as {
      outbound_sends: Array<Record<string, unknown>>;
    };
    expect(body.outbound_sends).toHaveLength(1);
    expect(body.outbound_sends[0]).toMatchObject({
      id: intent.id,
      audit_receipt: intent.auditReceipt,
      caller: 'mcp',
      target_kind: 'chatJid',
      outcome_code: 'submitted',
    });
    expect(body.outbound_sends[0]).not.toHaveProperty('text');
    expect(body.outbound_sends[0]).not.toHaveProperty('chat_jid');
    expect(body.outbound_sends[0]).not.toHaveProperty('transport_id');
  });

  it('filters by exact opaque audit receipt', async () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const included = writer.writeIntent({
      caller: 'mcp',
      targetKind: 'chatJid',
    });
    writer.writeIntent({
      caller: 'health',
      targetKind: 'chatJid',
    });

    const result = await registry.call(
      'read_outbound_sends',
      { auditReceipt: included.auditReceipt },
      globalSession(),
    );
    const body = JSON.parse(result.content[0].text) as {
      outbound_sends: Array<{ audit_receipt: string }>;
    };

    expect(body.outbound_sends.map((row) => row.audit_receipt)).toEqual([included.auditReceipt]);
  });

  it('rejects unknown arguments instead of silently stripping them', async () => {
    const result = await registry.call(
      'read_outbound_sends',
      { text: '' },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid parameters/);
  });

  it('supports authorized preview and apply under one fixed retention policy', async () => {
    const maintenanceRegistry = new ToolRegistry();
    const writer = createOutboundSendsWriter({ db: db.raw });
    registerOutboundAuditTools(maintenanceRegistry, { writer });
    maintenanceRegistry.setSensitiveToolAuthorizer(() => true);
    const old = writer.writeIntent({ caller: 'mcp', targetKind: 'chatJid' });
    writer.markSuccess(old.id);
    db.raw.prepare(`
      UPDATE outbound_sends
      SET created_at = datetime('now', '-40 days'),
          completed_at = datetime('now', '-40 days')
      WHERE id = ?
    `).run(old.id);
    const session = { tier: 'global' as const, actorJid: 'operator@example.invalid' };

    const preview = await maintenanceRegistry.call(
      'maintain_outbound_audit',
      { dry_run: true },
      session,
    );
    expect(JSON.parse(preview.content[0].text)).toEqual({
      dry_run: true,
      retention_days: 30,
      eligible: 1,
      deleted: 0,
    });

    const apply = await maintenanceRegistry.call(
      'maintain_outbound_audit',
      { dry_run: false },
      session,
    );
    expect(JSON.parse(apply.content[0].text)).toEqual({
      dry_run: false,
      retention_days: 30,
      eligible: 1,
      deleted: 1,
    });
  });

  it('rejects caller-selected retention cutoffs', async () => {
    const maintenanceRegistry = new ToolRegistry();
    registerOutboundAuditTools(maintenanceRegistry, {
      writer: createOutboundSendsWriter({ db: db.raw }),
    });
    maintenanceRegistry.setSensitiveToolAuthorizer(() => true);

    const result = await maintenanceRegistry.call(
      'maintain_outbound_audit',
      { dry_run: true, terminalDays: 1, terminalMaxRows: 100 },
      { tier: 'global', actorJid: 'operator@example.invalid' },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid parameters/);
  });
});
