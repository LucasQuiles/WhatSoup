import { describe, expect, it } from 'vitest';
import { isDurableEventKind } from '../../../src/transport/contract/events.ts';

describe('transport event durability policy', () => {
  it('classifies message, edit, delete, and outbound-status as durable', () => {
    expect(isDurableEventKind('message')).toBe(true);
    expect(isDurableEventKind('edit')).toBe(true);
    expect(isDurableEventKind('delete')).toBe(true);
    expect(isDurableEventKind('outbound-status')).toBe(true);
  });

  it('classifies reaction, presence, read, group-update, and button-press as non-durable', () => {
    expect(isDurableEventKind('reaction')).toBe(false);
    expect(isDurableEventKind('presence')).toBe(false);
    expect(isDurableEventKind('read')).toBe(false);
    expect(isDurableEventKind('group-update')).toBe(false);
    expect(isDurableEventKind('button-press')).toBe(false);
  });
});
