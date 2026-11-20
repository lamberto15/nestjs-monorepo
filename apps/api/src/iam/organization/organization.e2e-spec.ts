import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessModule } from '../access/access.module.js';
import { AccessService } from '../access/access.service.js';
import { definePermissions } from '../access/permissions.js';
import { auditLog } from '../audit/audit.tables.js';
import type { Principal } from '../auth/principal.js';
import { organizationalUnits } from './organization.tables.js';
import { UNIT_CONDITION_KEYS, unitConditions } from './unit-conditions.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-organization-${process.pid}-${Date.now()}`;
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.ADMIN_ONBOARDING = 'off';
});

/** A subject whose records are the units themselves: what the unit conditions reach, read both ways. */
@Module({
  imports: [
    AccessModule.forFeature(
      definePermissions({
        subjects: {
          TestUnit: {
            actions: { read: [...UNIT_CONDITION_KEYS] },
            conditions: unitConditions(organizationalUnits.id),
          },
        },
      }),
    ),
  ],
})
class TestUnitsModule {}

type Headers = Record<string, string>;
const URL = '/v1/access/organizational-units';

describe('organizational units (e2e)', () => {
  let app: NestNodeApplication;
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const db = () => app.get<Database>(getDrizzleToken());

  beforeAll(async () => {
    app = await bootModules(...accessModules(), TestUnitsModule);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** A fresh tenant with units Sales > North > North East and Sales > South. */
  async function tree() {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const unit = async (type: string, name: string, parentId?: string) => {
      const created = await call('POST', URL, admin.headers, {
        type,
        name,
        parentId,
      });
      expect(created.statusCode).toBe(201);
      return created.json().id as string;
    };
    const sales = await unit('division', 'Sales');
    const north = await unit('department', 'North', sales);
    const south = await unit('team', 'South', sales);
    const northEast = await unit('team', 'North East', north);
    const names = {
      [sales]: 'Sales',
      [north]: 'North',
      [south]: 'South',
      [northEast]: 'North East',
    };
    return { tenantId, admin, sales, north, south, northEast, names };
  }

  /** A role reading TestUnit under one condition. */
  async function readingWith(headers: Headers, key: string) {
    const role = await call('POST', '/v1/access/roles', headers, {
      name: `role-${randomUUID().slice(0, 8)}`,
      permissions: [
        { subject: 'TestUnit', action: 'read', conditions: [{ key }] },
      ],
    });
    expect(role.statusCode).toBe(201);
    return role.json().id as string;
  }

  /** The units a user reaches, by name: the SQL filter's rows, checked to be the ones can() allows. */
  async function reach(tenantId: string, userId: string) {
    const access = app.get(AccessService);
    const principal = { kind: 'user', id: userId } as Principal;
    return app.get(Tenancy).run(tenantId, async () => {
      const all = await db().select().from(organizationalUnits);
      const filter = await access.sqlFilter(principal, 'TestUnit', 'read');
      const bySql = (
        await db()
          .select({ name: organizationalUnits.name })
          .from(organizationalUnits)
          .where(filter)
      )
        .map((row) => row.name)
        .sort();
      const byCan: string[] = [];
      for (const unit of all) {
        if (await access.can(principal, 'read', 'TestUnit', unit))
          byCan.push(unit.name);
      }
      expect(byCan.sort()).toEqual(bySql);
      return bySql;
    });
  }

  it('grants inMyUnits the direct units only, inMyUnitsAndBelow those below too, never the parent', async () => {
    const { tenantId, admin, sales, northEast } = await tree();
    const memberOf = async (key: string, unitId: string) => {
      const user = await member(app, tenantId, [
        await readingWith(admin.headers, key),
      ]);
      expect(
        (
          await call('POST', `${URL}/${unitId}/members`, admin.headers, {
            userId: user.id,
          })
        ).statusCode,
      ).toBe(201);
      return reach(tenantId, user.id);
    };
    expect(await memberOf('inMyUnits', sales)).toEqual(['Sales']);
    expect(await memberOf('inMyUnitsAndBelow', sales)).toEqual([
      'North',
      'North East',
      'Sales',
      'South',
    ]);
    expect(await memberOf('inMyUnitsAndBelow', northEast)).toEqual([
      'North East',
    ]);
    // Up the tree: what a parent holds reaches its teams' members, never a sibling's.
    expect(await memberOf('inMyUnitsAndAbove', northEast)).toEqual([
      'North',
      'North East',
      'Sales',
    ]);
    expect(await memberOf('inMyUnitsAndAbove', sales)).toEqual(['Sales']);
  });

  it('grants inUnitsILeadAndBelow to leads only, until their membership ends; previews a change without making it', async () => {
    const { tenantId, admin, sales, north, northEast } = await tree();
    const role = await readingWith(admin.headers, 'inUnitsILeadAndBelow');
    const user = async (unitId: string, unitRole: 'member' | 'lead') => {
      const created = await member(app, tenantId, [role]);
      const membership = await call(
        'POST',
        `${URL}/${unitId}/members`,
        admin.headers,
        { userId: created.id, role: unitRole },
      );
      expect(membership.json()).toMatchObject({
        role: unitRole,
        validTo: null,
      });
      return created;
    };
    expect(await reach(tenantId, (await user(sales, 'member')).id)).toEqual([]);
    expect(await reach(tenantId, (await user(sales, 'lead')).id)).toEqual([
      'North',
      'North East',
      'Sales',
      'South',
    ]);
    const northLead = await user(north, 'lead');
    expect(await reach(tenantId, northLead.id)).toEqual([
      'North',
      'North East',
    ]);

    const promoted = await user(north, 'member');
    expect(await reach(tenantId, promoted.id)).toEqual([]);
    const impact = await call(
      'POST',
      `${URL}/${north}/members/${promoted.id}/impact`,
      admin.headers,
      { role: 'lead' },
    );
    expect(impact.statusCode).toBe(200);
    expect(impact.json()).toEqual({
      changes: [
        {
          userId: promoted.id,
          name: 'Test User',
          email: promoted.email,
          andBelow: { gains: [], loses: [] },
          andAbove: { gains: [], loses: [] },
          ledAndBelow: {
            gains: expect.arrayContaining([north, northEast]),
            loses: [],
          },
        },
      ],
      truncated: false,
    });
    expect(await reach(tenantId, promoted.id)).toEqual([]);
    const audited = await app.get(Tenancy).run(tenantId, () =>
      db()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'organizationalUnit.member-role-changed'),
            eq(auditLog.targetId, north),
          ),
        ),
    );
    expect(audited).toHaveLength(0);

    expect(
      (
        await call(
          'PATCH',
          `${URL}/${north}/members/${promoted.id}`,
          admin.headers,
          { role: 'lead' },
        )
      ).statusCode,
    ).toBe(200);
    expect(await reach(tenantId, promoted.id)).toEqual(['North', 'North East']);
    expect(
      (
        await call(
          'DELETE',
          `${URL}/${north}/members/${northLead.id}`,
          admin.headers,
        )
      ).statusCode,
    ).toBe(204);
    expect(await reach(tenantId, northLead.id)).toEqual([]);

    const history = (
      await call('GET', `${URL}/${north}/members`, admin.headers)
    ).json().items as {
      userId: string;
      role: string;
      validTo: string | null;
      email: string;
    }[];
    expect(
      history
        .filter((row) => row.userId === promoted.id)
        .map((row) => row.role)
        .sort(),
    ).toEqual(['lead', 'member']);
    expect(history.find((row) => row.userId === northLead.id)).toMatchObject({
      email: northLead.email,
    });
    expect(
      history.find((row) => row.userId === northLead.id)?.validTo,
    ).not.toBeNull();
    // Nobody changes their own units.
    expect(
      (
        await call('POST', `${URL}/${north}/members`, admin.headers, {
          userId: admin.id,
          role: 'lead',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('places people only in units the placer manages, belongs to or leads (or one above)', async () => {
    const { tenantId, admin, sales, north, south } = await tree();
    const managerRole = await call('POST', '/v1/access/roles', admin.headers, {
      name: `managers-${randomUUID().slice(0, 8)}`,
      permissions: [
        { subject: 'Access', action: 'manageUsers', conditions: [] },
      ],
    });
    const manager = await member(app, tenantId, [managerRole.json().id]);
    await call('POST', `${URL}/${south}/members`, admin.headers, {
      userId: manager.id,
    });
    const user = await member(app, tenantId, []);
    const outside = await call(
      'POST',
      `${URL}/${north}/members`,
      manager.headers,
      { userId: user.id },
    );
    expect(outside.statusCode).toBe(403);
    expect(outside.json().code).toBe('unit_authority_required');
    expect(
      (
        await call('POST', `${URL}/${south}/members`, manager.headers, {
          userId: user.id,
        })
      ).statusCode,
    ).toBe(201);
    // A lead takes leading it.
    expect(
      (
        await call(
          'PATCH',
          `${URL}/${south}/members/${user.id}`,
          manager.headers,
          { role: 'lead' },
        )
      ).statusCode,
    ).toBe(403);
    // Changing the tree is another permission.
    expect(
      (
        await call('POST', URL, manager.headers, {
          type: 'team',
          name: 'Mine',
          parentId: sales,
        })
      ).statusCode,
    ).toBe(403);
    expect((await call('GET', URL, manager.headers)).statusCode).toBe(200);
  });

  it('lists users by unit, with their units', async () => {
    const { tenantId, admin, sales, north } = await tree();
    const inSales = await member(app, tenantId, []);
    const inNorth = await member(app, tenantId, []);
    await call('POST', `${URL}/${sales}/members`, admin.headers, {
      userId: inSales.id,
    });
    await call('POST', `${URL}/${north}/members`, admin.headers, {
      userId: inNorth.id,
    });
    const ids = async (query: string) =>
      (
        (await call('GET', `/v1/access/users?${query}`, admin.headers)).json()
          .items as { id: string }[]
      ).map((u) => u.id);
    // A unit's current members, not those of the units below.
    expect(await ids(`unitId=${sales}`)).toEqual([inSales.id]);
    expect((await ids(`unitId.in=${sales},${north}`)).sort()).toEqual(
      [inSales.id, inNorth.id].sort(),
    );
    expect(
      (
        await call('GET', `/v1/access/users/${inNorth.id}`, admin.headers)
      ).json().unitIds,
    ).toEqual([north]);
  });

  it('keeps sibling names unique ignoring case, moves subtrees, and deletes only empty units', async () => {
    const { tenantId, admin, sales, north, south, northEast } = await tree();
    const listed = (await call('GET', URL, admin.headers)).json().items;
    expect(
      listed.find((u: { id: string }) => u.id === northEast),
    ).toMatchObject({ depth: 2, parentId: north, type: 'team' });

    const taken = await call('POST', URL, admin.headers, {
      type: 'team',
      name: 'north',
      parentId: sales,
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe('unit_name_taken');
    expect(
      (await call('POST', URL, admin.headers, { type: 'team', name: 'SALES' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call('PATCH', `${URL}/${south}`, admin.headers, { name: 'NORTH' }))
        .statusCode,
    ).toBe(409);
    const other = await call('POST', URL, admin.headers, {
      type: 'team',
      name: 'North',
      parentId: south,
    });
    expect(other.statusCode).toBe(201);

    // Moving a subtree moves what is reached through it.
    const southLead = await member(app, tenantId, [
      await readingWith(admin.headers, 'inUnitsILeadAndBelow'),
    ]);
    await call('POST', `${URL}/${south}/members`, admin.headers, {
      userId: southLead.id,
      role: 'lead',
    });
    // A member below the moved unit: what is above them changes too.
    const eastMember = await member(app, tenantId, [
      await readingWith(admin.headers, 'inMyUnitsAndAbove'),
    ]);
    await call('POST', `${URL}/${northEast}/members`, admin.headers, {
      userId: eastMember.id,
    });
    const impact = (status: number) =>
      call('POST', `${URL}/${north}/impact`, admin.headers, {
        parentId: south,
        type: 'team',
      }).then((response) => {
        expect(response.statusCode).toBe(status);
        return response.json();
      });
    // The preview refuses what the move would refuse…
    expect((await impact(409)).code).toBe('unit_name_taken');
    expect(
      (await call('DELETE', `${URL}/${other.json().id}`, admin.headers))
        .statusCode,
    ).toBe(204);
    // …and tells who would reach what, without moving anything.
    const previewed = await impact(200);
    expect(
      previewed.changes.find(
        (change: { userId: string }) => change.userId === southLead.id,
      ),
    ).toMatchObject({
      ledAndBelow: {
        gains: expect.arrayContaining([north, northEast]),
        loses: [],
      },
    });
    expect(await reach(tenantId, southLead.id)).toEqual(['South']);
    expect(
      previewed.changes.find(
        (change: { userId: string }) => change.userId === eastMember.id,
      ),
    ).toMatchObject({ andAbove: { gains: [south], loses: [] } });
    expect(await reach(tenantId, eastMember.id)).toEqual([
      'North',
      'North East',
      'Sales',
    ]);
    expect(
      (
        await call('PATCH', `${URL}/${north}`, admin.headers, {
          parentId: south,
          type: 'team',
        })
      ).statusCode,
    ).toBe(200);
    expect(await reach(tenantId, southLead.id)).toEqual([
      'North',
      'North East',
      'South',
    ]);
    // Never under itself or a unit below it.
    expect(
      (
        await call('PATCH', `${URL}/${south}`, admin.headers, {
          parentId: northEast,
        })
      ).statusCode,
    ).toBe(409);

    const notEmpty = async (id: string) => {
      const refused = await call('DELETE', `${URL}/${id}`, admin.headers);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('unit_not_empty');
    };
    await notEmpty(south);
    const empty = (
      await call('POST', URL, admin.headers, {
        type: 'department',
        name: 'Empty',
      })
    ).json().id as string;
    const passing = await member(app, tenantId, []);
    await call('POST', `${URL}/${empty}/members`, admin.headers, {
      userId: passing.id,
    });
    await notEmpty(empty);
    expect(
      (
        await call(
          'DELETE',
          `${URL}/${empty}/members/${passing.id}`,
          admin.headers,
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (await call('DELETE', `${URL}/${empty}`, admin.headers)).statusCode,
    ).toBe(204);
    expect(
      (await call('GET', `${URL}/${empty}/members`, admin.headers)).statusCode,
    ).toBe(404);
  });

  it("keeps to the tenant: another tenant's administrator finds none of its units", async () => {
    const { sales } = await tree();
    const other = await tenantWithAdmin(app);
    expect(
      (await call('GET', `${URL}/${sales}/members`, other.admin.headers))
        .statusCode,
    ).toBe(404);
    expect((await call('GET', URL, other.admin.headers)).json().items).toEqual(
      [],
    );
  });
});
