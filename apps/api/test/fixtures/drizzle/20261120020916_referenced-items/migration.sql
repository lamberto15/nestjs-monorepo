CREATE TABLE "test_referenced_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" text NOT NULL,
	"reference" text,
	"region" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "test_referenced_items_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_referenced_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "test_referenced_items_owner_id_idx" ON "test_referenced_items" ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_referenced_items_reference_idx" ON "test_referenced_items" ("tenant_id","reference");--> statement-breakpoint
ALTER TABLE "test_referenced_items" ADD CONSTRAINT "test_referenced_items_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "test_referenced_items_tenant_select" ON "test_referenced_items" AS PERMISSIVE FOR SELECT TO public USING (("test_referenced_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_referenced_items_tenant_insert" ON "test_referenced_items" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_referenced_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_referenced_items_tenant_update" ON "test_referenced_items" AS PERMISSIVE FOR UPDATE TO public USING (("test_referenced_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_referenced_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_referenced_items_tenant_delete" ON "test_referenced_items" AS PERMISSIVE FOR DELETE TO public USING (("test_referenced_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));