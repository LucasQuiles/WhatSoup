import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
// T2-DEFER(T3/T4): conformance keeps the deprecated Claude head shim until all parser APIs are envelopes.
import { parseEvent as parseDeprecatedHead } from '../../../../src/runtimes/agent/stream-parser.ts';
import { parseCodexEvent } from '../../../../src/runtimes/agent/providers/codex-parser.ts';
import { parseGeminiAcpEvent } from '../../../../src/runtimes/agent/providers/gemini-acp-parser.ts';
import {
  createOpenCodeParser,
} from '../../../../src/runtimes/agent/providers/opencode-parser.ts';

const AGENT_EVENT_TYPES = new Set<AgentEvent['type']>([
  'init',
  'compact_boundary',
  'assistant_text',
  'tool_use',
  'tool_result',
  'result',
  'token_usage',
  'ignored',
  'unknown_block',
  'unknown',
  'parse_error',
]);

function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string') return false;
  if (!AGENT_EVENT_TYPES.has(type as AgentEvent['type'])) return false;

  switch (type) {
    case 'init':
      return typeof record['sessionId'] === 'string';
    case 'compact_boundary':
      return true;
    case 'assistant_text':
      return (
        typeof record['text'] === 'string' &&
        (record['itemId'] === undefined || typeof record['itemId'] === 'string') &&
        (record['complete'] === undefined || typeof record['complete'] === 'boolean')
      );
    case 'tool_use':
      return (
        typeof record['toolName'] === 'string' &&
        typeof record['toolId'] === 'string' &&
        typeof record['toolInput'] === 'object' &&
        record['toolInput'] !== null &&
        !Array.isArray(record['toolInput'])
      );
    case 'tool_result':
      return (
        typeof record['isError'] === 'boolean' &&
        typeof record['toolId'] === 'string' &&
        typeof record['content'] === 'string' &&
        (record['toolName'] === undefined || typeof record['toolName'] === 'string')
      );
    case 'result':
      return (
        (record['text'] === null || typeof record['text'] === 'string') &&
        (record['inputTokens'] === undefined || typeof record['inputTokens'] === 'number') &&
        (record['outputTokens'] === undefined || typeof record['outputTokens'] === 'number')
      );
    case 'token_usage':
      return (
        (record['inputTokens'] === undefined || typeof record['inputTokens'] === 'number') &&
        (record['outputTokens'] === undefined || typeof record['outputTokens'] === 'number')
      );
    case 'ignored':
      return true;
    case 'unknown_block':
      return typeof record['blockType'] === 'string' && 'raw' in record;
    case 'unknown':
      return 'raw' in record;
    case 'parse_error':
      return typeof record['line'] === 'string';
    default:
      return false;
  }
}

interface ParserCase {
  name: string;
  parse: (line: string) => AgentEvent | null;
}

const parsers: ParserCase[] = [
  { name: 'parseEvent (claude-cli)', parse: (line) => parseDeprecatedHead(line) },
  { name: 'parseCodexEvent', parse: (line) => parseCodexEvent(line) },
  { name: 'parseGeminiAcpEvent', parse: (line) => parseGeminiAcpEvent(line) },
  {
    name: 'createOpenCodeParser().parse',
    parse: (line) => createOpenCodeParser().parse(line),
  },
];

const universalInputs: { label: string; line: string }[] = [
  { label: 'empty string', line: '' },
  { label: 'whitespace only', line: '   ' },
  { label: 'non-JSON garbage', line: 'not json at all' },
  { label: 'JSON-parseable but not an object', line: '42' },
  { label: 'JSON-parseable empty object', line: '{}' },
  { label: 'JSON-parseable null', line: 'null' },
];

const providerSpecificInputs: Record<string, { line: string; expectedType: AgentEvent['type'] }[]> = {
  'parseEvent (claude-cli)': [
    { line: JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }), expectedType: 'init' },
    {
      line: JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
      expectedType: 'assistant_text',
    },
  ],
  parseCodexEvent: [
    {
      line: JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: { thread: { id: 'codex-1' } },
      }),
      expectedType: 'init',
    },
    {
      line: JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { itemId: 'item-1', delta: 'codex says hi' },
      }),
      expectedType: 'assistant_text',
    },
  ],
  parseGeminiAcpEvent: [
    {
      line: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '0.1', agentCapabilities: {} },
      }),
      expectedType: 'init',
    },
    {
      line: JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { type: 'agent_message_chunk', content: { text: 'streamed' } } },
      }),
      expectedType: 'assistant_text',
    },
  ],
  'createOpenCodeParser().parse': [
    { line: JSON.stringify({ type: 'step_start', sessionID: 'oc-2' }), expectedType: 'init' },
    { line: JSON.stringify({ type: 'text', part: { text: 'instance one' } }), expectedType: 'assistant_text' },
  ],
};

describe('parser interface conformance', () => {
  describe.each(parsers)('$name', ({ name, parse }) => {
    it.each(universalInputs)(
      'returns null or a valid AgentEvent for $label',
      ({ line }) => {
        const result = parse(line);
        if (result === null) {
          expect(result).toBeNull();
          return;
        }
        expect(isAgentEvent(result)).toBe(true);
      },
    );

    it('returns AgentEvent-shaped values for provider-specific inputs', () => {
      const inputs = providerSpecificInputs[name] ?? [];
      expect(inputs.length).toBeGreaterThan(0);
      for (const { line, expectedType } of inputs) {
        const result = parse(line);
        expect(result).not.toBeNull();
        expect(isAgentEvent(result)).toBe(true);
        expect(result?.type).toBe(expectedType);
      }
    });

    it('never throws on malformed input', () => {
      const malformedCases = [
        '{"unterminated":',
        '\n',
        '{"jsonrpc":"2.0","method":null,"params":[]}',
        '[1,2,3]',
      ];
      for (const line of malformedCases) {
        expect(() => parse(line)).not.toThrow();
        const result = parse(line);
        if (result !== null) {
          expect(isAgentEvent(result)).toBe(true);
        }
      }
    });
  });

  it('enumerates every parser entry point covered by this conformance suite', () => {
    expect(parsers.map((p) => p.name)).toEqual([
      'parseEvent (claude-cli)',
      'parseCodexEvent',
      'parseGeminiAcpEvent',
      'createOpenCodeParser().parse',
    ]);
  });

  it('accepts representative values for every enumerated AgentEvent type', () => {
    const examples: AgentEvent[] = [
      { type: 'init', sessionId: 'session-1' },
      { type: 'compact_boundary' },
      { type: 'assistant_text', text: 'hello', itemId: 'item-1', complete: true },
      { type: 'tool_use', toolName: 'bash', toolId: 'tool-1', toolInput: { command: 'pwd' } },
      { type: 'tool_result', isError: false, toolId: 'tool-1', toolName: 'bash', content: 'ok' },
      { type: 'result', text: null, inputTokens: 1, outputTokens: 2 },
      { type: 'token_usage', inputTokens: 1, outputTokens: 2 },
      { type: 'ignored' },
      { type: 'unknown_block', blockType: 'future_block', raw: { type: 'future_block' } },
      { type: 'unknown', raw: { unexpected: true } },
      { type: 'parse_error', line: '{' },
    ];

    expect(new Set(examples.map((event) => event.type))).toEqual(AGENT_EVENT_TYPES);
    for (const example of examples) {
      expect(isAgentEvent(example)).toBe(true);
    }
  });

  it('rejects malformed event-like values for variants with required fields', () => {
    expect(isAgentEvent({ type: 'init' })).toBe(false);
    expect(isAgentEvent({ type: 'assistant_text', text: 1 })).toBe(false);
    expect(isAgentEvent({ type: 'tool_use', toolName: 'bash', toolId: '1', toolInput: [] })).toBe(false);
    expect(isAgentEvent({ type: 'tool_result', isError: 'false', toolId: '1', content: 'ok' })).toBe(false);
    expect(isAgentEvent({ type: 'tool_result', isError: false, toolId: '1', toolName: 42, content: 'ok' })).toBe(false);
    expect(isAgentEvent({ type: 'parse_error' })).toBe(false);
    expect(isAgentEvent({ type: 'new_future_event' })).toBe(false);
  });
});
