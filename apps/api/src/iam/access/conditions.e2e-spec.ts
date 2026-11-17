import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { subject as asSubject } from '@casl/ability';
import { z } from 'zod';
import { bootModules } from '../../../test/boot.js';
import { tenantItems } from '../../../test/fixtures/tenant-items.tables.js';
import { DatabaseModule } from '../../core/database/database.module.js';
import type { Database } from '../../core/database/database.js';
import { TenancyModule } from '../../core/tenancy/tenancy.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { type Principal, principalKey } from '../auth/principal.js';
import { abilityOf, filterOf } from './access.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import {
  type AccessContext,
  definePermissions,
  type PermissionInput,
} from './permissions.js';

/**
 * A condition is written once (column/value data); the CASL check of one
 * record and the SQL filter of a list are both derived from it. Each
 * condition here runs both ways on the same rows: the rows the filter
 * returns are exactly those the ability allows.
 */
const ITEMS = definePermissions({
  subjects: {
    Item: {
      actions: {
        read: [
          'mine',
          'alpha',
          'named',
          'alphaOrBeta',
          'narrowed',
          'none',
          'unknown',
          'inParents',
          'flagged',
        ],
      },
      conditions: {
        mine: {
          where: (principal) => [[tenantItems.name, principalKey(principal)]],
        },
        alpha: { where: () => [[tenantItems.name, 'alpha']] },
        named: {
          params: z.object({ name: z.string() }),
          where: (_principal, params: { name: string }) => [
            [tenantItems.name, params.name],
          ],
        },
        alphaOrBeta: { where: () => [[tenantItems.name, ['alpha', 'beta']]] },
        // The same column twice: both must hold, so only beta.
        narrowed: {
          where: () => [
            [tenantItems.name, ['alpha', 'beta']],
            [tenantItems.name, ['beta', 'gamma']],
          ],
        },
        none: { where: () => [[tenantItems.name, []]] },
        unknown: { where: () => [[tenantItems.name, undefined]] },
        inParents: {
          where: (_p, _params, context) => [
            [tenantItems.parentId, context.directUnitIds],
          ],
        },
        // Two columns at once.
        flagged: {
          where: (_p, _params, context) => [
            [tenantItems.parentId, context.unitIdsAndBelow],
            [tenantItems.name, ['child-1', 'child-3']],
          ],
        },
      },
    },
  },
});

describe('conditions: one declaration, two forms (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let rows: (typeof tenantItems.$inferSelect)[];
  const catalog = PermissionCatalog.of(ITEMS);
  const user = {
    kind: 'user',
    id: '0190a1b2-0000-7000-8000-000000000001',
  } as Principal;
  let context: AccessContext;

  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, work);

  beforeAll(async () => {
    app = await bootModules(DatabaseModule, TenancyModule);
    tenantId = (
      await app.get(Tenancy).create({ slug: 'conditions', name: 'Conditions' })
    ).id;
    rows = await inTenant(async () => {
      const [parentA] = await db()
        .insert(tenantItems)
        .values({ name: 'parent-a' })
        .returning();
      const [parentB] = await db()
        .insert(tenantItems)
        .values({ name: 'parent-b' })
        .returning();
      await db()
        .insert(tenantItems)
        .values([
          { name: 'alpha' },
          { name: 'beta' },
          { name: 'gamma' },
          { name: principalKey(user) },
          { name: 'child-1', parentId: parentA!.id },
          { name: 'child-2', parentId: parentA!.id },
          { name: 'child-3', parentId: parentB!.id },
        ]);
      context = {
        directUnitIds: [parentA!.id],
        unitIdsAndBelow: [parentA!.id, parentB!.id],
        ledUnitIdsAndBelow: [],
      };
      return db().select().from(tenantItems);
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  /** The names each form lets the user read under these permissions. */
  async function bothWays(permissions: PermissionInput[]) {
    const ability = abilityOf(catalog, user, permissions, context);
    const byCasl = rows
      .filter((row) => ability.can('read', asSubject('Item', { ...row })))
      .map((row) => row.name)
      .sort();
    const filter = filterOf(
      catalog,
      user,
      permissions,
      'Item',
      'read',
      context,
    );
    const bySql = (
      await inTenant(() =>
        db().select({ name: tenantItems.name }).from(tenantItems).where(filter),
      )
    )
      .map((row) => row.name)
      .sort();
    return { byCasl, bySql };
  }

  const read = (
    ...conditions: PermissionInput['conditions']
  ): PermissionInput => ({
    subject: 'Item',
    action: 'read',
    conditions,
  });

  it.each([
    [
      'the principal',
      [read({ key: 'mine' })],
      ['user:0190a1b2-0000-7000-8000-000000000001'],
    ],
    ['a constant', [read({ key: 'alpha' })], ['alpha']],
    [
      'a parameter',
      [read({ key: 'named', params: { name: 'gamma' } })],
      ['gamma'],
    ],
    ['a list', [read({ key: 'alphaOrBeta' })], ['alpha', 'beta']],
    ['the same column twice', [read({ key: 'narrowed' })], ['beta']],
    ['an empty list', [read({ key: 'none' })], []],
    ['undefined', [read({ key: 'unknown' })], []],
    ['the context', [read({ key: 'inParents' })], ['child-1', 'child-2']],
    ['two columns', [read({ key: 'flagged' })], ['child-1', 'child-3']],
    [
      'two conditions (AND)',
      [read({ key: 'alphaOrBeta' }, { key: 'narrowed' })],
      ['beta'],
    ],
    [
      'two permissions (OR)',
      [
        read({ key: 'alpha' }),
        read({ key: 'named', params: { name: 'gamma' } }),
      ],
      ['alpha', 'gamma'],
    ],
    ['no permission', [], []],
    ['an undeclared condition (grants nothing)', [read({ key: 'gone' })], []],
  ] as const)('agrees on %s', async (_name, permissions, expected) => {
    const { byCasl, bySql } = await bothWays(
      permissions as unknown as PermissionInput[],
    );
    expect(byCasl).toEqual([...expected].sort());
    expect(bySql).toEqual(byCasl);
  });

  it('agrees on a permission without conditions: every row, and no filter', async () => {
    const { byCasl, bySql } = await bothWays([read()]);
    expect(byCasl).toHaveLength(rows.length);
    expect(bySql).toEqual(byCasl);
    expect(
      filterOf(catalog, user, [read()], 'Item', 'read', context),
    ).toBeUndefined();
  });
});
