import { createChildLogger } from '../logger.ts';
import {
  clearRecoveryMarker,
  setRecoveryMarker,
} from '../lib/recovery-authority-store.ts';

const log = createChildLogger('fleet:recovery-marker');

export function setRecoveryMarkerObserved(name: string, source: string): void {
  try {
    setRecoveryMarker(`${name}:${source}`);
  } catch (err) {
    log.warn(
      { err, name, source },
      'recovery authority marker write failed',
    );
  }
}

export function clearRecoveryMarkerObserved(name: string, source: string): void {
  try {
    clearRecoveryMarker(`${name}:${source}`);
  } catch (err) {
    log.warn(
      { err, name, source },
      'recovery authority marker clear failed',
    );
  }
}
