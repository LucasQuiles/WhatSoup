import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function readDoc(path: string): string {
  return readFileSync(`${repoRoot}/${path}`, 'utf8');
}

describe('startup-notification documentation', () => {
  it('documents portable configured-admin routing, bounded health, and deferred cleanup', () => {
    const configuration = readDoc('docs/configuration.md');

    expect(configuration).toContain('### Startup-notification protocol');
    expect(configuration).toMatch(/\| `baileys` \| phone digits \| `toPersonalJid` \|/);
    expect(configuration).toMatch(/\| `twilio` \| phone digits \| `toSmsJid`[^|]*\|/);
    expect(configuration).toMatch(/\| `signal` \| lowercase UUID or E\.164 wire identity \| `toSignalJid` \|/);
    expect(configuration).toMatch(/\| `imessage` \| AppleID or E\.164 wire identity \| `toImessageJid` \|/);
    expect(configuration).toContain('`connected === true && state === \'connected\'`');
    expect(configuration).toContain('startup-notify.json');
    expect(configuration).toContain('`journal_unreadable`');
    expect(configuration).toContain('`restart_loop_guard_alert`');
    expect(configuration).toContain('`expired_session_notice`');
    expect(configuration).toContain('`intentional_restart`');
    expect(configuration).toContain('`sent` means a tracked provider-submission attempt completed successfully');
    expect(configuration).toContain('`lastSendAt` is recorded when the most recent submission attempt starts');
    expect(configuration).toContain('may be non-null with `send_failed`');
    expect(configuration).toContain('Provider-bridge base extraction');
    expect(configuration).toContain('health boolean-helper consolidation');
    expect(configuration).toContain('`STARTUP_NOTIFY_FILENAME` export cleanup');
    expect(configuration).toContain('currently unused');
    expect(configuration).not.toContain('final repository search found callers');
  });

  it('replaces per-process burst guidance with aggregate and health observation guidance', () => {
    const runbook = readDoc('docs/runbooks/personal-line-watch.md');

    expect(runbook).toContain('## 8. Startup-notification protocol');
    expect(runbook).toContain('one aggregate');
    expect(runbook).toContain('`startupNotification`');
    expect(runbook).toContain('`send_failed`');
    expect(runbook).toMatch(/not provider\s+delivery/);
    expect(runbook).toContain('does not query `bot.db`');
    expect(runbook).toContain('does not add a fleet monitor');
    expect(runbook).toContain('release-deployment.md#startup-notification-acceptance');
  });

  it('defines one approval-gated, manager-neutral release acceptance procedure', () => {
    const releaseRunbook = readDoc('docs/runbooks/release-deployment.md');

    expect(releaseRunbook).toContain('## Startup-notification acceptance');
    expect(releaseRunbook).toContain('one manager-neutral startup-notification acceptance');
    expect(releaseRunbook).toContain('explicit owner approval');
    expect(releaseRunbook).toContain('once under launchd and once under systemd');
    expect(releaseRunbook).toMatch(/Docker inherits the process protocol and\s+remains untested/);
    expect(releaseRunbook).toContain('does not execute a probe command');
    expect(releaseRunbook).toContain('--health-file');
    expect(releaseRunbook).toContain('--journal-file');
    expect(releaseRunbook).toContain('--probe-outcome passed');
    expect(releaseRunbook).not.toContain('--probe-command');
    expect(releaseRunbook).toContain('Source tests do not prove portability');
  });
});
