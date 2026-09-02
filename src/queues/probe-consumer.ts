import {
  getCatalogSystem,
  getSystemFeedStub,
  loadCatalog,
} from "../catalog";
import { classifyProviderError } from "../durable";
import type {
  ProviderErrorClass,
  SystemFeed,
  SystemFeedProbeResult,
} from "../durable";
import { emitMetric, logEvent } from "../observability";
import { recordProbeStatus } from "../status";
import type { StatusCycle } from "../status";
import type { SystemProbeStatus } from "../status";
import { ProbeMessageSchema } from "./types";
import type { ProbeMessage } from "./types";

const MAX_RETRY_DELAY_SECONDS = 15 * 60;

export const queueRetryDelaySeconds = (attempts: number): number =>
  Math.min(MAX_RETRY_DELAY_SECONDS, 60 * 2 ** Math.max(0, attempts - 1));

const cacheStatus = (
  result: SystemFeedProbeResult,
): SystemProbeStatus["cache_status"] => {
  const expiry = result.health.snapshot_expires_at;
  if (expiry === null) return "miss";
  return Date.parse(expiry) < Date.now() ? "stale" : "fresh";
};

export const probeStatus = (
  message: ProbeMessage,
  result: SystemFeedProbeResult,
  checkedAt: Date,
): SystemProbeStatus => {
  const fetchedAt = result.health.snapshot_fetched_at;
  const ageSeconds =
    result.health.status_source_age_seconds ??
    (fetchedAt === null
      ? null
      : Math.max(
          0,
          Math.floor((checkedAt.getTime() - Date.parse(fetchedAt)) / 1_000),
        ));
  return {
    schema_version: 1,
    cycle_id: message.cycle_id,
    catalog_version: message.catalog_version,
    system_id: message.system_id,
    checked_at: checkedAt.toISOString(),
    outcome: result.ok
      ? result.health.state === "healthy"
        ? "healthy"
        : "degraded"
      : result.health.ready
        ? "degraded"
        : "unavailable",
    cache_status: cacheStatus(result),
    circuit_state: result.health.circuit_state,
    age_seconds: ageSeconds,
    retryable: result.retryable,
    error_class: result.error_class ?? null,
    detected_version:
      result.discovery_metadata?.detected_version ??
      result.health.detected_version,
    capabilities: result.discovery_metadata?.capabilities ?? null,
    last_successful_probe:
      result.discovery_metadata?.last_successful_probe ??
      result.health.last_success_at,
  };
};

const unavailableStatus = (
  message: ProbeMessage,
  errorClass: ProviderErrorClass,
  checkedAt: Date,
): SystemProbeStatus => ({
  schema_version: 1,
  cycle_id: message.cycle_id,
  catalog_version: message.catalog_version,
  system_id: message.system_id,
  checked_at: checkedAt.toISOString(),
  outcome: "unavailable",
  cache_status: "unknown",
  circuit_state: "unknown",
  age_seconds: null,
  retryable: false,
  error_class: errorClass,
  detected_version: null,
  capabilities: null,
  last_successful_probe: null,
});

const persistAndAggregateStatus = async (
  env: Env,
  status: SystemProbeStatus,
  cycle: StatusCycle,
): Promise<void> => {
  const coordinator = env.SYSTEM_FEEDS.getByName("__openbike_status__", {
    locationHint: "enam",
  }) as unknown as Pick<SystemFeed, "materializeProbeStatus">;
  const materialized = await coordinator.materializeProbeStatus(cycle, status);
  if (
    materialized.cycle_id === status.cycle_id &&
    materialized.catalog_version === status.catalog_version
  ) {
    await recordProbeStatus(env, status);
  }
};

const probeCycle = (message: ProbeMessage): StatusCycle => ({
  schema_version: 1,
  cycle_id: message.cycle_id,
  catalog_version: message.catalog_version,
  catalog_published_at: message.catalog_published_at,
  started_at: message.enqueued_at,
  systems_scheduled: message.systems_scheduled,
  systems_completed: 0,
  systems_healthy: 0,
  systems_degraded: 0,
  systems_unavailable: 0,
  last_probe_activity_at: null,
  state: message.systems_scheduled === 0 ? "complete" : "probing",
});

const processMessage = async (
  message: Message<unknown>,
  env: Env,
): Promise<void> => {
  const parsed = ProbeMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    logEvent("warn", "invalid_probe_message", {
      component: "probe_queue",
      operation: "consume",
      outcome: "discarded",
      attempt: message.attempts,
    });
    message.ack();
    return;
  }
  const probe = parsed.data;
  const startedAt = Date.now();
  try {
    const catalog = await loadCatalog(env, {
      version: probe.catalog_version,
      allowBundledFallback: false,
    });
    const system = getCatalogSystem(catalog, probe.system_id);
    if (system === undefined || !system.enabled) {
      await persistAndAggregateStatus(
        env,
        unavailableStatus(probe, "unsupported_version", new Date()),
        probeCycle(probe),
      );
      message.ack();
      return;
    }
    const stub = getSystemFeedStub(env, system) as unknown as Pick<
      SystemFeed,
      "probe"
    >;
    const result = await stub.probe(system, {
      idempotencyKey: probe.idempotency_key,
    });
    await persistAndAggregateStatus(
      env,
      probeStatus(probe, result, new Date()),
      probeCycle(probe),
    );
    emitMetric(env, {
      index: system.system_id,
      event: "probe",
      component: "probe_queue",
      operation: "consume",
      outcome: result.ok ? "success" : "failure",
      ...(result.error_class === null
        ? {}
        : { errorClass: result.error_class }),
      cacheStatus: cacheStatus(result),
      circuitState: result.health.circuit_state,
      durationMs: Date.now() - startedAt,
      attempt: message.attempts,
    });
    if (result.retryable) {
      message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts) });
    } else {
      message.ack();
    }
  } catch (error) {
    const failure = classifyProviderError(error);
    logEvent("warn", "probe_message_failed", {
      system_id: probe.system_id,
      component: "probe_queue",
      operation: "consume",
      outcome: "retry",
      error_class: failure.errorClass,
      attempt: message.attempts,
      duration_ms: Date.now() - startedAt,
    });
    message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts) });
  }
};

export const processProbeBatch = async (
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> => {
  for (const message of batch.messages) await processMessage(message, env);
};

export const processProbeDlqBatch = async (
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> => {
  for (const message of batch.messages) {
    const parsed = ProbeMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      logEvent("warn", "invalid_probe_dlq_message", {
        component: "probe_queue",
        operation: "dead_letter",
        outcome: "discarded",
        attempt: message.attempts,
      });
      message.ack();
      continue;
    }
    try {
      await persistAndAggregateStatus(
        env,
        unavailableStatus(parsed.data, "unknown", new Date()),
        probeCycle(parsed.data),
      );
      emitMetric(env, {
        index: parsed.data.system_id,
        event: "probe_dead_letter",
        component: "probe_queue",
        operation: "dead_letter",
        outcome: "failure",
        attempt: message.attempts,
      });
      message.ack();
    } catch {
      logEvent("error", "probe_dlq_status_failed", {
        system_id: parsed.data.system_id,
        component: "probe_queue",
        operation: "dead_letter",
        outcome: "retry",
        attempt: message.attempts,
      });
      message.retry({ delaySeconds: 60 });
    }
  }
};

export const dispatchProbeBatch = async (
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> => {
  if (batch.queue === env.PROBE_DLQ_QUEUE_NAME) {
    await processProbeDlqBatch(batch, env);
    return;
  }
  await processProbeBatch(batch, env);
};
