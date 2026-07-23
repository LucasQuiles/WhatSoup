import { describe, expect, it, vi } from 'vitest';

import {
  ProviderDataBoundaryError,
  createProviderDataBoundary,
  type ProviderBoundaryEvent,
  type CreateProviderDataBoundaryOptions,
  type ProviderDataBoundary,
} from '../../src/core/provider-data-boundary.ts';
import { PROVIDER_DATA_POLICY_VERSION } from '../../src/core/provider-data-policy.ts';
import type { ProviderMcpTool } from '../../src/runtimes/agent/providers/types.ts';
import {
  containsProviderSecretValue,
  sanitizeProviderSecrets,
} from '../../src/lib/provider-preview-sanitizer.ts';

function deterministicEntropy(): (size: number) => Uint8Array {
  let sequence = 0;
  return (size) => {
    sequence += 1;
    return Uint8Array.from({ length: size }, (_, index) => (sequence * 31 + index) % 256);
  };
}

function boundary(
  providerSessionId = 'provider-session-a',
  events: ProviderBoundaryEvent[] = [],
): ProviderDataBoundary {
  return createProviderDataBoundary({
    binding: {
      provider: 'openai-api',
      model: 'gpt-test',
      dataPolicy: 'restricted',
      policyVersion: PROVIDER_DATA_POLICY_VERSION,
      providerSessionId,
    },
    mode: 'enforce',
    routeSource: 'default',
    entropy: deterministicEntropy(),
    eventSink: (event) => events.push(event),
    technicalIdentifiers: ['lab-node'],
  });
}

function tool(name: string, properties: Record<string, unknown>): ProviderMcpTool {
  return {
    name,
    description: 'test tool',
    inputSchema: { type: 'object', properties },
  };
}

describe('ProviderDataBoundary', () => {
  it('aliases restricted operational values and exactly rehydrates provider output', () => {
    const broker = boundary();
    const raw = [
      'Open /workspace/LAB/WhatSoup/src/core/provider.ts',
      'email operator@example.com',
      'message 15551234567@s.whatsapp.net or +1 (555) 123-4567',
      'inspect LucasQuiles/WhatSoup#2042 on lab-node.local (10.0.0.9) via lab-node',
    ].join('; ');

    const exposed = broker.exposeText(raw, { surface: 'prompt' });

    expect(exposed).not.toContain('/workspace/LAB/WhatSoup');
    expect(exposed).not.toContain('operator@example.com');
    expect(exposed).not.toContain('15551234567@s.whatsapp.net');
    expect(exposed).not.toContain('+1 (555) 123-4567');
    expect(exposed).not.toContain('LucasQuiles/WhatSoup#2042');
    expect(exposed).not.toContain('lab-node.local');
    expect(exposed).not.toContain('10.0.0.9');
    expect(exposed).not.toContain('via lab-node');
    expect(exposed).toMatch(/WSA1/);
    expect(broker.rehydrateProviderText(exposed, { surface: 'provider_output' })).toBe(raw);
  });

  it('detects secrets before allocating any aliases and reports only scalar telemetry', () => {
    const events: ProviderBoundaryEvent[] = [];
    const broker = boundary('secret-session', events);
    const secret = `sk-${'a'.repeat(30)}`;

    expect(() => broker.exposeText(
      `/workspace/private Authorization: Bearer ${secret}`,
      { surface: 'prompt' },
    )).toThrowError(expect.objectContaining({ code: 'secret_detected' }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'secret_block',
      success: 1,
      aliasCount: 0,
      secretCount: 1,
    });
    expect(Object.keys(events[0]!).sort()).toEqual([
      'aliasCount',
      'eventType',
      'latencyMs',
      'mode',
      'policyVersion',
      'providerClass',
      'routeSource',
      'secretCount',
      'success',
      'transformCount',
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain('/workspace/private');
  });

  it('authenticates aliases and rejects forged, cross-session, retired, and homoglyph forms', () => {
    const first = boundary('provider-session-a');
    const second = boundary('provider-session-b');
    const alias = first.exposeText('/workspace/LAB/WhatSoup', { surface: 'prompt' });
    const forged = alias.replace(/[0-9a-f](?=[^0-9a-f]*⟧$)/, '0');
    const homoglyph = alias.replaceAll(':', '：');

    expect(() => second.rehydrateProviderText(alias, { surface: 'provider_output' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_alias' }));
    expect(() => first.rehydrateProviderText(forged, { surface: 'provider_output' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_alias' }));
    expect(() => first.rehydrateProviderText(homoglyph, { surface: 'provider_output' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_alias' }));

    first.retire();
    expect(() => first.rehydrateProviderText(alias, { surface: 'provider_output' }))
      .toThrowError(expect.objectContaining({ code: 'retired_boundary' }));
  });

  it('rejects aliases echoed back through local input and nested JSON strings', () => {
    const broker = boundary();
    const alias = broker.exposeText('/workspace/LAB/WhatSoup', { surface: 'prompt' });

    expect(() => broker.exposeText(`user pasted ${alias}`, { surface: 'turn' }))
      .toThrowError(expect.objectContaining({ code: 'residual_alias' }));
    expect(() => broker.rehydrateToolInput(
      'read_file',
      { path: JSON.stringify({ path: alias }) },
      [tool('read_file', { path: { type: 'string' } })],
    )).toThrowError(expect.objectContaining({ code: 'nested_alias' }));
  });

  it('uses advertised schemas and field classification to authorize exact tool rehydration', () => {
    const broker = boundary();
    const pathAlias = broker.exposeText('/workspace/LAB/WhatSoup/package.json', { surface: 'prompt' });
    const emailAlias = broker.exposeText('operator@example.com', { surface: 'prompt' });
    const tools = [tool('read_file', {
      path: { type: 'string', 'x-whatsoup-alias-type': 'path' },
      label: { type: 'string' },
      email: { type: 'string', 'x-whatsoup-alias-type': 'email' },
    })];

    expect(broker.rehydrateToolInput('read_file', { path: pathAlias }, tools))
      .toEqual({ path: '/workspace/LAB/WhatSoup/package.json' });
    expect(() => broker.rehydrateToolInput('read_file', { path: emailAlias }, tools))
      .toThrowError(expect.objectContaining({ code: 'alias_type_mismatch' }));
    expect(() => broker.rehydrateToolInput('read_file', { label: pathAlias }, tools))
      .toThrowError(expect.objectContaining({ code: 'unauthorized_field' }));
    expect(() => broker.rehydrateToolInput('other_tool', { path: pathAlias }, tools))
      .toThrowError(expect.objectContaining({ code: 'unknown_tool' }));
  });

  it('authorizes operational fields across the existing MCP toolbox', () => {
    const broker = boundary();
    const groupJid = '15551234567-1234567890@g.us';
    const contactJid = '15551234567@s.whatsapp.net';
    const newsletterJid = '123456789012345@newsletter';
    const rawPath = '/workspace/LAB/WhatSoup/media/photo.jpg';
    const rawPhone = '+1 (555) 123-4567';
    const exposed = broker.exposeTexts(
      [groupJid, contactJid, newsletterJid, rawPath, rawPhone],
      { surface: 'prompt' },
    );
    const tools = [
      tool('send_group_invite', {
        groupJid: { type: 'string' },
        chatJid: { type: 'string' },
      }),
      tool('schedule_message', {
        chatJid: { type: 'string' },
        filePath: { type: 'string' },
      }),
      tool('add_or_edit_contact', {
        jid: { type: 'string' },
        phone: { type: 'string' },
      }),
      tool('forward_message', { to_jid: { type: 'string' } }),
      tool('newsletter_change_owner', {
        jid: { type: 'string' },
        newOwnerJid: { type: 'string' },
      }),
    ];

    expect(broker.rehydrateToolInput('send_group_invite', {
      groupJid: exposed[0], chatJid: exposed[1],
    }, tools)).toEqual({ groupJid, chatJid: contactJid });
    expect(broker.rehydrateToolInput('schedule_message', {
      chatJid: exposed[1], filePath: exposed[3],
    }, tools)).toEqual({ chatJid: contactJid, filePath: rawPath });
    expect(broker.rehydrateToolInput('add_or_edit_contact', {
      jid: exposed[1], phone: exposed[4],
    }, tools)).toEqual({ jid: contactJid, phone: rawPhone });
    expect(broker.rehydrateToolInput('forward_message', { to_jid: exposed[1] }, tools))
      .toEqual({ to_jid: contactJid });
    expect(broker.rehydrateToolInput('newsletter_change_owner', {
      jid: exposed[2], newOwnerJid: exposed[1],
    }, tools)).toEqual({ jid: newsletterJid, newOwnerJid: contactJid });
  });

  it('rejects wrong JSON value types and aliases placed at the wrong nested field path', () => {
    const broker = boundary();
    const pathAlias = broker.exposeText('/workspace/LAB/WhatSoup/package.json', { surface: 'prompt' });
    const tools = [tool('read_file', {
      options: {
        type: 'object',
        properties: { path: { type: 'string', 'x-whatsoup-alias-type': 'path' } },
      },
      path: { type: 'string', 'x-whatsoup-alias-type': 'path' },
    })];

    expect(() => broker.rehydrateToolInput('read_file', { path: [pathAlias] }, tools))
      .toThrowError(expect.objectContaining({ code: 'invalid_tool_input' }));
    expect(() => broker.rehydrateToolInput('read_file', { options: { other: pathAlias } }, tools))
      .toThrowError(expect.objectContaining({ code: 'unauthorized_field' }));
    expect(broker.rehydrateToolInput('read_file', { options: { path: pathAlias } }, tools))
      .toEqual({ options: { path: '/workspace/LAB/WhatSoup/package.json' } });
  });

  it('validates scalar values, enums, and required fields against the advertised schema', () => {
    const broker = boundary();
    const tools: ProviderMcpTool[] = [{
      name: 'inspect',
      description: 'test tool',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          count: { type: 'number' },
          exact: { type: 'integer' },
          enabled: { type: 'boolean' },
          mode: { type: 'string', enum: ['quick', 'full'] },
        },
        required: ['path', 'mode'],
      },
    }];

    expect(broker.rehydrateToolInput('inspect', {
      path: 'relative.txt',
      count: 1.5,
      exact: 2,
      enabled: true,
      mode: 'quick',
    }, tools)).toEqual({
      path: 'relative.txt',
      count: 1.5,
      exact: 2,
      enabled: true,
      mode: 'quick',
    });
    expect(() => broker.rehydrateToolInput('inspect', { path: 123, mode: 'quick' }, tools))
      .toThrowError(expect.objectContaining({ code: 'invalid_tool_input' }));
    expect(() => broker.rehydrateToolInput('inspect', { path: 'relative.txt', mode: 'slow' }, tools))
      .toThrowError(expect.objectContaining({ code: 'invalid_tool_input' }));
    expect(() => broker.rehydrateToolInput('inspect', { path: 'relative.txt' }, tools))
      .toThrowError(expect.objectContaining({ code: 'invalid_tool_input' }));
    expect(() => broker.rehydrateToolInput('inspect', {
      path: 'relative.txt',
      mode: 'full',
      exact: 1.25,
    }, tools)).toThrowError(expect.objectContaining({ code: 'invalid_tool_input' }));
  });

  it('transforms tool results before restricted provider exposure and rejects residual aliases', () => {
    const broker = boundary();
    const result = broker.exposeToolResult(
      'read_file',
      'owner=operator@example.com path=/workspace/LAB/WhatSoup',
    );

    expect(result).not.toContain('operator@example.com');
    expect(result).not.toContain('/workspace/LAB/WhatSoup');
    expect(broker.rehydrateProviderText(result, { surface: 'provider_output' }))
      .toBe('owner=operator@example.com path=/workspace/LAB/WhatSoup');
    expect(() => broker.rehydrateProviderText('⟦WSA1:path:unknown:deadbeef⟧', { surface: 'provider_output' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_alias' }));
  });

  it('keeps trusted and shadow route bytes unchanged while shadow still emits a decision event', () => {
    const eventSink = vi.fn();
    const trusted = createProviderDataBoundary({
      binding: {
        provider: 'openai-api',
        model: 'gpt-test',
        dataPolicy: 'trusted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        providerSessionId: 'trusted-session',
      },
      mode: 'enforce',
      routeSource: 'default',
      entropy: deterministicEntropy(),
      eventSink,
    });
    const shadow = createProviderDataBoundary({
      binding: {
        provider: 'openai-api',
        model: 'gpt-test',
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        providerSessionId: 'shadow-session',
      },
      mode: 'shadow',
      routeSource: 'fallback',
      entropy: deterministicEntropy(),
      eventSink,
    });
    const bytes = 'open /workspace/LAB/WhatSoup and email operator@example.com';

    expect(trusted.exposeText(bytes, { surface: 'prompt' })).toBe(bytes);
    expect(shadow.exposeText(bytes, { surface: 'prompt' })).toBe(bytes);
    expect(eventSink).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'shadow',
      eventType: 'success',
      success: 1,
      aliasCount: 2,
    }));
  });

  it('throws typed boundary errors without including protected values', () => {
    const broker = boundary();
    const protectedValue = '/workspace/LAB/WhatSoup/private';
    const alias = broker.exposeText(protectedValue, { surface: 'prompt' });

    let caught: unknown;
    try {
      broker.rehydrateToolInput('missing', { path: alias }, []);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderDataBoundaryError);
    expect(String(caught)).not.toContain(protectedValue);
    expect(JSON.stringify(caught)).not.toContain(protectedValue);
  });

  it('does not classify operational words as secrets', () => {
    const broker = boundary();
    const operational = [
      '/srv/token/cache',
      'refs/heads/secret-fix',
      'token.internal',
      'secret@example.invalid',
    ].join(' ');

    expect(() => broker.exposeText(operational, { surface: 'prompt' })).not.toThrow();
  });

  it('rejects short explicit credentials while retaining weak-key false-positive bounds', () => {
    const broker = boundary();

    expect(() => broker.exposeText('Authorization: Bearer short', { surface: 'prompt' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(() => broker.exposeText('password=blue', { surface: 'prompt' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(() => broker.exposeText('clientSecret=blue', { surface: 'prompt' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(() => broker.exposeText('openaiApiKey=blue', { surface: 'prompt' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(() => broker.exposeText('session=blue', { surface: 'prompt' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(() => broker.exposeText('session="blue green words"', { surface: 'prompt' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(() => broker.exposeText('credential="quoted multiword value"', { surface: 'prompt' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
  });

  it.each([
    'session="blue green words"',
    'credential="quoted multiword value"',
    "token='single quoted complete value'",
  ])('uses the canonical complete-value parser for %s', (input) => {
    expect(containsProviderSecretValue(input)).toBe(true);
    expect(sanitizeProviderSecrets(input)).not.toContain(input.slice(input.indexOf('=') + 1));
    expect(sanitizeProviderSecrets(input)).toContain('[REDACTED]');
  });

  it('rejects NFKC and invisible alias lookalikes without normalizing them into valid aliases', () => {
    const broker = boundary();
    const alias = broker.exposeText('/workspace/LAB/WhatSoup', { surface: 'prompt' });
    const fullWidth = alias.replace(':', '：');
    const zeroWidth = alias.replace('WSA1', 'WS\u200bA1');
    const cyrillic = alias.replace('WSA1', 'WЅА1');

    expect(() => broker.rehydrateProviderText(fullWidth, { surface: 'provider_output' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_alias' }));
    expect(() => broker.rehydrateProviderText(zeroWidth, { surface: 'provider_output' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_alias' }));
    expect(() => broker.rehydrateProviderText(cyrillic, { surface: 'provider_output' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_alias' }));
  });

  it('fails closed when deterministic entropy repeatedly collides', () => {
    const fixedEntropy = (size: number) => new Uint8Array(size).fill(7);
    const broker = createProviderDataBoundary({
      binding: {
        provider: 'openai-api',
        model: 'gpt-test',
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        providerSessionId: 'collision-session',
      },
      mode: 'enforce',
      routeSource: 'default',
      entropy: fixedEntropy,
    });

    expect(() => broker.exposeTexts(
      ['/workspace/first', '/workspace/second'],
      { surface: 'prompt' },
    ))
      .toThrowError(expect.objectContaining({ code: 'entropy_collision' }));
    expect(() => broker.exposeText('/workspace/first', { surface: 'prompt' })).not.toThrow();
  });

  it('preflights a whole batch before allocating aliases', () => {
    const make = () => createProviderDataBoundary({
      binding: {
        provider: 'openai-api',
        model: 'gpt-test',
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        providerSessionId: 'atomic-session',
      },
      mode: 'enforce' as const,
      routeSource: 'default',
      entropy: deterministicEntropy(),
    });
    const attempted = make();
    const clean = make();
    const secret = `sk-${'q'.repeat(30)}`;

    expect(() => attempted.exposeTexts(
      ['/workspace/LAB/WhatSoup', `late ${secret}`],
      { surface: 'turn' },
    )).toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(attempted.exposeText('/workspace/LAB/WhatSoup', { surface: 'turn' }))
      .toBe(clean.exposeText('/workspace/LAB/WhatSoup', { surface: 'turn' }));
  });

  it('bounds the number of text fields in one transform', () => {
    const broker = boundary();

    expect(() => broker.exposeTexts(
      Array.from({ length: 10_001 }, () => ''),
      { surface: 'turn' },
    )).toThrowError(expect.objectContaining({ code: 'limit_exceeded' }));
  });

  it('keeps shadow bytes unchanged even when enforcement would reject them', () => {
    const events: ProviderBoundaryEvent[] = [];
    const shadow = createProviderDataBoundary({
      binding: {
        provider: 'openai-api',
        model: 'gpt-test',
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        providerSessionId: 'shadow-secret-session',
      },
      mode: 'shadow',
      routeSource: 'default',
      entropy: deterministicEntropy(),
      eventSink: (event) => events.push(event),
    });
    const secret = `sk-${'s'.repeat(30)}`;

    expect(shadow.exposeText(secret, { surface: 'prompt' })).toBe(secret);
    expect(events).toContainEqual(expect.objectContaining({
      eventType: 'secret_block',
      success: 1,
      secretCount: 1,
    }));
  });

  it('denies unknown object keys and cyclic provider tool inputs', () => {
    const broker = boundary();
    const tools = [tool('read_file', {
      path: { type: 'string', 'x-whatsoup-alias-type': 'path' },
    })];
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(() => broker.rehydrateToolInput('read_file', { extra: 'ordinary' }, tools))
      .toThrowError(expect.objectContaining({ code: 'unauthorized_field' }));
    expect(() => broker.rehydrateToolInput('read_file', cyclic, tools))
      .toThrowError(expect.objectContaining({ code: 'invalid_tool_input' }));
  });

  it('accepts advertised record values but denies aliases inside unclassified records', () => {
    const broker = boundary();
    const alias = broker.exposeText('/workspace/LAB/WhatSoup', { surface: 'prompt' });
    const tools = [tool('configure', {
      metadata: { type: 'object' },
    })];

    expect(broker.rehydrateToolInput('configure', {
      metadata: { nested: { count: 2, enabled: true }, label: 'ordinary' },
    }, tools)).toEqual({
      metadata: { nested: { count: 2, enabled: true }, label: 'ordinary' },
    });
    expect(() => broker.rehydrateToolInput('configure', {
      metadata: { localPath: alias },
    }, tools)).toThrowError(expect.objectContaining({ code: 'unauthorized_field' }));
  });

  it('enforces additionalProperties value schemas recursively for advertised records', () => {
    const broker = boundary();
    const tools = [tool('configure', {
      metadata: {
        type: 'object',
        additionalProperties: {
          type: 'array',
          items: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
        },
      },
    })];

    expect(broker.rehydrateToolInput('configure', {
      metadata: { first: [{ label: 'ordinary' }] },
    }, tools)).toEqual({ metadata: { first: [{ label: 'ordinary' }] } });
    expect(() => broker.rehydrateToolInput('configure', {
      metadata: { first: [{ label: 42 }] },
    }, tools)).toThrowError(expect.objectContaining({ code: 'invalid_tool_input' }));
    expect(() => broker.rehydrateToolInput('configure', {
      metadata: { first: 'not-an-array' },
    }, tools)).toThrowError(expect.objectContaining({ code: 'invalid_tool_input' }));
  });

  it('accepts ordinary JSON recursively when additionalProperties uses the empty schema', () => {
    const broker = boundary();
    const ordinary = {
      text: 'ordinary',
      number: 42.5,
      enabled: true,
      absent: null,
      nested: { label: 'value', count: 2 },
      items: ['value', 3, false, null, { nested: ['leaf'] }],
    };
    const tools = [tool('configure', {
      metadata: { type: 'object', additionalProperties: {} },
    })];

    expect(broker.rehydrateToolInput('configure', { metadata: ordinary }, tools))
      .toEqual({ metadata: ordinary });
  });

  it('keeps empty-schema record values unclassified and bounded', () => {
    const broker = boundary();
    const knownAlias = broker.exposeText('/workspace/LAB/WhatSoup', { surface: 'prompt' });
    const forgedAlias = knownAlias.replace(/:[0-9a-f]{32}⟧$/u, `:${'0'.repeat(32)}⟧`);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    let tooDeep: unknown = 'leaf';
    for (let index = 0; index < 34; index += 1) tooDeep = [tooDeep];
    const prototypeKey = JSON.parse('{"__proto__":"ordinary"}') as Record<string, unknown>;
    const tools = [tool('configure', {
      metadata: { type: 'object', additionalProperties: {} },
    })];
    const hostileValues: Array<[string, unknown, string]> = [
      ['secret', 'credential="quoted multiword value"', 'secret_detected'],
      ['known alias', knownAlias, 'unauthorized_field'],
      ['forged alias', forgedAlias, 'unauthorized_field'],
      ['prototype key', prototypeKey, 'invalid_tool_input'],
      ['cycle', cyclic, 'invalid_tool_input'],
      ['non-finite number', Number.POSITIVE_INFINITY, 'invalid_tool_input'],
      ['depth limit', tooDeep, 'limit_exceeded'],
      ['node limit', Array.from({ length: 10_001 }, () => null), 'limit_exceeded'],
      ['string limit', 'x'.repeat(1_048_577), 'limit_exceeded'],
    ];

    for (const [label, value, code] of hostileValues) {
      expect(
        () => broker.rehydrateToolInput('configure', { metadata: { value } }, tools),
        label,
      ).toThrowError(expect.objectContaining({ code }));
    }
  });

  it('atomically detects secrets and reserved aliases split across adjacent turn fields', () => {
    const broker = boundary();

    expect(() => broker.exposeTexts(
      ['cred', 'ential="quoted multiword value"'],
      { surface: 'turn' },
    )).toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(() => broker.exposeTexts(
      ['prefix ⟦W', 'ЅА1:path:deadbeef⟧'],
      { surface: 'turn' },
    )).toThrowError(expect.objectContaining({ code: 'residual_alias' }));
  });

  it('emits exactly one constrained failure event for forged and cross-session output aliases', () => {
    const source = boundary('source-session');
    const events: ProviderBoundaryEvent[] = [];
    const target = boundary('target-session', events);
    const alias = source.exposeText('/workspace/LAB/WhatSoup', { surface: 'prompt' });

    expect(() => target.rehydrateProviderText(alias, { surface: 'provider_output' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_alias' }));
    expect(events).toEqual([
      expect.objectContaining({ eventType: 'unknown_alias', success: 0, aliasCount: 1 }),
    ]);
    expect(Object.keys(events[0]!).sort()).toEqual([
      'aliasCount',
      'eventType',
      'latencyMs',
      'mode',
      'policyVersion',
      'providerClass',
      'routeSource',
      'secretCount',
      'success',
      'transformCount',
    ]);
  });

  it('runs enforce-equivalent shadow validation without creating usable aliases', () => {
    const events: ProviderBoundaryEvent[] = [];
    const shadow = createProviderDataBoundary({
      binding: {
        provider: 'openai-api',
        model: 'gpt-test',
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        providerSessionId: 'shadow-equivalence-session',
      },
      mode: 'shadow',
      routeSource: 'configured',
      entropy: deterministicEntropy(),
      eventSink: (event) => events.push(event),
    });
    const raw = '/workspace/LAB/WhatSoup';

    expect(shadow.exposeText(raw, { surface: 'prompt' })).toBe(raw);
    expect(shadow.inspectToolJson('{"path":"first","path":"second"}')).toBe(false);
    expect(shadow.rehydrateToolInput('missing_tool', { path: raw }, [])).toEqual({ path: raw });
    expect(shadow.rehydrateProviderText('⟦WSA1:path:unknown:deadbeef⟧', { surface: 'provider_output' }))
      .toBe('⟦WSA1:path:unknown:deadbeef⟧');
    expect(events.map(({ eventType, success }) => ({ eventType, success }))).toEqual([
      { eventType: 'success', success: 1 },
      { eventType: 'rehydration_failure', success: 0 },
      { eventType: 'rehydration_failure', success: 0 },
      { eventType: 'unknown_alias', success: 0 },
    ]);
  });

  it('validates record keys as well as values for secrets and alias syntax', () => {
    const broker = boundary();
    const alias = broker.exposeText('/workspace/LAB/WhatSoup', { surface: 'prompt' });
    const tools = [tool('configure', { metadata: { type: 'object' } })];

    expect(() => broker.rehydrateToolInput('configure', {
      metadata: { 'credential="quoted multiword value"': 'ordinary' },
    }, tools)).toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(() => broker.rehydrateToolInput('configure', {
      metadata: { [alias]: 'ordinary' },
    }, tools)).toThrowError(expect.objectContaining({ code: 'unauthorized_field' }));
  });

  it('rejects inherited and prototype-keyed schemas during authorization', () => {
    const broker = boundary();
    const inherited = Object.create({ properties: { path: { type: 'string' } } }) as Record<string, unknown>;
    inherited['type'] = 'object';
    const protoKeyed = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}') as Record<string, unknown>;

    expect(() => broker.rehydrateToolInput('poisoned', { path: 'ordinary' }, [{
      name: 'poisoned', inputSchema: inherited,
    }])).toThrowError(expect.objectContaining({ code: 'invalid_tool_input' }));
    expect(() => broker.rehydrateToolInput('poisoned', {}, [{
      name: 'poisoned', inputSchema: protoKeyed,
    }])).toThrowError(expect.objectContaining({ code: 'invalid_tool_input' }));
  });

  it('does not let an advisory event sink change enforcement behavior', () => {
    const broker = createProviderDataBoundary({
      binding: {
        provider: 'openai-api',
        model: 'gpt-test',
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        providerSessionId: 'throwing-sink-session',
      },
      mode: 'enforce',
      routeSource: 'default',
      entropy: deterministicEntropy(),
      eventSink: () => { throw new Error('sink unavailable'); },
    });

    const exposed = broker.exposeText('/workspace/LAB/WhatSoup', { surface: 'prompt' });
    expect(broker.rehydrateProviderText(exposed, { surface: 'provider_output' }))
      .toBe('/workspace/LAB/WhatSoup');
  });

  it('snapshots enforcement mode and event provenance at construction', () => {
    const events: ProviderBoundaryEvent[] = [];
    const options: CreateProviderDataBoundaryOptions = {
      binding: {
        provider: 'openai-api',
        model: 'gpt-test',
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        providerSessionId: 'immutable-options-session',
      },
      mode: 'enforce',
      routeSource: 'default',
      entropy: deterministicEntropy(),
      eventSink: (event) => events.push(event),
    };
    const broker = createProviderDataBoundary(options);
    const mutable = options as { mode: string; routeSource: string };
    mutable.mode = 'shadow';
    mutable.routeSource = 'conversation-id-should-not-appear';

    expect(() => broker.exposeText(`sk-${'v'.repeat(30)}`, { surface: 'prompt' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(events.at(-1)).toMatchObject({ mode: 'enforce', routeSource: 'default' });
  });

  it.each([
    ['route source', { routeSource: 'conversation-identity-must-not-emit' }],
    ['mode', { mode: 'session-identity-must-not-emit' }],
    ['policy version', { binding: { policyVersion: 'identity-must-not-emit' } }],
  ])('rejects %s outside the SoupOps closed vocabulary', (_label, mutation) => {
    const base = {
      binding: {
        provider: 'openai-api',
        model: 'gpt-test',
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        providerSessionId: 'invalid-provenance-session',
      },
      mode: 'enforce',
      routeSource: 'default',
      entropy: deterministicEntropy(),
    };
    const options = {
      ...base,
      ...mutation,
      binding: { ...base.binding, ...('binding' in mutation ? mutation.binding : {}) },
    } as unknown as CreateProviderDataBoundaryOptions;

    expect(() => createProviderDataBoundary(options)).toThrow(/closed telemetry vocabulary/i);
  });
});
