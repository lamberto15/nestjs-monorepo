import { randomUUID } from 'node:crypto';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { member } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import {
  computed,
  computedResponse,
  defineComputed,
} from './computed-fields.js';
import { ComputedFieldsModule } from './computed-fields.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.REDIS_PREFIX = `test-computed-fields-${process.pid}-${Date.now()}`;
});

// `summary` reads `body`, a field granted field by field.
const TEST_ITEM_COMPUTED = defineComputed(TEST_ITEM, {
  titleLength: computed.int('length(title)'),
  summary: computed.string("concat(title, ': ', coalesce(body, ''))"),
  published: computed.bool('publishedAt != null'),
  shout: computed.string('upper(summary)'),
});

describe('computed fields (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      testItemsModule({
        imports: [
          ComputedFieldsModule.forRecord(TEST_ITEM, TEST_ITEM_COMPUTED),
        ],
        response: computedResponse(TEST_ITEM_COMPUTED),
      }),
    );
  });
  afterAll(async () => {
    await app?.close();
  });

  it('shows its computed fields, without those reading a field the reader may not see', async () => {
    const team = await recordsTenant(app);
    const { id } = await createTestItem(app, team.editor.headers, {
      title: 'Hello',
      body: 'World',
    });
    const shown = await app.inject({
      method: 'GET',
      url: `/v1/test-items/${id}`,
      headers: team.viewer.headers,
    });
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json()).toMatchObject({
      titleLength: 5,
      summary: 'Hello: World',
      published: false,
      shout: 'HELLO: WORLD',
    });

    // A change of a field it reads shows on the next read: nothing stored.
    const changed = await app.inject({
      method: 'PATCH',
      url: `/v1/test-items/${id}`,
      headers: team.editor.headers,
      payload: { title: 'Hi', publishedAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(changed.json()).toMatchObject({
      titleLength: 2,
      summary: 'Hi: World',
      published: true,
    });

    // A reader whose permissions hide `body` gets neither it nor what reads it, directly or not.
    const role = await app.inject({
      method: 'POST',
      url: '/v1/access/roles',
      headers: team.admin.headers,
      payload: {
        name: `titles-${randomUUID().slice(0, 8)}`,
        permissions: [
          { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
        ],
      },
    });
    expect(role.statusCode, role.body).toBe(201);
    const reader = await member(app, team.tenantId, [role.json().id]);
    const read = await app.inject({
      method: 'GET',
      url: `/v1/test-items/${id}`,
      headers: reader.headers,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).not.toHaveProperty('body');
    expect(read.json()).not.toHaveProperty('summary');
    expect(read.json()).not.toHaveProperty('shout');
    expect(read.json()).toMatchObject({ titleLength: 2, published: true });
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/test-items?fields=summary,titleLength',
      headers: reader.headers,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items.length).toBeGreaterThan(0);
    for (const item of listed.json().items) {
      expect(item).not.toHaveProperty('summary');
      expect(item).toHaveProperty('titleLength');
    }
  });

  it('refuses to filter or sort by one: there is no column', async () => {
    const team = await recordsTenant(app);
    for (const query of ['?titleLength=5', '?sort=titleLength']) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/test-items${query}`,
        headers: team.viewer.headers,
      });
      expect(response.statusCode, query).toBe(400);
    }
  });
});
