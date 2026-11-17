import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import {
  TenantItemsModule,
  TenantItemsService,
} from '../../../test/fixtures/tenant-items.js';
import { DatabaseModule } from '../database/database.module.js';
import { TenancyModule } from './tenancy.module.js';
import { Tenancy } from './tenancy.service.js';

async function bootAs(mode: 'single' | 'multi') {
  process.env.TENANCY = mode;
  try {
    return await bootModules(DatabaseModule, TenancyModule, TenantItemsModule);
  } finally {
    delete process.env.TENANCY;
  }
}

/**
 * TENANCY=single: one tenant, made at the first start; the wall and the
 * tenant columns as in multi, so switching is changing the variable.
 */
describe('single tenant (e2e)', () => {
  let app: NestNodeApplication | undefined;
  afterEach(() => app?.close());

  it('makes its one tenant at the first start, and refuses another', async () => {
    app = await bootAs('single');
    const tenancy = app.get(Tenancy);
    const sole = await tenancy.soleTenant();
    expect(sole).toMatchObject({ slug: 'default', active: true });
    await expect(
      tenancy.create({ slug: 'other', name: 'Other' }),
    ).rejects.toMatchObject({
      response: { code: 'single_tenant' },
    });
    await tenancy.run(sole.id, () => app!.get(TenantItemsService).add('kept'));
    await app.close();

    // A restart keeps the one tenant.
    app = await bootAs('single');
    expect((await app.get(Tenancy).soleTenant()).id).toBe(sole.id);
  });

  it('becomes multi-tenant by the variable alone, its rows where they were', async () => {
    app = await bootAs('single');
    const sole = await app.get(Tenancy).soleTenant();
    await app
      .get(Tenancy)
      .run(sole.id, () => app!.get(TenantItemsService).add('carried'));
    await app.close();

    app = await bootAs('multi');
    const tenancy = app.get(Tenancy);
    const items = app.get(TenantItemsService);
    const other = await tenancy.create({ slug: 'other', name: 'Other' });
    expect(await tenancy.run(sole.id, () => items.names())).toContain(
      'carried',
    );
    expect(await tenancy.run(other.id, () => items.names())).toEqual([]);
  });
});
