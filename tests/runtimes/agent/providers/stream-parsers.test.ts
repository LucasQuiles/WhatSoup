// tests/runtimes/agent/providers/stream-parsers.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCodexEvent } from '../../../../src/runtimes/agent/providers/codex-parser.ts';
import {
  createOpenCodeParser,
  type OpenCodeParser,
} from '../../../../src/runtimes/agent/providers/opencode-parser.ts';

const FIXTURES_DIR = resolve(
  import.meta.dirname,
  '../../../../src/runtimes/agent/providers/__tests__/fixtures',
);

function readFixtureLines(filename: string): string[] {
  return readFileSync(resolve(FIXTURES_DIR, filename), 'utf8').split('\n');
}

// ---------------------------------------------------------------------------
// Codex stream parser
// ---------------------------------------------------------------------------

describe('Codex stream parser', () => {
  describe('codex-output.jsonl (simple 2+2 response)', () => {
    const lines = readFixtureLines('codex-output.jsonl');

    it('parses thread.started → init event with sessionId', () => {
      const event = parseCodexEvent(lines[0]!);
      expect(event).toEqual({
        type: 'init',
        sessionId: '019d572a-d8da-7fa3-8c55-6bad7ff0f8b9',
      });
    });

    it('parses turn.started → ignored event', () => {
      const event = parseCodexEvent(lines[1]!);
      expect(event).toEqual({ type: 'ignored' });
    });

    it('parses item.completed agent_message → assistant_text with text', () => {
      const event = parseCodexEvent(lines[2]!);
      expect(event).toMatchObject({ type: 'assistant_text', text: 'Four' });
    });

    it('parses turn.completed → result with token counts and null text', () => {
      const event = parseCodexEvent(lines[3]!);
      expect(event).toEqual({
        type: 'result',
        text: null,
        inputTokens: 38365,
        outputTokens: 564,
      });
    });

    it('returns null for empty/whitespace-only lines', () => {
      // The fixture has a trailing newline producing an empty last line
      const lastLine = lines[lines.length - 1]!;
      expect(lastLine.trim()).toBe('');
      expect(parseCodexEvent(lastLine)).toBeNull();
    });
  });

  describe('codex-output2.jsonl (sandbox-blocked transcript with MCP probes)', () => {
    const lines = readFixtureLines('codex-output2.jsonl').filter((l) => l.trim() !== '');
    const events = lines.map((line) => parseCodexEvent(line));

    it('parses the full real capture into the expected event sequence', () => {
      expect(lines).toHaveLength(15);
      expect(events.map((event) => event?.type)).toEqual([
        'init',
        'ignored',
        'assistant_text',
        'assistant_text',
        'assistant_text',
        'tool_use',
        'tool_use',
        'tool_result',
        'tool_result',
        'assistant_text',
        'ignored',
        'ignored',
        'assistant_text',
        'assistant_text',
        'result',
      ]);
    });

    it('preserves assistant text from the sandbox failure transcript', () => {
      expect(events[2]).toMatchObject({
        type: 'assistant_text',
        itemId: 'item_0',
        complete: true,
      });
      expect((events[2] as { type: 'assistant_text'; text: string }).text).toContain('create `output.txt`');

      expect((events[12] as { type: 'assistant_text'; text: string }).text).toContain(
        'bwrap: loopback: Failed RTM_NEWADDR',
      );
      expect((events[13] as { type: 'assistant_text'; text: string }).text).toContain(
        'because every local command is being blocked',
      );
    });

    it('parses MCP resource probes as tool use/results with structured content', () => {
      expect(events[5]).toEqual({
        type: 'tool_use',
        toolName: 'mcp_tool_call',
        toolId: 'item_3',
        toolInput: {
          server: 'codex',
          tool: 'list_mcp_resources',
          arguments: {},
          result: null,
          error: null,
        },
      });
      expect(events[6]).toEqual({
        type: 'tool_use',
        toolName: 'mcp_tool_call',
        toolId: 'item_4',
        toolInput: {
          server: 'codex',
          tool: 'list_mcp_resource_templates',
          arguments: {},
          result: null,
          error: null,
        },
      });
      expect(events[7]).toMatchObject({
        type: 'tool_result',
        toolId: 'item_3',
        isError: false,
        content: '{"resources":[]}',
      });
      expect(events[8]).toMatchObject({
        type: 'tool_result',
        toolId: 'item_4',
        isError: false,
        content: '{"resourceTemplates":[]}',
      });
    });

    it('ignores unsupported web_search transcript items and parses final token usage', () => {
      expect(events[10]).toEqual({ type: 'ignored' });
      expect(events[11]).toEqual({ type: 'ignored' });
      expect(events[14]).toEqual({
        type: 'result',
        text: null,
        inputTokens: 100392,
        outputTokens: 2102,
      });
    });
  });

  describe('codex-output3.jsonl (tool use: shell commands + file changes)', () => {
    const lines = readFixtureLines('codex-output3.jsonl').filter((l) => l.trim() !== '');

    it('parses thread.started', () => {
      const event = parseCodexEvent(lines[0]!);
      expect(event).toEqual({
        type: 'init',
        sessionId: '019d572c-139c-7562-a122-00cb52893dfb',
      });
    });

    it('parses turn.started → ignored', () => {
      expect(parseCodexEvent(lines[1]!)).toEqual({ type: 'ignored' });
    });

    it('parses first item.completed agent_message → assistant_text', () => {
      const event = parseCodexEvent(lines[2]!);
      expect(event).toMatchObject({ type: 'assistant_text' });
      expect((event as { type: string; text: string }).text).toContain("output.txt");
    });

    it('parses item.started command_execution → tool_use with command input', () => {
      // lines[3] is item.started for item_1 (sed command)
      const event = parseCodexEvent(lines[3]!);
      expect(event).toMatchObject({
        type: 'tool_use',
        toolName: 'command_execution',
        toolId: 'item_1',
      });
      const toolUse = event as { type: 'tool_use'; toolInput: Record<string, unknown> };
      expect(typeof toolUse.toolInput['command']).toBe('string');
    });

    it('parses item.started for a second command_execution → tool_use', () => {
      // lines[4] is item.started for item_2
      const event = parseCodexEvent(lines[4]!);
      expect(event).toMatchObject({
        type: 'tool_use',
        toolName: 'command_execution',
        toolId: 'item_2',
      });
    });

    it('parses item.completed command_execution (exit 0) → tool_result isError=false', () => {
      // lines[5] is item.completed for item_2 — status completed, exit_code 0
      const event = parseCodexEvent(lines[5]!);
      expect(event).toMatchObject({
        type: 'tool_result',
        toolId: 'item_2',
        isError: false,
      });
      const result = event as { type: 'tool_result'; content: string };
      expect(result.content).toContain('test.txt');
    });

    it('parses item.completed command_execution with aggregated_output → tool_result content', () => {
      // lines[6] is item.completed for item_1 (sed output with SKILL.md content)
      const event = parseCodexEvent(lines[6]!);
      expect(event).toMatchObject({
        type: 'tool_result',
        toolId: 'item_1',
        isError: false,
      });
      const result = event as { type: 'tool_result'; content: string };
      expect(result.content.length).toBeGreaterThan(0);
    });

    it('parses item.started file_change → tool_use', () => {
      // lines[11] is item.started for item_6 (file_change)
      const fileChangeLine = lines.find((l) => {
        try {
          const p = JSON.parse(l) as Record<string, unknown>;
          const item = p['item'] as Record<string, unknown> | undefined;
          return p['type'] === 'item.started' && item?.['type'] === 'file_change';
        } catch {
          return false;
        }
      });
      expect(fileChangeLine).toBeDefined();
      const event = parseCodexEvent(fileChangeLine!);
      expect(event).toMatchObject({
        type: 'tool_use',
        toolName: 'file_change',
        toolId: 'item_6',
      });
      const toolUse = event as { type: 'tool_use'; toolInput: Record<string, unknown> };
      expect(Array.isArray(toolUse.toolInput['changes'])).toBe(true);
    });

    it('parses item.completed file_change → tool_result isError=false', () => {
      const fileChangeLine = lines.find((l) => {
        try {
          const p = JSON.parse(l) as Record<string, unknown>;
          const item = p['item'] as Record<string, unknown> | undefined;
          return p['type'] === 'item.completed' && item?.['type'] === 'file_change';
        } catch {
          return false;
        }
      });
      expect(fileChangeLine).toBeDefined();
      const event = parseCodexEvent(fileChangeLine!);
      expect(event).toMatchObject({
        type: 'tool_result',
        toolId: 'item_6',
        isError: false,
      });
    });
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(parseCodexEvent('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(parseCodexEvent('   \t  ')).toBeNull();
    });

    it('returns parse_error for malformed JSON', () => {
      const event = parseCodexEvent('{not valid json');
      expect(event).toEqual({ type: 'parse_error', line: '{not valid json' });
    });

    it('parses turn.failed → result with error text', () => {
      const line = JSON.stringify({
        type: 'turn.failed',
        error: { message: 'context window exceeded' },
        usage: { input_tokens: 100, output_tokens: 5 },
      });
      const event = parseCodexEvent(line);
      expect(event).toMatchObject({ type: 'result', inputTokens: 100, outputTokens: 5 });
      const result = event as { type: 'result'; text: string | null };
      expect(result.text).toBeTruthy();
      expect(result.text).toContain('context window exceeded');
    });

    it('parses turn.failed with no error fields → fallback text', () => {
      const line = JSON.stringify({ type: 'turn.failed' });
      const event = parseCodexEvent(line);
      expect(event).toMatchObject({ type: 'result' });
      const result = event as { type: 'result'; text: string | null };
      expect(result.text).toBe('Codex CLI turn failed');
    });
  });
});

// ---------------------------------------------------------------------------
// Codex app-server (JSON-RPC) parser
// ---------------------------------------------------------------------------

describe('Codex app-server parser (JSON-RPC)', () => {
  describe('codex-appserver-output.jsonl (simple 2+2 response)', () => {
    const lines = readFixtureLines('codex-appserver-output.jsonl').filter((l) => l.trim() !== '');

    it('parses initialize response → ignored', () => {
      const event = parseCodexEvent(lines[0]!);
      expect(event).toEqual({ type: 'ignored' });
    });

    it('parses thread/started notification → init with threadId', () => {
      const event = parseCodexEvent(lines[1]!);
      expect(event).toEqual({
        type: 'init',
        sessionId: '019d572a-d8da-7fa3-8c55-6bad7ff0f8b9',
      });
    });

    it('parses thread/start response → init (duplicate, has Thread shape)', () => {
      const event = parseCodexEvent(lines[2]!);
      expect(event).toEqual({
        type: 'init',
        sessionId: '019d572a-d8da-7fa3-8c55-6bad7ff0f8b9',
      });
    });

    it('parses turn/started with its exact native identity', () => {
      const event = parseCodexEvent(lines[3]!);
      expect(event).toEqual({
        type: 'provider_turn_started',
        identity: {
          sessionId: '019d572a-d8da-7fa3-8c55-6bad7ff0f8b9',
          turnId: 'turn-1',
        },
      });
    });

    it('parses item/agentMessage/delta → assistant_text with delta text', () => {
      const event = parseCodexEvent(lines[4]!);
      expect(event).toEqual({ type: 'assistant_text', text: 'Four', itemId: 'item-1' });
    });

    it('ignores item/completed agentMessage because deltas already delivered the text', () => {
      const event = parseCodexEvent(lines[5]!);
      expect(event).toEqual({ type: 'ignored' });
    });

    it('parses turn/completed with exact identity and terminal status', () => {
      const event = parseCodexEvent(lines[6]!);
      expect(event).toEqual({
        type: 'result',
        text: null,
        providerTurn: {
          sessionId: '019d572a-d8da-7fa3-8c55-6bad7ff0f8b9',
          turnId: 'turn-1',
          status: 'completed',
        },
      });
    });
  });

  describe('codex-appserver-tools.jsonl (tool use: commands + file changes)', () => {
    const lines = readFixtureLines('codex-appserver-tools.jsonl').filter((l) => l.trim() !== '');

    it('parses item/started commandExecution → tool_use', () => {
      const event = parseCodexEvent(lines[2]!);
      expect(event).toMatchObject({
        type: 'tool_use',
        toolName: 'commandExecution',
        toolId: 'cmd-1',
      });
      const toolUse = event as { type: 'tool_use'; toolInput: Record<string, unknown> };
      expect(toolUse.toolInput['command']).toBe('ls -la');
    });

    it('parses item/completed commandExecution → tool_result with output', () => {
      const event = parseCodexEvent(lines[3]!);
      expect(event).toMatchObject({
        type: 'tool_result',
        toolId: 'cmd-1',
        isError: false,
      });
      const result = event as { type: 'tool_result'; content: string };
      expect(result.content).toBe('file1.txt\nfile2.txt');
    });

    it('parses item/started fileChange → tool_use', () => {
      const event = parseCodexEvent(lines[4]!);
      expect(event).toMatchObject({
        type: 'tool_use',
        toolName: 'fileChange',
        toolId: 'fc-1',
      });
    });

    it('parses item/completed fileChange → tool_result', () => {
      const event = parseCodexEvent(lines[5]!);
      expect(event).toMatchObject({
        type: 'tool_result',
        toolId: 'fc-1',
        isError: false,
      });
    });

    it('parses final agentMessage delta → assistant_text', () => {
      const event = parseCodexEvent(lines[6]!);
      expect(event).toEqual({ type: 'assistant_text', text: 'Done! I created the file.', itemId: 'msg-2' });
    });

    it('ignores final item/completed agentMessage after deltas', () => {
      const event = parseCodexEvent(lines[7]!);
      expect(event).toEqual({ type: 'ignored' });
    });

    it('parses final turn/completed → result', () => {
      const event = parseCodexEvent(lines[8]!);
      expect(event).toEqual({
        type: 'result',
        text: null,
        providerTurn: {
          sessionId: '019d572a-d8da-7fa3-8c55-6bad7ff0f8b9',
          turnId: 'turn-2',
          status: 'completed',
        },
      });
    });
  });

  describe('JSON-RPC edge cases', () => {
    it('parses turn/completed with failed status → result with error text', () => {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          threadId: 'test-thread',
          turn: { id: 'turn-1', items: [], status: 'failed', error: { message: 'context window exceeded' } },
        },
      });
      const event = parseCodexEvent(line);
      expect(event).toMatchObject({
        type: 'result',
        isError: true,
        providerTurn: {
          sessionId: 'test-thread',
          turnId: 'turn-1',
          status: 'failed',
        },
      });
      const result = event as { type: 'result'; text: string | null };
      expect(result.text).toContain('context window exceeded');
    });

    it('keeps interrupted distinct and fail-closed instead of reporting success', () => {
      const event = parseCodexEvent(JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          threadId: 'test-thread',
          turn: { id: 'turn-2', status: 'interrupted', error: null },
        },
      }));

      expect(event).toEqual({
        type: 'result',
        text: null,
        isError: true,
        providerTurn: {
          sessionId: 'test-thread',
          turnId: 'turn-2',
          status: 'interrupted',
        },
      });
    });

    it('parses error response → result with error text', () => {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        id: 'ws-5',
        error: { code: -32600, message: 'Invalid Request' },
      });
      const event = parseCodexEvent(line);
      expect(event).toMatchObject({ type: 'result' });
      const result = event as { type: 'result'; text: string | null };
      expect(result.text).toContain('Invalid Request');
    });

    it('parses server request (approval) → unknown (handled by session manager)', () => {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        id: 'srv-1',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'test', turnId: 't1', itemId: 'i1' },
      });
      const event = parseCodexEvent(line);
      expect(event).toMatchObject({ type: 'unknown' });
    });

    it('parses thread/compacted → compact_boundary', () => {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/compacted',
        params: { threadId: 'test' },
      });
      const event = parseCodexEvent(line);
      expect(event).toEqual({ type: 'compact_boundary' });
    });
  });
});

// ---------------------------------------------------------------------------
// OpenCode stream parser
// ---------------------------------------------------------------------------

describe('OpenCode stream parser', () => {
  let parser: OpenCodeParser;

  beforeEach(() => {
    parser = createOpenCodeParser();
  });

  describe('opencode-output.jsonl (simple text response)', () => {
    const lines = readFixtureLines('opencode-output.jsonl');

    it('parses first step_start → init with sessionId', () => {
      const event = parser.parse(lines[0]!);
      expect(event).toEqual({
        type: 'init',
        sessionId: 'ses_2a87cf8f6ffe7hp2X3Pp2257Ni',
      });
    });

    it('parses text event → assistant_text with text content', () => {
      parser.parse(lines[0]!); // consume step_start
      const event = parser.parse(lines[1]!);
      expect(event).toMatchObject({ type: 'assistant_text' });
      const textEvent = event as { type: 'assistant_text'; text: string };
      expect(textEvent.text).toContain('Hello!');
    });

    it('parses step_finish with reason=stop → result with token counts', () => {
      parser.parse(lines[0]!);
      parser.parse(lines[1]!);
      const event = parser.parse(lines[2]!);
      expect(event).toEqual({
        type: 'result',
        text: null,
        inputTokens: 17853,
        outputTokens: 39,
        costUsd: 0.00270135,
      });
    });

    it('returns null for empty/whitespace-only lines', () => {
      const lastLine = lines[lines.length - 1]!;
      expect(lastLine.trim()).toBe('');
      expect(parser.parse(lastLine)).toBeNull();
    });
  });

  describe('opencode-tools-output.jsonl (with tool use)', () => {
    const lines = readFixtureLines('opencode-tools-output.jsonl').filter((l) => l.trim() !== '');

    it('parses first step_start → init with sessionId', () => {
      const event = parser.parse(lines[0]!);
      expect(event).toEqual({
        type: 'init',
        sessionId: 'ses_2a7f70c38ffemX8TGwQSl6tjaH',
      });
    });

    it('parses tool_use event → tool_result with isError=false and output content', () => {
      parser.parse(lines[0]!); // step_start → init
      const event = parser.parse(lines[1]!); // tool_use
      expect(event).toMatchObject({
        type: 'tool_result',
        toolId: 'call_nB8ilojwx5u6AutWTkcmMwUc',
        isError: false,
      });
      const result = event as { type: 'tool_result'; content: string };
      expect(result.content).toContain('CLAUDE.md');
    });

    it('parses step_finish with reason=tool-calls → ignored', () => {
      parser.parse(lines[0]!);
      parser.parse(lines[1]!);
      const event = parser.parse(lines[2]!);
      expect(event).toEqual({ type: 'ignored' });
    });

    it('parses second step_start → ignored (not init)', () => {
      parser.parse(lines[0]!);
      parser.parse(lines[1]!);
      parser.parse(lines[2]!);
      const event = parser.parse(lines[3]!);
      expect(event).toEqual({ type: 'ignored' });
    });

    it('parses text event after tool round → assistant_text', () => {
      parser.parse(lines[0]!);
      parser.parse(lines[1]!);
      parser.parse(lines[2]!);
      parser.parse(lines[3]!); // second step_start
      const event = parser.parse(lines[4]!); // text
      expect(event).toMatchObject({ type: 'assistant_text' });
      const textEvent = event as { type: 'assistant_text'; text: string };
      expect(textEvent.text).toContain('CLAUDE.md');
    });

    it('parses final step_finish with reason=stop → result with token counts', () => {
      for (let i = 0; i < 5; i++) parser.parse(lines[i]!);
      const event = parser.parse(lines[5]!);
      expect(event).toMatchObject({ type: 'result', text: null });
      const result = event as { type: 'result'; inputTokens?: number; outputTokens?: number };
      expect(typeof result.inputTokens).toBe('number');
      expect(typeof result.outputTokens).toBe('number');
    });
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(parser.parse('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(parser.parse('   \t  ')).toBeNull();
    });

    it('returns parse_error for malformed JSON', () => {
      const event = parser.parse('{not valid json');
      expect(event).toEqual({ type: 'parse_error', line: '{not valid json' });
    });

    it('resets state: second step_start after parser.reset() → init again', () => {
      const line = JSON.stringify({
        type: 'step_start',
        sessionID: 'ses_test123',
        part: { type: 'step-start', sessionID: 'ses_test123' },
      });
      parser.parse(line); // consume first → init
      parser.reset();
      const event = parser.parse(line); // after reset → init again
      expect(event).toEqual({ type: 'init', sessionId: 'ses_test123' });
    });

    it('isolates first step_start state between parser instances', () => {
      const firstParser = createOpenCodeParser();
      const secondParser = createOpenCodeParser();
      const firstLine = JSON.stringify({ type: 'step_start', sessionID: 'ses_one' });
      const secondLine = JSON.stringify({ type: 'step_start', sessionID: 'ses_two' });

      expect(firstParser.parse(firstLine)).toEqual({ type: 'init', sessionId: 'ses_one' });
      expect(firstParser.parse(firstLine)).toEqual({ type: 'ignored' });
      expect(secondParser.parse(secondLine)).toEqual({ type: 'init', sessionId: 'ses_two' });
    });

    it('resets isolated parser state so step_start emits init again', () => {
      const parser = createOpenCodeParser();
      const line = JSON.stringify({ type: 'step_start', sessionID: 'ses_isolated' });

      expect(parser.parse(line)).toEqual({ type: 'init', sessionId: 'ses_isolated' });
      expect(parser.parse(line)).toEqual({ type: 'ignored' });
      parser.reset();
      expect(parser.parse(line)).toEqual({ type: 'init', sessionId: 'ses_isolated' });
    });

    it('parses tool_use with error status → tool_result isError=true', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        sessionID: 'ses_test',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'call_err1',
          state: {
            status: 'error',
            input: { command: 'bad-cmd' },
            output: 'command not found',
          },
        },
      });
      const event = parser.parse(line);
      expect(event).toMatchObject({
        type: 'tool_result',
        toolId: 'call_err1',
        isError: true,
        content: 'command not found',
      });
    });

    it('parses unknown event type → unknown', () => {
      const line = JSON.stringify({ type: 'heartbeat', ts: 1234 });
      const event = parser.parse(line);
      expect(event).toMatchObject({ type: 'unknown' });
    });
  });
});
