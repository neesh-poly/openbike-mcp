import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { dispatchProbeBatch, probeStatus } from "../../src/queues";
import type { SystemFeedProbeResult } from "../../src/durable";
import { readPublicStatus, SystemProbeStatusSchema } from "../../src/status";
import type { ProbeMessage } from "../../src/queues";

const probeMessage = (suffix: string): ProbeMessage => ({
  schema_version: 1,
  cycle_id: `dlq-cycle-${suffix}`,
  catalog_version: `dlq-catalog-${suffix}`,
  catalog_published_at: "2026-09-02T04:00:00.000Z",
  system_id: `dlq-system-${suffix}`,
  idempotency_key: `dlq-catalog-${suffix}:dlq-system-${suffix}`,
  enqueued_at: "2026-09-02T04:00:00.000Z",
  systems_scheduled: 1,
});

const messageBatch = (
  queue: string,
  body: unknown,
  ack: () => void,
  retry: (options?: QueueRetryOptions) => void,
): MessageBatch<unknown> => ({
  queue,
  metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
  messages: [
    {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      body,
      attempts: 5,
      ack,
      retry,
    },
  ],
  ackAll: vi.fn(),
  retryAll: vi.fn(),
});

describe("probe dead-letter consumer", () => {
  it("marks a successful but source-stale probe degraded with source age", () => {
    const suffix = crypto.randomUUID();
    const result = {
      ok: true,
      retryable: false,
      duplicate: false,
      error_class: null,
      discovery_metadata: null,
      health: {
        system_id: `probe-system-${suffix}`,
        discovery_url: "https://example.com/gbfs.json",
        detected_version: "2.3",
        ready: true,
        state: "degraded",
        circuit_state: "closed",
        consecutive_failures: 0,
        open_until: null,
        last_success_at: "2026-09-02T12:02:00.000Z",
        last_error_at: null,
        last_error_class: null,
        snapshot_fetched_at: "2026-09-02T12:01:59.000Z",
        snapshot_expires_at: "2026-09-02T12:02:29.000Z",
        status_source_age_seconds: 120,
        observation_count: 5,
        feeds: [],
        rolling_success_rate: 1,
        rolling_window_seconds: 86_400,
        successes: 1,
        failures: 0,
      },
    } satisfies SystemFeedProbeResult;

    expect(
      probeStatus(
        probeMessage(suffix),
        result,
        new Date("2026-09-02T12:02:00.000Z"),
      ),
    ).toMatchObject({
      outcome: "degraded",
      age_seconds: 120,
      retryable: false,
    });
  });

  it("dispatches the DLQ by queue name and completes the probe cycle", async () => {
    const suffix = crypto.randomUUID();
    const probe = probeMessage(suffix);
    const ack = vi.fn();
    const retry = vi.fn();

    await dispatchProbeBatch(
      messageBatch(env.PROBE_DLQ_QUEUE_NAME, probe, ack, retry),
      env,
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    const publicStatus = await readPublicStatus(env);
    expect(publicStatus.cycle).toMatchObject({
      cycle_id: probe.cycle_id,
      catalog_version: probe.catalog_version,
      systems_scheduled: 1,
      systems_completed: 1,
      systems_unavailable: 1,
      state: "complete",
    });

    const stored = await env.CATALOG_KV.get<{ key: string }>(
      `status:cycle:${probe.cycle_id}:system:${probe.system_id}`,
      "json",
    );
    expect(stored).not.toBeNull();
    const object = await env.CATALOG_R2.get(stored!.key);
    expect(object).not.toBeNull();
    expect(SystemProbeStatusSchema.parse(await object!.json())).toMatchObject({
      cycle_id: probe.cycle_id,
      system_id: probe.system_id,
      outcome: "unavailable",
      retryable: false,
      error_class: "unknown",
    });
  });

  it("acknowledges malformed DLQ messages instead of retrying them", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    await dispatchProbeBatch(
      messageBatch(env.PROBE_DLQ_QUEUE_NAME, { invalid: true }, ack, retry),
      env,
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
