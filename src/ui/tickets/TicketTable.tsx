import Link from "next/link";
import type { TicketRowDTO } from "@/modules/tickets/list";
import { SlaBadge } from "./SlaBadge";

const label = (s: string) => s.replace(/_/g, " ");

export function TicketTable({ rows, basePath, showQueue }: { rows: TicketRowDTO[]; basePath: string; showQueue: boolean }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-gray-600">No tickets match.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Tickets</caption>
        <thead className="border-b border-gray-200 text-xs uppercase text-gray-500">
          <tr>
            <th scope="col" className="px-2 py-2">Ticket</th>
            <th scope="col" className="px-2 py-2">Subject</th>
            <th scope="col" className="px-2 py-2">Status</th>
            <th scope="col" className="px-2 py-2">Priority</th>
            {showQueue ? <th scope="col" className="px-2 py-2">Requester</th> : null}
            {showQueue ? <th scope="col" className="px-2 py-2">Group / assignee</th> : null}
            <th scope="col" className="px-2 py-2">SLA</th>
            <th scope="col" className="px-2 py-2">Opened</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-2 py-2 font-medium"><Link className="text-blue-700 underline" href={`${basePath}/${r.reference}`}>{r.reference}</Link></td>
              <td className="px-2 py-2">{r.subject}</td>
              <td className="px-2 py-2">{label(r.status)}</td>
              <td className="px-2 py-2">{r.priority.toUpperCase()}</td>
              {showQueue ? <td className="px-2 py-2">{r.requesterName}</td> : null}
              {showQueue ? <td className="px-2 py-2">{r.assignmentGroup ?? "-"} / {r.assignee ?? "unassigned"}</td> : null}
              <td className="px-2 py-2"><SlaBadge level={r.sla} /></td>
              <td className="px-2 py-2 text-gray-500">{r.createdAt.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, totalPages, hrefFor }: { page: number; totalPages: number; hrefFor: (page: number) => string }) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="mt-3 flex items-center gap-3 text-sm">
      {page > 1 ? <Link className="text-blue-700 underline" href={hrefFor(page - 1)}>Previous</Link> : <span className="text-gray-400">Previous</span>}
      <span>Page {page} of {totalPages}</span>
      {page < totalPages ? <Link className="text-blue-700 underline" href={hrefFor(page + 1)}>Next</Link> : <span className="text-gray-400">Next</span>}
    </nav>
  );
}
