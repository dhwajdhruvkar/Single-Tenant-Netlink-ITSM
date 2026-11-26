import { reportSummary } from "@/modules/reporting/queries";
import { parseRange } from "@/modules/reporting/range";
import type { Actor } from "@/modules/identity/actor";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { ValidationError } from "@/platform/errors";

/** Shared by the two report pages: parse the query, load the summary and the groups the person may filter by. */
export async function loadReportPage(actor: Actor, sp: Record<string, string | undefined>) {
  const policy = { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS };
  let range: { from: Date; to: Date };
  try { range = parseRange({ from: sp.from, to: sp.to }); } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    return { error: e.message } as const;
  }
  const groupId = sp.groupId && /^[0-9a-f-]{36}$/i.test(sp.groupId) ? sp.groupId : undefined;
  const all = actor.role === "manager" || actor.role === "admin";
  const groups = await prisma.assignmentGroup.findMany({ where: { active: true, ...(all ? {} : { id: { in: [...actor.groupIds] } }) }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  let summary;
  try { summary = await reportSummary(prisma, actor, { ...range, groupId }, { policy }); } catch (e) {
    if (e instanceof ValidationError) return { error: e.message } as const;
    throw e;
  }
  const toInclusive = new Date(range.to.getTime() - 86_400_000).toISOString().slice(0, 10);
  return { summary, groups, from: range.from.toISOString().slice(0, 10), to: toInclusive } as const;
}
