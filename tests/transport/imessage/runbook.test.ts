import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runbook = readFileSync(
  new URL('../../../docs/runbooks/imessage-transport.md', import.meta.url),
  'utf8',
);

describe('iMessage transport runbook', () => {
  it('documents the upstream imsg RPC relay instead of a nonexistent socket daemon', () => {
    expect(runbook).toContain('https://github.com/openclaw/imsg');
    expect(runbook).toContain('imsg rpc');
    expect(runbook).toContain('npm run imsg:relay --');
    expect(runbook).toContain('v0.13.2');
    expect(runbook).not.toMatch(/imsg daemon/i);
  });

  it('keeps the imsg extension surface fail closed pending IMCore attestation', () => {
    expect(runbook).toContain('not advertised for imsg without IMCore attestation');
    expect(runbook).toContain('Run this command under a per-user LaunchAgent, not as root.');
  });
});
