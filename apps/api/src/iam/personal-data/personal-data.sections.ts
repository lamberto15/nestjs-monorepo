import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { auditLog } from '../audit/audit.tables.js';
import {
  memberships,
  refreshTokens,
  sessions,
  users,
} from '../auth/auth.tables.js';
import { DELETED_USER_NAME } from './account-deletion.job.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from './personal-data.js';
import { consents } from './personal-data.tables.js';

/**
 * The account itself (iam/auth's tables): the profile without its
 * password hash, the memberships, where it is signed in. Its erasure is
 * the deletion job's last step (the anonymisation), not a section's.
 */
@PersonalData({ name: 'account', scopes: ['account'] })
@Injectable()
export class AccountSection implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ userId }: PersonalDataSubject) {
    const [profile] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    const { passwordHash: _hash, ...rest } = profile ?? {};
    const [joined, signedIn, tokens] = await Promise.all([
      this.db
        .select({
          tenantId: memberships.tenantId,
          active: memberships.active,
          createdAt: memberships.createdAt,
        })
        .from(memberships)
        .where(eq(memberships.userId, userId)),
      this.db
        .select({
          createdAt: sessions.createdAt,
          lastActiveAt: sessions.lastActiveAt,
          expiresAt: sessions.expiresAt,
          metadata: sessions.metadata,
        })
        .from(sessions)
        .where(eq(sessions.userId, userId)),
      this.db
        .select({
          createdAt: refreshTokens.createdAt,
          revoked: refreshTokens.revoked,
        })
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, userId)),
    ]);
    return [
      ...(profile ? [{ kind: 'profile', ...rest }] : []),
      ...joined.map((row) => ({ kind: 'membership', ...row })),
      ...signedIn.map((row) => ({ kind: 'session', ...row })),
      ...tokens.map((row) => ({ kind: 'refreshToken', ...row })),
    ];
  }
}

/** Every consent the person gave or withdrew. Kept at the deletion, as proof (the account is anonymised). */
@PersonalData({ name: 'consents', scopes: ['account'] })
@Injectable()
export class ConsentsSection implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  rows({ userId }: PersonalDataSubject) {
    return this.db.select().from(consents).where(eq(consents.userId, userId));
  }
}

/**
 * What the person did, as the audit log holds it, in each tenant and in
 * none. At the deletion the entries stay (an audit trail) but lose the
 * address they were labelled with: "Deleted user", the actor key kept.
 */
@PersonalData({ name: 'audit', scopes: ['tenant', 'account'] })
@Injectable()
export class AuditSection implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async *rows({ key }: PersonalDataSubject) {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.db
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
            eq(auditLog.actor, key),
            cursor ? lt(auditLog.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(auditLog.id))
        .limit(1000);
      if (page.length === 0) return;
      yield page;
      cursor = page[page.length - 1]!.id;
    }
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db
      .update(auditLog)
      .set({ actorLabel: DELETED_USER_NAME })
      .where(eq(auditLog.actor, key));
  }
}
