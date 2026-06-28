import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = path.join(repoRoot, 'deploy', 'scripts', 'heal-notify.sh');

describe('deploy/scripts/heal-notify.sh', () => {
  const scriptSrc = readFileSync(scriptPath, 'utf8');

  it('does not use GNU grep PCRE flags', () => {
    const pcreUsage = scriptSrc.match(/grep\s+-[a-zA-Z]*P[a-zA-Z]*\b/g) ?? [];

    expect(pcreUsage).toEqual([]);
  });

  it('extracts msg fields with BSD-compatible extended grep', () => {
    expect(scriptSrc).toMatch(/grep\s+-oE\s+'"msg":"\[\^"\]\*"'/);
  });

  it('derives HEALTH_PORT from config.json rather than hardcoding 9092', () => {
    expect(scriptSrc).not.toContain('127.0.0.1:9092');
    expect(scriptSrc).toContain('HEALTH_PORT');
    expect(scriptSrc).toContain('config.json');
  });

  it('reads health token from tokens.env before falling back to keyring', () => {
    expect(scriptSrc).toContain('tokens.env');
    expect(scriptSrc).toContain('WHATSOUP_HEALTH_TOKEN');
  });

  it('uses instance-scoped config root matching src/fleet/paths.ts XDG convention', () => {
    expect(scriptSrc).toContain('XDG_CONFIG_HOME');
    expect(scriptSrc).toContain('.config}/whatsoup/instances/${INSTANCE}');
  });

  it('guards the alert binary with an existence + executable check', () => {
    expect(scriptSrc).toMatch(/if \[ ! -x "\$ALERT_BIN" \]/);
  });

  it('uses HEALTH_PORT variable in the HEAL_URL', () => {
    expect(scriptSrc).toMatch(/127\.0\.0\.1:\$\{HEALTH_PORT\}/);
  });

  it('resolves dataRoot from config.json paths.dataRoot for the marker check', () => {
    expect(scriptSrc).toContain('.paths.dataRoot');
    expect(scriptSrc).toContain('intentional-restart.marker');
  });

  it('suppresses crash alerts for a fresh intentional restart and consumes the marker', () => {
    // Freshness window matches the 300s marker window.
    expect(scriptSrc).toMatch(/-mmin\s+-5/);
    expect(scriptSrc).toContain('suppressing crash alert');
    expect(scriptSrc).toMatch(/rm\s+-f\s+"\$\{?RESTART_MARKER\}?"/);
  });

  it('exits before gathering crash evidence when an intentional restart is detected', () => {
    const markerIdx = scriptSrc.indexOf('intentional-restart.marker');
    const contextIdx = scriptSrc.indexOf('journalctl');
    expect(markerIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeLessThan(contextIdx);
  });
});
