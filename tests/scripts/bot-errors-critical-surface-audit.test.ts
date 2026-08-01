import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildRemoteProbeScript,
  collectLocalObservations,
  evaluateCriticalSurfaces,
  loadHealthProfile,
  loadRuntimeManifest,
  parseHealthProfile,
  parseRuntimeManifest,
  run,
} from '../../scripts/bot-errors-critical-surface-audit.ts';

let tmpRoot = '';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
  process.exitCode = undefined;
});

function makeFixture(): { root: string; home: string; manifestPath: string; profilePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-critical-surface-'));
  tmpRoot = root;
  const home = path.join(root, 'home');
  const scriptDir = path.join(root, 'deploy/scripts');
  mkdirSync(scriptDir, { recursive: true });
  const scriptBody = 'def q_unavailable_reason():\n    return "marker"\n';
  const scriptPath = path.join(scriptDir, 'bot-errors-q-loop.py');
  writeFileSync(scriptPath, scriptBody, 'utf8');
  chmodSync(scriptPath, 0o755);

  const configRoot = path.join(home, '.config/whatsoup');
  const credentialDir = path.join(configRoot, 'instances/q');
  const authDir = path.join(credentialDir, 'auth');
  mkdirSync(credentialDir, { recursive: true });
  mkdirSync(authDir, { recursive: true });
  chmodSync(path.join(home, '.config'), 0o700);
  chmodSync(configRoot, 0o700);
  chmodSync(path.join(configRoot, 'instances'), 0o700);
  chmodSync(credentialDir, 0o700);
  chmodSync(authDir, 0o700);
  writeFileSync(path.join(configRoot, 'bot-errors.env'), 'BOT_ERRORS_JID=redacted\n', 'utf8');
  chmodSync(path.join(configRoot, 'bot-errors.env'), 0o600);
  writeFileSync(path.join(credentialDir, 'config.json'), '{"name":"q","type":"agent"}\n', 'utf8');
  chmodSync(path.join(credentialDir, 'config.json'), 0o600);
  writeFileSync(path.join(credentialDir, 'tokens.env'), 'export TOKEN=redacted\n', 'utf8');
  chmodSync(path.join(credentialDir, 'tokens.env'), 0o600);
  writeFileSync(path.join(authDir, 'creds.json'), '{"me":{"id":"redacted"}}\n', 'utf8');
  chmodSync(path.join(authDir, 'creds.json'), 0o600);

  const stateRoot = path.join(home, '.local/state/bot-errors');
  const qLoopRoot = path.join(home, '.local/state/bot-errors-q-loop');
  const dataInstanceRoot = path.join(home, '.local/share/whatsoup/instances/q');
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(qLoopRoot, { recursive: true });
  mkdirSync(dataInstanceRoot, { recursive: true });
  chmodSync(path.join(home, '.local'), 0o700);
  chmodSync(path.join(home, '.local/state'), 0o700);
  chmodSync(path.join(home, '.local/share'), 0o700);
  chmodSync(path.join(home, '.local/share/whatsoup'), 0o700);
  chmodSync(path.join(home, '.local/share/whatsoup/instances'), 0o700);
  chmodSync(dataInstanceRoot, 0o700);
  chmodSync(stateRoot, 0o700);
  chmodSync(qLoopRoot, 0o700);
  writeFileSync(path.join(qLoopRoot, 'state.json'), '{"updated_at":1}\n', 'utf8');
  chmodSync(path.join(qLoopRoot, 'state.json'), 0o600);

  const digest = cryptoHash(scriptBody);
  const manifestPath = path.join(root, 'deploy/bot-errors-runtime-manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      files: [{ path: 'deploy/scripts/bot-errors-q-loop.py', sha256: digest, mustContain: ['q_unavailable_reason'] }],
    }, null, 2),
    'utf8',
  );
  const profilePath = path.join(root, 'deploy/health-profiles/test-host.json');
  mkdirSync(path.dirname(profilePath), { recursive: true });
  writeFileSync(
    profilePath,
    JSON.stringify({
      expectDispatcher: true,
      expectQLoop: true,
      expectConfigInventory: true,
      expectPrimaryPhoneVerification: true,
      requiredCredentialFiles: ['instances/q/tokens.env'],
      instances: [{ name: 'q', expected: 'always_on' }],
    }, null, 2),
    'utf8',
  );
  return { root, home, manifestPath, profilePath };
}

function cryptoHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('bot-errors critical surface audit', () => {
  it('passes when runtime markers, hashes, credential files, and critical state paths are private', () => {
    const fixture = makeFixture();
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = loadHealthProfile(fixture.root, 'deploy/health-profiles/test-host.json');
    const observations = collectLocalObservations(fixture.root, manifest, profile, fixture.home);

    expect(evaluateCriticalSurfaces(manifest, observations)).toEqual([]);
  });

  it('flags runtime marker drift even when a file can still be hashed', () => {
    const fixture = makeFixture();
    const scriptPath = path.join(fixture.root, 'deploy/scripts/bot-errors-q-loop.py');
    const body = 'def other_marker():\n    return "stale"\n';
    writeFileSync(scriptPath, body, 'utf8');
    const manifest = parseRuntimeManifest({
      schemaVersion: 1,
      files: [{ path: 'deploy/scripts/bot-errors-q-loop.py', sha256: cryptoHash(body), mustContain: ['q_unavailable_reason'] }],
    });
    const profile = loadHealthProfile(fixture.root, 'deploy/health-profiles/test-host.json');
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runtime-marker-drift', path: 'deploy/scripts/bot-errors-q-loop.py' }),
    ]));
  });

  it('flags runtime hash drift separately from marker drift', () => {
    const fixture = makeFixture();
    const manifest = parseRuntimeManifest({
      schemaVersion: 1,
      files: [{ path: 'deploy/scripts/bot-errors-q-loop.py', sha256: '0'.repeat(64), mustContain: ['q_unavailable_reason'] }],
    });
    const profile = loadHealthProfile(fixture.root, 'deploy/health-profiles/test-host.json');
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runtime-sha256-drift', expected: '0'.repeat(64) }),
    ]));
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runtime-marker-drift' }),
    ]));
  });

  it('flags symlinked credentials and unsafe parent directories without printing raw secret paths', () => {
    const fixture = makeFixture();
    const tokenPath = path.join(fixture.home, '.config/whatsoup/instances/q/tokens.env');
    rmSync(tokenPath);
    symlinkSync('/tmp/outside-token.env', tokenPath);
    chmodSync(path.join(fixture.home, '.config/whatsoup/instances'), 0o755);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = loadHealthProfile(fixture.root, 'deploy/health-profiles/test-host.json');
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));
    const messages = issues.map((issue) => issue.message).join('\n');

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'credential-kind' }),
      expect.objectContaining({ kind: 'credential-parent-unsafe' }),
    ]));
    expect(messages).not.toContain(fixture.home);
    expect(messages).toContain('tokens.env#');
  });

  it('flags profile-derived always-on config, token, and auth bond credential gaps', () => {
    const fixture = makeFixture();
    rmSync(path.join(fixture.home, '.config/whatsoup/instances/q/config.json'));
    rmSync(path.join(fixture.home, '.config/whatsoup/instances/q/auth/creds.json'));
    rmSync(path.join(fixture.home, '.config/whatsoup/instances/q/tokens.env'));
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({
      expectConfigInventory: true,
      expectPrimaryPhoneVerification: true,
      instances: [{ name: 'q', expected: 'always_on' }],
    });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'credential-missing', requirement: expect.stringMatching(/^config\.json#/) }),
      expect.objectContaining({ kind: 'credential-missing', requirement: expect.stringMatching(/^tokens\.env#/) }),
      expect.objectContaining({ kind: 'credential-missing', requirement: expect.stringMatching(/^creds\.json#/) }),
    ]));
  });

  it('flags undeclared secret-like files that exist with unsafe modes', () => {
    const fixture = makeFixture();
    const extraSecret = path.join(fixture.home, '.config/whatsoup/instances/q/provider.env');
    writeFileSync(extraSecret, 'PROVIDER_TOKEN=redacted\n', 'utf8');
    chmodSync(extraSecret, 0o644);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({ expectConfigInventory: true });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'credential-mode-too-open', requirement: expect.stringMatching(/^provider\.env#/) }),
    ]));
  });

  it('flags unprofiled instance config files as protected control-plane material', () => {
    const fixture = makeFixture();
    const unprofiledConfigDir = path.join(fixture.home, '.config/whatsoup/instances/unprofiled-bot');
    mkdirSync(unprofiledConfigDir, { recursive: true });
    chmodSync(unprofiledConfigDir, 0o700);
    writeFileSync(path.join(unprofiledConfigDir, 'config.json'), '{"name":"unprofiled-bot"}\n', 'utf8');
    chmodSync(path.join(unprofiledConfigDir, 'config.json'), 0o644);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({ expectConfigInventory: true });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'credential-mode-too-open', requirement: expect.stringMatching(/^config\.json#/) }),
    ]));
  });

  it('flags any unsafe file under a WhatsApp auth tree, not only creds.json', () => {
    const fixture = makeFixture();
    const authKey = path.join(fixture.home, '.config/whatsoup/instances/q/auth/pre-key-1.json');
    writeFileSync(authKey, '{"keyData":"redacted"}\n', 'utf8');
    chmodSync(authKey, 0o644);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({ expectConfigInventory: true });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'credential-mode-too-open', requirement: expect.stringMatching(/^pre-key-1\.json#/) }),
    ]));
  });

  it('collapses repeated auth-tree mode and parent findings into actionable issues', () => {
    const fixture = makeFixture();
    const authDir = path.join(fixture.home, '.config/whatsoup/instances/q/auth');
    writeFileSync(path.join(authDir, 'pre-key-1.json'), '{"keyData":"redacted"}\n', 'utf8');
    writeFileSync(path.join(authDir, 'pre-key-2.json'), '{"keyData":"redacted"}\n', 'utf8');
    chmodSync(path.join(authDir, 'pre-key-1.json'), 0o644);
    chmodSync(path.join(authDir, 'pre-key-2.json'), 0o644);
    chmodSync(path.join(fixture.home, '.config/whatsoup/instances'), 0o755);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({ expectConfigInventory: true });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));
    const parentIssues = issues.filter((issue) => issue.kind === 'credential-parent-unsafe');
    const modeIssues = issues.filter((issue) => issue.kind === 'credential-mode-too-open');

    expect(parentIssues).toHaveLength(1);
    expect(modeIssues).toHaveLength(1);
    expect(modeIssues[0]).toEqual(expect.objectContaining({
      path: expect.stringMatching(/^auth#/),
      requirement: expect.stringMatching(/^pre-key-[12]\.json#/),
    }));
  });

  it('flags unsafe files under legacy data-root auth trees', () => {
    const fixture = makeFixture();
    const dataAuthDir = path.join(fixture.home, '.local/share/whatsoup/instances/legacy-bot/auth');
    mkdirSync(dataAuthDir, { recursive: true });
    chmodSync(path.join(fixture.home, '.local/share'), 0o700);
    chmodSync(path.join(fixture.home, '.local/share/whatsoup'), 0o700);
    chmodSync(path.join(fixture.home, '.local/share/whatsoup/instances'), 0o700);
    chmodSync(path.join(fixture.home, '.local/share/whatsoup/instances/legacy-bot'), 0o700);
    chmodSync(dataAuthDir, 0o700);
    const keyPath = path.join(dataAuthDir, 'sender-key.json');
    writeFileSync(keyPath, '{"keyData":"redacted"}\n', 'utf8');
    chmodSync(keyPath, 0o644);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({ expectConfigInventory: true });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'credential-mode-too-open', requirement: expect.stringMatching(/^sender-key\.json#/) }),
    ]));
  });

  it('flags symlinked legacy data-root auth directories as critical paths', () => {
    const fixture = makeFixture();
    const dataInstanceDir = path.join(fixture.home, '.local/share/whatsoup/instances/legacy-bot');
    mkdirSync(dataInstanceDir, { recursive: true });
    chmodSync(path.join(fixture.home, '.local/share'), 0o700);
    chmodSync(path.join(fixture.home, '.local/share/whatsoup'), 0o700);
    chmodSync(path.join(fixture.home, '.local/share/whatsoup/instances'), 0o700);
    chmodSync(dataInstanceDir, 0o700);
    symlinkSync(path.join(fixture.root, 'outside-auth'), path.join(dataInstanceDir, 'auth'));
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({ expectConfigInventory: true });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'critical-path-kind', label: 'discovered-data-auth-root:legacy-bot', actual: 'symlink' }),
    ]));
  });

  it('flags empty credential files even when permissions are private', () => {
    const fixture = makeFixture();
    const tokenPath = path.join(fixture.home, '.config/whatsoup/instances/q/tokens.env');
    writeFileSync(tokenPath, '', 'utf8');
    chmodSync(tokenPath, 0o600);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = loadHealthProfile(fixture.root, 'deploy/health-profiles/test-host.json');
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'credential-empty', requirement: expect.stringMatching(/^tokens\.env#/) }),
    ]));
  });

  it('flags required q-loop state paths that are missing or too open', () => {
    const fixture = makeFixture();
    const qLoopState = path.join(fixture.home, '.local/state/bot-errors-q-loop/state.json');
    chmodSync(qLoopState, 0o644);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({ expectQLoop: true, requiredCredentialFiles: [] });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'critical-path-mode-too-open', label: 'q-loop-state-file' }),
    ]));
  });

  it('flags unredacted sensitive markers in critical state files without printing values', () => {
    const fixture = makeFixture();
    const qLoopState = path.join(fixture.home, '.local/state/bot-errors-q-loop/state.json');
    writeFileSync(qLoopState, JSON.stringify({
      last_poll_error: 'Authorization: Bearer rawBearerSecret123 token=rawTokenSecret123 /home/testuser/.config/whatsoup/bot-errors.env',
    }), 'utf8');
    chmodSync(qLoopState, 0o600);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({ expectQLoop: true });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));
    const rendered = JSON.stringify(issues);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'critical-path-sensitive-content',
        label: 'q-loop-state-file',
        actual: expect.stringContaining('authorization-bearer'),
      }),
    ]));
    expect(rendered).toContain('credential-path');
    expect(rendered).toContain('keyed-secret');
    expect(rendered).not.toContain('rawBearerSecret123');
    expect(rendered).not.toContain('rawTokenSecret123');
    expect(rendered).not.toContain('/home/testuser/.config/whatsoup/bot-errors.env');
  });

  it('does not flag already-redacted critical state diagnostics', () => {
    const fixture = makeFixture();
    const qLoopState = path.join(fixture.home, '.local/state/bot-errors-q-loop/state.json');
    writeFileSync(qLoopState, JSON.stringify({
      last_poll_error: 'Authorization: Bearer [REDACTED] token=[REDACTED] [REDACTED CREDENTIAL PATH]',
    }), 'utf8');
    chmodSync(qLoopState, 0o600);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({ expectQLoop: true });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'critical-path-sensitive-content' }),
    ]));
  });

  it('does not treat ordinary WhatSoup bot database paths as credential leaks', () => {
    const fixture = makeFixture();
    const qLoopState = path.join(fixture.home, '.local/state/bot-errors-q-loop/state.json');
    writeFileSync(qLoopState, JSON.stringify({
      db_identity: {
        path: path.join(fixture.home, '.local/share/whatsoup/instances/agent/bot.db'),
      },
    }), 'utf8');
    chmodSync(qLoopState, 0o600);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({ expectQLoop: true });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'critical-path-sensitive-content' }),
    ]));
  });

  it('flags credential files without owner-read permission as unreadable', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    const fixture = makeFixture();
    const tokens = path.join(fixture.home, '.config/whatsoup/instances/q/tokens.env');
    chmodSync(tokens, 0o200);
    try {
      const manifest = loadRuntimeManifest(fixture.root);
      const profile = parseHealthProfile({ requiredCredentialFiles: ['instances/q/tokens.env'] });
      const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'credential-unreadable',
          requirement: expect.stringMatching(/^tokens\.env#[0-9a-f]{16}$/),
        }),
      ]));
      expect(JSON.stringify(issues)).not.toContain(tokens);
    } finally {
      chmodSync(tokens, 0o600);
    }
  });

  it('flags credential parent directories without owner traversal access', () => {
    const fixture = makeFixture();
    const instanceRoot = path.join(fixture.home, '.config/whatsoup/instances/q');
    chmodSync(instanceRoot, 0o300);
    try {
      const manifest = loadRuntimeManifest(fixture.root);
      const profile = parseHealthProfile({ requiredCredentialFiles: ['instances/q/tokens.env'] });
      const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));
      const rendered = JSON.stringify(issues);

      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'credential-parent-unsafe',
          actual: 'owner-access-missing:300',
        }),
      ]));
      expect(rendered).not.toContain(instanceRoot);
    } finally {
      chmodSync(instanceRoot, 0o700);
    }
  });

  it('flags critical directories without owner read and execute access', () => {
    const fixture = makeFixture();
    const qLoopRoot = path.join(fixture.home, '.local/state/bot-errors-q-loop');
    chmodSync(qLoopRoot, 0o300);
    try {
      const manifest = loadRuntimeManifest(fixture.root);
      const profile = parseHealthProfile({ expectQLoop: true });
      const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));
      const rendered = JSON.stringify(issues);

      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'critical-path-owner-access-missing',
          label: 'q-loop-state-root',
          actual: 'owner-read',
        }),
      ]));
      expect(rendered).not.toContain(qLoopRoot);
    } finally {
      chmodSync(qLoopRoot, 0o700);
    }
  });

  it('fails closed when a critical state file cannot be scanned for sensitive content', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    const fixture = makeFixture();
    const qLoopState = path.join(fixture.home, '.local/state/bot-errors-q-loop/state.json');
    chmodSync(qLoopState, 0o000);
    try {
      const manifest = loadRuntimeManifest(fixture.root);
      const profile = parseHealthProfile({ expectQLoop: true });
      const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));
      const rendered = JSON.stringify(issues);

      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'critical-path-sensitive-scan-failed',
          label: 'q-loop-state-file',
        }),
      ]));
      expect(rendered).not.toContain(qLoopState);
    } finally {
      chmodSync(qLoopState, 0o600);
    }
  });

  it('flags expected always-on data instance roots that are too open', () => {
    const fixture = makeFixture();
    chmodSync(path.join(fixture.home, '.local/share/whatsoup/instances/q'), 0o775);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = loadHealthProfile(fixture.root, 'deploy/health-profiles/test-host.json');
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'critical-path-mode-too-open', label: 'data-instance-root:q' }),
    ]));
  });

  it('flags optional alert control-plane files when they exist with unsafe modes', () => {
    const fixture = makeFixture();
    const silences = path.join(fixture.home, '.config/whatsoup/fleet-silences.json');
    writeFileSync(silences, '[]\n', 'utf8');
    chmodSync(silences, 0o664);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({ expectConfigInventory: true });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'critical-path-mode-too-open', label: 'fleet-silences-file' }),
    ]));
  });

  it('treats the fleet API token source as a required protected credential', () => {
    const fixture = makeFixture();
    const tokenPath = path.join(fixture.home, '.config/whatsoup/fleet-tokens.json');
    writeFileSync(tokenPath, '{"active":"redacted","accept":[]}\n', 'utf8');
    chmodSync(tokenPath, 0o644);
    const manifest = loadRuntimeManifest(fixture.root);
    const profile = parseHealthProfile({
      expectFleetApi: true,
      fleetApiTokenFile: tokenPath,
    });
    const issues = evaluateCriticalSurfaces(manifest, collectLocalObservations(fixture.root, manifest, profile, fixture.home));
    const messages = issues.map((issue) => issue.message).join('\n');

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'credential-mode-too-open',
        requirement: 'fleetApiTokenFile',
      }),
    ]));
    expect(messages).toContain('fleet-tokens.json#');
    expect(messages).not.toContain(tokenPath);
  });

  it('rejects invalid runtime manifest marker declarations', () => {
    expect(() => parseRuntimeManifest({
      schemaVersion: 1,
      files: [{ path: 'deploy/scripts/bot-errors-q-loop.py', sha256: 'a'.repeat(64), mustContain: [42] }],
    })).toThrow(/mustContain/);
  });

  it('rejects required credential profile paths that escape the WhatSoup config root', () => {
    expect(() => parseHealthProfile({ requiredCredentialFiles: ['../outside.env'] }))
      .toThrow(/relative traversal/);
    expect(() => parseHealthProfile({ requiredCredentialFiles: ['/home/testuser/.config/whatsoup/fleet-tokens.json'] }))
      .toThrow(/safe path/);
    expect(() => parseHealthProfile({ requiredCredentialFiles: ['instances/q/$TOKEN_FILE'] }))
      .toThrow(/safe path/);
  });

  it('rejects unsafe fleet API token profile paths before remote probing', () => {
    expect(() => parseHealthProfile({ expectFleetApi: true, fleetApiTokenFile: '../fleet-tokens.json' }))
      .toThrow(/relative traversal/);
    expect(() => parseHealthProfile({ expectFleetApi: true, fleetApiTokenFile: '$FLEET_TOKEN_FILE' }))
      .toThrow(/safe literal path/);
  });

  it('remote probe collector is read-only for credentials and emits no credential file content reads', () => {
    const manifest = parseRuntimeManifest({
      schemaVersion: 1,
      files: [{ path: 'deploy/scripts/bot-errors-q-loop.py', sha256: 'a'.repeat(64), mustContain: ['q_unavailable_reason'] }],
    });
    const script = buildRemoteProbeScript(
      manifest,
      parseHealthProfile({ expectFleetApi: true, fleetApiTokenFile: '~/fleet-tokens.json', requiredCredentialFiles: ['instances/q/tokens.env'] }),
      '~/LAB/WhatSoup',
    );

    expect(script).toContain('p.read_bytes()');
    expect(script).toContain('remote repo root missing or not a directory');
    expect(script).toContain('data_instances_root = home / ".local" / "share" / "whatsoup" / "instances"');
    expect(script).toContain('resolve_profile_credential(home, config_root, profile.get("fleetApiTokenFile"))');
    expect(script).toContain('"fleetApiTokenFile"');
    expect(script).toContain('CREDENTIAL_LIKE_BASENAMES = set(ROOT_CREDENTIAL_FILES) | set(["config.json","tokens.env"])');
    expect(script).toContain('"readable": bool(int(info.get("mode", 0)) & 0o400)');
    expect(script).not.toContain('open(p');
    expect(script).not.toContain('read_text');
    expect(script).not.toContain('os.path.expanduser(requirement)');
    expect(script).not.toContain('os.path.expandvars(requirement)');
  });

  it('CLI returns issues and sets exitCode on local drift', () => {
    const fixture = makeFixture();
    const scriptPath = path.join(fixture.root, 'deploy/scripts/bot-errors-q-loop.py');
    writeFileSync(scriptPath, 'def q_unavailable_reason():\n    return "changed"\n', 'utf8');

    const issues = run(['--profile', 'deploy/health-profiles/test-host.json', '--home', fixture.home, '--json'], fixture.root, { HOME: fixture.home });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runtime-sha256-drift' }),
    ]));
    expect(process.exitCode).toBe(1);
  });

  it('checked-in runtime manifest and health profiles are parseable by the audit guard', () => {
    expect(loadRuntimeManifest(repoRoot).files.length).toBeGreaterThan(0);
    const profileNames = readdirSync(path.join(repoRoot, 'deploy/health-profiles')).filter((name) => name.endsWith('.json'));
    expect(profileNames.length).toBeGreaterThan(0);
    // Every checked-in profile must parse; at least one must declare credential files.
    const credentialCounts = profileNames.map(
      (name) => loadHealthProfile(repoRoot, `deploy/health-profiles/${name}`).requiredCredentialFiles.length,
    );
    expect(Math.max(...credentialCounts)).toBeGreaterThan(0);
    expect(readFileSync(path.join(repoRoot, 'deploy/bot-errors-runtime-manifest.json'), 'utf8')).toContain('mustContain');
  });
});
