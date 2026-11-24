import { TransactionHost } from '@nestjs-cls/transactional';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { sequencesConfig } from './sequences.config.js';
import { SequencesRepository } from './sequences.repository.js';

export interface NextNumberOptions {
  /** Numbered apart: a unit's id, a client's key… Default: one series. */
  scope?: string;
  /** Starts over every year, the year in the number: `INV-2026-00042`. */
  perYear?: boolean;
  /** The moment the number is for (its year); default now. */
  at?: Date;
  /** `INV` in `INV-2026-00042`. */
  prefix?: string;
  /** Digits, zero-padded: 5 for `00042`. Default: none. */
  width?: number;
  /** Between the parts; default `-`. */
  separator?: string;
}

/** The parts of a number as text: prefix, year, the value padded. */
export function formatNumber(
  value: number,
  { prefix, width, separator = '-' }: NextNumberOptions,
  year?: string,
) {
  const digits = width ? String(value).padStart(width, '0') : String(value);
  return [prefix, year, digits].filter(Boolean).join(separator);
}

/**
 * Gapless, human-readable numbers (`INV-2026-00042`): one counter per
 * sequence name, scope and tenant, taken in the transaction of the write
 * that uses the number (a `@Transactional()` method, or
 * `TransactionHost.withTransaction()`; every method that takes a number
 * refuses to run outside one). The counter's row is locked until the
 * commit, so two writes never get the same number and a rollback leaves no
 * gap; a busy series serializes its writes on that row (the price of no
 * gaps: a UUID pays none), so number what people need numbered. Each tenant
 * numbers its own series.
 *
 * A record the tenant's administrators may format differently is numbered
 * through NamingSeriesService instead, which uses these counters.
 *
 * ```ts
 * const { formatted } = await this.sequences.next('invoice', { prefix: 'INV', perYear: true, width: 5 });
 * ```
 */
@Injectable()
export class SequencesService {
  constructor(
    private readonly repository: SequencesRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    @Inject(sequencesConfig.KEY)
    private readonly config: ConfigType<typeof sequencesConfig>,
  ) {}

  /** The next number of `name` (and scope), in the current transaction: its value, and as text. */
  async next(name: string, options: NextNumberOptions = {}) {
    this.assertTransaction();
    const year = options.perYear
      ? this.yearOf(options.at ?? new Date())
      : undefined;
    const scope = [options.scope ?? '', year ?? ''].join('|');
    const value = await this.repository.increment(name, scope);
    return { value, formatted: formatNumber(value, options, year) };
  }

  /** The last number taken (0 when none): for display, never to number with. */
  async current(
    name: string,
    options: Pick<NextNumberOptions, 'scope' | 'perYear' | 'at'> = {},
  ) {
    const year = options.perYear
      ? this.yearOf(options.at ?? new Date())
      : undefined;
    const scope = [options.scope ?? '', year ?? ''].join('|');
    return Number((await this.repository.valueOf(name, scope)) ?? 0);
  }

  /**
   * The next value of a naming series' counter (`key`: what its pattern
   * prints around the counter, naming-pattern.ts), locked until the commit
   * like `next()`. `carryFrom`: the scope of the counter a declared format
   * used before naming series; a key's first number continues from it, so
   * `NOTE-2026-00042` is followed by `00043`, never by a second `00001`.
   */
  async take(
    name: string,
    key: string,
    { carryFrom }: { carryFrom?: string } = {},
  ) {
    this.assertTransaction();
    // Without a counter to carry on, the first row holds 1.
    return carryFrom
      ? this.repository.incrementFrom(name, key, carryFrom)
      : this.repository.increment(name, key);
  }

  /** A naming series counter's last value (0 when none), `carryFrom` as in `take()`. */
  async peek(name: string, key: string, options: { carryFrom?: string } = {}) {
    const [value] = await this.peekMany([{ name, key, ...options }]);
    return value!;
  }

  /** `peek()` of many counters, in one query: their values in order. */
  async peekMany(
    counters: readonly { name: string; key: string; carryFrom?: string }[],
  ) {
    const wanted = counters.flatMap(({ name, key, carryFrom }) =>
      [key, carryFrom]
        .filter((scope) => scope !== undefined)
        .map((scope) => ({ name, scope })),
    );
    const rows = await this.repository.values(wanted);
    const valueOf = (name: string, scope?: string) =>
      rows.find((row) => row.name === name && row.scope === scope)?.value;
    return counters.map(({ name, key, carryFrom }) =>
      Number(valueOf(name, key) ?? valueOf(name, carryFrom) ?? 0),
    );
  }

  /**
   * Sets a naming series counter's last value: the next number is
   * `value + 1`. Never below the last value taken (a number is never given
   * twice): `set: false`, and nothing changed, when it would be. `before`:
   * the last value taken.
   */
  async setAtLeast(
    name: string,
    key: string,
    value: number,
    { carryFrom }: { carryFrom?: string } = {},
  ) {
    this.assertTransaction();
    // The row's lock first: a number taken meanwhile is counted.
    const locked = await this.repository.lockValue(name, key);
    const current = locked ?? (await this.peek(name, key, { carryFrom }));
    if (value < current) {
      return { set: false, before: current };
    }
    const set = await this.repository.setIfNotPast(name, key, value);
    return { set, before: current };
  }

  /** The row lock that makes numbers gapless lasts until the commit: outside a transaction it would end at once. */
  private assertTransaction() {
    if (!this.txHost.isTransactionActive()) {
      throw new Error(
        'A number is taken inside a transaction: use @Transactional() or TransactionHost.withTransaction().',
      );
    }
  }

  /** The year of a moment in SEQUENCES_TIMEZONE: a series restarts at that zone's new year. */
  private yearOf(at: Date) {
    return new Intl.DateTimeFormat('en', {
      timeZone: this.config.timezone,
      year: 'numeric',
    }).format(at);
  }
}
