const HOUR_MS = 60 * 60 * 1000;

export interface HeartbeatInput {
  now: number;
  lastHeartbeatTs: number | undefined;
  thresholdHours: number;
}

export interface HeartbeatResult {
  silent: boolean;
  elapsedHours: number;
  reason?: string;
}

export function detectHeartbeatSilence(input: HeartbeatInput): HeartbeatResult {
  if (input.lastHeartbeatTs === undefined) {
    return { silent: true, elapsedHours: Infinity, reason: 'no heartbeat recorded' };
  }

  const elapsedHours = (input.now - input.lastHeartbeatTs) / HOUR_MS;
  if (elapsedHours < 0) {
    return { silent: false, elapsedHours, reason: 'last heartbeat is in the future' };
  }

  if (elapsedHours > input.thresholdHours) {
    return { silent: true, elapsedHours, reason: 'heartbeat silence threshold exceeded' };
  }

  return { silent: false, elapsedHours };
}
