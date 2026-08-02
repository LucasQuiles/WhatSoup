import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  run,
  validateDisposableClientCanaryArtifact,
} from '../../scripts/disposable-client-canary-artifact.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('');

function validArtifact(): Record<string, unknown> {
  return {
    artifact_type: 'disposable-client-canary',
    run_id: 'canary-run-alpha',
    client_family: 'whatsapp-web-js',
    account_class: 'disposable',
    send_disabled: true,
    auth_started: true,
    auth_completed: true,
    ready_seen: true,
    linked_duration_seconds: 60,
    chat_list_readable: true,
    logout_seen: false,
    ghost_connection_suspected: false,
    raw_identifier_scan: 'pass',
    message_content_scan: 'pass',
    kill_reason: null,
  };
}

function rawGroupJid(): string {
  return ['120363', '123456789012', '@g.us'].join('');
}

function phoneLikeNumber(): string {
  return ['1555', '123', '4567'].join('');
}

function rawLid(): string {
  return ['abcde', '1234567890', 'abcde', '@lid'].join('');
}

function makeTempArtifact(artifact: Record<string, unknown>): string {
  const root = tmp.make('whatsoup-canary-artifact');
  const file = path.join(root, 'artifact.json');
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('disposable client canary artifact contract', () => {
  it('accepts the no-send disposable canary success artifact shape', () => {
    expect(validateDisposableClientCanaryArtifact(validArtifact())).toMatchObject({
      artifact_type: 'disposable-client-canary',
      account_class: 'disposable',
      send_disabled: true,
      ready_seen: true,
      chat_list_readable: true,
      raw_identifier_scan: 'pass',
      message_content_scan: 'pass',
    });
  });

  it('rejects live-risky artifacts before any canary execution', () => {
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      account_class: 'personal',
    })).toThrow(/account_class/);
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      send_disabled: false,
    })).toThrow(/send_disabled/);
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      chat_list_readable: false,
    })).toThrow(/ready.*chat_list_readable/);
  });

  it('rejects artifacts that do not prove a clean no-send liveness result', () => {
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      auth_completed: false,
    })).toThrow(/auth_completed/);
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      raw_identifier_scan: 'fail',
    })).toThrow(/raw_identifier_scan/);
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      message_content_scan: 'fail',
    })).toThrow(/message_content_scan/);
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      logout_seen: true,
    })).toThrow(/logout_seen/);
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      ghost_connection_suspected: true,
    })).toThrow(/ghost_connection_suspected/);
  });

  it('rejects raw identifiers, phone-like numbers, and message body fields', () => {
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      diagnostic: rawGroupJid(),
    })).toThrow(/redaction_violation/);
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      diagnostic: phoneLikeNumber(),
    })).toThrow(/redaction_violation/);
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      diagnostic: rawLid(),
    })).toThrow(/redaction_violation/);
    expect(() => validateDisposableClientCanaryArtifact({
      ...validArtifact(),
      message_body: ['hello ', 'from canary'].join(''),
    })).toThrow(/message content/);
  });

  it('validates an artifact file from the command surface with safe diagnostics', () => {
    const artifact = makeTempArtifact(validArtifact());
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = run(['--artifact', artifact]);

    expect(process.exitCode).toBeUndefined();
    expect(result).toMatchObject({ artifact_type: 'disposable-client-canary' });
    expect(stdout).toHaveBeenCalledWith(
      'DISPOSABLE_CLIENT_CANARY_ARTIFACT status=pass artifact_type=disposable-client-canary client_family=whatsapp-web-js linked_duration_seconds=60',
    );
  });

  it('fails closed without echoing raw artifact content when the file is unsafe', () => {
    const raw = rawGroupJid();
    const artifact = makeTempArtifact({
      ...validArtifact(),
      diagnostic: raw,
    });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = run(['--artifact', artifact]);

    expect(result).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    const errorText = stderr.mock.calls.flat().join('\n');
    expect(errorText).toContain('redaction_violation');
    expect(errorText).not.toContain(raw);
  });

  it('prints usage without requiring a live artifact path', () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = run(['--help']);

    expect(process.exitCode).toBeUndefined();
    expect(result).toBeNull();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('--artifact'));
  });
});
