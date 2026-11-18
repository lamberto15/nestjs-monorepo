import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { Injectable, Logger } from '@nestjs/common';
import { SessionService, TokenService } from '@nestjs/authentication';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { SystemContext } from '../access/system-context.js';
import { AuditService } from '../audit/audit.service.js';
import { memberships, users } from '../auth/auth.tables.js';
import { LegalHoldsService } from '../holds/holds.service.js';
import { lockAccount } from './account-deletion.service.js';
import { ACCOUNT_DELETION_JOB } from './personal-data.permissions.js';
import { PersonalDataService } from './personal-data.service.js';
import { accountDeletions } from './personal-data.tables.js';

/** How an erased account is named from then on (its audit entries keep the actor key). */
export const DELETED_USER_NAME = 'Deleted user';

/**
 * Carries out the account deletions whose grace period passed, every
 * night at 03:50 UTC, on one instance, as `system:account-deletion`.
 *
 * A legal hold on the person (subject `User`) in any of their tenants
 * keeps the account whole: the request stays open, still cancellable, and
 * the next night looks again. Otherwise the request is claimed under the
 * account's row lock (no cancel from then on), every section
 * (`@PersonalData()`) erases what it holds in each tenant, one
 * transaction per tenant in that tenant's scope, then the account's own
 * sections run and the account is anonymised (name, address, password,
 * memberships with their roles and units) in a last transaction in no
 * tenant, audited `account.deleted`; its sessions and token families end
 * after the commit. Records the person created stay. Every step can run
 * again: a run cut short leaves the request claimed and open, and the next
 * night finishes it.
 */
@Injectable()
export class AccountDeletionJob {
  private readonly logger = new Logger(AccountDeletionJob.name);

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly system: SystemContext,
    private readonly holds: LegalHoldsService,
    private readonly personalData: PersonalDataService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
  ) {}

  @Cron('50 3 * * *', { name: 'account-deletion', timeZone: 'UTC' })
  @OnOneInstance({ key: 'iam:account-deletion' })
  @WithoutOverlapping()
  run() {
    return this.deleteDue();
  }

  /** The run itself, past the locks' decorators; `now` for tests. Resolves the accounts deleted. */
  async deleteDue(now = new Date()): Promise<number> {
    const failures: unknown[] = [];
    let deleted = 0;
    const due = await this.inNoTenant(() =>
      this.db
        .select()
        .from(accountDeletions)
        .where(
          and(
            lte(accountDeletions.scheduledFor, now),
            isNull(accountDeletions.cancelledAt),
            isNull(accountDeletions.completedAt),
          ),
        ),
    );
    for (const request of due) {
      try {
        if (await this.carryOut(request, now)) {
          deleted++;
        }
      } catch (error) {
        // One account's failure never stops the others: it stays open, and
        // the next night tries again.
        failures.push(error);
        this.logger.error(
          `Account ${request.userId} not deleted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (deleted > 0) {
      this.logger.log(`Accounts deleted: ${deleted}`);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `account-deletion failed for ${failures.length} account(s)`,
      );
    }
    return deleted;
  }

  private async carryOut(
    request: typeof accountDeletions.$inferSelect,
    now: Date,
  ) {
    const userId = request.userId;
    const tenantIds = await this.personalData.tenantsOf(userId);
    if (await this.heldInAnyTenant(userId, tenantIds)) {
      this.logger.warn(`Account ${userId}: deletion kept by a legal hold`);
      return false;
    }
    if (!(await this.claim(request.id, userId))) {
      return false; // cancelled or carried out since the list was read
    }
    for (const tenantId of tenantIds) {
      await this.system.run(
        ACCOUNT_DELETION_JOB,
        () => this.personalData.erase(userId, tenantId),
        { tenantId },
      );
    }
    await this.system.run(
      ACCOUNT_DELETION_JOB,
      async (system) => {
        await lockAccount(this.db, userId);
        await this.personalData.erase(userId, null);
        await this.db
          .update(users)
          .set({
            email: `deleted-${userId}@anonymized.invalid`,
            name: DELETED_USER_NAME,
            passwordHash: null,
            emailVerified: false,
            locale: null,
            timezone: null,
            active: false,
            onboardingEmail: false,
            onboardingPassword: false,
          })
          .where(eq(users.id, userId));
        // Its roles and units in every tenant go with them (cascade).
        await this.db.delete(memberships).where(eq(memberships.userId, userId));
        await this.db
          .update(accountDeletions)
          .set({ completedAt: now })
          .where(eq(accountDeletions.id, request.id));
        await this.audit.record(system, {
          action: 'account.deleted',
          targetType: 'user',
          targetId: userId,
          details: {
            requestedAt: request.requestedAt.toISOString(),
            tenants: tenantIds.length,
          },
        });
      },
      { tenantId: null },
    );
    // Committed: the account's sessions and token families end (the store
    // announces each, so live sockets close). Inactive already: none works.
    await this.sessions.revokeAll(userId);
    await this.tokens.revokeAll(userId);
    return true;
  }

  /** Whether a tenant the person belongs to holds them (subject `User`). */
  private async heldInAnyTenant(userId: string, tenantIds: string[]) {
    for (const tenantId of tenantIds) {
      const held = await this.system.run(
        ACCOUNT_DELETION_JOB,
        async () => (await this.holds.heldAmong('User', [userId])).size > 0,
        { tenantId, transaction: false },
      );
      if (held) {
        return true;
      }
    }
    return false;
  }

  /** Claimed under the account's row lock: from here on no cancel takes it back. */
  private async claim(id: string, userId: string) {
    const claimed = await this.inNoTenant(() =>
      this.txHost.withTransaction(async () => {
        await lockAccount(this.db, userId);
        return this.db
          .update(accountDeletions)
          .set({
            startedAt: sql`coalesce(${accountDeletions.startedAt}, now())`,
          })
          .where(
            and(
              eq(accountDeletions.id, id),
              isNull(accountDeletions.cancelledAt),
              isNull(accountDeletions.completedAt),
            ),
          )
          .returning({ id: accountDeletions.id });
      }),
    );
    return claimed.length > 0;
  }

  private inNoTenant<T>(work: () => Promise<T>) {
    return this.system.run(ACCOUNT_DELETION_JOB, work, {
      transaction: false,
      tenantId: null,
    });
  }
}
