import { z } from "zod";

// Validated environment contract (docs/planning/IMPLEMENTATION_ROADMAP.md section 4).
// Variables used by later phases are declared here now (optional) so the contract lives in one place;
// production additionally requires the ones that must exist for a safe deployment.

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const intString = (def: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a non-negative integer")
    .default(String(def))
    .transform(Number);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a GUID");

const postgresUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\//i.test(v), "must be a postgresql:// URL");

const schema = z.object({
  APP_ENV: z.enum(["local", "test", "staging", "production"]).default("local"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: postgresUrl,
  DIRECT_URL: postgresUrl.optional(),

  AUTH_SECRET: optionalString,
  AUTH_TRUST_HOST: bool.default(true),
  AUTH_URL: optionalString,
  ENTRA_TENANT_ID: guid.optional(),
  ENTRA_CLIENT_ID: guid.optional(),
  ENTRA_CLIENT_SECRET: optionalString,
  ENTRA_ROLE_AGENT: z.string().default("ITSM.Agent"),
  ENTRA_ROLE_MANAGER: z.string().default("ITSM.Manager"),
  ENTRA_ROLE_ADMIN: z.string().default("ITSM.Admin"),
  ENTRA_ROLE_SUBMITTER: z.string().default("ITSM.Submitter"),
  SESSION_MAX_AGE_HOURS: intString(8),
  // [OPEN] Whether agents may see all tickets regardless of queue. Default off (queue-scoped).
  AGENTS_VIEW_ALL_TICKETS: bool.default(false),

  GRAPH_TENANT_ID: guid.optional(),
  GRAPH_CLIENT_ID: guid.optional(),
  GRAPH_CLIENT_SECRET: optionalString,
  DIRECTORY_SYNC_ENABLED: bool.default(false),
  DIRECTORY_ELIGIBILITY_COMPANY_NAME: optionalString,
  // [OPEN] Comma-separated UPN prefixes that mark service/shared accounts, excluded from the directory.
  DIRECTORY_ELIGIBILITY_EXCLUDE_UPN_PREFIXES: z.string().default("svc-"),

  STORAGE_PROVIDER: z.enum(["local", "database", "s3", "azure_blob"]).default("database"),
  ATTACHMENT_MAX_BYTES: intString(4 * 1024 * 1024),
  // Rollback switch: false hides the UI and rejects uploads with 503.
  ATTACHMENTS_ENABLED: bool.default(true),
  STORAGE_LOCAL_DIR: z.string().default("./storage-local"),
  ATTACHMENT_REQUIRE_CLEAN_SCAN: bool.default(false),

  EMAIL_PROVIDER: z.enum(["noop", "graph", "smtp"]).default("noop"),
  SUPPORT_MAILBOX: optionalString,
  TEAMS_NOTIFICATIONS_ENABLED: bool.default(false),

  CRON_SECRET: optionalString,
  JOBS_INLINE_DISPATCH: bool.default(true),
  WORKER_POLL_MS: intString(15000),
  APP_ROLE: z.enum(["web", "worker"]).default("web"),

  TRUST_PROXY_HEADERS: bool.default(false),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const PRODUCTION_REQUIRED = [
  "AUTH_SECRET",
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "ENTRA_CLIENT_SECRET",
  "CRON_SECRET",
] as const;

/** Parse and validate an environment. Throws ConfigError listing every problem (never secret values). */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = schema.safeParse(env);
  const problems: string[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    throw new ConfigError(problems);
  }
  const cfg = result.data;

  if (cfg.EMAIL_PROVIDER === "graph") {
    if (!cfg.SUPPORT_MAILBOX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.SUPPORT_MAILBOX)) problems.push("SUPPORT_MAILBOX: a valid email address is required when EMAIL_PROVIDER is graph");
    for (const key of ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET"] as const) {
      if (!cfg[key]) problems.push(`${key}: required when EMAIL_PROVIDER is graph`);
    }
  }
  if (cfg.APP_ENV === "production" || cfg.APP_ENV === "staging") {
    for (const key of PRODUCTION_REQUIRED) {
      if (!cfg[key]) problems.push(`${key}: required when APP_ENV is ${cfg.APP_ENV}`);
    }
    if (cfg.AUTH_SECRET && cfg.AUTH_SECRET.length < 32) problems.push("AUTH_SECRET: must be at least 32 characters");
    if (cfg.CRON_SECRET && cfg.CRON_SECRET.length < 32) problems.push("CRON_SECRET: must be at least 32 characters");
    if (!cfg.APP_BASE_URL.startsWith("https://")) problems.push("APP_BASE_URL: must be https:// outside local/test");
    if (cfg.STORAGE_PROVIDER === "local") problems.push("STORAGE_PROVIDER: 'local' is for development only");
  }
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}

let cached: AppConfig | undefined;

/** Fail-fast config loader (memoised). */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  if (env === process.env && cached) return cached;
  const cfg = parseConfig(env);
  if (env === process.env) cached = cfg;
  return cfg;
}

/** Test helper. */
export function resetConfigCache(): void {
  cached = undefined;
}
