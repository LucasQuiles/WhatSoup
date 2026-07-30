/** Valid instance name pattern: lowercase alphanumeric + hyphens, starting with a letter. */
export const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Maximum instance name length shared by fleet routes and launchd tooling. */
export const NAME_MAX_LENGTH = 30;

/** Pure instance-name policy for paths, labels, and route parameters. */
export function isValidInstanceName(name: string): boolean {
  return name.length >= 1 && name.length <= NAME_MAX_LENGTH && NAME_RE.test(name);
}
