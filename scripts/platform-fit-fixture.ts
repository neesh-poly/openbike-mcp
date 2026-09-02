import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { cpus, platform as hostPlatform, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { parseLocalProcessTreeUsage } from "./platform-fit-resource";

const RESULT_MARKER = "OPENBIKE_PLATFORM_FIT_RESULT:";
const timeBinary = "/usr/bin/time";

const tempDirectory = await mkdtemp(join(tmpdir(), "openbike-platform-fit-"));
const resourceOutput = join(tempDirectory, "resource-usage.txt");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const vitestArguments = [
  "exec",
  "vitest",
  "run",
  "--config",
  "vitest.platform-fit.config.ts",
  "--reporter",
  "verbose",
  "--no-color",
];

try {
  const canMeasureResources =
    existsSync(timeBinary) &&
    (process.platform === "darwin" || process.platform === "linux");
  const command = canMeasureResources ? timeBinary : pnpmCommand;
  const args = canMeasureResources
    ? [
        ...(process.platform === "darwin" ? ["-l"] : ["-v"]),
        "-o",
        resourceOutput,
        pnpmCommand,
        ...vitestArguments,
      ]
    : vitestArguments;
  const startedAt = performance.now();
  const execution = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  const harnessWallMs = Math.round((performance.now() - startedAt) * 10) / 10;
  const combinedOutput = `${execution.stdout ?? ""}\n${execution.stderr ?? ""}`;

  if (execution.error !== undefined) throw execution.error;
  if (execution.status !== 0) {
    process.stderr.write(combinedOutput);
    process.exitCode = execution.status ?? 1;
  } else {
    const markerIndex = combinedOutput.indexOf(RESULT_MARKER);
    if (markerIndex < 0) {
      throw new Error("The workerd benchmark did not emit a result payload");
    }
    const encodedResult = combinedOutput
      .slice(markerIndex + RESULT_MARKER.length)
      .split(/\r?\n/, 1)[0];
    if (encodedResult === undefined) {
      throw new Error("The workerd benchmark emitted an empty result payload");
    }
    const workerd = JSON.parse(encodedResult) as Record<string, unknown>;
    const resourceText = canMeasureResources
      ? await readFile(resourceOutput, "utf8")
      : "";
    const localProcessTree = parseLocalProcessTreeUsage(
      resourceText,
      process.platform,
    );

    const report = {
      schema_version: 1,
      measured_at: new Date().toISOString(),
      benchmark: "openbike-recorded-fixture-platform-fit",
      host: {
        platform: hostPlatform(),
        architecture: process.arch,
        node: process.version,
        cpu_model: cpus()[0]?.model ?? "unknown",
      },
      harness_wall_ms: harnessWallMs,
      workerd,
      local_process_tree: localProcessTree,
      unsupported_locally: {
        per_invocation_cpu_ms:
          "Use deployed Workers traces or invocation logs; local process CPU includes the full harness.",
        peak_isolate_memory_bytes:
          "Use the workerd/Workers DevTools heap profiler and deployed exceededMemory outcomes; process-tree RSS is not isolate RSS.",
        production_network_latency:
          "The fixture benchmark is intentionally offline and cannot establish a production latency SLO.",
        independent_rpc_fan_in:
          "Concurrent calls run inside one Durable Object test callback; replay the public request path in staging to measure Worker-to-Durable-Object scheduling and serialization.",
        worst_case_provider_payload:
          "The repository fixture is deterministic synthetic data, not a captured maximum-size live provider feed.",
      },
      gate_interpretation:
        "Functional coalescing, operation, payload-size, and local latency gates are automated. The production platform-fit gate remains incomplete until deployed CPU and isolate-memory evidence is recorded.",
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
