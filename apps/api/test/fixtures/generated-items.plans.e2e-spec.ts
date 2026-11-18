import type { Type } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import pg from 'pg';
import { bootModules } from '../boot.js';
import { captured, fullScans } from '../query-plans.js';
import { recordsTenant, testItemModules, unitWithLead } from '../records.js';
import type { Member } from '../records.js';
import { GeneratedItemsModule } from './generated-feature/generated-items.module.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    MAIL_TRANSPORT: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    STORAGE_DRIVER: 'memory',
    WEBHOOKS_WORKER: 'off',
    REDIS_PREFIX: `test-generated-plans-${process.pid}-${Date.now()}`,
  });
});

/**
 * What the generated e2e spec boots besides testItemModules(), for every
 * add-on: the generator's own account (schematics/feature/addons.js, plain
 * JavaScript, so imported by a computed path), so a removed module's add-on
 * is gone from both.
 */
async function addonModules() {
  const generator = '../../schematics/feature/addons.js';
  const { ADDONS, bootOf } = (await import(generator)) as {
    ADDONS: Record<string, unknown>;
    bootOf: (addons: string[]) => [string, string][];
  };
  return Promise.all(
    bootOf(Object.keys(ADDONS)).map(
      async ([name, path]) =>
        ((await import(`../../src/${path}`)) as Record<string, Type>)[name]!,
    ),
  );
}

/** Rows of another tenant, so a list that reads the whole table shows. */
const OTHER_TENANT_ROWS = 20_000;
/** Each member's own, live and in the bin. */
const OWN_ROWS = 150;

/**
 * The generated feature's reads on a table of realistic size: every
 * statement a list sends (the page, its access conditions, the add-ons
 * it reads) uses an index, for each kind of member. The shape every new
 * feature starts from (docs/adding-a-feature.md).
 */
describe('generated-items query plans (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;
  let lead: Member;

  /** Inserts `count` rows of `ownerId` in `tenantId` (and its unit). */
  async function seed(
    db: pg.Client,
    tenantId: string,
    ownerId: string,
    count: number,
    { unitId = null as string | null, deleted = false } = {},
  ) {
    await db.query(
      `insert into generated_items (tenant_id, owner_id, unit_id, title, status, code, deleted_at)
       select $1, $2, $3, 'Item ' || n, 'draft', $2 || '-' || $4 || '-' || n, $5
       from generate_series(1, $6::int) n`,
      [
        tenantId,
        ownerId,
        unitId,
        deleted ? 'bin' : 'live',
        deleted ? new Date() : null,
        count,
      ],
    );
  }

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      ...(await addonModules()),
      GeneratedItemsModule,
    );
    team = await recordsTenant(app);
    const unit = await unitWithLead(app, team);
    lead = unit.lead;
    const other = await recordsTenant(app);
    // As the maintenance role (BYPASSRLS): rows of two tenants at once.
    const db = new pg.Client({
      connectionString: process.env.DATABASE_MAINTENANCE_URL,
    });
    await db.connect();
    try {
      await seed(db, other.tenantId, other.editor.id, OTHER_TENANT_ROWS);
      for (const member of [team.editor, team.other]) {
        await seed(db, team.tenantId, member.id, OWN_ROWS);
        await seed(db, team.tenantId, member.id, OWN_ROWS, { deleted: true });
      }
      await seed(db, team.tenantId, unit.worker.id, OWN_ROWS, {
        unitId: unit.unitId,
      });
    } finally {
      await db.end();
    }
    // As the owner: statistics (and the visibility map, for index-only scans).
    const owner = new pg.Client({
      connectionString: process.env.DATABASE_OWNER_URL,
    });
    await owner.connect();
    try {
      await owner.query('vacuum analyze generated_items');
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  const reads = (url: string, member: Member) =>
    captured(async () => {
      const answer = await app.inject({
        method: 'GET',
        url,
        headers: member.headers,
      });
      expect(answer.statusCode, answer.body).toBe(200);
    });

  const urls = () => [
    process.env.DATABASE_URL!,
    process.env.DATABASE_MAINTENANCE_URL!,
  ];

  it('reports a statement no index serves (the check itself)', async () => {
    const statement = {
      text: 'select id from generated_items where title = $1',
      values: ['Item 7'],
      user: new URL(process.env.DATABASE_URL!).username,
      tenantId: team.tenantId,
    };
    expect(await fullScans([statement], ['generated_items'], urls())).toEqual([
      `generated_items: ${statement.text}`,
    ]);
  });

  it.each([
    ['an administrator lists every record', '/v1/generated-items', 'admin'],
    ['an editor lists their own', '/v1/generated-items', 'editor'],
    ['a viewer reads the next page', '/v1/generated-items?limit=50', 'viewer'],
    [
      'an editor opens the recycle bin',
      '/v1/generated-items?deleted=true',
      'editor',
    ],
    ['a unit lead lists the unit', '/v1/generated-items', 'lead'],
  ] as const)('%s with indexes', async (_, url, who) => {
    const member = who === 'lead' ? lead : team[who];
    const statements = await reads(url, member);
    expect(statements.length).toBeGreaterThan(0);
    expect(await fullScans(statements, ['generated_items'], urls())).toEqual(
      [],
    );
  });
});
