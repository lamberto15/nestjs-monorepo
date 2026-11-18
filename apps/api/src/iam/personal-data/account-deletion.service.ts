import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  PasswordHasher,
  SessionService,
  TokenService,
} from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { and, eq, isNull } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { MailQueue } from '../../core/mail/mail.queue.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import { users } from '../auth/auth.tables.js';
import type { UserPrincipal } from '../auth/principal.js';
import { DeletionCancelLinks } from './deletion-cancel-links.js';
import { personalDataConfig } from './personal-data.config.js';
import { AccountDeletionMail } from './personal-data.mails.js';
import { accountDeletions } from './personal-data.tables.js';

type Deletion = typeof accountDeletions.$inferSelect;

/**
 * A person's request to delete their account (README.md): carried out by
 * AccountDeletionJob after ACCOUNT_DELETION_GRACE_DAYS, cancellable until
 * the job starts on it (signed in, or with the mail's link). Each change
 * is one transaction with its audit entry, in no tenant: the account is
 * the person's, whatever tenant the request acts in.
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly mail: MailQueue,
    private readonly links: DeletionCancelLinks,
    @Inject(personalDataConfig.KEY)
    private readonly config: ConfigType<typeof personalDataConfig>,
  ) {}

  /** The account's pending deletion, or undefined. */
  async pending(userId: string): Promise<Deletion | undefined> {
    const [row] = await this.accountLevel(() =>
      this.db
        .select()
        .from(accountDeletions)
        .where(
          and(
            eq(accountDeletions.userId, userId),
            isNull(accountDeletions.cancelledAt),
            isNull(accountDeletions.completedAt),
          ),
        ),
    );
    return row;
  }

  /**
   * Schedules the deletion, once the password (when the account has one)
   * was given again; the route also wants a recent sign-in. The password
   * stays because a stolen session's thief could enrol their own second
   * factor and re-authenticate with it. A pending request is returned as
   * it is, with no new mail. Every other session and every token client is
   * signed out; this session stays, to cancel.
   */
  async request(
    user: UserPrincipal,
    password: string | undefined,
    ip: string | undefined,
    sessionId: string | undefined,
  ) {
    const pending = await this.pending(user.id);
    if (pending) {
      return view(pending);
    }
    const [account] = await this.accountLevel(() =>
      this.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, user.id)),
    );
    if (account?.passwordHash) {
      if (!password) {
        throw new BadRequestException({
          code: 'validation_failed',
          message: t('personalData.passwordRequired'),
          errors: [{ path: 'password', message: t('personalData.required') }],
        });
      }
      if (!(await this.hasher.verify(password, account.passwordHash))) {
        await this.accountLevel(() =>
          this.audit.record(user, {
            action: 'account.deletion-refused',
            targetType: 'user',
            targetId: user.id,
            details: { reason: 'password' },
            ip,
          }),
        );
        // 403, not 401: a web app would read that as signed out.
        throw new ForbiddenException(t('personalData.wrongPassword'));
      }
    }
    const scheduledFor = new Date(
      Date.now() + this.config.deletionGraceDays * 86_400_000,
    );
    const row = await this.accountLevel(() =>
      this.txHost.withTransaction(async () => {
        const [created] = await this.db
          .insert(accountDeletions)
          .values({ userId: user.id, scheduledFor })
          .returning();
        await this.audit.record(user, {
          action: 'account.deletion-requested',
          targetType: 'user',
          targetId: user.id,
          details: { scheduledFor: scheduledFor.toISOString() },
          ip,
        });
        return created!;
      }),
    );
    // After the commit (the package's stores), as a password change does.
    await this.sessions.revokeAll(user.id, {
      ...(sessionId && { except: sessionId }),
    });
    await this.tokens.revokeAll(user.id);
    await this.mail.send(AccountDeletionMail, {
      to: { name: user.name, address: user.email },
      data: {
        name: user.name,
        scheduledFor,
        timezone: user.timezone,
        token: this.links.sign(row),
      },
      locale: user.locale ?? undefined,
    });
    return view(row);
  }

  /** Cancels the pending deletion; 404 when there is none (or the job started on it). */
  async cancel(user: UserPrincipal, ip?: string) {
    const pending = await this.pending(user.id);
    const cancelled =
      pending &&
      (await this.accountLevel(() =>
        this.txHost.withTransaction(async () => {
          if (!(await this.cancelPending(pending.id, user.id))) {
            return false;
          }
          await this.audit.record(user, {
            action: 'account.deletion-cancelled',
            targetType: 'user',
            targetId: user.id,
            ip,
          });
          return true;
        }),
      ));
    if (!cancelled) {
      throw new NotFoundException(t('personalData.noDeletionPending'));
    }
  }

  /**
   * Cancels the deletion a mail's link names, without a sign-in. Every
   * refusal is the same 400: a forged or expired token, a request
   * cancelled or carried out already, an earlier request, an account that
   * doesn't exist. Audited as the person's `account.deletion-cancelled`,
   * `via: link`.
   */
  async cancelByLink(token: string, ip?: string) {
    const invalid = () =>
      new BadRequestException(t('personalData.invalidLink'));
    const claims = await this.links.verify(token);
    if (!claims) {
      throw invalid();
    }
    await this.accountLevel(() =>
      this.txHost.withTransaction(async () => {
        const cancelled = await this.cancelPending(
          claims.deletionId,
          claims.userId,
        );
        const [user] = cancelled
          ? await this.db
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(eq(users.id, claims.userId))
          : [];
        if (!user) {
          throw invalid(); // rolls the update back
        }
        await this.audit.recordAccount(user, {
          action: 'account.deletion-cancelled',
          targetType: 'user',
          targetId: user.id,
          details: { via: 'link' },
          ip,
        });
      }),
    );
  }

  /**
   * Marks the request cancelled if it is still pending and not started,
   * under the account's row lock (the one the job claims it under): true
   * when it did.
   */
  private async cancelPending(id: string, userId: string) {
    await lockAccount(this.db, userId);
    const rows = await this.db
      .update(accountDeletions)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(accountDeletions.id, id),
          eq(accountDeletions.userId, userId),
          isNull(accountDeletions.cancelledAt),
          isNull(accountDeletions.startedAt),
          isNull(accountDeletions.completedAt),
        ),
      )
      .returning({ id: accountDeletions.id });
    return rows.length > 0;
  }

  /** In no tenant: the account's own entries belong to no tenant's log. */
  private accountLevel<T>(work: () => Promise<T>) {
    return this.tenancy.run(null, work);
  }
}

/** The account's row, locked until the transaction ends: deletions, cancels and the job one at a time. */
export async function lockAccount(db: Database, userId: string) {
  if (!UUID.test(userId)) {
    return;
  }
  await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const view = (row: Deletion) => ({
  requestedAt: row.requestedAt.toISOString(),
  scheduledFor: row.scheduledFor.toISOString(),
});
