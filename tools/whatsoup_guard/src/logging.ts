import pino from 'pino';
import type { StoreLogger } from './store/connection.ts';

export function createGuardLogger(): StoreLogger {
  const level = process.env.WHATSOUP_GUARD_LOG_LEVEL;
  if (!level || level.trim().length === 0) return {};

  return pino({
    name: 'whatsoup-guard',
    level,
  }, pino.destination(2));
}
