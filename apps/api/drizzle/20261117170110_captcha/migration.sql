CREATE TABLE "app_attest_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"key_id" text NOT NULL UNIQUE,
	"app_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
