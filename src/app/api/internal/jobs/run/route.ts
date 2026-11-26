import { loadConfig } from "@/platform/config/env";
import { ok, withApi } from "@/platform/http/handler";
import { assertCronAuthorized } from "@/platform/http/cronAuth";
import { runJobsOnce, runnerId } from "@/platform/jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Called by Vercel Cron (GET) or any scheduler (POST) with `Authorization: Bearer $CRON_SECRET`. Enqueues due schedule slots and runs up to
// 50 jobs within 50 s. Not cookie-authenticated, so the CSRF origin check is off; the secret is the only credential.
async function run(req: Request) {
  assertCronAuthorized(req, loadConfig().CRON_SECRET);
  return ok(await runJobsOnce({ owner: runnerId("cron"), maxJobs: 50, budgetMs: 50_000 }));
}

export const GET = withApi(run, { csrf: false });
export const POST = withApi(run, { csrf: false });
