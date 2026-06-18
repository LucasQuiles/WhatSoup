import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  normalizeOpenCodeCommandMode,
  type OpenCodeCommandMode,
} from '../../../core/provider-config-contracts.ts';
export {
  OPENCODE_COMMAND_MODES,
  isOpenCodeCommandMode,
  normalizeOpenCodeCommandMode,
  openCodeCommandModeValidationError,
  type OpenCodeCommandMode,
} from '../../../core/provider-config-contracts.ts';

export type OpenCodeDetectedMode = 'modern-run' | 'legacy-prompt-json' | 'unsupported';

export interface OpenCodeCliContract {
  provider: 'opencode-cli';
  binary: string;
  detectedMode: OpenCodeDetectedMode;
  configuredMode: OpenCodeCommandMode;
  supported: boolean;
  degraded: boolean;
  modelOverrideSupported: boolean;
  sessionResumeSupported: boolean;
  version: string | null;
  reason: string;
  remediation: string;
}

interface ProbeResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode: string | null;
}

type SpawnSyncLike = (
  command: string,
  args: string[],
  options: {
    encoding: 'utf8';
    timeout: number;
    windowsHide: true;
    env: NodeJS.ProcessEnv;
  },
) => SpawnSyncReturns<string>;

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_REMEDIATION =
  'Install or upgrade the OpenCode CLI that supports `opencode run --format json --pure -m <model>`, or set agentOptions.providerConfig.opencodeCommandMode="legacy-prompt-json" to intentionally allow the older one-shot JSON CLI with no model override or session resume.';

const contractCache = new Map<string, { expiresAt: number; value: OpenCodeCliContract }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function probeTempEnv(): Partial<Pick<NodeJS.ProcessEnv, 'TMPDIR' | 'TMP' | 'TEMP'>> {
  const tmpRoot = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? process.env.XDG_RUNTIME_DIR;
  if (!tmpRoot) return {};
  return {
    TMPDIR: tmpRoot,
    TMP: process.env.TMP ?? tmpRoot,
    TEMP: process.env.TEMP ?? tmpRoot,
  };
}

export function detectOpenCodeMode(helpText: string, runHelpText: string): OpenCodeDetectedMode {
  const combined = `${helpText}\n${runHelpText}`.toLowerCase();
  const runHelp = runHelpText.toLowerCase();
  const hasModernRun =
    runHelp.includes('--format') &&
    runHelp.includes('--pure') &&
    (runHelp.includes('-m') || runHelp.includes('--model')) &&
    (runHelp.includes('usage') || runHelp.includes('opencode run'));
  if (hasModernRun) return 'modern-run';

  const hasLegacyPrompt =
    (combined.includes('--prompt') || /\s-p,\s*--prompt/.test(combined) || combined.includes(' -p "')) &&
    (combined.includes('--output-format') || /\s-f,\s*--output-format/.test(combined)) &&
    combined.includes('json');
  if (hasLegacyPrompt) return 'legacy-prompt-json';

  return 'unsupported';
}

export function buildOpenCodeCliContract(args: {
  binary?: string;
  configuredMode?: unknown;
  detectedMode: OpenCodeDetectedMode;
  version?: string | null;
  reason?: string;
}): OpenCodeCliContract {
  const configuredMode = normalizeOpenCodeCommandMode(args.configuredMode);
  const detectedMode = args.detectedMode;
  const effectiveMode = configuredMode === 'auto' ? detectedMode : configuredMode;
  const detectedCompatible = detectedMode === 'modern-run' || detectedMode === 'legacy-prompt-json';
  const detectedMismatch =
    configuredMode !== 'auto' &&
    configuredMode !== detectedMode;
  const supported = detectedCompatible && !detectedMismatch &&
    (effectiveMode === 'modern-run' || effectiveMode === 'legacy-prompt-json');
  const legacy = supported && effectiveMode === 'legacy-prompt-json';
  const unsupportedReason = args.reason ?? 'OpenCode CLI command contract is unsupported';
  const reason = !supported
    ? unsupportedReason
    : detectedMismatch
      ? `Configured OpenCode mode ${configuredMode} does not match detected mode ${detectedMode}`
      : legacy
        ? 'OpenCode legacy one-shot JSON CLI detected; model override and session resume are unavailable'
        : 'OpenCode modern run CLI detected';

  return {
    provider: 'opencode-cli',
    binary: args.binary ?? 'opencode',
    detectedMode,
    configuredMode,
    supported: supported && !detectedMismatch,
    degraded: legacy || detectedMismatch,
    modelOverrideSupported: supported && effectiveMode === 'modern-run' && !detectedMismatch,
    sessionResumeSupported: supported && effectiveMode === 'modern-run' && !detectedMismatch,
    version: args.version ?? null,
    reason,
    remediation: supported && !detectedMismatch && !legacy
      ? 'No action required.'
      : DEFAULT_REMEDIATION,
  };
}

function cleanFirstLine(value: string): string | null {
  const line = value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? null;
}

function runProbe(
  binary: string,
  args: string[],
  timeoutMs: number,
  spawnSyncImpl: SpawnSyncLike,
): ProbeResult {
  try {
    const result = spawnSyncImpl(binary, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        USER: process.env.USER,
        SHELL: process.env.SHELL,
        LANG: process.env.LANG,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        ...probeTempEnv(),
        NO_COLOR: '1',
      },
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
      signal: result.signal,
      errorCode: result.error ? ((result.error as NodeJS.ErrnoException).code ?? result.error.name) : null,
    };
  } catch (err) {
    return {
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      status: null,
      signal: null,
      errorCode: err instanceof Error ? err.name : 'unknown',
    };
  }
}

export function probeOpenCodeCliContract(args: {
  binary?: string;
  configuredMode?: unknown;
  timeoutMs?: number;
  useCache?: boolean;
  spawnSyncImpl?: SpawnSyncLike;
} = {}): OpenCodeCliContract {
  const binary = args.binary ?? 'opencode';
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const configuredMode = normalizeOpenCodeCommandMode(args.configuredMode);
  const cacheKey = `${binary}\0${configuredMode}\0${process.env.PATH ?? ''}`;
  if (args.useCache !== false) {
    const cached = contractCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }

  const spawnImpl = args.spawnSyncImpl ?? spawnSync;
  const versionProbe = runProbe(binary, ['--version'], timeoutMs, spawnImpl);
  if (versionProbe.errorCode === 'ENOENT') {
    const value = buildOpenCodeCliContract({
      binary,
      configuredMode,
      detectedMode: 'unsupported',
      version: null,
      reason: 'OpenCode CLI binary was not found on PATH',
    });
    contractCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  }

  const helpProbe = runProbe(binary, ['--help'], timeoutMs, spawnImpl);
  const runHelpProbe = runProbe(binary, ['run', '--help'], timeoutMs, spawnImpl);
  const helpText = `${helpProbe.stdout}\n${helpProbe.stderr}`;
  const runHelpText = `${runHelpProbe.stdout}\n${runHelpProbe.stderr}`;
  const detectedMode = detectOpenCodeMode(helpText, runHelpText);
  const value = buildOpenCodeCliContract({
    binary,
    configuredMode,
    detectedMode,
    version: cleanFirstLine(`${versionProbe.stdout}\n${versionProbe.stderr}`),
    reason:
      detectedMode === 'unsupported'
        ? `OpenCode CLI help did not advertise a supported command contract; version_probe=${versionProbe.status ?? versionProbe.errorCode ?? 'unknown'} help_probe=${helpProbe.status ?? helpProbe.errorCode ?? 'unknown'} run_help_probe=${runHelpProbe.status ?? runHelpProbe.errorCode ?? 'unknown'}`
        : undefined,
  });
  contractCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

export function openCodeContractEvidence(contract: OpenCodeCliContract): string {
  return [
    `provider=opencode-cli`,
    `binary=${contract.binary}`,
    `version=${contract.version ?? 'unknown'}`,
    `detected_mode=${contract.detectedMode}`,
    `configured_mode=${contract.configuredMode}`,
    `supported=${contract.supported ? 'true' : 'false'}`,
    `degraded=${contract.degraded ? 'true' : 'false'}`,
    `model_override=${contract.modelOverrideSupported ? 'true' : 'false'}`,
    `session_resume=${contract.sessionResumeSupported ? 'true' : 'false'}`,
    `reason=${contract.reason}`,
    `remediation=${contract.remediation}`,
  ].join(' ');
}

export function buildOpenCodeSpawnPerTurnArgs(args: {
  prompt: string;
  model?: string;
  sessionId?: string | null;
  providerConfig?: Record<string, unknown>;
  binary?: string;
  contract?: OpenCodeCliContract;
}): string[] {
  const contract = args.contract ?? probeOpenCodeCliContract({
    binary: args.binary,
    configuredMode: args.providerConfig?.['opencodeCommandMode'],
  });
  if (!contract.supported) {
    throw new Error(`OPENCODE_CLI_UNSUPPORTED: ${openCodeContractEvidence(contract)}`);
  }

  if (contract.detectedMode === 'legacy-prompt-json' || contract.configuredMode === 'legacy-prompt-json') {
    return ['-p', args.prompt, '-f', 'json', '-q'];
  }

  const sessionArgs =
    args.sessionId && !args.sessionId.startsWith('opencode-cli-')
      ? ['--session', args.sessionId]
      : [];
  return [
    'run',
    '--format', 'json',
    '--pure',
    ...sessionArgs,
    ...(args.model ? ['-m', args.model] : []),
    args.prompt,
  ];
}
