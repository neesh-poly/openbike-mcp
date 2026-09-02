import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
        environment: "staging",
      },
      miniflare: {
        // Pin to the newest date supported by this repository's local workerd
        // binary. Production remains on the date declared in wrangler.jsonc.
        compatibilityDate: "2026-08-22",
      },
      additionalExports: {
        SystemFeed: "DurableObject",
        CatalogRefreshWorkflow: "WorkflowEntrypoint",
      },
    }),
  ],
  test: {
    include: ["tests/platform-fit/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
  },
});
