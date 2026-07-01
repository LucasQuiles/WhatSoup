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
    decision = parsed.hookSpecificOutput?.permissionDecision ?? '';
    reason = parsed.hookSpecificOutput?.permissionDecisionReason;
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
  it('emits Claude hookSpecificOutput for allow decisions', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedTools: [], bash: { enabled: false } },
      { tool_name: 'mcp__whatsoup__send_message' },
      dir,
    );
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

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

  it('allowedMcpTools: ["send_message"] → denies unlisted MCP tool', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedMcpTools: ['send_message'], bash: { enabled: false } },
      { tool_name: 'mcp__whatsoup__list_contacts' },
      dir,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('not in allowedMcpTools');
  });

  it('plugin MCP tools blocked when not in allowlist', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedMcpTools: ['send_message'], bash: { enabled: false } },
      { tool_name: 'mcp__some-plugin__some_tool' },
      dir,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('not in allowedMcpTools');
  });

  it('denial produces structured JSON on stderr', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedMcpTools: ['send_message'], bash: { enabled: false } },
      { tool_name: 'mcp__whatsoup__blocked_tool' },
      dir,
    );
    expect(result.decision).toBe('deny');
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

  it('emits Claude hookSpecificOutput for deny decisions', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedMcpTools: ['send_message'], bash: { enabled: false } },
      { tool_name: 'mcp__whatsoup__blocked_tool' },
      dir,
    );
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'MCP tool mcp__whatsoup__blocked_tool not in allowedMcpTools',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: no policy file → allow all
// ---------------------------------------------------------------------------

describe('agent-sandbox.sh — no policy file (R1-A: fail closed)', () => {
  function runNoPolicy(env: Record<string, string> = {}) {
    const dir = makeTmpDir();
    // Never write a policy file into dir/.claude.
    const input = JSON.stringify({ tool_name: 'mcp__whatsoup__send_message' });
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('bash', [HOOK_PATH], {
      input,
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return result as { stdout: string; stderr: string };
  }

  it('DENIES by default when no sandbox-policy.json exists (fail closed)', () => {
    const result = runNoPolicy();
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('missing');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      'WHATSOUP_SANDBOX_FAIL_OPEN',
    );
  });

  it('emits a structured sandbox_deny log on stderr when failing closed', () => {
    const result = runNoPolicy();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(result.stderr.trim());
    } catch {
      // fail below
    }
    expect(parsed).not.toBeNull();
    expect(parsed!.event).toBe('sandbox_deny');
    expect(typeof parsed!.reason).toBe('string');
    expect(parsed!.policyPath).toBe('.claude/sandbox-policy.json');
  });

  it('allows everything when WHATSOUP_SANDBOX_FAIL_OPEN=1 (legacy opt-out)', () => {
    const result = runNoPolicy({ WHATSOUP_SANDBOX_FAIL_OPEN: '1' });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('still fails closed for any non-"1" value of the opt-out env', () => {
    const result = runNoPolicy({ WHATSOUP_SANDBOX_FAIL_OPEN: 'true' });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Tests: Bash path-restriction hardening (R1-B)
//
// HONEST SCOPE: these prove the denylist now blocks the obvious, low-effort
// escapes that previously slipped through. They do NOT claim bash is fully
// sandboxed — a shell can still construct out-of-sandbox paths at runtime in
// ways a raw-string scan cannot see. The must-allow cases lock in that ordinary
// in-sandbox usage keeps working.
// ---------------------------------------------------------------------------

describe('agent-sandbox.sh — Bash path restriction (R1-B)', () => {
  const bashPolicy = (dir: string): Policy => ({
    allowedPaths: [dir],
    allowedMcpTools: [],
    bash: { enabled: true, pathRestricted: true },
  });

  function runBash(dir: string, command: string) {
    return runHookFull(bashPolicy(dir), { tool_name: 'Bash', tool_input: { command } }, dir);
  }

  describe('denies known escape patterns', () => {
    const denyCases: Array<[string, string]> = [
      ['tilde home dir', 'cat ~/secrets.txt'],
      ['tilde bare arg', 'tar czf out.tgz ~'],
      ['tilde then relative read', 'cd ~ && cat secrets.txt'],
      ['tilde user', 'cat ~root/.bashrc'],
      ['HOME default-value indirection', 'cat ${HOME:-/x}/secrets.txt'],
      ['HOME brace split', 'cat ${H}${OME}/secrets.txt'],
      ['HOME quote split', "cat $HO''ME/secrets.txt"],
      ['literal $HOME', 'cat $HOME/.bashrc'],
      ['XDG home var', 'cat $XDG_CONFIG_HOME/x'],
      ['command substitution $()', 'cat $(printf %s /Users/testuser)/secrets'],
      ['command substitution backtick', 'cat `echo /etc`/passwd'],
      ['directory traversal', 'cat ../../../etc/passwd'],
      // QR-045: bare `..` (no trailing slash) is the most obvious traversal and
      // slipped past the '../' substring block — `cd .. && cat relative` walked
      // up out of allowedPaths and the hook ALLOWED it. These lock the gap shut.
      ['bare dotdot cd then relative read', 'cd .. && cat secret.txt'],
      ['bare dotdot list parent', 'ls ..'],
      ['dotdot path component no trailing slash', 'cat foo/..'],
      ['system config /etc', 'cat /etc/passwd'],
      ['ssh keys', 'cat .ssh/id_rsa'],
      ['absolute path outside sandbox', 'cat /var/log/system.log'],
      ['quoted absolute path with space outside', 'cat "/Users/testuser/my file.txt"'],
    ];
    for (const [label, command] of denyCases) {
      it(`denies: ${label}`, () => {
        const dir = makeTmpDir();
        expect(runBash(dir, command).decision).toBe('deny');
      });
    }
  });

  describe('allows legitimate in-sandbox commands', () => {
    const allowCases: Array<[string, (d: string) => string]> = [
      ['plain echo', () => 'echo hello'],
      ['git status', () => 'git status'],
      ['npm test', () => 'npm test'],
      ['list sandbox root', (d) => `ls ${d}`],
      ['read file in sandbox', (d) => `cat ${d}/file.txt`],
      ['grep within sandbox', (d) => `grep -r foo ${d}/src`],
      ['mkdir + cd inside sandbox', (d) => `mkdir -p ${d}/sub && cd ${d}/sub`],
      ['system binary path', () => 'cat /usr/bin/env'],
      ['redirect to /dev/null', () => 'echo hi > /dev/null'],
      // QR-045 false-positive controls: a non-traversal `..` (git rev range,
      // brace-expansion range, double-dot inside a word) must keep working — the
      // bare-`..` block matches `..` only as a standalone path component, not
      // `..` flanked by word chars on both sides.
      ['git rev range HEAD..main', () => 'git log HEAD..main --oneline'],
      ['brace expansion range', () => 'echo {1..10}'],
      ['double-dot inside a filename', (d) => `cat ${d}/a..b.txt`],
    ];
    for (const [label, build] of allowCases) {
      it(`allows: ${label}`, () => {
        const dir = makeTmpDir();
        expect(runBash(dir, build(dir)).decision).toBe('allow');
      });
    }
  });

  it('Bash disabled by policy is denied regardless of command', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedMcpTools: [], bash: { enabled: false } },
      { tool_name: 'Bash', tool_input: { command: 'echo hi' } },
      dir,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('disabled');
  });

  it('Bash allowed but not path-restricted permits an out-of-sandbox path', () => {
    const dir = makeTmpDir();
    const result = runHookFull(
      { allowedPaths: [dir], allowedMcpTools: [], bash: { enabled: true } },
      { tool_name: 'Bash', tool_input: { command: 'cat ~/anything' } },
      dir,
    );
    // pathRestricted is falsy → no path scan applies; tilde is allowed.
    expect(result.decision).toBe('allow');
  });
});
