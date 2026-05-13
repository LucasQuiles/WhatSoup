/**
 * @vitest-environment jsdom
 *
 * Direct unit coverage for console/src/lib/csv-export.ts.
 *
 * Two helpers ship in this module:
 * - metricsToCSV: pure CSV-string builder over MessageVolumeBucket[]
 * - downloadCSV:  DOM-heavy glue (Blob + URL.createObjectURL + anchor click)
 *
 * This file covers both halves directly. `metricsToCSV` stays pure and
 * `downloadCSV` runs against jsdom with browser download APIs stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadCSV, metricsToCSV } from '../../console/src/lib/csv-export';
import type { MessageVolumeBucket } from '../../console/src/types';

function bucket(over: Partial<MessageVolumeBucket>): MessageVolumeBucket {
  return { bucket: '2026-05-12T00:00:00Z', inbound: 0, outbound: 0, media: 0, ...over };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('metricsToCSV', () => {
  it('returns the header alone for an empty array (no trailing newline)', () => {
    expect(metricsToCSV([])).toBe('bucket,inbound,outbound');
  });

  it('emits header + single row for a one-element array', () => {
    const csv = metricsToCSV([bucket({ bucket: '2026-05-12T00:00:00Z', inbound: 5, outbound: 3 })]);
    expect(csv).toBe('bucket,inbound,outbound\n2026-05-12T00:00:00Z,5,3');
  });

  it('joins multiple rows with literal LF separators', () => {
    const csv = metricsToCSV([
      bucket({ bucket: '2026-05-12T00:00:00Z', inbound: 1, outbound: 2 }),
      bucket({ bucket: '2026-05-12T01:00:00Z', inbound: 3, outbound: 4 }),
      bucket({ bucket: '2026-05-12T02:00:00Z', inbound: 5, outbound: 6 }),
    ]);
    expect(csv.split('\n')).toEqual([
      'bucket,inbound,outbound',
      '2026-05-12T00:00:00Z,1,2',
      '2026-05-12T01:00:00Z,3,4',
      '2026-05-12T02:00:00Z,5,6',
    ]);
  });

  it('renders zero counts as the literal "0" (not blank)', () => {
    const csv = metricsToCSV([bucket({ bucket: '2026-05-12T00:00:00Z', inbound: 0, outbound: 0 })]);
    expect(csv).toBe('bucket,inbound,outbound\n2026-05-12T00:00:00Z,0,0');
  });

  it('renders negative or large counts via template-string coercion', () => {
    const csv = metricsToCSV([
      bucket({ bucket: '2026-05-12T00:00:00Z', inbound: -1, outbound: 1_234_567 }),
    ]);
    expect(csv).toBe('bucket,inbound,outbound\n2026-05-12T00:00:00Z,-1,1234567');
  });

  it('excludes the unused `media` field from the row output', () => {
    // Per the header `bucket,inbound,outbound`, media is not part of CSV output
    // — the helper is intentionally scoped to the three reported fields.
    const csv = metricsToCSV([
      bucket({ bucket: '2026-05-12T00:00:00Z', inbound: 1, outbound: 2, media: 99 }),
    ]);
    expect(csv).toContain('1,2');
    expect(csv).not.toContain('99');
  });

  it('produces stable output regardless of insertion order (Array.prototype.map preserves order)', () => {
    const a = metricsToCSV([
      bucket({ bucket: 'b', inbound: 1, outbound: 1 }),
      bucket({ bucket: 'a', inbound: 1, outbound: 1 }),
    ]);
    expect(a.split('\n')[1]).toBe('b,1,1');
    expect(a.split('\n')[2]).toBe('a,1,1');
  });
});

describe('downloadCSV', () => {
  it('creates a CSV blob, clicks a download anchor, and revokes the object URL', async () => {
    const content = 'bucket,inbound,outbound\n2026-05-12T00:00:00Z,5,3';
    const objectUrl = 'blob:whatsoup-test-csv';
    const createObjectURL = vi.fn((_blob: Blob) => objectUrl);
    const revokeObjectURL = vi.fn((_url: string) => undefined);
    class StubURL extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    }
    vi.stubGlobal('URL', StubURL);
    const createElement = vi.spyOn(document, 'createElement');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    downloadCSV(content, 'metrics.csv');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob).toBeInstanceOf(Blob);
    await expect(blob.text()).resolves.toBe(content);
    expect(blob.type).toBe('text/csv;charset=utf-8;');
    const anchor = createElement.mock.results.find((result) => result.type === 'return')?.value as
      | HTMLAnchorElement
      | undefined;
    expect(createElement).toHaveBeenCalledWith('a');
    expect(anchor?.href).toBe(objectUrl);
    expect(anchor?.download).toBe('metrics.csv');
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });
});
