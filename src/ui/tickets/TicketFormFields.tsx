"use client";

import type { ReactNode } from "react";
import type { AffectedPeople, TicketFormValues, WorkImpact } from "./payload";

export interface CategoryChoice {
  id: string;
  name: string;
  ticketTypes: string[];
}

const input = "mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";

export function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="block text-sm font-medium text-gray-800">{label}</label>
      {hint ? <p id={`${id}-hint`} className="text-xs text-gray-500">{hint}</p> : null}
      {children}
      {error ? <p id={`${id}-error`} className="mt-1 text-xs text-red-700">{error}</p> : null}
    </div>
  );
}

export function TicketFormFields({
  values, onChange, errors, categories,
}: {
  values: TicketFormValues;
  onChange: (patch: Partial<TicketFormValues>) => void;
  errors: Record<string, string>;
  categories: CategoryChoice[];
}) {
  const visibleCategories = categories.filter((c) => c.ticketTypes.length === 0 || c.ticketTypes.includes(values.type));
  const describedBy = (id: string, hasHint = false) => [hasHint ? `${id}-hint` : "", errors[id] ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;

  return (
    <>
      <fieldset className="mb-4">
        <legend className="text-sm font-medium text-gray-800">What do you need?</legend>
        <div className="mt-1 flex gap-4 text-sm">
          {([["incident", "Something is broken"], ["service_request", "I need something"]] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1">
              <input type="radio" name="type" value={value} checked={values.type === value} onChange={() => onChange({ type: value, categoryId: "" })} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <Field id="categoryId" label="Category" error={errors.categoryId}>
        <select id="categoryId" className={input} value={values.categoryId} onChange={(e) => onChange({ categoryId: e.target.value })} aria-describedby={describedBy("categoryId")}>
          <option value="">Not sure / other</option>
          {visibleCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>

      <Field id="subject" label="Subject" error={errors.subject} hint="A short summary (3-200 characters).">
        <input id="subject" className={input} value={values.subject} maxLength={200} onChange={(e) => onChange({ subject: e.target.value })} aria-invalid={Boolean(errors.subject)} aria-describedby={describedBy("subject", true)} />
      </Field>

      <Field id="description" label="Description" error={errors.description} hint="What happened, and what did you expect?">
        <textarea id="description" className={`${input} min-h-32`} value={values.description} maxLength={20000} onChange={(e) => onChange({ description: e.target.value })} aria-invalid={Boolean(errors.description)} aria-describedby={describedBy("description", true)} />
      </Field>

      {values.type === "incident" ? (
        <>
          <Field id="affectedPeople" label="How many people are affected?">
            <select id="affectedPeople" className={input} value={values.affectedPeople} onChange={(e) => onChange({ affectedPeople: e.target.value as AffectedPeople })}>
              <option value="one">Just me</option>
              <option value="team">My team or department</option>
              <option value="many">Many people or the whole company</option>
            </select>
          </Field>
          <Field id="workImpact" label="Can you still work?">
            <select id="workImpact" className={input} value={values.workImpact} onChange={(e) => onChange({ workImpact: e.target.value as WorkImpact })}>
              <option value="normal">Yes, normally</option>
              <option value="slowed">Yes, but it slows me down</option>
              <option value="stopped">No, I am blocked</option>
            </select>
          </Field>
          <Field id="affectedService" label="Affected service or system (optional)" error={errors["typeDetails.affectedService"]}>
            <input id="affectedService" className={input} value={values.affectedService} maxLength={200} onChange={(e) => onChange({ affectedService: e.target.value })} />
          </Field>
        </>
      ) : (
        <Field id="requestedItem" label="What are you requesting? (optional)">
          <input id="requestedItem" className={input} value={values.requestedItem} maxLength={200} onChange={(e) => onChange({ requestedItem: e.target.value })} />
        </Field>
      )}

      <Field id="contactPhone" label="Best phone number (optional)" error={errors.contactPhone}>
        <input id="contactPhone" type="tel" className={input} value={values.contactPhone} maxLength={40} onChange={(e) => onChange({ contactPhone: e.target.value })} />
      </Field>
      <Field id="locationNote" label="Where are you? (optional)" error={errors.locationNote} hint="For example a floor, desk or meeting room.">
        <input id="locationNote" className={input} value={values.locationNote} maxLength={160} onChange={(e) => onChange({ locationNote: e.target.value })} aria-describedby={describedBy("locationNote", true)} />
      </Field>
    </>
  );
}
