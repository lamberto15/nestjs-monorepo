CREATE TABLE "account_devices" (
	"user_id" uuid,
	"device" text,
	"last_seen_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_devices_pkey" PRIMARY KEY("user_id","device")
);
--> statement-breakpoint
CREATE TABLE "email_tokens" (
	"id" text PRIMARY KEY,
	"purpose" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"fingerprint" text,
	"created_at" timestamp(3) with time zone NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"redirect_to" text
);
--> statement-breakpoint
CREATE TABLE "mfa_authenticators" (
	"id" uuid PRIMARY KEY,
	"secret" text NOT NULL,
	"confirmed" boolean NOT NULL,
	"pending_secret" text,
	"last_used_step" integer
);
--> statement-breakpoint
CREATE TABLE "mfa_failures" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mfa_failures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"failed_at" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"user_id" uuid,
	"code_hash" text,
	CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY("user_id","code_hash")
);
--> statement-breakpoint
CREATE TABLE "oidc_logins" (
	"state" text PRIMARY KEY,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"nonce" text,
	"redirect_to" text,
	"link_user_id" text,
	"link_session_id" text,
	"created_at" timestamp(3) with time zone NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"credential_id" text NOT NULL UNIQUE,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]' NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"aaguid" text DEFAULT '' NOT NULL,
	"last_used_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"provider" text,
	"subject" text,
	"user_id" uuid NOT NULL,
	"email" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_pkey" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "break_glass_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"target_tenant_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"ended_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "break_glass_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" uuid,
	"reason" text NOT NULL,
	"placed_by" text NOT NULL,
	"released_at" timestamp(3) with time zone,
	"released_by" text,
	"release_note" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"email" text,
	"name" text,
	"role_ids" jsonb DEFAULT '[]' NOT NULL,
	"role_expires_at" jsonb DEFAULT '{}' NOT NULL,
	"unit_ids" jsonb DEFAULT '[]' NOT NULL,
	"token_hash" text,
	"invited_by" text NOT NULL,
	"sent_at" timestamp(3) with time zone,
	"expires_at" timestamp(3) with time zone,
	"accepted_at" timestamp(3) with time zone,
	"accepted_by" uuid,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scim_deprovisioned_users" (
	"user_id" uuid PRIMARY KEY,
	"deprovisioned_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"unit_id" uuid,
	"external_id" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "scim_groups_pkey" PRIMARY KEY("tenant_id","unit_id")
);
--> statement-breakpoint
ALTER TABLE "scim_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scim_users" (
	"user_id" uuid,
	"external_id" text,
	"attributes" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "scim_users_pkey" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "scim_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_assertions" (
	"connection_id" uuid,
	"assertion_id" text,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "sso_assertions_pkey" PRIMARY KEY("tenant_id","connection_id","assertion_id")
);
--> statement-breakpoint
ALTER TABLE "sso_assertions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"jit_provisioning" boolean DEFAULT false NOT NULL,
	"issuer" text,
	"client_id" text,
	"client_secret" text,
	"oidc_metadata" jsonb,
	"metadata_fetched_at" timestamp(3) with time zone,
	"metadata_error" text,
	"authorization_endpoint" text,
	"token_endpoint" text,
	"userinfo_endpoint" text,
	"token_endpoint_auth_method" text,
	"scopes" jsonb,
	"mapping" jsonb,
	"preset" jsonb,
	"idp_entity_id" text,
	"idp_sso_url" text,
	"idp_certificates" jsonb DEFAULT '[]' NOT NULL,
	"allow_idp_initiated" boolean DEFAULT false NOT NULL,
	"require_encrypted_assertions" boolean DEFAULT false NOT NULL,
	"sp_private_key" text,
	"sp_certificate" text,
	"groups_attribute" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "sso_connections_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "sso_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_domain_routes" (
	"domain" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "sso_domain_routes_pkey" PRIMARY KEY("domain","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "sso_domain_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_domains" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"domain" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp(3) with time zone,
	"last_checked_at" timestamp(3) with time zone,
	"last_error" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sso_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_exemptions" (
	"user_id" uuid,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "sso_exemptions_pkey" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "sso_exemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_identities" (
	"connection_id" uuid,
	"subject" text,
	"user_id" uuid NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "sso_identities_pkey" PRIMARY KEY("tenant_id","connection_id","subject")
);
--> statement-breakpoint
ALTER TABLE "sso_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_policies" (
	"require_sso" boolean DEFAULT false NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid PRIMARY KEY
);
--> statement-breakpoint
ALTER TABLE "sso_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"connection_id" uuid NOT NULL,
	"binding_hash" text NOT NULL,
	"code_verifier" text,
	"nonce" text,
	"saml_request_id" text,
	"redirect_to" text,
	"user_id" uuid,
	"authenticated_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"consumed_at" timestamp(3) with time zone,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sso_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_role_grants" (
	"user_id" uuid,
	"role_id" uuid,
	"connection_id" uuid NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "sso_role_grants_pkey" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "sso_role_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sso_role_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"connection_id" uuid NOT NULL,
	"group" text,
	"role_id" uuid NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "sso_role_mappings_connection_group_role_key" UNIQUE NULLS NOT DISTINCT("connection_id","group","role_id")
);
--> statement-breakpoint
ALTER TABLE "sso_role_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_domain_routes" (
	"hostname" text PRIMARY KEY,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_domain_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_domains" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"hostname" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp(3) with time zone,
	"last_checked_at" timestamp(3) with time zone,
	"last_error" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_lifecycle" (
	"created_by_sign_up" boolean DEFAULT false NOT NULL,
	"deletion_requested_at" timestamp(3) with time zone,
	"deletion_scheduled_for" timestamp(3) with time zone,
	"deletion_started_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid PRIMARY KEY
);
--> statement-breakpoint
ALTER TABLE "tenant_lifecycle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "business_calendars" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"hours" jsonb NOT NULL,
	"exceptions" jsonb DEFAULT '[]' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "business_calendars_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "business_calendars" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mail_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"address" text NOT NULL,
	"occurred_at" timestamp(3) with time zone NOT NULL,
	"detail" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"address" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"last_detail" text,
	"events" integer DEFAULT 0 NOT NULL,
	"soft_bounces" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"suppressed_at" timestamp(3) with time zone,
	"skipped" integer DEFAULT 0 NOT NULL,
	"last_skipped_at" timestamp(3) with time zone,
	"created_by" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messaging_devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"token_index" text NOT NULL,
	"last_seen_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messaging_usage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"day" date NOT NULL,
	"counter" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messaging_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"phone_index" text NOT NULL,
	"verified_at" timestamp(3) with time zone,
	"opted_out_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"source" text NOT NULL,
	"day" date NOT NULL,
	"base" char(3) NOT NULL,
	"currency" char(3) NOT NULL,
	"rate" numeric NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"recipient" text NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"quiet_hours" jsonb,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"recipient" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}' NOT NULL,
	"key" text,
	"count" integer DEFAULT 1 NOT NULL,
	"link" text,
	"read_at" timestamp(3) with time zone,
	"delivered_at" timestamp(3) with time zone,
	"digest" text,
	"digest_due_at" timestamp(3) with time zone,
	"emailed_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"last_seen_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" text NOT NULL,
	"subscriber" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quota_plans" (
	"name" text PRIMARY KEY,
	"limits" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_quotas" (
	"plan" text,
	"limits" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid PRIMARY KEY
);
--> statement-breakpoint
ALTER TABLE "tenant_quotas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "record_schedule_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"schedule_id" uuid NOT NULL,
	"occurrence_at" timestamp(3) with time zone NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_schedule_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "record_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"target" text NOT NULL,
	"template" jsonb NOT NULL,
	"rrule" text NOT NULL,
	"start_date" date NOT NULL,
	"time" text NOT NULL,
	"timezone" text NOT NULL,
	"calendar_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"end_reason" text,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"max_occurrences" integer,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_run_at" timestamp(3) with time zone,
	"last_status" text,
	"next_run_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "record_schedules_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "record_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"rule" text NOT NULL,
	"days" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp(3) with time zone,
	"last_count" integer,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retention_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "naming_series" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"pattern" text NOT NULL,
	"label" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"date_field" text,
	"conditions" jsonb DEFAULT '[]' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "naming_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_setting_values" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"key" text NOT NULL UNIQUE,
	"value" jsonb,
	"secret" text,
	"enforced" boolean DEFAULT false NOT NULL,
	"rollout" integer,
	"rules" jsonb DEFAULT '[]' NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setting_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"value" jsonb,
	"secret" text,
	"rollout" integer,
	"rules" jsonb DEFAULT '[]' NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "setting_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "api_client_quotas" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"client_id" uuid NOT NULL,
	"daily_quota" integer NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_client_quotas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "api_usage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"client_id" uuid NOT NULL,
	"day" date NOT NULL,
	"route" text NOT NULL,
	"count" integer NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "incoming_webhook_senders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"secret" text NOT NULL,
	"previous_secret" text,
	"previous_secret_expires_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incoming_webhook_senders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_delivery_requests" (
	"delivery_id" text PRIMARY KEY,
	"attempt" integer NOT NULL,
	"headers" jsonb NOT NULL,
	"signed_with" jsonb,
	"sent_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_tokens_user_id_purpose_idx" ON "email_tokens" ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "email_tokens_expires_at_idx" ON "email_tokens" ("expires_at");--> statement-breakpoint
CREATE INDEX "magic_links_expires_at_idx" ON "magic_links" ("expires_at");--> statement-breakpoint
CREATE INDEX "mfa_failures_user_id_failed_at_idx" ON "mfa_failures" ("user_id","failed_at");--> statement-breakpoint
CREATE INDEX "mfa_failures_failed_at_idx" ON "mfa_failures" ("failed_at");--> statement-breakpoint
CREATE INDEX "oidc_logins_expires_at_idx" ON "oidc_logins" ("expires_at");--> statement-breakpoint
CREATE INDEX "passkeys_user_id_idx" ON "passkeys" ("user_id");--> statement-breakpoint
CREATE INDEX "password_history_user_id_idx" ON "password_history" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_identities_user_id_idx" ON "user_identities" ("user_id");--> statement-breakpoint
CREATE INDEX "break_glass_grants_user_target_idx" ON "break_glass_grants" ("tenant_id","user_id","target_tenant_id");--> statement-breakpoint
CREATE INDEX "legal_holds_active_idx" ON "legal_holds" ("tenant_id","subject","record_id") WHERE released_at is null;--> statement-breakpoint
CREATE INDEX "legal_holds_created_at_idx" ON "legal_holds" ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_tenant_token_idx" ON "invitations" ("tenant_id","token_hash");--> statement-breakpoint
CREATE INDEX "invitations_tenant_email_idx" ON "invitations" ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_groups_tenant_external_id_idx" ON "scim_groups" ("tenant_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_users_tenant_external_id_idx" ON "scim_users" ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "sso_assertions_expires_at_idx" ON "sso_assertions" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_tenant_name_idx" ON "sso_connections" ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "sso_domain_routes_tenant_id_idx" ON "sso_domain_routes" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domains_tenant_domain_idx" ON "sso_domains" ("tenant_id","domain");--> statement-breakpoint
CREATE INDEX "sso_identities_user_id_idx" ON "sso_identities" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_requests_tenant_binding_idx" ON "sso_requests" ("tenant_id","binding_hash");--> statement-breakpoint
CREATE INDEX "sso_requests_connection_saml_idx" ON "sso_requests" ("connection_id","saml_request_id");--> statement-breakpoint
CREATE INDEX "sso_requests_expires_at_idx" ON "sso_requests" ("expires_at");--> statement-breakpoint
CREATE INDEX "sso_role_grants_connection_idx" ON "sso_role_grants" ("connection_id","user_id");--> statement-breakpoint
CREATE INDEX "sso_role_mappings_role_id_idx" ON "sso_role_mappings" ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_domains_tenant_hostname_idx" ON "tenant_domains" ("tenant_id","hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "business_calendars_name_idx" ON "business_calendars" ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_events_provider_event_address_idx" ON "mail_events" ("provider","event_id","address");--> statement-breakpoint
CREATE INDEX "mail_events_address_idx" ON "mail_events" ("address");--> statement-breakpoint
CREATE INDEX "mail_events_created_at_idx" ON "mail_events" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_suppressions_address_idx" ON "mail_suppressions" ("address");--> statement-breakpoint
CREATE INDEX "mail_suppressions_reason_idx" ON "mail_suppressions" ("reason");--> statement-breakpoint
CREATE INDEX "mail_suppressions_suppressed_at_idx" ON "mail_suppressions" ("suppressed_at");--> statement-breakpoint
CREATE INDEX "mail_suppressions_last_seen_at_idx" ON "mail_suppressions" ("last_seen_at");--> statement-breakpoint
CREATE INDEX "messaging_devices_user_id_idx" ON "messaging_devices" ("user_id");--> statement-breakpoint
CREATE INDEX "messaging_devices_token_index_idx" ON "messaging_devices" ("token_index");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_usage_counter_idx" ON "messaging_usage" ("tenant_id","day","counter");--> statement-breakpoint
CREATE INDEX "messaging_usage_day_idx" ON "messaging_usage" ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_user_id_idx" ON "phone_numbers" ("user_id");--> statement-breakpoint
CREATE INDEX "phone_numbers_phone_index_idx" ON "phone_numbers" ("phone_index");--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_source_day_currency_idx" ON "exchange_rates" ("source","day","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_recipient_idx" ON "notification_preferences" ("recipient");--> statement-breakpoint
CREATE INDEX "notifications_recipient_id_idx" ON "notifications" ("tenant_id","recipient","id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_unread_idx" ON "notifications" ("tenant_id","recipient","id") WHERE ("read_at" is null);--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_recipient_key_idx" ON "notifications" ("tenant_id","recipient","key") WHERE ("key" is not null);--> statement-breakpoint
CREATE INDEX "notifications_digest_due_idx" ON "notifications" ("digest_due_at") WHERE ("digest_due_at" is not null);--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_endpoint_idx" ON "push_devices" ("endpoint");--> statement-breakpoint
CREATE INDEX "push_devices_user_id_idx" ON "push_devices" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_subscriptions_record_subscriber_idx" ON "record_subscriptions" ("tenant_id","subject","record_id","subscriber");--> statement-breakpoint
CREATE INDEX "record_subscriptions_subscriber_id_idx" ON "record_subscriptions" ("tenant_id","subscriber","id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_schedule_runs_occurrence_idx" ON "record_schedule_runs" ("tenant_id","schedule_id","occurrence_at");--> statement-breakpoint
CREATE INDEX "record_schedules_owner_idx" ON "record_schedules" ("tenant_id","owner","id");--> statement-breakpoint
CREATE INDEX "record_schedules_next_run_at_idx" ON "record_schedules" ("tenant_id","next_run_at") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "retention_policies_rule_idx" ON "retention_policies" ("tenant_id","rule");--> statement-breakpoint
CREATE INDEX "retention_policies_enabled_idx" ON "retention_policies" ("tenant_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "naming_series_pattern_idx" ON "naming_series" ("tenant_id","subject","pattern");--> statement-breakpoint
CREATE UNIQUE INDEX "naming_series_default_idx" ON "naming_series" ("tenant_id","subject") WHERE "is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "sequences_name_scope_idx" ON "sequences" ("tenant_id","name","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "setting_overrides_key_scope_idx" ON "setting_overrides" ("tenant_id","key","scope","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_client_quotas_client_idx" ON "api_client_quotas" ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_usage_client_day_route_idx" ON "api_usage" ("tenant_id","client_id","day","route");--> statement-breakpoint
CREATE INDEX "api_usage_day_idx" ON "api_usage" ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_webhook_senders_name_idx" ON "incoming_webhook_senders" ("tenant_id","name");--> statement-breakpoint
ALTER TABLE "account_devices" ADD CONSTRAINT "account_devices_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mfa_authenticators" ADD CONSTRAINT "mfa_authenticators_id_users_id_fkey" FOREIGN KEY ("id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_target_tenant_id_tenants_id_fkey" FOREIGN KEY ("target_tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scim_deprovisioned_users" ADD CONSTRAINT "scim_deprovisioned_users_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "organizational_units"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "memberships"("tenant_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_assertions" ADD CONSTRAINT "sso_assertions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_assertions" ADD CONSTRAINT "sso_assertions_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "sso_connections"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_domain_routes" ADD CONSTRAINT "sso_domain_routes_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_exemptions" ADD CONSTRAINT "sso_exemptions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_exemptions" ADD CONSTRAINT "sso_exemptions_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "memberships"("tenant_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "sso_connections"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_policies" ADD CONSTRAINT "sso_policies_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_requests" ADD CONSTRAINT "sso_requests_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_requests" ADD CONSTRAINT "sso_requests_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "sso_connections"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_role_grants" ADD CONSTRAINT "sso_role_grants_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_role_grants" ADD CONSTRAINT "sso_role_grants_user_role_fk" FOREIGN KEY ("user_id","role_id") REFERENCES "user_roles"("user_id","role_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_role_grants" ADD CONSTRAINT "sso_role_grants_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "sso_connections"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_role_mappings" ADD CONSTRAINT "sso_role_mappings_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_role_mappings" ADD CONSTRAINT "sso_role_mappings_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "sso_connections"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sso_role_mappings" ADD CONSTRAINT "sso_role_mappings_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "roles"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_domain_routes" ADD CONSTRAINT "tenant_domain_routes_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_lifecycle" ADD CONSTRAINT "tenant_lifecycle_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "business_calendars" ADD CONSTRAINT "business_calendars_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messaging_devices" ADD CONSTRAINT "messaging_devices_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messaging_usage" ADD CONSTRAINT "messaging_usage_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_subscriptions" ADD CONSTRAINT "record_subscriptions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_quotas" ADD CONSTRAINT "tenant_quotas_plan_quota_plans_name_fkey" FOREIGN KEY ("plan") REFERENCES "quota_plans"("name") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tenant_quotas" ADD CONSTRAINT "tenant_quotas_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_schedule_runs" ADD CONSTRAINT "record_schedule_runs_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_schedule_runs" ADD CONSTRAINT "record_schedule_runs_schedule_fk" FOREIGN KEY ("tenant_id","schedule_id") REFERENCES "record_schedules"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_schedules" ADD CONSTRAINT "record_schedules_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_schedules" ADD CONSTRAINT "record_schedules_calendar_fk" FOREIGN KEY ("tenant_id","calendar_id") REFERENCES "business_calendars"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "naming_series" ADD CONSTRAINT "naming_series_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "setting_overrides" ADD CONSTRAINT "setting_overrides_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_client_quotas" ADD CONSTRAINT "api_client_quotas_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_client_quotas" ADD CONSTRAINT "api_client_quotas_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "api_clients"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "api_clients"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "incoming_webhook_senders" ADD CONSTRAINT "incoming_webhook_senders_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "break_glass_grants_tenant_select" ON "break_glass_grants" AS PERMISSIVE FOR SELECT TO public USING (("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "break_glass_grants_tenant_insert" ON "break_glass_grants" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "break_glass_grants_tenant_update" ON "break_glass_grants" AS PERMISSIVE FOR UPDATE TO public USING (("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "break_glass_grants_tenant_delete" ON "break_glass_grants" AS PERMISSIVE FOR DELETE TO public USING (("break_glass_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "legal_holds_tenant_select" ON "legal_holds" AS PERMISSIVE FOR SELECT TO public USING (("legal_holds"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "legal_holds_tenant_insert" ON "legal_holds" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("legal_holds"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "legal_holds_tenant_update" ON "legal_holds" AS PERMISSIVE FOR UPDATE TO public USING (("legal_holds"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("legal_holds"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "legal_holds_tenant_delete" ON "legal_holds" AS PERMISSIVE FOR DELETE TO public USING (("legal_holds"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "invitations_tenant_select" ON "invitations" AS PERMISSIVE FOR SELECT TO public USING (("invitations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "invitations_tenant_insert" ON "invitations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("invitations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "invitations_tenant_update" ON "invitations" AS PERMISSIVE FOR UPDATE TO public USING (("invitations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("invitations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "invitations_tenant_delete" ON "invitations" AS PERMISSIVE FOR DELETE TO public USING (("invitations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_groups_tenant_select" ON "scim_groups" AS PERMISSIVE FOR SELECT TO public USING (("scim_groups"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_groups_tenant_insert" ON "scim_groups" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("scim_groups"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_groups_tenant_update" ON "scim_groups" AS PERMISSIVE FOR UPDATE TO public USING (("scim_groups"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("scim_groups"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_groups_tenant_delete" ON "scim_groups" AS PERMISSIVE FOR DELETE TO public USING (("scim_groups"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_users_tenant_select" ON "scim_users" AS PERMISSIVE FOR SELECT TO public USING (("scim_users"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_users_tenant_insert" ON "scim_users" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("scim_users"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_users_tenant_update" ON "scim_users" AS PERMISSIVE FOR UPDATE TO public USING (("scim_users"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("scim_users"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "scim_users_tenant_delete" ON "scim_users" AS PERMISSIVE FOR DELETE TO public USING (("scim_users"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_assertions_tenant_select" ON "sso_assertions" AS PERMISSIVE FOR SELECT TO public USING (("sso_assertions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_assertions_tenant_insert" ON "sso_assertions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_assertions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_assertions_tenant_update" ON "sso_assertions" AS PERMISSIVE FOR UPDATE TO public USING (("sso_assertions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_assertions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_assertions_tenant_delete" ON "sso_assertions" AS PERMISSIVE FOR DELETE TO public USING (("sso_assertions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_connections_tenant_select" ON "sso_connections" AS PERMISSIVE FOR SELECT TO public USING (("sso_connections"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_connections_tenant_insert" ON "sso_connections" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_connections"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_connections_tenant_update" ON "sso_connections" AS PERMISSIVE FOR UPDATE TO public USING (("sso_connections"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_connections"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_connections_tenant_delete" ON "sso_connections" AS PERMISSIVE FOR DELETE TO public USING (("sso_connections"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_domain_routes_global" ON "sso_domain_routes" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "sso_domains_tenant_select" ON "sso_domains" AS PERMISSIVE FOR SELECT TO public USING (("sso_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_domains_tenant_insert" ON "sso_domains" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_domains_tenant_update" ON "sso_domains" AS PERMISSIVE FOR UPDATE TO public USING (("sso_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_domains_tenant_delete" ON "sso_domains" AS PERMISSIVE FOR DELETE TO public USING (("sso_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_exemptions_tenant_select" ON "sso_exemptions" AS PERMISSIVE FOR SELECT TO public USING (("sso_exemptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_exemptions_tenant_insert" ON "sso_exemptions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_exemptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_exemptions_tenant_update" ON "sso_exemptions" AS PERMISSIVE FOR UPDATE TO public USING (("sso_exemptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_exemptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_exemptions_tenant_delete" ON "sso_exemptions" AS PERMISSIVE FOR DELETE TO public USING (("sso_exemptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_identities_tenant_select" ON "sso_identities" AS PERMISSIVE FOR SELECT TO public USING (("sso_identities"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_identities_tenant_insert" ON "sso_identities" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_identities"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_identities_tenant_update" ON "sso_identities" AS PERMISSIVE FOR UPDATE TO public USING (("sso_identities"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_identities"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_identities_tenant_delete" ON "sso_identities" AS PERMISSIVE FOR DELETE TO public USING (("sso_identities"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_policies_tenant_select" ON "sso_policies" AS PERMISSIVE FOR SELECT TO public USING (("sso_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_policies_tenant_insert" ON "sso_policies" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_policies_tenant_update" ON "sso_policies" AS PERMISSIVE FOR UPDATE TO public USING (("sso_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_policies_tenant_delete" ON "sso_policies" AS PERMISSIVE FOR DELETE TO public USING (("sso_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_requests_tenant_select" ON "sso_requests" AS PERMISSIVE FOR SELECT TO public USING (("sso_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_requests_tenant_insert" ON "sso_requests" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_requests_tenant_update" ON "sso_requests" AS PERMISSIVE FOR UPDATE TO public USING (("sso_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_requests_tenant_delete" ON "sso_requests" AS PERMISSIVE FOR DELETE TO public USING (("sso_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_grants_tenant_select" ON "sso_role_grants" AS PERMISSIVE FOR SELECT TO public USING (("sso_role_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_grants_tenant_insert" ON "sso_role_grants" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_role_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_grants_tenant_update" ON "sso_role_grants" AS PERMISSIVE FOR UPDATE TO public USING (("sso_role_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_role_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_grants_tenant_delete" ON "sso_role_grants" AS PERMISSIVE FOR DELETE TO public USING (("sso_role_grants"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_mappings_tenant_select" ON "sso_role_mappings" AS PERMISSIVE FOR SELECT TO public USING (("sso_role_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_mappings_tenant_insert" ON "sso_role_mappings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sso_role_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_mappings_tenant_update" ON "sso_role_mappings" AS PERMISSIVE FOR UPDATE TO public USING (("sso_role_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sso_role_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sso_role_mappings_tenant_delete" ON "sso_role_mappings" AS PERMISSIVE FOR DELETE TO public USING (("sso_role_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_domain_routes_global" ON "tenant_domain_routes" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_domains_tenant_select" ON "tenant_domains" AS PERMISSIVE FOR SELECT TO public USING (("tenant_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_domains_tenant_insert" ON "tenant_domains" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("tenant_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_domains_tenant_update" ON "tenant_domains" AS PERMISSIVE FOR UPDATE TO public USING (("tenant_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("tenant_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_domains_tenant_delete" ON "tenant_domains" AS PERMISSIVE FOR DELETE TO public USING (("tenant_domains"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_lifecycle_global" ON "tenant_lifecycle" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "business_calendars_tenant_select" ON "business_calendars" AS PERMISSIVE FOR SELECT TO public USING (("business_calendars"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "business_calendars_tenant_insert" ON "business_calendars" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("business_calendars"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "business_calendars_tenant_update" ON "business_calendars" AS PERMISSIVE FOR UPDATE TO public USING (("business_calendars"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("business_calendars"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "business_calendars_tenant_delete" ON "business_calendars" AS PERMISSIVE FOR DELETE TO public USING (("business_calendars"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "messaging_usage_tenant_select" ON "messaging_usage" AS PERMISSIVE FOR SELECT TO public USING (("messaging_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "messaging_usage_tenant_insert" ON "messaging_usage" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("messaging_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "messaging_usage_tenant_update" ON "messaging_usage" AS PERMISSIVE FOR UPDATE TO public USING (("messaging_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("messaging_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "messaging_usage_tenant_delete" ON "messaging_usage" AS PERMISSIVE FOR DELETE TO public USING (("messaging_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "notifications_tenant_select" ON "notifications" AS PERMISSIVE FOR SELECT TO public USING (("notifications"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "notifications_tenant_insert" ON "notifications" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("notifications"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "notifications_tenant_update" ON "notifications" AS PERMISSIVE FOR UPDATE TO public USING (("notifications"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("notifications"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "notifications_tenant_delete" ON "notifications" AS PERMISSIVE FOR DELETE TO public USING (("notifications"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_subscriptions_tenant_select" ON "record_subscriptions" AS PERMISSIVE FOR SELECT TO public USING (("record_subscriptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_subscriptions_tenant_insert" ON "record_subscriptions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("record_subscriptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_subscriptions_tenant_update" ON "record_subscriptions" AS PERMISSIVE FOR UPDATE TO public USING (("record_subscriptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("record_subscriptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_subscriptions_tenant_delete" ON "record_subscriptions" AS PERMISSIVE FOR DELETE TO public USING (("record_subscriptions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_quotas_global" ON "tenant_quotas" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "record_schedule_runs_tenant_select" ON "record_schedule_runs" AS PERMISSIVE FOR SELECT TO public USING (("record_schedule_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedule_runs_tenant_insert" ON "record_schedule_runs" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("record_schedule_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedule_runs_tenant_update" ON "record_schedule_runs" AS PERMISSIVE FOR UPDATE TO public USING (("record_schedule_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("record_schedule_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedule_runs_tenant_delete" ON "record_schedule_runs" AS PERMISSIVE FOR DELETE TO public USING (("record_schedule_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedules_tenant_select" ON "record_schedules" AS PERMISSIVE FOR SELECT TO public USING (("record_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedules_tenant_insert" ON "record_schedules" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("record_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedules_tenant_update" ON "record_schedules" AS PERMISSIVE FOR UPDATE TO public USING (("record_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("record_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_schedules_tenant_delete" ON "record_schedules" AS PERMISSIVE FOR DELETE TO public USING (("record_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "retention_policies_tenant_select" ON "retention_policies" AS PERMISSIVE FOR SELECT TO public USING (("retention_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "retention_policies_tenant_insert" ON "retention_policies" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("retention_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "retention_policies_tenant_update" ON "retention_policies" AS PERMISSIVE FOR UPDATE TO public USING (("retention_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("retention_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "retention_policies_tenant_delete" ON "retention_policies" AS PERMISSIVE FOR DELETE TO public USING (("retention_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "naming_series_tenant_select" ON "naming_series" AS PERMISSIVE FOR SELECT TO public USING (("naming_series"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "naming_series_tenant_insert" ON "naming_series" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("naming_series"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "naming_series_tenant_update" ON "naming_series" AS PERMISSIVE FOR UPDATE TO public USING (("naming_series"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("naming_series"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "naming_series_tenant_delete" ON "naming_series" AS PERMISSIVE FOR DELETE TO public USING (("naming_series"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sequences_tenant_select" ON "sequences" AS PERMISSIVE FOR SELECT TO public USING (("sequences"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sequences_tenant_insert" ON "sequences" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("sequences"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sequences_tenant_update" ON "sequences" AS PERMISSIVE FOR UPDATE TO public USING (("sequences"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("sequences"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "sequences_tenant_delete" ON "sequences" AS PERMISSIVE FOR DELETE TO public USING (("sequences"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "setting_overrides_tenant_select" ON "setting_overrides" AS PERMISSIVE FOR SELECT TO public USING (("setting_overrides"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "setting_overrides_tenant_insert" ON "setting_overrides" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("setting_overrides"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "setting_overrides_tenant_update" ON "setting_overrides" AS PERMISSIVE FOR UPDATE TO public USING (("setting_overrides"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("setting_overrides"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "setting_overrides_tenant_delete" ON "setting_overrides" AS PERMISSIVE FOR DELETE TO public USING (("setting_overrides"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_client_quotas_tenant_select" ON "api_client_quotas" AS PERMISSIVE FOR SELECT TO public USING (("api_client_quotas"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_client_quotas_tenant_insert" ON "api_client_quotas" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("api_client_quotas"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_client_quotas_tenant_update" ON "api_client_quotas" AS PERMISSIVE FOR UPDATE TO public USING (("api_client_quotas"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("api_client_quotas"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_client_quotas_tenant_delete" ON "api_client_quotas" AS PERMISSIVE FOR DELETE TO public USING (("api_client_quotas"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_usage_tenant_select" ON "api_usage" AS PERMISSIVE FOR SELECT TO public USING (("api_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_usage_tenant_insert" ON "api_usage" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("api_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_usage_tenant_update" ON "api_usage" AS PERMISSIVE FOR UPDATE TO public USING (("api_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("api_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "api_usage_tenant_delete" ON "api_usage" AS PERMISSIVE FOR DELETE TO public USING (("api_usage"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "incoming_webhook_senders_tenant_select" ON "incoming_webhook_senders" AS PERMISSIVE FOR SELECT TO public USING (("incoming_webhook_senders"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "incoming_webhook_senders_tenant_insert" ON "incoming_webhook_senders" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("incoming_webhook_senders"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "incoming_webhook_senders_tenant_update" ON "incoming_webhook_senders" AS PERMISSIVE FOR UPDATE TO public USING (("incoming_webhook_senders"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("incoming_webhook_senders"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "incoming_webhook_senders_tenant_delete" ON "incoming_webhook_senders" AS PERMISSIVE FOR DELETE TO public USING (("incoming_webhook_senders"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));