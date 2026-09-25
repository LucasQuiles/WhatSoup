import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../../helpers/child-process.ts');
  return childProcessMock();
});

import {
  handleConfigUpdate,
  handleCreateLine,
  type OpsDeps,
} from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

const DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SYNTHETIC_PHONE = ['1555', '020', '0001'].join('');

function syntheticPublicKey(): string {
  return Buffer.concat([DER_PREFIX, Buffer.alloc(32, 13)]).toString('base64url');
}

function policy(conversationKey: string, privateTerm = 'restricted') {
  return {
    conversationKey,
    maxCodePoints: 500,
    maxQuestionMarks: 1,
    blockedTerms: [{ value: privateTerm, match: 'whole_word', caseSensitive: false }],
    rejectInternalArtifacts: true,
    rejectWhatsAppJids: true,
    authorization: {
      keyId: 'synthetic-key',
      publicKey: syntheticPublicKey(),
      requiredActions: ['send_message'],
    },
  };
}

const INVALID_POLICY_CASES: readonly {
  id: string;
  label: string;
  policies: unknown;
}[] = [
  {
    id: 'duplicate-policy',
    label: 'a duplicate policy conversation key',
    policies: [policy('duplicate-key'), policy('duplicate-key')],
  },
  {
    id: 'duplicate-term',
    label: 'a duplicate blocked term',
    policies: [{
      ...policy('duplicate-term'),
      blockedTerms: [
        { value: 'duplicate', match: 'substring', caseSensitive: false },
        { value: 'DUPLICATE', match: 'substring', caseSensitive: false },
      ],
    }],
  },
  {
    id: 'unknown-policy',
    label: 'an unknown policy field',
    policies: [{ ...policy('unknown-policy'), unsupportedPolicyField: true }],
  },
  {
    id: 'unknown-term',
    label: 'an unknown blocked-term field',
    policies: [{
      ...policy('unknown-term'),
      blockedTerms: [{
        value: 'restricted',
        match: 'whole_word',
        caseSensitive: false,
        unsupportedTermField: true,
      }],
    }],
  },
  {
    id: 'unknown-auth',
    label: 'an unknown authorization field',
    policies: [{
      ...policy('unknown-authorization'),
      authorization: {
        keyId: 'synthetic-key',
        publicKey: syntheticPublicKey(),
        requiredActions: ['send_message'],
        unsupportedAuthorizationField: true,
      },
    }],
  },
  {
    id: 'policy-count',
    label: 'the policy-count bound',
    policies: Array.from({ length: 33 }, (_, index) => policy(`policy-${index}`)),
  },
  {
    id: 'max-codepoints',
    label: 'the maxCodePoints bound',
    policies: [{ ...policy('max-codepoints'), maxCodePoints: 4001 }],
  },
  {
    id: 'max-questions',
    label: 'the maxQuestionMarks bound',
    policies: [{ ...policy('max-questions'), maxQuestionMarks: 21 }],
  },
  {
    id: 'term-count',
    label: 'the blockedTerms-count bound',
    policies: [{
      ...policy('term-count'),
      blockedTerms: Array.from({ length: 65 }, (_, index) => ({
        value: `term-${index}`,
        match: 'whole_word',
        caseSensitive: false,
      })),
    }],
  },
  {
    id: 'term-value',
    label: 'the blocked-term-value bound',
    policies: [{
      ...policy('term-value'),
      blockedTerms: [{
        value: 'x'.repeat(129),
        match: 'whole_word',
        caseSensitive: false,
      }],
    }],
  },
];

describe('fleet client-output policy config admission and projection', () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-policy-routes-'));
    savedEnv = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    process.env.HOME = path.join(tmpDir, 'home');
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
    fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function configDir(name: string): string {
    return path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', name);
  }

  function configPath(name: string): string {
    return path.join(configDir(name), 'config.json');
  }

  function createDeps(): OpsDeps {
    return makeDeps<any>({});
  }

  function patchDeps(name: string, targetPath: string): OpsDeps {
    const instance: DiscoveredInstance = {
      name,
      type: 'agent',
      accessMode: 'self_only',
      healthPort: 9095,
      dbPath: path.join(tmpDir, 'bot.db'),
      stateRoot: path.join(tmpDir, 'state'),
      logDir: path.join(tmpDir, 'logs'),
      healthToken: null,
      configPath: targetPath,
      socketPath: null,
    };
    return makeDeps<any>({
      discovery: { getInstance: vi.fn(() => instance) },
    });
  }

  function writeAgent(name: string, clientOutputPolicies: unknown): string {
    const targetPath = configPath(name);
    const agentCwd = path.join(process.env.HOME!, 'workspace');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(agentCwd, { recursive: true, mode: 0o700 });
    fs.writeFileSync(targetPath, JSON.stringify({
      name,
      type: 'agent',
      adminPhones: [SYNTHETIC_PHONE],
      accessMode: 'self_only',
      healthPort: 9095,
      agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
      clientOutputPolicies,
    }, null, 2) + '\n');
    return targetPath;
  }

  it('rejects explicit null on CREATE before creating an instance directory', async () => {
    const name = 'policy-null';
    const deps = createDeps();
    const res = mockRes();

    await handleCreateLine(mockReq({
      method: 'POST',
      body: JSON.stringify({
        name,
        type: 'agent',
        adminPhones: [SYNTHETIC_PHONE],
        clientOutputPolicies: null,
      }),
    }), res, deps);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/clientOutputPolicies/);
    expect(fs.existsSync(configDir(name))).toBe(false);
    expect(deps.serviceManager.enable).not.toHaveBeenCalled();
  });

  it('persists a valid policy array on CREATE without returning its private values', async () => {
    const name = 'policy-create';
    const privateTerm = 'private-create-term';
    const policies = [policy('create-key', privateTerm)];
    const deps = createDeps();
    const res = mockRes();

    await handleCreateLine(mockReq({
      method: 'POST',
      body: JSON.stringify({
        name,
        type: 'agent',
        adminPhones: [SYNTHETIC_PHONE],
        clientOutputPolicies: policies,
      }),
    }), res, deps);

    expect(res._status).toBe(201);
    expect(JSON.parse(fs.readFileSync(configPath(name), 'utf8')).clientOutputPolicies).toEqual(policies);
    expect(res._body).not.toContain(privateTerm);
    expect(res._body).not.toContain(syntheticPublicKey());
  });

  it.each(INVALID_POLICY_CASES)(
    'rejects $label on CREATE without directory, service, or realtime side effects',
    async ({ id, policies }) => {
      const name = `create-${id}`;
      const deps = createDeps();
      const res = mockRes();

      await handleCreateLine(mockReq({
        method: 'POST',
        body: JSON.stringify({
          name,
          type: 'agent',
          adminPhones: [SYNTHETIC_PHONE],
          clientOutputPolicies: policies,
        }),
      }), res, deps);

      expect(res._status).toBe(400);
      expect(fs.existsSync(configDir(name))).toBe(false);
      expect(deps.serviceManager.enable).not.toHaveBeenCalled();
      expect(deps.realtime.publish).not.toHaveBeenCalled();
    },
  );

  it('atomically replaces policy arrays on PATCH, redacts the response, and retains full disk config', async () => {
    const name = 'policy-patch';
    const targetPath = writeAgent(name, [policy('old-one'), policy('old-two')]);
    const privateTerm = 'private-patch-term';
    const replacement = [policy('replacement', privateTerm)];
    const deps = patchDeps(name, targetPath);
    const res = mockRes();

    await handleConfigUpdate(mockReq({
      method: 'PATCH',
      body: JSON.stringify({ clientOutputPolicies: replacement }),
    }), res, deps, { name });

    const disk = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    const response = JSON.parse(res._body);
    expect(res._status, res._body).toBe(200);
    expect(disk.clientOutputPolicies).toEqual(replacement);
    expect(response.clientOutputPolicies).toHaveLength(1);
    expect(response.clientOutputPolicies[0]).toMatchObject({
      conversationKey: 'replacement',
      blockedTerms: [{ value: '[redacted]', match: 'whole_word', caseSensitive: false }],
      authorization: { keyId: 'synthetic-key', publicKey: '[redacted]' },
    });
    expect(res._body).not.toContain(privateTerm);
    expect(res._body).not.toContain(syntheticPublicKey());
  });

  it('leaves config bytes and auxiliary state unchanged when PATCH validation fails', async () => {
    const name = 'policy-invalid';
    const targetPath = writeAgent(name, [policy('original')]);
    const beforeBytes = fs.readFileSync(targetPath);
    const beforeEntries = fs.readdirSync(configDir(name)).sort();
    const privateTerm = 'private-invalid-term';
    const deps = patchDeps(name, targetPath);
    const res = mockRes();

    await handleConfigUpdate(mockReq({
      method: 'PATCH',
      body: JSON.stringify({
        clientOutputPolicies: [{
          ...policy('replacement', privateTerm),
          blockedTerms: [{ value: privateTerm, match: 'invalid', caseSensitive: false }],
        }],
      }),
    }), res, deps, { name });

    expect(res._status).toBe(400);
    expect(fs.readFileSync(targetPath)).toEqual(beforeBytes);
    expect(fs.readdirSync(configDir(name)).sort()).toEqual(beforeEntries);
    expect(res._body).not.toContain(privateTerm);
    expect(deps.realtime.publish).not.toHaveBeenCalled();
  });

  it.each(INVALID_POLICY_CASES)(
    'rejects $label on PATCH while preserving exact config bytes and sibling entries',
    async ({ id, policies }) => {
      const name = `patch-${id}`;
      const targetPath = writeAgent(name, [policy('original')]);
      const siblingPath = path.join(configDir(name), 'sibling-evidence.txt');
      fs.writeFileSync(siblingPath, `sibling-${id}\n`, { mode: 0o600 });
      const beforeConfig = fs.readFileSync(targetPath);
      const beforeSibling = fs.readFileSync(siblingPath);
      const beforeEntries = fs.readdirSync(configDir(name)).sort();
      const deps = patchDeps(name, targetPath);
      const res = mockRes();

      await handleConfigUpdate(mockReq({
        method: 'PATCH',
        body: JSON.stringify({ clientOutputPolicies: policies }),
      }), res, deps, { name });

      expect(res._status).toBe(400);
      expect(fs.readFileSync(targetPath)).toEqual(beforeConfig);
      expect(fs.readFileSync(siblingPath)).toEqual(beforeSibling);
      expect(fs.readdirSync(configDir(name)).sort()).toEqual(beforeEntries);
      expect(deps.realtime.publish).not.toHaveBeenCalled();
    },
  );
});
