import type { TicketSummary } from "@/modules/tickets/queries";

const when = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "Not set");

/** Minimal read-only ticket view. The full detail page (timeline, conversation, actions) arrives in Phase 7. */
export function TicketSummaryView({ ticket, created }: { ticket: TicketSummary; created: boolean }) {
  return (
    <article>
      {created ? (
        <p role="status" className="mb-4 rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800">
          Ticket {ticket.reference} was created.
        </p>
      ) : null}
      <h1 className="text-2xl font-semibold text-gray-900">{ticket.reference}: {ticket.subject}</h1>
      <dl className="mt-4 grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
        <dt className="text-gray-500">Status</dt><dd>{ticket.status}</dd>
        <dt className="text-gray-500">Priority</dt><dd>{ticket.priority.toUpperCase()}</dd>
        <dt className="text-gray-500">Requester</dt><dd>{ticket.requesterName}</dd>
        <dt className="text-gray-500">Created by</dt><dd>{ticket.createdByName}</dd>
        <dt className="text-gray-500">Channel</dt><dd>{ticket.channel}</dd>
        <dt className="text-gray-500">Group</dt><dd>{ticket.assignmentGroup ?? "Not assigned"}</dd>
        <dt className="text-gray-500">Assignee</dt><dd>{ticket.assignee ?? "Not assigned"}</dd>
        <dt className="text-gray-500">First response due</dt><dd>{when(ticket.responseDueAt)}</dd>
        <dt className="text-gray-500">Resolution due</dt><dd>{when(ticket.resolveDueAt)}</dd>
      </dl>
      <h2 className="mt-6 text-sm font-semibold text-gray-700">Description</h2>
      <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">{ticket.description}</p>
    </article>
  );
}
