import { execFileSync } from "node:child_process";
import { testDatabaseUrl } from "./setup";

// Apply the repository's migrations to the local test database before any integration test runs.
export default function globalSetup() {
  const url = testDatabaseUrl(); // throws unless local and *_test
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}
