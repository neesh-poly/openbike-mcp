# Cloudflare platform-fit benchmark

Run the offline, repeatable gate before staging deployment:

```bash
pnpm benchmark:platform
```

The command executes the production `SystemFeed` Durable Object inside local
`workerd` through Cloudflare's Vitest integration. It deterministically expands
the repository's Citi-like GBFS 2.3 fixture to 6,000 stations and starts 1, 10,
and 100 forced cold-cache requests for the same system. Every scenario gets a
new Durable Object, so it starts without a snapshot.

The concurrency calls are made directly against one `SystemFeed` instance via
`runInDurableObject`. That isolates the cache/refresh implementation and its
SQLite writes, but it does not measure the serialization and scheduling cost of
100 independent Worker-to-Durable-Object RPC calls.

## Automated evidence

The JSON report records and asserts:

- every caller completed with a fresh snapshot;
- all same-system misses collapsed to one logical refresh (`successes = 1` and
  five total upstream reads, independent of caller count);
- provider work never exceeded four simultaneous subfeed reads;
- the serialized normalized snapshot and every source feed stayed inside their
  configured byte bounds; and
- local cold-request p95 stayed below five seconds for each concurrency level.

The fixture fetcher adds a fixed 5 ms delay so the concurrent subfeed ceiling is
observable, but performs no live network I/O. The report includes per-request
wall latency and whole-harness user/system CPU plus peak resident memory when
`/usr/bin/time` is available on macOS or Linux.

## Initial deployed canary evidence

The September 2, 2026 production launch uploaded a 249.74 KiB gzip bundle with a reported 78 ms Worker startup time. The public production smoke passed both supported MCP client modes and all five tools. From the launch machine, 10-sample p95 wall times were 69.7 ms for `/healthz`, 26.9 ms for `/readyz`, and 581 ms for warm `find_systems`. These single-origin client measurements validate the launched request path but are not an availability SLO or a substitute for isolate CPU and memory profiling.

## What the local report does not prove

Whole-process CPU and RSS include Node, pnpm, Vitest, Vite, and `workerd`. They
are diagnostic proxies, not per-invocation CPU or the memory used by one
Cloudflare isolate, and are deliberately not compared with Cloudflare's runtime
limits. The synthetic amplified fixture also does not prove behavior for the
largest feed in the live provider catalog.

Complete the pre-private-alpha platform-fit gate with deployed staging and
production evidence and record:

1. per-invocation CPU and wall time from Workers traces or invocation logs;
2. a DevTools heap profile while replaying the largest reviewed provider
   capture, plus confirmation that no `exceededMemory` outcomes occurred; and
3. client-observed cold and warm p95 from the intended launch regions.

Cloudflare documents the 128 MB per-isolate ceiling and CPU accounting in
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
the runtime-backed local test model in
[Workers testing](https://developers.cloudflare.com/workers/testing/), and the
manual CPU profile workflow in
[Profiling CPU usage](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/).
