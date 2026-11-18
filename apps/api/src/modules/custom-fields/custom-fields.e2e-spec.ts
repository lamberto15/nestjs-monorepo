import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { member } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { DataTransferModule } from '../data-transfer/data-transfer.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { CustomFieldsModule } from './custom-fields.module.js';
import {
  CUSTOM_FIELDS_BODY,
  CUSTOM_FIELDS_RESPONSE,
} from './custom-fields.schemas.js';
import { customFieldValues } from './custom-fields.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.REDIS_PREFIX = `test-custom-fields-${process.pid}-${Date.now()}`;
});

type Team = Awaited<ReturnType<typeof recordsTenant>>;

/** Custom fields on the test items: definitions, values, lists. Each test in a tenant of its own. */
describe('custom fields (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      StorageModule,
      testItemsModule({
        imports: [
          CustomFieldsModule.forRecord(TEST_ITEM),
          DataTransferModule.forRecord(TEST_ITEM),
        ],
        body: CUSTOM_FIELDS_BODY,
        response: CUSTOM_FIELDS_RESPONSE,
      }),
    );
  });
  afterAll(async () => {
    await app?.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);

  /** A role of these permissions (no conditions), by id. */
  async function role(team: Team, ...permissions: [string, string][]) {
    const created = await call('POST', '/v1/access/roles', team.admin.headers, {
      name: `role-${randomUUID().slice(0, 8)}`,
      permissions: permissions.map(([subject, action]) => ({
        subject,
        action,
        conditions: [],
      })),
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().id as string;
  }

  /** Adds a field to TestItem as the administrator. */
  async function field(team: Team, definition: Record<string, unknown>) {
    const created = await call(
      'POST',
      '/v1/custom-fields',
      team.admin.headers,
      {
        subject: 'TestItem',
        label: String(definition.key),
        ...definition,
      },
    );
    expect(created.statusCode, created.body).toBe(201);
    return created.json() as { id: string; key: string };
  }

  const write = (headers: Headers, custom?: Record<string, unknown>) =>
    call('POST', '/v1/test-items', headers, {
      title: `Item ${randomUUID().slice(0, 6)}`,
      ...(custom && { custom }),
    });

  it('lets managers define fields, and anyone who reads the subject list them', async () => {
    const team = await recordsTenant(app);
    const manager = await member(app, team.tenantId, [
      await role(team, ['Access', 'manageCustomFields']),
    ]);
    const outsider = team.nobody;
    const created = await call('POST', '/v1/custom-fields', manager.headers, {
      subject: 'TestItem',
      key: 'region',
      label: 'Region',
      type: 'select',
      options: [
        { value: 'eu', label: 'Europe' },
        { value: 'us', label: 'Americas' },
      ],
      filterable: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      subject: 'TestItem',
      key: 'region',
      type: 'select',
      required: false,
      default: null,
      position: 0,
      active: true,
    });
    const id = created.json().id as string;

    // Changing definitions: Access.manageCustomFields.
    const text = { subject: 'TestItem', key: 'x', label: 'X', type: 'text' };
    expect(
      (await call('POST', '/v1/custom-fields', team.editor.headers, text))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call('PATCH', `/v1/custom-fields/${id}`, team.editor.headers, {
          label: 'No',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('DELETE', `/v1/custom-fields/${id}`, team.editor.headers))
        .statusCode,
    ).toBe(403);

    // Reading them: whoever may read test items, or manages them.
    for (const headers of [
      team.editor.headers,
      team.viewer.headers,
      manager.headers,
    ]) {
      const listed = await call(
        'GET',
        '/v1/custom-fields?subject=TestItem',
        headers,
      );
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().items.map((f: { key: string }) => f.key)).toEqual([
        'region',
      ]);
    }
    expect(
      (
        await call(
          'GET',
          '/v1/custom-fields?subject=TestItem',
          outsider.headers,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', '/v1/custom-fields?subject=Nope', manager.headers))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call('POST', '/v1/custom-fields', manager.headers, {
          ...text,
          subject: 'Nope',
        })
      ).statusCode,
    ).toBe(404);

    // Keys: slugs, unique per subject, never reused.
    const again = await call('POST', '/v1/custom-fields', manager.headers, {
      ...text,
      key: 'region',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('custom_field_exists');
    const slug = await call('POST', '/v1/custom-fields', manager.headers, {
      ...text,
      key: 'Not A Slug',
    });
    expect(slug.statusCode).toBe(400);
    expect(paths(slug.json())).toEqual(['key']);

    // Order: these first, the others after; audited.
    const second = await field(team, { key: 'second', type: 'text' });
    const ordered = await call(
      'PUT',
      '/v1/custom-fields/order',
      manager.headers,
      {
        subject: 'TestItem',
        ids: [second.id],
      },
    );
    expect(ordered.statusCode, ordered.body).toBe(200);
    expect(ordered.json().items.map((f: { key: string }) => f.key)).toEqual([
      'second',
      'region',
    ]);
    const entries = await app
      .get(Tenancy)
      .run(team.tenantId, () =>
        app
          .get<Database>(getDrizzleToken())
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.targetType, 'customField')),
      );
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'customField.created',
      'customField.created',
      'customField.reordered',
    ]);
  });

  it('lists the subjects that take custom fields, to whoever may read their fields', async () => {
    const team = await recordsTenant(app);
    const subjects = await call(
      'GET',
      '/v1/custom-fields/subjects',
      team.editor.headers,
    );
    expect(subjects.statusCode, subjects.body).toBe(200);
    expect(subjects.json().items).toEqual([
      {
        subject: 'TestItem',
        label: { singular: 'Test item', plural: 'Test items' },
      },
    ]);
    expect(
      (await call('GET', '/v1/custom-fields/subjects', team.nobody.headers))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('GET', '/v1/custom-fields/subjects', {})).statusCode,
    ).toBe(401);
  });

  it('names the nested path of each error on a definition', async () => {
    const team = await recordsTenant(app);
    const create = (body: Record<string, unknown>) =>
      call('POST', '/v1/custom-fields', team.admin.headers, {
        subject: 'TestItem',
        label: 'X',
        key: `k${randomUUID().slice(0, 6).replace(/-/g, '')}`,
        ...body,
      });
    const choice = (value: string) => ({ value, label: 'Label' });
    const refused = async (body: Record<string, unknown>) => {
      const response = await create(body);
      expect(response.statusCode, response.body).toBe(400);
      return paths(response.json());
    };
    expect(
      await refused({ type: 'text', validation: { pattern: '(' } }),
    ).toEqual(['validation.pattern']);
    expect(
      await refused({
        type: 'select',
        options: [
          choice('a'),
          choice('b'),
          choice('a'),
          choice('c'),
          choice('b'),
        ],
      }),
    ).toEqual(['options.2.value', 'options.4.value']);
    expect(
      await refused({ type: 'select', options: [choice('a'), choice(' ')] }),
    ).toEqual(['options.1.value']);
    expect(
      await refused({ type: 'select', options: [{ value: 'a', label: '' }] }),
    ).toEqual(['options.0.label']);
    expect(
      await refused({
        type: 'multiSelect',
        options: [choice('a'), choice('b,c')],
      }),
    ).toEqual(['options.1.value']);
    expect(await refused({ type: 'select' })).toEqual(['options']);
    expect(await refused({ type: 'number', default: 'x' })).toEqual([
      'default',
    ]);
    expect(
      (
        await refused({
          type: 'number',
          validation: { min: 5, max: 1, pattern: 'x' },
        })
      ).sort(),
    ).toEqual(['validation.min', 'validation.pattern']);
    // The same on a change, against the field as it would be saved.
    const select = await create({
      type: 'select',
      options: [choice('a'), choice('b')],
    });
    const patched = await call(
      'PATCH',
      `/v1/custom-fields/${select.json().id}`,
      team.admin.headers,
      {
        options: [choice('a'), choice('b'), choice('a')],
      },
    );
    expect(patched.statusCode).toBe(400);
    expect(paths(patched.json())).toEqual(['options.2.value']);
  });

  it('checks every type of value, by field, and shows them on the record', async () => {
    const team = await recordsTenant(app);
    await field(team, {
      key: 'short',
      type: 'text',
      validation: { maxLength: 5 },
    });
    await field(team, { key: 'story', type: 'longText' });
    await field(team, {
      key: 'amount',
      type: 'number',
      validation: { min: 0, max: 100 },
    });
    await field(team, { key: 'done', type: 'boolean' });
    await field(team, { key: 'due', type: 'date' });
    await field(team, {
      key: 'region',
      type: 'select',
      options: [
        { value: 'eu', label: 'Europe' },
        { value: 'us', label: 'Americas' },
      ],
    });
    await field(team, {
      key: 'tags',
      type: 'multiSelect',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      validation: { max: 2 },
    });
    await field(team, { key: 'contact', type: 'email' });
    await field(team, { key: 'site', type: 'url' });
    await field(team, {
      key: 'code',
      type: 'text',
      validation: { pattern: '[A-Z]{3}' },
    });
    const valid = {
      short: 'short',
      story: 'x'.repeat(5_000),
      amount: 42.5,
      done: true,
      due: '2026-12-31',
      region: 'eu',
      tags: ['a', 'b'],
      contact: 'sam@example.com',
      site: 'https://example.com/x',
      code: 'ABC',
    };
    const created = await write(team.editor.headers, valid);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().custom).toEqual(valid);
    const read = await call(
      'GET',
      `/v1/test-items/${created.json().id}`,
      team.viewer.headers,
    );
    expect(read.json().custom).toEqual(valid);
    // A record without values shows an empty object.
    expect((await createTestItem(app, team.editor.headers)).custom).toEqual({});

    const wrong: [string, unknown][] = [
      ['short', 'too long'],
      ['short', 5],
      ['story', 'x'.repeat(10_001)],
      ['amount', '42'],
      ['amount', 101],
      ['done', 'yes'],
      ['due', '31/12/2026'],
      ['region', 'asia'],
      ['tags', ['a', 'c']],
      ['tags', ['a', 'a']],
      ['tags', 'a'],
      ['contact', 'not-an-email'],
      ['site', 'javascript:alert(1)'],
      ['code', 'abc'],
      ['nope', 'x'],
    ];
    for (const [key, value] of wrong) {
      const refused = await write(team.editor.headers, { [key]: value });
      expect(refused.statusCode, `${key}: ${refused.body}`).toBe(400);
      expect(refused.json().code).toBe('validation_failed');
      expect(
        paths(refused.json()).some((path) => path.startsWith(`custom.${key}`)),
      ).toBe(true);
    }
  });

  it('enforces required fields on create, fills defaults, merges updates and audits each key', async () => {
    const team = await recordsTenant(app);
    await field(team, { key: 'code', type: 'text', required: true });
    await field(team, {
      key: 'priority',
      type: 'number',
      required: true,
      default: 3,
    });
    await field(team, { key: 'region', type: 'text' });
    const headers = team.editor.headers;

    const missing = await write(headers);
    expect(missing.statusCode).toBe(400);
    expect(paths(missing.json())).toEqual(['custom.code']);
    const created = await write(headers, { code: 'A1', region: 'north' });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().custom).toEqual({
      code: 'A1',
      priority: 3,
      region: 'north',
    });
    const id = created.json().id as string;

    // Only the keys sent change; null removes one; a required one can't go.
    const merged = await call('PATCH', `/v1/test-items/${id}`, headers, {
      custom: { region: 'south' },
    });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json().custom).toEqual({
      code: 'A1',
      priority: 3,
      region: 'south',
    });
    const removed = await call('PATCH', `/v1/test-items/${id}`, headers, {
      title: 'Renamed',
      custom: { region: null },
    });
    expect(removed.json()).toMatchObject({
      title: 'Renamed',
      custom: { code: 'A1', priority: 3 },
    });
    expect(removed.json().custom).not.toHaveProperty('region');
    const required = await call('PATCH', `/v1/test-items/${id}`, headers, {
      custom: { code: null },
    });
    expect(required.statusCode).toBe(400);
    expect(paths(required.json())).toEqual(['custom.code']);
    expect(
      (
        await call('PATCH', `/v1/test-items/${id}`, headers, {
          custom: { nope: 1 },
        })
      ).statusCode,
    ).toBe(400);
    // A refused change changes nothing: the record's own fields neither.
    expect(
      (await call('GET', `/v1/test-items/${id}`, headers)).json().title,
    ).toBe('Renamed');

    // Audited key by key, from → to.
    const entries = await app.get(Tenancy).run(team.tenantId, () =>
      app
        .get<Database>(getDrizzleToken())
        .select({ details: auditLog.details })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'testItem.customValuesUpdated'),
            eq(auditLog.targetId, id),
          ),
        )
        .orderBy(auditLog.at),
    );
    expect(
      entries.map((entry) => (entry.details as { changes: unknown }).changes),
    ).toEqual([
      { region: { from: 'north', to: 'south' } },
      { region: { from: 'south', to: null } },
    ]);
  });

  it('keeps the values of a deactivated field, and refuses changes that would break values', async () => {
    const team = await recordsTenant(app);
    const admin = team.admin.headers;
    const region = await field(team, { key: 'region', type: 'text' });
    const unused = await field(team, { key: 'unused', type: 'text' });
    const size = await field(team, {
      key: 'size',
      type: 'select',
      options: [
        { value: 's', label: 'S' },
        { value: 'l', label: 'L' },
      ],
    });
    const item = (
      await write(team.editor.headers, { region: 'eu', size: 's' })
    ).json();

    const refused = await call(
      'PATCH',
      `/v1/custom-fields/${region.id}`,
      admin,
      { type: 'number' },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('custom_field_in_use');
    expect(
      (
        await call('PATCH', `/v1/custom-fields/${region.id}`, admin, {
          type: 'longText',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call('PATCH', `/v1/custom-fields/${unused.id}`, admin, {
          type: 'number',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call('PATCH', `/v1/custom-fields/${size.id}`, admin, {
          options: [{ value: 'l', label: 'L' }],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('PATCH', `/v1/custom-fields/${size.id}`, admin, {
          options: [{ value: 's', label: 'Small' }],
        })
      ).statusCode,
    ).toBe(200);

    // Deactivated: refused on writes, ignored when required, values kept but not shown.
    await call('PATCH', `/v1/custom-fields/${region.id}`, admin, {
      required: true,
    });
    expect(
      (await call('DELETE', `/v1/custom-fields/${region.id}`, admin))
        .statusCode,
    ).toBe(204);
    expect((await write(team.editor.headers)).statusCode).toBe(201);
    const unknown = await write(team.editor.headers, { region: 'us' });
    expect(paths(unknown.json())).toEqual(['custom.region']);
    expect(
      (await call('GET', `/v1/test-items/${item.id}`, admin)).json().custom,
    ).toEqual({ size: 's' });
    const [stored] = await app
      .get(Tenancy)
      .run(team.tenantId, () =>
        app
          .get<Database>(getDrizzleToken())
          .select({ values: customFieldValues.values })
          .from(customFieldValues)
          .where(eq(customFieldValues.recordId, item.id)),
      );
    expect(stored!.values).toEqual({ region: 'eu', size: 's' });
    // A change keeps an inactive field's value.
    await call('PATCH', `/v1/test-items/${item.id}`, team.editor.headers, {
      custom: { size: null },
    });
    expect(
      (
        await call('PATCH', `/v1/custom-fields/${region.id}`, admin, {
          active: true,
          required: false,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await call('GET', `/v1/test-items/${item.id}`, admin)).json().custom,
    ).toEqual({ region: 'eu' });
    expect(
      (
        await call('POST', '/v1/custom-fields', admin, {
          subject: 'TestItem',
          key: 'region',
          label: 'R',
          type: 'number',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('counts the records holding a value, for those who manage the fields; values go with the record', async () => {
    const team = await recordsTenant(app);
    await field(team, { key: 'region', type: 'text' });
    await field(team, { key: 'note', type: 'text' });
    const counts = async (query = '') => {
      const listed = await call(
        'GET',
        `/v1/custom-fields?subject=TestItem&include=counts${query}`,
        team.admin.headers,
      );
      expect(listed.statusCode, listed.body).toBe(200);
      return Object.fromEntries(
        (
          listed.json().items as {
            key: string;
            valueCount: number;
            deletedValueCount: number;
          }[]
        ).map((item) => [item.key, [item.valueCount, item.deletedValueCount]]),
      );
    };
    expect(
      (
        await call(
          'GET',
          '/v1/custom-fields?subject=TestItem',
          team.admin.headers,
        )
      ).json().items[0],
    ).not.toHaveProperty('valueCount');
    expect(await counts()).toEqual({ region: [0, 0], note: [0, 0] });
    expect(
      (
        await call(
          'GET',
          '/v1/custom-fields?subject=TestItem&include=counts',
          team.editor.headers,
        )
      ).statusCode,
    ).toBe(403);

    await write(team.editor.headers, { region: 'eu', note: 'a' });
    await write(team.editor.headers, { region: 'us' });
    const trashed = (await write(team.editor.headers, { region: 'eu' })).json()
      .id as string;
    await write(team.editor.headers, {});
    expect(await counts()).toEqual({ region: [3, 0], note: [1, 0] });
    expect(
      (await call('DELETE', `/v1/test-items/${trashed}`, team.editor.headers))
        .statusCode,
    ).toBe(204);
    expect(await counts()).toEqual({ region: [2, 1], note: [1, 0] });

    // Another tenant counts its own.
    const other = await recordsTenant(app);
    await field(other, { key: 'region', type: 'text' });
    expect(
      (
        await call(
          'GET',
          '/v1/custom-fields?subject=TestItem&include=counts',
          other.admin.headers,
        )
      ).json().items[0].valueCount,
    ).toBe(0);

    // Gone for good from the recycle bin: its values go too.
    const { RecycleBinPurgeJob } =
      await import('../records/recycle-bin.job.js');
    const { testItems } =
      await import('../../../test/fixtures/test-items/test-items.tables.js');
    const db = app.get<Database>(getDrizzleToken());
    await app.get(Tenancy).run(team.tenantId, () =>
      db
        .update(testItems)
        .set({ deletedAt: new Date(Date.now() - 400 * 86_400_000) })
        .where(eq(testItems.id, trashed)),
    );
    await app.get(RecycleBinPurgeJob).run();
    const left = await app
      .get(Tenancy)
      .run(team.tenantId, () =>
        db
          .select({ id: customFieldValues.id })
          .from(customFieldValues)
          .where(eq(customFieldValues.recordId, trashed)),
      );
    expect(left).toEqual([]);
    expect(await counts()).toEqual({ region: [2, 0], note: [1, 0] });
  });

  it('describes them in the list description', async () => {
    const team = await recordsTenant(app);
    await field(team, { key: 'region', type: 'text', filterable: true });
    const described = await call(
      'GET',
      '/v1/lists/TestItem',
      team.editor.headers,
    );
    expect(described.statusCode, described.body).toBe(200);
    expect(described.json().capabilities).toMatchObject({ custom: true });
    expect(described.json().customFields).toEqual([
      {
        name: 'custom.region',
        key: 'region',
        label: 'region',
        type: 'text',
        options: null,
        required: false,
        filterable: true,
        sortable: false,
      },
    ]);
  });

  describe('in lists', () => {
    /** Test items of the editor's, each with these custom values; then a list call. */
    async function itemsWith(team: Team, values: Record<string, unknown>[]) {
      const ids: string[] = [];
      for (const [i, custom] of values.entries()) {
        const created = await call(
          'POST',
          '/v1/test-items',
          team.editor.headers,
          { title: `Item ${i}`, custom },
        );
        expect(created.statusCode, created.body).toBe(201);
        ids.push(created.json().id);
      }
      return Object.assign(
        (query: string) =>
          call('GET', `/v1/test-items${query}`, team.editor.headers),
        { ids },
      );
    }
    const titles = (body: { items: { title: string }[] }) =>
      body.items.map((item) => item.title);

    it('filters by equality, any-of, presence, ranges and in or-groups', async () => {
      const team = await recordsTenant(app);
      await field(team, { key: 'note', type: 'text', filterable: true });
      await field(team, {
        key: 'region',
        type: 'select',
        options: ['eu', 'us'].map((value) => ({ value, label: value })),
        filterable: true,
      });
      await field(team, { key: 'amount', type: 'number', filterable: true });
      await field(team, { key: 'done', type: 'boolean', filterable: true });
      await field(team, { key: 'due', type: 'date', filterable: true });
      await field(team, {
        key: 'tags',
        type: 'multiSelect',
        options: ['a', 'b', 'c', 'd'].map((value) => ({ value, label: value })),
        filterable: true,
      });
      const list = await itemsWith(team, [
        {
          note: 'x',
          region: 'eu',
          amount: 5,
          done: false,
          due: '2026-01-05',
          tags: ['a', 'b'],
        },
        { note: 'y', region: 'us', amount: 2.5, done: true, tags: ['c'] },
        {},
        { region: 'eu', amount: 7 },
      ]);
      await call(
        'PATCH',
        `/v1/test-items/${list.ids[3]}`,
        team.editor.headers,
        { custom: { region: null } },
      );
      const found = async (query: string) => {
        const response = await list(query);
        expect(response.statusCode, `${query}: ${response.body}`).toBe(200);
        return titles(response.json()).sort((a, b) => a.localeCompare(b));
      };
      expect(await found('?custom.note=x')).toEqual(['Item 0']);
      expect(await found('?custom.note.in=x,y')).toEqual(['Item 0', 'Item 1']);
      expect(await found('?custom.note.contains=Y')).toEqual(['Item 1']);
      expect(await found('?custom.region=eu')).toEqual(['Item 0']);
      expect(await found('?custom.region.ne=eu')).toEqual(['Item 1']);
      expect(await found('?custom.amount=5')).toEqual(['Item 0']);
      expect(await found('?custom.amount=2.5')).toEqual(['Item 1']);
      expect(await found('?custom.amount.in=2.5,5')).toEqual([
        'Item 0',
        'Item 1',
      ]);
      expect(await found('?custom.amount.gte=5')).toEqual(['Item 0', 'Item 3']);
      expect(await found('?custom.done=false')).toEqual(['Item 0']);
      expect(await found('?custom.done=true')).toEqual(['Item 1']);
      expect(await found('?custom.due=2026-01-05')).toEqual(['Item 0']);
      expect(await found('?custom.due.lt=2026-02-01')).toEqual(['Item 0']);
      expect(await found('?custom.tags.in=b,c')).toEqual(['Item 0', 'Item 1']);
      expect(await found('?custom.tags.in=d')).toEqual([]);
      expect(await found('?custom.region.isNull=false')).toEqual([
        'Item 0',
        'Item 1',
      ]);
      expect(await found('?custom.region.isNull=true')).toEqual([
        'Item 2',
        'Item 3',
      ]);
      const filter = encodeURIComponent(
        JSON.stringify({
          or: [
            { field: 'custom.tags', op: 'in', value: ['c'] },
            { field: 'custom.amount', op: 'eq', value: 5 },
          ],
        }),
      );
      expect(await found(`?filter=${filter}`)).toEqual(['Item 0', 'Item 1']);
      // Another tenant's values never match.
      const other = await recordsTenant(app);
      await field(other, { key: 'note', type: 'text', filterable: true });
      await call('POST', '/v1/test-items', other.editor.headers, {
        title: 'Theirs',
        custom: { note: 'x' },
      });
      expect(await found('?custom.note=x')).toEqual(['Item 0']);
    });

    it('sorts and selects custom fields like declared ones, and refuses what is not offered', async () => {
      const team = await recordsTenant(app);
      await field(team, {
        key: 'region',
        type: 'select',
        options: [
          { value: 'eu', label: 'Europe' },
          { value: 'us', label: 'Americas' },
        ],
        filterable: true,
        sortable: true,
      });
      await field(team, {
        key: 'amount',
        type: 'number',
        filterable: true,
        sortable: true,
      });
      await field(team, {
        key: 'due',
        type: 'date',
        filterable: true,
        sortable: true,
      });
      await field(team, {
        key: 'tags',
        type: 'multiSelect',
        options: ['a', 'b'].map((value) => ({ value, label: value })),
        filterable: true,
      });
      await field(team, { key: 'secret', type: 'text' });
      const list = await itemsWith(team, [
        { region: 'eu', amount: 5, due: '2026-03-01' },
        { region: 'us', amount: 50, due: '2026-01-15' },
        { region: 'eu', amount: 20 },
        { amount: 1 },
      ]);

      // Sorted by a number, paged two at a time: every item once, in order.
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const response = await list(
          `?sort=custom.amount&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json() as {
          items: { title: string }[];
          nextCursor: string | null;
        };
        for (const item of body.items)
          expect(item).not.toHaveProperty(['custom.amount']);
        seen.push(...titles(body));
        cursor = body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(['Item 3', 'Item 0', 'Item 2', 'Item 1']);
      // Descending: no value counts as the largest, so it comes first (ties: newest first).
      expect(titles((await list('?sort=-custom.due')).json())).toEqual([
        'Item 3',
        'Item 2',
        'Item 0',
        'Item 1',
      ]);

      // fields= inside custom too.
      const picked = await list('?fields=title,custom.region&custom.region=us');
      expect(picked.json().items).toEqual([
        { id: expect.any(String), title: 'Item 1', custom: { region: 'us' } },
      ]);

      // Not filterable, not sortable, unknown, not an option: 400.
      for (const query of [
        '?custom.secret=x',
        '?sort=custom.secret',
        '?sort=custom.tags',
        '?custom.nope=1',
        '?custom.region=mars',
      ]) {
        expect((await list(query)).statusCode, query).toBe(400);
      }
    });

    it('applies a new field at once, and hides a deactivated one', async () => {
      const team = await recordsTenant(app);
      const list = await itemsWith(team, [{}]);
      expect((await list('?custom.color=red')).statusCode).toBe(400);
      const color = await field(team, {
        key: 'color',
        type: 'text',
        filterable: true,
      });
      expect((await list('?custom.color=red')).statusCode).toBe(200);
      const created = await write(team.editor.headers, { color: 'red' });
      expect(created.json().custom).toEqual({ color: 'red' });
      await call('DELETE', `/v1/custom-fields/${color.id}`, team.admin.headers);
      expect(
        (
          await call(
            'GET',
            `/v1/test-items/${created.json().id}`,
            team.editor.headers,
          )
        ).json().custom,
      ).toEqual({});
      expect((await list('?custom.color=red')).statusCode).toBe(400);
    });

    it('runs patterns on RE2: linear time on any value', async () => {
      const team = await recordsTenant(app);
      await field(team, {
        key: 'evil',
        type: 'longText',
        validation: { pattern: '(a|aa)+$' },
      });
      await field(team, {
        key: 'slow',
        type: 'longText',
        validation: { pattern: '.*.*.*.*x' },
      });
      const started = performance.now();
      const refused = await write(team.editor.headers, {
        evil: `${'a'.repeat(9_999)}!`,
        slow: 'a'.repeat(10_000),
      });
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(refused.statusCode).toBe(400);
      expect(paths(refused.json())).toEqual(['custom.evil', 'custom.slow']);
      expect(
        (await write(team.editor.headers, { evil: 'aaa', slow: 'aax' }))
          .statusCode,
      ).toBe(201);
    });
  });

  it('exports and imports the custom values as custom.<key> columns', async () => {
    const team = await recordsTenant(app);
    const field = await call('POST', '/v1/custom-fields', team.admin.headers, {
      subject: 'TestItem',
      key: 'region',
      label: 'Region',
      type: 'select',
      options: [
        { value: 'eu', label: 'Europe' },
        { value: 'us', label: 'Americas' },
      ],
    });
    expect(field.statusCode, field.body).toBe(201);
    const local = (url: string) => {
      const { pathname, search } = new URL(url);
      return pathname + search;
    };
    const settled = async (id: string) => {
      for (let tries = 0; tries < 400; tries++) {
        const transfer = (
          await call('GET', `/v1/data/transfers/${id}`, team.admin.headers)
        ).json<{
          status: string;
          result?: { url?: string; imported?: number };
        }>();
        if (['completed', 'failed'].includes(transfer.status)) return transfer;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('The transfer did not end');
    };

    // Import: a file with the column creates a record holding the value; a bad value is that row's error.
    const boundary = '----custom';
    const csv = 'title,custom.region\r\nWith region,eu\r\nBad region,mars\r\n';
    const imported = await app.inject({
      method: 'POST',
      url: '/v1/data/imports',
      headers: {
        ...team.admin.headers,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\ntest-items\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="items.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
      ),
    });
    expect(imported.statusCode, imported.body).toBe(202);
    const done = await settled(imported.json<{ id: string }>().id);
    expect(done.result).toMatchObject({ imported: 1, failed: 1 });

    // Export: one column per field, not the `custom` object.
    const started = await call('POST', '/v1/data/exports', team.admin.headers, {
      name: 'test-items',
      format: 'csv',
    });
    expect(started.statusCode).toBe(202);
    const exported = await settled(started.json<{ id: string }>().id);
    const file = await app.inject({
      method: 'GET',
      url: local(exported.result!.url!),
    });
    const [header, ...rows] = file.body
      .replace(/^\u{feff}/u, '')
      .trim()
      .split('\r\n');
    expect(header).toContain('custom.region');
    expect(header).not.toMatch(/(^|,)custom(,|$)/);
    const at = header!.split(',').indexOf('custom.region');
    expect(rows.map((row) => row.split(',')[at])).toEqual(['eu']);
  });
});
