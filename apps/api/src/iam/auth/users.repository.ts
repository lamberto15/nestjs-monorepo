import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { memberships, users } from './auth.tables.js';
import type { UserPrincipal } from './principal.js';

type Row = typeof users.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The queries of `users` and `memberships` that signing in needs. Password
 * hashes leave it only for verification (`findActiveByEmail`). Both tables
 * are global: no tenant scope is needed to read them.
 */
@Injectable()
export class UsersRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /**
   * The account as a principal acting in no tenant, or `null` when the
   * account is gone or deactivated. `inTenant()` for one that acts in one.
   */
  async findActive(id: string): Promise<UserPrincipal | null> {
    if (!UUID.test(id)) {
      return null;
    }
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row?.active ? toPrincipal(row) : null;
  }

  /**
   * The signed-in principal in `tenantId` (a session's, a token's), or
   * `null` when the account is gone or deactivated, or when it acts in a
   * tenant it no longer may (the membership or the tenant deactivated):
   * that session or token stops, and a new sign-in starts in a tenant the
   * user still belongs to. Without a tenant (an account with no membership
   * yet), the principal has none.
   */
  async inTenant(
    id: string,
    tenantId: string | null | undefined,
  ): Promise<UserPrincipal | null> {
    const user = await this.findActive(id);
    if (!user || !tenantId) {
      return user;
    }
    return (await this.isMember(id, tenantId)) ? { ...user, tenantId } : null;
  }

  /** Whether the user's membership in the tenant, and the tenant, are active. */
  async isMember(userId: string, tenantId: string): Promise<boolean> {
    if (!UUID.test(userId) || !UUID.test(tenantId)) {
      return false;
    }
    const [row] = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.tenantId, tenantId),
          eq(memberships.active, true),
          eq(tenants.active, true),
        ),
      );
    return !!row;
  }

  /**
   * The tenants the user may act in (active memberships of active
   * tenants), the last chosen first, then the oldest: what a new sign-in
   * starts in.
   */
  memberships(userId: string) {
    return this.db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        selectedAt: memberships.selectedAt,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.active, true),
          eq(tenants.active, true),
        ),
      )
      .orderBy(
        // The builder's desc() has no NULLS LAST outside an index.
        sql`${memberships.selectedAt} desc nulls last`,
        asc(memberships.createdAt),
        asc(tenants.id),
      );
  }

  /** The tenant a new sign-in starts in: the last chosen, else the oldest membership; null without one. */
  async defaultTenant(userId: string): Promise<string | null> {
    if (!UUID.test(userId)) {
      return null; // not an account's id (the stores' contract tests use others)
    }
    const [first] = await this.memberships(userId);
    return first?.id ?? null;
  }

  /** An active account by its address, with what the sign-in flows need. */
  async findActiveByEmail(email: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));
    return row?.active
      ? { user: toPrincipal(row), passwordHash: row.passwordHash }
      : null;
  }

  /**
   * The same password, hashed anew (the sign-in's rehash after the cost
   * settings changed): the hash only, and only while it is still the one
   * that was verified (a password changed meanwhile stays changed).
   */
  async updatePasswordHash(id: string, previous: string, passwordHash: string) {
    await this.db
      .update(users)
      .set({ passwordHash })
      .where(and(eq(users.id, id), eq(users.passwordHash, previous)));
  }
}

/** One spelling per address: trimmed, NFC, lower case. */
export const normalizeEmail = (email: string) =>
  email.trim().normalize('NFC').toLowerCase();

const toPrincipal = (row: Row): UserPrincipal => ({
  kind: 'user',
  id: row.id,
  email: row.email,
  name: row.name,
  emailVerified: row.emailVerified,
  locale: row.locale,
  timezone: row.timezone,
  tenantId: null,
  ...(row.onboardingEmail || row.onboardingPassword
    ? {
        onboarding: {
          email: row.onboardingEmail,
          password: row.onboardingPassword,
        },
      }
    : {}),
});
