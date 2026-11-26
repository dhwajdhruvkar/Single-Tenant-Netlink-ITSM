import { ConfigError, loadConfig } from "@/platform/config/env";

// Node.js-only startup checks. Invalid configuration stops the process with a readable message
// (non-zero exit so a container supervisor reports the failure).
export function validateStartup(): void {
  try {
    loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      if (process.env.NODE_ENV === "production") process.exit(1);
    }
    throw err;
  }
}
