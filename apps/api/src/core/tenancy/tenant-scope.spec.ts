import { AsyncLocalStorage } from 'node:async_hooks';
import { uuid } from 'drizzle-orm/pg-core';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import { bindingStatement } from './row-level-security.js';
import { globalTable, tenantTable, tenantTables } from './tenant-tables.js';
import { inTenantOf, withTenant } from './tenant-job.js';
import {
  ACROSS_TENANTS,
  assertTenantId,
  currentTenantScope,
  inheritScope,
  NO_TENANT,
  readOnlyTenantScope,
  requireTenantId,
  TENANT_SCOPE,
  TenantScopeMissingError,
  tenantScope,
} from './tenant-scope.js';

const A = '0199a000-0000-7000-8000-00000000000a';
const B = '0199a000-0000-7000-8000-00000000000b';

describe('the tenant scope', () => {
  it('binds a transaction to its tenant, locally, and to none without one', () => {
    expect(bindingStatement(tenantScope(A))).toBe(
      `select set_config('app.tenant_id', '${A}', true); select set_config('transaction_read_only', 'on', true) from "tenants" where "id" = '${A}' and "frozen_at" is not null`,
    );
    for (const scope of [NO_TENANT, ACROSS_TENANTS, undefined]) {
      expect(bindingStatement(scope)).toBe(
        "select set_config('app.tenant_id', '', true)",
      );
    }
  });

  it('binds a read-only scope’s transaction read only, before its setting', () => {
    expect(bindingStatement(readOnlyTenantScope(A))).toBe(
      `set transaction read only; select set_config('app.tenant_id', '${A}', true)`,
    );
  });

  it('keeps work nested in a read-only scope read only', () => {
    const cls = new ClsService(new AsyncLocalStorage());
    vi.spyOn(ClsServiceManager, 'getClsService').mockReturnValue(cls);
    expect(inheritScope(tenantScope(B))).toEqual(tenantScope(B));
    cls.run(() => {
      cls.set(TENANT_SCOPE, readOnlyTenantScope(A));
      expect(inheritScope(tenantScope(B))).toEqual({
        tenantId: B,
        acrossTenants: false,
        readOnly: true,
      });
      expect(inheritScope(NO_TENANT).readOnly).toBe(true);
    });
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

describe('the registry of tenant tables', () => {
  it('lists the tables tenantTable() and globalTable() made, by name', () => {
    tenantTable('registry_probe_items', { id: uuid('id').primaryKey() });
    globalTable('registry_probe_links', { id: uuid('id').primaryKey() });
    const probes = tenantTables().filter((entry) =>
      entry.name.startsWith('registry_probe_'),
    );
    expect(probes.map(({ name, kind }) => [name, kind])).toEqual([
      ['registry_probe_items', 'tenant'],
      ['registry_probe_links', 'global'],
    ]);
  });
});
