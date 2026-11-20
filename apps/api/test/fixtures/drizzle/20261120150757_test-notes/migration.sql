CREATE TABLE "test_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "test_notes_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "test_notes_owner_id_idx" ON "test_notes" ("owner_id");--> statement-breakpoint
CREATE INDEX "test_notes_item_id_idx" ON "test_notes" ("tenant_id","item_id","id" DESC);--> statement-breakpoint
ALTER TABLE "test_notes" ADD CONSTRAINT "test_notes_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "test_notes" ADD CONSTRAINT "test_notes_item_id_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "test_record_items"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "test_notes_tenant_select" ON "test_notes" AS PERMISSIVE FOR SELECT TO public USING (("test_notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_notes_tenant_insert" ON "test_notes" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_notes_tenant_update" ON "test_notes" AS PERMISSIVE FOR UPDATE TO public USING (("test_notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_notes_tenant_delete" ON "test_notes" AS PERMISSIVE FOR DELETE TO public USING (("test_notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));