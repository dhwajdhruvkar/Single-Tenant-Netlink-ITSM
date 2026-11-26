import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    // Component tests opt into jsdom with a `// @vitest-environment jsdom` docblock.
    include: ["tests/unit/**/*.test.ts", "tests/component/**/*.test.{ts,tsx}"],
  },
});
