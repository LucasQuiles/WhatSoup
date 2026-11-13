/**
 * The console reads instance config through a projection that replaces each
 * protected link with a marker. Saving that projection back through PATCH
 * must never replace the stored link with the marker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/core/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal));
vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../../helpers/child-process.ts');
  return childProcessMock();
});

import { projectClientOutputPolicyConfig } from '../../../src/core/client-output-policy-config.ts';
import { PROTECTED_MESSAGE_MARKER } from '../../../src/core/protected-message.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { handleConfigUpdate, type OpsDeps } from '../../../src/fleet/routes/ops.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';
import { TEST_LINK_HOST } from '../../helpers/protected-delivery-pins.ts';

const NAME = 'echo-line';
const SYNTHETIC_PHONE = ['1555', '020', '0001'].join('');
const LINK = `https://${TEST_LINK_HOST}/s/#v3.${'Q'.repeat(22)}.${'Z'.repeat(43)}`;
const STORED_PROMPT = `Send ${LINK} when asked for remote support.`;

describe('PATCH /api/lines/:name/config with a redacted projection', () => {
  let tmpDir: string;
  let configPath: string;
  let deps: OpsDeps;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-config-echo-'));
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
    const agentCwd = path.join(process.env.HOME, 'workspace');
    fs.mkdirSync(agentCwd, { recursive: true, mode: 0o700 });

    configPath = path.join(process.env.XDG_CONFIG_HOME, 'whatsoup', 'instances', NAME, 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, JSON.stringify({
      name: NAME,
      type: 'agent',
      adminPhones: [SYNTHETIC_PHONE],
      accessMode: 'self_only',
      healthPort: 9095,
      systemPrompt: STORED_PROMPT,
      agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
    }, null, 2) + '\n');

    const instance: DiscoveredInstance = {
      name: NAME,
      type: 'agent',
      accessMode: 'self_only',
      healthPort: 9095,
      dbPath: path.join(tmpDir, 'bot.db'),
      stateRoot: path.join(tmpDir, 'state'),
      logDir: path.join(tmpDir, 'logs'),
      healthToken: null,
      configPath,
      socketPath: null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shared deps factory is untyped for partial route deps. expires 2026-12-31
    deps = makeDeps<any>({ discovery: { getInstance: vi.fn(() => instance) } });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function patch(body: unknown): Promise<{ status: number; body: string }> {
    const res = mockRes();
    await handleConfigUpdate(mockReq({ method: 'PATCH', body: JSON.stringify(body) }), res, deps, { name: NAME });
    return { status: res._status, body: res._body };
  }

  function stored(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  }

  it('refuses the whole projected config read back and saved, and keeps the stored systemPrompt', async () => {
    // lines.ts serves the console exactly this projection of the stored config.
    const projected = projectClientOutputPolicyConfig(stored());
    expect(projected.systemPrompt).toBe(`Send ${PROTECTED_MESSAGE_MARKER} when asked for remote support.`);
    const before = fs.readFileSync(configPath);

    const result = await patch(projected);

    expect(result.status, result.body).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/^systemPrompt .*redaction marker/);
    expect(result.body).not.toContain(PROTECTED_MESSAGE_MARKER);
    expect(fs.readFileSync(configPath)).toEqual(before);
    expect(stored().systemPrompt).toBe(STORED_PROMPT);
    expect(deps.realtime.publish).not.toHaveBeenCalled();
  });

  it('refuses an edit made around the marker in one field and names its nested path', async () => {
    const projected = projectClientOutputPolicyConfig(stored());

    const result = await patch({ systemPrompt: `${String(projected.systemPrompt)} Be brief.` });
    const nested = await patch({ agentOptions: { notes: [`see ${PROTECTED_MESSAGE_MARKER}`] } });

    expect(result.status, result.body).toBe(400);
    expect(nested.status, nested.body).toBe(400);
    expect(JSON.parse(nested.body).error).toMatch(/^agentOptions\.notes\.0 /);
    expect(stored().systemPrompt).toBe(STORED_PROMPT);
  });

  it('still saves an unrelated field and a real link the operator types', async () => {
    const unrelated = await patch({ accessMode: 'allowlist' });
    const typedLink = await patch({ systemPrompt: `Use ${LINK} only.` });

    expect(unrelated.status, unrelated.body).toBe(200);
    expect(typedLink.status, typedLink.body).toBe(200);
    expect(stored()).toMatchObject({ accessMode: 'allowlist', systemPrompt: `Use ${LINK} only.` });
    // The response is the redacted projection, never the stored link.
    expect(typedLink.body).not.toContain(TEST_LINK_HOST);
  });
});
