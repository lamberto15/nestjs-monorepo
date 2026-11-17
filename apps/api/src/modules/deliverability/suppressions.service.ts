import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { and, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { deliverabilityConfig } from './deliverability.config.js';
import { mailEvents, mailSuppressions } from './deliverability.tables.js';
import type {
  CreateMailSuppressionDto,
  MailSuppressionView,
} from './deliverability.schemas.js';
import { MAIL_SUPPRESSION_LIST } from './deliverability.lists.js';
import type { MailEvent } from './mail-event.types.js';
import {
  type MailSuppression,
  MailSuppressionList,
  normalizeAddress,
  SUPPRESSION_REASONS,
  type SuppressionReason,
  type SuppressionVerdict,
} from '../../core/mail/mail-suppression.js';

type Suppression = typeof mailSuppressions.$inferSelect;

/** Which reason wins when a new report arrives for a listed address: a fact beats a decision. */
const RANK: Record<SuppressionReason, number> = {
  complaint: 3,
  hard_bounce: 2,
  manual: 1,
  soft_bounce: 0,
};

const iso = (date: Date | null) => (date ? date.toISOString() : null);

const view = (row: Suppression): MailSuppressionView => ({
  ...row,
  reason: row.reason as SuppressionReason,
  firstSeenAt: row.firstSeenAt.toISOString(),
  lastSeenAt: row.lastSeenAt.toISOString(),
  suppressedAt: iso(row.suppressedAt),
  lastSkippedAt: iso(row.lastSkippedAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** What applying a batch of events changed. */
export interface AppliedEvents {
  /** Events recorded (the rest were replays). */
  recorded: number;
  /** Addresses suppressed by this batch. */
  suppressed: string[];
}

/**
 * The suppression list (README.md): the addresses mail is not sent to, kept
 * from the bounces and complaints providers report (`apply`, by the intake's
 * queue job as `system:mail-intake`) and by administrators (`create`,
 * `remove`). The mail queue's worker asks it before every send (`check`,
 * found by `@MailSuppressionList()`). Each write is one transaction with
 * its audit entry. The list is the deployment's: global tables, every
 * tenant's addresses together.
 */
@Injectable()
@MailSuppressionList()
export class SuppressionsService implements MailSuppression {
  private readonly logger = new Logger('MailSuppressions');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly audit: AuditService,
    @Inject(deliverabilityConfig.KEY)
    private readonly config: ConfigType<typeof deliverabilityConfig>,
    metrics: MetricsService,
  ) {
    metrics.collect(
      'mail_suppressions',
      'Addresses on the suppression list (mail is not sent to them), by reason.',
      async () => {
        const rows = await this.db
          .select({ reason: mailSuppressions.reason, value: count() })
          .from(mailSuppressions)
          .where(isNotNull(mailSuppressions.suppressedAt))
          .groupBy(mailSuppressions.reason);
        return SUPPRESSION_REASONS.map((reason) => ({
          labels: { reason },
          value: rows.find((row) => row.reason === reason)?.value ?? 0,
        }));
      },
      ['reason'],
    );
  }

  /** An audit entry of the list's changes (`mailSuppression.created|updated|deleted`), in the transaction. */
  private record(
    principal: Principal,
    action: 'created' | 'updated' | 'deleted',
    row: Suppression,
    extra?: Record<string, unknown>,
    ip?: string,
  ) {
    return this.audit.record(principal, {
      action: `mailSuppression.${action}`,
      targetType: 'mailSuppression',
      targetId: row.id,
      details: { address: row.address, reason: row.reason, ...extra },
      ip,
    });
  }

  /** A page of entries, newest first unless the query sorts. */
  async list(query: ListQuery) {
    const where = MAIL_SUPPRESSION_LIST.where(query);
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(mailSuppressions)
        .where(and(where, afterCursor(mailSuppressions.id, query)))
        .orderBy(...pageOrder(mailSuppressions.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, mailSuppressions, where, query),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(view) };
  }

  async findOne(id: string) {
    const [row] = await this.db
      .select()
      .from(mailSuppressions)
      .where(eq(mailSuppressions.id, id));
    if (!row) {
      throw new NotFoundException(`Suppression ${id} not found.`);
    }
    return view(row);
  }

  /** Whether a soft-bounce suppression has run its MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS. */
  private softBounceExpired(row: Suppression, now: Date) {
    const hours = this.config.softBounce.suppressionHours;
    return (
      row.reason === 'soft_bounce' &&
      row.suppressedAt !== null &&
      now.getTime() - row.suppressedAt.getTime() > hours * 3_600_000
    );
  }

  /**
   * The sender's question (core/mail/mail-suppression.ts): a listed
   * address is skipped, unless the mail is essential and the mailbox
   * exists (a complaint, a soft bounce): the person asked for that mail,
   * and a soft bounce must never lock them out of account recovery. A
   * soft-bounce suppression older than MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS
   * has expired: the entry goes back to watched-only here (lazily, when
   * the address is next written to) and the mail goes out. Skips are
   * counted on the entry, outside any transaction (the worker has none;
   * a failed count never fails the mail).
   */
  async check(
    addresses: readonly string[],
    { essential, mail }: { essential: boolean; mail: string },
  ) {
    const verdicts = new Map<string, SuppressionVerdict>();
    const wanted = [...new Set(addresses.map(normalizeAddress))];
    if (wanted.length === 0) {
      return verdicts;
    }
    const rows = await this.db
      .select()
      .from(mailSuppressions)
      .where(
        and(
          inArray(mailSuppressions.address, wanted),
          isNotNull(mailSuppressions.suppressedAt),
        ),
      );
    const now = new Date();
    const skipped: string[] = [];
    const expired: string[] = [];
    for (const row of rows) {
      const reason = row.reason as SuppressionReason;
      if (this.softBounceExpired(row, now)) {
        expired.push(row.id);
        continue;
      }
      if (essential && (reason === 'complaint' || reason === 'soft_bounce')) {
        continue; // asked for by the person, and the mailbox exists: goes out
      }
      verdicts.set(row.address, { send: false, reason });
      skipped.push(row.address);
    }
    if (expired.length > 0) {
      await this.db
        .update(mailSuppressions)
        .set({ suppressedAt: null, softBounces: 0 })
        .where(inArray(mailSuppressions.id, expired));
      this.logger.log('Soft-bounce suppressions expired', {
        expired: expired.length,
      });
    }
    if (skipped.length > 0) {
      await this.db
        .update(mailSuppressions)
        .set({
          skipped: sql`${mailSuppressions.skipped} + 1`,
          lastSkippedAt: now,
        })
        .where(inArray(mailSuppressions.address, skipped));
      this.logger.log('Mail kept from suppressed addresses', {
        mail,
        skipped: skipped.length,
      });
    }
    return verdicts;
  }

  /**
   * Records a provider's events and keeps the list from them, in one
   * transaction: each event once (the unique index on provider, message
   * and address makes a redelivery a no-op), then per address: a hard
   * bounce or a complaint suppresses it (a stronger reason replaces a
   * weaker one), a soft bounce is counted and suppresses it at
   * MAIL_SOFT_BOUNCE_THRESHOLD in a row, a delivery resets that count.
   * The audit log gets an entry when an address becomes suppressed or its
   * reason changes, as `system`.
   */
  async apply(
    system: Principal,
    provider: string,
    id: string,
    events: readonly MailEvent[],
  ): Promise<AppliedEvents> {
    return this.txHost.withTransaction(async () => {
      const result: AppliedEvents = { recorded: 0, suppressed: [] };
      for (const event of events) {
        const address = normalizeAddress(event.address);
        const occurredAt = new Date(event.occurredAt);
        const [recorded] = await this.db
          .insert(mailEvents)
          .values({
            provider,
            eventId: id,
            type: event.type,
            address,
            occurredAt: Number.isNaN(occurredAt.getTime())
              ? new Date()
              : occurredAt,
            detail: event.detail ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: mailEvents.id });
        if (!recorded) {
          continue; // a replay
        }
        result.recorded++;
        if (await this.applyOne(system, provider, address, event)) {
          result.suppressed.push(address);
        }
      }
      return result;
    });
  }

  /**
   * One event on one address; true when the address became suppressed.
   * Soft bounces count within MAIL_SOFT_BOUNCE_WINDOW_HOURS of the last
   * one (an older count starts over), and an expired soft-bounce
   * suppression counts as none.
   */
  private async applyOne(
    system: Principal,
    provider: string,
    address: string,
    event: MailEvent,
  ) {
    const [current] = await this.db
      .select()
      .from(mailSuppressions)
      .where(eq(mailSuppressions.address, address))
      .for('update');
    const now = new Date();
    const expired = current ? this.softBounceExpired(current, now) : false;
    const wasSuppressed = !!current?.suppressedAt && !expired;
    if (event.type === 'delivery') {
      if (current && (current.softBounces > 0 || expired) && !wasSuppressed) {
        await this.db
          .update(mailSuppressions)
          .set({ softBounces: 0, suppressedAt: null, lastSeenAt: now })
          .where(eq(mailSuppressions.id, current.id));
      }
      return false;
    }
    const threshold = this.config.softBounce.threshold;
    const windowMs = this.config.softBounce.windowHours * 3_600_000;
    const recentSoft =
      current &&
      !expired &&
      now.getTime() - current.lastSeenAt.getTime() <= windowMs
        ? current.softBounces
        : 0;
    const softBounces = event.type === 'soft_bounce' ? recentSoft + 1 : 0;
    const reason: SuppressionReason = event.type;
    // What this event says the entry should be, on its own.
    const suppressNow = reason !== 'soft_bounce' || softBounces >= threshold;
    if (!current) {
      const [created] = await this.db
        .insert(mailSuppressions)
        .values({
          address,
          reason,
          source: provider,
          lastDetail: event.detail ?? null,
          events: 1,
          softBounces,
          firstSeenAt: now,
          lastSeenAt: now,
          suppressedAt: suppressNow ? now : null,
          createdBy: principalKey(system),
        })
        .returning();
      if (suppressNow) {
        await this.record(system, 'created', created!);
      }
      return suppressNow;
    }
    const upgrade =
      suppressNow &&
      (!wasSuppressed ||
        RANK[reason] > RANK[current.reason as SuppressionReason]);
    const [updated] = await this.db
      .update(mailSuppressions)
      .set({
        events: current.events + 1,
        softBounces,
        lastSeenAt: now,
        lastDetail: event.detail ?? current.lastDetail,
        ...(upgrade
          ? {
              reason,
              source: provider,
              suppressedAt: wasSuppressed ? current.suppressedAt : now,
            }
          : expired && { suppressedAt: null }),
      })
      .where(eq(mailSuppressions.id, current.id))
      .returning();
    if (upgrade) {
      await this.record(
        system,
        wasSuppressed ? 'updated' : 'created',
        updated!,
        wasSuppressed ? { from: current.reason } : undefined,
      );
    }
    return upgrade && !wasSuppressed;
  }

  /** An administrator's entry; a 409 when the address is listed already. */
  async create(
    principal: Principal,
    dto: CreateMailSuppressionDto,
    ip?: string,
  ) {
    const address = normalizeAddress(dto.address);
    const now = new Date();
    const row = await this.txHost
      .withTransaction(async () => {
        const [created] = await this.db
          .insert(mailSuppressions)
          .values({
            address,
            reason: 'manual',
            source: 'manual',
            note: dto.note || null,
            firstSeenAt: now,
            lastSeenAt: now,
            suppressedAt: now,
            createdBy: principalKey(principal),
          })
          .returning();
        await this.record(principal, 'created', created!, undefined, ip);
        return created!;
      })
      .catch((error: unknown) => {
        throw databaseErrorKind(error) === 'unique_violation'
          ? new ConflictException({
              code: 'suppression_exists',
              message: `${address} is on the list already.`,
            })
          : error;
      });
    return view(row);
  }

  /**
   * Removes an entry: mail goes to the address again. For a bounced
   * address, once the mailbox is known to work; for a complaint, only
   * when the person asked for mail again. The events stay (the trail);
   * a new report lists it again.
   */
  async remove(principal: Principal, id: string, ip?: string) {
    await this.txHost.withTransaction(async () => {
      // Read under the lock, so the audit entry's `before` is what was deleted.
      const [row] = await this.db
        .select()
        .from(mailSuppressions)
        .where(eq(mailSuppressions.id, id))
        .for('update');
      if (!row) {
        throw new NotFoundException(`Suppression ${id} not found.`);
      }
      await this.db.delete(mailSuppressions).where(eq(mailSuppressions.id, id));
      await this.record(principal, 'deleted', row, undefined, ip);
    });
  }
}
