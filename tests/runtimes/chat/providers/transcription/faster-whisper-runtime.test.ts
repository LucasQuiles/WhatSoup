import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { transcribeWithFasterWhisper } from '../../../../../src/runtimes/chat/providers/transcription/faster-whisper.ts';

vi.mock('../../../../../src/runtimes/chat/providers/transcription/local-audio.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../../src/runtimes/chat/providers/transcription/local-audio.ts')>(),
  withNormalizedAudioFile: async (_buffer: Buffer, _mime: string, callback: (wav: string) => Promise<string>) => callback('/unused.wav'),
}));

afterEach(() => vi.unstubAllEnvs());

it('reports only complete local models with regular required files as available', async () => {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-model-readiness-'));
  try {
    const python = process.env.WHATSOUP_TEST_LOCKED_PYTHON ?? 'python3.13';
    const probe = spawnSync(python, ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 5_000 });
    expect(probe.status, probe.stderr || probe.error?.message).toBe(0);
    vi.stubEnv('WHATSOUP_FASTER_WHISPER_PYTHON', probe.stdout.trim());
    vi.stubEnv('WHATSOUP_FASTER_WHISPER_MODEL', root);
    vi.resetModules();
    const { fasterWhisperProvider: provider } = await import('../../../../../src/runtimes/chat/providers/transcription/faster-whisper.ts');
    expect(provider.isAvailable()).toBe(false);
    for (const name of ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt']) {
      writeFileSync(join(root, name), 'fixture');
    }
    expect(provider.isAvailable()).toBe(true);
    rmSync(join(root, 'tokenizer.json'));
    expect(provider.isAvailable()).toBe(false);
    mkdirSync(join(root, 'tokenizer.json'));
    expect(provider.isAvailable()).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not import an ambient transcription dependency after a successful isolated probe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-transcription-isolation-'));
  try {
    const python = process.env.WHATSOUP_TEST_LOCKED_PYTHON ?? 'python3.13';
    const target = join(root, 'venv');
    const created = spawnSync(python, ['-I', '-m', 'venv', '--without-pip', target], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);
    const marker = join(root, 'ambient-dependency-ran');
    writeFileSync(join(root, 'faster_whisper.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\nraise RuntimeError("ambient transcription dependency")\n`);
    vi.stubEnv('PYTHONPATH', root);
    vi.stubEnv('WHATSOUP_FASTER_WHISPER_PYTHON', join(target, 'bin/python'));

    await expect(transcribeWithFasterWhisper(Buffer.from('audio'), 'audio/wav'))
      .rejects.toThrow("No module named 'faster_whisper'");
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects a real legacy interpreter before attempting audio normalization or model execution', async () => {
  const python = process.env.WHATSOUP_TEST_LEGACY_PYTHON ?? 'python3.12';
  const probe = spawnSync(python, ['-I', '-c', 'import sys; print(sys.executable); print(sys.version_info[:2])'], {
    encoding: 'utf8', timeout: 5_000,
  });
  expect(probe.status, probe.stderr || probe.error?.message).toBe(0);
  const [executable, version] = probe.stdout.trim().split('\n');
  expect(version).toBe('(3, 12)');
  vi.stubEnv('WHATSOUP_FASTER_WHISPER_PYTHON', executable);

  await expect(transcribeWithFasterWhisper(Buffer.from('not audio'), 'audio/wav'))
    .rejects.toThrow('CPython 3.13.16 is required; found cpython:3.12.');
});

it('forces the Python wrapper to use the installer path and local-only model loading', () => {
  const python = process.env.WHATSOUP_TEST_LOCKED_PYTHON ?? 'python3.13';
  const script = join(process.cwd(), 'scripts', 'transcribe-faster-whisper.py');
  const driver = `
import json
import runpy
import sys
import tempfile
import types
from pathlib import Path

captured = {}
class WhisperModel:
    def __init__(self, model, **kwargs):
        captured.update(model=model, local_files_only=kwargs.get('local_files_only'), download_root=kwargs.get('download_root'))
    def transcribe(self, _input, **_kwargs):
        return [], None

sys.modules['faster_whisper'] = types.SimpleNamespace(WhisperModel=WhisperModel)
temporary = tempfile.TemporaryDirectory()
model_dir = Path(temporary.name)
model_path = model_dir / 'large-v3-turbo-0c94664816ec82be77b20e824c8e8675995b0029'
model_path.mkdir()
for name in ('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'):
    (model_path / name).touch()
sys.argv = ['transcribe-faster-whisper.py', '--input', '/unused.wav', '--model-dir', str(model_dir)]
try:
    runpy.run_path(${JSON.stringify(script)}, run_name='__main__')
except SystemExit as error:
    if error.code not in (None, 0):
        raise
captured['expected_model'] = str(model_path)
captured['expected_root'] = str(model_dir)
print(json.dumps(captured))
temporary.cleanup()
`;
  const result = spawnSync(python, ['-I', '-c', driver], { encoding: 'utf8', timeout: 5_000 });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  const line = result.stdout.trim().split('\n').pop();
  expect(line).toBeTruthy();
  const captured = JSON.parse(line!);
  expect(captured.model).toBe(captured.expected_model);
  expect(captured.download_root).toBe(captured.expected_root);
  expect(captured.local_files_only).toBe(true);
});

it('rejects an incomplete local model before the dependency can resolve a remote tokenizer', () => {
  const python = process.env.WHATSOUP_TEST_LOCKED_PYTHON ?? 'python3.13';
  const script = join(process.cwd(), 'scripts', 'transcribe-faster-whisper.py');
  const driver = `
import runpy
import sys
import tempfile
import types
from pathlib import Path

class WhisperModel:
    def __init__(self, *_args, **_kwargs):
        print('DEPENDENCY_CONSTRUCTOR_REACHED', flush=True)
        raise RuntimeError('missing tokenizer can cause remote resolution')

sys.modules['faster_whisper'] = types.SimpleNamespace(WhisperModel=WhisperModel)
with tempfile.TemporaryDirectory() as temporary:
    model_path = Path(temporary)
    for name in ('config.json', 'model.bin', 'vocabulary.txt'):
        (model_path / name).touch()
    sys.argv = ['transcribe-faster-whisper.py', '--input', '/unused.wav', '--model-dir', temporary, '--model', temporary]
    runpy.run_path(${JSON.stringify(script)}, run_name='__main__')
`;
  const result = spawnSync(python, ['-I', '-c', driver], { encoding: 'utf8', timeout: 5_000 });
  expect(result.status, result.stderr || result.error?.message).toBe(2);
  expect(result.stderr).toContain('local model is incomplete: tokenizer.json');
  expect(result.stdout).not.toContain('DEPENDENCY_CONSTRUCTOR_REACHED');
});
