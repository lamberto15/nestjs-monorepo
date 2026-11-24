import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { t } from '@nestjs/i18n';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type {
  RequestPrincipal,
  UserPrincipal,
} from '../../iam/auth/principal.js';
import { UsageCounters } from './usage.counters.js';
import {
  addDays,
  daysBetween,
  LIVE_TTL_SECONDS,
  TOTAL_FIELD,
  utcDay,
} from './usage.keys.js';
import { UsageRepository } from './usage.repository.js';

/** The longest range one usage report covers. */
export const MAX_REPORT_DAYS = 400;
/** The range when none is asked for: the last 30 days, today included. */
const DEFAULT_REPORT_DAYS = 30;
/** Days whose counters can still be in Redis. */
const LIVE_DAYS = Math.ceil(LIVE_TTL_SECONDS / 86_400);

/**
 * API clients' usage reports (rolled-up rows merged with the live counters,
 * so today is always included) and their daily quotas.
 */
@Injectable()
export class UsageService {
  constructor(
    private readonly repository: UsageRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly counters: UsageCounters,
    private readonly audit: AuditService,
  ) {}

  /** The client's daily quota, or null: none. */
  async quotaOf(clientId: string): Promise<number | null> {
    return (await this.repository.quotaOf(clientId)) ?? null;
  }

  /** Sets (or, with null, removes) a client's daily quota; audited. */
  async setQuota(
    actor: UserPrincipal,
    clientId: string,
    dailyQuota: number | null,
    ip?: string,
  ) {
    await this.assertClient(clientId);
    await this.txHost.withTransaction(async () => {
      const before = await this.quotaOf(clientId);
      if (dailyQuota === null) {
        await this.repository.deleteQuota(clientId);
      } else {
        await this.repository.saveQuota(clientId, dailyQuota);
      }
      await this.audit.record(actor, {
        action: 'client.quota-changed',
        targetType: 'client',
        targetId: clientId,
        details: { dailyQuota: { from: before, to: dailyQuota } },
        ip,
      });
    });
    return { dailyQuota };
  }

  /** The caller's own usage: only API clients have usage, a user gets a 403. */
  async ownUsage(
    principal: RequestPrincipal,
    range: { from?: string; to?: string },
  ) {
    if (principal.kind !== 'client') {
      throw new ForbiddenException(t('usage.clientsOnly'));
    }
    return this.report(principal.id, range);
  }

  /** An API client's usage, for administrators: a 404 for an unknown client. */
  async forClient(clientId: string, range: { from?: string; to?: string }) {
    await this.assertClient(clientId);
    return this.report(clientId, range);
  }

  /**
   * Usage per day from `from` to `to` (UTC days, both included; default the
   * last 30 days). Per route the larger count of the rolled-up row and the
   * live counter wins, since a row is a copy of its day's counter.
   */
  async report(
    clientId: string,
    range: { from?: string; to?: string },
    now = new Date(),
  ) {
    const tenantId = requireTenantId('A usage report');
    const today = utcDay(now);
    const to = range.to ?? today;
    const from = range.from ?? addDays(to, -(DEFAULT_REPORT_DAYS - 1));
    if (from > to) {
      throw invalidRange('rangeBackwards');
    }
    // The span first, arithmetically: a list of every day since year 1 is not built to be refused.
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (span > MAX_REPORT_DAYS) {
      throw invalidRange('rangeTooLong', { max: MAX_REPORT_DAYS });
    }
    const days = daysBetween(from, to);
    const counts = new Map<string, Map<string, number>>(
      days.map((day) => [day, new Map()]),
    );
    const add = (day: string, route: string, count: number) => {
      const routes = counts.get(day);
      if (routes && route !== TOTAL_FIELD) {
        routes.set(route, Math.max(routes.get(route) ?? 0, count));
      }
    };

    const rows = await this.repository.rows(clientId, from, to);
    for (const row of rows) {
      add(row.day, row.route, row.count);
    }
    const live = days.filter(
      (day) => day <= today && day >= addDays(today, -LIVE_DAYS),
    );
    if (live.length > 0) {
      for (const [day, hash] of await this.counters.live(
        tenantId,
        clientId,
        live,
      )) {
        for (const [route, count] of Object.entries(hash)) {
          add(day, route, Number(count));
        }
      }
    }

    const report = days.map((day) => {
      const routes = Object.fromEntries(
        [...counts.get(day)!].sort(([a], [b]) => a.localeCompare(b)),
      );
      const total = Object.values(routes).reduce((sum, n) => sum + n, 0);
      return { day, total, routes };
    });
    return {
      from,
      to,
      days: report,
      total: report.reduce((sum, day) => sum + day.total, 0),
      dailyQuota: await this.quotaOf(clientId),
    };
  }

  private async assertClient(clientId: string) {
    if (!(await this.repository.clientExists(clientId))) {
      throw new NotFoundException(t('usage.clientNotFound'));
    }
  }
}

function invalidRange(key: string, args?: Record<string, unknown>) {
  const message = t(`usage.${key}`, args ? { args } : undefined);
  return new BadRequestException({
    code: 'validation_failed',
    message,
    errors: [{ path: 'from', message }],
  });
}
