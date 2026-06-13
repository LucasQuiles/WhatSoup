import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const registryPath = path.join(repoRoot, 'deploy', 'managed-components.json');

interface ProtectiveServiceEntry {
  name: string;
  label_pattern: string;
  template: string;
  script_template?: string;
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
  npm?: { npmrc?: string };
  protective_services?: { entries?: ProtectiveServiceEntry[] };
};
const entries = registry.protective_services?.entries ?? [];

describe('deploy/managed-components.json protective services registry', () => {
  it('declares at least the known protective service set', () => {
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.map((e) => e.name)).toContain('BOT-watchdog');
  });

  it.each(entries.map((e) => [e.name, e] as const))(
    '%s template path points at a real repo file',
    (_name, entry) => {
      expect(entry.template, `entry "${entry.name}" is missing a template`).toBeTruthy();
      expect(
        fs.existsSync(path.join(repoRoot, entry.template)),
        `template "${entry.template}" does not exist in the repo`,
      ).toBe(true);
    },
  );

  it.each(
    entries.filter((e) => e.script_template !== undefined).map((e) => [e.name, e] as const),
  )('%s script_template path points at a real repo file', (_name, entry) => {
    expect(
      entry.script_template,
      `entry "${entry.name}" has an empty script_template`,
    ).toBeTruthy();
    expect(
      fs.existsSync(path.join(repoRoot, entry.script_template as string)),
      `script_template "${entry.script_template}" does not exist in the repo`,
    ).toBe(true);
  });

  it.each(entries.map((e) => [e.name, e] as const))(
    '%s template Label matches label_pattern',
    (_name, entry) => {
      const expectedLabel = entry.label_pattern.replace('{BOT_NAME}', '__BOT_NAME__');
      const plist = fs.readFileSync(path.join(repoRoot, entry.template), 'utf8');
      expect(
        plist,
        `template "${entry.template}" Label does not match label_pattern "${entry.label_pattern}"`,
      ).toContain(`<string>${expectedLabel}</string>`);
    },
  );
});

describe('deploy/managed-components.json npm section', () => {
  it('npmrc path points at a real repo file (read at runtime by harness-maintenance.sh)', () => {
    expect(registry.npm?.npmrc, 'npm.npmrc is missing from the registry').toBeTruthy();
    expect(
      fs.existsSync(path.join(repoRoot, registry.npm?.npmrc as string)),
      `npm.npmrc "${registry.npm?.npmrc}" does not exist in the repo`,
    ).toBe(true);
  });
});
