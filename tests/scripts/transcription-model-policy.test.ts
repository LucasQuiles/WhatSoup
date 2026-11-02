import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scriptSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'install-transcription-deps.sh'), 'utf8');
const boundedSource = fs.readFileSync(path.join(repoRoot, 'deploy', 'lib', 'bounded-exec.sh'), 'utf8');
const roots: string[] = [];

function root(): string {
  const value = fs.mkdtempSync(path.join(tmpdir(), 'whatsoup-fw-model-policy-'));
  roots.push(value);
  return value;
}

function executable(directory: string, name: string, source: string): void {
  const file = path.join(directory, name);
  fs.writeFileSync(file, source, 'utf8');
  fs.chmodSync(file, 0o755);
}

function functionSource(name: string): string {
  const start = scriptSource.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`missing installer helper ${name}`);
  const end = scriptSource.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`unterminated installer helper ${name}`);
  return scriptSource.slice(start, end + 3);
}

function runInstaller(body: string, environment: NodeJS.ProcessEnv) {
  const helpers = ['sha256_of', 'sha256_matches', 'download_faster_whisper_file', 'publish_faster_whisper_model', 'install_faster_whisper_model']
    .map(functionSource)
    .join('\n');
  const python = spawnSync(process.env.WHATSOUP_TEST_LOCKED_PYTHON ?? 'python3.13', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 5_000 });
  if (python.status !== 0) throw new Error(python.stderr || python.error?.message || 'Python unavailable');
  const venv = root();
  fs.mkdirSync(path.join(venv, 'bin'));
  const quotedPython = `'${python.stdout.trim().replaceAll("'", "'\\''")}'`;
  executable(path.join(venv, 'bin'), 'python', `#!/bin/sh\nexec ${quotedPython} "$@"\n`);
  return spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${boundedSource}\n${helpers}\n${body}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, VENV: venv, ...environment },
  });
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('install-transcription-deps.sh faster-whisper model policy', () => {
  it('publishes only a complete, hash-verified staged local model under bounded HTTPS fetches', () => {
    const directory = root();
    const destination = path.join(directory, 'large-v3-turbo');
    const curlArguments = path.join(directory, 'curl-arguments');
    executable(directory, 'curl', `#!/bin/sh
printf '%s\\n' "$@" > "$CURL_ARGUMENTS"
while [ "$#" -gt 0 ]; do
  case "$1" in --output) output="$2"; shift 2;; https://*) url="$1"; shift;; *) shift;; esac
done
case "$url" in */config.json) printf config > "$output";; */model.bin) printf model > "$output";; *) exit 19;; esac
`);
    const configHash = createHash('sha256').update('config').digest('hex');
    const modelHash = createHash('sha256').update('model').digest('hex');
    const result = runInstaller(`
FW_MODEL_FILE_BLOCKS=2097152
FW_MODEL_MAX_FILESIZE=2147483648
install_faster_whisper_model "$DESTINATION" https://example.invalid/model \\
  "config.json $CONFIG_HASH" "model.bin $MODEL_HASH"
`, {
      DESTINATION: destination,
      CONFIG_HASH: configHash,
      MODEL_HASH: modelHash,
      CURL_ARGUMENTS: curlArguments,
      PATH: `${directory}:${process.env.PATH}`,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(destination, 'config.json'), 'utf8')).toBe('config');
    expect(fs.readFileSync(path.join(destination, 'model.bin'), 'utf8')).toBe('model');
    expect(fs.existsSync(`${destination}.install.lock`)).toBe(false);
    const args = fs.readFileSync(curlArguments, 'utf8').trim().split('\n');
    expect(args).toContain('--disable');
    expect(args).toContain('--location');
    for (const [flag, value] of [['--proto', '=https'], ['--proto-redir', '=https'], ['--max-filesize', '2147483648'], ['--max-redirs', '3']]) {
      expect(args[args.indexOf(flag) + 1]).toBe(value);
    }
  });

  it('does not publish a model directory when a fetched file fails its manifest hash', () => {
    const directory = root();
    const destination = path.join(directory, 'large-v3-turbo');
    executable(directory, 'curl', '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then printf corrupt > "$2"; break; fi; shift; done\n');
    const result = runInstaller(`
FW_MODEL_FILE_BLOCKS=2097152
FW_MODEL_MAX_FILESIZE=2147483648
install_faster_whisper_model "$DESTINATION" https://example.invalid/model "model.bin $MODEL_HASH"
`, {
      DESTINATION: destination,
      MODEL_HASH: createHash('sha256').update('expected').digest('hex'),
      PATH: `${directory}:${process.env.PATH}`,
    });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.existsSync(`${destination}.install.lock`)).toBe(false);
  });

  it.each(['empty directory', 'nonempty directory', 'symlink'])('never replaces or nests into an appearing %s at publication', (kind) => {
    const directory = root();
    const stage = path.join(directory, 'stage');
    const destination = path.join(directory, 'published');
    const other = path.join(directory, 'other');
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'model.bin'), 'verified');
    fs.mkdirSync(other);
    if (kind === 'symlink') fs.symlinkSync(other, destination);
    else fs.mkdirSync(destination);
    if (kind === 'nonempty directory') fs.writeFileSync(path.join(destination, 'prior'), 'retained');
    const before = fs.lstatSync(destination);
    const result = runInstaller('publish_faster_whisper_model "$STAGE" "$DESTINATION"', { STAGE: stage, DESTINATION: destination });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FileExistsError');
    expect(fs.lstatSync(destination).ino).toBe(before.ino);
    expect(fs.readFileSync(path.join(stage, 'model.bin'), 'utf8')).toBe('verified');
    expect(fs.readdirSync(destination)).toEqual(kind === 'nonempty directory' ? ['prior'] : []);
  });

  it.each(['INT', 'TERM', 'HUP'])('settles %s during model staging without publishing or replacing the caller trap', (signal) => {
    const directory = root();
    const destination = path.join(directory, 'model');
    const marker = path.join(directory, 'caller-exited');
    const result = runInstaller(`
trap 'printf caller > "$MARKER"' EXIT
download_faster_whisper_file() {
  printf partial > "$1"
  /bin/sh -c 'kill -${signal} "$PPID"'
  printf resumed > "$1"
}
install_faster_whisper_model "$DESTINATION" https://example.invalid/model "model.bin $MODEL_HASH"
`, { DESTINATION: destination, MARKER: marker, MODEL_HASH: 'a'.repeat(64) });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe({ INT: 130, TERM: 143, HUP: 129 }[signal]);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.existsSync(`${destination}.install.lock`)).toBe(false);
    expect(fs.readFileSync(marker, 'utf8')).toBe('caller');
    const retained = fs.readdirSync(directory).filter((name) => name.startsWith('model.pending.'));
    expect(retained).toHaveLength(1);
    expect(fs.readFileSync(path.join(directory, retained[0]!, 'model.bin'), 'utf8')).toBe('partial');
  });

  it('pins the supported default to the resolved model revision and complete SHA-256 manifest', () => {
    expect(scriptSource).toContain('FW_MODEL_REVISION="0c94664816ec82be77b20e824c8e8675995b0029"');
    for (const entry of [
      'config.json b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e',
      'model.bin e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da',
      'preprocessor_config.json 7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711',
      'tokenizer.json 297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd',
      'vocabulary.json c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1',
    ]) expect(scriptSource).toContain(entry);
  });
});
