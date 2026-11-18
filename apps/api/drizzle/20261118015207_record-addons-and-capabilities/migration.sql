CREATE TABLE "auth_policies" (
	"require_mfa" boolean DEFAULT false NOT NULL,
	"password_min_length" integer,
	"password_history" integer,
	"session_idle_minutes" integer,
	"session_max_hours" integer,
	"allow_break_glass" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid PRIMARY KEY
);
--> statement-breakpoint
ALTER TABLE "auth_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_policy_platform" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"require_mfa" boolean DEFAULT false NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_policy_platform_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "auth_policy_units" (
	"unit_id" uuid,
	"require_mfa" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "auth_policy_units_pkey" PRIMARY KEY("tenant_id","unit_id")
);
--> statement-breakpoint
ALTER TABLE "auth_policy_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "account_deletions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"requested_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"scheduled_for" timestamp(3) with time zone NOT NULL,
	"cancelled_at" timestamp(3) with time zone,
	"started_at" timestamp(3) with time zone,
	"completed_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"accepted_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"withdrawn_at" timestamp(3) with time zone,
	"withdrawal_ip" text
);
--> statement-breakpoint
CREATE TABLE "acknowledgment_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acknowledgment_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "record_acknowledgments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"recipient" text NOT NULL,
	"requested_by" text NOT NULL,
	"due_at" timestamp(3) with time zone,
	"reminders" integer DEFAULT 0 NOT NULL,
	"last_reminded_at" timestamp(3) with time zone,
	"acknowledged_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_acknowledgments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"source" text NOT NULL,
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"task" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"request_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"stage" integer NOT NULL,
	"approver_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"comment" text,
	"decided_at" timestamp(3) with time zone,
	"decided_by" uuid,
	"decided_by_name" text,
	"on_behalf_of" uuid,
	"escalated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_delegations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"starts_at" timestamp(3) with time zone NOT NULL,
	"ends_at" timestamp(3) with time zone NOT NULL,
	"subject" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_delegations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"request_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"actor_name" text NOT NULL,
	"round" integer NOT NULL,
	"stage" integer,
	"details" jsonb,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb,
	"changed_by" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requester" text NOT NULL,
	"requester_name" text NOT NULL,
	"title" text NOT NULL,
	"link" text,
	"payload" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"policy_version" integer NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"current_stage" integer DEFAULT 0 NOT NULL,
	"stage_started_at" timestamp(3) with time zone,
	"stage_outcome" text,
	"due_at" timestamp(3) with time zone,
	"comment" text,
	"outcome_reason" text,
	"ended_at" timestamp(3) with time zone,
	"fingerprint" text,
	"outcome_applied_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "approval_requests_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attachment_uploads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"resumable" boolean DEFAULT false NOT NULL,
	"received" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"completing_at" timestamp(3) with time zone,
	"completed_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attachment_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"attachment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"note" text,
	"uploaded_at" timestamp(3) with time zone NOT NULL,
	"replaced_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "attachment_versions_attachment_version_key" UNIQUE("tenant_id","attachment_id","version")
);
--> statement-breakpoint
ALTER TABLE "attachment_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"fields" text[],
	"scan_status" text DEFAULT 'clean' NOT NULL,
	"rendition_status" text,
	"renditions" jsonb DEFAULT '{}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"revision_note" text,
	"versioned_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "attachments_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attachment_texts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"attachment_id" uuid NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("text"::text, ''))) STORED,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment_texts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_avatars" (
	"user_id" uuid PRIMARY KEY,
	"key" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"trigger" text NOT NULL,
	"field" text,
	"condition" text,
	"actions" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"owner" text,
	"activated_at" timestamp(3) with time zone,
	"disabled_reason" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp(3) with time zone,
	"last_status" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "automation_rules_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "automation_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"rule_id" uuid NOT NULL,
	"rule_version" integer NOT NULL,
	"record_id" uuid NOT NULL,
	"status" text NOT NULL,
	"actions" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "branding_logos" (
	"variant" text,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "branding_logos_pkey" PRIMARY KEY("tenant_id","variant")
);
--> statement-breakpoint
ALTER TABLE "branding_logos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"mentions" text[] DEFAULT '{}'::text[] NOT NULL,
	"edited_at" timestamp(3) with time zone,
	"parent_id" uuid,
	"resolved_at" timestamp(3) with time zone,
	"resolved_by" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "comments_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"options" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"default_value" jsonb,
	"validation" jsonb,
	"position" integer DEFAULT 0 NOT NULL,
	"filterable" boolean DEFAULT false NOT NULL,
	"sortable" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"values" jsonb NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_field_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "data_quality_findings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"check" text NOT NULL,
	"field" text NOT NULL,
	"severity" text NOT NULL,
	"detail" jsonb,
	"checked_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp(3) with time zone,
	"dismissed_by" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_quality_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "data_quality_scans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"scanned" integer DEFAULT 0 NOT NULL,
	"findings" integer,
	"started_by" text NOT NULL,
	"finished_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_quality_scans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"importer" text NOT NULL,
	"name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"source" text NOT NULL,
	"template" text NOT NULL,
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"timezone" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"file_key" text,
	"file_name" text,
	"size" integer,
	"fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"run_token" uuid,
	"attachment_id" uuid,
	"error" text,
	"issued_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "favorites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"target" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "favorites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "form_public_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"form_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"revoked_at" timestamp(3) with time zone,
	"revoked_by" text,
	"max_submissions" integer NOT NULL,
	"submissions" integer DEFAULT 0 NOT NULL,
	"last_submitted_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_public_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"form_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"submitted_by" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"answers" jsonb NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "form_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"form_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"published_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "form_versions_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "form_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"draft" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"published_version" integer,
	"published_revision" integer,
	"key_types" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "forms_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "forms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recent_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner" text NOT NULL,
	"subject" text NOT NULL,
	"record_id" text NOT NULL,
	"label" text NOT NULL,
	"viewed_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recent_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"exporter" text NOT NULL,
	"format" text NOT NULL,
	"filters" jsonb DEFAULT '{}' NOT NULL,
	"sort" text,
	"timezone" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"recipients" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp(3) with time zone,
	"last_transfer_id" text,
	"last_status" text,
	"next_run_at" timestamp(3) with time zone NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changes" jsonb,
	"restored_from" integer,
	"changed_by" text NOT NULL,
	"changed_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "record_shares" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"record_id" uuid NOT NULL,
	"fields" jsonb NOT NULL,
	"files" boolean DEFAULT false NOT NULL,
	"token_hash" text NOT NULL,
	"recipient_email" text,
	"code_hash" text,
	"code_expires_at" timestamp(3) with time zone,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"revoked_at" timestamp(3) with time zone,
	"revoked_by" text,
	"views" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "record_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "record_tags" (
	"tag_id" uuid,
	"subject" text NOT NULL,
	"record_id" uuid,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "record_tags_pkey" PRIMARY KEY("tag_id","record_id")
);
--> statement-breakpoint
ALTER TABLE "record_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"description" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "tags_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "record_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"name" text NOT NULL,
	"visibility" text NOT NULL,
	"owner" text NOT NULL,
	"unit_id" uuid,
	"scope" text NOT NULL,
	"values" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "record_templates_unit_check" CHECK (("visibility" = 'unit') = ("unit_id" is not null)),
	CONSTRAINT "record_templates_visibility_check" CHECK ("visibility" in ('private', 'unit', 'tenant'))
);
--> statement-breakpoint
ALTER TABLE "record_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subject" text NOT NULL,
	"name" text NOT NULL,
	"visibility" text NOT NULL,
	"owner" text NOT NULL,
	"unit_id" uuid,
	"scope" text NOT NULL,
	"query" jsonb DEFAULT '{}' NOT NULL,
	"columns" jsonb,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "saved_views_unit_check" CHECK (("visibility" = 'unit') = ("unit_id" is not null)),
	CONSTRAINT "saved_views_visibility_check" CHECK ("visibility" in ('private', 'unit', 'tenant'))
);
--> statement-breakpoint
ALTER TABLE "saved_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_client_scopes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"client_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_client_scopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "account_deletions_user_id_idx" ON "account_deletions" ("user_id");--> statement-breakpoint
CREATE INDEX "account_deletions_scheduled_for_idx" ON "account_deletions" ("scheduled_for");--> statement-breakpoint
CREATE INDEX "consents_user_kind_accepted_at_idx" ON "consents" ("user_id","kind","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "acknowledgment_versions_record_idx" ON "acknowledgment_versions" ("tenant_id","subject","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "record_acknowledgments_version_recipient_idx" ON "record_acknowledgments" ("tenant_id","subject","record_id","version","recipient");--> statement-breakpoint
CREATE INDEX "record_acknowledgments_recipient_idx" ON "record_acknowledgments" ("recipient","acknowledged_at");--> statement-breakpoint
CREATE INDEX "ai_runs_requested_by_idx" ON "ai_runs" ("requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_pending_idx" ON "ai_runs" ("tenant_id","source","record_id","task","requested_by") WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "approval_assignments_unique_idx" ON "approval_assignments" ("tenant_id","request_id","round","stage","approver_id");--> statement-breakpoint
CREATE INDEX "approval_assignments_approver_idx" ON "approval_assignments" ("approver_id","status");--> statement-breakpoint
CREATE INDEX "approval_assignments_decided_by_idx" ON "approval_assignments" ("decided_by");--> statement-breakpoint
CREATE INDEX "approval_delegations_from_idx" ON "approval_delegations" ("from_user_id");--> statement-breakpoint
CREATE INDEX "approval_delegations_to_idx" ON "approval_delegations" ("to_user_id","ends_at");--> statement-breakpoint
CREATE INDEX "approval_events_request_idx" ON "approval_events" ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_policies_version_idx" ON "approval_policies" ("tenant_id","key","version");--> statement-breakpoint
CREATE INDEX "approval_requests_record_idx" ON "approval_requests" ("subject","record_id");--> statement-breakpoint
CREATE INDEX "approval_requests_requester_idx" ON "approval_requests" ("requester");--> statement-breakpoint
CREATE INDEX "approval_requests_status_idx" ON "approval_requests" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_open_idx" ON "approval_requests" ("tenant_id","subject","record_id","action") WHERE status in ('pending', 'changes_requested');--> statement-breakpoint
CREATE INDEX "attachment_uploads_expires_idx" ON "attachment_uploads" ("expires_at");--> statement-breakpoint
CREATE INDEX "attachment_uploads_uploaded_by_idx" ON "attachment_uploads" ("uploaded_by");--> statement-breakpoint
CREATE INDEX "attachments_record_idx" ON "attachments" ("subject","record_id");--> statement-breakpoint
CREATE INDEX "attachments_uploaded_by_idx" ON "attachments" ("uploaded_by");--> statement-breakpoint
CREATE INDEX "attachments_pending_idx" ON "attachments" ("created_at") WHERE "scan_status" = 'pending';--> statement-breakpoint
CREATE INDEX "attachments_rendition_pending_idx" ON "attachments" ("updated_at") WHERE "rendition_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_texts_attachment_idx" ON "attachment_texts" ("tenant_id","attachment_id");--> statement-breakpoint
CREATE INDEX "attachment_texts_search_idx" ON "attachment_texts" USING gin ("search");--> statement-breakpoint
CREATE INDEX "automation_rules_active_idx" ON "automation_rules" ("tenant_id","subject") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "automation_runs_rule_idx" ON "automation_runs" ("tenant_id","rule_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_record_idx" ON "comments" ("subject","record_id","id");--> statement-breakpoint
CREATE INDEX "comments_author_idx" ON "comments" ("author");--> statement-breakpoint
CREATE INDEX "comments_mentions_idx" ON "comments" USING gin ("mentions");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_definitions_subject_key_idx" ON "custom_field_definitions" ("tenant_id","subject","key");--> statement-breakpoint
CREATE INDEX "custom_field_definitions_subject_position_idx" ON "custom_field_definitions" ("tenant_id","subject","position");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_record_idx" ON "custom_field_values" ("tenant_id","subject","record_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_values_idx" ON "custom_field_values" USING gin ("values");--> statement-breakpoint
CREATE UNIQUE INDEX "data_quality_findings_key_idx" ON "data_quality_findings" ("tenant_id","subject","record_id","check","field");--> statement-breakpoint
CREATE INDEX "data_quality_scans_tenant_idx" ON "data_quality_scans" ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_mappings_name_idx" ON "import_mappings" ("tenant_id","importer",lower("name"));--> statement-breakpoint
CREATE INDEX "documents_record_idx" ON "documents" ("subject","record_id");--> statement-breakpoint
CREATE INDEX "documents_requested_by_idx" ON "documents" ("requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_pending_idx" ON "documents" ("tenant_id","source","record_id","requested_by","locale") WHERE "status" in ('queued', 'rendering');--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_owner_target_idx" ON "favorites" ("tenant_id","owner","kind","subject","target");--> statement-breakpoint
CREATE INDEX "favorites_owner_position_idx" ON "favorites" ("owner","position");--> statement-breakpoint
CREATE UNIQUE INDEX "form_public_links_token_idx" ON "form_public_links" ("tenant_id","token_hash");--> statement-breakpoint
CREATE INDEX "form_public_links_form_idx" ON "form_public_links" ("tenant_id","form_id");--> statement-breakpoint
CREATE INDEX "form_submissions_form_idx" ON "form_submissions" ("tenant_id","form_id","id");--> statement-breakpoint
CREATE INDEX "form_submissions_submitted_by_idx" ON "form_submissions" ("tenant_id","submitted_by","form_id");--> statement-breakpoint
CREATE INDEX "form_submissions_version_idx" ON "form_submissions" ("tenant_id","version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_form_version_idx" ON "form_versions" ("tenant_id","form_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_slug_idx" ON "forms" ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "recent_records_owner_record_idx" ON "recent_records" ("tenant_id","owner","subject","record_id");--> statement-breakpoint
CREATE INDEX "recent_records_owner_viewed_at_idx" ON "recent_records" ("owner","viewed_at");--> statement-breakpoint
CREATE INDEX "recent_records_viewed_at_idx" ON "recent_records" ("viewed_at");--> statement-breakpoint
CREATE INDEX "report_schedules_owner_idx" ON "report_schedules" ("tenant_id","owner","id");--> statement-breakpoint
CREATE INDEX "report_schedules_next_run_at_idx" ON "report_schedules" ("tenant_id","next_run_at") WHERE "active";--> statement-breakpoint
CREATE UNIQUE INDEX "revisions_record_number_uq" ON "revisions" ("tenant_id","subject","record_id","number");--> statement-breakpoint
CREATE INDEX "revisions_changed_by_idx" ON "revisions" ("changed_by");--> statement-breakpoint
CREATE INDEX "revisions_changed_at_idx" ON "revisions" ("changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "record_shares_token_idx" ON "record_shares" ("tenant_id","token_hash");--> statement-breakpoint
CREATE INDEX "record_shares_record_idx" ON "record_shares" ("tenant_id","subject","record_id");--> statement-breakpoint
CREATE INDEX "record_tags_record_idx" ON "record_tags" ("subject","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_subject_name_idx" ON "tags" ("tenant_id","subject",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "record_templates_name_idx" ON "record_templates" ("tenant_id","subject","scope",lower("name"));--> statement-breakpoint
CREATE INDEX "record_templates_owner_idx" ON "record_templates" ("owner","subject");--> statement-breakpoint
CREATE INDEX "record_templates_unit_idx" ON "record_templates" ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_name_idx" ON "saved_views" ("tenant_id","subject","scope",lower("name"));--> statement-breakpoint
CREATE INDEX "saved_views_owner_idx" ON "saved_views" ("owner","subject");--> statement-breakpoint
CREATE INDEX "saved_views_unit_idx" ON "saved_views" ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_client_scopes_client_idx" ON "webhook_client_scopes" ("tenant_id","client_id");--> statement-breakpoint
ALTER TABLE "auth_policies" ADD CONSTRAINT "auth_policies_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_policy_units" ADD CONSTRAINT "auth_policy_units_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_policy_units" ADD CONSTRAINT "auth_policy_units_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "organizational_units"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "acknowledgment_versions" ADD CONSTRAINT "acknowledgment_versions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_acknowledgments" ADD CONSTRAINT "record_acknowledgments_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "approval_requests"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "approval_requests"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "attachment_uploads" ADD CONSTRAINT "attachment_uploads_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "attachment_versions" ADD CONSTRAINT "attachment_versions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "attachment_versions" ADD CONSTRAINT "attachment_versions_attachment_fk" FOREIGN KEY ("tenant_id","attachment_id") REFERENCES "attachments"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "attachment_texts" ADD CONSTRAINT "attachment_texts_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "attachment_texts" ADD CONSTRAINT "attachment_texts_attachment_fk" FOREIGN KEY ("tenant_id","attachment_id") REFERENCES "attachments"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "automation_rules"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "branding_logos" ADD CONSTRAINT "branding_logos_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "comments"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "data_quality_findings_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "data_quality_scans" ADD CONSTRAINT "data_quality_scans_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "form_public_links" ADD CONSTRAINT "form_public_links_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "form_public_links" ADD CONSTRAINT "form_public_links_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "forms"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "forms"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "form_versions"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "forms"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "recent_records" ADD CONSTRAINT "recent_records_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_shares" ADD CONSTRAINT "record_shares_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_tags" ADD CONSTRAINT "record_tags_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_tags" ADD CONSTRAINT "record_tags_tag_fk" FOREIGN KEY ("tenant_id","tag_id") REFERENCES "tags"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_templates" ADD CONSTRAINT "record_templates_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "record_templates" ADD CONSTRAINT "record_templates_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "organizational_units"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "organizational_units"("tenant_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "webhook_client_scopes" ADD CONSTRAINT "webhook_client_scopes_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webhook_client_scopes" ADD CONSTRAINT "webhook_client_scopes_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "api_clients"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "auth_policies_global" ON "auth_policies" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "auth_policy_units_tenant_select" ON "auth_policy_units" AS PERMISSIVE FOR SELECT TO public USING (("auth_policy_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "auth_policy_units_tenant_insert" ON "auth_policy_units" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("auth_policy_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "auth_policy_units_tenant_update" ON "auth_policy_units" AS PERMISSIVE FOR UPDATE TO public USING (("auth_policy_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("auth_policy_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "auth_policy_units_tenant_delete" ON "auth_policy_units" AS PERMISSIVE FOR DELETE TO public USING (("auth_policy_units"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "acknowledgment_versions_tenant_select" ON "acknowledgment_versions" AS PERMISSIVE FOR SELECT TO public USING (("acknowledgment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "acknowledgment_versions_tenant_insert" ON "acknowledgment_versions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("acknowledgment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "acknowledgment_versions_tenant_update" ON "acknowledgment_versions" AS PERMISSIVE FOR UPDATE TO public USING (("acknowledgment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("acknowledgment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "acknowledgment_versions_tenant_delete" ON "acknowledgment_versions" AS PERMISSIVE FOR DELETE TO public USING (("acknowledgment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_acknowledgments_tenant_select" ON "record_acknowledgments" AS PERMISSIVE FOR SELECT TO public USING (("record_acknowledgments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_acknowledgments_tenant_insert" ON "record_acknowledgments" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("record_acknowledgments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_acknowledgments_tenant_update" ON "record_acknowledgments" AS PERMISSIVE FOR UPDATE TO public USING (("record_acknowledgments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("record_acknowledgments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_acknowledgments_tenant_delete" ON "record_acknowledgments" AS PERMISSIVE FOR DELETE TO public USING (("record_acknowledgments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "ai_runs_tenant_select" ON "ai_runs" AS PERMISSIVE FOR SELECT TO public USING (("ai_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "ai_runs_tenant_insert" ON "ai_runs" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("ai_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "ai_runs_tenant_update" ON "ai_runs" AS PERMISSIVE FOR UPDATE TO public USING (("ai_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("ai_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "ai_runs_tenant_delete" ON "ai_runs" AS PERMISSIVE FOR DELETE TO public USING (("ai_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_assignments_tenant_select" ON "approval_assignments" AS PERMISSIVE FOR SELECT TO public USING (("approval_assignments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_assignments_tenant_insert" ON "approval_assignments" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("approval_assignments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_assignments_tenant_update" ON "approval_assignments" AS PERMISSIVE FOR UPDATE TO public USING (("approval_assignments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("approval_assignments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_assignments_tenant_delete" ON "approval_assignments" AS PERMISSIVE FOR DELETE TO public USING (("approval_assignments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_delegations_tenant_select" ON "approval_delegations" AS PERMISSIVE FOR SELECT TO public USING (("approval_delegations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_delegations_tenant_insert" ON "approval_delegations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("approval_delegations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_delegations_tenant_update" ON "approval_delegations" AS PERMISSIVE FOR UPDATE TO public USING (("approval_delegations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("approval_delegations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_delegations_tenant_delete" ON "approval_delegations" AS PERMISSIVE FOR DELETE TO public USING (("approval_delegations"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_events_tenant_select" ON "approval_events" AS PERMISSIVE FOR SELECT TO public USING (("approval_events"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_events_tenant_insert" ON "approval_events" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("approval_events"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_events_tenant_update" ON "approval_events" AS PERMISSIVE FOR UPDATE TO public USING (("approval_events"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("approval_events"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_events_tenant_delete" ON "approval_events" AS PERMISSIVE FOR DELETE TO public USING (("approval_events"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_policies_tenant_select" ON "approval_policies" AS PERMISSIVE FOR SELECT TO public USING (("approval_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_policies_tenant_insert" ON "approval_policies" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("approval_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_policies_tenant_update" ON "approval_policies" AS PERMISSIVE FOR UPDATE TO public USING (("approval_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("approval_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_policies_tenant_delete" ON "approval_policies" AS PERMISSIVE FOR DELETE TO public USING (("approval_policies"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_requests_tenant_select" ON "approval_requests" AS PERMISSIVE FOR SELECT TO public USING (("approval_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_requests_tenant_insert" ON "approval_requests" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("approval_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_requests_tenant_update" ON "approval_requests" AS PERMISSIVE FOR UPDATE TO public USING (("approval_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("approval_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "approval_requests_tenant_delete" ON "approval_requests" AS PERMISSIVE FOR DELETE TO public USING (("approval_requests"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_uploads_tenant_select" ON "attachment_uploads" AS PERMISSIVE FOR SELECT TO public USING (("attachment_uploads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_uploads_tenant_insert" ON "attachment_uploads" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("attachment_uploads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_uploads_tenant_update" ON "attachment_uploads" AS PERMISSIVE FOR UPDATE TO public USING (("attachment_uploads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("attachment_uploads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_uploads_tenant_delete" ON "attachment_uploads" AS PERMISSIVE FOR DELETE TO public USING (("attachment_uploads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_versions_tenant_select" ON "attachment_versions" AS PERMISSIVE FOR SELECT TO public USING (("attachment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_versions_tenant_insert" ON "attachment_versions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("attachment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_versions_tenant_update" ON "attachment_versions" AS PERMISSIVE FOR UPDATE TO public USING (("attachment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("attachment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_versions_tenant_delete" ON "attachment_versions" AS PERMISSIVE FOR DELETE TO public USING (("attachment_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachments_tenant_select" ON "attachments" AS PERMISSIVE FOR SELECT TO public USING (("attachments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachments_tenant_insert" ON "attachments" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("attachments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachments_tenant_update" ON "attachments" AS PERMISSIVE FOR UPDATE TO public USING (("attachments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("attachments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachments_tenant_delete" ON "attachments" AS PERMISSIVE FOR DELETE TO public USING (("attachments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_texts_tenant_select" ON "attachment_texts" AS PERMISSIVE FOR SELECT TO public USING (("attachment_texts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_texts_tenant_insert" ON "attachment_texts" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("attachment_texts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_texts_tenant_update" ON "attachment_texts" AS PERMISSIVE FOR UPDATE TO public USING (("attachment_texts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("attachment_texts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "attachment_texts_tenant_delete" ON "attachment_texts" AS PERMISSIVE FOR DELETE TO public USING (("attachment_texts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "automation_rules_tenant_select" ON "automation_rules" AS PERMISSIVE FOR SELECT TO public USING (("automation_rules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "automation_rules_tenant_insert" ON "automation_rules" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("automation_rules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "automation_rules_tenant_update" ON "automation_rules" AS PERMISSIVE FOR UPDATE TO public USING (("automation_rules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("automation_rules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "automation_rules_tenant_delete" ON "automation_rules" AS PERMISSIVE FOR DELETE TO public USING (("automation_rules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "automation_runs_tenant_select" ON "automation_runs" AS PERMISSIVE FOR SELECT TO public USING (("automation_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "automation_runs_tenant_insert" ON "automation_runs" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("automation_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "automation_runs_tenant_update" ON "automation_runs" AS PERMISSIVE FOR UPDATE TO public USING (("automation_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("automation_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "automation_runs_tenant_delete" ON "automation_runs" AS PERMISSIVE FOR DELETE TO public USING (("automation_runs"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "branding_logos_tenant_select" ON "branding_logos" AS PERMISSIVE FOR SELECT TO public USING (("branding_logos"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "branding_logos_tenant_insert" ON "branding_logos" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("branding_logos"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "branding_logos_tenant_update" ON "branding_logos" AS PERMISSIVE FOR UPDATE TO public USING (("branding_logos"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("branding_logos"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "branding_logos_tenant_delete" ON "branding_logos" AS PERMISSIVE FOR DELETE TO public USING (("branding_logos"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "comments_tenant_select" ON "comments" AS PERMISSIVE FOR SELECT TO public USING (("comments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "comments_tenant_insert" ON "comments" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("comments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "comments_tenant_update" ON "comments" AS PERMISSIVE FOR UPDATE TO public USING (("comments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("comments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "comments_tenant_delete" ON "comments" AS PERMISSIVE FOR DELETE TO public USING (("comments"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "custom_field_definitions_tenant_select" ON "custom_field_definitions" AS PERMISSIVE FOR SELECT TO public USING (("custom_field_definitions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "custom_field_definitions_tenant_insert" ON "custom_field_definitions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("custom_field_definitions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "custom_field_definitions_tenant_update" ON "custom_field_definitions" AS PERMISSIVE FOR UPDATE TO public USING (("custom_field_definitions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("custom_field_definitions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "custom_field_definitions_tenant_delete" ON "custom_field_definitions" AS PERMISSIVE FOR DELETE TO public USING (("custom_field_definitions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "custom_field_values_tenant_select" ON "custom_field_values" AS PERMISSIVE FOR SELECT TO public USING (("custom_field_values"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "custom_field_values_tenant_insert" ON "custom_field_values" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("custom_field_values"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "custom_field_values_tenant_update" ON "custom_field_values" AS PERMISSIVE FOR UPDATE TO public USING (("custom_field_values"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("custom_field_values"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "custom_field_values_tenant_delete" ON "custom_field_values" AS PERMISSIVE FOR DELETE TO public USING (("custom_field_values"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_findings_tenant_select" ON "data_quality_findings" AS PERMISSIVE FOR SELECT TO public USING (("data_quality_findings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_findings_tenant_insert" ON "data_quality_findings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("data_quality_findings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_findings_tenant_update" ON "data_quality_findings" AS PERMISSIVE FOR UPDATE TO public USING (("data_quality_findings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("data_quality_findings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_findings_tenant_delete" ON "data_quality_findings" AS PERMISSIVE FOR DELETE TO public USING (("data_quality_findings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_scans_tenant_select" ON "data_quality_scans" AS PERMISSIVE FOR SELECT TO public USING (("data_quality_scans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_scans_tenant_insert" ON "data_quality_scans" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("data_quality_scans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_scans_tenant_update" ON "data_quality_scans" AS PERMISSIVE FOR UPDATE TO public USING (("data_quality_scans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("data_quality_scans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "data_quality_scans_tenant_delete" ON "data_quality_scans" AS PERMISSIVE FOR DELETE TO public USING (("data_quality_scans"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_select" ON "import_mappings" AS PERMISSIVE FOR SELECT TO public USING (("import_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_insert" ON "import_mappings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("import_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_update" ON "import_mappings" AS PERMISSIVE FOR UPDATE TO public USING (("import_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("import_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "import_mappings_tenant_delete" ON "import_mappings" AS PERMISSIVE FOR DELETE TO public USING (("import_mappings"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "documents_tenant_select" ON "documents" AS PERMISSIVE FOR SELECT TO public USING (("documents"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "documents_tenant_insert" ON "documents" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("documents"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "documents_tenant_update" ON "documents" AS PERMISSIVE FOR UPDATE TO public USING (("documents"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("documents"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "documents_tenant_delete" ON "documents" AS PERMISSIVE FOR DELETE TO public USING (("documents"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "favorites_tenant_select" ON "favorites" AS PERMISSIVE FOR SELECT TO public USING (("favorites"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "favorites_tenant_insert" ON "favorites" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("favorites"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "favorites_tenant_update" ON "favorites" AS PERMISSIVE FOR UPDATE TO public USING (("favorites"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("favorites"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "favorites_tenant_delete" ON "favorites" AS PERMISSIVE FOR DELETE TO public USING (("favorites"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_public_links_tenant_select" ON "form_public_links" AS PERMISSIVE FOR SELECT TO public USING (("form_public_links"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_public_links_tenant_insert" ON "form_public_links" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("form_public_links"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_public_links_tenant_update" ON "form_public_links" AS PERMISSIVE FOR UPDATE TO public USING (("form_public_links"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("form_public_links"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_public_links_tenant_delete" ON "form_public_links" AS PERMISSIVE FOR DELETE TO public USING (("form_public_links"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_submissions_tenant_select" ON "form_submissions" AS PERMISSIVE FOR SELECT TO public USING (("form_submissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_submissions_tenant_insert" ON "form_submissions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("form_submissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_submissions_tenant_update" ON "form_submissions" AS PERMISSIVE FOR UPDATE TO public USING (("form_submissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("form_submissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_submissions_tenant_delete" ON "form_submissions" AS PERMISSIVE FOR DELETE TO public USING (("form_submissions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_versions_tenant_select" ON "form_versions" AS PERMISSIVE FOR SELECT TO public USING (("form_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_versions_tenant_insert" ON "form_versions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("form_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_versions_tenant_update" ON "form_versions" AS PERMISSIVE FOR UPDATE TO public USING (("form_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("form_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "form_versions_tenant_delete" ON "form_versions" AS PERMISSIVE FOR DELETE TO public USING (("form_versions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "forms_tenant_select" ON "forms" AS PERMISSIVE FOR SELECT TO public USING (("forms"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "forms_tenant_insert" ON "forms" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("forms"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "forms_tenant_update" ON "forms" AS PERMISSIVE FOR UPDATE TO public USING (("forms"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("forms"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "forms_tenant_delete" ON "forms" AS PERMISSIVE FOR DELETE TO public USING (("forms"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "recent_records_tenant_select" ON "recent_records" AS PERMISSIVE FOR SELECT TO public USING (("recent_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "recent_records_tenant_insert" ON "recent_records" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("recent_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "recent_records_tenant_update" ON "recent_records" AS PERMISSIVE FOR UPDATE TO public USING (("recent_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("recent_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "recent_records_tenant_delete" ON "recent_records" AS PERMISSIVE FOR DELETE TO public USING (("recent_records"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "report_schedules_tenant_select" ON "report_schedules" AS PERMISSIVE FOR SELECT TO public USING (("report_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "report_schedules_tenant_insert" ON "report_schedules" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("report_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "report_schedules_tenant_update" ON "report_schedules" AS PERMISSIVE FOR UPDATE TO public USING (("report_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("report_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "report_schedules_tenant_delete" ON "report_schedules" AS PERMISSIVE FOR DELETE TO public USING (("report_schedules"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "revisions_tenant_select" ON "revisions" AS PERMISSIVE FOR SELECT TO public USING (("revisions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "revisions_tenant_insert" ON "revisions" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("revisions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "revisions_tenant_update" ON "revisions" AS PERMISSIVE FOR UPDATE TO public USING (("revisions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("revisions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "revisions_tenant_delete" ON "revisions" AS PERMISSIVE FOR DELETE TO public USING (("revisions"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_shares_tenant_select" ON "record_shares" AS PERMISSIVE FOR SELECT TO public USING (("record_shares"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_shares_tenant_insert" ON "record_shares" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("record_shares"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_shares_tenant_update" ON "record_shares" AS PERMISSIVE FOR UPDATE TO public USING (("record_shares"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("record_shares"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_shares_tenant_delete" ON "record_shares" AS PERMISSIVE FOR DELETE TO public USING (("record_shares"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_tags_tenant_select" ON "record_tags" AS PERMISSIVE FOR SELECT TO public USING (("record_tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_tags_tenant_insert" ON "record_tags" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("record_tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_tags_tenant_update" ON "record_tags" AS PERMISSIVE FOR UPDATE TO public USING (("record_tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("record_tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_tags_tenant_delete" ON "record_tags" AS PERMISSIVE FOR DELETE TO public USING (("record_tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tags_tenant_select" ON "tags" AS PERMISSIVE FOR SELECT TO public USING (("tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tags_tenant_insert" ON "tags" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tags_tenant_update" ON "tags" AS PERMISSIVE FOR UPDATE TO public USING (("tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tags_tenant_delete" ON "tags" AS PERMISSIVE FOR DELETE TO public USING (("tags"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_templates_tenant_select" ON "record_templates" AS PERMISSIVE FOR SELECT TO public USING (("record_templates"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_templates_tenant_insert" ON "record_templates" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("record_templates"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_templates_tenant_update" ON "record_templates" AS PERMISSIVE FOR UPDATE TO public USING (("record_templates"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("record_templates"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "record_templates_tenant_delete" ON "record_templates" AS PERMISSIVE FOR DELETE TO public USING (("record_templates"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "saved_views_tenant_select" ON "saved_views" AS PERMISSIVE FOR SELECT TO public USING (("saved_views"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "saved_views_tenant_insert" ON "saved_views" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("saved_views"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "saved_views_tenant_update" ON "saved_views" AS PERMISSIVE FOR UPDATE TO public USING (("saved_views"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("saved_views"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "saved_views_tenant_delete" ON "saved_views" AS PERMISSIVE FOR DELETE TO public USING (("saved_views"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "webhook_client_scopes_tenant_select" ON "webhook_client_scopes" AS PERMISSIVE FOR SELECT TO public USING (("webhook_client_scopes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "webhook_client_scopes_tenant_insert" ON "webhook_client_scopes" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("webhook_client_scopes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "webhook_client_scopes_tenant_update" ON "webhook_client_scopes" AS PERMISSIVE FOR UPDATE TO public USING (("webhook_client_scopes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("webhook_client_scopes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "webhook_client_scopes_tenant_delete" ON "webhook_client_scopes" AS PERMISSIVE FOR DELETE TO public USING (("webhook_client_scopes"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));