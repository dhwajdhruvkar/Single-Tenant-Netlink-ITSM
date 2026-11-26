import Link from "next/link";
import { Card } from "@/ui/primitives";

export const dynamic = "force-dynamic";

// Reasons are intentionally generic: the page must not reveal whether a given person exists or why exactly they were refused.
const MESSAGES: Record<string, string> = {
  tenant_mismatch: "Only Netlink accounts can use this application.",
  account_disabled: "Your access to this application has been disabled. Contact the IT service desk.",
  directory_disabled: "Your account is disabled. Contact the IT service desk.",
  directory_removed: "Your account was not found in the company directory. Contact the IT service desk.",
  not_eligible: "This account type cannot use the application. Contact the IT service desk.",
};
const FALLBACK = "We could not sign you in. Try again, or contact the IT service desk if the problem continues.";

export default async function AccessDeniedPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  const message = (reason && MESSAGES[reason]) || FALLBACK;
  return (
    <main className="mx-auto mt-24 max-w-sm p-4">
      <Card>
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="mt-2 text-sm text-gray-700">{message}</p>
        <Link href="/signin" className="mt-4 inline-block text-sm text-blue-700 underline">
          Back to sign in
        </Link>
      </Card>
    </main>
  );
}
