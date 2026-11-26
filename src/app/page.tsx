import { AppShell } from "@/ui/AppShell";
import { Card, PageHeader } from "@/ui/primitives";

export default function HomePage() {
  return (
    <AppShell>
      <PageHeader title="Netlink ITSM" description="Foundation placeholder. Application features arrive in later phases." />
      <Card>
        <p className="text-sm text-gray-600">Sign-in and ticketing are not available yet.</p>
      </Card>
    </AppShell>
  );
}
