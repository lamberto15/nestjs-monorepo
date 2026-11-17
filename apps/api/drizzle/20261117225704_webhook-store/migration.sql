-- @nestjs/webhooks: PostgresWebhookStore's schema "nest_webhooks", from version 0 to 1.
-- Run it in one transaction.

CREATE SCHEMA IF NOT EXISTS "nest_webhooks";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nest_webhooks".migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "nest_webhooks".endpoints (
  id text PRIMARY KEY,
  tenant text,
  url text NOT NULL,
  event_types jsonb NOT NULL,
  description text,
  enabled boolean NOT NULL,
  disabled_reason text,
  failing_since bigint,
  secrets jsonb NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nest_webhooks".messages (
  id text PRIMARY KEY,
  type text NOT NULL,
  tenant text,
  body text NOT NULL,
  created_at bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nest_webhooks".deliveries (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES "nest_webhooks".messages (id),
  endpoint_id text NOT NULL,
  tenant text,
  type text NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL,
  next_attempt_at bigint,
  last_attempt_at bigint,
  last_status_code integer,
  last_error text,
  failure_reason text,
  created_at bigint NOT NULL,
  completed_at bigint,
  lease_owner text,
  lease_until bigint,
  CONSTRAINT deliveries_message_endpoint UNIQUE (message_id, endpoint_id)
);
--> statement-breakpoint
CREATE TABLE "nest_webhooks".delivery_attempts (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES "nest_webhooks".deliveries (id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  at bigint NOT NULL,
  duration_ms integer NOT NULL,
  status_code integer,
  response text,
  error text
);
--> statement-breakpoint
CREATE INDEX endpoints_tenant ON "nest_webhooks".endpoints (tenant, created_at, id);
--> statement-breakpoint
CREATE INDEX deliveries_due ON "nest_webhooks".deliveries (next_attempt_at, created_at, id) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX deliveries_created ON "nest_webhooks".deliveries (created_at, id);
--> statement-breakpoint
CREATE INDEX deliveries_endpoint ON "nest_webhooks".deliveries (endpoint_id, created_at, id);
--> statement-breakpoint
CREATE INDEX deliveries_tenant ON "nest_webhooks".deliveries (tenant, created_at, id);
--> statement-breakpoint
CREATE INDEX deliveries_failed ON "nest_webhooks".deliveries (created_at, id) WHERE status = 'failed';
--> statement-breakpoint
CREATE INDEX deliveries_finished ON "nest_webhooks".deliveries (completed_at) WHERE status <> 'pending';
--> statement-breakpoint
CREATE INDEX delivery_attempts_delivery ON "nest_webhooks".delivery_attempts (delivery_id, at, attempt);
--> statement-breakpoint
INSERT INTO "nest_webhooks".migrations (version, name) VALUES (1, 'initial');
