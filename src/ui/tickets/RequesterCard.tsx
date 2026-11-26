// Read-only requester details. It renders text only: there is deliberately no input, select or hidden field here, so the
// requester can never be edited or submitted from the browser.

export interface RequesterProfile {
  displayName: string;
  mail: string | null;
  department: string | null;
  jobTitle: string | null;
  officeLocation: string | null;
}

const MISSING = "Not provided in directory";

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-2 py-0.5 text-sm">
      <dt className="w-24 shrink-0 text-gray-500">{label}</dt>
      <dd className={value ? "text-gray-900" : "italic text-gray-400"}>{value ?? MISSING}</dd>
    </div>
  );
}

export function RequesterCard({ profile, title = "Requester" }: { profile: RequesterProfile; title?: string }) {
  return (
    <section aria-label={title} className="rounded-md border border-gray-200 bg-gray-50 p-3" data-testid="requester-card">
      <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
      <p className="mt-1 text-base font-medium text-gray-900">{profile.displayName}</p>
      <dl className="mt-1">
        <Row label="Email" value={profile.mail} />
        <Row label="Department" value={profile.department} />
        <Row label="Job title" value={profile.jobTitle} />
        <Row label="Office" value={profile.officeLocation} />
      </dl>
    </section>
  );
}
