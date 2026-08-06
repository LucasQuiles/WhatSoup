import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export type TestPrerequisiteCode =
  | 'python-missing'
  | 'python-version'
  | 'python-probe-failed';

export class TestPrerequisiteError extends Error {
  readonly code: TestPrerequisiteCode;

  constructor(code: TestPrerequisiteCode, message: string) {
    super(message);
    this.name = 'TestPrerequisiteError';
    this.code = code;
  }
}

export interface ResolveTestPythonOptions {
  env?: NodeJS.ProcessEnv;
  minimum?: readonly [number, number];
  spawn?: typeof spawnSync;
}

interface ProbeFailure {
  code: TestPrerequisiteCode;
  detail: string;
}

function probePython(
  candidate: string,
  env: NodeJS.ProcessEnv,
  minimum: readonly [number, number],
  spawn: typeof spawnSync,
): ProbeFailure | null {
  const result = spawn(
    candidate,
    ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
    {
      env,
      encoding: 'utf8',
      shell: false,
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    },
  );
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === 'ENOENT') {
    return { code: 'python-missing', detail: `${candidate} was not found` };
  }
  if (error || result.status !== 0) {
    return {
      code: 'python-probe-failed',
      detail: `${candidate} probe failed with status ${String(result.status)}`,
    };
  }

  const match = String(result.stdout).trim().match(/^(\d+)\.(\d+)$/);
  if (!match) {
    return { code: 'python-probe-failed', detail: `${candidate} returned an invalid version` };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < minimum[0] || (major === minimum[0] && minor < minimum[1])) {
    return {
      code: 'python-version',
      detail: `${candidate} is ${major}.${minor}; Python ${minimum[0]}.${minimum[1]} or newer is required`,
    };
  }
  return null;
}

export function resolveTestPython(options: ResolveTestPythonOptions = {}): string {
  const env = options.env ?? process.env;
  const minimum = options.minimum ?? [3, 12] as const;
  const spawn = options.spawn ?? spawnSync;
  const explicit = env.WHATSOUP_TEST_PYTHON?.trim();
  if (explicit) {
    const failure = probePython(explicit, env, minimum, spawn);
    if (failure) throw new TestPrerequisiteError(failure.code, failure.detail);
    return explicit;
  }

  const candidates: string[] = [];
  const configuredVenv = env.WHATSOUP_QUALITY_VENV?.trim();
  if (configuredVenv) candidates.push(join(configuredVenv, 'bin/python'));
  const dataHome = env.XDG_DATA_HOME?.trim()
    || (env.HOME?.trim() ? join(env.HOME, '.local/share') : '');
  if (dataHome) candidates.push(join(dataHome, 'whatsoup/quality-venv/bin/python'));
  candidates.push('python3.12', 'python3');

  let strongestFailure: ProbeFailure = {
    code: 'python-missing',
    detail: 'no Python test interpreter candidate was found',
  };
  for (const candidate of [...new Set(candidates)]) {
    const failure = probePython(candidate, env, minimum, spawn);
    if (!failure) return candidate;
    if (
      failure.code === 'python-version'
      || (failure.code === 'python-probe-failed' && strongestFailure.code === 'python-missing')
    ) {
      strongestFailure = failure;
    }
  }

  throw new TestPrerequisiteError(strongestFailure.code, strongestFailure.detail);
}
