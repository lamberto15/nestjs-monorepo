CREATE TABLE "test_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL UNIQUE,
	"parent_id" uuid,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_items" ADD CONSTRAINT "test_items_parent_id_test_items_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "test_items"("id");