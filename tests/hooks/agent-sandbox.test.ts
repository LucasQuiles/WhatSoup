import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const HOOK_PATH = resolve(new URL('.', import.meta.url).pathname, '../../deploy/hooks/agent-sandbox.sh');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Policy {
  allowedPaths?: string[];
  allowedTools?: string[];
  allowedMcpTools?: string[];
  bash?: { enabled: boolean; pathRestricted?: boolean };
}

interface ToolCall {
  tool_name: string;
  tool_input?: Record<string, unknown>;
}

function runHook(
  policy: Policy,
  toolCall: ToolCall,
  policyDir: string,
): { stdout: string; stderr: string; decision: string; reason?: string } {
  const policyFile = join(policyDir, '.claude', 'sandbox-policy.json');
  writeFileSync(policyFile, JSON.stringify(policy, null, 2));

  const input = JSON.stringify(toolCall);
  let stdout = '';
  let stderr = '';

  try {
    stdout = execFileSync('bash', [HOOK_PATH], {
      input,
      cwd: policyDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    // execFileSync throws if exit code != 0; capture output from error
    const e = err as { stdout?: string; stderr?: string };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
  }

  // Capture stderr separately via spawnSync for normal (exit 0) runs
  // Actually, since hook always exits 0 and we use the try/catch above,
  // we need a different approach for stderr.
  return parseResult(stdout, stderr);
}

function runHookFull(
  policy: Policy,
  toolCall: ToolCall,
  policyDir: string,
): { stdout: string; stderr: string; decision: string; reason?: string } {
  const policyFile = join(policyDir, '.claude', 'sandbox-policy.json');
  writeFileSync(policyFile, JSON.stringify(policy, null, 2));

  const input = JSON.stringify(toolCall);

  const { spawnSync } = require('node:child_process');
  const result = spawnSync('bash', [HOOK_PATH], {
    input,
    cwd: policyDir,
    encoding: 'utf8',
  });

  const stdout: string = result.stdout ?? '';
  const stderr: string = result.stderr ?? '';
  return parseResult(stdout, stderr);
}

function parseResult(stdout: string, stderr: string): { stdout: string; stderr: string; decision: string; reason?: string } {
  let decision = '';
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(stdout.trim());
    decision = parsed.decision ?? '';
    reason = parsed.reason;
  } catch {
    // ignore parse errors
  }
  return { stdout, stderr, decision, reason };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
  // The hook looks for .claude/sandbox-policy.json relative to cwd
  const claudeDir = join(d, '.claude');
  const { mkdirSync } = require('node:fs');
  mkdirSync(claudeDir, { recursive: true });
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true });
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Tests: allowedMcpTools semantics
// ---------------------------------------------------------------------------

describe('agent-sandbox.sh — allowedMcpTools semantics', () => {
  it('allowedMcpTools absent → allows all MCP tools', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedTools: [], bash: { enabled: false } },
      { tool_name: 'mcp__whatsoup__send_message' },
      dir,
    );
    expect(result.decision).toBe('allow');
  });

  it('allowedMcpTools: [] → allows all MCP tools (normalized)', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedMcpTools: [], bash: { enabled: false } },
      { tool_name: 'mcp__whatsoup__send_message' },
      dir,
    );
    expect(result.decision).toBe('allow');
  });

  it('allowedMcpTools: ["send_message"] → allows listed tool', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedMcpTools: ['send_message'], bash: { enabled: false } },
      { tool_name: 'mcp__whatsoup__send_message' },
      dir,
    );
    expect(result.decision).toBe('allow');
  });

  it('allowedMcpTools: ["send_message"] → blocks unlisted MCP tool', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedMcpTools: ['send_message'], bash: { enabled: false } },
      { tool_name: 'mcp__whatsoup__list_contacts' },
      dir,
    );
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('not in allowedMcpTools');
  });

  it('plugin MCP tools blocked when not in allowlist', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedMcpTools: ['send_message'], bash: { enabled: false } },
      { tool_name: 'mcp__some-plugin__some_tool' },
      dir,
    );
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('not in allowedMcpTools');
  });

  it('denial produces structured JSON on stderr', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedMcpTools: ['send_message'], bash: { enabled: false } },
      { tool_name: 'mcp__whatsoup__blocked_tool' },
      dir,
    );
    expect(result.decision).toBe('block');
    // Structured JSON log on stderr
    let stderrParsed: Record<string, unknown> | null = null;
    try {
      stderrParsed = JSON.parse(result.stderr.trim());
    } catch {
      // fail below
    }
    expect(stderrParsed).not.toBeNull();
    expect(stderrParsed!.event).toBe('sandbox_deny');
    expect(stderrParsed!.tool).toBe('mcp__whatsoup__blocked_tool');
    expect(typeof stderrParsed!.reason).toBe('string');
    expect(typeof stderrParsed!.cwd).toBe('string');
    expect(typeof stderrParsed!.policyPath).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Tests: no policy file → allow all
// ---------------------------------------------------------------------------

describe('agent-sandbox.sh — no policy file', () => {
  it('allows everything when no sandbox-policy.json exists', () => {
    const dir = makeTmpDir();
    // Remove the policy file that makeTmpDir created the dir for (but we never wrote it)
    // Just run without writing a policy file
    const input = JSON.stringify({ tool_name: 'mcp__whatsoup__send_message' });
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('bash', [HOOK_PATH], {
      input,
      cwd: dir,
      encoding: 'utf8',
    });
    const parsed = JSON.parse((result.stdout as string).trim());
    expect(parsed.decision).toBe('allow');
  });
});
