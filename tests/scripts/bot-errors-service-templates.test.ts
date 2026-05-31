import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const serviceTemplates = [
  'deploy/bot-errors-collector.service',
  'deploy/bot-errors-dispatcher.service',
  'deploy/bot-errors-health-check.service',
  'deploy/bot-errors-heartbeat-watchdog.service',
  'deploy/bot-errors-deadman.service',
  'deploy/bot-errors-q-loop.service',
];
const timerTemplates = [
  'deploy/bot-errors-deadman.timer',
  'deploy/bot-errors-health-check.timer',
  'deploy/bot-errors-heartbeat-watchdog.timer',
];
const launchdInstallers = [
  'deploy/scripts/install-bot-errors-health-launchd.sh',
  'deploy/scripts/install-bot-errors-launchd.sh',
];
const unitTemplates = [...serviceTemplates, ...timerTemplates];
const PRIVATE_SOCKET_SEGMENT = ['instances', 'personal', 'whatsoup.sock'].join('/');

describe('BOT ERRORS service templates', () => {
  it('load live routing from the private host env file', () => {
    for (const file of serviceTemplates) {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('EnvironmentFile=%h/.config/whatsoup/bot-errors.env');
    }
  });

  it('keep deploy-specific identifiers out of tracked unit files', () => {
    for (const file of unitTemplates) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('120363');
      expect(text).not.toMatch(/\/home\/[A-Za-z0-9._-]+\//);
      expect(text).not.toContain(PRIVATE_SOCKET_SEGMENT);
    }
  });

  it('fails loud before installing launchd plists when referenced scripts are missing', () => {
    for (const file of launchdInstallers) {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('missing required BOT ERRORS script');
      expect(text).toContain('bot-errors-health-check.py');
      expect(text).toContain('bot-errors-runner.py');
    }
    expect(readFileSync('deploy/scripts/install-bot-errors-launchd.sh', 'utf8')).toContain('bot-errors-dispatcher.py');
  });
});
