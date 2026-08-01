import { describe, expect, it } from 'vitest';
import {
  INBOUND_STATUSES,
  isInboundStatus,
  isOpenInboundStatus,
  OPEN_INBOUND_STATUSES,
} from '../../src/core/inbound-status.ts';

describe('inbound-status SSOT (#2244/#2250)', () => {
  it('canonical union holds the five lifecycle states', () => {
    expect([...INBOUND_STATUSES]).toEqual([
      'pending',
      'processing',
      'turn_done',
      'complete',
      'failed',
    ]);
  });

  it('isInboundStatus narrows union members and rejects everything else', () => {
    for (const status of INBOUND_STATUSES) {
      expect(isInboundStatus(status)).toBe(true);
    }
    for (const rejected of [
      'skipped', // phantom member of the old reply-guarantee union
      '',
      'Pending',
      'bogus',
      undefined,
      null,
      42,
      {},
      [],
    ]) {
      expect(isInboundStatus(rejected)).toBe(false);
    }
  });

  it('open set is exactly pending/processing/turn_done', () => {
    expect([...OPEN_INBOUND_STATUSES]).toEqual([
      'pending',
      'processing',
      'turn_done',
    ]);
    for (const open of OPEN_INBOUND_STATUSES) {
      expect(isOpenInboundStatus(open)).toBe(true);
    }
    expect(isOpenInboundStatus('complete')).toBe(false);
    expect(isOpenInboundStatus('failed')).toBe(false);
    expect(isOpenInboundStatus(undefined)).toBe(false);
  });

  it('every open status is a member of the canonical union', () => {
    for (const status of OPEN_INBOUND_STATUSES) {
      expect(isInboundStatus(status)).toBe(true);
    }
  });
});
