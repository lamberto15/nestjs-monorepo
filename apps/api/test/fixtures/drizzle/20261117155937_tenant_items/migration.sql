CREATE TABLE "test_tenant_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "test_tenant_items_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_tenant_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "test_tenant_items_name_idx" ON "test_tenant_items" ("tenant_id","name");--> statement-breakpoint
ALTER TABLE "test_tenant_items" ADD CONSTRAINT "test_tenant_items_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "test_tenant_items" ADD CONSTRAINT "test_tenant_items_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "test_tenant_items"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "test_tenant_items_tenant_select" ON "test_tenant_items" AS PERMISSIVE FOR SELECT TO public USING (("test_tenant_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_tenant_items_tenant_insert" ON "test_tenant_items" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_tenant_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_tenant_items_tenant_update" ON "test_tenant_items" AS PERMISSIVE FOR UPDATE TO public USING (("test_tenant_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_tenant_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_tenant_items_tenant_delete" ON "test_tenant_items" AS PERMISSIVE FOR DELETE TO public USING (("test_tenant_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));