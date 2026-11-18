CREATE INDEX "test_tenant_items_parent_idx" ON "test_tenant_items" ("parent_id");--> statement-breakpoint
CREATE INDEX "test_items_parent_idx" ON "test_items" ("parent_id");--> statement-breakpoint
CREATE INDEX "test_encrypted_notes_body_idx" ON "test_encrypted_notes" ("tenant_id","body_index");--> statement-breakpoint
CREATE INDEX "generated_items_unit_id_idx" ON "generated_items" ("tenant_id","unit_id","id" DESC);--> statement-breakpoint
CREATE INDEX "test_record_items_unit_id_idx" ON "test_record_items" ("tenant_id","unit_id","id" DESC);