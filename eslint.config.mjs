import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([".next/**", "coverage/**", "node_modules/**", "out/**", "build/**", "next-env.d.ts", "src/generated/**"]),
  {
    // Domain modules stay framework- and host-neutral so they can move to company servers unchanged.
    files: ["src/modules/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["next", "next/*", "next-auth", "next-auth/*"], message: "Domain modules must not import Next.js." },
            { group: ["@vercel/*"], message: "Domain modules must not import Vercel SDKs." },
          ],
        },
      ],
    },
  },
]);
