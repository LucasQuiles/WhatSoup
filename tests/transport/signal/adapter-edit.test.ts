// tests/transport/signal/adapter-edit.test.ts
// Phase 9 — message edit (SupportsEdit).
//
// The spec (signal-and-imessage-transports-spec.md §3a) marks edit as
// "deferred" with the rationale "edit is beta in upstream". signal-cli
// supports editing outbound messages via the `--edit-timestamp` flag on
// `send` (and surfaces inbound edits via `dataMessage.edit` in received
// envelopes). This phase wires both directions.
//
// This file proves:
//   1. capabilities.extensions includes 'edit' (isEditable → true)
//   2. adapter.editText(target, newText) issues a signal-cli send with the
//      target's timestamp as editTimestamp
//   3. editText validates channel + target id format before the RPC
//   4. the adapter emits an 'edit' event when an inbound dataMessage carries
//      an edit (targetSentTimestamp + new body)

import { describe, it, expect } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import { isEditable } from '../../../src/transport/contract/extensions.ts';
import type { EditEvent } from '../../../src/transport/contract/events.ts';

describe('SignalAdapter — edit capabilities (Phase 9)', () => {
  it('declares the edit extension (isEditable → true)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(isEditable(adapter)).toBe(true);
    expect(adapter.capabilities.extensions.has('edit')).toBe(true);
  });
});

describe('SignalAdapter — editText (Phase 9)', () => {
  it('issues a signal-cli send with editTimestamp = target timestamp', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    await adapter.editText(
      { channel: adapter.capabilities.channel, conversation: '+15551234567', id: '1700000000000' },
      'edited text',
    );

    expect(port.sent).toHaveLength(1);
    const sent = port.sent[0];
    expect(sent.recipient).toBe('+15551234567');
    expect(sent.body).toBe('edited text');
    expect(sent.editTimestamp).toBe(1700000000000);
  });

  it('validates channel before the RPC', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    await expect(
      adapter.editText(
        { channel: 'whatsapp:wrong' as any, conversation: '+15551234567', id: '1700000000000' },
        'x',
      ),
    ).rejects.toThrow(/channel/i);
    expect(port.sent).toHaveLength(0);
  });

  it('routes to a group when conversation is a base64 V2 group id', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    const groupId = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';
    await adapter.editText(
      { channel: adapter.capabilities.channel, conversation: groupId, id: '1700000000000' },
      'edited in group',
    );
    expect(port.sent[0].groupId).toBe(groupId);
    expect(port.sent[0].recipient).toBeUndefined();
  });
});

describe('SignalAdapter — inbound edit events (Phase 9)', () => {
  it('emits an EditEvent when an inbound dataMessage carries an edit', async () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    await adapter.connect();
    const events: EditEvent[] = [];
    adapter.on('edit', (e) => events.push(e));

    adapter.handleInboundRecord({
      timestamp: 8000,
      source: 'aaa-bbb-ccc',
      destination: 'self-uuid',
      body: null,
      fromMe: false,
      type: 'edit',
      edit: { targetTimestamp: 7000, newText: 'this is the edited body' },
    } as any);

    expect(events).toHaveLength(1);
    expect(events[0].target.id).toBe('7000');
    expect(events[0].newText).toBe('this is the edited body');
    await adapter.disconnect();
  });
});
