import type { TicketDetailDTO } from "@/modules/tickets/detail";
import { SlaBadge } from "./SlaBadge";

const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "Not set");
const label = (s: string) => s.replace(/_/g, " ");

function eventText(e: TicketDetailDTO["events"][number]): string {
  switch (e.type) {
    case "created": return "Ticket created";
    case "status_changed": return `Status: ${label(e.from ?? "")} → ${label(e.to ?? "")}`;
    case "reopened": return "Ticket reopened";
    case "assigned": return e.to ? "Assigned" : "Unassigned";
    case "group_changed": return "Group changed";
    case "priority_changed": return `Priority: ${(e.from ?? "").toUpperCase()} → ${(e.to ?? "").toUpperCase()}`;
    case "category_changed": return "Category changed";
    case "type_changed": return `Type: ${label(e.from ?? "")} → ${label(e.to ?? "")}`;
    case "message_added": return "Reply added";
    case "internal_note_added": return "Internal note added";
    case "archived": return "Archived";
    default: return label(e.type);
  }
}

/** Read-only presentation of a ticket for one viewer. It renders only what the server put in the DTO, which already excludes anything the viewer may not see. */
export function TicketDetailView({ ticket, created }: { ticket: TicketDetailDTO; created: boolean }) {
  return (
    <article>
      {created ? <p role="status" className="mb-4 rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800">Ticket {ticket.reference} was created.</p> : null}
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">{ticket.reference}: {ticket.subject}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-600">
          <span className="rounded bg-gray-100 px-2 py-0.5 font-medium">{label(ticket.status)}{ticket.holdReason ? ` (${label(ticket.holdReason)})` : ""}</span>
          <span>{ticket.priority.toUpperCase()}{ticket.priorityOverridden ? " (overridden)" : ""}</span>
          <SlaBadge level={ticket.sla.level} />
        </p>
      </header>

      <dl className="mt-4 grid grid-cols-[11rem_1fr] gap-y-1 text-sm">
        <dt className="text-gray-500">Requester</dt><dd>{ticket.requester.name}{ticket.requester.department ? `, ${ticket.requester.department}` : ""}</dd>
        <dt className="text-gray-500">Created by</dt><dd>{ticket.createdBy.name}</dd>
        <dt className="text-gray-500">Type · channel</dt><dd>{label(ticket.type)} · {label(ticket.channel)}</dd>
        <dt className="text-gray-500">Category</dt><dd>{ticket.category?.name ?? "None"}</dd>
        <dt className="text-gray-500">Group</dt><dd>{ticket.assignmentGroup?.name ?? "Not assigned"}</dd>
        <dt className="text-gray-500">Assignee</dt><dd>{ticket.assignee?.name ?? "Not assigned"}</dd>
        <dt className="text-gray-500">First response due</dt><dd>{when(ticket.responseDueAt)}</dd>
        <dt className="text-gray-500">Resolution due</dt><dd>{when(ticket.resolveDueAt)}</dd>
        <dt className="text-gray-500">Opened</dt><dd>{when(ticket.createdAt)}</dd>
      </dl>

      <h2 className="mt-6 text-sm font-semibold text-gray-700">Description</h2>
      <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">{ticket.description}</p>

      {ticket.resolutionNotes ? (
        <>
          <h2 className="mt-6 text-sm font-semibold text-gray-700">Resolution</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">{ticket.resolutionNotes}</p>
        </>
      ) : null}

      {ticket.attachments.length > 0 ? (
        <>
          <h2 className="mt-6 text-sm font-semibold text-gray-700">Attachments</h2>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {ticket.attachments.map((a) => (
              <li key={a.id}><a className="text-blue-700 underline" href={`/api/attachments/${a.id}`} download>{a.fileName}</a> <span className="text-gray-500">({Math.max(1, Math.round(a.sizeBytes / 1024))} KB)</span></li>
            ))}
          </ul>
        </>
      ) : null}

      <h2 className="mt-6 text-sm font-semibold text-gray-700">Conversation</h2>
      {ticket.messages.length === 0 ? <p className="mt-1 text-sm text-gray-500">No messages yet.</p> : (
        <ol className="mt-2 space-y-3">
          {ticket.messages.map((m) => (
            <li key={m.id} className={`rounded-md border p-3 text-sm ${m.visibility === "internal" ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white"}`}>
              <p className="text-xs text-gray-500">
                <strong className="text-gray-800">{m.authorName ?? "System"}</strong> · {when(m.createdAt)}
                {m.visibility === "internal" ? <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 font-medium text-amber-900">Internal note</span> : null}
              </p>
              {m.removed ? <p className="mt-1 italic text-gray-500">This message was removed.</p> : <p className="mt-1 whitespace-pre-wrap">{m.body}</p>}
              {m.attachments.length > 0 ? (
                <ul className="mt-1 list-disc pl-5">{m.attachments.map((a) => <li key={a.id}><a className="text-blue-700 underline" href={`/api/attachments/${a.id}`} download>{a.fileName}</a></li>)}</ul>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      <h2 className="mt-6 text-sm font-semibold text-gray-700">History</h2>
      <ol className="mt-1 space-y-0.5 text-xs text-gray-600">
        {ticket.events.map((e) => (
          <li key={e.id}>{when(e.at)} · {e.actorName ?? "System"} · {eventText(e)}{e.note ? ` (${e.note})` : ""}</li>
        ))}
      </ol>
    </article>
  );
}
