import { describe, expect, it } from 'vitest';
import {
  validateInstanceConfig,
  type ValidatorContext,
} from '../../src/core/agent-config-validator.ts';

const ctx = (mode: ValidatorContext['mode']): ValidatorContext => ({ name: 'alpha', mode });

const goodServer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'microsoft_365',
  command: 'node',
  args: ['~/.claude/plugins/microsoft-365/mcp-server/dist/index.js'],
  env: { MS365_HUB_URL: 'https://hub.example:10000' },
  envFromKeyring: { MS365_HUB_API_KEY: 'ms365-hub' },
  ...over,
});

const cfg = (
  servers: unknown,
  agentOver: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: 'alpha',
  type: 'agent',
  accessMode: 'self_only',
  adminPhones: ['15551234567'],
  agentOptions: {
    sessionScope: 'per_chat',
    ...(servers === undefined ? {} : { additionalMcpServers: servers }),
    ...agentOver,
  },
});

const FIELD = 'agentOptions.additionalMcpServers';

describe('agentOptions.additionalMcpServers — shape and cardinality (P1-12)', () => {
  it('accepts a well-formed declaration in all four validator modes', () => {
    for (const mode of ['create', 'patch', 'load', 'discovery'] as const) {
      expect(validateInstanceConfig(cfg([goodServer()]), ctx(mode))).toBeNull();
    }
  });

  it('accepts absence (feature is opt-in)', () => {
    expect(validateInstanceConfig(cfg(undefined), ctx('load'))).toBeNull();
  });

  it('rejects a non-array', () => {
    const res = validateInstanceConfig(cfg({ name: 'x' }), ctx('load'));
    expect(res?.field).toBe(FIELD);
  });

  it('rejects more than 16 entries', () => {
    const many = Array.from({ length: 17 }, (_, i) => goodServer({ name: `srv_${i}` }));
    const res = validateInstanceConfig(cfg(many), ctx('load'));
    expect(res?.field).toBe(FIELD);
    expect(res?.message).toMatch(/16/);
  });

  it('rejects a non-object entry', () => {
    const res = validateInstanceConfig(cfg(['nope']), ctx('load'));
    expect(res?.field).toBe(FIELD);
  });

  it('rejects invalid, reserved, and duplicate names', () => {
    expect(validateInstanceConfig(cfg([goodServer({ name: 'has space' })]), ctx('load'))?.field).toBe(FIELD);
    const reserved = validateInstanceConfig(cfg([goodServer({ name: 'whatsoup' })]), ctx('load'));
    expect(reserved?.field).toBe(FIELD);
    expect(reserved?.message).toMatch(/reserved/i);
    expect(validateInstanceConfig(cfg([goodServer({ name: 'send-media' })]), ctx('load'))?.message).toMatch(/reserved/i);
    expect(validateInstanceConfig(cfg([goodServer({ name: 'Whatsoup' })]), ctx('load'))?.message).toMatch(/reserved/i);
    expect(validateInstanceConfig(cfg([goodServer({ name: 'Send-Media' })]), ctx('load'))?.message).toMatch(/reserved/i);
    const dup = validateInstanceConfig(
      cfg([goodServer({ name: 'M365' }), goodServer({ name: 'm365' })]),
      ctx('load'),
    );
    expect(dup?.message).toMatch(/duplicate/i);
  });

  it('rejects when neither or both launch lanes are set', () => {
    const neither = validateInstanceConfig(
      cfg([{ name: 'a1', env: {} }]),
      ctx('load'),
    );
    expect(neither?.field).toBe(FIELD);
    const both = validateInstanceConfig(
      cfg([goodServer({ proxyScriptPath: '~/x/proxy.ts' })]),
      ctx('load'),
    );
    expect(both?.field).toBe(FIELD);
  });

  it('rejects a relative non-node command and bad node-lane args', () => {
    expect(
      validateInstanceConfig(cfg([goodServer({ command: 'python3' })]), ctx('load'))?.field,
    ).toBe(FIELD);
    expect(
      validateInstanceConfig(cfg([goodServer({ args: undefined })]), ctx('load'))?.message,
    ).toMatch(/args\[0\]/);
    expect(
      validateInstanceConfig(cfg([goodServer({ args: ['-e'] })]), ctx('load'))?.message,
    ).toMatch(/args\[0\]/);
    expect(
      validateInstanceConfig(cfg([goodServer({ args: ['~/x/script.py'] })]), ctx('load'))?.message,
    ).toMatch(/\.js/);
  });

  it('rejects a proxyScriptPath with a bad prefix or extension', () => {
    expect(
      validateInstanceConfig(
        cfg([{ name: 'p1', proxyScriptPath: 'relative/p.ts' }]),
        ctx('load'),
      )?.field,
    ).toBe(FIELD);
    expect(
      validateInstanceConfig(
        cfg([{ name: 'p2', proxyScriptPath: '~/x/p.py' }]),
        ctx('load'),
      )?.field,
    ).toBe(FIELD);
  });

  it('rejects malformed env and envFromKeyring blocks', () => {
    expect(
      validateInstanceConfig(cfg([goodServer({ env: { lower: 'x' } })]), ctx('load'))?.field,
    ).toBe(FIELD);
    expect(
      validateInstanceConfig(cfg([goodServer({ env: { NODE_OPTIONS: '--x' } })]), ctx('load'))?.message,
    ).toMatch(/NODE_OPTIONS/);
    expect(
      validateInstanceConfig(cfg([goodServer({ env: { A_B: 42 } })]), ctx('load'))?.field,
    ).toBe(FIELD);
    const collide = validateInstanceConfig(
      cfg([
        goodServer({
          env: { MS365_HUB_API_KEY: 'plain' },
          envFromKeyring: { MS365_HUB_API_KEY: 'ms365-hub' },
        }),
      ]),
      ctx('load'),
    );
    expect(collide?.message).toMatch(/both/i);
  });

  it('rejects keyring services outside MCP_ENV_KEY_SERVICES with the allowlist named', () => {
    const res = validateInstanceConfig(
      cfg([goodServer({ envFromKeyring: { X_KEY: 'anthropic' } })]),
      ctx('load'),
    );
    expect(res?.field).toBe(FIELD);
    expect(res?.message).toContain('ms365-hub');
  });

  it('rejects a non-boolean required flag', () => {
    expect(
      validateInstanceConfig(cfg([goodServer({ required: 'yes' })]), ctx('load'))?.field,
    ).toBe(FIELD);
  });
});

describe('cross-field: additionalMcpServers vs providerConfig MCP overrides (P1-14)', () => {
  it('rejects coexistence with providerConfig.mcpConfig', () => {
    const res = validateInstanceConfig(
      cfg([goodServer()], { providerConfig: { mcpConfig: ['~/static.mcp.json'] } }),
      ctx('load'),
    );
    expect(res?.field).toBe(FIELD);
    expect(res?.message).toMatch(/mcpConfig/);
  });

  it('rejects coexistence with providerConfig.strictMcpConfig', () => {
    const res = validateInstanceConfig(
      cfg([goodServer()], { providerConfig: { strictMcpConfig: true } }),
      ctx('load'),
    );
    expect(res?.field).toBe(FIELD);
  });

  it('allows providerConfig.mcpConfig alone (legacy configs stay valid until migrated)', () => {
    expect(
      validateInstanceConfig(
        cfg(undefined, { providerConfig: { mcpConfig: ['~/static.mcp.json'] } }),
        ctx('load'),
      ),
    ).toBeNull();
  });
});
