import pino from 'pino';

const logger = pino({ level: 'info' });

export default logger;
export function createChildLogger(name: string) {
  return logger.child({ component: name });
}
