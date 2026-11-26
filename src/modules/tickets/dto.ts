export interface TicketCreatedDTO {
  id: string;
  reference: string;
  number: string;
  type: "incident" | "service_request";
  status: string;
  subject: string;
  priority: string;
  priorityOverridden: boolean;
  impact: string;
  urgency: string;
  channel: string;
  category: { id: string; name: string } | null;
  requester: { id: string; displayName: string; mail: string | null; department: string | null; jobTitle: string | null; location: string | null };
  createdBy: { id: string; displayName: string };
  onBehalf: boolean;
  assignmentGroup: { id: string; name: string } | null;
  assignee: { id: string; displayName: string } | null;
  responseDueAt: string | null;
  resolveDueAt: string | null;
  createdAt: string;
}
