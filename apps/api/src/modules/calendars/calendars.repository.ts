import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { asc, count, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { MAX_CALENDARS } from './calendars.schemas.js';
import { businessCalendars } from './calendars.tables.js';

type NewCalendar = typeof businessCalendars.$inferInsert;

/** The business calendars' queries, in the caller's transaction and tenant. */
@Injectable()
export class CalendarsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async list() {
    return this.db
      .select()
      .from(businessCalendars)
      .orderBy(asc(businessCalendars.name))
      .limit(MAX_CALENDARS);
  }

  async findById(id: string) {
    const [row] = await this.db
      .select()
      .from(businessCalendars)
      .where(eq(businessCalendars.id, id));
    return row;
  }

  async count() {
    const [{ total } = { total: 0 }] = await this.db
      .select({ total: count() })
      .from(businessCalendars);
    return total;
  }

  async insert(values: NewCalendar) {
    const [row] = await this.db
      .insert(businessCalendars)
      .values(values)
      .returning();
    return row!;
  }

  async update(id: string, values: Partial<NewCalendar>) {
    const [row] = await this.db
      .update(businessCalendars)
      .set(values)
      .where(eq(businessCalendars.id, id))
      .returning();
    return row!;
  }

  async delete(id: string) {
    await this.db.delete(businessCalendars).where(eq(businessCalendars.id, id));
  }
}
