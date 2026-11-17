import { randomInt, randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { and, eq, like, sql } from 'drizzle-orm';
import { accessModules } from '../../../test/access.js';
import { browser, CheapPasswordsModule } from '../../../test/account.js';
import { createUser } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import { SoftwareAuthenticator } from '../../../test/software-authenticator.js';
import type { Database } from '../../core/database/database.js';
import { MAIL_QUEUE } from '../../core/mail/mail.queue.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { auditLog } from '../audit/audit.tables.js';
import { sessions } from '../auth/auth.tables.js';
import { AccountModule } from './account.module.js';
import { passkeys } from './account.tables.js';

const ANDROID_FINGERPRINT = Array.from({ length: 32 }, (_, i) =>
  i.toString(16).padStart(2, '0').toUpperCase(),
).join(':');

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-passkeys-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    PASSWORD_BREACH_CHECK: 'off',
    WEB_URL: 'https://web.example.com',
    // The web app's origin is trusted (the package's login-CSRF check).
    CORS_ORIGINS: 'https://web.example.com',
    PASSKEY_ANDROID_APPS: `com.example.app:${Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':')}`,
    PASSKEY_APPLE_APPS: 'ABCDE12345.com.example.app',
  });
});

const WEB = 'https://web.example.com';
const RP_ID = 'web.example.com';
const origin = { origin: WEB };
/** An address of its own, so per-address limits don't add up. */
const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('passkeys (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      AccountModule,
      CheapPasswordsModule,
    );
    db = app.get<Database>(getDrizzleToken());
  });

  afterAll(async () => {
    await app
      ?.get<Queue>(`BullQueue_${MAIL_QUEUE}`)
      .obliterate({ force: true });
    await app?.close();
  });

  /** A user signed in with a password from the web app, with an authenticator of their own. */
  async function person() {
    const created = await createUser(app);
    const agent = browser(app, ip());
    const signedIn = await agent.post(
      '/v1/auth/sign-in',
      { email: created.email, password: created.password },
      origin,
    );
    expect(signedIn.statusCode).toBe(200);
    return {
      ...created,
      agent,
      device: new SoftwareAuthenticator({ origin: WEB }),
    };
  }
  type Person = Awaited<ReturnType<typeof person>>;

  async function register(who: Person, name = 'Laptop') {
    const options = await who.agent.post(
      '/v1/auth/passkeys/registration/options',
      {},
      origin,
    );
    expect(options.statusCode).toBe(200);
    const { response } = who.device.create(options.json());
    const created = await who.agent.post(
      '/v1/auth/passkeys',
      { name, response },
      origin,
    );
    expect(created.statusCode).toBe(201);
    return created.json<{ id: string }>().id;
  }

  async function signInOptions(body: { email?: string } = {}) {
    const response = await browser(app, ip()).post(
      '/v1/auth/passkeys/sign-in/options',
      body,
      origin,
    );
    expect(response.statusCode).toBe(200);
    return response.json<{
      challenge: string;
      rpId: string;
      allowCredentials?: { id: string; transports: string[] }[];
    }>();
  }

  const signIn = (response: unknown, agent = browser(app, ip())) =>
    agent.post('/v1/auth/passkeys/sign-in', { response }, origin);

  it('registers named passkeys, lists, renames and removes them, audited in no tenant', async () => {
    const me = await person();
    const laptop = await register(me, 'Laptop');
    const phone = await register(me, 'Phone');
    const listed = (await me.agent.get('/v1/auth/passkeys')).json<{
      items: { id: string; name: string }[];
    }>().items;
    expect(listed.map((item) => item.name)).toEqual(['Laptop', 'Phone']);
    expect(listed[0]).toMatchObject({ id: laptop, backedUp: false });
    expect(listed[0]).not.toHaveProperty('publicKey');

    const renamed = await me.agent.patch(`/v1/auth/passkeys/${phone}`, {
      name: 'Pixel',
    });
    expect(renamed.json()).toMatchObject({ name: 'Pixel' });
    // Another user's passkey is nobody's business: 404.
    const other = await person();
    expect(
      (await other.agent.patch(`/v1/auth/passkeys/${phone}`, { name: 'Mine' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await other.agent.delete(`/v1/auth/passkeys/${phone}`)).statusCode,
    ).toBe(404);
    expect(
      (await me.agent.delete(`/v1/auth/passkeys/${phone}`)).statusCode,
    ).toBe(204);

    const entries = await db
      .select({ action: auditLog.action, tenantId: auditLog.tenantId })
      .from(auditLog)
      .where(
        and(
          like(auditLog.action, 'auth.passkey-%'),
          eq(auditLog.targetId, me.user.id),
        ),
      )
      .orderBy(auditLog.id);
    expect(entries.map((entry) => entry.action)).toEqual([
      'auth.passkey-added',
      'auth.passkey-added',
      'auth.passkey-renamed',
      'auth.passkey-removed',
    ]);
    expect(entries.every((entry) => entry.tenantId === null)).toBe(true);
  });

  it('wants user verification and the session that asked', async () => {
    const me = await person();
    const ask = async () =>
      (
        await me.agent.post(
          '/v1/auth/passkeys/registration/options',
          {},
          origin,
        )
      ).json();
    const options = await ask();
    expect(options).toMatchObject({
      rp: { id: RP_ID },
      authenticatorSelection: { userVerification: 'required' },
    });
    const unverified = await me.agent.post(
      '/v1/auth/passkeys',
      {
        name: 'Key',
        response: me.device.create(options, { uv: false }).response,
      },
      origin,
    );
    expect(unverified.statusCode).toBe(400);
    expect(unverified.json()).toMatchObject({ reason: 'user-verification' });
    // The challenge went with it: one-time.
    const replay = await me.agent.post(
      '/v1/auth/passkeys',
      { name: 'Key', response: me.device.create(options).response },
      origin,
    );
    expect(replay.json()).toMatchObject({ reason: 'challenge' });
    // Another browser of the same user can't finish this session's ceremony.
    const second = await ask();
    const elsewhere = browser(app, ip());
    await elsewhere.post(
      '/v1/auth/sign-in',
      { email: me.email, password: me.password },
      origin,
    );
    const otherSession = await elsewhere.post(
      '/v1/auth/passkeys',
      { name: 'Key', response: me.device.create(second).response },
      origin,
    );
    expect(otherSession.json()).toMatchObject({ reason: 'session' });
    // Nor a page of another origin (clientDataJSON).
    const third = await ask();
    const phished = await me.agent.post(
      '/v1/auth/passkeys',
      {
        name: 'Key',
        response: me.device.create(third, {
          origin: 'https://web.example.com.evil.test',
        }).response,
      },
      origin,
    );
    expect(phished.json()).toMatchObject({ reason: 'origin' });
  });

  it('signs in usernameless and with an email, each challenge once', async () => {
    const me = await person();
    await register(me);
    const usernameless = await signInOptions();
    expect(usernameless.allowCredentials).toBeUndefined();
    expect(usernameless.rpId).toBe(RP_ID);
    const agent = browser(app, ip());
    const assertion = me.device.get(usernameless);
    const signedIn = await signIn(assertion, agent);
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toEqual({ signedIn: true, mfaRequired: false });
    const sessions = (await agent.get('/v1/auth/sessions')).json<{
      items: { current: boolean; method: string }[];
    }>().items;
    expect(sessions.find((item) => item.current)?.method).toBe('passkey');
    // The same answer again: the challenge is gone.
    expect((await signIn(assertion)).statusCode).toBe(401);

    const byEmail = await signInOptions({ email: me.email });
    expect(byEmail.allowCredentials?.map((c) => c.id)).toEqual([
      me.device.credentials[0]!.id,
    ]);
    expect((await signIn(me.device.get(byEmail))).statusCode).toBe(200);
    const [row] = await db
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, me.user.id));
    expect(row?.counter).toBe(2);
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it('answers an email without passkeys, or without an account, like one with them', async () => {
    const me = await person();
    await register(me);
    const unknown = `${randomUUID().slice(0, 8)}@example.com`;
    const noPasskeys = await person();
    const shapes = await Promise.all([
      signInOptions({ email: me.email }),
      signInOptions({ email: unknown }),
      signInOptions({ email: noPasskeys.email }),
    ]);
    for (const options of shapes) {
      expect(Object.keys(options).sort()).toEqual(
        Object.keys(shapes[0]!).sort(),
      );
      expect([1, 2]).toContain(options.allowCredentials?.length);
    }
    // The decoy is the same every time: a second look tells nothing either.
    const again = await signInOptions({ email: ` ${unknown.toUpperCase()} ` });
    expect(again.allowCredentials).toEqual(shapes[1]!.allowCredentials);
  });

  it('registers only from a recent sign-in; a password re-authenticates in place, audited', async () => {
    const me = await person();
    const current = async () =>
      (await me.agent.get('/v1/auth/sessions'))
        .json<{ items: { id: string; current: boolean }[] }>()
        .items.find((item) => item.current)!;
    // The sign-in, 11 minutes ago.
    await db
      .update(sessions)
      .set({
        metadata: sql`${sessions.metadata} || ${JSON.stringify({
          authenticatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
        })}::jsonb`,
      })
      .where(eq(sessions.id, (await current()).id));
    const stale = await me.agent.post(
      '/v1/auth/passkeys/registration/options',
      {},
      origin,
    );
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ code: 'reauthentication_required' });
    const status = (await me.agent.get('/v1/auth/reauthenticate')).json<{
      methods: string[];
    }>();
    expect(status.methods).toContain('password');

    const wrong = await me.agent.post(
      '/v1/auth/reauthenticate',
      { password: randomUUID() },
      origin,
    );
    expect(wrong.statusCode).toBe(403);
    const before = await current();
    const done = await me.agent.post(
      '/v1/auth/reauthenticate',
      { password: me.password },
      origin,
    );
    expect(done.statusCode).toBe(200);
    expect((await current()).id).not.toBe(before.id);
    await register(me);
    const audited = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          like(auditLog.action, 'auth.reauthenticat%'),
          like(auditLog.actor, `%${me.user.id}%`),
        ),
      )
      .orderBy(auditLog.id);
    expect(audited.map((row) => row.action)).toEqual([
      'auth.reauthentication-failed',
      'auth.reauthenticated',
    ]);
  });

  it('serves the native apps’ association files from configuration', async () => {
    const links = await app.inject({
      method: 'GET',
      url: '/.well-known/assetlinks.json',
    });
    expect(links.json()).toEqual([
      {
        relation: [
          'delegate_permission/common.handle_all_urls',
          'delegate_permission/common.get_login_creds',
        ],
        target: {
          namespace: 'android_app',
          package_name: 'com.example.app',
          sha256_cert_fingerprints: [ANDROID_FINGERPRINT],
        },
      },
    ]);
    const apple = await app.inject({
      method: 'GET',
      url: '/.well-known/apple-app-site-association',
    });
    expect(apple.headers['content-type']).toMatch(/application\/json/);
    expect(apple.json()).toEqual({
      webcredentials: { apps: ['ABCDE12345.com.example.app'] },
    });
  });
});
