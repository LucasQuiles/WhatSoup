// tests/runtimes/agent/providers/stream-parsers.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCodexEvent } from '../../../../src/runtimes/agent/providers/codex-parser.ts';
import { parseGeminiEvent } from '../../../../src/runtimes/agent/providers/gemini-parser.ts';
import { parseOpenCodeEvent, resetParserState } from '../../../../src/runtimes/agent/providers/opencode-parser.ts';

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
      expect(event).toEqual({ type: 'assistant_text', text: 'Four' });
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

    it('parses turn/started → ignored', () => {
      const event = parseCodexEvent(lines[3]!);
      expect(event).toEqual({ type: 'ignored' });
    });

    it('parses item/agentMessage/delta → assistant_text with delta text', () => {
      const event = parseCodexEvent(lines[4]!);
      expect(event).toEqual({ type: 'assistant_text', text: 'Four' });
    });

    it('parses item/completed agentMessage → assistant_text with full text', () => {
      const event = parseCodexEvent(lines[5]!);
      expect(event).toEqual({ type: 'assistant_text', text: 'Four' });
    });

    it('parses turn/completed → result with null text', () => {
      const event = parseCodexEvent(lines[6]!);
      expect(event).toEqual({ type: 'result', text: null });
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

    it('parses final turn/completed → result', () => {
      const event = parseCodexEvent(lines[7]!);
      expect(event).toEqual({ type: 'result', text: null });
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
      expect(event).toMatchObject({ type: 'result' });
      const result = event as { type: 'result'; text: string | null };
      expect(result.text).toContain('context window exceeded');
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
// Gemini stream parser
// ---------------------------------------------------------------------------

describe('Gemini stream parser', () => {
  describe('gemini-output.jsonl (simple 2+2 response)', () => {
    const lines = readFixtureLines('gemini-output.jsonl').filter((l) => l.trim() !== '');

    it('parses {type:"init", session_id} → init with sessionId', () => {
      const event = parseGeminiEvent(lines[0]!);
      expect(event).toEqual({
        type: 'init',
        sessionId: '85808b9c-967d-47d8-a23e-4e186c429d40',
      });
    });

    it('parses {type:"message", role:"user"} → unknown (not assistant delta)', () => {
      // lines[1] is the user message
      const event = parseGeminiEvent(lines[1]!);
      expect(event).toMatchObject({ type: 'unknown' });
    });

    it('parses {type:"message", role:"assistant", delta:true} → assistant_text', () => {
      // lines[2] is assistant delta
      const event = parseGeminiEvent(lines[2]!);
      expect(event).toEqual({ type: 'assistant_text', text: 'Four' });
    });

    it('parses {type:"result", status:"success", stats} → result with tokens and null text', () => {
      // lines[3] is the result
      const event = parseGeminiEvent(lines[3]!);
      expect(event).toEqual({
        type: 'result',
        text: null,
        inputTokens: 11986,
        outputTokens: 51,
      });
    });
  });

  describe('tool_use and tool_result events', () => {
    it('parses tool_use event → tool_use with toolName/toolId/toolInput', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        tool_name: 'bash',
        tool_id: 'call_abc123',
        input: { command: 'ls -la' },
      });
      const event = parseGeminiEvent(line);
      expect(event).toEqual({
        type: 'tool_use',
        toolName: 'bash',
        toolId: 'call_abc123',
        toolInput: { command: 'ls -la' },
      });
    });

    it('parses tool_use with no input → empty toolInput object', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        tool_name: 'noop',
        tool_id: 'call_noop',
      });
      const event = parseGeminiEvent(line);
      expect(event).toMatchObject({ type: 'tool_use', toolInput: {} });
    });

    it('parses tool_result with status success → isError=false', () => {
      const line = JSON.stringify({
        type: 'tool_result',
        tool_id: 'call_abc123',
        status: 'success',
        output: 'file1.txt\nfile2.txt',
      });
      const event = parseGeminiEvent(line);
      expect(event).toEqual({
        type: 'tool_result',
        isError: false,
        toolId: 'call_abc123',
        content: 'file1.txt\nfile2.txt',
      });
    });

    it('parses tool_result with error status → isError=true', () => {
      const line = JSON.stringify({
        type: 'tool_result',
        tool_id: 'call_fail',
        status: 'error',
        output: 'command not found',
      });
      const event = parseGeminiEvent(line);
      expect(event).toMatchObject({ type: 'tool_result', isError: true, toolId: 'call_fail' });
    });
  });

  describe('result event variations', () => {
    it('parses result with failed status → result with error text', () => {
      const line = JSON.stringify({
        type: 'result',
        status: 'failed',
        error: { message: 'quota exceeded' },
        stats: { input_tokens: 500, output_tokens: 10 },
      });
      const event = parseGeminiEvent(line);
      expect(event).toMatchObject({ type: 'result', inputTokens: 500, outputTokens: 10 });
      const result = event as { type: 'result'; text: string | null };
      expect(result.text).toContain('quota exceeded');
    });

    it('parses result with no stats → result with undefined tokens', () => {
      const line = JSON.stringify({ type: 'result', status: 'success' });
      const event = parseGeminiEvent(line);
      expect(event).toEqual({ type: 'result', text: null });
    });
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(parseGeminiEvent('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(parseGeminiEvent('  \n  ')).toBeNull();
    });

    it('returns parse_error for malformed JSON', () => {
      const event = parseGeminiEvent('{not valid json');
      expect(event).toEqual({ type: 'parse_error', line: '{not valid json' });
    });

    it('parses error event → result with error text', () => {
      const line = JSON.stringify({
        type: 'error',
        error: { message: 'rate limit hit' },
      });
      const event = parseGeminiEvent(line);
      expect(event).toMatchObject({ type: 'result' });
      const result = event as { type: 'result'; text: string | null };
      expect(result.text).toContain('rate limit hit');
    });

    it('parses unknown event type → unknown', () => {
      const line = JSON.stringify({ type: 'heartbeat', ts: 1234 });
      const event = parseGeminiEvent(line);
      expect(event).toMatchObject({ type: 'unknown' });
    });
  });
});

// ---------------------------------------------------------------------------
// OpenCode stream parser
// ---------------------------------------------------------------------------

describe('OpenCode stream parser', () => {
  beforeEach(() => {
    resetParserState();
  });

  describe('opencode-output.jsonl (simple text response)', () => {
    const lines = readFixtureLines('opencode-output.jsonl');

    it('parses first step_start → init with sessionId', () => {
      const event = parseOpenCodeEvent(lines[0]!);
      expect(event).toEqual({
        type: 'init',
        sessionId: 'ses_2a87cf8f6ffe7hp2X3Pp2257Ni',
      });
    });

    it('parses text event → assistant_text with text content', () => {
      parseOpenCodeEvent(lines[0]!); // consume step_start
      const event = parseOpenCodeEvent(lines[1]!);
      expect(event).toMatchObject({ type: 'assistant_text' });
      const textEvent = event as { type: 'assistant_text'; text: string };
      expect(textEvent.text).toContain('Hello!');
    });

    it('parses step_finish with reason=stop → result with token counts', () => {
      parseOpenCodeEvent(lines[0]!);
      parseOpenCodeEvent(lines[1]!);
      const event = parseOpenCodeEvent(lines[2]!);
      expect(event).toEqual({
        type: 'result',
        text: null,
        inputTokens: 17853,
        outputTokens: 39,
      });
    });

    it('returns null for empty/whitespace-only lines', () => {
      const lastLine = lines[lines.length - 1]!;
      expect(lastLine.trim()).toBe('');
      expect(parseOpenCodeEvent(lastLine)).toBeNull();
    });
  });

  describe('opencode-tools-output.jsonl (with tool use)', () => {
    const lines = readFixtureLines('opencode-tools-output.jsonl').filter((l) => l.trim() !== '');

    it('parses first step_start → init with sessionId', () => {
      const event = parseOpenCodeEvent(lines[0]!);
      expect(event).toEqual({
        type: 'init',
        sessionId: 'ses_2a7f70c38ffemX8TGwQSl6tjaH',
      });
    });

    it('parses tool_use event → tool_result with isError=false and output content', () => {
      parseOpenCodeEvent(lines[0]!); // step_start → init
      const event = parseOpenCodeEvent(lines[1]!); // tool_use
      expect(event).toMatchObject({
        type: 'tool_result',
        toolId: 'call_nB8ilojwx5u6AutWTkcmMwUc',
        isError: false,
      });
      const result = event as { type: 'tool_result'; content: string };
      expect(result.content).toContain('CLAUDE.md');
    });

    it('parses step_finish with reason=tool-calls → ignored', () => {
      parseOpenCodeEvent(lines[0]!);
      parseOpenCodeEvent(lines[1]!);
      const event = parseOpenCodeEvent(lines[2]!);
      expect(event).toEqual({ type: 'ignored' });
    });

    it('parses second step_start → ignored (not init)', () => {
      parseOpenCodeEvent(lines[0]!);
      parseOpenCodeEvent(lines[1]!);
      parseOpenCodeEvent(lines[2]!);
      const event = parseOpenCodeEvent(lines[3]!);
      expect(event).toEqual({ type: 'ignored' });
    });

    it('parses text event after tool round → assistant_text', () => {
      parseOpenCodeEvent(lines[0]!);
      parseOpenCodeEvent(lines[1]!);
      parseOpenCodeEvent(lines[2]!);
      parseOpenCodeEvent(lines[3]!); // second step_start
      const event = parseOpenCodeEvent(lines[4]!); // text
      expect(event).toMatchObject({ type: 'assistant_text' });
      const textEvent = event as { type: 'assistant_text'; text: string };
      expect(textEvent.text).toContain('CLAUDE.md');
    });

    it('parses final step_finish with reason=stop → result with token counts', () => {
      for (let i = 0; i < 5; i++) parseOpenCodeEvent(lines[i]!);
      const event = parseOpenCodeEvent(lines[5]!);
      expect(event).toMatchObject({ type: 'result', text: null });
      const result = event as { type: 'result'; inputTokens?: number; outputTokens?: number };
      expect(typeof result.inputTokens).toBe('number');
      expect(typeof result.outputTokens).toBe('number');
    });
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(parseOpenCodeEvent('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(parseOpenCodeEvent('   \t  ')).toBeNull();
    });

    it('returns parse_error for malformed JSON', () => {
      const event = parseOpenCodeEvent('{not valid json');
      expect(event).toEqual({ type: 'parse_error', line: '{not valid json' });
    });

    it('resets state: second step_start after resetParserState → init again', () => {
      const line = JSON.stringify({
        type: 'step_start',
        sessionID: 'ses_test123',
        part: { type: 'step-start', sessionID: 'ses_test123' },
      });
      parseOpenCodeEvent(line); // consume first → init
      resetParserState();
      const event = parseOpenCodeEvent(line); // after reset → init again
      expect(event).toEqual({ type: 'init', sessionId: 'ses_test123' });
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
      const event = parseOpenCodeEvent(line);
      expect(event).toMatchObject({
        type: 'tool_result',
        toolId: 'call_err1',
        isError: true,
        content: 'command not found',
      });
    });

    it('parses unknown event type → unknown', () => {
      const line = JSON.stringify({ type: 'heartbeat', ts: 1234 });
      const event = parseOpenCodeEvent(line);
      expect(event).toMatchObject({ type: 'unknown' });
    });
  });
});
