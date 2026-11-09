import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

  it('rejects an ID3v2 tag whose declared size exceeds the remaining audio', async () => {
    // Keep the declared allocation small even if the upstream size guard regresses.
    const truncatedTag = Buffer.from('49443304000000002000', 'hex');

    await expect(getAudioDuration(truncatedTag)).rejects.toThrow(
      'ID3v2 tag size 4096 exceeds remaining file size 0',
    );
  });

  it('rejects a malformed file path whose ID3v2 size exceeds the remaining audio', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'whatsoup-audio-duration-'));
    const malformedPath = path.join(directory, 'truncated-id3.mp3');
    const truncatedTag = Buffer.from('49443304000000002000', 'hex');

    try {
      await writeFile(malformedPath, truncatedTag);
      await expect(getAudioDuration(malformedPath)).rejects.toThrow(
        'ID3v2 tag size 4096 exceeds remaining file size 0',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
