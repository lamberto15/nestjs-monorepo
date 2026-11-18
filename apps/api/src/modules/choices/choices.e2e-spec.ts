import { randomUUID } from 'node:crypto';
import { Injectable, Module } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { recordsTenant, testItemModules } from '../../../test/records.js';
import {
  type ChoiceProvider,
  ChoiceSource,
  type ChoiceSet,
} from './choices.registry.js';
import { ChoicesModule } from './choices.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
});

/** The statuses a test item may take here: only "draft". */
@ChoiceSource()
@Injectable()
class StatusChoices implements ChoiceProvider {
  readonly key = 'test-statuses';
  readonly label = 'Test statuses';
  readonly params = {};
  mayUse = async () => true;
  options = async () => [{ value: 'draft', label: 'Draft' }];
  has = async ({ value }: { value: string }) => value === 'draft';
}

@Module({ providers: [StatusChoices] })
class StatusChoicesModule {}

const STATUS_SET: ChoiceSet = {
  key: 'test-status',
  label: 'Status',
  fields: { status: { provider: 'test-statuses' } },
};

describe('dependent choices (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Record<string, string>;

  beforeAll(async () => {
    app = await bootModules(...accessModules(), ChoicesModule);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    ({
      tenantId,
      admin: { headers: admin },
    } = await tenantWithAdmin(app));
  });

  const get = (url: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url, headers });

  async function unit(...members: { id: string }[]) {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/access/organizational-units',
      headers: admin,
      payload: { type: 'team', name: `unit-${randomUUID().slice(0, 6)}` },
    });
    const id = created.json<{ id: string }>().id;
    for (const one of members) {
      const added = await app.inject({
        method: 'POST',
        url: `/v1/access/organizational-units/${id}/members`,
        headers: admin,
        payload: { userId: one.id },
      });
      expect(added.statusCode).toBe(201);
    }
    return id;
  }

  it('describes the set, parents first, and answers a child for its parent only', async () => {
    const ann = await member(app, tenantId, ['editor']);
    const bob = await member(app, tenantId, ['editor']);
    const sales = await unit(ann);
    const ops = await unit(bob);

    const set = await get('/v1/choices/unit-member', ann.headers);
    expect(
      set.json<{ fields: { name: string }[] }>().fields.map((f) => f.name),
    ).toEqual(['unit', 'member']);
    expect(set.json<{ fields: object[] }>().fields[1]).toMatchObject({
      dependsOn: ['unit'],
    });

    const members = await get(
      `/v1/choices/unit-member/member/options?parent.unit=${sales}`,
      ann.headers,
    );
    expect(members.json()).toMatchObject({
      parents: { unit: sales },
      items: [{ value: ann.id }],
    });

    // Another unit's members are not hers to list: an empty answer, as for a unit that does not exist.
    const hidden = await get(
      `/v1/choices/unit-member/member/options?parent.unit=${ops}`,
      ann.headers,
    );
    expect(hidden.json<{ items: unknown[] }>().items).toEqual([]);
    // Whoever manages users sees them.
    const seen = await get(
      `/v1/choices/unit-member/member/options?parent.unit=${ops}`,
      admin,
    );
    expect(seen.json<{ items: unknown[] }>().items).toHaveLength(1);

    // Bounded, typed parameters: missing, malformed or foreign ones are 400s.
    for (const url of [
      '/v1/choices/unit-member/member/options',
      '/v1/choices/unit-member/member/options?parent.unit=nope',
      `/v1/choices/unit-member/member/options?parent.unit=${sales}&limit=1000`,
      '/v1/choices/unit-member/unit/options?parent.x=1',
    ]) {
      expect((await get(url, ann.headers)).statusCode).toBe(400);
    }
    expect((await get('/v1/choices/nothing', ann.headers)).statusCode).toBe(
      404,
    );
    expect(
      (await get('/v1/choices/unit-member/nothing/options', ann.headers))
        .statusCode,
    ).toBe(404);
  });

  it('checks a value again on write: it must fit the parent sent with it', async () => {
    const ann = await member(app, tenantId, ['editor']);
    const bob = await member(app, tenantId, ['editor']);
    const sales = await unit(ann);
    const ops = await unit(bob);
    const check = (values: Record<string, string | null>) =>
      app.inject({
        method: 'POST',
        url: '/v1/choices/unit-member/validate',
        headers: ann.headers,
        payload: { values },
      });

    expect((await check({ unit: sales, member: ann.id })).statusCode).toBe(204);
    const moved = await check({ unit: ops, member: bob.id });
    expect(moved.statusCode).toBe(400);
    expect(
      moved.json<{ errors: { path: string }[] }>().errors.map((e) => e.path),
    ).toEqual(['member']);
    expect((await check({ unit: sales, member: bob.id })).statusCode).toBe(400);
    expect((await check({ member: ann.id })).statusCode).toBe(400);
    expect(
      (await check({ unit: randomUUID(), member: ann.id })).statusCode,
    ).toBe(400);
    expect((await check({ unit: sales, member: 'a label' })).statusCode).toBe(
      400,
    );
  });
});

describe('choices on a record (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      ChoicesModule,
      testItemsModule({
        imports: [
          StatusChoicesModule,
          ChoicesModule.forRecord(TEST_ITEM, STATUS_SET),
        ],
      }),
    );
    team = await recordsTenant(app);
  });
  afterAll(() => app.close());

  it('refuses a write whose value is not an available choice', async () => {
    const create = (status: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/test-items',
        headers: team.editor.headers,
        payload: { title: 'Choice', status },
      });
    const refused = await create('done');
    expect(refused.statusCode).toBe(400);
    expect(
      refused.json<{ errors: { path: string }[] }>().errors.map((e) => e.path),
    ).toEqual(['status']);
    const ok = await create('draft');
    expect(ok.statusCode).toBe(201);

    const id = ok.json<{ id: string }>().id;
    const patch = (payload: object) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/test-items/${id}`,
        headers: team.editor.headers,
        payload,
      });
    expect((await patch({ status: 'done' })).statusCode).toBe(400);
    // A write that leaves the set's fields alone is not held to it.
    expect((await patch({ title: 'Renamed' })).statusCode).toBe(200);
  });
});
