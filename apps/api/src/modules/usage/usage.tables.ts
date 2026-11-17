import {
  date,
  index,
  integer,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import { apiClients } from '../../iam/auth/auth.tables.js';

/**
 * API clients' requests per UTC day and route, rolled up every night from
 * the live Redis counters (UsageRollupJob). `route` is `<METHOD> <pattern>`
 * (`GET /v1/notes/{id}`); a day's total is their sum.
 */
export const apiUsage = tenantTable(
  'api_usage',
  {
    id: uuidPk(),
    clientId: uuid('client_id').notNull(),
    day: date('day').notNull(),
    route: text('route').notNull(),
    count: integer('count').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('api_usage_client_day_route_idx').on(
      t.tenantId,
      t.clientId,
      t.day,
      t.route,
    ),
    index('api_usage_day_idx').on(t.day),
    tenantReference(
      'api_usage_client_fk',
      [t.tenantId, t.clientId],
      [apiClients.tenantId, apiClients.id],
    ),
  ],
);

/** An API client's daily request quota; no row: unlimited. */
export const apiClientQuotas = tenantTable(
  'api_client_quotas',
  {
    id: uuidPk(),
    clientId: uuid('client_id').notNull(),
    dailyQuota: integer('daily_quota').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('api_client_quotas_client_idx').on(t.tenantId, t.clientId),
    tenantReference(
      'api_client_quotas_client_fk',
      [t.tenantId, t.clientId],
      [apiClients.tenantId, apiClients.id],
    ),
  ],
);
