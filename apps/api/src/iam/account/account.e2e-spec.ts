import { randomBytes, randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import { InMemoryMailTransport, MailTransport } from '@nestjs/mail';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { accessModules } from '../../../test/access.js';
import { browser, CheapPasswordsModule, totp } from '../../../test/account.js';
import { createUser } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { MAIL_QUEUE } from '../../core/mail/mail.queue.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { auditLog } from '../audit/audit.tables.js';
import { users } from '../auth/auth.tables.js';
import { AccountModule } from './account.module.js';
import { mfaAuthenticators } from './account.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-account-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    PASSWORD_BREACH_CHECK: 'off',
    PASSWORD_HISTORY: '3',
    AUTH_MAGIC_LINK: 'on',
    WEB_URL: 'https://web.example.com',
  });
});

const newPassword = () => `new ${randomBytes(12).toString('hex')} pass`;

describe('account (e2e)', () => {
  let app: NestNodeApplication;
  let mailbox: InMemoryMailTransport;
  let db: Database;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      AccountModule,
      CheapPasswordsModule,
    );
    mailbox = app.get(MailTransport) as InMemoryMailTransport;
    db = app.get<Database>(getDrizzleToken());
  });

  afterAll(async () => {
    await app
      ?.get<Queue>(`BullQueue_${MAIL_QUEUE}`)
      .obliterate({ force: true });
    await app?.close();
  });

  /** The token in the link of the mail sent to `to` about `path`. */
  async function tokenMailed(to: string, path: string) {
    let token: string | undefined;
    await vi.waitFor(
      () => {
        const mail = [...mailbox.mails]
          .reverse()
          .find(
            (m) =>
              m.to.some((a) => a.address === to) &&
              m.html?.includes(`https://web.example.com${path}?token=`),
          );
        token = mail?.html?.match(/token=([\w-]+)/)?.[1];
        expect(token).toBeDefined();
      },
      { timeout: 15_000 },
    );
    return token!;
  }

  async function signedIn() {
    const created = await createUser(app);
    const agent = browser(app);
    const response = await agent.post('/v1/auth/sign-in', {
      email: created.email,
      password: created.password,
    });
    expect(response.statusCode).toBe(200);
    return { ...created, agent };
  }

  it('resets a forgotten password once, signing the account out everywhere', async () => {
    const user = await signedIn();
    // The same answer with or without an account.
    const nobody = await browser(app).post('/v1/auth/password/forgot', {
      email: `nobody-${randomUUID()}@example.com`,
    });
    expect(nobody.statusCode).toBe(202);
    const asked = await browser(app).post('/v1/auth/password/forgot', {
      email: user.email,
    });
    expect(asked.statusCode).toBe(202);
    const token = await tokenMailed(user.email, '/reset-password');

    const password = newPassword();
    const anonymous = browser(app);
    expect(
      (await anonymous.post('/v1/auth/password/reset', { token, password }))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await anonymous.post('/v1/auth/password/reset', {
          token,
          password: newPassword(),
        })
      ).statusCode,
    ).toBe(400);
    expect((await user.agent.get('/v1/auth/sessions')).statusCode).toBe(401);
    expect(
      (
        await browser(app).post('/v1/auth/sign-in', {
          email: user.email,
          password: user.password,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await browser(app).post('/v1/auth/sign-in', {
          email: user.email,
          password,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('changes a password with the current one, keeping only this browser signed in', async () => {
    const user = await signedIn();
    const other = browser(app);
    await other.post('/v1/auth/sign-in', {
      email: user.email,
      password: user.password,
    });
    const wrong = await user.agent.post('/v1/auth/password/change', {
      currentPassword: randomUUID(),
      newPassword: newPassword(),
    });
    expect(wrong.statusCode).toBe(403);
    // The same password again: one of the account's last.
    const reused = await user.agent.post('/v1/auth/password/change', {
      currentPassword: user.password,
      newPassword: user.password,
    });
    expect(reused.statusCode).toBe(422);
    const changed = await user.agent.post('/v1/auth/password/change', {
      currentPassword: user.password,
      newPassword: newPassword(),
    });
    expect(changed.statusCode).toBe(204);
    expect((await user.agent.get('/v1/auth/sessions')).statusCode).toBe(200);
    expect((await other.get('/v1/auth/sessions')).statusCode).toBe(401);
    const audited = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, user.user.id));
    expect(audited.map((row) => row.action)).toContain('auth.password-changed');
  });

  it('verifies an address with the link the user asks for', async () => {
    const user = await signedIn();
    await db
      .update(users)
      .set({ emailVerified: false })
      .where(eq(users.id, user.user.id));
    expect(
      (await user.agent.post('/v1/auth/email/verification')).statusCode,
    ).toBe(202);
    const token = await tokenMailed(user.email, '/verify-email');
    expect(
      (
        await browser(app).post('/v1/auth/email/verify', {
          token: randomUUID(),
        })
      ).statusCode,
    ).toBe(400);
    // A password chosen before the address was proved goes along.
    const withoutPassword = await browser(app).post('/v1/auth/email/verify', {
      token,
    });
    expect(withoutPassword.statusCode).toBe(400);
    const verified = await browser(app).post('/v1/auth/email/verify', {
      token,
      password: user.password,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ email: user.email, emailVerified: true });
  });

  it('turns on two-factor: a sign-in then needs a code, stored encrypted', async () => {
    const user = await signedIn();
    const enrollment = await user.agent.post('/v1/auth/mfa/enroll');
    expect(enrollment.statusCode).toBe(200);
    const { secret, uri } = enrollment.json<{ secret: string; uri: string }>();
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    const [stored] = await db
      .select({ secret: mfaAuthenticators.secret })
      .from(mfaAuthenticators)
      .where(eq(mfaAuthenticators.id, user.user.id));
    expect(stored?.secret).toBeTruthy();
    expect(stored?.secret).not.toContain(secret);

    expect(
      (await user.agent.post('/v1/auth/mfa/confirm', { code: '000000' }))
        .statusCode,
    ).toBe(400);
    const confirmed = await user.agent.post('/v1/auth/mfa/confirm', {
      code: totp(secret),
    });
    expect(confirmed.statusCode).toBe(200);
    const codes = confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(codes).toHaveLength(10);

    const second = browser(app);
    const pending = await second.post('/v1/auth/sign-in', {
      email: user.email,
      password: user.password,
    });
    expect(pending.json()).toEqual({ signedIn: false, mfaRequired: true });
    expect((await second.get('/v1/auth/sessions')).statusCode).toBe(401);
    expect(
      (await second.post('/v1/auth/mfa/verify', { code: '123456' })).statusCode,
    ).toBe(401);
    const verified = await second.post('/v1/auth/mfa/verify', {
      recoveryCode: codes[0],
    });
    expect(verified.statusCode).toBe(200);
    expect((await second.get('/v1/auth/sessions')).statusCode).toBe(200);

    // Token clients need a code too.
    const noCode = await browser(app).post('/v1/auth/token', {
      email: user.email,
      password: user.password,
    });
    expect(noCode.statusCode).toBe(401);
    expect(noCode.body).toContain('mfa_required');
    const withCode = await browser(app).post('/v1/auth/token', {
      email: user.email,
      password: user.password,
      recoveryCode: codes[1],
    });
    expect(withCode.statusCode).toBe(200);
  });

  it('lists browsers and apps, and signs one out', async () => {
    const user = await signedIn();
    const issued = await browser(app).post(
      '/v1/auth/token',
      { email: user.email, password: user.password },
      { 'user-agent': 'NestJSMobile/1.0.0 (iPhone 17 Pro; iOS 26.5)' },
    );
    expect(issued.statusCode).toBe(200);
    const tokens = issued.json<{ accessToken: string; refreshToken: string }>();
    type Item = {
      id: string;
      kind: string;
      device: string | null;
      current: boolean;
    };
    const listed = (await user.agent.get('/v1/auth/sessions')).json<{
      items: Item[];
    }>().items;
    expect(listed.filter((item) => item.kind === 'browser')).toHaveLength(1);
    const appSession = listed.find((item) => item.kind === 'app');
    expect(appSession).toMatchObject({
      device: 'NestJSMobile on iOS',
      current: false,
    });
    const fromApp = (
      await browser(app).get('/v1/auth/sessions', {
        authorization: `Bearer ${tokens.accessToken}`,
      })
    ).json<{ items: Item[] }>().items;
    expect(fromApp.find((item) => item.id === appSession!.id)?.current).toBe(
      true,
    );

    expect(
      (await user.agent.delete(`/v1/auth/sessions/${appSession!.id}`))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await browser(app).post('/v1/auth/token/refresh', {
          refreshToken: tokens.refreshToken,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await user.agent.delete(`/v1/auth/sessions/${randomUUID()}`)).statusCode,
    ).toBe(404);
    expect(
      (await user.agent.post('/v1/auth/sign-out-everywhere')).statusCode,
    ).toBe(204);
    expect((await user.agent.get('/v1/auth/sessions')).statusCode).toBe(401);
  });

  it('rotates refresh tokens and revokes a family on reuse', async () => {
    const user = await createUser(app);
    const issued = await browser(app).post('/v1/auth/token', {
      email: user.email,
      password: user.password,
    });
    expect(issued.json()).toMatchObject({ expiresIn: 900 });
    const first = issued.json<{ refreshToken: string }>().refreshToken;
    const refreshed = await browser(app).post('/v1/auth/token/refresh', {
      refreshToken: first,
    });
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.json<{ refreshToken: string }>().refreshToken;
    expect(
      (
        await browser(app).post('/v1/auth/token/refresh', {
          refreshToken: first,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await browser(app).post('/v1/auth/token/refresh', {
          refreshToken: second,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('signs in by email link, in the browser that asked for it only', async () => {
    const user = await createUser(app);
    const asking = browser(app);
    expect(
      (
        await asking.post('/v1/auth/magic-link', {
          email: user.email,
          redirectTo: '/inbox',
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await asking.post('/v1/auth/magic-link', {
          email: `nobody-${randomUUID()}@example.com`,
        })
      ).statusCode,
    ).toBe(202);
    const token = await tokenMailed(user.email, '/magic-link');
    expect(
      (await browser(app).post('/v1/auth/magic-link/verify', { token }))
        .statusCode,
    ).toBe(401);
    const signedInByLink = await asking.post('/v1/auth/magic-link/verify', {
      token,
    });
    expect(signedInByLink.statusCode).toBe(200);
    expect(signedInByLink.json()).toEqual({
      signedIn: true,
      mfaRequired: false,
      redirectTo: '/inbox',
    });
    expect((await asking.get('/v1/auth/sessions')).statusCode).toBe(200);
  });
});
