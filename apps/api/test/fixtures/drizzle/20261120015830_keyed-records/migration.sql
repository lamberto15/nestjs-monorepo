CREATE TABLE "test_keyed_books" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" text NOT NULL,
	"shelf_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp(3) with time zone,
	"deleted_by" text,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "test_keyed_books_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_keyed_books" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_keyed_loans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" text NOT NULL,
	"reference" text,
	"book_id" uuid NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "test_keyed_loans_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_keyed_loans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_keyed_shelves" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp(3) with time zone,
	"deleted_by" text,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "test_keyed_shelves_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "test_keyed_shelves" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "test_keyed_books_owner_id_idx" ON "test_keyed_books" ("owner_id");--> statement-breakpoint
CREATE INDEX "test_keyed_books_deleted_at_idx" ON "test_keyed_books" ("deleted_at");--> statement-breakpoint
CREATE INDEX "test_keyed_books_shelf_id_idx" ON "test_keyed_books" ("tenant_id","shelf_id","id" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "test_keyed_books_key_idx" ON "test_keyed_books" ("tenant_id","shelf_id","code") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "test_keyed_loans_owner_id_idx" ON "test_keyed_loans" ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_keyed_loans_reference_idx" ON "test_keyed_loans" ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "test_keyed_loans_book_id_idx" ON "test_keyed_loans" ("tenant_id","book_id","id" DESC);--> statement-breakpoint
CREATE INDEX "test_keyed_shelves_owner_id_idx" ON "test_keyed_shelves" ("owner_id");--> statement-breakpoint
CREATE INDEX "test_keyed_shelves_deleted_at_idx" ON "test_keyed_shelves" ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "test_keyed_shelves_code_idx" ON "test_keyed_shelves" ("tenant_id","code") WHERE deleted_at is null;--> statement-breakpoint
ALTER TABLE "test_keyed_books" ADD CONSTRAINT "test_keyed_books_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "test_keyed_books" ADD CONSTRAINT "test_keyed_books_shelf_id_fk" FOREIGN KEY ("tenant_id","shelf_id") REFERENCES "test_keyed_shelves"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "test_keyed_loans" ADD CONSTRAINT "test_keyed_loans_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "test_keyed_loans" ADD CONSTRAINT "test_keyed_loans_book_id_fk" FOREIGN KEY ("tenant_id","book_id") REFERENCES "test_keyed_books"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "test_keyed_shelves" ADD CONSTRAINT "test_keyed_shelves_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "test_keyed_books_tenant_select" ON "test_keyed_books" AS PERMISSIVE FOR SELECT TO public USING (("test_keyed_books"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_keyed_books_tenant_insert" ON "test_keyed_books" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_keyed_books"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_keyed_books_tenant_update" ON "test_keyed_books" AS PERMISSIVE FOR UPDATE TO public USING (("test_keyed_books"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_keyed_books"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_keyed_books_tenant_delete" ON "test_keyed_books" AS PERMISSIVE FOR DELETE TO public USING (("test_keyed_books"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_keyed_loans_tenant_select" ON "test_keyed_loans" AS PERMISSIVE FOR SELECT TO public USING (("test_keyed_loans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_keyed_loans_tenant_insert" ON "test_keyed_loans" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_keyed_loans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_keyed_loans_tenant_update" ON "test_keyed_loans" AS PERMISSIVE FOR UPDATE TO public USING (("test_keyed_loans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_keyed_loans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_keyed_loans_tenant_delete" ON "test_keyed_loans" AS PERMISSIVE FOR DELETE TO public USING (("test_keyed_loans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_keyed_shelves_tenant_select" ON "test_keyed_shelves" AS PERMISSIVE FOR SELECT TO public USING (("test_keyed_shelves"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_keyed_shelves_tenant_insert" ON "test_keyed_shelves" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("test_keyed_shelves"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_keyed_shelves_tenant_update" ON "test_keyed_shelves" AS PERMISSIVE FOR UPDATE TO public USING (("test_keyed_shelves"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("test_keyed_shelves"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "test_keyed_shelves_tenant_delete" ON "test_keyed_shelves" AS PERMISSIVE FOR DELETE TO public USING (("test_keyed_shelves"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));