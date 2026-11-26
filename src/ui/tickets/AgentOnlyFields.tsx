"use client";

import type { AgentFields } from "./payload";
import { Field } from "./TicketFormFields";

export interface GroupChoice {
  id: string;
  name: string;
  members: { id: string; displayName: string }[];
}

const input = "mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";

/** Fields only agents may set. The assignee list is filtered to the selected group's members. Shown only to agent+ (the server re-checks). */
export function AgentOnlyFields({
  value, onChange, groups, errors, canOverride,
}: {
  value: AgentFields;
  onChange: (patch: Partial<AgentFields>) => void;
  groups: GroupChoice[];
  errors: Record<string, string>;
  canOverride: boolean;
}) {
  const members = groups.find((g) => g.id === value.assignmentGroupId)?.members ?? [];
  return (
    <fieldset className="mb-4 rounded-md border border-gray-200 p-3">
      <legend className="px-1 text-sm font-semibold text-gray-700">Service desk fields</legend>

      <Field id="channel" label="How did the request arrive?">
        <select id="channel" className={input} value={value.channel} onChange={(e) => onChange({ channel: e.target.value as AgentFields["channel"] })}>
          <option value="phone">Phone</option>
          <option value="walk_in">Walk-in</option>
          <option value="email">Email</option>
          <option value="teams">Teams</option>
          <option value="chat">Chat</option>
        </select>
      </Field>

      {canOverride ? (
        <>
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={value.overrideEnabled} onChange={(e) => onChange({ overrideEnabled: e.target.checked })} />
            Override the calculated priority
          </label>
          {value.overrideEnabled ? (
            <>
              <Field id="overridePriority" label="Priority">
                <select id="overridePriority" className={input} value={value.overridePriority} onChange={(e) => onChange({ overridePriority: e.target.value as AgentFields["overridePriority"] })}>
                  {["p1", "p2", "p3", "p4"].map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
                </select>
              </Field>
              <Field id="overrideReason" label="Reason for the override" error={errors["priorityOverride.reason"]}>
                <input id="overrideReason" className={input} value={value.overrideReason} maxLength={500} onChange={(e) => onChange({ overrideReason: e.target.value })} />
              </Field>
            </>
          ) : null}

          <Field id="assignmentGroupId" label="Assignment group (optional)" hint="Leave empty to route by category.">
            <select id="assignmentGroupId" className={input} value={value.assignmentGroupId} onChange={(e) => onChange({ assignmentGroupId: e.target.value, assigneeEmployeeId: "" })}>
              <option value="">Route automatically</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          <Field id="assigneeEmployeeId" label="Assignee (optional)" error={errors.assigneeEmployeeId}>
            <select id="assigneeEmployeeId" className={input} value={value.assigneeEmployeeId} disabled={!value.assignmentGroupId} onChange={(e) => onChange({ assigneeEmployeeId: e.target.value })}>
              <option value="">{value.assignmentGroupId ? "Unassigned" : "Pick a group first"}</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
          </Field>
        </>
      ) : null}
    </fieldset>
  );
}
