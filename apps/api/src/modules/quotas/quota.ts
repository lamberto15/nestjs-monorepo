import type { Database } from '../../core/database/database.js';

interface QuotaBase {
  /** Stable, in limits and audit entries: `mail.perDay`, `apiClients`. */
  key: string;
  label: string;
  description?: string;
  /** The limit when neither the tenant nor its plan sets one; absent: unlimited. */
  default?: number | null;
}

/**
 * A limit on how much a tenant HAS (members, API clients, records, bytes):
 * counted by the module that owns the thing, in the tenant's scope, and
 * checked where it is made (QuotasService.assertRoom). Past it: 422.
 */
export interface StockQuota extends QuotaBase {
  kind: 'stock';
  count(db: Database, tenantId: string): Promise<number>;
}

/**
 * A limit on how much a tenant USES in a UTC day or month (mails, AI
 * tokens, API calls): counted in Redis by QuotasService.consume, which
 * starts again each period. Past it: 429 with the reset time.
 */
export interface RateQuota extends QuotaBase {
  kind: 'rate';
  period: 'day' | 'month';
}

export type Quota = StockQuota | RateQuota;

/**
 * Declares a quota in the module that owns the limited thing, and registers
 * it in that module's imports: `QuotasModule.forFeature(MEMBERS)`.
 */
export function defineQuota<Q extends Quota>(quota: Q): Q {
  if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)*$/.test(quota.key)) {
    throw new Error(
      `Quota key "${quota.key}": words of letters and digits joined by "." (mail.perDay).`,
    );
  }
  return Object.freeze(quota);
}

/** What a rate quota's period is now: the counter's id and when it starts again. */
export function periodOf(period: RateQuota['period'], now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === 'month') {
    return {
      id: now.toISOString().slice(0, 7),
      resetsAt: new Date(Date.UTC(year, month + 1, 1)),
    };
  }
  return {
    id: now.toISOString().slice(0, 10),
    resetsAt: new Date(Date.UTC(year, month, now.getUTCDate() + 1)),
  };
}

/** Hands a module's quotas to QuotasService (found by discovery, as permissions are). */
export class QuotaRegistration {
  constructor(readonly quotas: readonly Quota[]) {}
}
