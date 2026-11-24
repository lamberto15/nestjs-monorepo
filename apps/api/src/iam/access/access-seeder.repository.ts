import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { type Tenant, tenants } from '../../core/tenancy/tenancy.tables.js';
import { memberships, users } from '../auth/auth.tables.js';
import { userRoles } from './access.tables.js';

/** The first start's queries: the first tenant, the first administrator and their grant. */
@Injectable()
export class AccessSeederRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** Every process of a first start seeds at once: this lock lets one through at a time. */
  async lockSeed() {
    await this.db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('access:seed', 0))`,
    );
  }

  /** Whether any account exists: one row read, not a count. */
  async anyUser() {
    const rows = await this.db.select({ id: users.id }).from(users).limit(1);
    return rows.length > 0;
  }

  async oldestTenant(): Promise<Tenant | undefined> {
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .orderBy(asc(tenants.createdAt))
      .limit(1);
    return tenant;
  }

  async tenantBySlug(slug: string): Promise<Tenant | undefined> {
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug));
    return tenant;
  }

  async insertUser(values: typeof users.$inferInsert) {
    const [user] = await this.db
      .insert(users)
      .values(values)
      .returning({ id: users.id });
    return user!.id;
  }

  async insertMembership(tenantId: string, userId: string) {
    await this.db.insert(memberships).values({ tenantId, userId });
  }

  async insertGrant(userId: string, roleId: string) {
    await this.db.insert(userRoles).values({ userId, roleId });
  }

  /** Flags the verified account on this address for onboarding, unless already; the ids flagged. */
  async requireEmailOnboarding(email: string) {
    const rows = await this.db
      .update(users)
      .set({ onboardingEmail: true })
      .where(
        and(
          eq(users.email, email),
          eq(users.emailVerified, true),
          eq(users.onboardingEmail, false),
        ),
      )
      .returning({ id: users.id });
    return rows.map((row) => row.id);
  }
}
