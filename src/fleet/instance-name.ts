/** Valid instance name pattern: lowercase alphanumeric + hyphens, starting with a letter. */
export const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Maximum instance name length shared by fleet routes and launchd tooling. */
export const NAME_MAX_LENGTH = 30;

/** Pure instance-name policy for paths, labels, and route parameters. */
export function isValidInstanceName(name: string): boolean {
  return name.length >= 1 && name.length <= NAME_MAX_LENGTH && NAME_RE.test(name);
}

/**
 * Names a NEW instance may not take, with the reason. A retired launchd job keeps its `com.whatsoup.<name>` label:
 * an instance of that name would get the same label and plist path, which the launchd checks report as the retired
 * job (docs/releases/2026-11-20-token-backup-job-retired.md). Existing instances are not judged here, so
 * `isValidInstanceName` stays unchanged for them.
 */
const RESERVED_INSTANCE_NAMES: ReadonlyMap<string, string> = new Map([
  ['ms365-token-backup', 'com.whatsoup.ms365-token-backup is the label of a retired launchd job'],
]);

/** Why a new instance may not be named `name`, or null when the name is free. */
export function reservedInstanceNameReason(name: string): string | null {
  return RESERVED_INSTANCE_NAMES.get(name) ?? null;
}
