// tests/transport/signal/adapter-groups.test.ts
// group metadata extension (SupportsGroups).
//
// Before this slice, capabilities.extensions did NOT include 'groups' and the
// adapter had no getGroupMetadata method. The spec (signal-and-imessage-
// transports-spec.md §3a line 83) lists 'groups' among Signal's natively
// supported extensions. signal-cli's `listGroups -d -g <groupId>` JSON-RPC
// returns { id, name, members } for a known group.
//
// This file proves:
//   1. capabilities.extensions includes 'groups' (isGroupCapable → true)
//   2. adapter.getGroupMetadata() delegates to port.getGroupMetadata()
//   3. getGroupMetadata returns a GroupMetadata { conversation, title, memberCount }
//   4. getGroupMetadata rejects with ConversationNotFoundError for an unknown group
//   5. the adapter emits a 'group-update' event when an inbound groupV2 update arrives

import { describe, it, expect } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import { isGroupsCapable } from '../../../src/transport/contract/extensions.ts';
import type { GroupUpdateEvent } from '../../../src/transport/contract/events.ts';

const GROUP_ID = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';

describe('SignalAdapter — groups capabilities', () => {
  it('declares the groups extension (isGroupsCapable → true)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(isGroupsCapable(adapter)).toBe(true);
    expect(adapter.capabilities.extensions.has('groups')).toBe(true);
  });
});

describe('SignalAdapter — getGroupMetadata', () => {
  it('delegates to the port and returns GroupMetadata { conversation, title, memberCount }', async () => {
    const port = new MockSignalPort();
    port.nextGroup = {
      id: GROUP_ID,
      name: 'Ops channel',
      members: ['+15551234567', '+15557654321', '+15555550100'],
    };
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    const meta = await adapter.getGroupMetadata({
      channel: adapter.capabilities.channel,
      id: GROUP_ID,
    });
    expect(meta.conversation.id).toBe(GROUP_ID);
    expect(meta.title).toBe('Ops channel');
    expect(meta.memberCount).toBe(3);
    await adapter.disconnect();
  });

  it('rejects with ConversationNotFoundError when the port reports the group unknown', async () => {
    const port = new MockSignalPort();
    port.nextGroupError = new Error('GROUP_NOT_FOUND');
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    await expect(
      adapter.getGroupMetadata({ channel: adapter.capabilities.channel, id: GROUP_ID }),
    ).rejects.toThrow(/not found|unknown group|GROUP_NOT_FOUND/i);
    await adapter.disconnect();
  });

  it('validates the target channel before the RPC (rejects cross-channel refs)', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    await expect(
      adapter.getGroupMetadata({
        channel: 'whatsapp:wrong' as any,
        id: GROUP_ID,
      }),
    ).rejects.toThrow(/channel/i);
    // Must not have hit the port.
    expect(port.groupQueries).toHaveLength(0);
    await adapter.disconnect();
  });
});

describe('SignalAdapter — group-update events', () => {
  it('emits a group-update event when an inbound sync envelope carries a groupV2 update', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    const events: GroupUpdateEvent[] = [];
    adapter.on('group-update', (e) => events.push(e));

    // Simulate signal-cli delivering a groupV2 name-change update via sync.
    adapter.handleInboundRecord({
      timestamp: 5000,
      source: 'self-uuid',
      destination: GROUP_ID,
      groupId: GROUP_ID,
      body: null,
      fromMe: true,
      type: 'sync',
      groupUpdate: { kind: 'metadata', detail: 'name change: "New Name"' },
    } as any);

    expect(events).toHaveLength(1);
    expect(events[0].conversation.id).toBe(GROUP_ID);
    expect(events[0].kind).toBe('metadata');
    await adapter.disconnect();
  });
});
