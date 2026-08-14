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
      db,
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

// #2567 slice 2 — redacted fact-export queue operator reader. Counts, ages,
// attempt distribution, and opaque per-row fields ONLY: fact text, payload
// JSON, chat/sender JIDs, and the legacy fact_id never cross the wire.
describe('list_fact_export_queue (redacted operator reader)', () => {
  let db: Database;
  let registry: ToolRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    registerOutboundAuditTools(registry, {
      writer: createOutboundSendsWriter({ db: db.raw, line: 'personal' }),
      db,
    });
  });

  afterEach(() => {
    db.close();
  });

  function seed(factId: string, state: string, extra: Record<string, unknown> = {}): void {
    const cols = ['fact_uid', 'fact_id', 'chat_jid', 'sender_jid', 'payload_json', 'state', ...Object.keys(extra)];
    const vals = [
      `fe_${factId.replace(/[^a-z0-9]/gi, '').padEnd(24, '0').slice(0, 24)}`,
      factId, 'SECRET-CHAT@g.us', 'SECRET-SENDER@s.whatsapp.net',
      '{"text":"SECRET-FACT-TEXT"}', state, ...Object.values(extra),
    ];
    db.raw.prepare(
      `INSERT INTO fact_export_queue (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ).run(...(vals as never[]));
  }

  it('registers as a global read-only tool, absent from chat scope', () => {
    expect(registry.listTools({ tier: 'global' }).find((t) => t.name === 'list_fact_export_queue')).toBeDefined();
    expect(
      registry.listTools({ tier: 'chat-scoped', conversationKey: '111', deliveryJid: '111@s.whatsapp.net' })
        .find((t) => t.name === 'list_fact_export_queue'),
    ).toBeUndefined();
  });

  it('returns summary counts, ages, attempt distribution, and redacted rows only', async () => {
    seed('SECRET-ID-1', 'pending');
    seed('SECRET-ID-2', 'leased', { lease_owner: 'SECRET-WORKER', lease_expires_at: 9999999999, attempt_count: 2 });
    seed('SECRET-ID-3', 'quarantined', { failure_code: 'payload_invalid', failure_stage: 'claim_validate' });
    seed('SECRET-ID-4', 'retry_wait', { attempt_count: 3, next_attempt_at: 9999999999, failure_code: 'remote_unavailable' });

    const result = await registry.call('list_fact_export_queue', {}, { tier: 'global' });
    expect(result.isError).toBeUndefined();
    const raw = result.content[0].text;
    const body = JSON.parse(raw) as {
      summary: {
        counts: Record<string, number>;
        oldest_pending_age_s: number;
        latest_ack_age_s: number | null;
        attempt_histogram: Record<string, number>;
      };
      rows: Array<Record<string, unknown>>;
    };
    expect(body.summary.counts).toMatchObject({ pending: 1, leased: 1, quarantined: 1, retry_wait: 1 });
    expect(body.summary.attempt_histogram).toMatchObject({ '2': 1, '3': 1 });
    expect(body.rows).toHaveLength(4);
    for (const row of body.rows) {
      expect(row.fact_uid).toMatch(/^fe_/);
      expect(row).not.toHaveProperty('fact_id');
      expect(row).not.toHaveProperty('chat_jid');
      expect(row).not.toHaveProperty('sender_jid');
      expect(row).not.toHaveProperty('payload_json');
      expect(row).not.toHaveProperty('lease_owner');
    }
    // Exact-byte discipline over the whole wire payload.
    expect(raw).not.toContain('SECRET-ID');
    expect(raw).not.toContain('SECRET-CHAT');
    expect(raw).not.toContain('SECRET-SENDER');
    expect(raw).not.toContain('SECRET-FACT-TEXT');
    expect(raw).not.toContain('SECRET-WORKER');
  });

  it('filters by state and clamps the row limit', async () => {
    for (let i = 0; i < 5; i++) seed(`bulk-${i}`, 'pending');
    seed('quar-1', 'quarantined', { failure_code: 'payload_invalid' });

    const result = await registry.call('list_fact_export_queue', { state: 'pending', limit: 2 }, { tier: 'global' });
    const body = JSON.parse(result.content[0].text) as { summary: { counts: Record<string, number> }; rows: Array<{ state: string }> };
    expect(body.rows).toHaveLength(2);
    expect(body.rows.every((r) => r.state === 'pending')).toBe(true);
    // Summary always covers the WHOLE queue regardless of the row filter.
    expect(body.summary.counts).toMatchObject({ pending: 5, quarantined: 1 });
  });
});
