import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolRegistry } from '../../src/mcp/registry.ts';
import { SessionTokenRegistry } from '../../src/mcp/caller-attribution.ts';
import { registerM365WorkflowAuthorityTool } from '../../src/mcp/m365-workflow-authority.ts';
import { WhatSoupSocketServer } from '../../src/mcp/socket-server.ts';
import { resolveSessionContext, type SessionContext } from '../../src/mcp/types.ts';
import { createMicrosoft365Tool } from '../../src/mcp/tools/microsoft365.ts';

const FIXTURE = join(process.cwd(), 'tests/mcp/bin/fake-microsoft365-mcp.mjs');
const SESSION_TOKEN = 'session-token-not-for-output';

const tempDirectories: string[] = [];
const authorityServers: WhatSoupSocketServer[] = [];

afterEach(() => {
  for (const server of authorityServers.splice(0)) server.stop();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function makeTracePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'whatsoup-m365-tool-'));
  tempDirectories.push(directory);
  return join(directory, 'trace.jsonl');
}

function traceRows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type GroupMembershipAnswer = 'live' | 'no-live-members' | 'unknown';

/**
 * True once `pid` can no longer run. ESRCH means it is gone. Darwin leaves a killed orphan a
 * zombie until launchd reaps it, and kill(pid, 0) succeeds for a zombie, so a `Z` state from
 * `ps` counts as gone too. Any other answer, EPERM included, means the pid is still present.
 */
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
  }
  const listing = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1_000 });
  // macOS appends flag characters to the state letter, so only the first character counts.
  return listing.status === 0 && listing.stdout.trim().startsWith('Z');
}

/**
 * Delivers each group SIGKILL, then throws EPERM: the errno Darwin returns for a group kill
 * when every member left is an unreaped zombie (a post-close group kill returned EPERM in 8%
 * of 600 local trials). Records each process group id it was asked to kill.
 */
function epermOnGroupKill(groups: number[]) {
  const kill = process.kill;
  return vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
    if (pid < 0 && value === 'SIGKILL') {
      groups.push(-pid);
      try {
        kill.call(process, pid, value);
      } catch {
        // Deliberately ignored: the group may already be gone. The EPERM below is the case under test.
      }
      throw Object.assign(new Error('group kill failed'), { code: 'EPERM' });
    }
    return kill.call(process, pid, value);
  });
}

function resolvedSession(conversationKey = 'chat-a'): ReturnType<typeof resolveSessionContext> {
  const session: SessionContext = {
    tier: 'chat-scoped',
    conversationKey,
    deliveryJid: `${conversationKey}@lid`,
  };
  return resolveSessionContext(session, {
    actorJid: '15551230001@s.whatsapp.net',
    purpose: undefined,
    conversationKey,
    requestRef: `request-${conversationKey}`,
    workflowAuthority: {
      accountId: 'employee-account',
      employeeActorJid: '15551230001@s.whatsapp.net',
    },
  });
}

async function authorityForFixture(session: SessionContext, accountId: string, actorJid = '15551230001@s.whatsapp.net'): Promise<{
  socketPath: string;
  sessionToken: string;
  accountId: string;
} | undefined> {
  if (!session.conversationKey) return undefined;
  const directory = mkdtempSync(join(tmpdir(), 'whatsoup-m365-authority-'));
  tempDirectories.push(directory);
  const tokens = new SessionTokenRegistry();
  const registry = new ToolRegistry();
  registerM365WorkflowAuthorityTool(registry);
  const socketPath = join(directory, 'authority.sock');
  const sessionToken = tokens.mint({ kind: 'session', socketPath });
  const server = new WhatSoupSocketServer(
    socketPath,
    registry,
    { tier: 'chat-scoped', conversationKey: session.conversationKey, deliveryJid: session.deliveryJid },
    () => ({
      actorJid,
      purpose: undefined,
      conversationKey: session.conversationKey,
      requestRef: `request-${session.conversationKey}`,
      workflowAuthority: { accountId, employeeActorJid: '15551230001@s.whatsapp.net' },
    }),
    undefined,
    { sessionTokens: tokens },
  );
  authorityServers.push(server);
  await server.startAndWait();
  return { socketPath, sessionToken, accountId };
}

function makeTool(options: {
  trace: string;
  catalogVersion: string;
  accountId?: string;
  scenario?: string;
  catalogTool?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  probeGroup?: (pgid: number) => GroupMembershipAnswer;
  authorityForSession?: (session: SessionContext) => Promise<{
    socketPath: string;
    sessionToken: string;
    accountId: string;
    release?: () => void;
  } | undefined>;
  launchAllowed?: () => boolean;
}) {
  const accountId = options.accountId ?? 'employee-account';
  return createMicrosoft365Tool({
    launch: {
      command: process.execPath,
      args: [FIXTURE, '--fixed-plugin-launch-argument'],
      env: {
        FAKE_M365_TRACE: options.trace,
        FAKE_M365_SCENARIO: options.scenario ?? 'success',
        FAKE_M365_CATALOG_TOOL: options.catalogTool ?? 'list-mail-messages',
        WHATSOUP_MCP_SESSION_TOKEN: SESSION_TOKEN,
        MS365_AGENT365_ACCOUNT_ID: accountId,
        MS365_WORKFLOW_AUTHORITY_SOCKET: '/must-be-replaced-by-session.sock',
      },
      catalogVersion: options.catalogVersion,
      accountId,
    },
    authorityForSession: options.authorityForSession ?? ((session) => authorityForFixture(session, accountId)),
    launchAllowed: options.launchAllowed ?? (() => true),
    timeoutMs: options.timeoutMs ?? 1_000,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
    probeGroup: options.probeGroup,
  });
}

async function callTool(
  tool: ReturnType<typeof createMicrosoft365Tool>,
  params: Record<string, unknown>,
  session = resolvedSession(),
) {
  const registry = new ToolRegistry();
  registry.register(tool);
  return registry.call('microsoft365', params, session);
}

describe('createMicrosoft365Tool', () => {
  it('registers a conservative chat executor and forwards a call through stdio with the session authority', async () => {
    const trace = makeTracePath();
    const tool = makeTool({ trace, catalogVersion: 'protocol-v1' });

    expect(tool).toMatchObject({
      name: 'microsoft365',
      scope: 'chat',
      targetMode: 'caller-supplied',
      replayPolicy: 'unsafe',
      externalEffect: { kind: 'external' },
    });

    const result = await callTool(tool, {
      operation: 'call',
      name: 'list-mail-messages',
      args: { folderId: 'inbox' },
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ content: [{ type: 'text', text: 'called list-mail-messages' }] }, null, 2) }],
    });
    const rows = traceRows(trace);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'boot',
        argv: ['--fixed-plugin-launch-argument'],
        authorityRequired: '1',
        authoritySocket: expect.stringMatching(/authority\.sock$/),
        sessionToken: expect.any(String),
      }),
      expect.objectContaining({ event: 'request', method: 'initialize' }),
      expect.objectContaining({ event: 'request', method: 'notifications/initialized' }),
      expect.objectContaining({
        event: 'request',
        method: 'tools/call',
        params: { name: 'list-mail-messages', arguments: { folderId: 'inbox' } },
      }),
    ]));
  });

  it.each([
    ['refuses', () => false],
    ['throws', () => { throw new Error('launch check failed'); }],
  ])('starts no plugin process when the launch check %s after the authority resolved', async (_case, check) => {
    for (const operation of [{ operation: 'call', name: 'list-mail-messages', args: {} }, { operation: 'list' }]) {
      const trace = makeTracePath();
      const order: string[] = [];
      const release = vi.fn();
      const tool = makeTool({
        trace,
        catalogVersion: `launch-check-${Date.now()}-${Math.random()}`,
        authorityForSession: async (session) => {
          const authority = await authorityForFixture(session, 'employee-account');
          order.push('authority');
          return authority === undefined ? undefined : { ...authority, release };
        },
        launchAllowed: () => {
          order.push('launch-check');
          return check();
        },
      });

      const result = await callTool(tool, operation);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('microsoft365_authority_unavailable');
      // The check ran once, after the authority resolved, and its token was still retired.
      expect(order).toEqual(['authority', 'launch-check']);
      expect(release).toHaveBeenCalledOnce();
      expect(() => readFileSync(trace, 'utf8')).toThrow();
    }
  });

  it('rejects an incomplete call request before it starts the plugin process', async () => {
    const trace = makeTracePath();
    const tool = makeTool({ trace, catalogVersion: 'schema-v1' });

    const result = await callTool(tool, { operation: 'call', args: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/name/i);
    expect(() => readFileSync(trace, 'utf8')).toThrow();
  });

  it('keeps a tool catalogue cache only for its configured version and account', async () => {
    const firstTrace = makeTracePath();
    const sameVersionTrace = makeTracePath();
    const changedVersionTrace = makeTracePath();
    const version = `catalog-${Date.now()}-${Math.random()}`;

    const first = await callTool(
      makeTool({ trace: firstTrace, catalogVersion: version, catalogTool: 'v1-tool' }),
      { operation: 'list' },
    );
    const sameVersion = await callTool(
      makeTool({ trace: sameVersionTrace, catalogVersion: version, catalogTool: 'stale-tool' }),
      { operation: 'list' },
    );
    const changedVersion = await callTool(
      makeTool({ trace: changedVersionTrace, catalogVersion: `${version}-next`, catalogTool: 'v2-tool' }),
      { operation: 'list' },
    );

    expect(first.content[0]?.text).toContain('v1-tool');
    expect(sameVersion.content[0]?.text).toContain('v1-tool');
    expect(changedVersion.content[0]?.text).toContain('v2-tool');
    expect(() => readFileSync(sameVersionTrace, 'utf8')).toThrow();
  });

  it('does not share a catalogue between account-bound adapter instances with the same version', async () => {
    const firstTrace = makeTracePath();
    const secondTrace = makeTracePath();
    const version = `catalog-isolation-${Date.now()}-${Math.random()}`;

    const first = await callTool(
      makeTool({
        trace: firstTrace,
        catalogVersion: version,
        catalogTool: 'employee-one-tool',
        accountId: 'employee-account-one',
      }),
      { operation: 'list' },
    );
    const second = await callTool(
      makeTool({
        trace: secondTrace,
        catalogVersion: version,
        catalogTool: 'employee-two-tool',
        accountId: 'employee-account-two',
      }),
      { operation: 'list' },
    );

    expect(first.content[0]?.text).toContain('employee-one-tool');
    expect(second.content[0]?.text).toContain('employee-two-tool');
    expect(traceRows(secondTrace)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'request', method: 'tools/list' }),
    ]));
  });

  it('awaits and binds a fresh authority token for each chat call', async () => {
    const trace = makeTracePath();
    const tool = makeTool({ trace, catalogVersion: `context-${Date.now()}-${Math.random()}` });

    await callTool(tool, { operation: 'call', name: 'get-auth-status', args: {} }, resolvedSession('chat-one'));
    await callTool(tool, { operation: 'call', name: 'get-auth-status', args: {} }, resolvedSession('chat-two'));

    const sockets = traceRows(trace)
      .filter((row) => row.event === 'boot')
      .map((row) => row.authoritySocket);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]).toMatch(/authority\.sock$/);
    expect(sockets[1]).toMatch(/authority\.sock$/);
    expect(sockets[0]).not.toBe(sockets[1]);
    const sessionTokens = traceRows(trace)
      .filter((row) => row.event === 'boot')
      .map((row) => row.sessionToken);
    expect(sessionTokens).toHaveLength(2);
    expect(sessionTokens[0]).not.toBe(sessionTokens[1]);
  });

  it('revokes the request token once each call or listing settles, whatever its outcome', async () => {
    const tokens = new SessionTokenRegistry() as unknown as {
      mintLease(binding: Record<string, unknown>): { token: string; revoke(): void };
      verify(presented: unknown, socketPath: string): unknown;
      readonly liveCount: number;
    };
    const baseline = tokens.liveCount;
    const socketPath = '/tmp/whatsoup-authority-release.sock';
    const minted: string[] = [];
    const authorityForSession = async () => {
      const lease = tokens.mintLease({ kind: 'request', socketPath, conversationKey: 'chat-a', requestRef: 'request-chat-a' });
      minted.push(lease.token);
      return { socketPath, sessionToken: lease.token, accountId: 'employee-account', release: lease.revoke };
    };
    const cases = [
      { scenario: 'success', timeoutMs: 1_000, params: { operation: 'call', name: 'list-mail-messages', args: {} } },
      { scenario: 'tool-error', timeoutMs: 1_000, params: { operation: 'call', name: 'send-mail', args: {} } },
      { scenario: 'hang', timeoutMs: 75, params: { operation: 'call', name: 'send-mail', args: {} } },
    ];
    for (const { scenario, timeoutMs, params } of cases) {
      const tool = makeTool({ trace: makeTracePath(), catalogVersion: `release-${scenario}-${Date.now()}-${Math.random()}`, scenario, timeoutMs, authorityForSession });
      await callTool(tool, params);
    }
    // The second listing is served from the catalogue cache; its token must still be revoked.
    const lister = makeTool({ trace: makeTracePath(), catalogVersion: `release-list-${Date.now()}-${Math.random()}`, authorityForSession });
    await callTool(lister, { operation: 'list' });
    await callTool(lister, { operation: 'list' });

    expect(minted).toHaveLength(5);
    for (const token of minted) expect(tokens.verify(token, socketPath)).toBeUndefined();
    expect(tokens.liveCount).toBe(baseline);
  });

  it('revokes a request token whose authority resolves after the acquisition deadline', async () => {
    const tokens = new SessionTokenRegistry() as unknown as {
      mintLease(binding: Record<string, unknown>): { token: string; revoke(): void };
      readonly liveCount: number;
    };
    const baseline = tokens.liveCount;
    type LateAuthority = { socketPath: string; sessionToken: string; accountId: string; release: () => void };
    let resolveLate: ((authority: LateAuthority) => void) | undefined;
    const tool = makeTool({
      trace: makeTracePath(),
      catalogVersion: `release-late-${Date.now()}-${Math.random()}`,
      timeoutMs: 25,
      authorityForSession: () => new Promise<LateAuthority>((resolve) => { resolveLate = resolve; }),
    });

    const result = await callTool(tool, { operation: 'call', name: 'send-mail', args: {} });
    expect(result.content[0]?.text).toContain('microsoft365_authority_timeout');
    const lease = tokens.mintLease({ kind: 'request', socketPath: '/tmp/whatsoup-late.sock', conversationKey: 'chat-a', requestRef: 'request-chat-a' });
    resolveLate?.({ socketPath: '/tmp/whatsoup-late.sock', sessionToken: lease.token, accountId: 'employee-account', release: lease.revoke });

    await vi.waitFor(() => expect(tokens.liveCount).toBe(baseline));
  });

  it.each(['_agent365_operation_key', '_agent365_receipt'])(
    'refuses a call whose arguments carry the reserved %s key before acquiring authority or starting the plugin',
    async (key) => {
      const trace = makeTracePath();
      const authorityForSession = vi.fn(async () => undefined);
      const tool = makeTool({ trace, catalogVersion: `reserved-${Date.now()}-${Math.random()}`, authorityForSession });

      const result = await callTool(tool, { operation: 'call', name: 'send-mail', args: { subject: 'Hi', [key]: 'caller-chosen' } });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('microsoft365_invalid_request');
      expect(authorityForSession).not.toHaveBeenCalled();
      expect(() => readFileSync(trace, 'utf8')).toThrow();
    },
  );

  it.each(['select-account', 'select-dataverse-environment', 'Select-Account', ' select-account '])(
    'refuses the account or environment selection %j before acquiring authority or starting the plugin',
    async (name) => {
      const trace = makeTracePath();
      const authorityForSession = vi.fn(async () => undefined);
      const tool = makeTool({ trace, catalogVersion: `selection-${Date.now()}-${Math.random()}`, authorityForSession });

      const result = await callTool(tool, { operation: 'call', name, args: {} });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('microsoft365_invalid_request');
      expect(authorityForSession).not.toHaveBeenCalled();
      expect(() => readFileSync(trace, 'utf8')).toThrow();
    },
  );

  it('does not launch the plugin when asynchronous authority acquisition fails closed', async () => {
    const trace = makeTracePath();
    const tool = makeTool({
      trace,
      catalogVersion: `authority-${Date.now()}-${Math.random()}`,
      authorityForSession: async () => undefined,
    });

    const result = await callTool(tool, { operation: 'call', name: 'send-mail', args: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('microsoft365_authority_unavailable');
    expect(() => readFileSync(trace, 'utf8')).toThrow();
  });

  it('does not launch the pinned account plugin when the chat authority names another account', async () => {
    const trace = makeTracePath();
    const tool = makeTool({
      trace,
      catalogVersion: `account-mismatch-${Date.now()}-${Math.random()}`,
      authorityForSession: async () => ({
        socketPath: '/tmp/whatsoup-authority-chat-a.sock',
        sessionToken: `${SESSION_TOKEN}-chat-a`,
        accountId: 'other-employee-account',
      }),
    });

    const result = await callTool(tool, { operation: 'call', name: 'send-mail', args: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('microsoft365_account_mismatch');
    expect(() => readFileSync(trace, 'utf8')).toThrow();
  });

  it('bounds an authority acquisition that never resolves before launching the plugin', async () => {
    const trace = makeTracePath();
    const tool = makeTool({
      trace,
      catalogVersion: `authority-timeout-${Date.now()}-${Math.random()}`,
      timeoutMs: 25,
      authorityForSession: async () => new Promise<never>(() => {}),
    });

    const result = await callTool(tool, { operation: 'call', name: 'send-mail', args: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('microsoft365_authority_timeout');
    expect(() => readFileSync(trace, 'utf8')).toThrow();
  });

  it('reports plugin and JSON-RPC tool failures as tool errors without exposing child secrets', async () => {
    const toolErrorTrace = makeTracePath();
    const rpcErrorTrace = makeTracePath();

    const toolError = await callTool(
      makeTool({ trace: toolErrorTrace, catalogVersion: `tool-error-${Date.now()}-${Math.random()}`, scenario: 'tool-error' }),
      { operation: 'call', name: 'send-mail', args: {} },
    );
    const rpcError = await callTool(
      makeTool({ trace: rpcErrorTrace, catalogVersion: `rpc-error-${Date.now()}-${Math.random()}`, scenario: 'rpc-error' }),
      { operation: 'call', name: 'send-mail', args: {} },
    );

    expect(toolError.isError).toBe(true);
    expect(rpcError.isError).toBe(true);
    expect(toolError.content[0]?.text).not.toContain('tool-secret');
    expect(rpcError.content[0]?.text).not.toContain('rpc-secret');
    expect(toolError.content[0]?.text).toContain('microsoft365_tool_error');
    expect(rpcError.content[0]?.text).toContain('microsoft365_protocol_error');
  });

  it('bounds hanging plugin calls and reaps their process group', async () => {
    const trace = makeTracePath();
    // The deadline must not race the plugin's start: the hang row is awaited first, well inside the deadline.
    const pending = callTool(
      makeTool({ trace, catalogVersion: `timeout-${Date.now()}-${Math.random()}`, scenario: 'hang', timeoutMs: 2_000 }),
      { operation: 'call', name: 'send-mail', args: {} },
    );
    const hang = await vi.waitFor(() => {
      const row = traceRows(trace).find((candidate) => candidate.event === 'hang');
      expect(row).toBeDefined();
      return row;
    }, { timeout: 1_500 });
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('microsoft365_timeout');
    for (const pid of [hang?.pid, hang?.descendantPid]) {
      // A missing pid must fail here rather than reach the liveness wait below.
      expect(Number(pid)).toBeGreaterThan(0);
      // The killed descendant is an orphan that only launchd reaps; until then it is a zombie.
      await vi.waitFor(() => expect(pidGone(Number(pid))).toBe(true), { timeout: 1_000, interval: 20 });
    }
  });

  it('keeps the timeout when a group kill reports EPERM and the group has no live member', async () => {
    const trace = makeTracePath();
    const groups: number[] = [];
    const probeGroup = vi.fn((_pgid: number): GroupMembershipAnswer => 'no-live-members');
    const signal = epermOnGroupKill(groups);
    try {
      const pending = callTool(
        makeTool({ trace, catalogVersion: `timeout-eperm-${Date.now()}-${Math.random()}`, scenario: 'hang', timeoutMs: 2_000, probeGroup }),
        { operation: 'call', name: 'send-mail', args: {} },
      );
      const hang = await vi.waitFor(() => {
        const row = traceRows(trace).find((candidate) => candidate.event === 'hang');
        expect(row).toBeDefined();
        return row;
      }, { timeout: 1_500 });
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('microsoft365_timeout');
      expect(groups).toContain(Number(hang?.pid));
      expect(probeGroup).toHaveBeenCalledWith(Number(hang?.pid));
    } finally {
      signal.mockRestore();
    }
  });

  it.each([
    ['live', (): GroupMembershipAnswer => 'live'],
    ['unknown', (): GroupMembershipAnswer => 'unknown'],
    ['a thrown probe error', (): GroupMembershipAnswer => { throw new Error('probe failed'); }],
  ] as const)('keeps the timeout and reports unproven cleanup separately when a group kill reports EPERM and the probe answers %s', async (_case, answer) => {
    const trace = makeTracePath();
    const probeGroup = vi.fn(answer);
    const signal = epermOnGroupKill([]);
    try {
      const pending = callTool(
        makeTool({ trace, catalogVersion: `timeout-unproven-${Date.now()}-${Math.random()}`, scenario: 'hang', timeoutMs: 2_000, probeGroup }),
        { operation: 'call', name: 'send-mail', args: {} },
      );
      await vi.waitFor(() => expect(traceRows(trace).some((row) => row.event === 'hang')).toBe(true), { timeout: 1_500 });
      const result = await pending;

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
      expect(payload).toMatchObject({ error: 'microsoft365_timeout', cleanup: 'unproven' });
      expect(probeGroup).toHaveBeenCalled();
    } finally {
      signal.mockRestore();
    }
  });

  it('returns a completed call when a group kill reports EPERM and the group has no live member', async () => {
    const trace = makeTracePath();
    const groups: number[] = [];
    const probeGroup = vi.fn((_pgid: number): GroupMembershipAnswer => 'no-live-members');
    const signal = epermOnGroupKill(groups);
    try {
      const result = await callTool(
        makeTool({ trace, catalogVersion: `result-eperm-${Date.now()}-${Math.random()}`, probeGroup }),
        { operation: 'call', name: 'list-mail-messages', args: {} },
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain('called list-mail-messages');
      expect(groups.length).toBeGreaterThan(0);
      expect(probeGroup).toHaveBeenCalledWith(groups[0]);
    } finally {
      signal.mockRestore();
    }
  });

  it.each(['live', 'unknown'] as const)('reports a protocol error when a group kill reports EPERM and the group membership is %s', async (membership) => {
    const trace = makeTracePath();
    const signal = epermOnGroupKill([]);
    try {
      const result = await callTool(
        makeTool({
          trace,
          catalogVersion: `result-eperm-${membership}-${Date.now()}-${Math.random()}`,
          probeGroup: () => membership,
        }),
        { operation: 'call', name: 'list-mail-messages', args: {} },
      );

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({ error: 'microsoft365_protocol_error', cleanup: 'unproven' });
    } finally {
      signal.mockRestore();
    }
  });

  it.each(['EPERM', 'EINVAL'])('reports %s during process-group cleanup instead of returning success', async (code) => {
    const trace = makeTracePath();
    const kill = process.kill;
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
      if (pid < 0 && value === 'SIGTERM') throw Object.assign(new Error('signal failed'), { code });
      return kill.call(process, pid, value);
    });
    try {
      const result = await callTool(
        makeTool({ trace, catalogVersion: `cleanup-${code}` }),
        { operation: 'call', name: 'list-mail-messages', args: {} },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('microsoft365_protocol_error');
    } finally {
      signal.mockRestore();
    }
  });

  it('allows a completed process-group race during cleanup', async () => {
    const trace = makeTracePath();
    const kill = process.kill;
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
      const result = kill.call(process, pid, value);
      if (pid < 0 && value === 'SIGTERM') throw Object.assign(new Error('group exited'), { code: 'ESRCH' });
      return result;
    });
    try {
      const result = await callTool(
        makeTool({ trace, catalogVersion: 'cleanup-exited' }),
        { operation: 'call', name: 'list-mail-messages', args: {} },
      );
      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain('called list-mail-messages');
    } finally {
      signal.mockRestore();
    }
  });

  it.each([
    ['stdout-overflow', 'maxStdoutBytes'],
    ['stderr-overflow', 'maxStderrBytes'],
  ] as const)('caps %s without returning child output', async (scenario, _limit) => {
    const trace = makeTracePath();
    const result = await callTool(
      makeTool({
        trace,
        catalogVersion: `${scenario}-${Date.now()}-${Math.random()}`,
        scenario,
        maxStdoutBytes: 128,
        maxStderrBytes: 128,
      }),
      { operation: 'call', name: 'send-mail', args: {} },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('microsoft365_output_limit');
    expect(result.content[0]?.text).not.toContain('x'.repeat(32));
  });
});
