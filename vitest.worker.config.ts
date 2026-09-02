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
        compatibilityDate: "2026-08-22",
      },
      additionalExports: {
        SystemFeed: "DurableObject",
        CatalogRefreshWorkflow: "WorkflowEntrypoint",
      },
    }),
  ],
  test: {
    include: [
      "tests/integration/**/*.test.ts",
      "tests/durable/**/*.test.ts",
      "tests/workflow/**/*.test.ts",
    ],
  },
});
