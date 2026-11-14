import { describe, expect, it } from 'vitest';
import {
  MAX_SANITIZE_NODES,
  PROTECTED_MESSAGE_MARKER,
  ProtectedValueScanLimitError,
  hasProtectedManagedLink,
  isCanonicalManagedLink,
  isProtectedDeliveryMessage,
  sanitizeCompletedToolResult,
  sanitizeProtectedMessageValue,
  sanitizeProtectedMessageText,
  sanitizeProtectedToolResult,
} from '../../src/core/protected-message.ts';
import { PROTECTED_TEXT_WITHHELD_MARKER } from '../../src/lib/protected-link-text.ts';
import {
  TEST_DELIVERY_HOST,
  TEST_LINK_HOST,
  TEST_PROTECTED_DELIVERY_PINS as pins,
} from '../helpers/protected-delivery-pins.ts';

describe('protected message sanitizer', () => {
  it('redacts legacy, v3, and setup fragment links without touching ordinary text', () => {
    const legacy = `https://${TEST_LINK_HOST}/s/#legacy-protected-test`;
    const v3 = `https://${TEST_LINK_HOST}/s/#v3.protected-test`;
    const setup = `https://${TEST_LINK_HOST}/setup/#setup-protected-test`;

    const result = sanitizeProtectedMessageText(`legacy: ${legacy}\nv3: ${v3}\nsetup: ${setup}`, pins);

    expect(result).toBe(`legacy: ${PROTECTED_MESSAGE_MARKER}\nv3: ${PROTECTED_MESSAGE_MARKER}\nsetup: ${PROTECTED_MESSAGE_MARKER}`);
    expect(hasProtectedManagedLink(result, pins)).toBe(true);
  });

  it('redacts the full query-like legacy fragment from the delivery API reader origin', () => {
    const link = `https://${TEST_DELIVERY_HOST}/setup/#n=host&k=LONGSEED&x=expiry`;

    const result = sanitizeProtectedMessageText(`open ${link}`, pins);

    expect(result).toBe(`open ${PROTECTED_MESSAGE_MARKER}`);
    expect(result).not.toContain('LONGSEED');
    expect(result).not.toContain(TEST_DELIVERY_HOST);
  });

  it('redacts default-port, trailing-dot, www, upper-case, bare and slashless reader URL forms without leaking fragment fields', () => {
    const links = [
      [`https://${TEST_LINK_HOST}:443/s/#n=host&k=DEFAULTPORT&x=expiry`, 'DEFAULTPORT'],
      [`http://${TEST_LINK_HOST}:80/s#n=host&k=SLASHLESS&x=expiry`, 'SLASHLESS'],
      [`https://${TEST_LINK_HOST}./setup/#n=host&k=TRAILINGDOT&x=expiry`, 'TRAILINGDOT'],
      [`https://${TEST_DELIVERY_HOST}:443/setup#n=host&k=APIPORT&x=expiry`, 'APIPORT'],
      [`https://www.${TEST_LINK_HOST}/s/#n=host&k=WWWPREFIX&x=expiry`, 'WWWPREFIX'],
      [`HTTPS://${TEST_LINK_HOST.toUpperCase()}/S/#n=host&k=UPPERCASE&x=expiry`, 'UPPERCASE'],
      [`${TEST_LINK_HOST}/s/#n=host&k=BAREHOST&x=expiry`, 'BAREHOST'],
      // Browsers map U+017F to `s` and U+212A to `k`, so these spellings open the pinned host.
      [`https://${TEST_DELIVERY_HOST.replace(/s/g, 'ſ')}/s/#n=host&k=LONGS&x=expiry`, 'LONGS'],
      [`https://${TEST_LINK_HOST.replace(/k/g, 'K')}/s/#n=host&k=KELVIN&x=expiry`, 'KELVIN'],
    ] as const;

    for (const [link, secret] of links) {
      const result = sanitizeProtectedMessageText(`open ${link}`, pins);
      expect(result).toBe(`open ${PROTECTED_MESSAGE_MARKER}`);
      expect(result).not.toContain(secret);
    }
  });

  it('does not redact lookalike, unpinned, or mismatched-port hosts', () => {
    const links = [
      `https://${TEST_LINK_HOST}.evil.invalid/s/#attacker`,
      `https://evil${TEST_LINK_HOST}/s/#attacker`,
      'https://evil.invalid/s/#attacker',
      `https://${TEST_LINK_HOST}:8443/s/#attacker`,
      `http://${TEST_LINK_HOST}:443/s/#attacker`,
      `${TEST_LINK_HOST}:443/s/#attacker`,
    ];

    for (const link of links) {
      expect(sanitizeProtectedMessageText(link, pins)).toBe(link);
      expect(hasProtectedManagedLink(link, pins)).toBe(false);
    }
  });

  it('finds a pinned link after an unpinned candidate in the same text', () => {
    const text = `https://evil.invalid/s/#attacker then https://${TEST_LINK_HOST}/s/#v3.later-protected-test`;

    expect(sanitizeProtectedMessageText(text, pins)).toBe(`https://evil.invalid/s/#attacker then ${PROTECTED_MESSAGE_MARKER}`);
  });

  it('redacts only hosts whose digest is pinned, so production pins ignore the test hosts', () => {
    const link = `https://${TEST_LINK_HOST}/s/#v3.production-pins-test`;

    expect(sanitizeProtectedMessageText(link)).toBe(link);
    expect(hasProtectedManagedLink(link)).toBe(false);
    expect(sanitizeProtectedMessageText(link, pins)).toBe(PROTECTED_MESSAGE_MARKER);
  });

  it('treats the persisted marker as protected so a database without correlation rows cannot forward it', () => {
    expect(hasProtectedManagedLink(PROTECTED_MESSAGE_MARKER, pins)).toBe(true);
  });

  it('redacts protected links in nested forwarded and quoted payload fields', () => {
    const link = `https://${TEST_LINK_HOST}/s/#v3.nested-protected-test`;
    const payload = {
      message: {
        extendedTextMessage: {
          text: link,
          contextInfo: { quotedMessage: { conversation: link } },
        },
      },
      forwarded: [{ caption: `shared ${link}` }],
    };

    const sanitized = sanitizeProtectedMessageValue(payload, pins);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(`${TEST_LINK_HOST}/s/#`);
    expect(serialized).toContain(PROTECTED_MESSAGE_MARKER);
    expect(JSON.stringify(payload)).toContain(link);
  });

  it('accepts only the exact canonical managed link on the pinned canonical host', () => {
    const fragment = `v3.${'a'.repeat(22)}.${'b'.repeat(43)}`;
    const canonical = `https://${TEST_LINK_HOST}/s/#${fragment}`;

    expect(isCanonicalManagedLink(canonical, pins)).toBe(true);
    for (const rejected of [
      `https://${TEST_DELIVERY_HOST}/s/#${fragment}`,
      `https://${TEST_LINK_HOST.toUpperCase()}/s/#${fragment}`,
      `https://${TEST_LINK_HOST}:443/s/#${fragment}`,
      `https://${TEST_LINK_HOST}./s/#${fragment}`,
      `http://${TEST_LINK_HOST}/s/#${fragment}`,
      `https://user@${TEST_LINK_HOST}/s/#${fragment}`,
      `https://${TEST_LINK_HOST}/s/?q=1#${fragment}`,
      `https://${TEST_LINK_HOST}/setup/#${fragment}`,
      `https://${TEST_LINK_HOST}/s/#v3.short.${'b'.repeat(43)}`,
      `https://evil${TEST_LINK_HOST}/s/#${fragment}`,
      `${canonical} `,
    ]) {
      expect(isCanonicalManagedLink(rejected, pins)).toBe(false);
    }
    expect(isCanonicalManagedLink(canonical)).toBe(false);
  });

  it('uses delivery correlation when available and fails closed to link-only detection when the table is absent', () => {
    const missingTable = { raw: { prepare: () => { throw new Error('no such table'); } } };
    const correlated = { raw: { prepare: () => ({ get: () => ({ found: 1 }) }) } };

    expect(isProtectedDeliveryMessage(missingTable as any, 'protected-message-id')).toBe(false);
    expect(isProtectedDeliveryMessage(correlated as any, 'protected-message-id')).toBe(true);
  });
});

describe('protected value scan bounds', () => {
  // The root counts one node and each object or array one more; strings are
  // scanned and not counted. A root array of N objects is N + 1 nodes.
  const objects = (count: number): unknown[] => Array.from({ length: count }, (_, n) => ({ n }));
  const link = `https://${TEST_LINK_HOST}/s/#v3.${'Q'.repeat(22)}.${'Z'.repeat(43)}`;

  it('returns a tool result of exactly MAX_SANITIZE_NODES nodes whole', () => {
    const atCap = objects(MAX_SANITIZE_NODES - 1);

    const result = sanitizeProtectedToolResult(atCap, pins) as unknown[];

    expect(result).toHaveLength(atCap.length);
    expect(result[result.length - 1]).toEqual({ n: atCap.length - 1 });
    expect(result).not.toContain(PROTECTED_MESSAGE_MARKER);
  });

  it('refuses a tool result one node over the bound with an explicit error', () => {
    expect(() => sanitizeProtectedToolResult(objects(MAX_SANITIZE_NODES), pins)).toThrow(ProtectedValueScanLimitError);
  });

  it('lets the bound escape a nested property instead of reading it as a throwing accessor', () => {
    const nested = { outer: { inner: objects(MAX_SANITIZE_NODES) } };

    expect(() => sanitizeProtectedToolResult(nested, pins)).toThrow(ProtectedValueScanLimitError);
  });

  it('refuses a tool result nested deeper than the depth bound', () => {
    let deep: Record<string, unknown> = { text: link };
    for (let level = 0; level < 70; level++) deep = { next: deep };

    expect(() => sanitizeProtectedToolResult(deep, pins)).toThrow(ProtectedValueScanLimitError);
  });

  it('stores an inbound payload past the bound with the marker, never the unscanned text', () => {
    const overCap = objects(MAX_SANITIZE_NODES);
    overCap[overCap.length - 1] = { text: `see ${link}` };

    const result = sanitizeProtectedMessageValue(overCap, pins) as unknown[];

    expect(result[result.length - 1]).toBe(PROTECTED_MESSAGE_MARKER);
    expect(JSON.stringify(result)).not.toContain(TEST_LINK_HOST);
  });

  it('returns a realistic list_groups result whole: 256 groups at the 1,024-member cap', () => {
    // 1 root + 1 groups array + 256 x (group + participants array + 1,024 members) = 262,658 nodes.
    const groups = Array.from({ length: 256 }, (_, group) => ({
      id: `group-${group}@g.us`,
      subject: `group ${group}`,
      participants: Array.from({ length: 1024 }, (_, member) => ({
        id: `${group}-${member}@lid`,
        admin: member === 0 ? 'superadmin' : null,
      })),
    }));

    const result = sanitizeProtectedToolResult({ groups }, pins);

    expect(JSON.stringify(result)).toBe(JSON.stringify({ groups }));
  });
});

describe('protected text scan bounds: more than 128 links, or a fragment past its bound', () => {
  const link = `https://${TEST_LINK_HOST}/s/#v3.${'Q'.repeat(22)}.${'Z'.repeat(43)}`;
  const links = (count: number): string => `${link} `.repeat(count);

  it('keeps the text after the 128th link whole', () => {
    const result = sanitizeProtectedMessageText(`${links(128)}IMPORTANT NEUTRAL CONTENT`, pins);

    expect(result.split(PROTECTED_MESSAGE_MARKER)).toHaveLength(129);
    expect(result.endsWith(' IMPORTANT NEUTRAL CONTENT')).toBe(true);
    expect(result).not.toContain(TEST_LINK_HOST);
  });

  it('withholds a stored text with more than 128 links whole instead of truncating it', () => {
    expect(sanitizeProtectedMessageText(`${links(129)}IMPORTANT NEUTRAL CONTENT`, pins)).toBe(PROTECTED_TEXT_WITHHELD_MARKER);
  });

  it('withholds a text whose fragment reaches the fragment bound before the text ends', () => {
    const text = `see https://${TEST_LINK_HOST}/s/#${'F'.repeat(16_384)} IMPORTANT NEUTRAL CONTENT`;

    expect(sanitizeProtectedMessageText(text, pins)).toBe(PROTECTED_TEXT_WITHHELD_MARKER);
  });

  it('keeps the withheld marker recognisable as protected and safe inside JSON', () => {
    expect(PROTECTED_TEXT_WITHHELD_MARKER).toContain(PROTECTED_MESSAGE_MARKER);
    expect(PROTECTED_TEXT_WITHHELD_MARKER).not.toMatch(/["\\]/);
    expect(hasProtectedManagedLink(PROTECTED_TEXT_WITHHELD_MARKER, pins)).toBe(true);
  });

  it('refuses a tool result string with more than 128 links', () => {
    expect(() => sanitizeProtectedToolResult({ text: `${links(129)}tail` }, pins)).toThrow(ProtectedValueScanLimitError);
  });

  it('stores an inbound string with more than 128 links as the withheld marker', () => {
    expect(sanitizeProtectedMessageValue({ text: `${links(129)}tail` }, pins)).toEqual({ text: PROTECTED_TEXT_WITHHELD_MARKER });
  });
});

describe('tool result binary leaves and built-in values', () => {
  const link = `https://${TEST_LINK_HOST}/s/#v3.${'Q'.repeat(22)}.${'Z'.repeat(43)}`;
  const plaintext = (text: string): Buffer =>
    Buffer.concat([Buffer.from([0x0a, Buffer.byteLength(text)]), Buffer.from(text)]);

  it('replaces a tool result Buffer leaf whose UTF-8 bytes carry a protected link', () => {
    expect(sanitizeProtectedToolResult({ plaintext: plaintext(`see ${link}`) }, pins))
      .toEqual({ plaintext: PROTECTED_MESSAGE_MARKER });
  });

  it('finds a bare host glued to a protobuf length byte that reads as a host character', () => {
    const body = `${TEST_LINK_HOST}/s/#${'Q'.repeat(75)}`;
    expect(body.length).toBe(0x61);

    expect(sanitizeProtectedToolResult({ leaf: plaintext(body) }, pins)).toEqual({ leaf: PROTECTED_MESSAGE_MARKER });
  });

  it('scans every binary view in a tool result: Uint8Array, DataView and ArrayBuffer', () => {
    const bytes = new Uint8Array(plaintext(`see ${link}`));
    const result = sanitizeProtectedToolResult({
      typed: bytes, view: new DataView(bytes.buffer), buffer: bytes.buffer,
    }, pins);

    expect(result).toEqual({ typed: PROTECTED_MESSAGE_MARKER, view: PROTECTED_MESSAGE_MARKER, buffer: PROTECTED_MESSAGE_MARKER });
  });

  it('passes a tool result binary leaf with no link through unchanged', () => {
    const leaf = plaintext('hello');

    expect((sanitizeProtectedToolResult({ leaf }, pins) as { leaf: Buffer }).leaf).toBe(leaf);
  });

  it('keeps binary media fields of an inbound payload intact', () => {
    const mediaKey = plaintext(`see ${link}`);
    const samples = new Uint16Array([1, 2, 3]);
    const result = sanitizeProtectedMessageValue({ mediaKey, samples }, pins) as { mediaKey: Buffer; samples: Uint16Array };

    expect(result.mediaKey).toBe(mediaKey);
    expect(result.samples).toBe(samples);
  });

  it('copies a Date with its time value in both modes', () => {
    const setAt = new Date(1_700_000_000_000);
    for (const out of [sanitizeProtectedToolResult({ setAt }, pins), sanitizeProtectedMessageValue({ setAt }, pins)]) {
      expect(JSON.stringify(out)).toBe(JSON.stringify({ setAt }));
    }
    expect((sanitizeProtectedMessageValue({ setAt }, pins) as { setAt: Date }).setAt.getTime()).toBe(setAt.getTime());
  });

  it('serializes a URL as its redacted href', () => {
    const out = sanitizeProtectedToolResult({ url: new URL(link), plain: new URL('https://example.test/a') }, pins);

    expect(JSON.parse(JSON.stringify(out))).toEqual({ url: PROTECTED_MESSAGE_MARKER, plain: 'https://example.test/a' });
  });

  it('copies Map and Set contents with links redacted', () => {
    const out = sanitizeProtectedToolResult({
      map: new Map([[`key ${link}`, `see ${link}`]]), set: new Set([`see ${link}`]),
    }, pins) as { map: Map<string, string>; set: Set<string> };

    expect([...out.map]).toEqual([[`key ${PROTECTED_MESSAGE_MARKER}`, `see ${PROTECTED_MESSAGE_MARKER}`]]);
    expect([...out.set]).toEqual([`see ${PROTECTED_MESSAGE_MARKER}`]);
  });

  it('redacts a protected link used as a plain object key, in both modes', () => {
    const value = { [link]: 'first', nested: { [`key ${link}`]: 'second' } };

    for (const out of [sanitizeProtectedToolResult(value, pins), sanitizeProtectedMessageValue(value, pins)]) {
      expect(out).toEqual({ [PROTECTED_MESSAGE_MARKER]: 'first', nested: { [`key ${PROTECTED_MESSAGE_MARKER}`]: 'second' } });
      expect(JSON.stringify(out)).not.toContain(TEST_LINK_HOST);
    }
  });

  describe('a redacted key that collides with another key', () => {
    const marker = PROTECTED_MESSAGE_MARKER;
    const other = `https://${TEST_LINK_HOST}/s/#v3.${'R'.repeat(22)}.${'Y'.repeat(43)}`;
    const modes = [
      ['tool result', sanitizeProtectedToolResult],
      ['completed tool result', sanitizeCompletedToolResult],
      ['inbound payload', sanitizeProtectedMessageValue],
    ] as const;

    it.each(modes)('keeps an existing key and its value in a %s, in either order', (_mode, sanitize) => {
      const existing = { [`label ${marker}`]: { id: 'existing-record' } };
      const linked = { [`label ${link}`]: { id: 'link-record' } };
      const expected = { [`label ${marker}`]: { id: 'existing-record' }, [`label ${marker} [2]`]: { id: 'link-record' } };

      for (const value of [{ ...existing, ...linked }, { ...linked, ...existing }]) {
        const out = sanitize(value, pins);
        expect(out).toEqual(expected);
        expect(JSON.stringify(out)).not.toContain(TEST_LINK_HOST);
      }
    });

    it.each(modes)('keeps an existing Map key and its value in a %s, in either order', (_mode, sanitize) => {
      const existing: [string, string] = [`label ${marker}`, 'existing-record'];
      const linked: [string, string] = [`label ${link}`, 'link-record'];

      expect([...(sanitize(new Map([existing, linked]), pins) as Map<string, string>)])
        .toEqual([[`label ${marker}`, 'existing-record'], [`label ${marker} [2]`, 'link-record']]);
      expect([...(sanitize(new Map([linked, existing]), pins) as Map<string, string>)])
        .toEqual([[`label ${marker} [2]`, 'link-record'], [`label ${marker}`, 'existing-record']]);
    });

    it('numbers redacted keys that collide with each other, skipping a suffix another key already holds', () => {
      const out = sanitizeProtectedToolResult({ [link]: 'first', [`${marker} [2]`]: 'kept', [other]: 'second' }, pins);
      const map = sanitizeProtectedToolResult(new Map([[link, 'first'], [other, 'second']]), pins) as Map<string, string>;

      expect(out).toEqual({ [marker]: 'first', [`${marker} [2]`]: 'kept', [`${marker} [3]`]: 'second' });
      expect([...map]).toEqual([[marker, 'first'], [`${marker} [2]`, 'second']]);
    });
  });

  it('copies an Error with its message and stack redacted', () => {
    const out = sanitizeProtectedToolResult({ error: new Error(`failed ${link}`) }, pins) as { error: Error };

    expect(out.error).toBeInstanceOf(Error);
    expect(out.error.message).toBe(`failed ${PROTECTED_MESSAGE_MARKER}`);
    // Node exposes stack through an accessor; the copy must still carry it.
    expect(typeof out.error.stack).toBe('string');
    expect(out.error.stack).toContain(`failed ${PROTECTED_MESSAGE_MARKER}`);
    expect(out.error.stack).not.toContain(TEST_LINK_HOST);
    // Both stay non-enumerable, so the serialized result is unchanged.
    expect(JSON.stringify(out)).toBe('{"error":{}}');
  });

  it('serializes another value with toJSON through its redacted JSON form', () => {
    class Opaque {
      readonly #href: string;
      constructor(href: string) { this.#href = href; }
      toJSON(): string { return this.#href; }
    }

    expect(JSON.stringify(sanitizeProtectedToolResult({ opaque: new Opaque(`see ${link}`) }, pins)))
      .toBe(JSON.stringify({ opaque: `see ${PROTECTED_MESSAGE_MARKER}` }));
  });
});

describe('a scheme-less host after a JSON escape inside a string value', () => {
  const link = `https://${TEST_LINK_HOST}/s/#v3.${'Q'.repeat(22)}.${'Z'.repeat(43)}`;
  const bare = link.slice('https://'.length);
  // A stored JSON column keeps a newline or tab as a two-character escape whose
  // letter reads as a host character and would glue onto the host.
  const metadata = (note: string) => ({ metadata_json: JSON.stringify({ note }) });
  const note = (value: unknown): unknown => JSON.parse((value as { metadata_json: string }).metadata_json);

  it.each(['\n', '\t'])('redacts it in a tool result and an inbound value (%j)', (escape) => {
    const input = metadata(`line${escape}${bare}`);

    expect(note(sanitizeProtectedToolResult(input, pins))).toEqual({ note: `line${escape}${PROTECTED_MESSAGE_MARKER}` });
    expect(note(sanitizeProtectedMessageValue(input, pins))).toEqual({ note: `line${escape}${PROTECTED_MESSAGE_MARKER}` });
  });

  it.each([
    ['a real newline before the bare host', `line\n${bare}`],
    ['a scheme-bearing link after an escape', JSON.stringify({ note: `line\n${link}` })],
  ])('control: %s yields one marker and no link', (_, value) => {
    const out = (sanitizeProtectedToolResult({ value }, pins) as { value: string }).value;

    expect(out).not.toContain(TEST_LINK_HOST);
    expect(out).not.toContain('Q'.repeat(22));
    expect(out.split(PROTECTED_MESSAGE_MARKER)).toHaveLength(2);
  });
});
