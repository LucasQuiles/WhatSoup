import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  auditInstancePluginCoverage,
  findConfigFiles,
  parseArgs,
} from '../../scripts/audit-instance-plugin-coverage.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('plugin-coverage');

function makeTmpDir(): string {
  return tmp.make('');
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeInstance(root: string, name: string, config: Record<string, unknown>): string {
  const configPath = path.join(root, name, 'config.json');
  writeJson(configPath, { name, type: 'agent', accessMode: 'self_only', adminPhones: ['15555550100'], ...config });
  return configPath;
}

describe('audit-instance-plugin-coverage', () => {
  it('reports no gaps when an agent explicitly covers every user-scope plugin key', () => {
    const root = makeTmpDir();
    const settingsPath = path.join(root, 'settings.json');
    writeJson(settingsPath, {
      enabledPlugins: {
        'playwright@claude-plugins-official': true,
        'superpowers@superpowers-marketplace': true,
        'sentry@claude-plugins-official': false,
      },
    });
    writeInstance(root, 'bot', {
      agentOptions: {
        sessionScope: 'per_chat',
        enabledPlugins: {
          'playwright@claude-plugins-official': true,
          'superpowers@superpowers-marketplace': false,
          'sentry@claude-plugins-official': false,
        },
      },
    });

    const audit = auditInstancePluginCoverage({ root, settingsPath, instances: [] });

    expect(audit.hasGaps).toBe(false);
    expect(audit.results[0]?.missingEnabled).toEqual([]);
    expect(audit.results[0]?.missingDisabled).toEqual([]);
  });

  it('separates missing inherited enabled keys from missing inherited disabled keys', () => {
    const root = makeTmpDir();
    const settingsPath = path.join(root, 'settings.json');
    writeJson(settingsPath, {
      enabledPlugins: {
        'superpowers@superpowers-marketplace': true,
        'sentry@claude-plugins-official': false,
      },
    });
    writeInstance(root, 'bot', {
      agentOptions: { sessionScope: 'per_chat', enabledPlugins: {} },
    });

    const audit = auditInstancePluginCoverage({ root, settingsPath, instances: [] });
    const result = audit.results[0]!;

    expect(audit.hasGaps).toBe(true);
    expect(result.missingEnabled.map((gap) => gap.plugin)).toEqual(['superpowers@superpowers-marketplace']);
    expect(result.missingDisabled.map((gap) => gap.plugin)).toEqual(['sentry@claude-plugins-official']);
  });

  it('skips passive instances and audits only requested instance names', () => {
    const root = makeTmpDir();
    const settingsPath = path.join(root, 'settings.json');
    writeJson(settingsPath, {
      enabledPlugins: { 'superpowers@superpowers-marketplace': true },
    });
    writeInstance(root, 'agent-a', {
      agentOptions: {
        sessionScope: 'per_chat',
        enabledPlugins: { 'superpowers@superpowers-marketplace': false },
      },
    });
    writeInstance(root, 'agent-b', {
      agentOptions: { sessionScope: 'per_chat', enabledPlugins: {} },
    });
    writeJson(path.join(root, 'passive', 'config.json'), {
      name: 'passive',
      type: 'passive',
      accessMode: 'self_only',
      adminPhones: ['15555550100'],
    });

    expect(findConfigFiles(root, ['agent-b']).map((file) => path.basename(path.dirname(file)))).toEqual(['agent-b']);

    const filtered = auditInstancePluginCoverage({ root, settingsPath, instances: ['agent-b'] });
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]?.name).toBe('agent-b');
    expect(filtered.results[0]?.missingEnabled).toHaveLength(1);

    const all = auditInstancePluginCoverage({ root, settingsPath, instances: [] });
    const passive = all.results.find((result) => result.name === 'passive');
    expect(passive?.checked).toBe(false);
    expect(passive?.reason).toBe('not an agent instance');
  });

  it('parses CLI options', () => {
    const args = parseArgs([
      '--root', '/tmp/instances',
      '--settings', '/tmp/settings.json',
      '--instance', 'agent-alpha',
      '--instance', 'agent-beta',
      '--json',
      '--fail-on-gap',
    ]);

    expect(args.root).toBe('/tmp/instances');
    expect(args.settingsPath).toBe('/tmp/settings.json');
    expect(args.instances).toEqual(['agent-alpha', 'agent-beta']);
    expect(args.json).toBe(true);
    expect(args.failOnGap).toBe(true);
  });
});

describe('parseArgs — a flag must never be consumed as another flag\'s value', () => {
  /**
   * MEASURED ON origin/main BEFORE THE FIX:
   *
   *   parseArgs(['--root', '--fail-on-gap']) -> { root: '--fail-on-gap', failOnGap: false }
   *
   * That is the dangerous shape for an AUDIT: the operator explicitly asked it to fail when
   * a gap is found, and it silently will not — the audit reports success regardless.
   */
  it('THROWS instead of swallowing --fail-on-gap as the value of --root', () => {
    expect(() => parseArgs(['--root', '--fail-on-gap'])).toThrow(/another flag/);
  });

  it('THROWS instead of taking the next flag as the value of --instance', () => {
    expect(() => parseArgs(['--instance', '--json'])).toThrow(/another flag/);
  });

  it('THROWS on a missing value rather than yielding an empty string', () => {
    expect(() => parseArgs(['--settings'])).toThrow(/requires a value/);
  });

  it('still parses ordinary values and flags correctly', () => {
    const args = parseArgs(['--root', '/tmp/x', '--instance', 'q', '--fail-on-gap', '--json']);
    expect(args.root).toBe('/tmp/x');
    expect(args.instances).toEqual(['q']);
    expect(args.failOnGap).toBe(true);
    expect(args.json).toBe(true);
  });

  it('rejects an unknown flag rather than ignoring it silently', () => {
    expect(() => parseArgs(['--fail-on-gaps'])).toThrow(/Unknown argument/);
  });
});
