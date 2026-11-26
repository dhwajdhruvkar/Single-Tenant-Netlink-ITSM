import { z } from "zod";
import { MIN_QUERY_LENGTH, searchEmployees } from "@/modules/directory/searchService";
import { prisma } from "@/platform/db/prisma";
import { getDirectoryProvider, getEligibilityConfig } from "@/platform/directory";
import { ValidationError } from "@/platform/errors";
import { ok, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";
import { dbRateLimiter, enforceRateLimit } from "@/platform/rateLimit/dbRateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Query = z.object({
  q: z.string().trim().min(MIN_QUERY_LENGTH, `q must be at least ${MIN_QUERY_LENGTH} characters`).max(64),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

// GET /api/directory/employees?q=&limit=  (permission directory.search: submitter and above)
export const GET = withApi(async (req) => {
  const actor = await requireActor("directory.search");
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid query", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

  await enforceRateLimit(dbRateLimiter(prisma), { key: `directory.search:${actor.employeeId}`, limit: 30, windowSeconds: 60 });

  const results = await searchEmployees(
    { db: prisma, provider: getDirectoryProvider(), eligibility: getEligibilityConfig() },
    parsed.data.q,
    parsed.data.limit,
  );
  return ok(results);
});
