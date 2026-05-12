/**
 * Direct unit coverage for console/src/lib/csv-export.ts.
 *
 * Two helpers ship in this module:
 * - metricsToCSV: pure CSV-string builder over MessageVolumeBucket[]
 * - downloadCSV:  DOM-heavy glue (Blob + URL.createObjectURL + anchor click)
 *
 * The repository's console tests run under the default Node env (no DOM —
 * see vitest.config.ts; no `// @vitest-environment` directive is used in any
 * existing test under `tests/console/`). Following that convention, this
 * file pins only the pure-function half. `downloadCSV` remains exercised
 * indirectly by the in-browser console workflow.
 */
import { describe, expect, it } from 'vitest';
import { metricsToCSV } from '../../console/src/lib/csv-export';
import type { MessageVolumeBucket } from '../../console/src/types';

function bucket(over: Partial<MessageVolumeBucket>): MessageVolumeBucket {
  return { bucket: '2026-05-12T00:00:00Z', inbound: 0, outbound: 0, media: 0, ...over };
}

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
