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

  it('blocks escaped static provider-upsert property names', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'src/new-provider.ts',
      'await index["upsert\\u0052ecords"]({ records });',
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.remote-memory.raw-provider-upsert',
    }));
  });

  it('blocks line-continued static provider-upsert property names', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'src/new-provider.ts',
      ['await index["upsert\\', 'Records"]({ records });'].join('\n'),
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.remote-memory.raw-provider-upsert',
    }));
  });

  it.each([
    ['identity escape', 'await index["upsert\\Records"]({ records });'],
    ['legacy octal escape', 'await index["upsert\\122ecords"]({ records });'],
  ])('blocks static provider-upsert property names using a %s', (_label, content) => {
    const findings = scanFileForSecurityBoundaryViolations('src/new-provider.ts', content);
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
    expect(result.scan.typeScriptFilesParsed).toBe(4);
    expect(result.scan.counts).toEqual({
      canonicalRegistrations: 1,
      directMemoryWrites: 1,
      providerUpserts: 1,
      lifecycleContracts: 1,
      providerDirectMethods: 1,
      incidentAuthorityPreflights: 1,
      dispatcherAuthorizedSends: 7,
      dispatcherAuthorizedEmails: 3,
      ownerRouteAuthorityChecks: 2,
      qAuthorityChecks: 1,
      phaseRouteInstallations: 1,
      dispatcherCredentialReads: 1,
      qCredentialReads: 1,
      launchdAuthorityBindings: 2,
    });
    expect(result.scan.findings).toEqual([]);
  });
});

describe('security boundary guard — IncidentStore authority', () => {
  it('blocks a direct dispatcher notification bypass', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'deploy/scripts/bot-errors-dispatcher.py',
      'def alternate(event, text):\n    send_whatsapp(text)\n',
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.incident-authority.raw-dispatch-send',
    }));
  });

  it('blocks a direct dispatcher e-mail bypass', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'deploy/scripts/bot-errors-dispatcher.py',
      'def alternate(event, text):\n    email_fallback("subject", text)\n',
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.incident-authority.raw-dispatch-email',
    }));
  });

  it('blocks transport aliases and dynamic lookup bypasses', () => {
    const dispatcher = scanFileForSecurityBoundaryViolations(
      'deploy/scripts/bot-errors-dispatcher.py',
      [
        'def alternate(event, text):',
        '    sender = send_whatsapp',
        '    sender(text)',
        '    globals()["email_fallback"]("subject", text)',
      ].join('\n'),
    );
    const qLoop = scanFileForSecurityBoundaryViolations(
      'deploy/scripts/bot-errors-q-loop.py',
      'def alternate(socket):\n    transport = rpc_call\n    transport(socket, "send_message", {})\n',
    );
    const owner = scanFileForSecurityBoundaryViolations(
      'deploy/scripts/lib/owner_route.py',
      'def alternate(socket):\n    transport = json_rpc_call\n    transport(socket, "tools/call", {})\n',
    );
    expect(dispatcher).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'security.incident-authority.raw-dispatch-send' }),
      expect.objectContaining({ code: 'security.incident-authority.raw-dispatch-email' }),
    ]));
    expect(qLoop).toContainEqual(expect.objectContaining({
      code: 'security.incident-authority.raw-q-send',
    }));
    expect(owner).toContainEqual(expect.objectContaining({
      code: 'security.incident-authority.raw-owner-send',
    }));
  });

  it('blocks a Q-loop RPC bypass and chat-granted phase mutation', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'deploy/scripts/bot-errors-q-loop.py',
      [
        'def classify_activity(state, messages):',
        '    state["phase"] = "approved"',
        'def alternate(socket):',
        '    rpc_call(socket, "send_message", {})',
      ].join('\n'),
    );
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'security.incident-authority.q-chat-grants-phase' }),
      expect.objectContaining({ code: 'security.incident-authority.raw-q-send' }),
    ]));
  });

  it('blocks owner-route effects outside the receipt-validating sender', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'deploy/scripts/lib/owner_route.py',
      [
        'def alternate(socket, email):',
        '    json_rpc_call(socket, "tools/call", {})',
        '    email_fallback("subject", "body")',
      ].join('\n'),
    );
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'security.incident-authority.raw-owner-send' }),
      expect.objectContaining({ code: 'security.incident-authority.raw-owner-email' }),
    ]));
  });

  it('blocks a shared credential identity for independent producers', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'deploy/scripts/bot-errors-dispatcher.py',
      'credential = os.environ["BOT_ERRORS_INCIDENT_AUTHORITY_CREDENTIAL_FILE"]\n',
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.incident-authority.shared-producer-credential',
    }));
  });

  it('blocks moving the authority preflight behind incident mutation', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'deploy/scripts/bot-errors-dispatcher.py',
      [
        'def run_once(max_events):',
        '    observe_credential_members(paths)',
        '    suppress_ready_recovery_duplicates(paths, incident=_incident_cycle)',
        '    flap_scan_outbox(paths, incident=_incident_cycle)',
        '    suppress_alerts_recovered_before_delivery(paths, incident=_incident_cycle)',
        '    collapse_ready_storms(paths, incident=_incident_cycle)',
        '    authority_preflight = authorize_ready_events(paths)',
        '    process_one(path, paths)',
      ].join('\n'),
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.incident-authority.authority-order-drift',
    }));
  });

  it('blocks dry authority seams in production service definitions', () => {
    const findings = scanFileForSecurityBoundaryViolations(
      'deploy/templates/dispatcher.service',
      'Environment="BOT_ERRORS_DRY_AUTHORITY_CAPTURE=/tmp/accept.jsonl"\n',
    );
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'security.incident-authority.dry-config-in-service',
    }));
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
