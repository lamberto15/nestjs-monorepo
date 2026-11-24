import { TransactionHost } from '@nestjs-cls/transactional';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Locks } from '@nestjs/locks';
import type { Queue } from 'bullmq';
import type { DatabaseTransactions } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { toPage } from '../../core/http/pagination.js';
import { onceJob } from '../../core/queues/queues.js';
import { withTenant } from '../../core/tenancy/tenant-job.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type RequestPrincipal,
  type SystemPrincipal,
} from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import type { BusinessCalendarRow } from '../calendars/calendars.tables.js';
import { CalendarsService } from '../calendars/calendars.service.js';
import { RECORD_SCHEDULE_JOB } from './recurrence.permissions.js';
import {
  type CreateRecordScheduleDto,
  MAX_ACTIVE_SCHEDULES,
  type PreviewRecordScheduleDto,
  type UpdateRecordScheduleDto,
} from './recurrence.schemas.js';
import { RecurrenceRepository } from './recurrence.repository.js';
import type { RecordScheduleRow } from './recurrence.tables.js';
import { ScheduleTargets } from './recurrence.targets.js';
import {
  nextOccurrence,
  parseRule,
  type RecurrenceSchedule,
} from './recurrence-rule.js';

export const RECORD_SCHEDULE_QUEUE = 'record-schedules';

/** An occurrence that fails this many times (a pass every five minutes) is skipped. */
export const MAX_ATTEMPTS = 3;
/** At most this many schedules are looked at in one pass; the rest wait for the next. */
const BATCH = 500;
/** At most this many occurrences of one schedule are made in one pass (making up missed ones). */
export const MAX_PER_PASS = 10;

/** The scheduler's interval (RecurrenceScheduler, every five minutes): one job per tenant in each. */
const PASS_MS = 5 * 60_000;

const view = (row: RecordScheduleRow) => ({
  id: row.id,
  name: row.name,
  target: row.target,
  template: row.template,
  rrule: row.rrule,
  startDate: row.startDate,
  time: row.time,
  timezone: row.timezone,
  calendarId: row.calendarId,
  status: row.status,
  endReason: row.endReason,
  occurrences: row.occurrences,
  maxOccurrences: row.maxOccurrences,
  failures: row.failures,
  lastError: row.lastError,
  lastRunAt: row.lastRunAt?.toISOString() ?? null,
  lastStatus: row.lastStatus,
  nextRunAt: row.nextRunAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/** What a runner pass did with one schedule. */
export type RunOutcome = 'created' | 'skipped' | 'failed' | 'ended' | 'idle';

/**
 * Recurring record schedules: a template (a row of a schedule target) that
 * creates a record, as its owner, at each occurrence of an RRULE-style
 * rule on the wall clock of a time zone, optionally moved into a business
 * calendar's working time. Each principal sees and changes only their own.
 * Audited as `recordSchedule.created`, `.updated`, `.deleted`; the runner's
 * `.ran`, `.skipped`, `.ended`. `runTenant()` (queued every five minutes by
 * RecurrenceScheduler) creates what is due; an occurrence is created once
 * however often it is tried (`runDue()`).
 */
@Injectable()
export class RecurrenceService {
  private readonly logger = new Logger(RecurrenceService.name);

  constructor(
    private readonly repository: RecurrenceRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    @InjectQueue(RECORD_SCHEDULE_QUEUE) private readonly queue: Queue,
    private readonly targets: ScheduleTargets,
    private readonly calendars: CalendarsService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly users: UsersRepository,
    private readonly tenancy: Tenancy,
    private readonly locks: Locks,
  ) {}

  async page(principal: RequestPrincipal, query: ListQuery) {
    const [rows, total] = await this.repository.page(
      principalKey(principal),
      query,
    );
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(view) };
  }

  async get(principal: RequestPrincipal, id: string) {
    return view(await this.findOwn(principal, id));
  }

  /** The next moments records would be created, from now. */
  async preview(dto: PreviewRecordScheduleDto, principal: RequestPrincipal) {
    const calendar = await this.calendar(dto.calendarId);
    const schedule = this.schedule(principal, dto);
    const rule = parseRule(dto.rrule);
    const occurrences: string[] = [];
    let after = new Date();
    while (occurrences.length < Math.min(dto.count, rule.count ?? dto.count)) {
      const next = this.nextRun(schedule, calendar, after);
      if (!next) break;
      occurrences.push(next.toISOString());
      after = next;
    }
    return { occurrences };
  }

  async create(
    principal: RequestPrincipal,
    dto: CreateRecordScheduleDto,
    ip?: string,
  ) {
    this.notImpersonating(principal);
    await this.check(principal, dto.target, dto.template);
    const calendar = await this.calendar(dto.calendarId);
    const timezone = this.zone(principal, dto.timezone);
    const rule = parseRule(dto.rrule);
    const next = this.nextRun(
      { rule, startDate: dto.startDate, time: dto.time, timezone },
      calendar,
      new Date(),
    );
    if (!next) {
      throw invalid([
        { path: 'rrule', message: 'It has no occurrence to come.' },
      ]);
    }
    const row = await this.exclusively(principal, async () => {
      await this.assertRoomFor(principal);
      const created = await this.repository.insert({
        owner: principalKey(principal),
        name: dto.name,
        target: dto.target,
        template: dto.template,
        rrule: dto.rrule,
        startDate: dto.startDate,
        time: dto.time,
        timezone,
        calendarId: dto.calendarId ?? null,
        maxOccurrences: rule.count,
        nextRunAt: next,
      });
      await this.audit.record(principal, {
        action: 'recordSchedule.created',
        targetType: 'recordSchedule',
        targetId: created.id,
        details: { name: created.name, target: created.target },
        ip,
      });
      return created;
    });
    return view(row);
  }

  /**
   * Only what is sent changes; an active schedule's next run is computed
   * again from now when its rule, start, time, zone or calendar changes.
   */
  async update(
    principal: RequestPrincipal,
    id: string,
    dto: UpdateRecordScheduleDto,
    ip?: string,
  ) {
    this.notImpersonating(principal);
    const before = await this.findOwn(principal, id);
    this.notEnded(before);
    const values = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as UpdateRecordScheduleDto;
    if (Object.keys(values).length === 0) {
      return view(before);
    }
    if (values.template !== undefined) {
      await this.check(principal, before.target, values.template);
    }
    const merged = { ...before, ...values };
    const calendar = await this.calendar(merged.calendarId ?? undefined);
    const rule = parseRule(merged.rrule);
    const timing = ['rrule', 'startDate', 'time', 'timezone', 'calendarId'];
    const retime = timing.some((key) => key in values);
    let nextRunAt = before.nextRunAt;
    if (retime && before.status === 'active') {
      nextRunAt = this.nextRun(
        {
          rule,
          startDate: merged.startDate,
          time: merged.time,
          timezone: merged.timezone,
        },
        calendar,
        new Date(),
      );
      if (!nextRunAt) {
        throw invalid([
          { path: 'rrule', message: 'It has no occurrence to come.' },
        ]);
      }
    }
    const row = await this.txHost.withTransaction(async () => {
      const updated = await this.repository.update(id, {
        ...values,
        maxOccurrences: rule.count,
        nextRunAt,
        ...(retime && { failures: 0, lastError: null }),
      });
      await this.audit.record(principal, {
        action: 'recordSchedule.updated',
        targetType: 'recordSchedule',
        targetId: id,
        details: { changed: Object.keys(values) },
        ip,
      });
      return updated;
    });
    return view(row);
  }

  async remove(principal: RequestPrincipal, id: string, ip?: string) {
    const before = await this.findOwn(principal, id);
    await this.txHost.withTransaction(async () => {
      await this.repository.delete(id);
      await this.audit.record(principal, {
        action: 'recordSchedule.deleted',
        targetType: 'recordSchedule',
        targetId: id,
        details: { name: before.name, target: before.target },
        ip,
      });
    });
  }

  /** Stops creating until resumed; the occurrences in between are not made up. */
  async pause(principal: RequestPrincipal, id: string, ip?: string) {
    const before = await this.findOwn(principal, id);
    this.notEnded(before);
    if (before.status === 'paused') return view(before);
    return this.setStatus(principal, before, 'paused', { nextRunAt: null }, ip);
  }

  /** Picks up at the next occurrence after now. */
  async resume(principal: RequestPrincipal, id: string, ip?: string) {
    this.notImpersonating(principal);
    const before = await this.findOwn(principal, id);
    this.notEnded(before);
    if (before.status === 'active') return view(before);
    const next = this.nextRun(
      this.scheduleOf(before),
      await this.calendar(before.calendarId ?? undefined),
      new Date(),
    );
    if (!next) {
      return this.setStatus(
        principal,
        before,
        'ended',
        { nextRunAt: null, endReason: 'completed' },
        ip,
      );
    }
    return this.exclusively(principal, async () => {
      await this.assertRoomFor(principal);
      return this.setStatus(
        principal,
        before,
        'active',
        { nextRunAt: next, failures: 0, lastError: null },
        ip,
      );
    });
  }

  /** Ends it for good; the records it made stay. */
  async end(principal: RequestPrincipal, id: string, ip?: string) {
    const before = await this.findOwn(principal, id);
    if (before.status === 'ended') return view(before);
    return this.setStatus(
      principal,
      before,
      'ended',
      { nextRunAt: null, endReason: 'ended' },
      ip,
    );
  }

  /**
   * Queues one job for the current tenant when a schedule of it is due:
   * what the scheduler runs in every tenant. Returns whether it did.
   */
  async queueIfDue(now: Date) {
    if (!(await this.repository.anyDue(now))) return false;
    const job = withTenant({});
    // From the tenant and the pass: the pass run again queues nothing new.
    const pass = Math.floor(now.getTime() / PASS_MS);
    await this.queue.add(
      'run',
      job,
      onceJob(`record-schedules-${job.tenantId}-${pass}`),
    );
    return true;
  }

  /** The tenants of the scheduler's pass; returns how many jobs it queued. */
  async queueDue(now = new Date()) {
    const queued = await this.tenancy.forEachTenant(
      RECORD_SCHEDULE_JOB.key,
      () => this.queueIfDue(now),
    );
    return [...queued.values()].filter(Boolean).length;
  }

  /**
   * The due schedules of the current tenant, oldest first, each made up to
   * MAX_PER_PASS occurrences at a time (the rest wait for the next pass).
   * Returns how many records it created. `now` lets a test choose the moment.
   */
  async runTenant(system: SystemPrincipal, now = new Date()) {
    const due = await this.repository.dueIds(now, BATCH);
    let created = 0;
    for (const id of due) {
      for (let made = 0; made < MAX_PER_PASS; made++) {
        const outcome = await this.runDue(id, now, system);
        if (outcome === 'created') created++;
        // Failed, ended, or nothing due (any more): the next pass.
        if (outcome !== 'created' && outcome !== 'skipped') break;
      }
    }
    this.logger.log('Recurring records created', {
      tenant: this.tenancy.tenantId(),
      due: due.length,
      created,
    });
    return created;
  }

  /**
   * Creates the record of the schedule's due occurrence, if there is one,
   * and moves the schedule to the next. Safe to call again and from many
   * workers at once:
   *
   * - one transaction holds the schedule row (`FOR UPDATE SKIP LOCKED`: a
   *   second worker finds it taken and does nothing);
   * - the occurrence's moment is inserted into `record_schedule_runs`
   *   (unique per schedule and moment) before the record is written, so
   *   not even a schedule reset to an earlier moment can create it twice;
   * - the record, that row and the move to the next occurrence commit
   *   together or not at all, so a crash or an error leaves the occurrence
   *   due, to be tried again.
   *
   * The owner is looked up again (an inactive one ends the schedule), and
   * may still create the kind of record; the template is checked again as
   * the target's schema is now. Failures are counted: the third in a row
   * skips the occurrence (`skipped` in the runs) and goes on to the next.
   */
  async runDue(
    id: string,
    now: Date,
    system: SystemPrincipal,
  ): Promise<RunOutcome> {
    let due: RecordScheduleRow | undefined;
    try {
      return await this.txHost.withTransaction(async () => {
        const row = await this.repository.lock(id, { skipLocked: true });
        if (
          !row ||
          row.status !== 'active' ||
          !row.nextRunAt ||
          row.nextRunAt > now
        ) {
          return 'idle';
        }
        due = row;
        const owner = await this.owner(row);
        if (!owner) return this.stop(row, 'owner_inactive', system);
        const target = this.targets.find(row.target);
        if (
          !target ||
          !(await this.access.can(
            owner,
            target.action ?? 'create',
            target.subject,
          ))
        ) {
          return this.stop(row, 'import_not_allowed', system);
        }
        const parsed = target.schema.safeParse(row.template);
        if (!parsed.success) return this.stop(row, 'template_invalid', system);
        const claimed = await this.repository.insertRun({
          scheduleId: row.id,
          occurrenceAt: row.nextRunAt,
          status: 'created',
        });
        if (claimed) {
          await target.create(owner, parsed.data);
          await this.audit.record(system, {
            action: 'recordSchedule.ran',
            targetType: 'recordSchedule',
            targetId: row.id,
            details: {
              occurrence: row.nextRunAt.toISOString(),
              target: row.target,
            },
          });
        }
        await this.advance(row, now, { lastStatus: 'created' });
        return 'created';
      });
    } catch (error) {
      if (!due) throw error; // before there was anything to run: not ours to hide
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('A recurring record could not be created', {
        schedule: id,
        error: message,
      });
      return this.fail(id, due, now, message, system);
    }
  }

  /** Counts a failed attempt at `due`'s occurrence; the last allowed skips it. */
  private fail(
    id: string,
    due: RecordScheduleRow,
    now: Date,
    message: string,
    system: SystemPrincipal,
  ) {
    return this.txHost.withTransaction(async (): Promise<RunOutcome> => {
      const row = await this.repository.lock(id);
      // Changed, paused or taken meanwhile: that attempt is not this one's to count.
      if (
        !row ||
        row.status !== 'active' ||
        row.nextRunAt?.getTime() !== due.nextRunAt?.getTime()
      ) {
        return 'idle';
      }
      const error = message.slice(0, 500);
      const failures = row.failures + 1;
      if (failures < MAX_ATTEMPTS) {
        await this.repository.update(id, {
          failures,
          lastError: error,
          lastStatus: 'failed',
          lastRunAt: now,
        });
        return 'failed';
      }
      await this.repository.insertRun({
        scheduleId: id,
        occurrenceAt: row.nextRunAt!,
        status: 'skipped',
        error,
      });
      await this.audit.record(system, {
        action: 'recordSchedule.skipped',
        targetType: 'recordSchedule',
        targetId: id,
        details: { occurrence: row.nextRunAt!.toISOString(), error },
      });
      await this.advance(row, now, { lastStatus: 'failed', lastError: error });
      return 'skipped';
    });
  }

  /** Counts the handled occurrence and moves to the next, or ends the schedule. */
  private async advance(
    row: RecordScheduleRow,
    now: Date,
    result: { lastStatus: 'created' | 'failed'; lastError?: string },
  ) {
    const occurrences = row.occurrences + 1;
    const next =
      row.maxOccurrences !== null && occurrences >= row.maxOccurrences
        ? null
        : this.nextRun(
            this.scheduleOf(row),
            await this.calendar(row.calendarId ?? undefined),
            row.nextRunAt!,
          );
    await this.repository.update(row.id, {
      occurrences,
      failures: 0,
      lastRunAt: now,
      lastStatus: result.lastStatus,
      lastError: result.lastError ?? null,
      nextRunAt: next,
      ...(!next && { status: 'ended' as const, endReason: 'completed' }),
    });
  }

  /** Ends a schedule that can no longer run, and says why. */
  private async stop(
    row: RecordScheduleRow,
    reason: string,
    system: SystemPrincipal,
  ): Promise<RunOutcome> {
    await this.repository.update(row.id, {
      status: 'ended',
      endReason: reason,
      nextRunAt: null,
    });
    await this.audit.record(system, {
      action: 'recordSchedule.ended',
      targetType: 'recordSchedule',
      targetId: row.id,
      details: { owner: row.owner, reason },
    });
    return 'ended';
  }

  /**
   * The owner as they are now, acting in the schedule's tenant; null when
   * they no longer can (a user whose account or membership is inactive, a
   * client that is gone or deactivated).
   */
  private async owner(
    row: RecordScheduleRow,
  ): Promise<RequestPrincipal | null> {
    const [kind, id] = row.owner.split(':') as [string, string];
    if (kind === 'user') {
      return this.users.inTenant(id, row.tenantId);
    }
    if (kind !== 'client') return null;
    const client = await this.repository.findClient(id);
    return client?.active
      ? { kind: 'client', id, name: client.name, tenantId: row.tenantId }
      : null;
  }

  private scheduleOf(row: RecordScheduleRow): RecurrenceSchedule {
    return {
      rule: parseRule(row.rrule),
      startDate: row.startDate,
      time: row.time,
      timezone: row.timezone,
    };
  }

  private schedule(
    principal: RequestPrincipal,
    dto: { rrule: string; startDate: string; time: string; timezone?: string },
  ): RecurrenceSchedule {
    return {
      rule: parseRule(dto.rrule),
      startDate: dto.startDate,
      time: dto.time,
      timezone: this.zone(principal, dto.timezone),
    };
  }

  private zone(principal: RequestPrincipal, timezone?: string) {
    return (
      timezone ??
      (principal.kind === 'user' ? principal.timezone : null) ??
      'UTC'
    );
  }

  /**
   * The occurrence after `after`, moved into the calendar's working time
   * when there is one. Strictly after, so occurrences that land on one
   * working moment make one record.
   */
  private nextRun(
    schedule: RecurrenceSchedule,
    calendar: BusinessCalendarRow | null,
    after: Date,
  ) {
    const next = nextOccurrence(schedule, after);
    return next && calendar
      ? this.calendars.addWorkingMinutes(calendar, next, 0)
      : next;
  }

  private async calendar(id?: string | null) {
    if (!id) return null;
    try {
      return await this.calendars.row(id);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw invalid([{ path: 'calendarId', message: 'No such calendar.' }]);
      }
      throw error;
    }
  }

  /** A schedule creates records later, unobserved: never for an impersonated user. */
  private notImpersonating(principal: RequestPrincipal) {
    if (principal.kind === 'user' && principal.impersonator) {
      throw new ForbiddenException(
        'A session impersonating a user cannot set up recurring records.',
      );
    }
  }

  private notEnded(row: RecordScheduleRow) {
    if (row.status === 'ended') {
      throw new ConflictException('The schedule has ended.');
    }
  }

  /** The target exists, the principal may create its records, and the template is one of its rows. */
  private async check(
    principal: RequestPrincipal,
    targetName: string,
    template: Record<string, unknown>,
  ) {
    const target = this.targets.find(targetName);
    const action = target?.action ?? 'create';
    if (
      !target ||
      !(await this.access.can(principal, action, target.subject))
    ) {
      throw invalid([
        {
          path: 'target',
          message: `No schedule target named "${targetName}" you may use.`,
        },
      ]);
    }
    const parsed = target.schema.safeParse(template);
    if (!parsed.success) {
      throw invalid(
        parsed.error.issues.map((issue) => ({
          path: ['template', ...issue.path].join('.'),
          message: issue.message,
        })),
      );
    }
    const forbidden = await this.access.forbiddenFields(
      principal,
      action,
      target.subject,
      template,
    );
    if (forbidden.length > 0) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `Your permissions do not let you set: ${forbidden.join(', ')}.`,
        fields: forbidden,
      });
    }
  }

  /** One at a time per owner, in one transaction: two creates at once can't both take the last place. */
  private exclusively<T>(principal: RequestPrincipal, work: () => Promise<T>) {
    return this.locks.withLock(
      `record-schedules:${this.tenancy.tenantId()}:${principalKey(principal)}`,
      () => this.txHost.withTransaction(work),
      { wait: '10s' },
    );
  }

  /** A 400 when the principal has MAX_ACTIVE_SCHEDULES active schedules already. */
  private async assertRoomFor(principal: RequestPrincipal) {
    if (
      (await this.repository.countActiveOf(principalKey(principal))) >=
      MAX_ACTIVE_SCHEDULES
    ) {
      throw invalid([
        {
          path: 'status',
          message: `At most ${MAX_ACTIVE_SCHEDULES} active schedules: pause or end one first.`,
        },
      ]);
    }
  }

  private async setStatus(
    principal: RequestPrincipal,
    before: RecordScheduleRow,
    status: RecordScheduleRow['status'],
    set: Partial<RecordScheduleRow>,
    ip?: string,
  ) {
    const row = await this.txHost.withTransaction(async () => {
      const updated = await this.repository.update(before.id, {
        status,
        ...set,
      });
      await this.audit.record(principal, {
        action: 'recordSchedule.updated',
        targetType: 'recordSchedule',
        targetId: before.id,
        details: { status, from: before.status },
        ip,
      });
      return updated;
    });
    return view(row);
  }

  private async findOwn(principal: RequestPrincipal, id: string) {
    const row = await this.repository.findOwn(principalKey(principal), id);
    if (!row) {
      throw new NotFoundException(`Recurring schedule ${id} not found.`);
    }
    return row;
  }
}
