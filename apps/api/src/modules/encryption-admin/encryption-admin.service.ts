import { InjectQueue } from '@nestjs/bullmq';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Database } from '../../core/database/database.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { ReencryptionService } from '../../core/encryption/reencryption.service.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';

/** The queue of the re-encryption jobs. */
export const REENCRYPTION_QUEUE = 'reencryption';

const JOB = 'reencryption';

/**
 * Where the keys stand and the work that moves rows to the current ones.
 * core/encryption does the rewriting (ReencryptionService); this decides
 * where and when: one pass per tenant (a tenant's rows are only seen in its
 * scope) and one outside every tenant for the tables of none, each pass a
 * job on the queue.
 */
@Injectable()
export class EncryptionAdminService {
  private readonly logger = new Logger('Reencryption');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly encryption: EncryptionService,
    private readonly reencryption: ReencryptionService,
    private readonly tenancy: Tenancy,
    @InjectQueue(REENCRYPTION_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Stale rows per column in the current scope: a tenant's columns in each
   * tenant's, the tables of no tenant outside every one (they would
   * otherwise be counted once per tenant).
   */
  private async staleHere(tenantId: string | null) {
    const stale = new Map<string, number>();
    for (const entry of this.encryption.columns()) {
      if ((entry.tenantColumn !== undefined) !== (tenantId !== null)) {
        continue;
      }
      stale.set(
        `${entry.bindingTable}.${entry.bindingColumn}`,
        await this.reencryption.stale(this.db, entry),
      );
    }
    return stale;
  }

  /** Runs `work` once outside every tenant, then once in each tenant (deactivated ones too: their rows still hold the old key). */
  private async eachScope<T>(work: (tenantId: string | null) => Promise<T>) {
    const results = [await this.tenancy.run(null, () => work(null))];
    const perTenant = await this.tenancy.forEachTenant(
      JOB,
      (tenant) => work(tenant.id),
      { includeInactive: true },
    );
    return [...results, ...perTenant.values()];
  }

  /** The current keys and, per encrypted column, the rows still on an older one in every tenant. */
  async status() {
    const columns = this.encryption.columns();
    const totals = new Map<string, number>();
    for (const scope of await this.eachScope((id) => this.staleHere(id))) {
      for (const [column, count] of scope) {
        totals.set(column, (totals.get(column) ?? 0) + count);
      }
    }
    const rows = columns.map((entry) => {
      const column = `${entry.bindingTable}.${entry.bindingColumn}`;
      return {
        column,
        blindIndex: entry.blindIndex !== undefined,
        staleRows: totals.get(column) ?? 0,
      };
    });
    return {
      enabled: this.encryption.currentKeyId !== undefined,
      dataKeyId: this.encryption.currentKeyId ?? null,
      indexKeyId: this.encryption.currentIndexPrefix()?.slice(0, -1) ?? null,
      upToDate: rows.every((row) => row.staleRows === 0),
      columns: rows,
    };
  }

  /**
   * Queues a job for every scope with stale rows (the hourly schedule and
   * the operators' route). Returns how many it queued; nothing is queried
   * while no column is declared encrypted.
   */
  async schedule() {
    if (this.encryption.columns().length === 0) {
      return 0;
    }
    const queued = await this.eachScope(async (tenantId): Promise<number> => {
      const stale = [...(await this.staleHere(tenantId)).values()];
      if (stale.every((count) => count === 0)) {
        return 0;
      }
      // The job's envelope: the tenant to run in, null for the tables of none.
      // While a scope's job is pending, the next hour queues no second one.
      await this.queue.add(
        JOB,
        { tenantId },
        { deduplication: { id: `reencrypt:${tenantId ?? 'global'}` } },
      );
      return 1;
    });
    const total = queued.reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      this.logger.log(`Re-encryption queued for ${total} scope(s)`);
    }
    return total;
  }

  /** One pass in the current scope: what a job does. */
  pass() {
    return this.reencryption.run(this.db);
  }

  /** Every pass now, in this process: what the operator CLI does. */
  async runNow() {
    const results = await this.eachScope(() => this.pass());
    return {
      rewritten: results.reduce((sum, result) => sum + result.rewritten, 0),
      failed: results.reduce((sum, result) => sum + result.failed, 0),
    };
  }
}
