import type { NestNodeApplication } from '@nestjs/platform-node';
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
import { AccountModule } from './account.module.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-who-am-i-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    PASSWORD_BREACH_CHECK: 'off',
    AUTH_MAGIC_LINK: 'on',
    PASSKEYS: 'on',
  });
});

describe('who am I, sign-in methods and the profile (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      AccountModule,
      CheapPasswordsModule,
    );
  });

  afterAll(async () => {
    await app
      ?.get<Queue>(`BullQueue_${MAIL_QUEUE}`)
      .obliterate({ force: true });
    await app?.close();
  });

  it('answers 401 without a credential', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('tells a browser session who it is, its tenant, factors, lifetime and what it may do', async () => {
    const { tenantId } = await tenantWithAdmin(app);
    const created = await createUser(app, { tenantId, name: 'Ada' });
    const agent = browser(app);
    expect(
      (
        await agent.post('/v1/auth/sign-in', {
          email: created.email,
          password: created.password,
        })
      ).statusCode,
    ).toBe(200);
    const response = await agent.get('/v1/auth/me');
    expect(response.statusCode).toBe(200);
    const me = response.json();
    expect(me.user).toMatchObject({
      kind: 'user',
      id: created.user.id,
      email: created.email,
      name: 'Ada',
      tenantId,
    });
    expect(me.user).not.toHaveProperty('onboarding');
    expect(me.tenant).toMatchObject({ id: tenantId, operator: false });
    expect(me).toMatchObject({
      mfaEnabled: false,
      hasPassword: true,
      mfaEnrollmentRequired: false,
      onboardingRequired: null,
      authentication: { via: 'session', method: 'password' },
    });
    expect(me.authentication.recentUntil).toEqual(expect.any(String));
    expect(me.session).toMatchObject({ idleMinutes: expect.any(Number) });
    // A member without roles: actions listed, none allowed.
    expect(me.can['Access.manageRoles']).toBe(false);
  });

  it('gives an administrator their abilities, and a token no session lifetime', async () => {
    const { admin } = await tenantWithAdmin(app);
    const me = (
      await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: admin.headers,
      })
    ).json();
    expect(me.can['Access.manageRoles']).toBe(true);
    expect(me.session).toBeNull();
    expect(me.authentication).toMatchObject({ via: 'token' });
  });

  it('lists the ways in for the sign-in page, without a credential', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/methods',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      password: true,
      magicLink: true,
      passkeys: true,
      providers: [],
      captcha: null,
    });
  });

  it('changes the name, language and time zone; refuses what it does not know', async () => {
    const { tenantId } = await tenantWithAdmin(app);
    const user = await member(app, tenantId);
    const patch = (payload: object) =>
      app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: user.headers,
        payload,
      });
    const changed = await patch({
      name: 'Grace',
      locale: 'en-GB',
      timezone: 'Europe/Berlin',
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      name: 'Grace',
      locale: 'en',
      timezone: 'Europe/Berlin',
      tenantId,
    });
    expect((await patch({ timezone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await patch({ locale: 'xx' })).statusCode).toBe(400);
    expect((await patch({ email: 'x@y.z' })).statusCode).toBe(400);
    const reset = await patch({ locale: null, timezone: null });
    expect(reset.json()).toMatchObject({ locale: null, timezone: null });
  });
});
