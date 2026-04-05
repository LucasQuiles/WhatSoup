import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { FleetMetrics, LineMetrics, MetricsRange } from '../types';

export function getMetricsQueryOptions(name: string, range: MetricsRange) {
  return queryOptions<LineMetrics, Error, LineMetrics, ['metrics', string, MetricsRange]>({
    queryKey: ['metrics', name, range],
    queryFn: () => api.getMetrics(name, range),
    enabled: !!name,
    refetchInterval: 60_000,
  });
}

export function useMetrics(name: string, range: MetricsRange) {
  return useQuery(getMetricsQueryOptions(name, range));
}

export function getFleetMetricsQueryOptions(range: MetricsRange) {
  return queryOptions<FleetMetrics, Error, FleetMetrics, ['fleet-metrics', MetricsRange]>({
    queryKey: ['fleet-metrics', range],
    queryFn: () => api.getFleetMetrics(range),
    refetchInterval: 60_000,
  });
}

export function useFleetMetrics(range: MetricsRange = '24h') {
  return useQuery(getFleetMetricsQueryOptions(range));
}
