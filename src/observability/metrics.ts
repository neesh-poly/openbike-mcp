export interface MetricEvent {
  index: string;
  event: string;
  component: string;
  operation: string;
  outcome: string;
  errorClass?: string;
  cacheStatus?: string;
  circuitState?: string;
  catalogVersion?: string;
  workerVersion?: string;
  durationMs?: number;
  resultCount?: number;
  ageSeconds?: number;
  httpStatus?: number;
  attempt?: number;
  consecutiveFailures?: number;
  partial?: boolean;
}

const cleanBlob = (value: string | undefined): string =>
  (value ?? "").slice(0, 256);

const cleanDouble = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) ? value : 0;

export const metricDataPoint = (
  metric: MetricEvent,
): AnalyticsEngineDataPoint => ({
  indexes: [cleanBlob(metric.index)],
  blobs: [
    cleanBlob(metric.event),
    cleanBlob(metric.component),
    cleanBlob(metric.operation),
    cleanBlob(metric.outcome),
    cleanBlob(metric.errorClass),
    cleanBlob(metric.cacheStatus),
    cleanBlob(metric.circuitState),
    cleanBlob(metric.catalogVersion),
    cleanBlob(metric.workerVersion),
  ],
  doubles: [
    cleanDouble(metric.durationMs),
    cleanDouble(metric.resultCount),
    cleanDouble(metric.ageSeconds),
    cleanDouble(metric.httpStatus),
    cleanDouble(metric.attempt),
    cleanDouble(metric.consecutiveFailures),
    metric.partial === true ? 1 : 0,
  ],
});

export const emitMetric = (
  env: Pick<Env, "METRICS">,
  metric: MetricEvent,
): void => {
  env.METRICS.writeDataPoint(metricDataPoint(metric));
};
