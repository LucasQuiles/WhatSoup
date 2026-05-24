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
