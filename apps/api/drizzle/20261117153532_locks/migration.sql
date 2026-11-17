CREATE SEQUENCE "public"."locks_fencing_token_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "locks" (
	"key" text PRIMARY KEY,
	"owner" text,
	"fencing_token" bigint NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL
);
