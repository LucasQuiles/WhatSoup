const gitChildEnvKeys = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_PATH',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK',
  'SUDO_ASKPASS',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
] as const;

export function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    gitChildEnvKeys
      .map((key) => [key, process.env[key]] as const)
      .filter(([, value]) => value !== undefined),
  ) as NodeJS.ProcessEnv;
}

const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/i;

function readNonEmptyEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function readWhatsoupGitSha(): string | null {
  const value = readNonEmptyEnv('WHATSOUP_GIT_SHA') ?? readNonEmptyEnv('GIT_SHA');
  if (!value || !FULL_GIT_SHA_RE.test(value)) return null;
  return value.toLowerCase();
}

export function readWhatsoupGitBranch(): string | null {
  return readNonEmptyEnv('WHATSOUP_GIT_BRANCH');
}
