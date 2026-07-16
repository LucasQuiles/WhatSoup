export const WHATSOUP_HEADLESS_EXECUTION_PROFILE = 'whatsoup-headless' as const;

export function isWhatSoupHeadlessExecutionProfile(
  value: unknown,
): value is typeof WHATSOUP_HEADLESS_EXECUTION_PROFILE {
  return value === WHATSOUP_HEADLESS_EXECUTION_PROFILE;
}
