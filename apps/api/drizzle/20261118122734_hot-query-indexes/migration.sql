CREATE INDEX "approval_requests_unapplied_idx" ON "approval_requests" ("ended_at") WHERE status = 'approved' and outcome_applied_at is null;--> statement-breakpoint
CREATE INDEX "attachments_key_idx" ON "attachments" ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "data_quality_findings_open_idx" ON "data_quality_findings" ("tenant_id","subject","id" DESC) WHERE ("dismissed_at" is null);--> statement-breakpoint
CREATE INDEX "favorites_target_idx" ON "favorites" ("tenant_id","kind","subject","target");--> statement-breakpoint
CREATE INDEX "notifications_read_at_idx" ON "notifications" ("read_at") WHERE ("read_at" is not null);--> statement-breakpoint
CREATE INDEX "recent_records_record_idx" ON "recent_records" ("tenant_id","subject","record_id");