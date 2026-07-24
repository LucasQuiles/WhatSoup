import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  readArcBindingHealth,
  resolveArcRepoRoot,
} from '../../src/core/arc-binding-health.ts';

function repoWithArcToml(content: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-arc-health.'));
  mkdirSync(path.join(root, '.arc'));
  writeFileSync(path.join(root, '.arc', 'arc.toml'), content, 'utf8');
  return root;
}

describe('readArcBindingHealth', () => {
  it('accepts an explicit root only when its realpath matches the source-anchored checkout', () => {
    const reviewedRoot = repoWithArcToml('');
    const linkRoot = `${reviewedRoot}-link`;
    symlinkSync(reviewedRoot, linkRoot);

    expect(resolveArcRepoRoot(
      { WHATSOUP_REPO_ROOT: `  ${linkRoot}  ` },
      reviewedRoot,
    )).toBe(realpathSync(reviewedRoot));
  });

  it('uses the source-anchored checkout rather than cwd when the explicit root is empty', () => {
    const reviewedRoot = repoWithArcToml('');
    expect(resolveArcRepoRoot({ WHATSOUP_REPO_ROOT: '   ' }, reviewedRoot))
      .toBe(realpathSync(reviewedRoot));
    expect(resolveArcRepoRoot({}, reviewedRoot)).toBe(realpathSync(reviewedRoot));
  });

  it('fails closed when an explicit root does not match the source-anchored checkout', () => {
    const reviewedRoot = repoWithArcToml([
      'arc_version = "0.1.0"',
      'consumer = "whatsoup"',
      'modules = []',
      'emits = []',
      'binding = "bindings/whatsoup.arc.json"',
      `payload_sha = "sha256:${'a'.repeat(64)}"`,
      '',
    ].join('\n'));
    const otherRoot = repoWithArcToml('');
    const resolved = resolveArcRepoRoot(
      { WHATSOUP_REPO_ROOT: otherRoot },
      reviewedRoot,
    );

    expect(resolved).toBeNull();
    expect(readArcBindingHealth(resolved)).toEqual({
      loaded: false,
      reason: 'repository root invalid',
    });
  });

  it('fails closed when the source-anchored checkout is unavailable', () => {
    const explicitRoot = repoWithArcToml('');

    expect(resolveArcRepoRoot({}, null)).toBeNull();
    expect(resolveArcRepoRoot(
      { WHATSOUP_REPO_ROOT: explicitRoot },
      null,
    )).toBeNull();
  });

  it('loads safe ARC metadata from generated arc.toml', () => {
    const root = repoWithArcToml([
      'arc_version = "0.1.0"',
      'consumer = "whatsoup"',
      'modules = ["app-runtime", "telemetry", "verification"]',
      'emits = ["verification-record"]',
      '',
      '[boundary]',
      'owns = ["runtime-health"]',
      'does_not_own = ["publish-decision"]',
      '',
      '[source]',
      'binding = "bindings/whatsoup.arc.json"',
      `payload_sha = "sha256:${'a'.repeat(64)}"`,
      'generated_by = "arc adopt"',
      '',
    ].join('\n'));

    expect(readArcBindingHealth(root)).toEqual({
      loaded: true,
      consumer: 'whatsoup',
      arcVersion: '0.1.0',
      modules: ['app-runtime', 'telemetry', 'verification'],
      emits: ['verification-record'],
      binding: 'bindings/whatsoup.arc.json',
      payloadSha: `sha256:${'a'.repeat(64)}`,
    });
  });

  it('reports loaded=false when arc.toml is missing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-arc-health-missing.'));

    expect(readArcBindingHealth(root)).toEqual({
      loaded: false,
      reason: '.arc/arc.toml missing',
    });
  });

  it('reports loaded=false without echoing malformed file content', () => {
    const root = repoWithArcToml('password = "SUPERSECRET123456"\n');
    const health = readArcBindingHealth(root);

    expect(health.loaded).toBe(false);
    expect(JSON.stringify(health)).not.toContain('SUPERSECRET');
  });
});
