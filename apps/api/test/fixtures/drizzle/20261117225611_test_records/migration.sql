CREATE TABLE "test_record_marks" (
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"mark" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_record_marks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_record_seen" (
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"seen_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_record_seen" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_record_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" text NOT NULL,
	"unit_id" uuid,
	"title" text NOT NULL,
	"body" text,
	"published_at" timestamp(3) with time zone,
	"code" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"words" integer,
	"parent_id" uuid,
	"linked_id" uuid,
	"last_mark" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp(3) with time zone,
	"deleted_by" text,
	"search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("title"::text, '') || ' ' || coalesce("body"::text, ''))) STORED,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "test_record_items_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_record_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "test_record_marks_idx" ON "test_record_marks" ("tenant_id","subject","record_id","mark");--> statement-breakpoint
CREATE UNIQUE INDEX "test_record_seen_idx" ON "test_record_seen" ("tenant_id","subject","record_id");--> statement-breakpoint
CREATE INDEX "test_record_items_owner_id_idx" ON "test_record_items" ("owner_id");--> statement-breakpoint
CREATE INDEX "test_record_items_deleted_at_idx" ON "test_record_items" ("deleted_at");--> statement-breakpoint
CREATE INDEX "test_record_items_search_idx" ON "test_record_items" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "test_record_items_code_idx" ON "test_record_items" ("tenant_id","code") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "test_record_items_parent_id_idx" ON "test_record_items" ("tenant_id","parent_id","id" DESC);--> statement-breakpoint
CREATE INDEX "test_record_items_linked_id_idx" ON "test_record_items" ("tenant_id","linked_id","id" DESC);--> statement-breakpoint
ALTER TABLE "test_record_marks" ADD CONSTRAINT "test_record_marks_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "test_record_seen" ADD CONSTRAINT "test_record_seen_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "test_record_items" ADD CONSTRAINT "test_record_items_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "test_record_items" ADD CONSTRAINT "test_record_items_parent_id_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "test_record_items"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "test_record_items" ADD CONSTRAINT "test_record_items_linked_id_fk" FOREIGN KEY ("tenant_id","linked_id") REFERENCES "test_record_items"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "test_record_items" ADD CONSTRAINT "test_record_items_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "organizational_units"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "test_record_marks_tenant_select" ON "test_record_marks" AS PERMISSIVE FOR SELECT TO public USING (("test_record_marks"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_record_marks_tenant_insert" ON "test_record_marks" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_record_marks"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_record_marks_tenant_update" ON "test_record_marks" AS PERMISSIVE FOR UPDATE TO public USING (("test_record_marks"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_record_marks"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_record_marks_tenant_delete" ON "test_record_marks" AS PERMISSIVE FOR DELETE TO public USING (("test_record_marks"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_record_seen_tenant_select" ON "test_record_seen" AS PERMISSIVE FOR SELECT TO public USING (("test_record_seen"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_record_seen_tenant_insert" ON "test_record_seen" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_record_seen"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_record_seen_tenant_update" ON "test_record_seen" AS PERMISSIVE FOR UPDATE TO public USING (("test_record_seen"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_record_seen"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_record_seen_tenant_delete" ON "test_record_seen" AS PERMISSIVE FOR DELETE TO public USING (("test_record_seen"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_record_items_tenant_select" ON "test_record_items" AS PERMISSIVE FOR SELECT TO public USING (("test_record_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_record_items_tenant_insert" ON "test_record_items" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_record_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_record_items_tenant_update" ON "test_record_items" AS PERMISSIVE FOR UPDATE TO public USING (("test_record_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_record_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_record_items_tenant_delete" ON "test_record_items" AS PERMISSIVE FOR DELETE TO public USING (("test_record_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));