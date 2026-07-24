import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { OperationTrackerConfig } from '../../../src/config.ts';
import { OperationTracker } from '../../../src/runtimes/agent/operation-tracker.ts';
import {
  IGNORED_BLOCK_REASONS,
  parseEvents,
} from '../../../src/runtimes/agent/stream-parser.ts';

interface SanitizedEnvelopeFixture {
  block_types_in_order: string[];
  tool_names: string[];
}

const FIXTURE_FILES = ['send-message.json', 'bash-1.json', 'bash-2.json'] as const;
const FIXTURE_DIR = resolve(import.meta.dirname, 'fixtures/stream-envelope');

const TRACKER_CONFIG: OperationTrackerConfig = {
  enabled: true,
  progressIntervalMs: 30_000,
  thinkingLongMs: 45_000,
  thinkingStallMs: 300_000,
  progressPlaceholderRateLimitMs: 180_000,
  maxStatusMessagesPerTurn: Number.MAX_SAFE_INTEGER,
  maxStatusMessagesPerWindow: Number.MAX_SAFE_INTEGER,
  statusMessageWindowMs: 300_000,
  toolThresholds: {
    default: { expectedMs: 10_000, slowMultiplier: 2, stallMultiplier: 5 },
  },
};

function readFixture(filename: string): SanitizedEnvelopeFixture {
  return JSON.parse(
    readFileSync(resolve(FIXTURE_DIR, filename), 'utf8'),
  ) as SanitizedEnvelopeFixture;
}

function buildAssistantLine(fixture: SanitizedEnvelopeFixture): string {
  let toolIndex = 0;
  const content = fixture.block_types_in_order.map((blockType, index) => {
    switch (blockType) {
      case 'thinking':
        return { type: 'thinking' };
      case 'text':
        return { type: 'text', text: `[sanitized-text-${index}]` };
      case 'tool_use': {
        const name = fixture.tool_names[toolIndex] ?? '';
        toolIndex += 1;
        return { type: 'tool_use', id: `sanitized-tool-${index}`, name, input: {} };
      }
      default:
        return { type: blockType };
    }
  });
  return JSON.stringify({ type: 'assistant', message: { content } });
}

describe('X1 stream envelope replay contract', () => {
  it('exports the ordered parseEvents API', () => {
    expect(parseEvents).toBeTypeOf('function');
  });

  it.each(FIXTURE_FILES)('replays every sanitized block in order from %s', (filename) => {
    const fixture = readFixture(filename);
    const events = parseEvents(buildAssistantLine(fixture));

    expect(events.map((event) => event.type)).toEqual([
      'ignored',
      'assistant_text',
      'tool_use',
    ]);
    const droppedBlockCount = fixture.block_types_in_order.length - events.length;
    expect(droppedBlockCount).toBe(0);
    expect(events[0]).toEqual({
      type: 'ignored',
      blockType: 'thinking',
      reason: 'model-internal, no side effects',
    });
    expect(events[2]).toMatchObject({
      type: 'tool_use',
      toolName: fixture.tool_names[0],
    });
  });

  it('preserves the error bit on a textless terminal result', () => {
    expect(parseEvents(JSON.stringify({ type: 'result', is_error: true }))).toEqual([
      { type: 'result', text: null, isError: true },
    ]);
  });

  it('resolves known non-side-effect blocks through the explicit ignore registry', () => {
    expect(IGNORED_BLOCK_REASONS).toMatchObject({
      thinking: 'model-internal, no side effects',
      redacted_thinking: 'model-internal redacted reasoning, no side effects',
      text: 'user-originated context, no provider output side effects',
      image: 'user-originated media, no provider output side effects',
      document: 'user-originated document, no provider output side effects',
    });

    expect(parseEvents(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking' },
          { type: 'redacted_thinking' },
        ],
      },
    }))).toEqual([
      {
        type: 'ignored',
        blockType: 'thinking',
        reason: 'model-internal, no side effects',
      },
      {
        type: 'ignored',
        blockType: 'redacted_thinking',
        reason: 'model-internal redacted reasoning, no side effects',
      },
    ]);

    expect(parseEvents(JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'text', text: '[sanitized]' },
          { type: 'image' },
          { type: 'document' },
        ],
      },
    }))).toEqual([
      {
        type: 'ignored',
        blockType: 'text',
        reason: 'user-originated context, no provider output side effects',
      },
      {
        type: 'ignored',
        blockType: 'image',
        reason: 'user-originated media, no provider output side effects',
      },
      {
        type: 'ignored',
        blockType: 'document',
        reason: 'user-originated document, no provider output side effects',
      },
    ]);
  });

  it('emits unknown_block for an unregistered block type instead of dropping it', () => {
    const block = { type: 'future_side_effect', sanitized: true };

    expect(parseEvents(JSON.stringify({
      type: 'assistant',
      message: { content: [block] },
    }))).toEqual([
      { type: 'unknown_block', blockType: 'future_side_effect', raw: block },
    ]);
  });

  it('emits one unknown_block for every malformed content entry', () => {
    const malformed = [null, 'not-an-object', {}, { type: 42 }];

    const events = parseEvents(JSON.stringify({
      type: 'assistant',
      message: { content: malformed },
    }));

    expect(events).toEqual([
      { type: 'unknown_block', blockType: '<non-object>', raw: null },
      { type: 'unknown_block', blockType: '<non-object>', raw: 'not-an-object' },
      { type: 'unknown_block', blockType: '<missing>', raw: {} },
      { type: 'unknown_block', blockType: '<invalid>', raw: { type: 42 } },
    ]);
  });

  it('does not admit malformed empty tool identities into OperationTracker', () => {
    vi.useFakeTimers();
    const tracker = new OperationTracker('malformed-envelope-contract', TRACKER_CONFIG, {
      onProgress: vi.fn(),
      onStalled: vi.fn(),
      onThinkingStalled: vi.fn(),
    });
    try {
      const malformedStarts = [
        { type: 'tool_use', name: 'Bash', input: {} },
        { type: 'tool_use', id: ' ', name: 'Read', input: {} },
      ];
      const events = parseEvents(JSON.stringify({
        type: 'assistant',
        message: { content: malformedStarts },
      }));
      for (const event of events) {
        if (event.type === 'tool_use') tracker.onToolStart(event.toolId, event.toolName, 'running');
      }

      expect(events).toEqual(malformedStarts.map((raw) => ({
        type: 'unknown_block',
        blockType: 'tool_use',
        raw,
      })));
      expect(events.some((event) => event.type === 'tool_use' && event.toolId === '')).toBe(false);
      expect(tracker.getActive()).toEqual([]);
    } finally {
      tracker.shutdown();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('closes all three tracked operations from one parallel tool-result envelope', () => {
    vi.useFakeTimers();
    const tracker = new OperationTracker('envelope-contract', TRACKER_CONFIG, {
      onProgress: vi.fn(),
      onStalled: vi.fn(),
      onThinkingStalled: vi.fn(),
    });
    try {
      for (const toolId of ['tool-1', 'tool-2', 'tool-3']) {
        tracker.onToolStart(toolId, 'Bash', 'running');
      }

      const events = parseEvents(JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'tool-2', is_error: true },
            { type: 'tool_result', tool_use_id: 'tool-3', content: 'ok' },
          ],
        },
      }));
      for (const event of events) {
        if (event.type === 'tool_result') tracker.onToolEnd(event.toolId);
      }

      expect(events.map((event) => event.type)).toEqual([
        'tool_result',
        'tool_result',
        'tool_result',
      ]);
      expect(events[1]).toEqual({
        type: 'tool_result',
        isError: true,
        toolId: 'tool-2',
        content: '',
      });
      expect(tracker.getActive()).toEqual([]);
    } finally {
      tracker.shutdown();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
