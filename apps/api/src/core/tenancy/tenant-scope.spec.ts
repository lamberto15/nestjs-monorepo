import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import { bindingStatement } from './row-level-security.js';
import { inTenantOf, withTenant } from './tenant-job.js';
import {
  ACROSS_TENANTS,
  assertTenantId,
  currentTenantScope,
  NO_TENANT,
  requireTenantId,
  TenantScopeMissingError,
  tenantScope,
} from './tenant-scope.js';

const A = '0199a000-0000-7000-8000-00000000000a';
const B = '0199a000-0000-7000-8000-00000000000b';

describe('the tenant scope', () => {
  it('binds a transaction to its tenant, locally, and to none without one', () => {
    expect(bindingStatement(tenantScope(A))).toBe(
      `select set_config('app.tenant_id', '${A}', true)`,
    );
    for (const scope of [NO_TENANT, ACROSS_TENANTS, undefined]) {
      expect(bindingStatement(scope)).toBe(
        "select set_config('app.tenant_id', '', true)",
      );
    }
  });

  it('takes nothing but a UUID into the binding', () => {
    expect(() => tenantScope(`${A}', true); --`)).toThrow(TypeError);
    expect(() => assertTenantId('ACME')).toThrow(TypeError);
    expect(() =>
      bindingStatement({ tenantId: "x'", acrossTenants: false }),
    ).toThrow(TypeError);
  });

  it('reads the scope from the context, and carries it with a job', async () => {
    const cls = new ClsService(new AsyncLocalStorage());
    vi.spyOn(ClsServiceManager, 'getClsService').mockReturnValue(cls);
    expect(currentTenantScope()).toBeUndefined();
    expect(() => requireTenantId()).toThrow(TenantScopeMissingError);
    expect(withTenant({ x: 1 })).toEqual({ x: 1, tenantId: null });
    const seen = await inTenantOf({ tenantId: A }, async () => ({
      id: requireTenantId(),
      data: withTenant({ x: 1 }),
      inner: await inTenantOf({ tenantId: B }, async () => requireTenantId()),
      after: requireTenantId(),
    }));
    expect(seen).toEqual({
      id: A,
      data: { x: 1, tenantId: A },
      inner: B,
      after: A,
    });
    await expect(inTenantOf({}, async () => 1)).rejects.toThrow(
      /carries no tenantId/,
    );
    expect(
      await inTenantOf({ tenantId: null }, async () => currentTenantScope()),
    ).toEqual(NO_TENANT);
  });
});
