DROP INDEX "report_schedules_next_run_at_idx";--> statement-breakpoint
CREATE INDEX "report_schedules_next_run_at_idx" ON "report_schedules" ("next_run_at","tenant_id") WHERE "active";