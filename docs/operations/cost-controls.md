# Cost controls

The initial production canary is expected to stay near the Workers Paid minimum and must remain below an approximate USD 25 monthly ceiling. Cloudflare already has a USD 10 budget notification configured; this is a warning, not a hard spending cap.

- Candidate systems are capped at four per request; results and response bodies are bounded.
- The anonymous rate-limit binding permits 60 request-cost units per minute per coarse client key. It protects MCP traffic plus the KV/R2-backed `/readyz` and `/status` routes; the constant local `/` and `/healthz` responses remain unmetered.
- Probe consumers use batches of five and a maximum concurrency of two per environment.
- Catalog publication runs once daily. Normal station queries do not fetch large `free_bike_status` feeds.
- Production logs sample 25% of invocations and traces sample 10%; exact coordinates and bodies are excluded.
- Staging is not a permanent load generator.

Cloudflare billing notifications are warnings, not a guaranteed hard cap. At a projected USD 20 monthly run rate, pause scheduled probes and inspect request, Durable Object duration, observability, R2, KV, Queue, and Workflow usage. Before projected spend can exceed USD 25, disable nonessential background work or the production route until the driver is understood.
