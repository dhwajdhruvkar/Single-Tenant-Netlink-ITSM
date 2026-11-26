import { AppShell } from "@/ui/AppShell";
import { Card } from "@/ui/primitives";

/** Rendered (HTTP 200 page, no data) when a signed-in user opens a page their role does not allow. The server also enforces this in the API. */
export function Forbidden() {
  return (
    <AppShell>
      <Card>
        <h1 className="text-xl font-semibold">You do not have access to this page</h1>
        <p className="mt-2 text-sm text-gray-600">If you think this is a mistake, contact the IT service desk.</p>
      </Card>
    </AppShell>
  );
}
