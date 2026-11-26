import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { safeRedirectPath } from "@/platform/http/safeRedirect";
import { Button, Card } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string; signedOut?: string }> }) {
  const params = await searchParams;
  const configured = Boolean(process.env.ENTRA_TENANT_ID && process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET);
  const target = safeRedirectPath(params.callbackUrl);

  if (configured) {
    const session = await auth();
    if (session?.claims) redirect(target);
  }

  return (
    <main className="mx-auto mt-24 max-w-sm p-4">
      <Card>
        <h1 className="text-xl font-semibold">Netlink ITSM</h1>
        {params.signedOut ? <p className="mt-2 text-sm text-gray-600">You have been signed out.</p> : null}
        {configured ? (
          <form
            className="mt-4"
            action={async () => {
              "use server";
              await signIn("microsoft-entra-id", { redirectTo: target });
            }}
          >
            <Button type="submit">Sign in with Microsoft</Button>
          </form>
        ) : (
          <p className="mt-4 text-sm text-red-700">Sign-in is not configured for this environment.</p>
        )}
      </Card>
    </main>
  );
}
