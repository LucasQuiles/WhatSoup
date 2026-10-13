import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateSecurityBoundaryGuard,
  scanFileForSecurityBoundaryViolations,
} from '../../scripts/security-boundary-guard.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts/security-boundary-guard.ts');

describe('security boundary guard — remote memory writes', () => {
  it('blocks raw provider upserts outside the canonical provider adapter', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'src/new-provider.ts',
      'await index.upsertRecords({ records });',
    );
    expect(findings).not.toHaveLength(0);
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.remote-memory.raw-provider-upsert',
    }));
  });

  it('blocks generic upserts from an MCP tool', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'src/mcp/tools/new-memory.ts',
      'await writer.upsert(records);',
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.remote-memory.mcp-generic-upsert',
    }));
  });

  it('requires the dedicated direct-memory writer to carry a provider-attempt gate', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'src/mcp/tools/memory-write.ts',
      'await writer.upsertDirectMemory(records, { operationId });',
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.remote-memory.provider-attempt-gate-missing',
    }));
  });

  it('allows the canonical direct-memory writer with an explicit provider-attempt gate', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'src/mcp/tools/memory-write.ts',
      'await writer.upsertDirectMemory(records, { operationId, beforeProviderAttempt: () => lifecycle.assertWriteAdmission(id) });',
    );
    expect(findings).toEqual([]);
  });

  it('blocks memory_write registration outside the canonical composition root', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'src/new-registration.ts',
      'registerMemoryWriteTools(register, lifecycle);',
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.remote-memory.registration-outside-root',
    }));
  });

  it('requires the composition root to pass its lifecycle authority', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'src/mcp/register-all.ts',
      'memoryWriteTools.registerMemoryWriteTools(register, undefined);',
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.remote-memory.lifecycle-authority-missing',
    }));
  });

  it('blocks making the lifecycle authority optional at the tool boundary', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'src/mcp/tools/memory-write.ts',
      'export function registerMemoryWriteTools(register: Register, lifecycle?: Lifecycle) {}',
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.remote-memory.lifecycle-contract-optional',
    }));
  });

  it('blocks making provider-attempt context optional on the dedicated writer', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'src/runtimes/chat/providers/pinecone.ts',
      'class Provider { upsertDirectMemory(records: Record[], context?: Context): Promise<void> {} }',
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.remote-memory.provider-contract-optional',
    }));
  });

  it('passes the live tree with all required remote-memory boundaries present', () => {
    const result = evaluateSecurityBoundaryGuard(REPO_ROOT);
    expect(result.status).toBe('pass');
    expect(result.scan.filesExamined).toBeGreaterThan(100);
    expect(result.scan.counts).toEqual({
      canonicalRegistrations: 1,
      directMemoryWrites: 1,
      providerUpserts: 1,
      lifecycleContracts: 1,
      providerDirectMethods: 1,
    });
    expect(result.scan.findings).toEqual([]);
  });
});

describe('security boundary guard — fail-closed inventory', () => {
  const temps: string[] = [];
  afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('is inconclusive when no source files can be examined', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'security-boundary-empty-'));
    temps.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"name":"empty"}\n');

    const run = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      GUARD,
    ], { cwd: root, encoding: 'utf8' });

    expect(run.status).toBe(2);
    expect(`${run.stdout}${run.stderr}`).toMatch(/INCONCLUSIVE/i);
  });
});
