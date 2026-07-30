import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  InvalidSendRequestError,
  MissingTextError,
  createSendPipeline,
  prepareTextSend,
  type PreparedTextSend,
} from '../../src/core/send-pipeline.ts';
import {
  MissingTargetError,
  MutuallyExclusiveError,
  type ChatResolver,
} from '../../src/core/chats-resolver.ts';
import { createProfileRegistry, UnknownProfileError } from '../../src/core/profiles.ts';

const chatResolver: ChatResolver = {
  resolve(target): string {
    if (
      typeof target.chatJid === 'string' &&
      target.chatJid.trim().length > 0 &&
      typeof target.to === 'string' &&
      target.to.trim().length > 0
    ) {
      throw new MutuallyExclusiveError();
    }
    if (typeof target.chatJid === 'string' && target.chatJid.trim().length > 0) {
      return target.chatJid;
    }
    if (target.to === 'ops') {
      return 'ops-chat@s.whatsapp.net';
    }
    throw new MissingTargetError();
  },
};

describe('executeSend outbound audit lifecycle', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('records one sent audit row when transport succeeds', async () => {
    const { createOutboundSendsWriter } = await import('../../src/core/outbound-sends.ts');
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const pipeline = createSendPipeline({
      resolver: chatResolver,
      auditWriter: writer,
      caller: 'mcp',
    });

    const result = await pipeline.executeSend(
      { to: 'ops', text: 'hello audit' },
      async () => ({ transportId: 'wamid.success' }),
    );

    expect(result).toEqual({ transportId: 'wamid.success' });
    const rows = db.raw
      .prepare(`
        SELECT caller, target_kind, outcome_code, failure_code,
               failure_stage, mutation_state, provider_submission_count
        FROM outbound_sends
      `)
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([{
      caller: 'mcp',
      target_kind: 'alias',
      outcome_code: 'submitted',
      failure_code: null,
      failure_stage: 'ack_received',
      mutation_state: 'acknowledged',
      provider_submission_count: 1,
    }]);
  });

  it('records one failed audit row and rethrows when transport throws', async () => {
    const { createOutboundSendsWriter } = await import('../../src/core/outbound-sends.ts');
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const pipeline = createSendPipeline({
      resolver: chatResolver,
      auditWriter: writer,
      caller: 'health',
    });

    await expect(pipeline.executeSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'will fail' },
      async () => {
        throw new Error('socket closed');
      },
    )).rejects.toThrow('socket closed');

    const rows = db.raw
      .prepare(`
        SELECT caller, target_kind, outcome_code, failure_code,
               failure_stage, mutation_state, evidence_coverage
        FROM outbound_sends
      `)
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([{
      caller: 'health',
      target_kind: 'chatJid',
      outcome_code: 'ambiguous',
      failure_code: 'unknown',
      failure_stage: 'unknown',
      mutation_state: 'unknown',
      evidence_coverage: 'untyped',
    }]);
  });

  it('does not audit preparation failures because no send intent exists', async () => {
    const { createOutboundSendsWriter } = await import('../../src/core/outbound-sends.ts');
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const pipeline = createSendPipeline({
      resolver: chatResolver,
      auditWriter: writer,
      caller: 'mcp',
    });
    const transport = vi.fn(async () => ({ transportId: 'wamid.unused' }));

    await expect(pipeline.executeSend({ text: 'missing target' }, transport))
      .rejects.toThrow(MissingTargetError);

    const row = db.raw.prepare('SELECT COUNT(*) AS count FROM outbound_sends').get() as { count: number };
    expect(row.count).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it('throws when an audit writer is configured without a caller', async () => {
    const { createOutboundSendsWriter } = await import('../../src/core/outbound-sends.ts');
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const pipeline = createSendPipeline({ resolver: chatResolver, auditWriter: writer }); // no caller

    await expect(pipeline.executeSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'hi' },
      async () => ({ transportId: 'wamid.x' }),
    )).rejects.toThrow(/caller is required/i);
  });

  it('records submitted without persisting a provider transport id', async () => {
    const { createOutboundSendsWriter } = await import('../../src/core/outbound-sends.ts');
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const pipeline = createSendPipeline({ resolver: chatResolver, auditWriter: writer, caller: 'mcp' });

    const result = await pipeline.executeSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'hi' },
      async () => ({}), // no transportId → extractTransportId returns null
    );

    expect(result).toEqual({});
    const row = db.raw
      .prepare('SELECT outcome_code, provider_submission_count FROM outbound_sends')
      .get() as Record<string, unknown>;
    expect(row).toEqual({ outcome_code: 'submitted', provider_submission_count: 1 });
  });

  it('executes without auditing when no audit writer is configured', async () => {
    const pipeline = createSendPipeline({ resolver: chatResolver }); // no auditWriter → skip audit

    const ok = await pipeline.executeSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'hi' },
      async () => ({ transportId: 'wamid.noaudit' }),
    );
    expect(ok).toEqual({ transportId: 'wamid.noaudit' });

    // A throwing transport still rethrows even though there is no audit row to mark failed.
    await expect(pipeline.executeSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'boom' },
      async () => { throw new Error('down'); },
    )).rejects.toThrow('down');
  });

  it('records a non-Error transport failure via String(err)', async () => {
    const { createOutboundSendsWriter } = await import('../../src/core/outbound-sends.ts');
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const pipeline = createSendPipeline({ resolver: chatResolver, auditWriter: writer, caller: 'mcp' });

    await expect(pipeline.executeSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'x' },
      async () => { throw 'string failure'; },
    )).rejects.toBe('string failure');

    const row = db.raw
      .prepare('SELECT outcome_code, failure_code, evidence_coverage FROM outbound_sends')
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      outcome_code: 'ambiguous',
      failure_code: 'unknown',
      evidence_coverage: 'untyped',
    });
  });

  it('exposes the audit receipt before entering transport', async () => {
    const { createOutboundSendsWriter } = await import('../../src/core/outbound-sends.ts');
    const writer = createOutboundSendsWriter({ db: db.raw });
    const pipeline = createSendPipeline({ resolver: chatResolver, auditWriter: writer, caller: 'mcp' });
    let observedReceipt: string | undefined;
    let receiptDuringTransport: string | undefined;

    await pipeline.executeSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'receipt' },
      async () => {
        receiptDuringTransport = observedReceipt;
        return {};
      },
      { onAuditReceipt: (receipt) => { observedReceipt = receipt; } },
    );

    expect(observedReceipt).toMatch(/^[0-9a-f]{32}$/);
    expect(receiptDuringTransport).toBe(observedReceipt);
  });
});

describe('executeSend transformPrepared seam', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  const toSafe = (p: PreparedTextSend): PreparedTextSend => ({
    ...p,
    text: 'SAFE',
    audit: { ...p.audit, textLength: 'SAFE'.length },
  });

  it('applies transformPrepared after preparation and before transport', async () => {
    const pipeline = createSendPipeline({ resolver: chatResolver });
    let transportText = '';
    await pipeline.executeSend(
      { to: 'ops', text: 'RAW LEAKY ORIGINAL' },
      async (prepared) => {
        transportText = prepared.text;
        return { transportId: 'x' };
      },
      { transformPrepared: toSafe },
    );
    expect(transportText).toBe('SAFE');
  });

  it('lets beforeAudit observe the transformed prepared value', async () => {
    const pipeline = createSendPipeline({ resolver: chatResolver });
    let seen = '';
    await pipeline.executeSend(
      { to: 'ops', text: 'RAW' },
      async () => ({ transportId: 'x' }),
      {
        transformPrepared: toSafe,
        beforeAudit: (prepared) => {
          seen = prepared.text;
        },
      },
    );
    expect(seen).toBe('SAFE');
  });

  it('does not persist either transformed or original text evidence', async () => {
    const { createOutboundSendsWriter } = await import('../../src/core/outbound-sends.ts');
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const pipeline = createSendPipeline({ resolver: chatResolver, auditWriter: writer, caller: 'mcp' });

    await pipeline.executeSend(
      { to: 'ops', text: 'leaky original text' },
      async () => ({ transportId: 'wamid.x' }),
      { transformPrepared: toSafe },
    );

    const row = db.raw.prepare('SELECT * FROM outbound_sends').get() as Record<string, unknown>;
    expect(row.outcome_code).toBe('submitted');
    expect(JSON.stringify(row)).not.toContain('SAFE');
    expect(JSON.stringify(row)).not.toContain('leaky original text');
  });

  it('awaits an async transformPrepared', async () => {
    const pipeline = createSendPipeline({ resolver: chatResolver });
    let transportText = '';
    await pipeline.executeSend(
      { to: 'ops', text: 'RAW' },
      async (prepared) => {
        transportText = prepared.text;
        return { transportId: 'x' };
      },
      { transformPrepared: async (p) => toSafe(p) },
    );
    expect(transportText).toBe('SAFE');
  });

  it('sends the original prepared text when no transform is provided', async () => {
    const pipeline = createSendPipeline({ resolver: chatResolver });
    let transportText = '';
    await pipeline.executeSend(
      { to: 'ops', text: 'UNTOUCHED' },
      async (prepared) => {
        transportText = prepared.text;
        return { transportId: 'x' };
      },
    );
    expect(transportText).toBe('UNTOUCHED');
  });
});

describe('prepareTextSend', () => {
  it('prepares raw chat JID sends with default link preview behavior', () => {
    const prepared = prepareTextSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'hi' },
      { chatResolver },
    );

    expect(prepared).toEqual({
      chatJid: 'raw-chat@s.whatsapp.net',
      text: 'hi',
      linkPreviewMode: 'auto',
      audit: {
        targetKind: 'chatJid',
        textLength: 2,
      },
    });
  });

  it('prepares alias sends and preserves link preview opt-out', () => {
    const prepared = prepareTextSend(
      { to: 'ops', text: 'hello ops', link_preview: 'off' },
      { chatResolver },
    );

    expect(prepared).toEqual({
      chatJid: 'ops-chat@s.whatsapp.net',
      text: 'hello ops',
      linkPreviewMode: 'off',
      audit: {
        targetKind: 'alias',
        alias: 'ops',
        textLength: 9,
      },
    });
  });

  it('throws typed errors for invalid request shape and missing text', () => {
    expect(() => prepareTextSend(null, { chatResolver })).toThrow(InvalidSendRequestError);
    expect(() => prepareTextSend({ chatJid: 'raw-chat@s.whatsapp.net' }, { chatResolver }))
      .toThrow(MissingTextError);
  });

  it('rejects invalid link preview modes before resolving the target', () => {
    expect(() => prepareTextSend(
      { to: 'missing', text: 'hi', link_preview: 'full' },
      { chatResolver },
    )).toThrow('link_preview must be "auto" or "off"');
  });

  it('creates a reusable pipeline with the resolver bound once', () => {
    const pipeline = createSendPipeline({ resolver: chatResolver });

    expect(pipeline.prepareSend({ to: 'ops', text: 'hi' })).toMatchObject({
      chatJid: 'ops-chat@s.whatsapp.net',
      text: 'hi',
      linkPreviewMode: 'auto',
    });
  });

  it('rejects unknown profiles before preparing a send', () => {
    expect(() => prepareTextSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'hi', profile: 'missing' },
      { chatResolver, profiles: createProfileRegistry({}) },
    )).toThrow(UnknownProfileError);
  });

  it('rejects an empty-string profile as an invalid request', () => {
    expect(() => prepareTextSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'hi', profile: '   ' },
      { chatResolver },
    )).toThrow(/profile must be a non-empty string/i);
  });

  it('preserves current send preparation when no profile is requested', () => {
    const prepared = prepareTextSend(
      { to: 'ops', text: 'hi' },
      { chatResolver, profiles: createProfileRegistry({ satellite: { prefix: '[SAT] ' } }) },
    );

    expect(prepared).toEqual({
      chatJid: 'ops-chat@s.whatsapp.net',
      text: 'hi',
      linkPreviewMode: 'auto',
      audit: {
        targetKind: 'alias',
        alias: 'ops',
        textLength: 2,
      },
    });
  });

  it('creates a reusable pipeline with resolver and profile registry bound once', () => {
    const pipeline = createSendPipeline({
      resolver: chatResolver,
      profiles: createProfileRegistry({
        satellite: { prefix: '[SAT] ', tag: ' #satellite', linkPreview: 'off' },
      }),
    });

    expect(pipeline.prepareSend({ to: 'ops', text: 'hi', profile: 'satellite' })).toEqual({
      chatJid: 'ops-chat@s.whatsapp.net',
      text: '[SAT] hi #satellite',
      linkPreviewMode: 'off',
      audit: {
        targetKind: 'alias',
        alias: 'ops',
        profile: 'satellite',
        textLength: 19,
      },
    });
  });

  it('lets request link_preview override profile linkPreview', () => {
    const pipeline = createSendPipeline({
      resolver: chatResolver,
      profiles: createProfileRegistry({
        satellite: { prefix: '[SAT] ', linkPreview: 'off' },
      }),
    });

    expect(pipeline.prepareSend({
      to: 'ops',
      text: 'https://example.com',
      profile: 'satellite',
      link_preview: 'auto',
    })).toMatchObject({
      text: '[SAT] https://example.com',
      linkPreviewMode: 'auto',
    });
  });
});
