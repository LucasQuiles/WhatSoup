/**
 * POST /api/lines — positive BYOK round-trip.
 *
 * handleCreateLine carries agentOptions through a WHOLESALE passthrough
 * (PASSTHROUGH_FIELDS includes 'agentOptions' as one entry, copied by
 * reference) — there is deliberately no per-subfield allowlist. This test is
 * the lock on that load-bearing line: if the passthrough is ever "tightened"
 * to enumerate agentOptions subfields, a custom-endpoint config
 * (providerConfig + fallbacks) silently dropping on create fails here first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { handleCreateLine } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

function successDeps(): OpsDeps {
  return makeDeps<any>({});
}

describe('handleCreateLine — BYOK providerConfig/fallbacks round-trip', () => {
  let tmpDir: string;
  let agentCwd: string;
  let originalHome: string | undefined;
  let originalConfigHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalStateHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-byok-create-'));
    originalHome = process.env.HOME;
    originalConfigHome = process.env.XDG_CONFIG_HOME;
    originalDataHome = process.env.XDG_DATA_HOME;
    originalStateHome = process.env.XDG_STATE_HOME;

    process.env.HOME = path.join(tmpDir, 'home');
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
    fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
    agentCwd = fs.mkdtempSync(path.join(process.env.HOME, 'byok-cwd-'));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalStateHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists providerConfig and fallbacks to config.json on successful create', async () => {
    const providerConfig = {
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKeyService: 'groq',
    };
    const fallbacks = [{ provider: 'openai-api', model: 'llama-3.3-70b-versatile' }];

    const res = mockRes();
    await handleCreateLine(
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'byok-roundtrip',
          type: 'agent',
          adminPhones: ['15551234567'],
          agentOptions: {
            cwd: agentCwd,
            sessionScope: 'single',
            provider: 'claude-cli',
            providerConfig,
            fallbacks,
          },
        }),
      }),
      res,
      successDeps(),
    );

    expect(res._status, 'create must succeed: ' + res._body).toBe(201);

    const cfgPath = path.join(
      process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'byok-roundtrip', 'config.json',
    );
    expect(fs.existsSync(cfgPath), 'config.json must be written').toBe(true);
    const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(persisted.agentOptions.providerConfig).toEqual(providerConfig);
    expect(persisted.agentOptions.fallbacks).toEqual(fallbacks);
    expect(persisted.agentOptions.provider).toBe('claude-cli');
  });
});
