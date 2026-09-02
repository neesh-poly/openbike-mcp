# Probe queue and dead-letter runbook

The probe queues deliver at least once. Every message is keyed by catalog version and system ID, and the consumer records the idempotency key before acknowledging success. The same Worker consumes the DLQ at concurrency 1 and converts each exhausted probe into a terminal `unavailable` status before acknowledging it. The DLQ consumer has four bounded retries and no dead-letter target of its own, so a storage failure cannot create a queue cycle. Thirty minutes after enqueue, the durable Workflow reconciles the enabled catalog IDs against the coordinator's terminal results and idempotently marks any missing or still-retryable result unavailable in the aggregate. This closes the public cycle even if every DLQ terminalization attempt failed. A system completed only by reconciliation can lack its per-system R2 status object; the aggregate coordinator is authoritative for cycle completion, while discovery falls back to the reviewed catalog when that derived per-system object is absent.

## Triage

1. Inspect the safe error class and attempt count in Workers Logs. Never paste a raw provider response into an issue.
2. Confirm the affected cycle advances to a terminal `unavailable` result in `/status`; the versioned per-system status object in R2 is the audit record.
3. Confirm whether the failure is one provider, a catalog publication, a platform limit, or the service itself.
4. Check the discovery URL directly only when its hostname is already reviewed in the active catalog.
5. Correct bad catalog metadata through a new immutable catalog version. Fix adapter defects in code and deploy through staging.
6. The DLQ consumer acknowledges messages after terminalization, so it is not a retained manual-redrive backlog. After the cause is resolved, start a new probe cycle or enqueue the original deterministic probe message on the primary queue.

## Containment

- For an abusive or persistently broken provider, disable the system through the reviewed override path rather than increasing retries.
- If queue work threatens the USD 25 monthly ceiling, set Workflow schedules to an empty list or pause the Workflow in Cloudflare, then drain or delete pending probe messages only after recording the reason.
- Do not increase `max_concurrency` above the reviewed value without a staging usage replay.
