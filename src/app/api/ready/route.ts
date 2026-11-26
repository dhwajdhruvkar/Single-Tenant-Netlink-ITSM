import { NextResponse } from "next/server";
import { prisma } from "@/platform/db/prisma";
import { logger } from "@/platform/logging/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Readiness: the database answers `SELECT 1`. 503 otherwise.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ data: { status: "ready" } });
  } catch (err) {
    logger.error("readiness check failed", { error: err });
    return NextResponse.json({ error: { code: "not_ready", message: "Database unavailable." } }, { status: 503 });
  }
}
