import { type SQL, sql } from 'drizzle-orm';
import { listQuery } from '../../core/http/list-query.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { tenantLifecycle } from './tenants.tables.js';

/** The tenant fields GET /v1/tenants answers with (`?fields=`). */
export const TENANT_FIELDS = [
  'slug',
  'name',
  'active',
  'operator',
  'createdBySignUp',
  'deletionRequestedAt',
  'deletionScheduledFor',
  'deletionStartedAt',
  'createdAt',
  'updatedAt',
] as const;

/**
 * What GET /v1/tenants is filtered and sorted by. `operator` is the
 * operators' tenant: an expression of the deployment (OPERATOR_TENANT, or
 * TENANCY=single's one tenant), given by TenantsService.
 */
export const tenantList = (operator: SQL) =>
  listQuery(
    {
      name: {
        column: tenants.name,
        type: 'string',
        ops: ['eq', 'contains', 'startsWith'],
        sortable: true,
      },
      slug: {
        column: tenants.slug,
        type: 'string',
        ops: ['eq', 'contains', 'startsWith'],
        sortable: true,
      },
      active: { column: tenants.active, type: 'boolean', ops: ['eq'] },
      operator: {
        column: tenants.id,
        type: 'boolean',
        ops: ['eq'],
        conditions: {
          eq: (value) => (value ? operator : sql`not ${operator}`),
        },
      },
      createdBySignUp: {
        column: tenantLifecycle.createdBySignUp,
        type: 'boolean',
        ops: ['eq'],
      },
      createdAt: {
        column: tenants.createdAt,
        type: 'datetime',
        ops: ['gt', 'gte', 'lt', 'lte', 'between'],
        sortable: true,
      },
      updatedAt: {
        column: tenants.updatedAt,
        type: 'datetime',
        ops: ['gt', 'gte', 'lt', 'lte', 'between'],
        sortable: true,
      },
    },
    { select: TENANT_FIELDS },
  );

/** The list as the route validates it: the operator condition is TenantsService's. */
export const TENANT_LIST = tenantList(sql`false`);
