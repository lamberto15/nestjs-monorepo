CREATE TABLE "quota_locks" (
	"key" text,
	"tenant_id" uuid,
	CONSTRAINT "quota_locks_pkey" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
ALTER TABLE "quota_locks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quota_locks" ADD CONSTRAINT "quota_locks_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "quota_locks_tenant_select" ON "quota_locks" AS PERMISSIVE FOR SELECT TO public USING (("quota_locks"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "quota_locks_tenant_insert" ON "quota_locks" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("quota_locks"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "quota_locks_tenant_update" ON "quota_locks" AS PERMISSIVE FOR UPDATE TO public USING (("quota_locks"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid))) WITH CHECK (("quota_locks"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "quota_locks_tenant_delete" ON "quota_locks" AS PERMISSIVE FOR DELETE TO public USING (("quota_locks"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));