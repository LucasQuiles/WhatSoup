import type { MessageVolumeBucket, SessionActivityBucket } from '../types.js';

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values, 1);
  return values.map((value) => value / max);
}

export interface FleetMessageSparklines {
  inbound: number[];
  outbound: number[];
  media: number[];
}

export interface FleetSessionSparklines {
  active: number[];
}

export function deriveFleetMessageSparklines(
  messageVolume: MessageVolumeBucket[] | undefined,
): FleetMessageSparklines | undefined {
  if (!messageVolume || messageVolume.length === 0) return undefined;

  const buckets = [...messageVolume].sort((a, b) => a.bucket.localeCompare(b.bucket));
  return {
    inbound: normalize(buckets.map((bucket) => bucket.inbound)),
    outbound: normalize(buckets.map((bucket) => bucket.outbound)),
    media: normalize(buckets.map((bucket) => bucket.media)),
  };
}

export function deriveFleetSessionSparklines(
  sessionActivity: SessionActivityBucket[] | undefined,
): FleetSessionSparklines | undefined {
  if (!sessionActivity || sessionActivity.length === 0) return undefined;

  const buckets = [...sessionActivity].sort((a, b) => a.bucket.localeCompare(b.bucket));
  return {
    active: normalize(buckets.map((bucket) => bucket.active)),
  };
}
