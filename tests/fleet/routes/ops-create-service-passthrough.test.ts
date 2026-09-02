/**
 * CREATE `service`-block passthrough coverage (issue #3401 item 2).
 *
 * Before this file, `PASSTHROUGH_FIELDS` in src/fleet/routes/ops.ts did NOT
 * include `service`, so `POST /api/lines` with a `service` block dropped it
 * silently: the shared validator (validateInstanceConfig →
 * validateLaunchdServiceConfig, src/core/agent-config-validator.ts) never saw
 * the block, an invalid `service.pathPrepend`/`service.claudeConfigDir`
 * returned 201 instead of 400, and a valid block was not persisted to
 * config.json — contradicting docs/configuration.md's validation promise.
 * PATCH was unaffected (deepMergeRecords preserves unknown keys, then the same
 * validator runs on the merged config).
 *
 * Harness mirrors ops-chatoptions-gating.test.ts / ops-create-byok-roundtrip.test.ts:
 * same temp dirs, real handler, config.json readback. The render-options-only
 * cases use type: 'chat' so the block (claudeConfigDir + pathPrepend, no
 * expectedAccountDigest) exercises validateLaunchdServiceConfig without the
 * agent-only account-identity path; the identity round-trip at the bottom of
 * this file needs type: 'agent' because validateServiceIdentityConfig
 * (src/lib/service-identity-config.ts) rejects expectedAccountDigest on any
 * other instance type.
 *
 * The valid-block fixture is built from the overridden HOME: the route-layer
 * F3 guard added alongside these tests confines service.pathPrepend[] and
 * service.claudeConfigDir to the instance user's home, so the previous
 * out-of-home literals would now be refused with a 400. Confinement itself is
 * covered by ops-service-home-confinement.test.ts.
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

describe('handleCreateLine — service block passthrough (issue #3401 item 2)', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalConfigHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalStateHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-service-create-'));
    originalHome = process.env.HOME;
    originalConfigHome = process.env.XDG_CONFIG_HOME;
    originalDataHome = process.env.XDG_DATA_HOME;
    originalStateHome = process.env.XDG_STATE_HOME;

    process.env.HOME = path.join(tmpDir, 'home');
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
    fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
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

  function cfgPathFor(name: string): string {
    return path.join(
      process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', name, 'config.json',
    );
  }

  it('rejects an invalid service.pathPrepend on CREATE with 400 before writing config.json', async () => {
    // Issue #3401 item-2 falsifier: a relative pathPrepend entry must fail
    // admission. On the pre-fix route `service` was dropped, so this returned
    // 201 and wrote config.json.
    const res = mockRes();
    await handleCreateLine(
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'svc-bad-pathprepend',
          type: 'chat',
          adminPhones: ['15551234567'],
          service: { pathPrepend: ['relative'] },
        }),
      }),
      res,
      successDeps(),
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/service\.pathPrepend/);
    expect(fs.existsSync(cfgPathFor('svc-bad-pathprepend'))).toBe(false);
  });

  it('rejects an invalid service.claudeConfigDir on CREATE with 400 before writing config.json', async () => {
    const res = mockRes();
    await handleCreateLine(
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'svc-bad-claudedir',
          type: 'chat',
          adminPhones: ['15551234567'],
          service: { claudeConfigDir: 'relative/not/absolute' },
        }),
      }),
      res,
      successDeps(),
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/service\.claudeConfigDir/);
    expect(fs.existsSync(cfgPathFor('svc-bad-claudedir'))).toBe(false);
  });

  it('persists a valid service block to config.json on CREATE', async () => {
    const home = os.homedir();
    // Home-confined by the F3 route guard; still fully synthetic (HOME is the
    // per-test tmp tree created in beforeEach).
    const service = {
      claudeConfigDir: path.join(home, '.config', 'claude-agent'),
      pathPrepend: [path.join(home, 'pin', 'bin'), path.join(home, '.local', 'bin')],
    };
    const res = mockRes();
    await handleCreateLine(
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'svc-roundtrip',
          type: 'chat',
          adminPhones: ['15551234567'],
          service,
        }),
      }),
      res,
      successDeps(),
    );

    expect(res._status, 'create must succeed: ' + res._body).toBe(201);
    const persisted = JSON.parse(fs.readFileSync(cfgPathFor('svc-roundtrip'), 'utf-8'));
    // Prove this is a genuine, correctly-populated config (not an empty object
    // that would vacuously lack service) with the service block preserved.
    expect(persisted.type).toBe('chat');
    expect(persisted.service).toEqual(service);
  });

  it('persists service.expectedAccountDigest through CREATE on an agent instance (#3443)', async () => {
    // #3443 put 'service' in PASSTHROUGH_FIELDS so the block survives CREATE,
    // but no test pinned the identity field itself: the two cases above only
    // cover the render-options half (claudeConfigDir / pathPrepend), which is
    // validated by a different module. This is the missing round-trip.
    // Synthetic digest — 64 lowercase hex under the 'sha256:' scheme required
    // by isAccountIdentityDigest (src/lib/account-identity-digest.ts). It
    // digests nothing; no raw account identifier exists anywhere in this test.
    const expectedAccountDigest =
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const res = mockRes();
    await handleCreateLine(
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'svc-digest-roundtrip',
          // agent + the default provider 'claude-cli': validateServiceIdentityConfig
          // rejects expectedAccountDigest on every other type/provider pair.
          type: 'agent',
          adminPhones: ['15551234567'],
          service: { expectedAccountDigest },
        }),
      }),
      res,
      successDeps(),
    );

    expect(res._status, 'create must succeed: ' + res._body).toBe(201);
    const persisted = JSON.parse(fs.readFileSync(cfgPathFor('svc-digest-roundtrip'), 'utf-8'));
    // Prove this is a real, populated agent config rather than an empty object
    // that would vacuously satisfy the digest assertion below.
    expect(persisted.type).toBe('agent');
    expect(persisted.name).toBe('svc-digest-roundtrip');
    expect(persisted.service).toEqual({ expectedAccountDigest });
  });
});
