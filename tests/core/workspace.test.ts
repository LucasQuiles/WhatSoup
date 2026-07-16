import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, readFileSync, lstatSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  chatJidToWorkspace,
  provisionWorkspace,
  buildMcpAllowlist,
  writeSandboxArtifacts,
  writePermissionsSettings,
  ensurePermissionsSettings,
} from '../../src/core/workspace.ts';
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

  it('writes opencode.json shape for opencode-cli sandbox workspaces', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    const opts = {
      ...makeOpts(workspacePath, instanceCwd),
      provider: 'opencode-cli',
      sendMediaServerPath: '/abs/path/to/send-media-server.ts',
    };
    provisionWorkspace(opts);

    expect(existsSync(join(workspacePath, '.mcp.json'))).toBe(false);
    const opencode = JSON.parse(readFileSync(join(workspacePath, 'opencode.json'), 'utf8'));
    expect(opencode).toHaveProperty('mcp.whatsoup');
    expect(opencode).toHaveProperty('mcp.send-media');
    expect(opencode.mcp.whatsoup.type).toBe('local');
    expect(opencode.mcp.whatsoup.environment.WHATSOUP_SOCKET).toBe(
      join(workspacePath, '.claude', 'whatsoup.sock'),
    );
    expect(opencode.mcp['send-media'].environment.MEDIA_BRIDGE_SOCKET).toBe(
      join(workspacePath, '.claude', 'media-bridge.sock'),
    );
    expect(opencode).not.toHaveProperty('mcpServers');
  });

  it('writes custom endpoint provider config for opencode-cli sandbox workspaces', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    provisionWorkspace({
      ...makeOpts(workspacePath, instanceCwd),
      provider: 'opencode-cli',
      providerConfig: {
        baseUrl: 'https://api.example.invalid/v1',
        model: 'model-a',
        apiKeyService: 'openai',
      },
      sendMediaServerPath: '/abs/path/to/send-media-server.ts',
    });

    const opencode = JSON.parse(readFileSync(join(workspacePath, 'opencode.json'), 'utf8'));
    expect(opencode.model).toBe('whatsoup-cloud/model-a');
    expect(opencode.provider['whatsoup-cloud']).toEqual({
      options: {
        baseURL: 'https://api.example.invalid/v1',
        apiKey: '{env:OPENAI_API_KEY}',
      },
      models: { 'model-a': {} },
    });
    expect(opencode).toHaveProperty('mcp.whatsoup');
    expect(opencode).toHaveProperty('mcp.send-media');
  });

  it('merges opencode sandbox MCP entries without clobbering existing opencode.json', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    writeFileSync(
      join(workspacePath, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'usercloud/model-a',
        provider: {
          usercloud: {
            options: { baseURL: 'https://user.example/v1' },
            models: { 'model-a': {} },
          },
        },
        mcp: {
          custom: { type: 'local', command: ['custom'], enabled: true },
        },
      }),
    );

    provisionWorkspace({
      ...makeOpts(workspacePath, instanceCwd),
      provider: 'opencode-cli',
      sendMediaServerPath: '/abs/path/to/send-media-server.ts',
    });

    const opencode = JSON.parse(readFileSync(join(workspacePath, 'opencode.json'), 'utf8'));
    expect(opencode.$schema).toBe('https://opencode.ai/config.json');
    expect(opencode.model).toBe('usercloud/model-a');
    expect(opencode.provider.usercloud).toEqual({
      options: { baseURL: 'https://user.example/v1' },
      models: { 'model-a': {} },
    });
    expect(opencode.mcp.custom).toEqual({ type: 'local', command: ['custom'], enabled: true });
    expect(opencode.mcp.whatsoup).toMatchObject({
      type: 'local',
      environment: { WHATSOUP_SOCKET: join(workspacePath, '.claude', 'whatsoup.sock') },
      enabled: true,
    });
    expect(opencode.mcp['send-media']).toMatchObject({
      type: 'local',
      environment: { MEDIA_BRIDGE_SOCKET: join(workspacePath, '.claude', 'media-bridge.sock') },
      enabled: true,
    });
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

  it('fails workspace provisioning closed when opencode.json is a symlink', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    const victimDir = makeTmp();
    const victim = join(victimDir, 'victim.json');
    writeFileSync(victim, '{"untouched":true}');
    symlinkSync(victim, join(workspacePath, 'opencode.json'));

    // Provisioning must not read or write existing config through the symlink,
    // and it must not continue into an implicit/default OpenCode profile.
    expect(() =>
      provisionWorkspace({
        ...makeOpts(workspacePath, instanceCwd),
        provider: 'opencode-cli',
      }),
    ).toThrow(/OpenCode configuration.*non-symlink/i);

    expect(readFileSync(victim, 'utf8')).toBe('{"untouched":true}');
    expect(lstatSync(join(workspacePath, 'opencode.json')).isSymbolicLink()).toBe(true);
  });

  it('fails workspace provisioning closed without overwriting corrupt opencode.json', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    writeFileSync(join(workspacePath, 'opencode.json'), 'not json{');

    expect(() =>
      provisionWorkspace({
        ...makeOpts(workspacePath, instanceCwd),
        provider: 'opencode-cli',
        sendMediaServerPath: '/abs/path/to/send-media-server.ts',
      }),
    ).toThrow('Existing OpenCode configuration must be a valid JSON object');

    expect(readFileSync(join(workspacePath, 'opencode.json'), 'utf8')).toBe('not json{');
  });

  it('prunes stale whatsoup-cloud provider/model but preserves sibling mcp entries and unrelated top-level keys', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    writeFileSync(
      join(workspacePath, 'opencode.json'),
      JSON.stringify({
        unrelated: 'preserved',
        provider: { 'whatsoup-cloud': { options: { baseURL: 'https://old.example/v1' } } },
        model: 'whatsoup-cloud/old-model',
        mcp: { other: { type: 'local', command: ['other'], enabled: true } },
      }),
    );

    provisionWorkspace({
      ...makeOpts(workspacePath, instanceCwd),
      provider: 'opencode-cli',
      sendMediaServerPath: '/abs/path/to/send-media-server.ts',
    });

    const opencode = JSON.parse(readFileSync(join(workspacePath, 'opencode.json'), 'utf8'));
    // Sibling MCP and unrelated key survive
    expect(opencode.mcp.other).toEqual({ type: 'local', command: ['other'], enabled: true });
    expect(opencode.unrelated).toBe('preserved');
    // Stale provider and model pruned
    expect(opencode).not.toHaveProperty('provider.whatsoup-cloud');
    expect(opencode).not.toHaveProperty('model');
    // Managed MCP entries are present
    expect(opencode).toHaveProperty('mcp.whatsoup');
  });
});

describe('workspace.ts uncovered-branch coverage', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  function makeTmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'ws-test-cov-'));
    tmpDirs.push(d);
    return d;
  }

  // --- chatJidToWorkspace fallback branch (lines 61-66) ---

  it('chatJidToWorkspace falls back to dm/users for a non-personal, non-group JID', () => {
    const result = chatJidToWorkspace(CWD, 'status@broadcast');
    expect(result.kind).toBe('dm');
    expect(result.workspaceKey).toBe('status_at_broadcast');
    expect(result.workspacePath).toBe(join(CWD, 'users', 'status_at_broadcast'));
  });

  // --- buildMcpAllowlist (lines 95-101) ---

  it('buildMcpAllowlist prefixes chat-scoped tool names with mcp__whatsoup__ (no media)', () => {
    const list = buildMcpAllowlist(['send_message', 'ask_user'], false);
    expect(list).toEqual([
      'mcp__whatsoup__send_message',
      'mcp__whatsoup__ask_user',
    ]);
    expect(list).not.toContain('mcp__send-media__send_media');
  });

  it('buildMcpAllowlist appends send-media tool when includeSendMedia is true', () => {
    const list = buildMcpAllowlist(['send_message'], true);
    expect(list).toEqual(['mcp__whatsoup__send_message', 'mcp__send-media__send_media']);
  });

  it('buildMcpAllowlist handles an empty chat-scoped list with media appended', () => {
    const list = buildMcpAllowlist([], true);
    expect(list).toEqual(['mcp__send-media__send_media']);
  });

  // --- writeSandboxArtifacts branches (lines 133-161) ---

  it('writeSandboxArtifacts writes only PreToolUse when no optional hooks are given', () => {
    const claudeDir = makeTmp();
    const policy = { allowedPaths: ['/x'], allowedTools: ['Read'] };
    writeSandboxArtifacts(claudeDir, policy, '/hooks/agent-sandbox.sh');

    const policyFile = JSON.parse(readFileSync(join(claudeDir, 'sandbox-policy.json'), 'utf8'));
    expect(policyFile).toEqual(policy);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('/hooks/agent-sandbox.sh');
    expect(settings.hooks).not.toHaveProperty('PostToolUse');
    expect(settings.hooks).not.toHaveProperty('PostToolUseFailure');
  });

  it('writeSandboxArtifacts wires PostToolUse when only pollLintHookPath is given', () => {
    const claudeDir = makeTmp();
    writeSandboxArtifacts(
      claudeDir,
      { allowedPaths: [] },
      '/hooks/agent-sandbox.sh',
      '/hooks/poll.mjs',
    );

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.PostToolUse[0].hooks).toEqual([
      { type: 'command', command: '/hooks/poll.mjs' },
    ]);
    expect(settings.hooks).not.toHaveProperty('PostToolUseFailure');
  });

  it('writeSandboxArtifacts writes PostToolUseFailure only when postToolUseLogHookPath is given', () => {
    const claudeDir = makeTmp();
    writeSandboxArtifacts(
      claudeDir,
      { allowedPaths: [] },
      '/hooks/agent-sandbox.sh',
      undefined,
      '/hooks/log.sh',
    );

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.hooks.PostToolUse[0].hooks).toEqual([
      { type: 'command', command: '/hooks/log.sh' },
    ]);
    expect(settings.hooks.PostToolUseFailure[0].hooks[0].command).toBe('/hooks/log.sh');
  });

  it('writeSandboxArtifacts rethrows (logged) when claudeDir is missing', () => {
    const missingParent = join(makeTmp(), 'does-not-exist');
    expect(() =>
      writeSandboxArtifacts(missingParent, { allowedPaths: [] }, '/hooks/x.sh'),
    ).toThrow();
    expect(existsSync(join(missingParent, 'settings.json'))).toBe(false);
  });

  // --- writePermissionsSettings branches (lines 170-202) ---

  it('writePermissionsSettings creates a fresh settings.json with deny floor when none exists', () => {
    const claudeDir = makeTmp();
    writePermissionsSettings(claudeDir, {
      permissions: {
        allow: ['Read'],
        deny: ['custom-deny'],
        defaultMode: 'bypassPermissions',
      },
    });

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.permissions.allow).toEqual(['Read']);
    expect(out.permissions.deny).toContain('custom-deny');
    // deny floor unioned
    expect(out.permissions.deny).toContain('mcp__claude_ai_Gmail__create_draft');
    expect(out.permissions.defaultMode).toBe('bypassPermissions');
    expect(out).not.toHaveProperty('enabledPlugins');
  });

  it('writePermissionsSettings merges into an existing settings.json preserving hooks', () => {
    const claudeDir = makeTmp();
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [] }] } }),
    );

    writePermissionsSettings(claudeDir, {
      permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' },
    });

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.hooks.PreToolUse[0].matcher).toBe('');
    expect(out.permissions.allow).toEqual(['Bash']);
    expect(out.permissions.deny.length).toBeGreaterThan(0);
  });

  it('writePermissionsSettings overwrites a corrupt existing settings.json', () => {
    const claudeDir = makeTmp();
    writeFileSync(join(claudeDir, 'settings.json'), 'not-valid-json{{{');

    writePermissionsSettings(claudeDir, {
      permissions: { allow: ['Read'], deny: [], defaultMode: 'bypassPermissions' },
    });

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.permissions.allow).toEqual(['Read']);
  });

  it('writePermissionsSettings writes enabledPlugins when provided', () => {
    const claudeDir = makeTmp();
    writePermissionsSettings(claudeDir, {
      permissions: { allow: [], deny: [], defaultMode: 'bypassPermissions' },
      enabledPlugins: { foo: true, bar: false },
    });

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.enabledPlugins).toEqual({ foo: true, bar: false });
  });

  it('writePermissionsSettings resets enabledPlugins to {} when null is passed', () => {
    const claudeDir = makeTmp();
    // The runtime accepts null to mean "reset to global inheritance" (line 195: `?? {}`),
    // even though the TS type does not include null. Cast through unknown to exercise
    // the runtime branch without weakening the assertion.
    const settings = {
      permissions: { allow: [], deny: [], defaultMode: 'bypassPermissions' as const },
      enabledPlugins: null,
    } as unknown as Parameters<typeof writePermissionsSettings>[1];
    writePermissionsSettings(claudeDir, settings);

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.enabledPlugins).toEqual({});
  });

  // --- ensurePermissionsSettings branches (lines 215-266) ---

  it('ensurePermissionsSettings is a no-op for non-agent types', () => {
    const claudeDir = makeTmp();
    ensurePermissionsSettings(claudeDir, 'chat');
    expect(existsSync(join(claudeDir, 'settings.json'))).toBe(false);
  });

  it('ensurePermissionsSettings writes defaults when no settings.json exists', () => {
    const claudeDir = makeTmp();
    ensurePermissionsSettings(claudeDir, 'agent');

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.permissions.defaultMode).toBe('bypassPermissions');
    expect(out.permissions.allow).toContain('Bash');
    expect(out.permissions.deny).toContain('mcp__claude_ai_Gmail__create_draft');
  });

  it('ensurePermissionsSettings writes defaults + enabledPlugins when none exist and plugins provided', () => {
    const claudeDir = makeTmp();
    ensurePermissionsSettings(claudeDir, 'agent', { myPlugin: true });

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.enabledPlugins).toEqual({ myPlugin: true });
    expect(out.permissions.defaultMode).toBe('bypassPermissions');
  });

  it('ensurePermissionsSettings leaves existing settings with permissions alone (no plugins)', () => {
    const claudeDir = makeTmp();
    const original = {
      permissions: { allow: ['CustomTool'], deny: [], defaultMode: 'bypassPermissions' },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(original));

    ensurePermissionsSettings(claudeDir, 'agent');

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.permissions.allow).toEqual(['CustomTool']);
    expect(out).not.toHaveProperty('enabledPlugins');
  });

  it('ensurePermissionsSettings adds default permissions to existing settings lacking them', () => {
    const claudeDir = makeTmp();
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [] } }),
    );

    ensurePermissionsSettings(claudeDir, 'agent');

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.hooks.PreToolUse).toEqual([]);
    expect(out.permissions.defaultMode).toBe('bypassPermissions');
  });

  it('ensurePermissionsSettings rewrites enabledPlugins + deny floor when plugins provided on existing perms', () => {
    const claudeDir = makeTmp();
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: ['X'],
          deny: ['mcp__claude_ai_Gmail__create_draft'],
          defaultMode: 'bypassPermissions',
        },
      }),
    );

    ensurePermissionsSettings(claudeDir, 'agent', { newPlugin: true });

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.enabledPlugins).toEqual({ newPlugin: true });
    expect(out.permissions.allow).toEqual(['X']);
    // deny floor re-applied (unioned)
    expect(out.permissions.deny).toContain('mcp__claude_ai_Gmail__create_draft');
    expect(out.permissions.deny).toContain('mcp__plugin_microsoft_365_microsoft_365__send-mail');
  });

  it('ensurePermissionsSettings adds default permissions to existing settings lacking them when plugins provided', () => {
    const claudeDir = makeTmp();
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [] } }),
    );

    ensurePermissionsSettings(claudeDir, 'agent', { newPlugin: true });

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.enabledPlugins).toEqual({ newPlugin: true });
    expect(out.permissions.defaultMode).toBe('bypassPermissions');
  });

  it('ensurePermissionsSettings overwrites a corrupt existing settings.json with defaults', () => {
    const claudeDir = makeTmp();
    writeFileSync(join(claudeDir, 'settings.json'), 'corrupt{{{');

    ensurePermissionsSettings(claudeDir, 'agent', { myPlugin: true });

    const out = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(out.permissions.defaultMode).toBe('bypassPermissions');
    expect(out.enabledPlugins).toEqual({ myPlugin: true });
  });
});
