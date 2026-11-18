import { ClsServiceManager } from 'nestjs-cls';

/**
 * Whose rows the current work may touch: one tenant (`tenantId`), or every
 * tenant for cross-tenant maintenance (`acrossTenants`, Tenancy.acrossTenants()).
 * No scope at all, or a scope with neither, is no tenant: a tenant table
 * shows no rows and takes no writes.
 */
export interface TenantScope {
  readonly tenantId: string | null;
  readonly acrossTenants: boolean;
  /**
   * Every transaction `READ ONLY` (an operator's break-glass request):
   * PostgreSQL refuses any write, a global table's too. Once set, every
   * scope entered inside it is read only as well (inheritScope()).
   */
  readonly readOnly?: boolean;
}

/**
 * The CLS key of the scope. A symbol: a dotted string key is a path in
 * nestjs-cls, whose parent object a nested (`inherit`) context shares, so
 * an inner scope would leak out to its caller.
 */
export const TENANT_SCOPE = Symbol('tenancy.scope');

/** A UUID as PostgreSQL prints them: the only text a scope ever hands the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertTenantId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(`Not a tenant id: ${JSON.stringify(value)}`);
  }
  return value;
}

/** One tenant's scope. */
export const tenantScope = (tenantId: string): TenantScope =>
  Object.freeze({ tenantId: assertTenantId(tenantId), acrossTenants: false });

/** One tenant's scope, read only (break-glass): its rows and nothing written. */
export const readOnlyTenantScope = (tenantId: string): TenantScope =>
  Object.freeze({
    tenantId: assertTenantId(tenantId),
    acrossTenants: false,
    readOnly: true,
  });

/**
 * The scope work nested in the current context runs in: `scope`, read
 * only when the current one is, so nothing run inside a read-only request
 * (Tenancy.run(), a job's inTenantOf()) can write again.
 */
export function inheritScope(scope: TenantScope): TenantScope {
  return currentTenantScope()?.readOnly && !scope.readOnly
    ? Object.freeze({ ...scope, readOnly: true })
    : scope;
}

/** No tenant: global tables only. */
export const NO_TENANT: TenantScope = Object.freeze({
  tenantId: null,
  acrossTenants: false,
});

/** Every tenant at once: cross-tenant maintenance only. */
export const ACROSS_TENANTS: TenantScope = Object.freeze({
  tenantId: null,
  acrossTenants: true,
});

export const sameScope = (a: TenantScope | undefined, b: TenantScope) =>
  (a?.tenantId ?? null) === b.tenantId &&
  (a?.acrossTenants ?? false) === b.acrossTenants &&
  (a?.readOnly ?? false) === (b.readOnly ?? false);

export const describeScope = (scope: TenantScope | undefined) =>
  `${
    scope?.acrossTenants
      ? 'every tenant'
      : scope?.tenantId
        ? `tenant ${scope.tenantId}`
        : 'no tenant'
  }${scope?.readOnly ? ' (read only)' : ''}`;

/**
 * The scope of the current async context, or undefined outside one. Read
 * through nestjs-cls's global manager, so the pool and a column's default
 * reach it without injection.
 */
export function currentTenantScope(): TenantScope | undefined {
  const cls = ClsServiceManager.getClsService();
  return cls.isActive()
    ? (cls.get(TENANT_SCOPE) as TenantScope | undefined)
    : undefined;
}

/** The tenant of the current context, or a TenantScopeMissingError. */
export function requireTenantId(what = 'This work'): string {
  const tenantId = currentTenantScope()?.tenantId;
  if (!tenantId) {
    throw new TenantScopeMissingError(
      `${what} needs a tenant, and the context has none: run it in a request of a tenant, a job queued in one, or Tenancy.run(tenantId, work).`,
    );
  }
  return tenantId;
}

/** Work on a tenant's data without a tenant in the context. Over HTTP: 403 `tenant_required` (tenancy-errors.ts). */
export class TenantScopeMissingError extends Error {
  override readonly name = 'TenantScopeMissingError';
}
