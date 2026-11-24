import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, lte, max, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { exchangeRates } from './money.tables.js';

/**
 * The exchange rates' queries (a global table), in the caller's
 * transaction (`@InjectTransaction()`).
 */
@Injectable()
export class ExchangeRatesRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The newest day of `source` on or before `onOrBefore` (any, without it). */
  async newestDay(source: string, onOrBefore?: string) {
    const [row] = await this.db
      .select({ day: max(exchangeRates.day) })
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.source, source),
          onOrBefore === undefined
            ? undefined
            : lte(exchangeRates.day, onOrBefore),
        ),
      );
    return row?.day ?? null;
  }

  /** A day's rates, by currency. */
  ratesOf(source: string, day: string) {
    return this.db
      .select({
        base: exchangeRates.base,
        currency: exchangeRates.currency,
        rate: exchangeRates.rate,
      })
      .from(exchangeRates)
      .where(and(eq(exchangeRates.source, source), eq(exchangeRates.day, day)))
      .orderBy(exchangeRates.currency);
  }

  /** The newest day on or before `day` that has a rate for every one of `currencies`. */
  async newestDayWith(
    source: string,
    base: string,
    day: string,
    currencies: string[],
  ) {
    const [found] = await this.db
      .select({ day: exchangeRates.day })
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.source, source),
          eq(exchangeRates.base, base),
          lte(exchangeRates.day, day),
          inArray(exchangeRates.currency, currencies),
        ),
      )
      .groupBy(exchangeRates.day)
      .having(eq(count(), currencies.length))
      .orderBy(desc(exchangeRates.day))
      .limit(1);
    return found?.day;
  }

  /** These currencies' rates of a day. */
  ratesFor(source: string, day: string, currencies: string[]) {
    return this.db
      .select({ currency: exchangeRates.currency, rate: exchangeRates.rate })
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.source, source),
          eq(exchangeRates.day, day),
          inArray(exchangeRates.currency, currencies),
        ),
      );
  }

  /** Inserts these rates, or updates a changed one; how many rows were written. */
  async upsert(rows: (typeof exchangeRates.$inferInsert)[]) {
    let written = 0;
    // In batches: a parameter list has its limits.
    for (let start = 0; start < rows.length; start += 1000) {
      const changed = await this.db
        .insert(exchangeRates)
        .values(rows.slice(start, start + 1000))
        .onConflictDoUpdate({
          target: [
            exchangeRates.source,
            exchangeRates.day,
            exchangeRates.currency,
          ],
          set: {
            rate: sql`excluded.rate`,
            base: sql`excluded.base`,
            updatedAt: new Date(),
          },
          // Only a changed rate is a write (an hourly refetch of the same day is none).
          setWhere: sql`${exchangeRates.rate} <> excluded.rate or ${exchangeRates.base} <> excluded.base`,
        })
        .returning({ id: exchangeRates.id });
      written += changed.length;
    }
    return written;
  }
}
