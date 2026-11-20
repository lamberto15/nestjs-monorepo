CREATE TABLE "test_stages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"code" text NOT NULL,
	"next_id" uuid,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "test_stages_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_stages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "test_stages_owner_id_idx" ON "test_stages" ("owner_id");--> statement-breakpoint
CREATE INDEX "test_stages_item_id_idx" ON "test_stages" ("tenant_id","item_id","id" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "test_stages_code_idx" ON "test_stages" ("tenant_id","item_id","code");--> statement-breakpoint
CREATE INDEX "test_stages_next_id_idx" ON "test_stages" ("tenant_id","next_id","id" DESC);--> statement-breakpoint
ALTER TABLE "test_stages" ADD CONSTRAINT "test_stages_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "test_stages" ADD CONSTRAINT "test_stages_item_id_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "test_record_items"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "test_stages" ADD CONSTRAINT "test_stages_next_id_fk" FOREIGN KEY ("tenant_id","next_id") REFERENCES "test_stages"("tenant_id","id");--> statement-breakpoint
CREATE POLICY "test_stages_tenant_select" ON "test_stages" AS PERMISSIVE FOR SELECT TO public USING (("test_stages"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_stages_tenant_insert" ON "test_stages" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_stages"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_stages_tenant_update" ON "test_stages" AS PERMISSIVE FOR UPDATE TO public USING (("test_stages"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_stages"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_stages_tenant_delete" ON "test_stages" AS PERMISSIVE FOR DELETE TO public USING (("test_stages"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));