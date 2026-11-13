import { describe, expect, it } from 'vitest';
import {
  MAX_SANITIZE_NODES,
  PROTECTED_MESSAGE_MARKER,
  ProtectedValueScanLimitError,
  hasProtectedManagedLink,
  isCanonicalManagedLink,
  isProtectedDeliveryMessage,
  sanitizeProtectedMessageValue,
  sanitizeProtectedMessageText,
  sanitizeProtectedToolResult,
} from '../../src/core/protected-message.ts';
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
