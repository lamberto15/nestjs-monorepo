import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, count, eq } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  addWorkingMinutes,
  type CalendarDefinition,
  NoWorkingTimeError,
} from './calendar-time.js';
import {
  type CreateCalendarDto,
  MAX_CALENDARS,
  type UpdateCalendarDto,
} from './calendars.schemas.js';
import {
  type BusinessCalendarRow,
  businessCalendars,
} from './calendars.tables.js';

/** JSON with sorted keys: jsonb returns an object's keys in its own order. */
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );

const view = (row: BusinessCalendarRow) => ({
  id: row.id,
  name: row.name,
  timezone: row.timezone,
  hours: row.hours,
  exceptions: row.exceptions,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Business calendars: the working hours, time zone and holidays of a
 * tenant, and the one deadline calculation everything that counts working
 * time shares (`deadline()`; the math is calendar-time.ts). Any change to
 * what moves a deadline bumps the calendar's `version`; a deadline already
 * computed is not touched. Audited as `businessCalendar.created`,
 * `.updated` (what changed) and `.deleted`.
 */
@Injectable()
export class CalendarsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.db
      .select()
      .from(businessCalendars)
      .orderBy(asc(businessCalendars.name))
      .limit(MAX_CALENDARS);
    return { items: rows.map(view) };
  }

  async findOne(id: string) {
    return view(await this.row(id));
  }

  /** The calendar of the current tenant, for deadline math; 404 when it is none of the tenant's. */
  async row(id: string) {
    const [row] = await this.db
      .select()
      .from(businessCalendars)
      .where(eq(businessCalendars.id, id));
    if (!row) {
      throw new NotFoundException(`Calendar ${id} not found.`);
    }
    return row;
  }

  async create(principal: Principal, dto: CreateCalendarDto, ip?: string) {
    const row = await this.txHost
      .withTransaction(async () => {
        const [{ total } = { total: 0 }] = await this.db
          .select({ total: count() })
          .from(businessCalendars);
        if (total >= MAX_CALENDARS) {
          throw new BadRequestException({
            code: 'validation_failed',
            message: `At most ${MAX_CALENDARS} calendars.`,
          });
        }
        const [created] = await this.db
          .insert(businessCalendars)
          .values(dto)
          .returning();
        await this.audit.record(principal, {
          action: 'businessCalendar.created',
          targetType: 'businessCalendar',
          targetId: created!.id,
          details: { name: created!.name, timezone: created!.timezone },
          ip,
        });
        return created!;
      })
      .catch((error: unknown) => {
        throw nameTaken(error, dto.name);
      });
    return view(row);
  }

  /**
   * Only what is sent, and differs, changes. A change of hours, zone or
   * exceptions makes the next version; a rename does not.
   */
  async update(
    principal: Principal,
    id: string,
    dto: UpdateCalendarDto,
    ip?: string,
  ) {
    const before = await this.row(id);
    const changed = (
      ['name', 'timezone', 'hours', 'exceptions'] as const
    ).filter(
      (key) =>
        dto[key] !== undefined && stable(dto[key]) !== stable(before[key]),
    );
    if (changed.length === 0) {
      return view(before);
    }
    const moves = changed.some((key) => key !== 'name');
    const row = await this.txHost
      .withTransaction(async () => {
        const [updated] = await this.db
          .update(businessCalendars)
          .set({
            ...Object.fromEntries(changed.map((key) => [key, dto[key]])),
            ...(moves && { version: before.version + 1 }),
          })
          .where(eq(businessCalendars.id, id))
          .returning();
        await this.audit.record(principal, {
          action: 'businessCalendar.updated',
          targetType: 'businessCalendar',
          targetId: id,
          details: { changed, version: updated!.version },
          ip,
        });
        return updated!;
      })
      .catch((error: unknown) => {
        throw nameTaken(error, dto.name ?? before.name);
      });
    return view(row);
  }

  /** Refused while a recurring schedule follows it (its foreign key restricts). */
  async remove(principal: Principal, id: string, ip?: string) {
    const before = await this.row(id);
    await this.txHost
      .withTransaction(async () => {
        await this.db
          .delete(businessCalendars)
          .where(eq(businessCalendars.id, id));
        await this.audit.record(principal, {
          action: 'businessCalendar.deleted',
          targetType: 'businessCalendar',
          targetId: id,
          details: { name: before.name },
          ip,
        });
      })
      .catch((error: unknown) => {
        throw databaseErrorKind(error) === 'foreign_key_violation'
          ? new ConflictException('A recurring schedule still follows it.')
          : error;
      });
  }

  /**
   * The reusable deadline calculation: `minutes` of working time after
   * `from` (0: the first working moment at or after it), with the
   * calendar's version, for the caller to store beside the deadline.
   */
  async deadline(id: string, from: Date, minutes: number) {
    const calendar = await this.row(id);
    return {
      due: this.addWorkingMinutes(calendar, from, minutes).toISOString(),
      calendarVersion: calendar.version,
    };
  }

  /** The math on a row already in hand; a calendar with no working time is a 400. */
  addWorkingMinutes(calendar: CalendarDefinition, from: Date, minutes: number) {
    try {
      return addWorkingMinutes(calendar, from, minutes);
    } catch (error) {
      if (error instanceof NoWorkingTimeError) {
        throw new BadRequestException({
          code: 'calendar_has_no_working_time',
          message: error.message,
        });
      }
      throw error;
    }
  }
}

const nameTaken = (error: unknown, name: string) =>
  databaseErrorKind(error) === 'unique_violation'
    ? new ConflictException(`A calendar is named "${name}".`)
    : error;
