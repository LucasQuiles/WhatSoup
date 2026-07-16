import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  checkHealthProfiles,
  checkInstanceConfigs,
  checkMemoryIntegrity,
  checkPortMap,
  run,
  type ConfigFinding,
} from '../../scripts/check-instance-config.ts';
import {
  DEFAULT_FLEET_PORT,
  DEFAULT_INSTANCE_HEALTH_PORT,
  INSTANCE_HEALTH_PORT_MIN,
  INSTANCE_HEALTH_PORT_MAX,
} from '../../src/fleet/constants.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const EXAMPLES_ROOT = path.join(repoRoot, 'deploy', 'examples', 'instances');
const HEALTH_PROFILES_ROOT = path.join(repoRoot, 'deploy', 'health-profiles');

const VALID_SUFFIX = '-team-project-id.svc.aped-4627-b74a.pinecone.io';

/** A complete, valid pinecone-enabled chat config. */
function validChatConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'chat-bot',
    type: 'chat',
    systemPrompt: 'You are a helpful assistant.',
    accessMode: 'open_dm',
    adminPhones: ['15555550100'],
    healthPort: 9093,
    memory: {
      pinecone: {
        apiKeyEnv: 'PINECONE_TEAM_KEY',
        expectedHostSuffix: VALID_SUFFIX,
        index: 'team-search',
        searchMode: 'entity',
      },
    },
    ...overrides,
  };
}

/** Write a set of named instance configs into a fresh temp root. */
function makeRoot(configs: Record<string, Record<string, unknown>>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-cfg-'));
  for (const [name, cfg] of Object.entries(configs)) {
    const instDir = path.join(dir, name);
    mkdirSync(instDir, { recursive: true });
    writeFileSync(path.join(instDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  }
  return dir;
}

function makeRepoRootWithHealthProfile(profile: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-cfg-repo-'));
  const instanceDir = path.join(dir, 'deploy', 'examples', 'instances', 'chat-bot');
  const profilesDir = path.join(dir, 'deploy', 'health-profiles');
  mkdirSync(instanceDir, { recursive: true });
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(
    path.join(instanceDir, 'config.json'),
    JSON.stringify(validChatConfig(), null, 2),
    'utf8',
  );
  writeFileSync(path.join(profilesDir, 'test-host.json'), JSON.stringify(profile, null, 2), 'utf8');
  return dir;
}

function classesOf(findings: ConfigFinding[]): string[] {
  return findings.map((f) => f.category);
}

describe('check-instance-config — committed examples (self-run gate)', () => {
  it('the repo example configs pass with zero findings', () => {
    const result = checkInstanceConfigs(EXAMPLES_ROOT);
    expect(result.findings).toEqual([]);
    expect(result.scanned.length).toBeGreaterThanOrEqual(4);
  });

  it('default CLI run scans health profiles as well as example config trees', () => {
    const root = makeRepoRootWithHealthProfile({
      role: 'bot-host',
      instances: [
        {
          name: 'watched-bot',
          expected: 'always_on',
          service: 'com.whatsoup.watched-bot',
          healthPort: DEFAULT_FLEET_PORT,
        },
      ],
    });
    const previousExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = run([], root);
      expect(result.scanned.some((item) => item.instance === 'watched-bot')).toBe(true);
      expect(
        result.findings.some(
          (finding) => finding.instance === 'watched-bot' && finding.category === 'B-port',
        ),
      ).toBe(true);
    } finally {
      process.exitCode = previousExitCode;
      errorSpy.mockRestore();
    }
  });

  it('the repo health profiles pass health-port map validation', () => {
    const result = checkHealthProfiles(HEALTH_PROFILES_ROOT);
    expect(result.findings).toEqual([]);
    expect(result.scanned.length).toBeGreaterThanOrEqual(10);
  });

  it('uses schema-only mode by default and filesystem-aware mode for a live root', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'whatsoup-live-config-home-'));
    const cwd = path.join(home, 'workspace');
    mkdirSync(cwd);
    const root = makeRoot({
      'live-agent': {
        name: 'live-agent',
        type: 'agent',
        accessMode: 'self_only',
        adminPhones: ['15555550100'],
        healthPort: 9095,
        agentOptions: {
          sessionScope: 'single',
          cwd,
          instructionsPath: 'missing.md',
        },
      },
    });

    expect(checkInstanceConfigs(root).findings).toEqual([]);
    const result = checkInstanceConfigs(root, { filesystemHome: home });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        instance: 'live-agent',
        field: 'agentOptions.instructionsPath',
      }),
    );
  });
});

describe('Class A — memory-config integrity', () => {
  it('FAILS: empty memory:{} on a pinecone-enabled (chat) bot → silent-dead (ml/ew incident)', () => {
    const cfg = validChatConfig({ memory: {} });
    const findings = checkMemoryIntegrity(cfg, 'chat-bot', '/x/config.json');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: 'A-memory',
      field: 'memory.pinecone',
    });
  });

  it('FAILS: empty memory:{} on an agent instance → silent-dead', () => {
    const cfg = {
      name: 'ml-bot',
      type: 'agent',
      accessMode: 'allowlist',
      adminPhones: ['15555550100'],
      healthPort: 9098,
      memory: {},
    };
    const findings = checkMemoryIntegrity(cfg, 'ml-bot', '/x/config.json');
    expect(classesOf(findings)).toContain('A-memory');
  });

  it('PASSES: memory.pinecone may include the short-slug projectId used in Pinecone hosts', () => {
    const cfg = validChatConfig({
      memory: {
        pinecone: {
          expectedHostSuffix: VALID_SUFFIX,
          projectId: 'team-project-id',
          index: 'team-search',
        },
      },
    });
    const findings = checkMemoryIntegrity(cfg, 'chat-bot', '/x/config.json');
    expect(findings).toEqual([]);
  });

  it('FAILS: memory.pinecone with a UUID-shaped projectId set → host.includes trap', () => {
    const cfg = validChatConfig({
      memory: {
        pinecone: {
          expectedHostSuffix: VALID_SUFFIX,
          projectId: '123e4567-e89b-12d3-a456-426614174000',
          index: 'team-search',
        },
      },
    });
    const findings = checkMemoryIntegrity(cfg, 'chat-bot', '/x/config.json');
    expect(findings.some((f) => f.field === 'memory.pinecone.projectId')).toBe(true);
  });

  it('FAILS: memory.pinecone present but expectedHostSuffix missing', () => {
    const cfg = validChatConfig({
      memory: { pinecone: { apiKeyEnv: 'PINECONE_TEAM_KEY', index: 'team-search' } },
    });
    const findings = checkMemoryIntegrity(cfg, 'chat-bot', '/x/config.json');
    expect(findings.some((f) => f.field === 'memory.pinecone.expectedHostSuffix')).toBe(true);
  });

  it('FAILS: expectedHostSuffix with wrong shape (bare slug / UUID)', () => {
    const cfg = validChatConfig({
      memory: { pinecone: { expectedHostSuffix: 'nf9hzvy', index: 'team-search' } },
    });
    const findings = checkMemoryIntegrity(cfg, 'chat-bot', '/x/config.json');
    expect(findings.some((f) => f.field === 'memory.pinecone.expectedHostSuffix')).toBe(true);
  });

  it('PASSES: complete pinecone config with a well-shaped expectedHostSuffix and no projectId', () => {
    const cfg = validChatConfig();
    expect(checkMemoryIntegrity(cfg, 'chat-bot', '/x/config.json')).toEqual([]);
  });

  it('NO FALSE POSITIVE: a host suffix with a dotted env segment (AWS/GCP zone) is accepted', () => {
    const cfg = validChatConfig({
      memory: {
        pinecone: {
          expectedHostSuffix: '-nf9hzvy.svc.us-east-1.aws.pinecone.io',
          index: 'team-search',
        },
      },
    });
    expect(checkMemoryIntegrity(cfg, 'chat-bot', '/x/config.json')).toEqual([]);
  });

  it('NO FALSE POSITIVE: passive/agent instance that omits memory entirely is fine', () => {
    const passive = {
      name: 'primary-line',
      type: 'passive',
      accessMode: 'self_only',
      adminPhones: ['15555550100'],
    };
    expect(checkMemoryIntegrity(passive, 'primary-line', '/x/config.json')).toEqual([]);
    const agentNoMem = {
      name: 'operator-agent',
      type: 'agent',
      accessMode: 'allowlist',
      adminPhones: ['15555550100'],
    };
    expect(checkMemoryIntegrity(agentNoMem, 'operator-agent', '/x/config.json')).toEqual([]);
  });
});

describe('Class B — port-map integrity', () => {
  const opts = {
    fleetPort: DEFAULT_FLEET_PORT,
    portMin: INSTANCE_HEALTH_PORT_MIN,
    portMax: INSTANCE_HEALTH_PORT_MAX,
    defaultPort: DEFAULT_INSTANCE_HEALTH_PORT,
  };

  it('FAILS: two instances colliding on the same port', () => {
    const findings = checkPortMap(
      [
        { instance: 'a', filePath: '/a', healthPort: 9095 },
        { instance: 'b', filePath: '/b', healthPort: 9095 },
      ],
      opts,
    );
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.every((f) => f.category === 'B-port')).toBe(true);
  });

  it('FAILS: a bot squatting the canonical fleet/console port (ew-bot 9099)', () => {
    const findings = checkPortMap(
      [{ instance: 'ew-bot', filePath: '/x', healthPort: DEFAULT_FLEET_PORT }],
      opts,
    );
    expect(findings.some((f) => f.message.includes('fleet/console port'))).toBe(true);
  });

  it('FAILS: a port outside the agreed band', () => {
    const findings = checkPortMap(
      [{ instance: 'off', filePath: '/x', healthPort: 9190 }],
      opts,
    );
    expect(findings.some((f) => f.message.includes('outside the agreed'))).toBe(true);
  });

  it('PASSES: a clean, unique, in-band port map', () => {
    const findings = checkPortMap(
      [
        { instance: 'rb', filePath: '/rb', healthPort: 9095 },
        { instance: 'ml', filePath: '/ml', healthPort: 9098 },
        { instance: 'eh', filePath: '/eh', healthPort: 9096 },
      ],
      opts,
    );
    expect(findings).toEqual([]);
  });

  it('FAILS: two instances both omitting healthPort collide on the runtime default (9090)', () => {
    const findings = checkPortMap(
      [
        { instance: 'a', filePath: '/a', healthPort: undefined },
        { instance: 'b', filePath: '/b', healthPort: undefined },
      ],
      opts,
    );
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.every((f) => f.category === 'B-port')).toBe(true);
    expect(findings[0].message).toContain(String(DEFAULT_INSTANCE_HEALTH_PORT));
  });

  it('FAILS: an explicit-9090 instance collides with a no-port instance (both bind 9090)', () => {
    const findings = checkPortMap(
      [
        { instance: 'explicit', filePath: '/e', healthPort: DEFAULT_INSTANCE_HEALTH_PORT },
        { instance: 'implicit', filePath: '/i', healthPort: undefined },
      ],
      opts,
    );
    expect(findings.some((f) => f.message.includes('collides'))).toBe(true);
  });

  it('NO FALSE POSITIVE: a single no-port instance is fine (no collision, no squat/band)', () => {
    const findings = checkPortMap(
      [{ instance: 'solo', filePath: '/s', healthPort: undefined }],
      opts,
    );
    expect(findings).toEqual([]);
  });
});

describe('end-to-end via checkInstanceConfigs over a fixture root', () => {
  it('catches the ml/ew dead-memory + a port squat together', () => {
    const root = makeRoot({
      'ml-bot': {
        name: 'ml-bot',
        type: 'agent',
        accessMode: 'allowlist',
        adminPhones: ['15555550100'],
        healthPort: 9098,
        memory: {},
      },
      'ew-bot': {
        name: 'ew-bot',
        type: 'agent',
        accessMode: 'allowlist',
        adminPhones: ['15555550100'],
        healthPort: DEFAULT_FLEET_PORT,
        memory: { pinecone: { expectedHostSuffix: VALID_SUFFIX, index: 'team-search' } },
      },
    });
    const result = checkInstanceConfigs(root);
    expect(result.findings.some((f) => f.instance === 'ml-bot' && f.category === 'A-memory')).toBe(true);
    expect(result.findings.some((f) => f.instance === 'ew-bot' && f.category === 'B-port')).toBe(true);
  });

  it('a clean fleet root passes', () => {
    const root = makeRoot({
      'chat-bot': validChatConfig({ healthPort: 9093 }),
      'operator-agent': {
        name: 'operator-agent',
        type: 'agent',
        accessMode: 'allowlist',
        adminPhones: ['15555550100'],
        healthPort: 9092,
      },
    });
    expect(checkInstanceConfigs(root).findings).toEqual([]);
  });

  it('accepts a single config.json path arg (offline host check)', () => {
    const root = makeRoot({ 'chat-bot': validChatConfig() });
    const single = path.join(root, 'chat-bot', 'config.json');
    const result = checkInstanceConfigs(single);
    expect(result.scanned).toHaveLength(1);
    expect(result.findings).toEqual([]);
  });

  it('flags a schema violation (missing adminPhones) via the shared validator', () => {
    const root = makeRoot({
      bad: { name: 'bad', type: 'passive', accessMode: 'self_only' },
    });
    const result = checkInstanceConfigs(root);
    expect(result.findings.some((f) => f.category === 'schema' && f.field === 'adminPhones')).toBe(true);
  });
});
