import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RUNBOOK = readFileSync(
  new URL('../../../docs/runbooks/signal-transport.md', import.meta.url),
  'utf8',
);

describe('Signal transport runbook', () => {
  it('starts every documented daemon with unsupported media downloads disabled', () => {
    const daemonCommands = [...RUNBOOK.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((match) => match[1] ?? '')
      .filter((block) => block.includes('signal-cli') && block.includes('daemon'));

    expect(daemonCommands).toHaveLength(2);
    for (const command of daemonCommands) {
      expect(command).toContain('--ignore-attachments');
      expect(command).toContain('--ignore-stories');
      expect(command).toContain('--ignore-avatars');
      expect(command).toContain('--ignore-stickers');
    }
    expect(RUNBOOK).toMatch(/required.*media.*unsupported/is);
  });
});
