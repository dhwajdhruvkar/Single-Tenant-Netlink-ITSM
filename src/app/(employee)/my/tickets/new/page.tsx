import { redirect } from "next/navigation";
import { getOwnProfile } from "@/modules/directory/profileService";
import { listCategoriesFor } from "@/modules/tickets/queries";
import { prisma } from "@/platform/db/prisma";
import { getDirectoryProvider, getEligibilityConfig } from "@/platform/directory";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { PageHeader } from "@/ui/primitives";
import { NewTicketForm } from "@/ui/tickets/NewTicketForm";

export const dynamic = "force-dynamic";

// Form B. The profile is loaded here, on the server, straight from the directory data for the signed-in person.
export default async function NewTicketPage() {
  const actor = await getPageActor();
  if (!actor) redirect("/signin?callbackUrl=/my/tickets/new");

  const profile = await getOwnProfile({ db: prisma, provider: getDirectoryProvider(), eligibility: getEligibilityConfig() }, actor.employeeId);
  if (!profile) redirect("/signin");
  // Categories for both types; the form narrows them by the chosen type.
  const [incident, request] = await Promise.all([listCategoriesFor(prisma, "incident"), listCategoriesFor(prisma, "service_request")]);
  const categories = [...new Map([...incident, ...request].map((c) => [c.id, c])).values()];

  return (
    <AppShell>
      <PageHeader title="New ticket" description="Tell us what is wrong or what you need. We already know who you are." />
      <div className="max-w-2xl">
        <NewTicketForm profile={profile} categories={categories} />
      </div>
    </AppShell>
  );
}
