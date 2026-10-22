import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCRIPT_PATH as FASTER_WHISPER_SCRIPT_PATH,
  VENV_ROOT as FASTER_WHISPER_VENV_ROOT,
  fasterWhisperProvider,
  resolvePython,
} from '../../../../src/runtimes/chat/providers/transcription/faster-whisper.ts';
import { resolveBinaryPath } from '../../../../src/runtimes/chat/providers/transcription/local-audio.ts';
import {
  DEFAULT_MODEL as WHISPER_CPP_MODEL,
  resolveWhisperCli,
  whisperCppProvider,
} from '../../../../src/runtimes/chat/providers/transcription/whisper-cpp.ts';
import { transcribeAudio } from '../../../../src/runtimes/chat/providers/whisper.ts';

const FIXTURE_PATH = join(process.cwd(), 'tests/fixtures/audio/hello.ogg');

// Ask each provider whether it can actually run instead of re-deriving its
// requirements here. Commit 24b812377 (#2897) fixed the previous version of this
// predicate by replacing hardcoded /opt/homebrew/bin/* probes with a PATH lookup.
// Probing for an installed BINARY is that same error one level deeper, because
// whisper.cpp needs a MODEL as well as a binary, so the predicate could be true on
// a host that cannot transcribe: transcribeAudio() then fell through every provider
// and returned FALLBACK_TEXT, and this test reported a host gap as a test failure.
//
// CAUSE, for the record, because it is easy to misattribute: the HOME rewrite in
// tests/setup/bot-errors-vitest-isolation.ts (e105b34bc, 2026-07-12) made the
// DEFAULT model path unreachable under vitest on EVERY host, and 24b812377
// (2026-08-01) then un-skipped this test wherever whisper-cli was on PATH. A later
// whisper-cpp install is only the trigger that exposes this on a given host.
//
// SCOPE — this predicate covers the two LOCAL providers only. chain.ts tries THREE:
// openAIWhisperProvider first, then faster-whisper, then whisper.cpp. Skipping the
// network provider is deliberate, because this test exists to exercise the local
// chain. It does mean the predicate is NOT a complete account of what
// transcribeAudio() will attempt, and the gap is real rather than theoretical: the
// `delete process.env.OPENAI_API_KEY` below does NOT force the local path, because
// resolveApiKey() (src/lib/api-key-resolver.ts) consults the KEYCHAIN first and only
// falls back to the env var on a keyring miss. On a host with an openai keychain
// entry this test can therefore skip here while the network provider would in fact
// have transcribed the fixture. Neutralizing the keychain is a separate change.
//
// KNOWN ASYMMETRY, deliberate and NOT compensated for here: faster-whisper's
// isAvailable() checks python + wrapper script but no model, because it downloads
// models on demand. So a TRUE predicate still permits a run-and-fail: a host with
// the venv but no cached model and no network reaches the assertion and fails on
// FALLBACK_TEXT, exactly as whisper.cpp did before this change.
//
// Under this harness that is not a corner case, it is EVERY run. faster-whisper.ts
// derives MODEL_DIR from homedir() and passes it as --model-dir, and the setup file
// rewrites HOME to a fresh mkdtemp, so the download root is a new empty directory
// every time and the cache is always cold. Any host whose venv really does have
// faster_whisper installed must therefore fetch a model inside runCommand's 30s
// budget on every single run. Fixing that belongs in the provider, not in this test.
const whisperCppUsable = whisperCppProvider.isAvailable();
const fasterWhisperUsable = fasterWhisperProvider.isAvailable();

// ffmpeg stays a separate conjunct on purpose: neither provider's isAvailable()
// checks it, yet both decode through withNormalizedAudioFile, which shells out to
// ffmpeg. This conjunct covers that gap in the runtime predicates — it is not
// leftover duplication, so do not fold it into the provider checks.
const ffmpegPath = resolveBinaryPath('ffmpeg');
const hasLocalProvider = Boolean(ffmpegPath) && (whisperCppUsable || fasterWhisperUsable);

if (!hasLocalProvider) {
  // Loud skip reason. Each half of each provider is reported separately, because
  // "provider unusable" alone cannot tell a missing binary from a missing model and
  // those need different fixes. The halves come from the providers' own resolvers,
  // so the names below match the real resolution ORDER, env overrides included.
  // SEAM COST, the price of keeping isAvailable() as the predicate: the halves below
  // are DIAGNOSTICS that mirror today's conjuncts, not the predicate itself. Each one
  // is exactly one conjunct of the corresponding isAvailable(). Add a conjunct there
  // and these lines will report every half as fine while the predicate reads false —
  // so if you change either isAvailable(), update them in the same commit.
  //
  // That hazard is survivable because each provider's own isAvailable() verdict is
  // printed as the HEADLINE, from the same value the predicate consumed rather than
  // recomputed. In the future above, the reader sees NOT USABLE over healthy-looking
  // halves, which correctly says "something not shown here is failing" and sends them
  // to isAvailable(). The verdict is the authority; the halves only explain it.
  const whisperCliPath = resolveWhisperCli();
  const pythonPath = resolvePython();
  console.warn(
    '[transcription-integration] skipping real-audio test — no usable local provider:'
    + `\n  ffmpeg: PATH lookup = ${ffmpegPath ?? 'NOT FOUND'}`
    + `\n  whisper.cpp = ${whisperCppUsable ? 'usable' : 'NOT USABLE'}`
    + `\n    binary ($WHATSOUP_WHISPER_CPP_BIN, else 'whisper-cli' via PATH) = ${whisperCliPath ?? 'NOT FOUND'}`
    + '\n    model  ($WHATSOUP_WHISPER_CPP_MODEL, else the default in whisper-cpp.ts)'
    + `\n      resolved to ${WHISPER_CPP_MODEL} — ${existsSync(WHISPER_CPP_MODEL) ? 'present' : 'MISSING'}`
    + `\n  faster-whisper = ${fasterWhisperUsable ? 'usable' : 'NOT USABLE'}`
    + `\n    python ($WHATSOUP_FASTER_WHISPER_PYTHON, else ${FASTER_WHISPER_VENV_ROOT}/bin/{python3.12,python3,python}) = ${pythonPath ?? 'NOT FOUND'}`
    + `\n    wrapper script ${FASTER_WHISPER_SCRIPT_PATH} — ${existsSync(FASTER_WHISPER_SCRIPT_PATH) ? 'present' : 'MISSING'}`,
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
