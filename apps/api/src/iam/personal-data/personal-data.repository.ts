import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { roles, userRoles } from '../access/access.tables.js';
import { auditLog } from '../audit/audit.tables.js';
import {
  memberships,
  refreshTokens,
  sessions,
  users,
} from '../auth/auth.tables.js';
import {
  organizationalUnitMemberships,
  organizationalUnits,
} from '../organization/organization.tables.js';
import { consents } from './personal-data.tables.js';

/**
 * The queries of a person's data: what the sections export and erase, and
 * their consents, in the scope and transaction of the caller
 * (`@InjectTransaction()`; the caller says the tenant).
 */
@Injectable()
export class PersonalDataRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The tenants the person belongs to, active or not. */
  async tenantIdsOf(userId: string) {
    const rows = await this.db
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .where(eq(memberships.userId, userId));
    return rows.map((row) => row.tenantId);
  }

  async findUser(userId: string) {
    const [profile] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    return profile;
  }

  membershipsOf(userId: string) {
    return this.db
      .select({
        tenantId: memberships.tenantId,
        active: memberships.active,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .where(eq(memberships.userId, userId));
  }

  sessionsOf(userId: string) {
    return this.db
      .select({
        createdAt: sessions.createdAt,
        lastActiveAt: sessions.lastActiveAt,
        expiresAt: sessions.expiresAt,
        metadata: sessions.metadata,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId));
  }

  refreshTokensOf(userId: string) {
    return this.db
      .select({
        createdAt: refreshTokens.createdAt,
        revoked: refreshTokens.revoked,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));
  }

  /** The audit entries of `actor`, newest first, `limit` of them before the cursor. */
  auditEntriesOf(actor: string, before: string | undefined, limit: number) {
    return this.db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        details: auditLog.details,
        ip: auditLog.ip,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actor, actor),
          before ? lt(auditLog.id, before) : undefined,
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(limit);
  }

  async relabelAuditEntries(actor: string, actorLabel: string) {
    await this.db
      .update(auditLog)
      .set({ actorLabel })
      .where(eq(auditLog.actor, actor));
  }

  rolesOf(userId: string) {
    return this.db
      .select({
        id: roles.id,
        key: roles.key,
        name: roles.name,
        expiresAt: userRoles.expiresAt,
      })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId));
  }

  unitsOf(userId: string) {
    return this.db
      .select({
        id: organizationalUnits.id,
        name: organizationalUnits.name,
        role: organizationalUnitMemberships.role,
        validFrom: organizationalUnitMemberships.validFrom,
        validTo: organizationalUnitMemberships.validTo,
      })
      .from(organizationalUnitMemberships)
      .innerJoin(
        organizationalUnits,
        eq(organizationalUnits.id, organizationalUnitMemberships.unitId),
      )
      .where(eq(organizationalUnitMemberships.userId, userId));
  }

  /** Every consent of the person. */
  consentsOf(userId: string) {
    return this.db.select().from(consents).where(eq(consents.userId, userId));
  }

  /** The person's consents, latest acceptance first. */
  consentsByLatest(userId: string) {
    return this.db
      .select()
      .from(consents)
      .where(eq(consents.userId, userId))
      .orderBy(desc(consents.acceptedAt), desc(consents.id));
  }

  async insertConsent(values: {
    userId: string;
    kind: string;
    version: string;
    ip?: string;
  }) {
    const [saved] = await this.db.insert(consents).values(values).returning();
    return saved!;
  }

  /** Stamps the person's acceptances of `kind` in force as withdrawn; returns them. */
  withdrawConsents(
    userId: string,
    kind: string,
    values: { withdrawnAt: Date; withdrawalIp: string | null },
  ) {
    return this.db
      .update(consents)
      .set(values)
      .where(
        and(
          eq(consents.userId, userId),
          eq(consents.kind, kind),
          isNull(consents.withdrawnAt),
        ),
      )
      .returning();
  }
}
