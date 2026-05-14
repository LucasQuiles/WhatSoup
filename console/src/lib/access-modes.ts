export const ACCESS_MODE_VALUES = [
  'self_only',
  'allowlist',
  'open_dm',
  'groups_only',
] as const;

export type AccessModeValue = (typeof ACCESS_MODE_VALUES)[number];

export const ACCESS_MODE_DETAILS = {
  self_only: {
    label: 'Admin Only',
    description: 'Only admin phone numbers can interact',
  },
  allowlist: {
    label: 'Allowlist',
    description: 'Approved contacts only',
  },
  open_dm: {
    label: 'Open DMs',
    description: 'Anyone can send direct messages',
  },
  groups_only: {
    label: 'Groups Only',
    description: 'Only responds in group chats',
  },
} satisfies Record<AccessModeValue, { label: string; description: string }>;

export const ACCESS_MODE_LABELS = Object.fromEntries(
  ACCESS_MODE_VALUES.map((mode) => [mode, ACCESS_MODE_DETAILS[mode].label]),
) as Record<AccessModeValue, string>;
