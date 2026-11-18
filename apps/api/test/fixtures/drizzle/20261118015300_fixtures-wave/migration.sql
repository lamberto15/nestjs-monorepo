CREATE TABLE "test_encrypted_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"body" text NOT NULL,
	"body_index" text NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_encrypted_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "generated_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" text NOT NULL,
	"unit_id" uuid,
	"title" text NOT NULL,
	"body" text,
	"status" text NOT NULL,
	"amount_minor" bigint,
	"amount_currency" char(3),
	"due_on" date,
	"code" text NOT NULL,
	"number" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp(3) with time zone,
	"deleted_by" text,
	"search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("title"::text, '') || ' ' || coalesce("body"::text, '') || ' ' || coalesce("code"::text, ''))) STORED,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "generated_items_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "generated_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_numbered_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"region" text,
	"code" text,
	"number" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "test_numbered_items_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_numbered_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "generated_items_owner_id_idx" ON "generated_items" ("owner_id");--> statement-breakpoint
CREATE INDEX "generated_items_deleted_at_idx" ON "generated_items" ("deleted_at");--> statement-breakpoint
CREATE INDEX "generated_items_search_idx" ON "generated_items" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "generated_items_code_idx" ON "generated_items" ("tenant_id","code") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "test_numbered_items_owner_id_idx" ON "test_numbered_items" ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_numbered_items_code_idx" ON "test_numbered_items" ("tenant_id","code");--> statement-breakpoint
ALTER TABLE "test_encrypted_notes" ADD CONSTRAINT "test_encrypted_notes_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "generated_items" ADD CONSTRAINT "generated_items_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "generated_items" ADD CONSTRAINT "generated_items_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "organizational_units"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "test_numbered_items" ADD CONSTRAINT "test_numbered_items_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "test_encrypted_notes_tenant_select" ON "test_encrypted_notes" AS PERMISSIVE FOR SELECT TO public USING (("test_encrypted_notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_encrypted_notes_tenant_insert" ON "test_encrypted_notes" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_encrypted_notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_encrypted_notes_tenant_update" ON "test_encrypted_notes" AS PERMISSIVE FOR UPDATE TO public USING (("test_encrypted_notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_encrypted_notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_encrypted_notes_tenant_delete" ON "test_encrypted_notes" AS PERMISSIVE FOR DELETE TO public USING (("test_encrypted_notes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "generated_items_tenant_select" ON "generated_items" AS PERMISSIVE FOR SELECT TO public USING (("generated_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "generated_items_tenant_insert" ON "generated_items" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("generated_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "generated_items_tenant_update" ON "generated_items" AS PERMISSIVE FOR UPDATE TO public USING (("generated_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("generated_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "generated_items_tenant_delete" ON "generated_items" AS PERMISSIVE FOR DELETE TO public USING (("generated_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_numbered_items_tenant_select" ON "test_numbered_items" AS PERMISSIVE FOR SELECT TO public USING (("test_numbered_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_numbered_items_tenant_insert" ON "test_numbered_items" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_numbered_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_numbered_items_tenant_update" ON "test_numbered_items" AS PERMISSIVE FOR UPDATE TO public USING (("test_numbered_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_numbered_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_numbered_items_tenant_delete" ON "test_numbered_items" AS PERMISSIVE FOR DELETE TO public USING (("test_numbered_items"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));