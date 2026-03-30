import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chatJidToWorkspace, provisionWorkspace } from '../../src/core/workspace.ts';
import { toConversationKey } from '../../src/core/conversation-key.ts';
import type { ProvisionOptions } from '../../src/core/workspace.ts';

const CWD = '/instances/test-bot';

describe('chatJidToWorkspace', () => {
  it('DM @s.whatsapp.net: kind=dm, key=phone, path ends with users/<phone>', () => {
    const result = chatJidToWorkspace(CWD, '18459780919@s.whatsapp.net');
    expect(result.kind).toBe('dm');
    expect(result.workspaceKey).toBe('18459780919');
    expect(result.workspacePath.endsWith('users/18459780919')).toBe(true);
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
    const result = chatJidToWorkspace(CWD, '120363423809065844@g.us');
    expect(result.kind).toBe('group');
    expect(result.workspaceKey).toBe('120363423809065844_at_g.us');
    expect(result.workspacePath.endsWith('groups/120363423809065844_at_g.us')).toBe(true);
  });

  it('uses path.join to produce absolute paths from instanceCwd', () => {
    const result = chatJidToWorkspace(CWD, '18459780919@s.whatsapp.net');
    expect(result.workspacePath).toBe(join(CWD, 'users', '18459780919'));
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

  it('settings.json contains the hookPath', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    const opts = makeOpts(workspacePath, instanceCwd);
    provisionWorkspace(opts);

    const settings = JSON.parse(readFileSync(join(workspacePath, '.claude', 'settings.json'), 'utf8'));
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    expect(command).toBe(opts.hookPath);
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

    // Modify hookPath and re-provision
    const opts2 = { ...opts, hookPath: '/new/path/to/hook.sh' };
    provisionWorkspace(opts2);

    const settings = JSON.parse(readFileSync(join(workspacePath, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('/new/path/to/hook.sh');
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
