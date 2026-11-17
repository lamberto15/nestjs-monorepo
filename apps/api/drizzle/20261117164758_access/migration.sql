CREATE TABLE "api_client_roles" (
	"client_id" uuid,
	"role_id" uuid,
	"expires_at" timestamp(3) with time zone,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "api_client_roles_pkey" PRIMARY KEY("client_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "api_client_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"role_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"action" text NOT NULL,
	"conditions" jsonb DEFAULT '[]' NOT NULL,
	"fields" jsonb,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"key" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "roles_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid,
	"role_id" uuid,
	"expires_at" timestamp(3) with time zone,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "user_roles_pkey" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizational_unit_closure" (
	"ancestor_id" uuid,
	"descendant_id" uuid,
	"depth" integer NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "organizational_unit_closure_pkey" PRIMARY KEY("ancestor_id","descendant_id")
);
--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizational_unit_memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"unit_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"valid_from" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "organizational_unit_memberships_role_check" CHECK ("role" in ('member', 'lead')),
	CONSTRAINT "organizational_unit_memberships_period_check" CHECK ("valid_to" is null or "valid_to" > "valid_from")
);
--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizational_units" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"type" text DEFAULT 'team' NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "organizational_units_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "organizational_units_type_check" CHECK ("type" in ('division', 'department', 'team'))
);
--> statement-breakpoint
ALTER TABLE "organizational_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "api_client_roles_role_id_idx" ON "api_client_roles" ("role_id");--> statement-breakpoint
CREATE INDEX "role_permissions_role_id_idx" ON "role_permissions" ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_key_idx" ON "roles" ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_idx" ON "roles" ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "user_roles_role_live_idx" ON "user_roles" ("role_id","tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "organizational_unit_closure_descendant_idx" ON "organizational_unit_closure" ("descendant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizational_unit_memberships_open_idx" ON "organizational_unit_memberships" ("tenant_id","unit_id","user_id") WHERE ("valid_to" is null);--> statement-breakpoint
CREATE INDEX "organizational_unit_memberships_user_idx" ON "organizational_unit_memberships" ("user_id","valid_from");--> statement-breakpoint
CREATE INDEX "organizational_unit_memberships_unit_idx" ON "organizational_unit_memberships" ("unit_id");--> statement-breakpoint
CREATE INDEX "organizational_units_parent_id_idx" ON "organizational_units" ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizational_units_sibling_name_idx" ON "organizational_units" ("tenant_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
ALTER TABLE "api_client_roles" ADD CONSTRAINT "api_client_roles_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_client_roles" ADD CONSTRAINT "api_client_roles_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "api_clients"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_client_roles" ADD CONSTRAINT "api_client_roles_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "roles"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "roles"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "memberships"("tenant_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "roles"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" ADD CONSTRAINT "organizational_unit_closure_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" ADD CONSTRAINT "organizational_unit_closure_ancestor_fk" FOREIGN KEY ("tenant_id","ancestor_id") REFERENCES "organizational_units"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organizational_unit_closure" ADD CONSTRAINT "organizational_unit_closure_descendant_fk" FOREIGN KEY ("tenant_id","descendant_id") REFERENCES "organizational_units"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD CONSTRAINT "organizational_unit_memberships_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD CONSTRAINT "organizational_unit_memberships_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "memberships"("tenant_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organizational_unit_memberships" ADD CONSTRAINT "organizational_unit_memberships_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "organizational_units"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organizational_units" ADD CONSTRAINT "organizational_units_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organizational_units" ADD CONSTRAINT "organizational_units_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "organizational_units"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "api_client_roles_tenant_select" ON "api_client_roles" AS PERMISSIVE FOR SELECT TO public USING (("api_client_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_client_roles_tenant_insert" ON "api_client_roles" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("api_client_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_client_roles_tenant_update" ON "api_client_roles" AS PERMISSIVE FOR UPDATE TO public USING (("api_client_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("api_client_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_client_roles_tenant_delete" ON "api_client_roles" AS PERMISSIVE FOR DELETE TO public USING (("api_client_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "role_permissions_tenant_select" ON "role_permissions" AS PERMISSIVE FOR SELECT TO public USING (("role_permissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "role_permissions_tenant_insert" ON "role_permissions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("role_permissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "role_permissions_tenant_update" ON "role_permissions" AS PERMISSIVE FOR UPDATE TO public USING (("role_permissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("role_permissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "role_permissions_tenant_delete" ON "role_permissions" AS PERMISSIVE FOR DELETE TO public USING (("role_permissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "roles_tenant_select" ON "roles" AS PERMISSIVE FOR SELECT TO public USING (("roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "roles_tenant_insert" ON "roles" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "roles_tenant_update" ON "roles" AS PERMISSIVE FOR UPDATE TO public USING (("roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "roles_tenant_delete" ON "roles" AS PERMISSIVE FOR DELETE TO public USING (("roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_roles_tenant_select" ON "user_roles" AS PERMISSIVE FOR SELECT TO public USING (("user_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_roles_tenant_insert" ON "user_roles" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("user_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_roles_tenant_update" ON "user_roles" AS PERMISSIVE FOR UPDATE TO public USING (("user_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("user_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "user_roles_tenant_delete" ON "user_roles" AS PERMISSIVE FOR DELETE TO public USING (("user_roles"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_closure_tenant_select" ON "organizational_unit_closure" AS PERMISSIVE FOR SELECT TO public USING (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_closure_tenant_insert" ON "organizational_unit_closure" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_closure_tenant_update" ON "organizational_unit_closure" AS PERMISSIVE FOR UPDATE TO public USING (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_closure_tenant_delete" ON "organizational_unit_closure" AS PERMISSIVE FOR DELETE TO public USING (("organizational_unit_closure"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_select" ON "organizational_unit_memberships" AS PERMISSIVE FOR SELECT TO public USING (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_insert" ON "organizational_unit_memberships" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_update" ON "organizational_unit_memberships" AS PERMISSIVE FOR UPDATE TO public USING (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_unit_memberships_tenant_delete" ON "organizational_unit_memberships" AS PERMISSIVE FOR DELETE TO public USING (("organizational_unit_memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_select" ON "organizational_units" AS PERMISSIVE FOR SELECT TO public USING (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_insert" ON "organizational_units" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_update" ON "organizational_units" AS PERMISSIVE FOR UPDATE TO public USING (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "organizational_units_tenant_delete" ON "organizational_units" AS PERMISSIVE FOR DELETE TO public USING (("organizational_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));