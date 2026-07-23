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

const QUOTED_ASSIGNMENT_SPLITS = [
  '"password"="beta"',
  '"token"="beta"',
].flatMap((assignment) => Array.from(
  { length: assignment.length - 1 },
  (_, index) => [
    assignment,
    index + 1,
    assignment.slice(0, index + 1),
    assignment.slice(index + 1),
  ] as const,
));

const OVERLAPPING_SECRET_ASSIGNMENTS = [
  'token=Bearer alpha',
  'password="Bearer alpha"',
  `password="ghp_${'a'.repeat(16)}"`,
] as const;

const OFFSET_OVERLAPPING_SECRET_ASSIGNMENTS = [
  `password=x/ghp_${'a'.repeat(16)}`,
  'password=xBearer alpha',
] as const;

const SEEDED_OFFSET_OVERLAPS = Array.from({ length: 90 }, (_, index) => {
  const key = ['password', 'token', 'credential'][index % 3]!;
  const leading = 'x'.repeat(index % 5 + 1);
  if (index % 2 === 0) return `${key}=${leading}Bearer alpha${index}`;
  const separator = ['/', '!', '(', ','][index % 4]!;
  const tokenCharacter = String.fromCharCode(97 + (index % 26));
  return `${key}=${leading}${separator}ghp_${tokenCharacter.repeat(16)}`;
});

const SAME_FIELD_ASSIGNMENT_SEPARATORS = [',', ';', '&', '|'] as const;

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
    ['benign left plus one direct secret', ['ordinary', 'token=beta'], 1, 0],
    ['two direct secrets', ['token=alpha', 'password=beta'], 2, 0],
    [
      'two distinct fragments',
      ['pass', 'word=alpha', 'ordinary', 'to', 'ken=beta'],
      0,
      2,
    ],
    [
      'one direct plus two distinct fragments',
      ['credential=gamma', 'pass', 'word=alpha', 'ordinary', 'to', 'ken=beta'],
      1,
      2,
    ],
  ] as const)('reports exact canonical counts for %s', (
    _label,
    texts,
    directSecretCount,
    fragmentedSecretCount,
  ) => {
    const events: ProviderBoundaryEvent[] = [];
    const scan = scanProviderTextSequence(texts);

    expect(scan).toMatchObject({
      directSecretCount,
      fragmentedSecret: fragmentedSecretCount > 0,
      fragmentedSecretCount,
    });
    expect(() => boundary(events).exposeTexts(texts, { surface: 'history' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(events.filter((event) => event.eventType === 'secret_block'))
      .toEqual([expect.objectContaining({
        secretCount: directSecretCount + fragmentedSecretCount,
      })]);
  });

  it.each([
    ['keyed Bearer value', ['token=Bearer alpha'], 1],
    ['quoted keyed Bearer value', ['password="Bearer alpha"'], 1],
    ['quoted keyed known-token value', [`password="ghp_${'a'.repeat(16)}"`], 1],
    ['overlapping keyed value plus a distinct secret', [
      'password="Bearer alpha"',
      `ghp_${'b'.repeat(16)}`,
    ], 2],
  ] as const)('counts overlapping detector grammars once for %s', (
    _label,
    texts,
    secretCount,
  ) => {
    const events: ProviderBoundaryEvent[] = [];
    const scan = scanProviderTextSequence(texts);

    expect(scan.directSecretCount + scan.fragmentedSecretCount).toBe(secretCount);
    expect(() => boundary(events).exposeTexts(texts, { surface: 'history' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(events.filter((event) => event.eventType === 'secret_block'))
      .toEqual([expect.objectContaining({ secretCount })]);
  });

  it.each(OVERLAPPING_SECRET_ASSIGNMENTS)(
    'matches the canonical count for every split of %s',
    (assignment) => {
      const canonical = scanProviderTextSequence([assignment]);
      expect(canonical.directSecretCount + canonical.fragmentedSecretCount).toBe(1);

      for (let split = 1; split < assignment.length; split += 1) {
        const texts = [assignment.slice(0, split), assignment.slice(split)];
        const scan = scanProviderTextSequence(texts);
        const exposeEvents: ProviderBoundaryEvent[] = [];
        const rehydrateEvents: ProviderBoundaryEvent[] = [];

        expect(scan.directSecretCount + scan.fragmentedSecretCount, `split ${split}`)
          .toBe(1);
        expect(() => boundary(exposeEvents).exposeTexts(texts, { surface: 'history' }))
          .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
        expect(exposeEvents.filter((event) => event.eventType === 'secret_block'))
          .toEqual([expect.objectContaining({ secretCount: 1 })]);
        expect(() => boundary(rehydrateEvents).rehydrateToolInput(
          'inspect',
          { metadata: texts },
          [{
            name: 'inspect',
            inputSchema: {
              type: 'object',
              additionalProperties: true,
            },
          }],
        )).toThrowError(expect.objectContaining({ code: 'secret_detected' }));
        expect(rehydrateEvents.filter((event) => event.eventType === 'secret_block'))
          .toEqual([expect.objectContaining({ secretCount: 1 })]);
      }
    },
  );

  it.each(OVERLAPPING_SECRET_ASSIGNMENTS)(
    'keeps a distinct later fragment when %s is split',
    (assignment) => {
      const split = Math.floor(assignment.length / 2);
      const texts = [
        assignment.slice(0, split),
        assignment.slice(split),
        ' ',
        'pass',
        'word=beta',
      ];
      const events: ProviderBoundaryEvent[] = [];
      const scan = scanProviderTextSequence(texts);

      expect(scan.directSecretCount + scan.fragmentedSecretCount).toBe(2);
      expect(() => boundary(events).exposeTexts(texts, { surface: 'history' }))
        .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
      expect(events.filter((event) => event.eventType === 'secret_block'))
        .toEqual([expect.objectContaining({ secretCount: 2 })]);
    },
  );

  it.each(OFFSET_OVERLAPPING_SECRET_ASSIGNMENTS)(
    'matches canonical offset-overlap count for every split of case %#',
    (assignment) => {
      const canonical = scanProviderTextSequence([assignment]);
      expect(canonical.directSecretCount + canonical.fragmentedSecretCount).toBe(1);

      for (let split = 1; split < assignment.length; split += 1) {
        const texts = [assignment.slice(0, split), assignment.slice(split)];
        const scan = scanProviderTextSequence(texts);
        const exposeEvents: ProviderBoundaryEvent[] = [];
        const rehydrateEvents: ProviderBoundaryEvent[] = [];

        expect(scan.directSecretCount + scan.fragmentedSecretCount, `split ${split}`)
          .toBe(1);
        expect(() => boundary(exposeEvents).exposeTexts(texts, { surface: 'history' }))
          .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
        expect(exposeEvents.filter((event) => event.eventType === 'secret_block'))
          .toEqual([expect.objectContaining({ secretCount: 1 })]);
        expect(() => boundary(rehydrateEvents).rehydrateToolInput(
          'inspect',
          { metadata: texts },
          [{
            name: 'inspect',
            inputSchema: {
              type: 'object',
              additionalProperties: true,
            },
          }],
        )).toThrowError(expect.objectContaining({ code: 'secret_detected' }));
        expect(rehydrateEvents.filter((event) => event.eventType === 'secret_block'))
          .toEqual([expect.objectContaining({ secretCount: 1 })]);
      }
    },
  );

  it('matches canonical counts across deterministic seeded offset-overlap splits', () => {
    for (const [caseIndex, assignment] of SEEDED_OFFSET_OVERLAPS.entries()) {
      const canonical = scanProviderTextSequence([assignment]);
      expect(canonical.directSecretCount + canonical.fragmentedSecretCount, `case ${caseIndex}`)
        .toBe(1);
      for (let split = 1; split < assignment.length; split += 1) {
        const scan = scanProviderTextSequence([
          assignment.slice(0, split),
          assignment.slice(split),
        ]);
        expect(
          scan.directSecretCount + scan.fragmentedSecretCount,
          `case ${caseIndex} split ${split}`,
        ).toBe(1);
      }
    }
  });

  it.each(SAME_FIELD_ASSIGNMENT_SEPARATORS)(
    'counts unquoted assignments separated by %s as distinct values',
    (separator) => {
      const text = `token=alpha${separator}password=beta`;
      const exposeEvents: ProviderBoundaryEvent[] = [];
      const rehydrateEvents: ProviderBoundaryEvent[] = [];
      const scan = scanProviderTextSequence([text]);

      expect(scan.directSecretCount + scan.fragmentedSecretCount).toBe(2);
      expect(() => boundary(exposeEvents).exposeTexts([text], { surface: 'history' }))
        .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
      expect(exposeEvents.filter((event) => event.eventType === 'secret_block'))
        .toEqual([expect.objectContaining({ secretCount: 2 })]);
      expect(() => boundary(rehydrateEvents).rehydrateToolInput(
        'inspect',
        { metadata: [text] },
        [{
          name: 'inspect',
          inputSchema: {
            type: 'object',
            additionalProperties: true,
          },
        }],
      )).toThrowError(expect.objectContaining({ code: 'secret_detected' }));
      expect(rehydrateEvents.filter((event) => event.eventType === 'secret_block'))
        .toEqual([expect.objectContaining({ secretCount: 2 })]);
    },
  );

  it.each(SAME_FIELD_ASSIGNMENT_SEPARATORS)(
    'keeps ordinary %s punctuation inside one unquoted value',
    (separator) => {
      const text = `password=alpha${separator}ordinary`;
      const events: ProviderBoundaryEvent[] = [];
      const scan = scanProviderTextSequence([text]);

      expect(scan.directSecretCount + scan.fragmentedSecretCount).toBe(1);
      expect(() => boundary(events).exposeTexts([text], { surface: 'history' }))
        .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
      expect(events.filter((event) => event.eventType === 'secret_block'))
        .toEqual([expect.objectContaining({ secretCount: 1 })]);
    },
  );

  it.each([
    ['overlapping direct values', ['token=Bearer alpha', 'password="Bearer beta"']],
    ['one-character keyed value then a token', ['password=x', `ghp_${'c'.repeat(16)}`]],
  ])('counts two separate %s twice', (_label, texts) => {
    const events: ProviderBoundaryEvent[] = [];
    const scan = scanProviderTextSequence(texts);

    expect(scan.directSecretCount + scan.fragmentedSecretCount).toBe(2);
    expect(() => boundary(events).exposeTexts(texts, { surface: 'history' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(events.filter((event) => event.eventType === 'secret_block'))
      .toEqual([expect.objectContaining({ secretCount: 2 })]);
  });

  it.each(QUOTED_ASSIGNMENT_SPLITS)(
    'detects %s split at %i with and without a word-ending prior field',
    (assignment, _split, left, right) => {
      expect(containsProviderSecretValue(assignment)).toBe(true);
      expect(sanitizeProviderSecrets(assignment)).not.toBe(assignment);
      for (const texts of [[left, right], ['ordinary', left, right]]) {
        const events: ProviderBoundaryEvent[] = [];
        const scan = scanProviderTextSequence(texts);
        const totalSecretCount = scan.directSecretCount + scan.fragmentedSecretCount;

        expect(totalSecretCount).toBe(1);
        expect(scan.fragmentedSecret || scan.directSecretCount > 0).toBe(true);
        expect(() => boundary(events).exposeTexts(texts, { surface: 'history' }))
          .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
        expect(events.filter((event) => event.eventType === 'secret_block'))
          .toEqual([expect.objectContaining({ secretCount: 1 })]);
        expect(() => boundary().rehydrateToolInput('inspect', { metadata: texts }, [{
          name: 'inspect',
          inputSchema: {
            type: 'object',
            additionalProperties: true,
          },
        }])).toThrowError(expect.objectContaining({ code: 'secret_detected' }));
      }
    },
  );

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

  it.each([100, 500, 1_000])(
    'bounds internal boundary work for %i delimiter-dense fields',
    (fieldCount) => {
      const value = 'ordinarycredential=a='.repeat(24);
      const texts = Array.from({ length: fieldCount }, () => value);
      const scan = scanProviderTextSequence(texts);
      const inspectedCharacters = fieldCount * value.length;

      expect(scan.secretBoundaryWorkUnitCount).toBeGreaterThan(0);
      expect(scan.secretBoundaryWorkUnitCount)
        .toBeLessThanOrEqual((inspectedCharacters + fieldCount) * 48);
      expect(scan.detectorInvocationCount).toBeLessThanOrEqual(fieldCount * 4);
    },
  );

  it('bounds work for dense positive grammars inside one quoted keyed value', () => {
    const token = `ghp_${'a'.repeat(16)}`;
    const text = `password="${Array.from({ length: 2_000 }, () => token).join(' ')}"`;
    const scan = scanProviderTextSequence([text]);
    const events: ProviderBoundaryEvent[] = [];

    expect(text.length).toBeLessThan(1024 * 1024);
    expect(scan.directSecretCount + scan.fragmentedSecretCount).toBe(1);
    expect(scan.secretBoundaryWorkUnitCount).toBeLessThanOrEqual((text.length + 1) * 48);
    expect(() => boundary(events).exposeTexts([text], { surface: 'history' }))
      .toThrowError(expect.objectContaining({ code: 'secret_detected' }));
    expect(events.filter((event) => event.eventType === 'secret_block'))
      .toEqual([expect.objectContaining({ secretCount: 1 })]);
  });

  it.each([
    ['password', 'pass', 'word=beta'],
    ['quoted password', '"pass', 'word"="beta"'],
  ] as const)('preserves the 512-character carry across a 64 KiB flush for %s', (
    _label,
    left,
    right,
  ) => {
    const filler = [
      ...Array.from({ length: 127 }, () => 'x'.repeat(512)),
      'x'.repeat(506),
    ];
    const texts = [...filler, left, right];
    const scan = scanProviderTextSequence(texts);

    const charactersBeforeRight = filler
      .reduce((total, value) => total + value.length, 0) + left.length;
    expect(charactersBeforeRight).toBe(65_530 + left.length);
    expect(charactersBeforeRight + right.length).toBeGreaterThan(65_536);
    expect(scan).toMatchObject({
      directSecretCount: 0,
      fragmentedSecretCount: 1,
    });
    expect(scan.detectorInvocationCount).toBeLessThanOrEqual(texts.length * 4);
  });

  it.each([
    [100, 'xcredential=a'],
    [500, 'xcredential=a'],
    [1_000, 'ordinarycredential=a='],
    [9_999, 'ordinarycredential=a='],
  ] as const)(
    'bounds source-linear work for %i short candidate-dense fields',
    (fieldCount, value) => {
      const texts = Array.from({ length: fieldCount }, () => value);
      const scan = scanProviderTextSequence(texts);
      const sourceCharacters = fieldCount * value.length;

      expect(scan).toMatchObject({
        directSecretCount: 0,
        fragmentedSecret: false,
        fragmentedSecretCount: 0,
      });
      expect(scan.secretBoundaryWorkUnitCount)
        .toBeLessThanOrEqual((sourceCharacters + fieldCount) * 48);
      expect(boundary().exposeTexts(texts, { surface: 'history' })).toEqual(texts);
    },
  );

  it('passes an exact maximum-node short candidate-dense record through the broker', () => {
    const metadata = Array.from({ length: MAX_TOOL_NODES - 2 }, () => 'xcredential=a');
    const record = { metadata };
    const raw = JSON.stringify(record);
    const broker = boundary();
    const tools: ProviderBoundaryMcpTool[] = [{
      name: 'inspect',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
      },
    }];

    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(1024 * 1024);
    expect(() => broker.inspectToolJson(raw)).not.toThrow();
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
