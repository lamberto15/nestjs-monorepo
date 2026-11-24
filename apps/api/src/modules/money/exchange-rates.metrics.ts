import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { moneyConfig } from './money.config.js';
import { ECB, ExchangeRatesService } from './exchange-rates.service.js';

/**
 * How old the newest ECB rates are, a gauge of core/metrics: seconds since
 * the start (00:00 UTC) of the newest stored day. Normally under a day and
 * a half on weekdays, about four days on a Monday morning; it keeps growing
 * while ExchangeRatesJob can't fetch (the ExchangeRatesStale alert).
 * As old as the Unix epoch while nothing was ever stored. Absent with EXCHANGE_RATES_FETCH=off.
 * Shared state: every instance reports the same, aggregate with max().
 */
@Injectable()
export class ExchangeRatesMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly rates: ExchangeRatesService,
    @Inject(moneyConfig.KEY)
    private readonly config: ConfigType<typeof moneyConfig>,
  ) {}

  onModuleInit() {
    if (!this.config.fetchRates) {
      return;
    }
    this.metrics.collect(
      'exchange_rates_age_seconds',
      'Seconds since the start (00:00 UTC) of the newest stored ECB reference rates day (since 1970 when there are none yet).',
      async () => {
        const newest = await this.rates.newestDay(ECB.source);
        // None yet: as old as the Unix epoch, not +Inf, which OTLP's JSON
        // encoding cannot carry (it becomes null).
        const day = newest ? Date.parse(`${newest}T00:00:00Z`) : 0;
        return [{ value: (Date.now() - day) / 1000 }];
      },
      's',
    );
  }
}
