import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.ts",
      "tests/contract/**/*.test.ts",
      "tests/catalog/**/*.test.ts",
      "tests/security/**/*.test.ts",
    ],
  },
});
