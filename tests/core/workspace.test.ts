import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, readFileSync, lstatSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chatJidToWorkspace, provisionWorkspace } from '../../src/core/workspace.ts';
import { toConversationKey } from '../../src/core/conversation-key.ts';
import type { ProvisionOptions } from '../../src/core/workspace.ts';

const CWD = '/instances/test-bot';

describe('chatJidToWorkspace', () => {
  it('DM @s.whatsapp.net: kind=dm, key=phone, path ends with users/<phone>', () => {
    const result = chatJidToWorkspace(CWD, '15550100001@s.whatsapp.net');
    expect(result.kind).toBe('dm');
    expect(result.workspaceKey).toBe('15550100001');
    expect(result.workspacePath.endsWith('users/15550100001')).toBe(true);
  });

  it('DM @lid with :device qualifier: kind=dm, key strips device, path ends with users/<lid>', () => {
    const result = chatJidToWorkspace(CWD, '81536414179557:2@lid');
    expect(result.kind).toBe('dm');
    expect(result.workspaceKey).toBe('81536414179557');
    expect(result.workspacePath.endsWith('users/81536414179557')).toBe(true);
  });

  it('DM @lid without device qualifier: same key as with :device (LID equivalence)', () => {
    const result = chatJidToWorkspace(CWD, '81536414179557@lid');
    expect(result.kind).toBe('dm');
    expect(result.workspaceKey).toBe('81536414179557');
    expect(result.workspacePath.endsWith('users/81536414179557')).toBe(true);
  });

  it('Group @g.us: kind=group, key=sanitized JID, path ends with groups/<sanitized>', () => {
    const result = chatJidToWorkspace(CWD, '111111100000000002@g.us');
    expect(result.kind).toBe('group');
    expect(result.workspaceKey).toBe('111111100000000002_at_g.us');
    expect(result.workspacePath.endsWith('groups/111111100000000002_at_g.us')).toBe(true);
  });

  it('uses path.join to produce absolute paths from instanceCwd', () => {
    const result = chatJidToWorkspace(CWD, '15550100001@s.whatsapp.net');
    expect(result.workspacePath).toBe(join(CWD, 'users', '15550100001'));
  });
});

describe('toConversationKey (LID canonicalization)', () => {
  it('returns same key for @lid with and without :device qualifier', () => {
    const withDevice = toConversationKey('81536414179557:2@lid');
    const withoutDevice = toConversationKey('81536414179557@lid');
    expect(withDevice).toBe(withoutDevice);
    expect(withDevice).toBe('81536414179557');
  });
});

describe('provisionWorkspace', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true });
    }
    tmpDirs = [];
  });

  function makeTmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'ws-test-'));
    tmpDirs.push(d);
    return d;
  }

  function makeOpts(workspacePath: string, instanceCwd: string): ProvisionOptions {
    return {
      workspacePath,
      instanceCwd,
      sandbox: {
        allowedPaths: ['/some/other/path'],
        allowedTools: ['Read', 'Write'],
        allowedMcpTools: ['whatsoup'],
        bash: { enabled: true, pathRestricted: true },
      },
      hookPath: '/abs/path/to/agent-sandbox.sh',
      pollLintHookPath: '/abs/path/to/poll-interaction-lint.mjs',
      postToolUseLogHookPath: '/abs/path/to/post-tool-use-log.sh',
      mcpServerPath: '/abs/path/to/whatsoup-proxy.ts',
    };
  }

  it('creates .claude/ directory and all control files', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    provisionWorkspace(makeOpts(workspacePath, instanceCwd));

    // Verify files exist via readFileSync (throws if missing)
    readFileSync(join(workspacePath, '.claude', 'sandbox-policy.json'), 'utf8');
    readFileSync(join(workspacePath, '.claude', 'settings.json'), 'utf8');
    readFileSync(join(workspacePath, '.mcp.json'), 'utf8');
    const symlinkStat = lstatSync(join(workspacePath, 'CLAUDE.md'));
    expect(symlinkStat.isSymbolicLink()).toBe(true);
  });

  it('refuses to provision through a pre-existing .claude directory symlink', () => {
    const workspacePath = makeTmp();
    const targetDir = makeTmp();
    const instanceCwd = makeTmp();
    symlinkSync(targetDir, join(workspacePath, '.claude'), 'dir');

    expect(() => provisionWorkspace(makeOpts(workspacePath, instanceCwd))).toThrow(/directory.*symlink/);
    expect(existsSync(join(targetDir, 'sandbox-policy.json'))).toBe(false);
    expect(existsSync(join(targetDir, 'settings.json'))).toBe(false);
  });

  it('.mcp.json is written with mode 0600', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    provisionWorkspace(makeOpts(workspacePath, instanceCwd));

    const mcpPath = join(workspacePath, '.mcp.json');
    const stat = statSync(mcpPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('refuses to write .mcp.json through a pre-existing symlink', () => {
    const workspacePath = makeTmp();
    const decoy = makeTmp();
    const instanceCwd = makeTmp();
    const decoyTarget = join(decoy, 'attacker-target');
    // Create symlink at the .mcp.json path pointing to an attacker-controlled file
    symlinkSync(decoyTarget, join(workspacePath, '.mcp.json'));

    expect(() => provisionWorkspace(makeOpts(workspacePath, instanceCwd))).toThrow();
    // The symlink target was never created
    expect(existsSync(decoyTarget)).toBe(false);
  });

  it('rewriting .mcp.json preserves mode 0600 and replaces content', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    const opts = makeOpts(workspacePath, instanceCwd);
    provisionWorkspace(opts);

    const opts2 = { ...opts, mcpServerPath: '/new/path/to/proxy.ts' };
    provisionWorkspace(opts2);

    const mcpPath = join(workspacePath, '.mcp.json');
    const stat = statSync(mcpPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    expect(mcp.mcpServers.whatsoup.args).toContain('/new/path/to/proxy.ts');
  });

  it('sandbox-policy.json has workspacePath in allowedPaths, inherits bash/allowedTools/allowedMcpTools from input', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    const opts = makeOpts(workspacePath, instanceCwd);
    provisionWorkspace(opts);

    const policy = JSON.parse(readFileSync(join(workspacePath, '.claude', 'sandbox-policy.json'), 'utf8'));
    expect(policy.allowedPaths).toEqual([workspacePath]);
    expect(policy.allowedTools).toEqual(opts.sandbox.allowedTools);
    expect(policy.allowedMcpTools).toEqual(opts.sandbox.allowedMcpTools);
    expect(policy.bash).toEqual(opts.sandbox.bash);
  });

  it('settings.json contains enforcement and poll diagnostics hooks', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    const opts = makeOpts(workspacePath, instanceCwd);
    provisionWorkspace(opts);

    const settings = JSON.parse(readFileSync(join(workspacePath, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(opts.hookPath);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(opts.pollLintHookPath);
    expect(settings.hooks.PostToolUse[0].hooks[1].command).toBe(opts.postToolUseLogHookPath);
    expect(settings.hooks.PostToolUseFailure[0].hooks[0].command).toBe(opts.postToolUseLogHookPath);
  });

  it('.mcp.json contains the mcpServerPath and socket path under .claude/ (whatsoup.sock)', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    const opts = makeOpts(workspacePath, instanceCwd);
    provisionWorkspace(opts);

    const mcp = JSON.parse(readFileSync(join(workspacePath, '.mcp.json'), 'utf8'));
    const server = mcp.mcpServers['whatsoup'];
    expect(server).toBeDefined();
    expect(server.args).toContain(opts.mcpServerPath);
    // Socket path uses whatsoup.sock, not media-bridge.sock
    expect(server.env.WHATSOUP_SOCKET).toContain(join(workspacePath, '.claude'));
    expect(server.env.WHATSOUP_SOCKET).toContain('whatsoup.sock');
  });

  it('CLAUDE.md is a symlink pointing to instanceCwd/CLAUDE.md', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    provisionWorkspace(makeOpts(workspacePath, instanceCwd));

    const symlinkPath = join(workspacePath, 'CLAUDE.md');
    const stat = lstatSync(symlinkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    // readlinkSync gives the raw symlink target string
    expect(readlinkSync(symlinkPath)).toBe(join(instanceCwd, 'CLAUDE.md'));
  });

  it('calling provisionWorkspace twice overwrites files (deterministic rewrite)', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    const opts = makeOpts(workspacePath, instanceCwd);
    provisionWorkspace(opts);

    // Modify hook paths and re-provision.
    const opts2 = {
      ...opts,
      hookPath: '/new/path/to/hook.sh',
      pollLintHookPath: '/new/path/to/poll-interaction-lint.mjs',
      postToolUseLogHookPath: '/new/path/to/post-tool-use-log.sh',
    };
    provisionWorkspace(opts2);

    const settings = JSON.parse(readFileSync(join(workspacePath, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('/new/path/to/hook.sh');
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe('/new/path/to/poll-interaction-lint.mjs');
    expect(settings.hooks.PostToolUse[0].hooks[1].command).toBe('/new/path/to/post-tool-use-log.sh');
    expect(settings.hooks.PostToolUseFailure[0].hooks[0].command).toBe('/new/path/to/post-tool-use-log.sh');
  });

  it('returns the socket path (ends with .claude/whatsoup.sock)', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    const socketPath = provisionWorkspace(makeOpts(workspacePath, instanceCwd));

    expect(socketPath).toBe(join(workspacePath, '.claude', 'whatsoup.sock'));
  });

  it('bash.pathRestricted is preserved in the generated sandbox policy', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    const opts: ProvisionOptions = {
      ...makeOpts(workspacePath, instanceCwd),
      sandbox: {
        allowedPaths: ['/irrelevant'],
        allowedTools: ['Read'],
        bash: { enabled: false, pathRestricted: false },
      },
    };
    provisionWorkspace(opts);

    const policy = JSON.parse(readFileSync(join(workspacePath, '.claude', 'sandbox-policy.json'), 'utf8'));
    expect(policy.bash.enabled).toBe(false);
    expect(policy.bash.pathRestricted).toBe(false);
  });
});
