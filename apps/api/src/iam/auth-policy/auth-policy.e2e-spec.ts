import { getDrizzleToken } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import { TransactionHost } from '@nestjs-cls/transactional';
import { MfaService } from '@nestjs/authentication';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { browser, CheapPasswordsModule } from '../../../test/account.js';
import { createUser } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import { MAIL_QUEUE } from '../../core/mail/mail.queue.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { RolesService } from '../access/roles.service.js';
import { AccountModule } from '../account/account.module.js';
import { AuthPolicyModule } from './auth-policy.module.js';
import { TenantAuthPolicies } from './auth-policy.service.js';

const OPS = vi.hoisted(() => `ops-${process.pid}-${Date.now()}`);

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-auth-policy-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    PASSWORD_BREACH_CHECK: 'off',
    OPERATOR_TENANT: OPS,
    SESSION_IDLE_MINUTES: '60',
    SESSION_MAX_HOURS: '12',
  });
});

describe('auth policy (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      AccountModule,
      AuthPolicyModule,
      CheapPasswordsModule,
    );
  });

  afterAll(async () => {
    await app
      ?.get<Queue>(`BullQueue_${MAIL_QUEUE}`)
      .obliterate({ force: true });
    await app?.close();
  });

  afterEach(() => vi.restoreAllMocks());

  const policyOf = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/v1/access/auth-policy', headers });
  const change = (headers: Record<string, string>, payload: object) =>
    app.inject({
      method: 'PATCH',
      url: '/v1/access/auth-policy',
      headers,
      payload,
    });
  /** The two-factor check answers "enrolled" for these users. */
  const enrolled = (...ids: string[]) => {
    const mfa = app.get(MfaService);
    const real = mfa.isEnrolled.bind(mfa);
    vi.spyOn(mfa, 'isEnrolled').mockImplementation(async (id) =>
      ids.includes(id) ? true : real(id),
    );
  };

  it('shows the defaults to an administrator, and nothing to a member without the permission', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const response = await policyOf(admin.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      requireMfa: false,
      passwordMinLength: null,
      passwordHistory: null,
      sessionIdleMinutes: null,
      sessionMaxHours: null,
      allowBreakGlass: true,
    });
    const plain = await member(app, tenantId);
    expect((await policyOf(plain.headers)).statusCode).toBe(403);
    expect((await change(plain.headers, { requireMfa: true })).statusCode).toBe(
      403,
    );
  });

  it("reads a tenant's policy once a request, and again after a change", async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const read = vi.spyOn(
      app.get(TenantAuthPolicies) as unknown as {
        read: (tenantId: string) => Promise<unknown>;
      },
      'read',
    );
    const reads = () =>
      read.mock.calls.filter(([id]) => id === tenantId).length;
    // Its session limits, its two-factor rule and the page itself: one read.
    expect((await policyOf(admin.headers)).statusCode).toBe(200);
    expect(reads()).toBe(1);
    const changed = await change(admin.headers, { passwordMinLength: 14 });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await policyOf(admin.headers)).json().passwordMinLength).toBe(14);
  });

  it('requires two-factor: refused to a caller who has none, then members are held to enrolment', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const refused = await change(admin.headers, { requireMfa: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('mfa_enroll_first');

    enrolled(admin.id);
    const set = await change(admin.headers, { requireMfa: true });
    expect(set.statusCode).toBe(200);
    expect(set.json().requireMfa).toBe(true);
    // The administrator, enrolled, carries on.
    expect((await policyOf(admin.headers)).statusCode).toBe(200);

    const plain = await member(app, tenantId, ['administrator']);
    const held = await policyOf(plain.headers);
    expect(held.statusCode).toBe(403);
    expect(held.json().code).toBe('mfa_enrollment_required');
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: plain.headers,
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().mfaEnrollmentRequired).toBe(true);

    // Another tenant's members are not held.
    const other = await tenantWithAdmin(app);
    expect((await policyOf(other.admin.headers)).statusCode).toBe(200);

    expect(
      (await change(admin.headers, { requireMfa: false })).statusCode,
    ).toBe(200);
    expect((await policyOf(plain.headers)).statusCode).toBe(200);
  });

  it("only shortens the deployment's session limits", async () => {
    const { admin } = await tenantWithAdmin(app);
    const longer = await change(admin.headers, { sessionIdleMinutes: 61 });
    expect(longer.statusCode).toBe(400);
    expect(longer.json().code).toBe('setting_not_allowed');
    expect(
      (await change(admin.headers, { sessionMaxHours: 13 })).statusCode,
    ).toBe(400);
    expect(
      (await change(admin.headers, { sessionIdleMinutes: 4 })).statusCode,
    ).toBe(400);
    const shorter = await change(admin.headers, {
      sessionIdleMinutes: 30,
      sessionMaxHours: 8,
    });
    expect(shorter.statusCode).toBe(200);
    const me = (
      await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: admin.headers,
      })
    ).json();
    // A token has no session lifetime to tell; the policy still holds.
    expect(me.session).toBeNull();
  });

  it("holds a new password to the tenant's minimum length, and the tenant's alone", async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    expect(
      (await change(admin.headers, { passwordMinLength: 30 })).statusCode,
    ).toBe(200);
    const signedIn = async (tenant: string) => {
      const user = await createUser(app, { tenantId: tenant });
      const agent = browser(app);
      await agent.post('/v1/auth/sign-in', {
        email: user.email,
        password: user.password,
      });
      return { user, agent };
    };
    const { user, agent } = await signedIn(tenantId);
    const short = await agent.post('/v1/auth/password/change', {
      currentPassword: user.password,
      newPassword: 'twenty-two characters',
    });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({
      code: 'password_too_short',
      minLength: 30,
    });
    const long = await agent.post('/v1/auth/password/change', {
      currentPassword: user.password,
      newPassword: 'a passphrase of thirty-one chars',
    });
    expect(long.statusCode).toBe(204);

    const elsewhere = await signedIn((await tenantWithAdmin(app)).tenantId);
    expect(
      (
        await elsewhere.agent.post('/v1/auth/password/change', {
          currentPassword: elsewhere.user.password,
          newPassword: 'twenty-two characters',
        })
      ).statusCode,
    ).toBe(204);
  });

  const UNITS = '/v1/access/organizational-units';
  const unitCall = (
    headers: Record<string, string>,
    url: string,
    payload: object,
  ) => app.inject({ method: 'POST', url, headers, payload });
  const putUnit = (headers: Record<string, string>, id: string, body: object) =>
    app.inject({
      method: 'PUT',
      url: `/v1/access/auth-policy/units/${id}`,
      headers,
      payload: body,
    });

  it('requires two-factor per unit: inherited down the tree, never outside it', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const unit = async (name: string, parentId?: string) =>
      (
        await unitCall(admin.headers, UNITS, { type: 'team', name, parentId })
      ).json().id as string;
    const sales = await unit('Sales');
    const north = await unit('North', sales);
    const other = await unit('Support');
    const inUnit = async (unitId: string) => {
      const person = await member(app, tenantId, ['administrator']);
      expect(
        (
          await unitCall(admin.headers, `${UNITS}/${unitId}/members`, {
            userId: person.id,
          })
        ).statusCode,
      ).toBe(201);
      return person;
    };
    const salesPerson = await inUnit(sales);
    const northPerson = await inUnit(north);
    const supportPerson = await inUnit(other);
    const outsider = await member(app, tenantId, ['administrator']);

    // The writer is outside the unit: no enrolment asked of them.
    const set = await putUnit(admin.headers, sales, { requireMfa: true });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ requireMfa: true });
    const read = await app.inject({
      method: 'GET',
      url: `/v1/access/auth-policy/units/${north}`,
      headers: admin.headers,
    });
    expect(read.json()).toEqual({ requireMfa: false });
    expect((await policyOf(salesPerson.headers)).json().code).toBe(
      'mfa_enrollment_required',
    );
    // A member of a unit under it is held too.
    expect((await policyOf(northPerson.headers)).statusCode).toBe(403);
    // Neither another unit's member nor someone in no unit.
    expect((await policyOf(supportPerson.headers)).statusCode).toBe(200);
    expect((await policyOf(outsider.headers)).statusCode).toBe(200);

    expect(
      (await putUnit(admin.headers, sales, { requireMfa: false })).statusCode,
    ).toBe(200);
    expect((await policyOf(northPerson.headers)).statusCode).toBe(200);
    expect(
      (await putUnit(admin.headers, randomUUID(), { requireMfa: true }))
        .statusCode,
    ).toBe(404);
  });

  it('refuses a unit requirement that would lock its writer out, and asks the permission', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const created = await unitCall(admin.headers, UNITS, {
      type: 'team',
      name: 'Ops',
    });
    const unitId = created.json().id as string;
    // Not one's own units: another administrator places the writer.
    const placer = await member(app, tenantId, ['administrator']);
    const joined = await unitCall(
      placer.headers,
      `${UNITS}/${unitId}/members`,
      {
        userId: admin.id,
      },
    );
    expect(joined.statusCode, joined.body).toBe(201);
    const refused = await putUnit(admin.headers, unitId, { requireMfa: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('mfa_enroll_first');
    enrolled(admin.id);
    expect(
      (await putUnit(admin.headers, unitId, { requireMfa: true })).statusCode,
    ).toBe(200);

    const viewer = await member(app, tenantId, ['viewer']);
    expect((await putUnit(viewer.headers, unitId, {})).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/access/auth-policy/units/${unitId}`,
          headers: viewer.headers,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("holds every tenant to the operators' value, which no tenant can go below", async () => {
    const tenancy = app.get(Tenancy);
    // The boot makes the operators' tenant (OPERATOR_TENANT), roles seeded.
    const db = app.get<Database>(getDrizzleToken());
    let [ops] = await db.select().from(tenants).where(eq(tenants.slug, OPS));
    if (!ops) {
      ops = await tenancy.create({ slug: OPS, name: 'Operators' });
      await tenancy.run(ops.id, () =>
        app
          .get(TransactionHost)
          .withTransaction(() => app.get(RolesService).seedTenantRoles()),
      );
    }
    const operator = await member(app, ops.id, ['administrator']);
    const { tenantId, admin } = await tenantWithAdmin(app);
    const person = await member(app, tenantId, ['administrator']);
    const platform = (headers: Record<string, string>, payload?: object) =>
      app.inject({
        method: payload ? 'PUT' : 'GET',
        url: '/v1/access/auth-policy/platform',
        headers,
        ...(payload && { payload }),
      });

    // Operators only: a tenant's administrator is refused whatever they hold.
    expect((await platform(admin.headers)).json().code).toBe(
      'operator_required',
    );
    expect(
      (await platform(admin.headers, { requireMfa: true })).statusCode,
    ).toBe(403);
    expect(
      (await platform((await member(app, ops.id, ['viewer'])).headers))
        .statusCode,
    ).toBe(403);
    // Covering the writer: they need two-factor themselves.
    expect(
      (await platform(operator.headers, { requireMfa: true })).json().code,
    ).toBe('mfa_enroll_first');

    enrolled(operator.id, admin.id);
    try {
      const set = await platform(operator.headers, { requireMfa: true });
      expect(set.statusCode).toBe(200);
      expect((await platform(operator.headers)).json()).toEqual({
        requireMfa: true,
      });
      // The tenant says no; the platform's value holds.
      expect(
        (await change(admin.headers, { requireMfa: false })).statusCode,
      ).toBe(200);
      expect((await policyOf(person.headers)).json().code).toBe(
        'mfa_enrollment_required',
      );
    } finally {
      await platform(operator.headers, { requireMfa: false });
    }
    expect((await policyOf(person.headers)).statusCode).toBe(200);
  });

  it('keeps the break-glass opt-out', async () => {
    const { admin } = await tenantWithAdmin(app);
    expect(
      (await change(admin.headers, { allowBreakGlass: false })).statusCode,
    ).toBe(200);
    expect((await policyOf(admin.headers)).json().allowBreakGlass).toBe(false);
  });
});
