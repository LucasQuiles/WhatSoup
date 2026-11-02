import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_PATH as FASTER_WHISPER_DEFAULT_MODEL_PATH,
  SCRIPT_PATH as FASTER_WHISPER_SCRIPT_PATH,
  VENV_ROOT as FASTER_WHISPER_VENV_ROOT,
  fasterWhisperProvider,
  resolvePython,
  transcribeWithFasterWhisper,
} from '../../../../src/runtimes/chat/providers/transcription/faster-whisper.ts';
import { resolveBinaryPath } from '../../../../src/runtimes/chat/providers/transcription/local-audio.ts';
import {
  DEFAULT_MODEL as WHISPER_CPP_MODEL,
  resolveWhisperCli,
  whisperCppProvider,
} from '../../../../src/runtimes/chat/providers/transcription/whisper-cpp.ts';
import { transcribeAudio } from '../../../../src/runtimes/chat/providers/whisper.ts';

const FIXTURE_PATH = join(process.cwd(), 'tests/fixtures/audio/hello.ogg');
const requireLockedRuntime = process.env.WHATSOUP_REQUIRE_LOCKED_TRANSCRIPTION === '1';

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
// Faster-whisper availability requires the selected local model directory as well
// as the interpreter and wrapper. The fresh HOME used by vitest therefore makes it
// unavailable instead of causing a production-model download during a test. The
// locked smoke lane explicitly supplies its verified tiny model directory.
const whisperCppUsable = whisperCppProvider.isAvailable();
const fasterWhisperUsable = fasterWhisperProvider.isAvailable();

// ffmpeg stays a separate conjunct on purpose: neither provider's isAvailable()
// checks it, yet both decode through withNormalizedAudioFile, which shells out to
// ffmpeg. This conjunct covers that gap in the runtime predicates — it is not
// leftover duplication, so do not fold it into the provider checks.
const ffmpegPath = resolveBinaryPath('ffmpeg');
const hasLocalProvider = Boolean(ffmpegPath) && (whisperCppUsable || fasterWhisperUsable);

if (!hasLocalProvider && !requireLockedRuntime) {
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
    + `\n    python ($WHATSOUP_FASTER_WHISPER_PYTHON, else ${FASTER_WHISPER_VENV_ROOT}/bin/{python3.13,python3,python}) = ${pythonPath ?? 'NOT FOUND'}`
    + `\n    wrapper script ${FASTER_WHISPER_SCRIPT_PATH} — ${existsSync(FASTER_WHISPER_SCRIPT_PATH) ? 'present' : 'MISSING'}`
    + `\n    model ($WHATSOUP_FASTER_WHISPER_MODEL, else ${FASTER_WHISPER_DEFAULT_MODEL_PATH}) = ${existsSync(process.env.WHATSOUP_FASTER_WHISPER_MODEL ?? FASTER_WHISPER_DEFAULT_MODEL_PATH) ? 'present' : 'MISSING'}`,
  );
}

describe('transcription integration', () => {
  // @skip-env requires a usable local transcription provider and the real audio fixture.
  it.skipIf(!requireLockedRuntime && (!hasLocalProvider || !existsSync(FIXTURE_PATH)))('transcribes a real audio fixture through the selected local path', async () => {
    delete process.env.OPENAI_API_KEY;
    if (requireLockedRuntime) {
      const python = process.env.WHATSOUP_FASTER_WHISPER_PYTHON;
      const model = process.env.WHATSOUP_FASTER_WHISPER_MODEL;
      expect(python, 'the required lane must select its locked venv explicitly').toBeTruthy();
      expect(model && existsSync(model), 'the required lane must provide its pinned local model').toBe(true);
      expect(ffmpegPath, 'the required lane must provide ffmpeg').toBeTruthy();
      const runtime = spawnSync(python!, ['-I', '-c', 'import sys; print(f"{sys.implementation.name}:{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")'], { encoding: 'utf8', timeout: 5_000 });
      expect(runtime.status, runtime.stderr).toBe(0);
      expect(runtime.stdout.trim()).toBe('cpython:3.13.16');
    }
    const buffer = await readFile(FIXTURE_PATH);
    const result = requireLockedRuntime
      ? await transcribeWithFasterWhisper(buffer, 'audio/ogg')
      : await transcribeAudio(buffer, 'audio/ogg');
    expect(result).toMatch(/hello.*test/i);
  }, 30_000);
});
