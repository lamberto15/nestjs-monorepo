ALTER TABLE "audit_log" ADD COLUMN "run_id" uuid;--> statement-breakpoint
CREATE INDEX "audit_log_tenant_run_id_idx" ON "audit_log" ("tenant_id","run_id","id");