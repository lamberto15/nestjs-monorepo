ALTER TABLE "test_referenced_items" ADD COLUMN "label" text;--> statement-breakpoint
CREATE UNIQUE INDEX "test_referenced_items_label_idx" ON "test_referenced_items" ("tenant_id","item_id","label");