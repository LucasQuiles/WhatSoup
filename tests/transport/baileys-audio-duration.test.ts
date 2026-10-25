import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getAudioDuration } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';

const fixturePath = fileURLToPath(new URL('../fixtures/audio/hello.ogg', import.meta.url));
const fixtureDurationSeconds = 1.2070416666666666;

// Media unit tests mock Baileys. Exercise its installed parser here so a
// lockfile update cannot silently lose Ogg/Opus duration extraction.
describe('Baileys audio duration with the installed parser', () => {
  it('reads the duration of the bounded Ogg/Opus buffer', async () => {
    const audio = await readFile(fixturePath);

    expect(await getAudioDuration(audio)).toBeCloseTo(fixtureDurationSeconds, 6);
  });

  it('reads the same duration directly from the fixture file', async () => {
    expect(await getAudioDuration(fixturePath)).toBeCloseTo(fixtureDurationSeconds, 6);
  });

  it('rejects empty audio when its format cannot be identified', async () => {
    await expect(getAudioDuration(Buffer.alloc(0))).rejects.toThrow('Failed to determine audio format');
  });
});
