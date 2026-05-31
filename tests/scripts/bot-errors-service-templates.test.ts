import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const serviceTemplates = [
  'deploy/bot-errors-dispatcher.service',
  'deploy/bot-errors-q-loop.service',
];
const PRIVATE_SOCKET_SEGMENT = ['instances', 'personal', 'whatsoup.sock'].join('/');

describe('BOT ERRORS service templates', () => {
  it('load live routing from the private host env file', () => {
    for (const file of serviceTemplates) {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('EnvironmentFile=%h/.config/whatsoup/bot-errors.env');
    }
  });

  it('keep deploy-specific identifiers out of tracked unit files', () => {
    for (const file of serviceTemplates) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('120363');
      expect(text).not.toMatch(/\/home\/[A-Za-z0-9._-]+\//);
      expect(text).not.toContain(PRIVATE_SOCKET_SEGMENT);
    }
  });
});
