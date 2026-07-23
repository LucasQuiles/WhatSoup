import { describe, expect, it } from 'vitest';

import {
  createProviderDataBoundary,
  type ProviderBoundaryEvent,
  type ProviderBoundaryMcpTool,
} from '../../src/core/provider-data-boundary.ts';
import {
  MAX_TOOL_NODES,
  scanProviderTextSequence,
} from '../../src/core/provider-data-boundary-detection.ts';
import { PROVIDER_DATA_POLICY_VERSION } from '../../src/core/provider-data-policy.ts';
import {
  containsProviderSecretValue,
  sanitizeProviderSecrets,
} from '../../src/lib/provider-preview-sanitizer.ts';

function entropy(): (size: number) => Uint8Array {
  let call = 0;
  return (size) => {
    call += 1;
    return Uint8Array.from({ length: size }, (_, index) => (call * 31 + index) % 256);
  };
}

function boundary(events: ProviderBoundaryEvent[] = []) {
  return createProviderDataBoundary({
    binding: {
      provider: 'openai-api',
      model: 'gpt-test',
      dataPolicy: 'restricted',
      policyVersion: PROVIDER_DATA_POLICY_VERSION,
      providerSessionId: 'hardening-session',
    },
    mode: 'enforce',
    routeSource: 'configured',
    entropy: entropy(),
    technicalIdentifiers: ['lab-node'],
    eventSink: (event) => events.push(event),
  });
}

function tool(
  name: string,
  properties: Record<string, Record<string, unknown>>,
): ProviderBoundaryMcpTool {
  return {
    name,
    inputSchema: {
      type: 'object',
      properties,
      additionalProperties: false,
    },
  };
}

function aliasFrom(value: string): string {
  const alias = value.match(/⟦WSA1:[a-z_]+:[0-9a-f]{32}:[0-9a-f]{32}⟧/u)?.[0];
  if (!alias) throw new Error('expected provider alias');
  return alias;
}

describe('provider data boundary hardening', () => {
  it.each([
    ['early keyed', ['credential=alpha', 'ordinary']],
    ['late keyed', ['leading', 'credential=alpha', 'ordinary']],
    ['early Bearer', ['Bearer alpha', 'ordinary']],
    ['late Bearer', ['leading', 'Bearer alpha', 'ordinary']],
    ['early known token', [`ghp_${'a'.repeat(16)}`, 'ordinary']],
    ['late known token', ['leading', `ghp_${'a'.repeat(16)}`, 'ordinary']],
  ])('counts one direct %s secret followed by a benign field exactly once', (_label, texts) => {
    const scan = scanProviderTextSequence(texts);
    const events: ProviderBoundaryEvent[] = [];
    const broker = boundary(events);

    expect(scan).toMatchObject({
      directSecretCount: 1,
      fragmentedSecret: false,
    });
    expect(() => broker.exposeTexts(texts, { surface: 'history' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'secret_block',
      secretCount: 1,
    });
  });

  it.each([
    [
      'keyed direct plus an early two-field keyed fragment',
      ['credential=alpha ', 'cred', 'ential=beta'],
    ],
    [
      'Bearer direct plus a late three-field Bearer fragment',
      ['Bearer alpha ', 'ordinary', 'Bea', 'rer ', 'beta'],
    ],
    [
      'known-token direct plus a late two-field known-token fragment',
      [`ghp_${'a'.repeat(16)} `, 'ordinary', 'ghp_', 'b'.repeat(16)],
    ],
  ])('counts %s as one direct and one fragmented secret', (_label, texts) => {
    const scan = scanProviderTextSequence(texts);
    const events: ProviderBoundaryEvent[] = [];
    const broker = boundary(events);

    expect(scan).toMatchObject({
      directSecretCount: 1,
      fragmentedSecret: true,
    });
    expect(() => broker.exposeTexts(texts, { surface: 'history' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(events[0]).toMatchObject({
      eventType: 'secret_block',
      secretCount: 2,
    });
  });

  it.each([
    ['embedded GitHub token prefix', 'ordinaryghp_', 'a'.repeat(16)],
    ['embedded OpenAI token prefix', 'ordinarysk-', 'a'.repeat(16)],
  ])('keeps %s canonical-negative across fields', (_label, left, right) => {
    const combined = left + right;
    const scan = scanProviderTextSequence([left, right]);
    const broker = boundary();
    const record = { [left]: right };
    const tools: ProviderBoundaryMcpTool[] = [{
      name: 'inspect',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
      },
    }];

    expect(containsProviderSecretValue(combined)).toBe(false);
    expect(sanitizeProviderSecrets(combined)).toBe(combined);
    expect(scan).toMatchObject({
      directSecretCount: 0,
      fragmentedSecret: false,
    });
    expect(broker.rehydrateToolInput('inspect', record, tools)).toEqual(record);
  });

  it.each([
    ['early two-field Bearer', ['Bear', 'er alpha']],
    ['late three-field Bearer', ['ordinary', 'values', 'Bea', 'rer ', 'alpha']],
    ['early two-field known token', ['ghp_', 'a'.repeat(16)]],
    ['late three-field known token', ['ordinary', 'values', 'gh', 'p_', 'a'.repeat(16)]],
  ])('detects genuine %s fragments', (_label, texts) => {
    expect(scanProviderTextSequence(texts)).toMatchObject({
      directSecretCount: 0,
      fragmentedSecret: true,
    });
  });

  it('keeps global secret regex state stable across repeated direct and boundary scans', () => {
    const token = `ghp_${'a'.repeat(16)}`;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      expect(containsProviderSecretValue(token)).toBe(true);
      expect(scanProviderTextSequence(['ghp_', 'a'.repeat(16)])).toMatchObject({
        directSecretCount: 0,
        fragmentedSecret: true,
      });
      expect(scanProviderTextSequence([token, 'ordinary'])).toMatchObject({
        directSecretCount: 1,
        fragmentedSecret: false,
      });
    }
  });

  it.each([
    [
      'relaxed keyed negative before split password',
      ['ordinarycredential=alpha', 'pass', 'word=beta'],
      0,
      'ordinarycredential=alpha',
    ],
    [
      'relaxed keyed negative before split token',
      ['ordinarycredential=alpha', 'to', 'ken=beta'],
      0,
      'ordinarycredential=alpha',
    ],
    [
      'relaxed keyed negative before split quoted password',
      ['ordinarycredential=alpha', 'pass', 'word="quoted value"'],
      0,
      'ordinarycredential=alpha',
    ],
    [
      'direct keyed secret before split password',
      ['credential=alpha', 'pass', 'word=beta'],
      1,
      'credential=[REDACTED]',
    ],
    [
      'direct keyed secret before split token',
      ['credential=alpha', 'to', 'ken=beta'],
      1,
      'credential=[REDACTED]',
    ],
    [
      'direct keyed secret before split quoted password',
      ['credential=alpha', 'pass', 'word="quoted value"'],
      1,
      'credential=[REDACTED]',
    ],
  ] as const)('does not let an earlier keyed candidate shadow a %s', (
    _label,
    texts,
    directSecretCount,
    sanitizedEarlier,
  ) => {
    const earlier = texts[0];
    const scan = scanProviderTextSequence(texts);
    const events: ProviderBoundaryEvent[] = [];

    expect(containsProviderSecretValue(earlier)).toBe(directSecretCount === 1);
    expect(sanitizeProviderSecrets(earlier)).toBe(sanitizedEarlier);
    expect(scan).toMatchObject({
      directSecretCount,
      fragmentedSecret: true,
    });
    expect(() => boundary(events).exposeTexts(texts, { surface: 'history' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'secret_block',
      secretCount: directSecretCount + 1,
    });
    expect(() => boundary().rehydrateToolInput('inspect', { metadata: texts }, [{
      name: 'inspect',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
      },
    }])).toThrowError(expect.objectContaining({ code: 'secret_detected' }));
  });

  it.each([
    [
      'embedded known-token negative before a field-start token',
      [`ordinaryghp_${'x'.repeat(16)}`, 'ghp_', 'y'.repeat(16)],
      0,
      `ordinaryghp_${'x'.repeat(16)}`,
    ],
    [
      'direct known token before a distinct field-start token',
      [`ghp_${'x'.repeat(16)}`, 'ghp_', 'y'.repeat(16)],
      1,
      '[REDACTED_TOKEN]',
    ],
  ] as const)('does not let an earlier known-token candidate shadow a %s', (
    _label,
    texts,
    directSecretCount,
    sanitizedEarlier,
  ) => {
    const earlier = texts[0];
    const scan = scanProviderTextSequence(texts);
    const events: ProviderBoundaryEvent[] = [];

    expect(containsProviderSecretValue(earlier)).toBe(directSecretCount === 1);
    expect(sanitizeProviderSecrets(earlier)).toBe(sanitizedEarlier);
    expect(scan).toMatchObject({
      directSecretCount,
      fragmentedSecret: true,
    });
    expect(() => boundary(events).exposeTexts(texts, { surface: 'history' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'secret_block',
      secretCount: directSecretCount + 1,
    });
    expect(() => boundary().rehydrateToolInput('inspect', { metadata: texts }, [{
      name: 'inspect',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
      },
    }])).toThrowError(expect.objectContaining({ code: 'secret_detected' }));
  });

  it('bounds detector invocations for a maximum-node provider tool record', () => {
    expect(scanProviderTextSequence(['first', 'second']).detectorInvocationCount)
      .toBeLessThanOrEqual(8);
    const entries = Array.from(
      { length: MAX_TOOL_NODES - 1 },
      (_, index) => [`field_${index}`, `ordinary_${index}`] as const,
    );
    const record = Object.fromEntries(entries);
    const orderedTexts = entries.flatMap(([key, value]) => [key, value]);
    const scan = scanProviderTextSequence(orderedTexts);
    const broker = boundary();
    const tools: ProviderBoundaryMcpTool[] = [{
      name: 'inspect',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
      },
    }];

    expect(scan.detectorInvocationCount).toBeLessThanOrEqual(orderedTexts.length * 4);
    expect(JSON.stringify(record).length).toBeLessThan(1024 * 1024);
    expect(() => broker.inspectToolJson(JSON.stringify(record))).not.toThrow();
    expect(broker.rehydrateToolInput('inspect', record, tools)).toEqual(record);
  });

  it.each([
    ['early two-field secret', ['cred', 'ential="quoted multiword value"'], 'secret_detected'],
    ['late two-field secret', ['ordinary', 'values', 'cred', 'ential="quoted multiword value"'], 'secret_detected'],
    ['early three-field secret', ['cre', 'den', 'tial="quoted multiword value"'], 'secret_detected'],
    ['late three-field secret', ['ordinary', 'values', 'cre', 'den', 'tial="quoted multiword value"'], 'secret_detected'],
    ['early two-field alias', ['⟦W', `SA1:path:${'1'.repeat(32)}:${'2'.repeat(32)}⟧`], 'residual_alias'],
    ['late two-field alias', ['ordinary', 'values', '⟦W', `SA1:path:${'1'.repeat(32)}:${'2'.repeat(32)}⟧`], 'residual_alias'],
    ['early three-field alias', ['⟦', 'W', `SA1:path:${'1'.repeat(32)}:${'2'.repeat(32)}⟧`], 'residual_alias'],
    ['late three-field alias', ['ordinary', 'values', '⟦', 'W', `SA1:path:${'1'.repeat(32)}:${'2'.repeat(32)}⟧`], 'residual_alias'],
  ])('rejects %s fragments in provider tool arrays', (_label, fragments, code) => {
    const broker = boundary();
    const tools: ProviderBoundaryMcpTool[] = [{
      name: 'inspect',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
      },
    }];

    expect(() => broker.rehydrateToolInput('inspect', { metadata: fragments }, tools))
      .toThrowError(expect.objectContaining({ code }));
  });

  it('detects a late fragmented alias even when the carry contains a complete direct alias', () => {
    const directAlias = `⟦WSA1:path:${'a'.repeat(32)}:${'b'.repeat(32)}⟧`;
    const fragments = [
      directAlias,
      'ordinary',
      '⟦',
      'W',
      `SA1:path:${'1'.repeat(32)}:${'2'.repeat(32)}⟧`,
    ];
    const scan = scanProviderTextSequence(fragments);

    expect(scan.directAlias).toBe(true);
    expect(scan.fragmentedAlias).toBe(true);
  });

  it.each([
    [
      'secret assignment',
      { cred: 'ential="quoted multiword value"' },
      'secret_detected',
    ],
    [
      'multi-fragment secret assignment',
      { meta: 'data', cred: 'ential="quoted multiword value"' },
      'secret_detected',
    ],
    [
      'reserved alias syntax',
      { 'prefix ⟦W': `SA1:path:${'1'.repeat(32)}:${'2'.repeat(32)}⟧` },
      'residual_alias',
    ],
  ] as const)('rejects %s split across deterministic object keys and string values', (
    _label,
    metadata,
    code,
  ) => {
    const broker = boundary();
    const tools = [tool('configure', {
      metadata: { type: 'object', additionalProperties: {} },
    })];

    expect(() => broker.rehydrateToolInput('configure', { metadata }, tools))
      .toThrowError(expect.objectContaining({ code }));
  });

  it('binds JSON tool-result aliases to the authenticated originating tool and field', () => {
    const broker = boundary();
    const rawJid = '15551234567@s.whatsapp.net';
    const exposed = broker.exposeToolResult(
      'send_group_invite',
      JSON.stringify({ chatJid: rawJid }),
    );
    const alias = aliasFrom(exposed);
    const tools = [
      tool('send_group_invite', {
        chatJid: { type: 'string' },
        groupJid: { type: 'string' },
      }),
      tool('reply_message', {
        chatJid: { type: 'string' },
      }),
    ];

    expect(broker.rehydrateToolInput('send_group_invite', { chatJid: alias }, tools))
      .toEqual({ chatJid: rawJid });
    expect(() => broker.rehydrateToolInput('send_group_invite', { groupJid: alias }, tools))
      .toThrowError(expect.objectContaining({ code: 'invalid_alias' }));
    expect(() => broker.rehydrateToolInput('reply_message', { chatJid: alias }, tools))
      .toThrowError(expect.objectContaining({ code: 'invalid_alias' }));
  });

  it('allows general prompt aliases only through explicitly authorized destinations', () => {
    const broker = boundary();
    const rawJid = '15551234567@s.whatsapp.net';
    const alias = broker.exposeText(rawJid, { surface: 'prompt' });
    const tools = [tool('reply_message', {
      chatJid: { type: 'string' },
      text: { type: 'string' },
    })];

    expect(broker.rehydrateToolInput('reply_message', { chatJid: alias }, tools))
      .toEqual({ chatJid: rawJid });
    expect(() => broker.rehydrateToolInput('reply_message', { text: alias }, tools))
      .toThrowError(expect.objectContaining({ code: 'unauthorized_field' }));
  });

  it.each([
    ['/tmp', 'path'],
    ['C:\\Users\\q\\WhatSoup\\bot.db', 'path'],
    ['\\\\fileserver\\share\\bot.db', 'path'],
    ['2001:db8::7', 'network_identity'],
    ['node.example.technology', 'network_identity'],
    ['lab-node', 'technical_identifier'],
  ] as const)('aliases and exactly rehydrates operational identifier %s as %s', (raw, type) => {
    const broker = boundary();

    const exposed = broker.exposeText(`target=${raw}`, { surface: 'prompt' });

    expect(exposed).not.toContain(raw);
    expect(exposed).toContain(`⟦WSA1:${type}:`);
    expect(broker.rehydrateProviderText(exposed, { surface: 'provider_output' }))
      .toBe(`target=${raw}`);
  });

  it.each([
    'ratio 1/2 remains ordinary',
    'version v1/v2 remains ordinary',
    'release 1.2.3 remains ordinary',
    'time 10:30 remains ordinary',
    'hex word dead:beef remains ordinary',
    'invalid address 999.999.999.999 remains ordinary',
    'relative path tmp/cache remains ordinary',
  ])('does not alias negative-corpus prose: %s', (raw) => {
    const broker = boundary();

    expect(broker.exposeText(raw, { surface: 'prompt' })).toBe(raw);
  });
});
