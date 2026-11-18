CREATE INDEX "attachment_versions_size_idx" ON "attachment_versions" ("tenant_id","size");--> statement-breakpoint
CREATE INDEX "attachments_size_idx" ON "attachments" ("tenant_id","size");