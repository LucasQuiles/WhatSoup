// src/config.ts
// Minimal config stub — full implementation comes in Task 16.
// Exported shape must satisfy all current consumers in src/core/.

export type AccessMode = 'self_only' | 'allowlist' | 'open_dm' | 'groups_only';

export interface Config {
  adminPhones: Set<string>;
  dbPath: string;
  authDir: string;
  mediaDir: string;
  botName: string;
  accessMode: AccessMode;
  healthPort: number;
  models: {
    conversation: string;
    extraction: string;
    validation: string;
    fallback: string;
  };
}

export const config: Config = {
  adminPhones: new Set(
    (process.env.ADMIN_PHONES ?? '').split(',').map((p) => p.trim()).filter(Boolean),
  ),
  dbPath: process.env.WHATSOUP_DB_PATH ?? '/var/lib/whatsoup/data.db',
  authDir: process.env.WHATSOUP_AUTH_DIR ?? '/var/lib/whatsoup/auth',
  mediaDir: process.env.WHATSOUP_MEDIA_DIR ?? '/tmp/whatsoup-media',
  botName: process.env.WHATSOUP_BOT_NAME ?? 'WhatSoup',
  accessMode: (process.env.WHATSOUP_ACCESS_MODE ?? 'allowlist') as AccessMode,
  healthPort: parseInt(process.env.WHATSOUP_HEALTH_PORT ?? '9090', 10),
  models: {
    conversation: process.env.WHATSOUP_MODEL_CONVERSATION ?? 'claude-opus-4-5',
    extraction: process.env.WHATSOUP_MODEL_EXTRACTION ?? 'claude-haiku-4-5',
    validation: process.env.WHATSOUP_MODEL_VALIDATION ?? 'claude-haiku-4-5',
    fallback: process.env.WHATSOUP_MODEL_FALLBACK ?? 'claude-sonnet-4-5',
  },
};
