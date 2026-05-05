import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findConfigFiles,
  migrateMemoryConfigFile,
  parseArgs,
  runMigration,
} from '../../scripts/migrate-memory-config.ts';

function makeInstance(root: string, name: string, config: Record<string, unknown>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'tokens.env'), 'WHATSOUP_HEALTH_TOKEN=token\n');
  fs.writeFileSync(path.join(dir, 'auth', 'creds.json'), '{"auth":true}\n');
  return path.join(dir, 'config.json');
}

describe('migrate-memory-config CLI helpers', () => {
  it('parses dry-run defaults', () => {
    const args = parseArgs(['--root', '/tmp/ws', '--instance', 'mw-bot']);
    expect(args.root).toBe('/tmp/ws');
    expect(args.instances).toEqual(['mw-bot']);
    expect(args.write).toBe(false);
    expect(args.backup).toBe(true);
    expect(args.removeLegacy).toBe(true);
  });

  it('finds all instance config.json files under a root', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      makeInstance(tmp, 'a-bot', { name: 'a-bot' });
      makeInstance(tmp, 'b-bot', { name: 'b-bot' });
      expect(findConfigFiles({ root: tmp, configs: [], instances: [] })).toEqual([
        path.join(tmp, 'a-bot', 'config.json'),
        path.join(tmp, 'b-bot', 'config.json'),
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('dry-runs without touching config.json, tokens.env, or auth credentials', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      const configPath = makeInstance(tmp, 'mw-bot', {
        name: 'mw-bot',
        pineconeIndex: 'mw-mind',
        pineconeAllowedIndexes: ['mw-mind'],
      });
      const beforeConfig = fs.readFileSync(configPath, 'utf-8');
      const beforeToken = fs.readFileSync(path.join(tmp, 'mw-bot', 'tokens.env'), 'utf-8');
      const beforeAuth = fs.readFileSync(path.join(tmp, 'mw-bot', 'auth', 'creds.json'), 'utf-8');

      const result = migrateMemoryConfigFile(configPath, { write: false });

      expect(result.changed).toBe(true);
      expect(result.wrote).toBe(false);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(beforeConfig);
      expect(fs.readFileSync(path.join(tmp, 'mw-bot', 'tokens.env'), 'utf-8')).toBe(beforeToken);
      expect(fs.readFileSync(path.join(tmp, 'mw-bot', 'auth', 'creds.json'), 'utf-8')).toBe(beforeAuth);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('write mode updates only config.json and creates a backup', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      const configPath = makeInstance(tmp, 'mw-bot', {
        name: 'mw-bot',
        pineconeIndex: 'mw-mind',
        pineconeFactsNamespace: 'mw-facts',
      });

      const result = migrateMemoryConfigFile(configPath, { write: true, backup: true });
      const next = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(result.wrote).toBe(true);
      expect(result.backupPath).toBeTruthy();
      expect(fs.existsSync(result.backupPath!)).toBe(true);
      expect(next.memory.pinecone.index).toBe('mw-mind');
      expect(next.memory.pinecone.namespaces.facts).toBe('mw-facts');
      expect(next).not.toHaveProperty('pineconeIndex');
      expect(fs.readFileSync(path.join(tmp, 'mw-bot', 'tokens.env'), 'utf-8')).toBe('WHATSOUP_HEALTH_TOKEN=token\n');
      expect(fs.readFileSync(path.join(tmp, 'mw-bot', 'auth', 'creds.json'), 'utf-8')).toBe('{"auth":true}\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('write mode preserves flat recency settings while migrating supported Pinecone fields', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      const configPath = makeInstance(tmp, 'mw-bot', {
        name: 'mw-bot',
        pineconeIndex: 'mw-mind',
        recencyHalfLifeDays: 21,
        maxAgeDays: 180,
      });

      const result = migrateMemoryConfigFile(configPath, { write: true, backup: false });
      const next = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(result.wrote).toBe(true);
      expect(result.backupPath).toBeNull();
      expect(next.memory.pinecone.index).toBe('mw-mind');
      expect(next).not.toHaveProperty('pineconeIndex');
      expect(next.recencyHalfLifeDays).toBe(21);
      expect(next.maxAgeDays).toBe(180);
      expect(next.memory.pinecone).not.toHaveProperty('recencyHalfLifeDays');
      expect(next.memory.pinecone).not.toHaveProperty('maxAgeDays');
      expect(result.moved).toContainEqual({ from: 'pineconeIndex', to: 'memory.pinecone.index' });
      expect(result.removed).toContain('pineconeIndex');
      expect(result.moved.map((move) => move.from)).not.toContain('recencyHalfLifeDays');
      expect(result.moved.map((move) => move.from)).not.toContain('maxAgeDays');
      expect(result.removed).not.toContain('recencyHalfLifeDays');
      expect(result.removed).not.toContain('maxAgeDays');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('dry-run preserves flat recency settings while reporting supported Pinecone moves', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      const configPath = makeInstance(tmp, 'mw-bot', {
        name: 'mw-bot',
        pineconeIndex: 'mw-mind',
        recencyHalfLifeDays: 21,
        maxAgeDays: 180,
      });
      const beforeConfig = fs.readFileSync(configPath, 'utf-8');

      const result = migrateMemoryConfigFile(configPath, { write: false });
      const next = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(result.changed).toBe(true);
      expect(result.wrote).toBe(false);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(beforeConfig);
      expect(next.pineconeIndex).toBe('mw-mind');
      expect(next.recencyHalfLifeDays).toBe(21);
      expect(next.maxAgeDays).toBe(180);
      expect(next).not.toHaveProperty('memory.pinecone.index');
      expect(next).not.toHaveProperty('memory.pinecone.recencyHalfLifeDays');
      expect(next).not.toHaveProperty('memory.pinecone.maxAgeDays');
      expect(result.moved).toContainEqual({ from: 'pineconeIndex', to: 'memory.pinecone.index' });
      expect(result.removed).toContain('pineconeIndex');
      expect(result.moved.map((move) => move.from)).not.toContain('recencyHalfLifeDays');
      expect(result.moved.map((move) => move.from)).not.toContain('maxAgeDays');
      expect(result.removed).not.toContain('recencyHalfLifeDays');
      expect(result.removed).not.toContain('maxAgeDays');
      expect(result).not.toHaveProperty('config');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runMigration can target a named instance', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-test-'));
    try {
      makeInstance(tmp, 'mw-bot', { name: 'mw-bot', pineconeIndex: 'mw-mind' });
      makeInstance(tmp, 'ana-bot', { name: 'ana-bot', pineconeIndex: 'ana-mind' });

      const results = runMigration(['--root', tmp, '--instance', 'ana-bot', '--write', '--json']);

      expect(results).toHaveLength(1);
      expect(results[0].configPath).toBe(path.join(tmp, 'ana-bot', 'config.json'));
      const mw = JSON.parse(fs.readFileSync(path.join(tmp, 'mw-bot', 'config.json'), 'utf-8'));
      const ana = JSON.parse(fs.readFileSync(path.join(tmp, 'ana-bot', 'config.json'), 'utf-8'));
      expect(mw.pineconeIndex).toBe('mw-mind');
      expect(ana.memory.pinecone.index).toBe('ana-mind');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
