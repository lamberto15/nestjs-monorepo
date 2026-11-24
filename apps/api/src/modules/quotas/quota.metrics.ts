import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Database } from '../../core/database/database.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { QuotaRegistration, type StockQuota } from './quota.js';
import { QuotasService } from './quotas.service.js';

/** The quota whose use is the storage gauges (attachments' `storageBytes`). */
const STORAGE_KEY = 'storageBytes';
/** A collection every few seconds reads every tenant once per this long. */
const TTL_MS = 30_000;

interface Reading {
  tenant: string;
  used: number;
  limit: number | null;
}

/**
 * `tenant_storage_bytes{tenant}` and `tenant_storage_limit_bytes{tenant}` (core/metrics):
 * what each active tenant stores and the limit it has (only
 * tenants with one), the `storageBytes` stock quota some module registers.
 * Without that quota there are no gauges. Each tenant is read in its own
 * scope, the reading kept for 30 seconds. Shared state: every instance
 * reports the same, aggregate with max().
 */
@Injectable()
export class QuotaMetrics implements OnModuleInit {
  private readonly logger = new Logger(QuotaMetrics.name);
  private cached?: { at: number; readings: Promise<Reading[]> };

  constructor(
    private readonly metrics: MetricsService,
    private readonly discovery: DiscoveryService,
    private readonly tenancy: Tenancy,
    private readonly quotas: QuotasService,
    @InjectTransaction() private readonly db: Database,
  ) {}

  onModuleInit() {
    const quota = this.storageQuota();
    if (!quota) {
      return;
    }
    this.metrics.collect(
      'tenant_storage_bytes',
      'Bytes of files a tenant stores.',
      async () =>
        (await this.read(quota)).map(({ tenant, used }) => ({
          labels: { tenant },
          value: used,
        })),
      'By',
    );
    this.metrics.collect(
      'tenant_storage_limit_bytes',
      'The storage limit of a tenant (only tenants that have one).',
      async () =>
        (await this.read(quota)).flatMap(({ tenant, limit }) =>
          limit === null ? [] : [{ labels: { tenant }, value: limit }],
        ),
      'By',
    );
  }

  /** The `storageBytes` quota, if a module registered it (a registration is in the module that owns the quota). */
  private storageQuota(): StockQuota | undefined {
    for (const wrapper of this.discovery.getProviders()) {
      if (wrapper.instance instanceof QuotaRegistration) {
        const found = wrapper.instance.quotas.find(
          (quota) => quota.key === STORAGE_KEY,
        );
        if (found?.kind === 'stock') return found;
      }
    }
    return undefined;
  }

  private read(quota: StockQuota) {
    if (!this.cached || Date.now() - this.cached.at > TTL_MS) {
      const readings = this.measure(quota);
      this.cached = { at: Date.now(), readings };
      // A failed reading is not kept: the next collection asks again.
      readings.catch((error: unknown) => {
        this.cached = undefined;
        this.logger.warn(`Storage gauges not read: ${String(error)}`);
      });
    }
    return this.cached.readings;
  }

  private async measure(quota: StockQuota) {
    const readings: Reading[] = [];
    await this.tenancy.forEachTenant('quotas.metrics', async (tenant) => {
      readings.push({
        tenant: tenant.slug,
        used: await quota.count(this.db, tenant.id),
        limit: await this.quotas.limitOf(quota, tenant.id),
      });
    });
    return readings;
  }
}
