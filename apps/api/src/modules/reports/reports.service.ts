import { randomUUID } from 'node:crypto';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import type { OutboxHandlerContext } from '@nestjs/outbox';
import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import { Locks } from '@nestjs/locks';
import { StorageDisk } from '@nestjs/storage';
import { and, asc, count, eq, lte } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { MailQueue } from '../../core/mail/mail.queue.js';
import { OnDomainEvent } from '../../core/outbox/events.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type RequestPrincipal,
  type SystemPrincipal,
} from '../../iam/auth/principal.js';
import {
  transferFinished,
  type TransferFinished,
} from '../data-transfer/data-transfer.events.js';
import { DataTransferService } from '../data-transfer/data-transfer.service.js';
import type { TransferFormat } from '../data-transfer/data-transfer.types.js';
import { PrincipalNow } from '../data-transfer/principal-now.js';
import { nextRunTime } from './report-time.js';
import { reportsConfig } from './reports.config.js';
import { REPORT_LIST } from './reports.lists.js';
import { ReportFailedMail, ReportReadyMail } from './reports.mails.js';
import { REPORT_RUNNER_JOB } from './reports.permissions.js';
import {
  type CreateReportDto,
  MAX_ACTIVE_REPORTS,
  type UpdateReportDto,
} from './reports.schemas.js';
import { type ReportScheduleRow, reportSchedules } from './reports.tables.js';

/** The transfers a report started carry this tag: `report:<id>`. */
const TAG = 'report:';

const view = (row: ReportScheduleRow) => ({
  id: row.id,
  name: row.name,
  exporter: row.exporter,
  format: row.format as TransferFormat,
  filters: row.filters,
  sort: row.sort,
  timezone: row.timezone,
  schedule: row.schedule,
  recipients: row.recipients,
  active: row.active,
  lastRunAt: row.lastRunAt?.toISOString() ?? null,
  lastStatus: row.lastStatus ?? null,
  lastTransferId: row.lastTransferId ?? null,
  nextRunAt: row.nextRunAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/** A refusal of the export that waiting will not change (its filters no longer parse, a field now hidden). */
export const isRefusal = (error: unknown) =>
  error instanceof HttpException &&
  error.getStatus() >= 400 &&
  error.getStatus() < 500;

/**
 * Scheduled reports: an export asked for once, run for its owner on a
 * schedule (daily, weekly, monthly at an hour of their time zone), its file
 * mailed to the recipients with a signed link. Each principal sees and
 * changes only their own (another's is a 404). The runner (ReportsRunner)
 * starts the due ones every hour; the export runs as any other
 * (`DataTransferService.startExport()`, as the owner, checked again on the
 * worker), and its end (`transferFinished`) mails the recipients.
 */
@Injectable()
export class ReportsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly transfers: DataTransferService,
    private readonly principals: PrincipalNow,
    private readonly audit: AuditService,
    private readonly mailQueue: MailQueue,
    private readonly disk: StorageDisk,
    private readonly i18n: I18nService,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
    private readonly locks: Locks,
    @Inject(reportsConfig.KEY)
    private readonly config: ConfigType<typeof reportsConfig>,
  ) {}

  /** A page of the principal's reports, newest first unless the query sorts. */
  async page(principal: RequestPrincipal, query: ListQuery) {
    const where = and(
      eq(reportSchedules.owner, principalKey(principal)),
      REPORT_LIST.where(query),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(reportSchedules)
        .where(and(where, afterCursor(reportSchedules.id, query)))
        .orderBy(...pageOrder(reportSchedules.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, reportSchedules, where, query),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(view) };
  }

  async get(principal: RequestPrincipal, id: string) {
    return view(await this.findOwn(principal, id));
  }

  async create(principal: RequestPrincipal, dto: CreateReportDto, ip?: string) {
    await this.check(principal, dto.exporter, dto.filters, dto.sort);
    const recipients =
      dto.recipients ?? (principal.kind === 'user' ? [principal.email] : null);
    if (!recipients) {
      throw invalid([
        { path: 'recipients', message: 'An API client names the recipients.' },
      ]);
    }
    const timezone = this.transfers.zone(principal, dto.timezone);
    const row = await this.exclusively(principal, async () => {
      if (dto.active) await this.assertRoomFor(principal);
      const [created] = await this.db
        .insert(reportSchedules)
        .values({
          owner: principalKey(principal),
          name: dto.name,
          exporter: dto.exporter,
          format: dto.format,
          filters: dto.filters,
          sort: dto.sort,
          timezone,
          schedule: dto.schedule,
          recipients,
          active: dto.active,
          nextRunAt: nextRunTime(dto.schedule, new Date(), timezone),
        })
        .returning();
      await this.audit.record(principal, {
        action: 'report.created',
        targetType: 'report',
        targetId: created!.id,
        details: { name: created!.name, exporter: created!.exporter },
        ip,
      });
      return created!;
    });
    return view(row);
  }

  /**
   * Only what is sent changes; the next run is computed again from now
   * when the schedule, the zone or `active` is sent.
   */
  async update(
    principal: RequestPrincipal,
    id: string,
    dto: UpdateReportDto,
    ip?: string,
  ) {
    const report = await this.findOwn(principal, id);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateReportDto;
    if (Object.keys(values).length === 0) return view(report);
    if (
      values.exporter !== undefined ||
      values.filters !== undefined ||
      values.sort !== undefined
    ) {
      await this.check(
        principal,
        values.exporter ?? report.exporter,
        values.filters ?? report.filters,
        values.sort === undefined ? report.sort : values.sort,
      );
    }
    const schedule = values.schedule ?? report.schedule;
    const timezone = values.timezone ?? report.timezone;
    const reschedule =
      values.schedule !== undefined ||
      values.timezone !== undefined ||
      values.active !== undefined;
    const row = await this.exclusively(principal, async () => {
      if (values.active && !report.active) {
        await this.assertRoomFor(principal);
      }
      const [updated] = await this.db
        .update(reportSchedules)
        .set({
          ...values,
          ...(reschedule && {
            nextRunAt: nextRunTime(schedule, new Date(), timezone),
          }),
        })
        .where(eq(reportSchedules.id, id))
        .returning();
      await this.audit.record(principal, {
        action: 'report.updated',
        targetType: 'report',
        targetId: id,
        details: { changed: Object.keys(values) },
        ip,
      });
      return updated!;
    });
    return view(row);
  }

  async remove(principal: RequestPrincipal, id: string, ip?: string) {
    const report = await this.findOwn(principal, id);
    await this.txHost.withTransaction(async () => {
      await this.db.delete(reportSchedules).where(eq(reportSchedules.id, id));
      await this.audit.record(principal, {
        action: 'report.deleted',
        targetType: 'report',
        targetId: id,
        details: { name: report.name, exporter: report.exporter },
        ip,
      });
    });
  }

  /** Runs one of the principal's reports now; its schedule stays as it is. */
  async runNow(principal: RequestPrincipal, id: string, ip?: string) {
    const report = await this.findOwn(principal, id);
    // A 400 (not the export's 403/404) when the owner may no longer run it.
    await this.check(principal, report.exporter, report.filters, report.sort);
    const started = await this.start(principal, report, {
      trigger: 'manual',
      ip,
    });
    if (!started) throw new NotFoundException(`Report ${id} not found.`);
    return started;
  }

  /**
   * Starts a report's export as `principal` (its owner), tagged with the
   * report, so its end mails the recipients.
   *
   * The run is claimed first, in one transaction: the transfer's id (chosen
   * now) and `lastRunAt` are stored, and a scheduled run moves `nextRunAt`
   * past `now` only where it is still the value the runner read: a second
   * runner gets nothing to claim (null). A manual run leaves the schedule
   * alone. If the export can't start, the claim is undone and the error
   * thrown.
   */
  async start(
    principal: RequestPrincipal,
    report: ReportScheduleRow,
    options: { trigger: 'manual' | 'schedule'; now?: Date; ip?: string },
  ) {
    const now = options.now ?? new Date();
    const transferId = randomUUID();
    const scheduled = options.trigger === 'schedule';
    const claim = await this.txHost.withTransaction(async () => {
      const [current] = await this.db
        .select()
        .from(reportSchedules)
        .where(eq(reportSchedules.id, report.id))
        .for('update');
      if (
        !current ||
        (scheduled &&
          (!current.active ||
            current.nextRunAt.getTime() !== report.nextRunAt.getTime()))
      ) {
        return null;
      }
      const [claimed] = await this.db
        .update(reportSchedules)
        .set({
          lastRunAt: now,
          lastTransferId: transferId,
          ...(scheduled && {
            nextRunAt: nextRunTime(current.schedule, now, current.timezone),
          }),
        })
        .where(eq(reportSchedules.id, report.id))
        .returning();
      return { before: current, claimed: claimed! };
    });
    if (!claim) return null; // another run took it
    const { before, claimed } = claim;
    let started;
    try {
      started = await this.transfers.startExport(principal, {
        name: claimed.exporter,
        format: claimed.format as TransferFormat,
        filters: claimed.filters,
        sort: claimed.sort,
        timezone: claimed.timezone,
        tag: `${TAG}${claimed.id}`,
        id: transferId,
        details: { report: claimed.id, trigger: options.trigger },
      });
    } catch (error) {
      await this.db
        .update(reportSchedules)
        .set({
          lastRunAt: before.lastRunAt,
          lastTransferId: before.lastTransferId,
          nextRunAt: before.nextRunAt,
        })
        .where(
          and(
            eq(reportSchedules.id, report.id),
            eq(reportSchedules.lastTransferId, transferId),
          ),
        );
      throw error;
    }
    await this.audit.record(principal, {
      action: 'report.ran',
      targetType: 'report',
      targetId: report.id,
      details: { transferId: started.id, trigger: options.trigger },
      ip: options.ip,
    });
    return started;
  }

  /** Moves a scheduled run that could not start (a refused export) past `now`; `by`: the runner. */
  async skip(
    report: ReportScheduleRow,
    now: Date,
    reason: string,
    by: SystemPrincipal,
  ) {
    await this.txHost.withTransaction(async () => {
      await this.db
        .update(reportSchedules)
        .set({
          lastStatus: 'failed',
          nextRunAt: nextRunTime(report.schedule, now, report.timezone),
        })
        .where(eq(reportSchedules.id, report.id));
      await this.audit.record(by, {
        action: 'report.skipped',
        targetType: 'report',
        targetId: report.id,
        details: { reason },
      });
    });
  }

  /** Stops a report whose owner is gone or may no longer run it; `by`: the runner. */
  async deactivate(
    report: ReportScheduleRow,
    reason: 'owner_inactive' | 'export_not_allowed',
    by: SystemPrincipal,
  ) {
    await this.txHost.withTransaction(async () => {
      await this.db
        .update(reportSchedules)
        .set({ active: false })
        .where(eq(reportSchedules.id, report.id));
      await this.audit.record(by, {
        action: 'report.deactivated',
        targetType: 'report',
        targetId: report.id,
        details: { owner: report.owner, reason },
      });
    });
  }

  /** The report's owner as they are now in its tenant; null when they no longer act there. */
  owner(report: ReportScheduleRow) {
    const [kind = '', id = ''] = report.owner.split(':');
    return this.principals.of(kind, id, report.tenantId);
  }

  /** Whether the owner may still run the report's export. */
  mayRun(principal: RequestPrincipal, exporter: string) {
    return this.transfers.exportable(principal, exporter);
  }

  /**
   * A transfer ended (on the worker): when a report started it, the
   * recipients get the link (or word of the failure), once per transfer,
   * in the owner's language: the owner's own address is the `To`, every
   * other recipient a `Bcc`, so nobody sees the others. The report's last
   * status is kept (unless a later run superseded it) and audited, once.
   * The runner's doing (`system:report-runner`), as the run's start was.
   */
  @OnDomainEvent(transferFinished, { consumer: 'reports' })
  onFinished(event: TransferFinished, ctx: OutboxHandlerContext) {
    const tag = event.job.kind === 'export' ? event.job.tag : undefined;
    if (!tag?.startsWith(TAG)) return;
    return this.system.run(
      REPORT_RUNNER_JOB,
      (system) => this.finished(tag.slice(TAG.length), event, ctx, system),
      { transaction: false },
    );
  }

  private async finished(
    reportId: string,
    event: TransferFinished,
    ctx: OutboxHandlerContext,
    system: SystemPrincipal,
  ) {
    const [report] = await this.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.id, reportId));
    if (!report) return; // deleted meanwhile: nobody to tell
    await this.mail(report, event);
    await this.txHost.withTransaction(async () => {
      await ctx.processInTransaction(this.txHost.tx, async () => {
        await this.db
          .update(reportSchedules)
          .set({ lastStatus: event.status })
          .where(
            and(
              eq(reportSchedules.id, reportId),
              eq(reportSchedules.lastTransferId, event.id),
            ),
          );
        await this.audit.record(system, {
          action: 'report.finished',
          targetType: 'report',
          targetId: reportId,
          details: { transferId: event.id, status: event.status },
        });
      });
    });
  }

  /** The mail of a run, its job id the transfer's: sent once however often this runs. */
  private async mail(report: ReportScheduleRow, event: TransferFinished) {
    const owner = event.job.principal;
    const locale =
      (owner.kind === 'user' ? owner.locale : null) ?? this.i18n.defaultLocale;
    const own = owner.kind === 'user' ? owner.email.toLowerCase() : undefined;
    const to = report.recipients.filter((a) => a.toLowerCase() === own);
    const bcc = report.recipients.filter((a) => a.toLowerCase() !== own);
    const jobId = `report-${event.id}`;
    if (event.status === 'completed' && event.result.kind === 'export') {
      const hours = this.config.linkTtlHours;
      const url = await this.disk.signedUrl(event.result.key, {
        expiresIn: `${hours}h`,
      });
      await this.mailQueue.send(
        ReportReadyMail,
        {
          to,
          bcc,
          locale,
          data: {
            report: report.name,
            url,
            expiresAt: new Date(Date.now() + hours * 3_600_000),
            rows: event.result.rows,
            timezone: report.timezone,
          },
        },
        { jobId },
      );
    } else if (event.status === 'failed') {
      await this.mailQueue.send(
        ReportFailedMail,
        { to, bcc, locale, data: { report: report.name } },
        { jobId },
      );
    }
  }

  /** The tenant's due reports, as the runner's system principal, at most `limit`. */
  due(now: Date, limit: number) {
    return this.db
      .select()
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.active, true),
          lte(reportSchedules.nextRunAt, now),
        ),
      )
      .orderBy(asc(reportSchedules.nextRunAt))
      .limit(limit);
  }

  /**
   * The export, its filters and sort checked as `POST /v1/data/exports`
   * checks them: one the principal may not run is a 400 on `exporter`;
   * filters that don't parse, 400s on `filters.<field>`/`sort`; a filter on
   * a hidden field, a 403 `field_forbidden`.
   */
  private async check(
    principal: RequestPrincipal,
    exporter: string,
    filters: Record<string, string>,
    sort?: string | null,
  ) {
    if (!(await this.transfers.exportable(principal, exporter))) {
      throw invalid([
        {
          path: 'exporter',
          message: `No export named "${exporter}" you may run (GET /v1/data lists yours).`,
        },
      ]);
    }
    await this.transfers.checkExport(principal, exporter, filters, sort);
  }

  /** One at a time per owner, in one transaction: two creates at once can't both take the last place. */
  private exclusively<T>(principal: RequestPrincipal, work: () => Promise<T>) {
    return this.locks.withLock(
      `reports:${this.tenancy.tenantId()}:${principalKey(principal)}`,
      () => this.txHost.withTransaction(work),
      { wait: '10s' },
    );
  }

  /** A 400 when the principal has MAX_ACTIVE_REPORTS active reports already. */
  private async assertRoomFor(principal: RequestPrincipal) {
    const [row] = await this.db
      .select({ active: count() })
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.owner, principalKey(principal)),
          eq(reportSchedules.active, true),
        ),
      );
    if ((row?.active ?? 0) >= MAX_ACTIVE_REPORTS) {
      throw invalid([
        {
          path: 'active',
          message: `At most ${MAX_ACTIVE_REPORTS} active reports: pause or delete one first.`,
        },
      ]);
    }
  }

  private async findOwn(principal: RequestPrincipal, id: string) {
    const [row] = await this.db
      .select()
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.id, id),
          eq(reportSchedules.owner, principalKey(principal)),
        ),
      );
    if (!row) throw new NotFoundException(`Report ${id} not found.`);
    return row;
  }
}
