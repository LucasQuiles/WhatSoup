/**
 * Shared shape validation for the RUNTIME-pair Site 1 (config.ts) consumer of
 * `INSTANCE_CONFIG`.
 *
 * Trimmed from qf/instanceconfig-consolidation (9178faf47), which originally consolidated
 * FOUR independent `INSTANCE_CONFIG` parse call sites (see instanceconfig-lane-spec-r15.md)
 * across two bootstrap phases: the EARLY-GATE pair (Sites 2/3,
 * `core/database-compatibility-early.ts` + `database-compatibility-bootstrap.ts`) and the
 * RUNTIME pair (Site 1 = config.ts, Site 4 = main.ts).
 *
 * Sites 2/3 are dropped here: #2206's typed instance-context store
 * (src/lib/instance-context.ts, landed ahead of this lane at 830fd3a95) already centralizes
 * that exact parse+validate step for the early-gate pair — `getBootstrapInstanceContext()`
 * enforces the identical field set this module's original `parseDatabaseGateConfig` did
 * (byte-identical error message: "INSTANCE_CONFIG is missing canonical database gate
 * fields"). Porting Sites 2/3 here would fork the ring-0 SSOT into two competing modules
 * validating the same shape.
 *
 * Site 4 is dropped here too: qf/exitcode-rescope-stacked (0e5844499) already restores
 * ConfigValidationError classification for main.ts's parse failure by composing with the
 * typed store (`getLoadedInstanceConfigOrNull()`), which is the architecturally-consistent
 * approach — main.ts should read through the store's typed getters like every other reader,
 * not re-parse the INSTANCE_CONFIG environment variable a second time via a parallel
 * raw-env parser (tests/lib/instance-context.test.ts pins the reader/writer set for that
 * variable; this module intentionally has zero references to it — every call here takes an
 * already-read `raw: string`, sourced by the caller).
 *
 * Site 1 (config.ts) survives untouched by the reclaim (instance-context.ts never imports
 * from or is imported by config.ts) and is genuinely additive: config.ts's
 * `paths.dbPath`/`lockPath`/`logDir`/`mediaDir` fields were previously unchecked casts
 * (`instance.paths.logDir as string`), so a missing/wrong-type value flowed straight into
 * `mkdirSync(undefined, ...)`. This turns that into a ConfigValidationError at the parse
 * boundary (a behavior change, not silent — see the config.ts diff this module backs).
 *
 * Zero-npm-dependency by design (Node builtins + `./startup-error.ts` + `./error-message.ts`
 * only) — matches the early-gate pair's dependency-light constraint even though this module
 * no longer serves that pair directly, to keep the module reusable if Sites 2/3 are ever
 * revisited.
 */
import { errorMessage } from './error-message.ts';
import { ConfigValidationError } from './startup-error.ts';

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigValidationError(`INSTANCE_CONFIG contains invalid JSON: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Runtime pair, Site 1 only — config.ts. paths.configRoot/dataRoot/stateRoot
// stay required (config.ts's existing throw, unchanged). paths.dbPath/lockPath/
// logDir/mediaDir become required-and-validated here — the real gap-close: they
// were previously zero-check unchecked casts in config.ts, so a missing/wrong-
// type value flowed straight into mkdirSync(undefined, ...). This turns that
// crash into a ConfigValidationError at the parse boundary (a behavior change,
// called out in the lane's commit message, not silent).
// ---------------------------------------------------------------------------

export type RuntimeBootstrapPaths = {
  configRoot: string;
  dataRoot: string;
  stateRoot: string;
  dbPath: string;
  lockPath: string;
  logDir: string;
  mediaDir: string;
  tmpDir?: string;
  authDir?: string;
};

export type RuntimeBootstrapConfig = {
  name?: string;
  type?: string;
  healthPort?: number;
  agentOptions?: Record<string, unknown>;
  systemPrompt?: string;
  socketPath?: string;
  introSent?: boolean;
  paths: RuntimeBootstrapPaths;
  /**
   * The full parsed object, for the ~30 config.ts-only fields this shared shape
   * does not cover (models, adminPhones, transport, chatOptions, the rate-limit
   * migration fields, etc — see instanceconfig-lane-spec-r15.md §2/§5, explicitly
   * out of scope for mechanical consolidation: reproducing them here would be a
   * config.ts business-logic rewrite, not a boundary-hardening pass). Lets
   * config.ts do exactly one JSON.parse of INSTANCE_CONFIG instead of two.
   */
  raw: Record<string, unknown>;
};

const REQUIRED_RUNTIME_PATH_FIELDS = [
  'configRoot',
  'dataRoot',
  'stateRoot',
  'dbPath',
  'lockPath',
  'logDir',
  'mediaDir',
] as const;

export function parseRuntimeBootstrapConfig(raw: string): RuntimeBootstrapConfig {
  const parsed = (parseJson(raw) ?? {}) as Record<string, unknown>;
  const pathsRaw = parsed.paths as Record<string, unknown> | undefined;
  // Message text is regex-pinned verbatim by tests/config.test.ts
  // (`/INSTANCE_CONFIG.*paths object/`) — one message covers both "paths is
  // missing entirely" and "paths is present but a required field is missing",
  // matching the original config.ts wording.
  for (const field of REQUIRED_RUNTIME_PATH_FIELDS) {
    if (typeof pathsRaw?.[field] !== 'string') {
      throw new ConfigValidationError('INSTANCE_CONFIG is missing required paths object');
    }
  }
  const p = pathsRaw as Record<(typeof REQUIRED_RUNTIME_PATH_FIELDS)[number], string>;
  const paths: RuntimeBootstrapPaths = {
    configRoot: p.configRoot,
    dataRoot: p.dataRoot,
    stateRoot: p.stateRoot,
    dbPath: p.dbPath,
    lockPath: p.lockPath,
    logDir: p.logDir,
    mediaDir: p.mediaDir,
    ...(typeof pathsRaw?.tmpDir === 'string' ? { tmpDir: pathsRaw.tmpDir } : {}),
    ...(typeof pathsRaw?.authDir === 'string' ? { authDir: pathsRaw.authDir } : {}),
  };
  return {
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
    ...(typeof parsed.type === 'string' ? { type: parsed.type } : {}),
    ...(typeof parsed.healthPort === 'number' ? { healthPort: parsed.healthPort } : {}),
    ...(typeof parsed.agentOptions === 'object' && parsed.agentOptions !== null
      ? { agentOptions: parsed.agentOptions as Record<string, unknown> }
      : {}),
    ...(typeof parsed.systemPrompt === 'string' ? { systemPrompt: parsed.systemPrompt } : {}),
    ...(typeof parsed.socketPath === 'string' ? { socketPath: parsed.socketPath } : {}),
    ...(typeof parsed.introSent === 'boolean' ? { introSent: parsed.introSent } : {}),
    paths,
    raw: parsed,
  };
}
