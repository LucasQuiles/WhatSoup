import { describe, expect, it } from 'vitest';

import {
  createProviderDataBoundary,
  type ProviderBoundaryEvent,
  type ProviderBoundaryMcpTool,
} from '../../src/core/provider-data-boundary.ts';
import { PROVIDER_DATA_POLICY_VERSION } from '../../src/core/provider-data-policy.ts';

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
