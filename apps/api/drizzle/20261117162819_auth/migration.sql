CREATE TABLE "app_secrets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL UNIQUE,
	"value" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"details" jsonb,
	"ip" text,
	"tenant_id" uuid
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "api_clients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"allowed_cidrs" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "api_clients_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "api_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"client_id" uuid NOT NULL,
	"key_id" text NOT NULL UNIQUE,
	"key_hash" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp(3) with time zone,
	"revoked_at" timestamp(3) with time zone,
	"last_used_at" timestamp(3) with time zone,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"selected_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY,
	"family_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"family_expires_at" timestamp(3) with time zone NOT NULL,
	"used_at" timestamp(3) with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"claims" jsonb
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"last_active_at" timestamp(3) with time zone NOT NULL,
	"mfa" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"email" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"password_hash" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"locale" text,
	"timezone" text,
	"active" boolean DEFAULT true NOT NULL,
	"onboarding_email" boolean DEFAULT false NOT NULL,
	"onboarding_password" boolean DEFAULT false NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" ("at");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_at_id_idx" ON "audit_log" ("tenant_id","at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "audit_log_tenant_id_id_idx" ON "audit_log" ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_action_at_idx" ON "audit_log" ("actor","action","at");--> statement-breakpoint
CREATE INDEX "audit_log_target_id_id_idx" ON "audit_log" ("target_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_id_idx" ON "audit_log" ("actor","id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_action_id_idx" ON "audit_log" ("tenant_id","action","id");--> statement-breakpoint
CREATE INDEX "audit_log_sign_ins_id_idx" ON "audit_log" ("tenant_id","id") WHERE action in ('member.signed-in', 'member.sign-in-failed');--> statement-breakpoint
CREATE INDEX "audit_log_sign_ins_at_idx" ON "audit_log" ("tenant_id","at" DESC,"id" DESC) WHERE action in ('member.signed-in', 'member.sign-in-failed');--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_tenant_name_idx" ON "api_clients" ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "api_keys_client_id_idx" ON "api_keys" ("client_id");--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens" ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_expires_at_idx" ON "refresh_tokens" ("family_expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" ("expires_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "api_clients"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "audit_log_tenant_select" ON "audit_log" AS PERMISSIVE FOR SELECT TO public USING ((("audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null)));--> statement-breakpoint
CREATE POLICY "audit_log_tenant_insert" ON "audit_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((("audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null)));--> statement-breakpoint
CREATE POLICY "audit_log_tenant_update" ON "audit_log" AS PERMISSIVE FOR UPDATE TO public USING ((("audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null))) WITH CHECK ((("audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null)));--> statement-breakpoint
CREATE POLICY "audit_log_tenant_delete" ON "audit_log" AS PERMISSIVE FOR DELETE TO public USING ((("audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) or ("audit_log"."tenant_id" is null and (select nullif(current_setting('app.tenant_id', true), '')::uuid) is null)));--> statement-breakpoint
CREATE POLICY "api_clients_tenant_select" ON "api_clients" AS PERMISSIVE FOR SELECT TO public USING (("api_clients"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_clients_tenant_insert" ON "api_clients" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("api_clients"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_clients_tenant_update" ON "api_clients" AS PERMISSIVE FOR UPDATE TO public USING (("api_clients"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("api_clients"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_clients_tenant_delete" ON "api_clients" AS PERMISSIVE FOR DELETE TO public USING (("api_clients"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_keys_global" ON "api_keys" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "memberships_global" ON "memberships" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);