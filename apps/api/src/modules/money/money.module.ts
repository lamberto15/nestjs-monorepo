import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { HttpClientModule } from '@nestjs/http-client';
import { SharedHttpClientModule } from '../../core/http-client/http-client.module.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { ECB_RATES, ExchangeRatesJob } from './exchange-rates.job.js';
import { ExchangeRatesMetrics } from './exchange-rates.metrics.js';
import { ExchangeRatesService } from './exchange-rates.service.js';
import { moneyConfig } from './money.config.js';
import { MoneyController } from './money.controller.js';
import { MONEY_PERMISSIONS } from './money.permissions.js';
// The library's errors as problem details.
import './money.errors.js';

/**
 * Exchange rates and their routes (README.md). The library (`Money`,
 * `formatMoney()`, `moneyColumns()`, the Zod schemas) is plain code
 * features import; this module adds the table, the job that fetches the
 * ECB's rates, the service that converts (exported), `/v1/money/rates` and
 * `/v1/money/convert`. Needs DatabaseModule, SharedLocksModule (the job's
 * schedule), MetricsModule and AuthModule.
 */
@Module({
  imports: [
    ConfigModule.forFeature(moneyConfig),
    AccessModule.forFeature(MONEY_PERMISSIONS),
    SharedHttpClientModule,
    // The ECB's eurofxref documents; GETs are retried on network errors and 5xx.
    HttpClientModule.registerAsync({
      name: ECB_RATES,
      imports: [ConfigModule.forFeature(moneyConfig)],
      inject: [moneyConfig.KEY],
      useFactory: (config: ConfigType<typeof moneyConfig>) => ({
        baseUrl: config.ecbUrl,
        timeout: '20s',
      }),
    }),
  ],
  controllers: [MoneyController],
  providers: [ExchangeRatesService, ExchangeRatesJob, ExchangeRatesMetrics],
  exports: [ExchangeRatesService],
})
export class MoneyModule {}
