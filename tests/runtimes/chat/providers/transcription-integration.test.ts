import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VENV_ROOT as FASTER_WHISPER_VENV_ROOT, fasterWhisperProvider } from '../../../../src/runtimes/chat/providers/transcription/faster-whisper.ts';
import { resolveBinaryPath } from '../../../../src/runtimes/chat/providers/transcription/local-audio.ts';
import { DEFAULT_MODEL as WHISPER_CPP_MODEL, whisperCppProvider } from '../../../../src/runtimes/chat/providers/transcription/whisper-cpp.ts';
import { transcribeAudio } from '../../../../src/runtimes/chat/providers/whisper.ts';

const FIXTURE_PATH = join(process.cwd(), 'tests/fixtures/audio/hello.ogg');

// Ask each provider whether it can actually run instead of re-deriving its
// requirements here. Commit 24b812377 (#2897) fixed the previous version of this
// predicate by replacing hardcoded /opt/homebrew/bin/* probes with a PATH lookup.
// Probing for an installed BINARY is that same error one level deeper, because whisper.cpp
// needs a MODEL as well as a binary. Installing whisper-cpp on a host with no
// ggml model therefore un-skipped this test, and it then failed against the
// chain's FALLBACK_TEXT — a host gap reported as a test failure. isAvailable() is
// the runtime's own answer to "can this provider run", so the predicate cannot
// drift from what transcribeAudio() will attempt. It also honours overrides the
// hand-rolled probe missed, such as WHATSOUP_FASTER_WHISPER_PYTHON.
//
// Known asymmetry, deliberate and NOT compensated for here: faster-whisper's
// isAvailable() checks python + wrapper script but no model, because it downloads
// models on demand. A host with the venv but no cached model and no network can
// still run-and-fail here; fixing that belongs in the provider, not in this test.
const whisperCppUsable = whisperCppProvider.isAvailable();
const fasterWhisperUsable = fasterWhisperProvider.isAvailable();

// ffmpeg stays a separate conjunct on purpose: neither provider's isAvailable()
// checks it, yet both decode through withNormalizedAudioFile, which shells out to
// ffmpeg. This conjunct covers that gap in the runtime predicates — it is not
// leftover duplication, so do not fold it into the provider checks.
const ffmpegPath = resolveBinaryPath('ffmpeg');
const hasLocalProvider = Boolean(ffmpegPath) && (whisperCppUsable || fasterWhisperUsable);

if (!hasLocalProvider) {
  // Loud skip reason: name exactly what was probed and what was (not) found,
  // so a green-but-skipped CI run is diagnosable without re-deriving the gate.
  console.warn(
    '[transcription-integration] skipping real-audio test — no usable local provider: '
    + `ffmpeg (via PATH)=${ffmpegPath ? 'found' : 'NOT FOUND'}, `
    + `whisper.cpp (whisper-cli via PATH + model ${WHISPER_CPP_MODEL})=${whisperCppUsable ? 'usable' : 'NOT USABLE'}, `
    + `faster-whisper (python under ${FASTER_WHISPER_VENV_ROOT} + wrapper script)=${fasterWhisperUsable ? 'usable' : 'NOT USABLE'}`,
  );
}

describe('transcription integration', () => {
  // @skip-env requires a usable local transcription provider and the real audio fixture.
  it.skipIf(!hasLocalProvider || !existsSync(FIXTURE_PATH))('transcribes a real audio fixture through the shared chain', async () => {
    delete process.env.OPENAI_API_KEY;
    const buffer = await readFile(FIXTURE_PATH);
    const result = await transcribeAudio(buffer, 'audio/ogg');
    expect(result).toMatch(/hello.*test/i);
  }, 30_000);
});
