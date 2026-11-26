import { defineConfig } from "vitest/config";

// Integration tests (Phase 2 onward) run against local Docker Postgres only.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
    fileParallelism: false,
  },
});
