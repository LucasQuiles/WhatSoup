import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { queryFreshness } from '../lib/freshness.js';
import type { FleetMetrics, LineMetrics, MetricsRange } from '../types.js';

export function getMetricsQueryOptions(name: string, range: MetricsRange) {
  return queryOptions<LineMetrics, Error, LineMetrics, ['metrics', string, MetricsRange]>({
    queryKey: ['metrics', name, range],
    queryFn: () => api.getMetrics(name, range),
    enabled: !!name,
    refetchInterval: 60_000,
  });
}

export function useMetrics(name: string, range: MetricsRange) {
  const query = useQuery(getMetricsQueryOptions(name, range));
  return {
    ...query,
    freshness: queryFreshness({
      dataUpdatedAt: query.dataUpdatedAt,
      refetchFailed: query.isRefetchError,
    }),
  };
}

export function getFleetMetricsQueryOptions(range: MetricsRange) {
  return queryOptions<FleetMetrics, Error, FleetMetrics, ['fleet-metrics', MetricsRange]>({
    queryKey: ['fleet-metrics', range],
    queryFn: () => api.getFleetMetrics(range),
    refetchInterval: 60_000,
  });
}

export function useFleetMetrics(range: MetricsRange = '24h') {
  const query = useQuery(getFleetMetricsQueryOptions(range));
  return {
    ...query,
    freshness: queryFreshness({
      dataUpdatedAt: query.dataUpdatedAt,
      refetchFailed: query.isRefetchError,
    }),
  };
}
