/**
 * Bead 8 — Pattern G: benign tool-error classification.
 *
 * Two layers:
 *  (1) Pure-helper tests for `isBenignToolError` — alert-safe self-correctable
 *      patterns return true; real-outage patterns (overloaded/timeout/enospc/
 *      enomem/rate-limit/exit-code) return false even though they humanize;
 *      plus fail-open assertions for unknown errors.
 *  (2) Gate-level tests for `maybeEmitToolFailureAlert` — an alert-safe benign
 *      error must NOT reach `emitAlertChecked`, while a real one (incl. a
 *      humanized-but-alert-worthy outage pattern) must; the gate is disabled by
 *      `BOT_ERRORS_RUNTIME_TOOL_BENIGN_FILTER='0'`, restoring prior behavior.
 *
 * Harness for the gate-level layer mirrors fallback-persist-alert.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks (gate-level layer) ──────────────────────────────────────────────────

vi.mock('../../../src/lib/emit-alert.ts', () => {
  const emitAlert = vi.fn(() => true);
  const clearAlertSource = vi.fn(() => true);
  return {
    emitAlert,
    emitAlertChecked: emitAlert,
    clearAlertSource,
    clearAlertSourceChecked: clearAlertSource,
  };
});

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media/tmp',
    voiceReply: 'never',
    agentMaxQueueDepth: 25,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    agentFallbackProvider: undefined,
    agentFallbackModel: undefined,
  };
  (globalThis as Record<string, unknown>)['__benignToolErrorTestConfig__'] = config;
  return { config };
});

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setDurability = vi.fn();
  },
}));

vi.mock('../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => 'present-key'),
  resolveProviderKeyService: vi.fn(() => null),
}));

// ─── Imports ────────────────────────────────────────────────────────────────────

import {
  AgentRuntime,
  isBenignToolError,
} from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { ToolUpdate } from '../../../src/runtimes/agent/outbound-queue.ts';
import { emitAlert } from '../../../src/lib/emit-alert.ts';

// ─── Pure helper tests ──────────────────────────────────────────────────────────

describe('isBenignToolError — alert-safe self-correctable patterns (return true)', () => {
  // ONLY genuinely agent-self-correctable, never-an-outage cases. These carry
  // alertSafe: true and are safe to suppress from the BOT ERRORS alert channel.
  const benign: Array<[string, string, string]> = [
    ['Edit not-read rejection', 'Edit', 'File has not been read yet. Read it first before writing to it.'],
    ['Edit old_string mismatch', 'Edit', 'String to replace not found in file. old_string was not present.'],
    ['worktree create failure', 'Bash', 'Cannot create agent worktree: WorktreeCreate hooks failed.'],
    ['file not found', 'Read', "ENOENT: no such file or directory, open '/tmp/missing.txt'"],
    ['no matches found', 'Grep', 'No matches found for pattern'],
    ['merge conflict', 'Bash', 'CONFLICT (content): Merge conflict in src/runtime.ts'],
    ['syntax error', 'Bash', 'bash: syntax error near unexpected token'],
    ['invalid json', 'Bash', 'Unexpected token < in JSON at position 0'],
    ['context window', 'Bash', 'prompt exceeds the context window limit'],
    ['too large', 'Read', 'File content (17906 tokens) exceeds maximum allowed tokens (10000).'],
    // AskUserQuestion auto-resolve marker — fires with tool_name=unknown on the
    // non-bridged path; never an agent or runtime fault.
    ['AskUserQuestion unanswered (unknown tool)', 'unknown', 'Answer questions?'],
    ['AskUserQuestion unanswered (error-tag wrapped)', 'unknown', '<error>Answer questions?</error>'],
    // Tool-input schema rejection — agent passed the wrong params; the harness
    // rejected the call before the handler ran. Self-correctable, never an outage.
    ['InputValidationError missing required param', 'TaskUpdate',
      '<tool_use_error>InputValidationError: TaskUpdate failed due to the following issues: The required parameter `taskId` is missing An unexpected parameter `tasks` was provided</tool_use_error>'],
    ['InputValidationError unexpected param', 'Bash',
      'InputValidationError: Bash failed due to the following issues: An unexpected parameter `tasks` was provided'],
  ];

  for (const [label, tool, content] of benign) {
    it(`returns true for ${label}`, () => {
      expect(isBenignToolError(tool, content)).toBe(true);
    });
  }

  it('is case-insensitive', () => {
    expect(isBenignToolError('Edit', 'FILE HAS NOT BEEN READ YET')).toBe(true);
  });

  it('matches the AskUserQuestion marker case-insensitively', () => {
    expect(isBenignToolError('unknown', 'ANSWER QUESTIONS?')).toBe(true);
  });
});

describe('isBenignToolError — real-outage patterns still alert (return false)', () => {
  // These patterns humanize for chat (alertSafe: false) but MUST still alert,
  // because they can indicate a real persistent infra/provider outage. Silencing
  // them would suppress the alert exactly when it matters most.
  const outage: Array<[string, string, string]> = [
    ['overloaded (Anthropic 529)', 'Bash', 'Service overloaded: no capacity for the next 30 minutes'],
    ['disk full (ENOSPC)', 'Bash', 'ENOSPC: no space left on device'],
    ['connection timeout', 'Bash', 'Error: connection timed out after 30s'],
    ['out of memory / killed', 'Bash', 'out of memory, process killed'],
    ['bare timeout', 'Bash', 'Command timed out after 120000ms'],
    ['connection reset', 'WebFetch', 'fetch failed: ECONNRESET'],
    ['rate limit / 429', 'Bash', 'Error: 429 rate limit exceeded'],
    ['exit code', 'Bash', 'Exit code 1'],
  ];

  for (const [label, tool, content] of outage) {
    it(`returns false for ${label}`, () => {
      expect(isBenignToolError(tool, content)).toBe(false);
    });
  }
});

describe('isBenignToolError — fail open to alerting', () => {
  it('returns false for an unknown real error (segfault)', () => {
    expect(isBenignToolError('Bash', 'segfault at 0x0')).toBe(false);
  });

  it('returns false for an assertion failure', () => {
    expect(isBenignToolError('Bash', 'AssertionError: expected 3 to equal 4')).toBe(false);
  });

  it('returns false for empty content', () => {
    expect(isBenignToolError('Bash', '')).toBe(false);
  });

  it('returns false for a generic database write failure', () => {
    expect(isBenignToolError('Bash', 'SQLITE_CORRUPT: database disk image is malformed')).toBe(false);
  });
});

// ─── Gate-level tests ───────────────────────────────────────────────────────────

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)[
    '__benignToolErrorTestConfig__'
  ] as Record<string, unknown>;
}

function makeDb(): Database {
  return {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeRuntime(): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
  });
}

type EmitArgs = {
  chatJid: string | null | undefined;
  toolId: string;
  toolName: string;
  content: string;
  classification: ToolUpdate;
  toolScopeKey: string;
  mapKey?: string;
};

type RuntimeView = {
  maybeEmitToolFailureAlert(args: EmitArgs): void;
};

function rv(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

function emitArgs(toolName: string, content: string): EmitArgs {
  const classification: ToolUpdate = { category: 'error', detail: `${toolName} — ${content}` };
  return {
    chatJid: 'user@s.whatsapp.net',
    toolId: 'tool-1',
    toolName,
    content,
    classification,
    toolScopeKey: 'scope-1',
  };
}

describe('maybeEmitToolFailureAlert — benign gate', () => {
  const priorFilter = process.env['BOT_ERRORS_RUNTIME_TOOL_BENIGN_FILTER'];
  const priorAlerts = process.env['BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS'];

  beforeEach(() => {
    vi.mocked(emitAlert).mockClear();
    delete process.env['BOT_ERRORS_RUNTIME_TOOL_BENIGN_FILTER'];
    delete process.env['BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS'];
  });

  afterEach(() => {
    if (priorFilter === undefined) delete process.env['BOT_ERRORS_RUNTIME_TOOL_BENIGN_FILTER'];
    else process.env['BOT_ERRORS_RUNTIME_TOOL_BENIGN_FILTER'] = priorFilter;
    if (priorAlerts === undefined) delete process.env['BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS'];
    else process.env['BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS'] = priorAlerts;
  });

  it('does NOT alert on a benign error (gate default ON)', () => {
    rv(makeRuntime()).maybeEmitToolFailureAlert(
      emitArgs('Edit', 'File has not been read yet. Read it first.'),
    );
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('does NOT alert on an unanswered AskUserQuestion (tool_name=unknown)', () => {
    rv(makeRuntime()).maybeEmitToolFailureAlert(
      emitArgs('unknown', 'Answer questions?'),
    );
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('does NOT alert on a tool-input schema rejection (InputValidationError)', () => {
    rv(makeRuntime()).maybeEmitToolFailureAlert(
      emitArgs('TaskUpdate',
        '<tool_use_error>InputValidationError: TaskUpdate failed due to the following issues: The required parameter `taskId` is missing An unexpected parameter `tasks` was provided</tool_use_error>'),
    );
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('DOES alert on an unknown real error (fail open)', () => {
    rv(makeRuntime()).maybeEmitToolFailureAlert(
      emitArgs('Bash', 'segfault at 0x0'),
    );
    expect(emitAlert).toHaveBeenCalledTimes(1);
  });

  it('DOES alert on a real-outage benign pattern (overloaded — humanized but alertSafe:false)', () => {
    rv(makeRuntime()).maybeEmitToolFailureAlert(
      emitArgs('Bash', 'Service overloaded: no capacity for the next 30 minutes'),
    );
    expect(emitAlert).toHaveBeenCalledTimes(1);
  });

  it('DOES alert on a real timeout (alertSafe:false)', () => {
    rv(makeRuntime()).maybeEmitToolFailureAlert(
      emitArgs('Bash', 'Error: connection timed out after 30s'),
    );
    expect(emitAlert).toHaveBeenCalledTimes(1);
  });

  it('DOES alert on real disk pressure (ENOSPC — alertSafe:false)', () => {
    rv(makeRuntime()).maybeEmitToolFailureAlert(
      emitArgs('Bash', 'ENOSPC: no space left on device'),
    );
    expect(emitAlert).toHaveBeenCalledTimes(1);
  });

  it('alerts on a benign error when the filter is disabled (prior behavior)', () => {
    process.env['BOT_ERRORS_RUNTIME_TOOL_BENIGN_FILTER'] = '0';
    rv(makeRuntime()).maybeEmitToolFailureAlert(
      emitArgs('Edit', 'File has not been read yet. Read it first.'),
    );
    expect(emitAlert).toHaveBeenCalledTimes(1);
  });

  it('still respects the master off switch', () => {
    process.env['BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS'] = '0';
    rv(makeRuntime()).maybeEmitToolFailureAlert(
      emitArgs('Bash', 'segfault at 0x0'),
    );
    expect(emitAlert).not.toHaveBeenCalled();
  });
});
