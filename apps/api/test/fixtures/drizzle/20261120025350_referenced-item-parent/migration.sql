ALTER TABLE "test_referenced_items" ADD COLUMN "item_id" uuid;--> statement-breakpoint
CREATE INDEX "test_referenced_items_item_id_idx" ON "test_referenced_items" ("tenant_id","item_id","id" DESC);--> statement-breakpoint
ALTER TABLE "test_referenced_items" ADD CONSTRAINT "test_referenced_items_item_id_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "test_record_items"("tenant_id","id");