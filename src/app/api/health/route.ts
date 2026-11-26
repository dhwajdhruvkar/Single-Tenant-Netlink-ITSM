import { ok, withApi } from "@/platform/http/handler";

export const dynamic = "force-dynamic";

// Liveness: the process is up. Does not touch the database.
export const GET = withApi(() => ok({ status: "ok" }));
