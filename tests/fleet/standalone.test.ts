import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FleetServerDeps = {
  db: unknown;
  selfName: string;
  fleetToken: string;
  acceptTokens?: readonly string[];
  getFleetTokens?: () => unknown;
  getSelfHealth: () => Record<string, unknown>;
};

const originalArgv = process.argv;
const originalBindAddress = process.env.FLEET_BIND_ADDRESS;

describe('fleet standalone launcher', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalBindAddress === undefined) {
      delete process.env.FLEET_BIND_ADDRESS;
    } else {
      process.env.FLEET_BIND_ADDRESS = originalBindAddress;
    }
    vi.restoreAllMocks();
    vi.doUnmock('node:sqlite');
    vi.doUnmock('../../src/fleet/index.ts');
    vi.doUnmock('../../src/fleet/token-storage.ts');
    vi.resetModules();
  });

  it('starts on the default fleet port with a throwaway database and token loader', async () => {
    process.argv = ['node', 'src/fleet/standalone.ts'];
    delete process.env.FLEET_BIND_ADDRESS;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { start, createFleetServer, loadOrCreateFleetTokens, DatabaseSync } = mockLauncherDeps({
      active: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      accept: ['old-token'],
    });

    await import('../../src/fleet/standalone.ts');

    expect(DatabaseSync).toHaveBeenCalledWith(':memory:');
    expect(loadOrCreateFleetTokens).toHaveBeenCalledTimes(1);
    expect(createFleetServer).toHaveBeenCalledTimes(1);
    const deps = createFleetServer.mock.calls[0]?.[0] as FleetServerDeps;
    expect(deps).toMatchObject({
      selfName: '__standalone__',
      fleetToken: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      acceptTokens: ['old-token'],
    });
    expect(deps.db).toMatchObject({ path: ':memory:' });
    expect(deps.getFleetTokens).toBe(loadOrCreateFleetTokens);
    const beforeHealth = Date.now();
    const selfHealth = deps.getSelfHealth();
    const afterHealth = Date.now();
    expect(selfHealth).toMatchObject({ status: 'healthy', standalone: true });
    expect(typeof selfHealth.generated_at).toBe('string');
    const generatedAt = Date.parse(selfHealth.generated_at as string);
    expect(Number.isNaN(generatedAt)).toBe(false);
    expect(generatedAt).toBeGreaterThanOrEqual(beforeHealth);
    expect(generatedAt).toBeLessThanOrEqual(afterHealth);
    expect(start).toHaveBeenCalledWith(9099);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      'Fleet token: abcdef01...',
      'Console unlock token: full value in ~/.config/whatsoup/fleet-tokens.json (field "active")',
      'Fleet server listening on http://127.0.0.1:9099',
      'Press Ctrl+C to stop',
    ]);
  });

  it('honors an explicit CLI port and bind-address display value', async () => {
    process.argv = ['node', 'src/fleet/standalone.ts', '4545'];
    process.env.FLEET_BIND_ADDRESS = '0.0.0.0';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { start } = mockLauncherDeps({
      active: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      accept: [],
    });

    await import('../../src/fleet/standalone.ts');

    expect(start).toHaveBeenCalledWith(4545);
    expect(log.mock.calls.map(([message]) => message)).toContain(
      'Fleet server listening on http://0.0.0.0:4545',
    );
  });
});

function mockLauncherDeps(tokens: { active: string; accept: readonly string[] }) {
  const start = vi.fn();
  const createFleetServer = vi.fn((_deps: FleetServerDeps) => ({ start }));
  const loadOrCreateFleetTokens = vi.fn(() => tokens);
  const DatabaseSync = vi.fn(function DatabaseSync(this: { path: string }, path: string) {
    this.path = path;
  });

  vi.doMock('node:sqlite', () => ({ DatabaseSync }));
  vi.doMock('../../src/fleet/index.ts', () => ({ createFleetServer }));
  vi.doMock('../../src/fleet/token-storage.ts', () => ({ loadOrCreateFleetTokens }));

  return { start, createFleetServer, loadOrCreateFleetTokens, DatabaseSync };
}
