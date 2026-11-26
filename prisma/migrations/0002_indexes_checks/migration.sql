-- Raw-SQL objects Prisma cannot model: search indexes, partial indexes, CHECK constraints.
-- Portable: pg_trgm is optional (the company Postgres may not allow it, [EXTERNAL]); a prefix index is the fallback.

-- Employee search -------------------------------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable (%); using prefix index fallback', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE $idx$
      CREATE INDEX "employee_search_trgm" ON "Employee" USING gin (
        (lower("displayName" || ' ' || coalesce("mail", '') || ' ' || "userPrincipalName" || ' ' || coalesce("employeeNumber", ''))) gin_trgm_ops
      )
    $idx$;
  ELSE
    EXECUTE 'CREATE INDEX "employee_search_prefix" ON "Employee" (lower("displayName") text_pattern_ops)';
  END IF;
END
$$;

-- Ticket ----------------------------------------------------------------------------------------------------------
-- SLA sweeps only look at open, non-archived tickets.
CREATE INDEX "ticket_open_resolve_due" ON "Ticket" ("resolveDueAt")
  WHERE "status" IN ('new', 'assigned', 'in_progress') AND "archivedAt" IS NULL;

-- A hold reason is present exactly when the ticket is on hold.
ALTER TABLE "Ticket" ADD CONSTRAINT "ticket_hold_reason_check"
  CHECK (("status" = 'on_hold') = ("holdReason" IS NOT NULL));

ALTER TABLE "Ticket" ADD CONSTRAINT "ticket_priority_override_reason_check"
  CHECK (NOT "priorityOverridden" OR "priorityOverrideReason" IS NOT NULL);

ALTER TABLE "Ticket" ADD CONSTRAINT "ticket_sla_paused_minutes_check" CHECK ("slaPausedMinutes" >= 0);

-- SLA / calendars -------------------------------------------------------------------------------------------------
-- At most one active policy per priority and ticket type, and one active "all types" policy per priority.
-- (Doc C used coalesce("ticketType"::text, '*'), but the enum->text cast is not IMMUTABLE and cannot be indexed.)
CREATE UNIQUE INDEX "sla_active_unique_typed" ON "SlaPolicy" ("priority", "ticketType")
  WHERE "active" AND "ticketType" IS NOT NULL;
CREATE UNIQUE INDEX "sla_active_unique_all_types" ON "SlaPolicy" ("priority")
  WHERE "active" AND "ticketType" IS NULL;

ALTER TABLE "SlaPolicy" ADD CONSTRAINT "sla_policy_minutes_check" CHECK ("responseMinutes" > 0 AND "resolveMinutes" > 0);

ALTER TABLE "BusinessCalendar" ADD CONSTRAINT "business_calendar_hours_check"
  CHECK ("startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute");
ALTER TABLE "BusinessCalendar" ADD CONSTRAINT "business_calendar_workdays_check"
  CHECK (cardinality("workDays") > 0 AND "workDays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]);

-- Attachments / jobs ----------------------------------------------------------------------------------------------
ALTER TABLE "Attachment" ADD CONSTRAINT "attachment_size_check" CHECK ("sizeBytes" >= 0);
-- A linked attachment must belong to a ticket; a staged one must not.
ALTER TABLE "Attachment" ADD CONSTRAINT "attachment_link_state_check"
  CHECK (("status" = 'linked') = ("ticketId" IS NOT NULL) OR "status" = 'deleted');

ALTER TABLE "Job" ADD CONSTRAINT "job_attempts_check" CHECK ("attempts" >= 0 AND "maxAttempts" >= 1);
CREATE INDEX "job_locked_until_idx" ON "Job" ("lockedUntil") WHERE "status" = 'running';
