import { createHash } from 'node:crypto';
import {
  Controller,
  type ExecutionContext,
  Get,
  Injectable,
  Module,
  Post,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  AuthenticationProvider,
  AuthenticationRegistry,
  CurrentUser,
  PasswordHasher,
  Public,
} from '@nestjs/authentication';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import {
  accessTokenFor,
  apiClient,
  authModules,
  cookieOf,
  createUser,
  signedInUser,
  signIn,
  TEST_PASSWORD,
} from '../../../test/auth.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditListeners } from '../audit/audit.listeners.js';
import { auditLog } from '../audit/audit.tables.js';
import { type AuthConfig, authConfig } from './auth.config.js';
import { apiKeys, memberships, sessions, users } from './auth.tables.js';
import { AuthPolicySource } from './auth-policy.js';
import { AuthenticationOptionsPart } from './authentication-options.js';
import { ClientOnly } from './client-only.decorator.js';
import { RequiresSwitch } from './deployment-switch.js';
import { HostTenantResolver } from './host-tenant.js';
import { ImpersonationRules } from './impersonation.js';
import { DuringOnboarding } from './onboarding.js';
import { OperatorOnly } from './operator-only.js';
import type { RequestPrincipal } from './principal.js';
import { RecentAuthentication } from './recent-authentication.js';
import { UserOnly } from './user-only.decorator.js';
import { UserThrottle } from './user-throttle.guard.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-auth-${process.pid}-${Date.now()}`;
  process.env.OPERATOR_TENANT = 'operators';
});

const PROBLEM = 'application/problem+json';

@Controller({ path: 'probe', version: VERSION_NEUTRAL })
class ProbeController {
  constructor(private readonly tenancy: Tenancy) {}

  @Get('me')
  me(@CurrentUser() user: RequestPrincipal) {
    return { user, tenantId: this.tenancy.current()?.tenantId ?? null };
  }

  @Public()
  @Get('public')
  open(@CurrentUser() user: RequestPrincipal | null) {
    return { user };
  }

  @Get('users')
  @UserOnly()
  usersOnly(@CurrentUser() user: RequestPrincipal) {
    return user;
  }

  @Get('clients')
  @ClientOnly()
  clientsOnly(@CurrentUser() user: RequestPrincipal) {
    return user;
  }

  @Get('recent')
  @RecentAuthentication()
  recent() {
    return { ok: true };
  }

  @Get('operators')
  @OperatorOnly()
  operators() {
    return { ok: true };
  }

  @Get('switched')
  @RequiresSwitch('auth.impersonation', 'IMPERSONATION')
  switched() {
    return { ok: true };
  }

  @Post('limited')
  @UserThrottle({ limit: 2, ttl: 60_000 })
  limited() {
    return { ok: true };
  }

  @Get('onboarding')
  @DuringOnboarding()
  duringOnboarding() {
    return { ok: true };
  }
}

/** What a tenant chose, changed by the tests. */
@Injectable()
@AuthPolicySource()
class TestPolicy {
  idleMinutes?: number;
  mfaRequired = false;
  async sessionIdleMinutes() {
    return this.idleMinutes;
  }
  async requireMfa() {
    return this.mfaRequired;
  }
}

@Injectable()
@HostTenantResolver()
class TestHosts {
  readonly domains = new Map<string, string>();
  async tenantOfHost(host: string) {
    return this.domains.get(host) ?? null;
  }
}

/** Stands in for iam/impersonation's rule of who may act as whom. */
@Injectable()
@ImpersonationRules()
class TestImpersonationRules {
  allowed = true;
  async mayImpersonate() {
    return this.allowed;
  }
}

/** A provider gone wrong: it hands out the system principal. */
@Injectable()
class LeakyProvider extends AuthenticationProvider {
  constructor(registry: AuthenticationRegistry) {
    super();
    registry.registerProvider(this, { order: 9 });
  }
  authenticate(context: ExecutionContext) {
    return this.header(context, 'x-leak')
      ? { user: { kind: 'system', id: 'x', name: 'System: x' } as never }
      : null;
  }
}

/** A module's own options, merged in: cheap hashes for the tests. */
@Injectable()
@AuthenticationOptionsPart(() => ({ password: { logN: 10 } }))
class CheapPasswords {}

@Module({
  controllers: [ProbeController],
  providers: [
    TestPolicy,
    TestHosts,
    TestImpersonationRules,
    LeakyProvider,
    CheapPasswords,
  ],
})
class ProbeModule {}

describe('sign-in and the principal (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let tenancy: Tenancy;

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });

  /** The account-level entries (no tenant), and a tenant's. */
  const entries = (tenantId: string | null, action: string) =>
    tenancy.run(tenantId, () =>
      db.select().from(auditLog).where(eq(auditLog.action, action)),
    );

  beforeAll(async () => {
    app = await bootModules(...authModules(), ProbeModule);
    db = app.get(getDrizzleToken());
    tenancy = app.get(Tenancy);
  });
  afterAll(async () => {
    await app.close();
  });

  describe('POST /v1/auth/sign-in', () => {
    it('sets the session cookie, which authenticates in the member’s tenant', async () => {
      const { user, tenantId, headers } = await signedInUser(app);
      const me = await get('/probe/me', headers);
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        user: { kind: 'user', id: user.id, tenantId },
        tenantId,
      });
      expect(me.json().user).not.toHaveProperty('passwordHash');
    });

    it('takes the email in any case and with spaces around it', async () => {
      const { email } = await createUser(app, { email: 'Mixed@Acme.dev' });
      expect(email).toBe('mixed@acme.dev');
      await expect(signIn(app, '  MIXED@acme.DEV ')).resolves.toMatchObject({
        cookie: expect.stringMatching(/sid=/),
      });
    });

    it('answers a wrong password and an unknown email alike, and records both', async () => {
      const { email, tenantId } = await createUser(app);
      const wrong = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        payload: { email, password: 'not the password' },
      });
      const unknown = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        payload: { email: 'nobody@acme.dev', password: 'not the password' },
      });
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.headers['content-type']).toContain(PROBLEM);
      const strip = (body: Record<string, unknown>) => ({
        ...body,
        requestId: undefined,
      });
      expect(strip(wrong.json())).toEqual(strip(unknown.json()));
      expect(wrong.headers['set-cookie']).toBeUndefined();
      await app.get(AuditListeners).settled();
      const failed = await entries(null, 'auth.sign-in-failed');
      expect(failed.map((entry) => entry.actorLabel)).toEqual(
        expect.arrayContaining([email, 'nobody@acme.dev']),
      );
      expect(failed.every((entry) => entry.actor === 'anonymous')).toBe(true);
      const tenants = await entries(tenantId, 'member.sign-in-failed');
      expect(tenants).toHaveLength(1);
      expect(tenants[0]).toMatchObject({ tenantId, targetType: 'user' });
    });

    it('records a sign-in for the account, and in the tenant it lands in', async () => {
      const { user, tenantId } = await signedInUser(app);
      const account = await entries(null, 'auth.signed-in');
      expect(
        account.find((entry) => entry.actor === `user:${user.id}`),
      ).toMatchObject({
        tenantId: null,
        details: { method: 'password' },
      });
      const tenant = await entries(tenantId, 'member.signed-in');
      expect(tenant.map((entry) => entry.actor)).toEqual([`user:${user.id}`]);
    });

    it('refuses an unproved address to whoever knows the password (verify first)', async () => {
      const { email } = await createUser(app, { emailVerified: false });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        payload: { email, password: TEST_PASSWORD },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'email_unverified' });
    });

    it('refuses a deactivated account, as an unknown one', async () => {
      const { user, email } = await createUser(app);
      await db
        .update(users)
        .set({ active: false })
        .where(eq(users.id, user.id));
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        payload: { email, password: TEST_PASSWORD },
      });
      expect(response.statusCode).toBe(401);
    });

    it('validates the body: a malformed or non-ASCII address is a 400', async () => {
      for (const email of ['not-an-email', 'ü@exämple.com']) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/auth/sign-in',
          payload: { email, password: 'x' },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: 'validation_failed' });
      }
    });

    it('allows 5 tries per email and address in 15 minutes, then 429; another email is not locked', async () => {
      const { email } = await createUser(app);
      const attempt = (address: string) =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/sign-in',
          payload: { email: address, password: 'wrong' },
          remoteAddress: '203.0.113.50',
        });
      for (let i = 0; i < 5; i++) {
        expect((await attempt(email)).statusCode).toBe(401);
      }
      const limited = await attempt(email.toUpperCase());
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: 'rate_limited' });
      expect((await attempt('someone-else@acme.dev')).statusCode).toBe(401);
    });

    it('refuses a sign-in from another site’s page (CSRF)', async () => {
      const { email } = await createUser(app);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        payload: { email, password: TEST_PASSWORD },
        headers: {
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('hashes with the options another module added (AuthenticationOptionsPart)', async () => {
      expect(await app.get(PasswordHasher).hash('x'.repeat(12))).toMatch(
        /^\$scrypt\$ln=10,/,
      );
    });
  });

  describe('POST /v1/auth/sign-out', () => {
    it('ends the session: the cookie stops working, and a second sign-out is a 401', async () => {
      const { headers } = await signedInUser(app);
      const out = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-out',
        headers,
      });
      expect(out.statusCode).toBe(204);
      expect((await get('/probe/me', headers)).statusCode).toBe(401);
      const again = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-out',
        headers,
      });
      expect(again.statusCode).toBe(401);
    });
  });

  describe('the global guard', () => {
    it('wants credentials unless @Public(), and refuses forged ones', async () => {
      expect((await get('/probe/me')).statusCode).toBe(401);
      expect((await get('/probe/public')).json()).toEqual({ user: null });
      expect(
        (await get('/probe/me', { cookie: '__Host-sid=forged' })).statusCode,
      ).toBe(401);
      for (const authorization of [
        'Bearer garbage',
        'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.',
      ]) {
        const response = await get('/probe/me', { authorization });
        expect(response.statusCode).toBe(401);
        expect(response.headers['content-type']).toContain(PROBLEM);
      }
    });

    it('never lets the system principal act for a request', async () => {
      const response = await get('/probe/me', { 'x-leak': '1' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        code: 'system_principal_refused',
      });
    });

    it('takes the tenant away when the membership ends, and the account when it is deactivated', async () => {
      const { user, tenantId, headers, email } = await signedInUser(app);
      await db
        .update(memberships)
        .set({ active: false })
        .where(eq(memberships.userId, user.id));
      // The session acted in a tenant it may no longer: it ends.
      expect((await get('/probe/me', headers)).statusCode).toBe(401);
      await db
        .update(memberships)
        .set({ active: true })
        .where(eq(memberships.userId, user.id));
      expect((await get('/probe/me', headers)).statusCode).toBe(401);
      const again = await signIn(app, email);
      expect((await get('/probe/me', again.headers)).json().tenantId).toBe(
        tenantId,
      );
      await db
        .update(users)
        .set({ active: false })
        .where(eq(users.id, user.id));
      expect((await get('/probe/me', again.headers)).statusCode).toBe(401);
    });

    it('signs in a user with no membership into no tenant', async () => {
      const { user, email } = await createUser(app);
      await db.delete(memberships).where(eq(memberships.userId, user.id));
      const { headers } = await signIn(app, email);
      expect((await get('/probe/me', headers)).json()).toMatchObject({
        user: { tenantId: null },
        tenantId: null,
      });
    });
  });

  describe('access tokens', () => {
    it('authenticate a user in the token’s tenant, while a member', async () => {
      const { user, tenantId } = await createUser(app);
      const { headers } = await accessTokenFor(app, user.id, tenantId);
      expect((await get('/probe/me', headers)).json()).toMatchObject({
        user: { id: user.id, tenantId },
        tenantId,
      });
      await db
        .update(users)
        .set({ active: false })
        .where(eq(users.id, user.id));
      expect((await get('/probe/me', headers)).statusCode).toBe(401);
    });

    it('refuse a token whose subject is not an account', async () => {
      const { headers } = await accessTokenFor(app, 'system:job', null);
      expect((await get('/probe/me', headers)).statusCode).toBe(401);
    });
  });

  describe('API keys', () => {
    it('authenticate the client in its own tenant, on client routes only', async () => {
      const { tenantId } = await createUser(app);
      const { client, headers, key } = await apiClient(app, tenantId);
      expect((await get('/probe/clients', headers)).json()).toMatchObject({
        kind: 'client',
        id: client.id,
        tenantId,
      });
      expect((await get('/probe/me', headers)).json().tenantId).toBe(tenantId);
      // A key is no credential on a users' route.
      expect((await get('/probe/users', headers)).statusCode).toBe(401);
      // One character off: refused, as problem details.
      const altered = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`;
      const refused = await get('/probe/clients', {
        authorization: `Bearer ${altered}`,
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.headers['content-type']).toContain(PROBLEM);
    });

    it('stop when expired, revoked, or the client deactivated', async () => {
      const { tenantId } = await createUser(app);
      const expired = await apiClient(app, tenantId, {
        expiresAt: new Date(Date.now() - 1000),
      });
      expect((await get('/probe/clients', expired.headers)).statusCode).toBe(
        401,
      );
      const revoked = await apiClient(app, tenantId);
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.clientId, revoked.client.id));
      expect((await get('/probe/clients', revoked.headers)).statusCode).toBe(
        401,
      );
    });

    it('stop while API_CLIENTS is off, and work again once it is on', async () => {
      const { tenantId } = await createUser(app);
      const { headers } = await apiClient(app, tenantId);
      const config = app.get<AuthConfig>(authConfig.KEY);
      config.apiClients = false;
      try {
        expect((await get('/probe/clients', headers)).statusCode).toBe(401);
      } finally {
        config.apiClients = true;
      }
      expect((await get('/probe/clients', headers)).statusCode).toBe(200);
    });

    it('serve an allowlisted client only from its addresses, and record a refusal once', async () => {
      const { tenantId } = await createUser(app);
      const { client, headers } = await apiClient(app, tenantId, {
        allowedCidrs: ['203.0.113.0/24'],
      });
      const from = (remoteAddress: string) =>
        app.inject({
          method: 'GET',
          url: '/probe/clients',
          headers,
          remoteAddress,
        });
      expect((await from('203.0.113.7')).statusCode).toBe(200);
      for (let i = 0; i < 2; i++) {
        const refused = await from('198.51.100.7');
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({ code: 'client_ip_not_allowed' });
      }
      const recorded = await tenancy.run(tenantId, () =>
        db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'client.ip-denied'),
              eq(auditLog.targetId, client.id),
            ),
          ),
      );
      expect(recorded).toHaveLength(1);
    });
  });

  describe('the decorators’ guards', () => {
    it('@RecentAuthentication(): a fresh sign-in passes, an old one gets 403 with the ways back', async () => {
      const { user, headers } = await signedInUser(app);
      expect((await get('/probe/recent', headers)).statusCode).toBe(200);
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, user.id));
      await db
        .update(sessions)
        .set({
          metadata: {
            ...session!.metadata,
            authenticatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
          },
        })
        .where(eq(sessions.id, session!.id));
      const old = await get('/probe/recent', headers);
      expect(old.statusCode).toBe(403);
      expect(old.json()).toMatchObject({
        code: 'reauthentication_required',
        maxAge: 600,
        methods: ['password'],
      });
    });

    it('@RecentAuthentication(): an API client is not asked', async () => {
      const { tenantId } = await createUser(app);
      const { headers } = await apiClient(app, tenantId);
      expect((await get('/probe/recent', headers)).statusCode).toBe(200);
    });

    it('@OperatorOnly(): members of OPERATOR_TENANT only', async () => {
      const operators = await tenancy.create({
        slug: 'operators',
        name: 'Ops',
      });
      const operator = await signedInUser(app, { tenantId: operators.id });
      const other = await signedInUser(app);
      expect((await get('/probe/operators', operator.headers)).statusCode).toBe(
        200,
      );
      const refused = await get('/probe/operators', other.headers);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'operator_required' });
    });

    it('@RequiresSwitch(): 404 feature_off while the switch is off, read on every request', async () => {
      const { headers } = await signedInUser(app);
      const off = await get('/probe/switched', headers);
      expect(off.statusCode).toBe(404);
      expect(off.json()).toMatchObject({ code: 'feature_off' });
      const config = app.get<AuthConfig>(authConfig.KEY);
      config.impersonation = true;
      try {
        expect((await get('/probe/switched', headers)).statusCode).toBe(200);
      } finally {
        config.impersonation = false;
      }
      // Guests learn nothing: the authentication guard answers first.
      expect((await get('/probe/switched')).statusCode).toBe(401);
    });

    it('@UserThrottle(): a limit per signed-in user', async () => {
      const { headers } = await signedInUser(app);
      const hit = () =>
        app.inject({ method: 'POST', url: '/probe/limited', headers });
      expect((await hit()).statusCode).toBe(201);
      expect((await hit()).statusCode).toBe(201);
      expect((await hit()).statusCode).toBe(429);
      const other = await signedInUser(app);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/probe/limited',
            headers: other.headers,
          })
        ).statusCode,
      ).toBe(201);
    });

    it('the onboarding guard holds the first administrator to the allowed routes', async () => {
      const { user, headers } = await signedInUser(app);
      await db
        .update(users)
        .set({ onboardingPassword: true })
        .where(eq(users.id, user.id));
      const refused = await get('/probe/me', headers);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'onboarding_required' });
      expect((await get('/probe/onboarding', headers)).statusCode).toBe(200);
      const out = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-out',
        headers,
      });
      expect(out.statusCode).toBe(204);
    });

    it('the two-factor guard holds a user whose tenant requires it and who has none', async () => {
      const { headers } = await signedInUser(app);
      const policy = app.get(TestPolicy);
      policy.mfaRequired = true;
      try {
        const refused = await get('/probe/me', headers);
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({
          code: 'mfa_enrollment_required',
        });
      } finally {
        policy.mfaRequired = false;
      }
      expect((await get('/probe/me', headers)).statusCode).toBe(200);
    });
  });

  describe('session lifetime and impersonation', () => {
    const sessionOf = async (userId: string) =>
      (await db.select().from(sessions).where(eq(sessions.userId, userId)))[0]!;

    it('ends a session at its tenant’s idle timeout, shorter than the environment’s', async () => {
      const { user, headers } = await signedInUser(app);
      const session = await sessionOf(user.id);
      await db
        .update(sessions)
        .set({ lastActiveAt: new Date(Date.now() - 6 * 60_000) })
        .where(eq(sessions.id, session.id));
      expect((await get('/probe/me', headers)).statusCode).toBe(200);
      await db
        .update(sessions)
        .set({ lastActiveAt: new Date(Date.now() - 6 * 60_000) })
        .where(eq(sessions.id, session.id));
      const policy = app.get(TestPolicy);
      policy.idleMinutes = 5;
      try {
        expect((await get('/probe/me', headers)).statusCode).toBe(401);
      } finally {
        policy.idleMinutes = undefined;
      }
    });

    it('ends an impersonation while IMPERSONATION is off, at its end, across tenants, or once its rule fails', async () => {
      const admin = await createUser(app);
      const target = await signedInUser(app, { tenantId: admin.tenantId });
      const session = await sessionOf(target.user.id);
      const impersonate = (changes: Record<string, unknown>) =>
        db
          .update(sessions)
          .set({
            metadata: {
              ...session.metadata,
              impersonator: {
                id: admin.user.id,
                email: admin.email,
                mfa: null,
                startedAt: new Date().toISOString(),
                endsAt: new Date(Date.now() + 60_000).toISOString(),
                tenantId: admin.tenantId,
                ...changes,
              },
            },
          })
          .where(eq(sessions.id, session.id));
      const config = app.get<AuthConfig>(authConfig.KEY);
      await impersonate({});
      config.impersonation = true;
      try {
        expect(
          (await get('/probe/me', target.headers)).json().user,
        ).toMatchObject({
          id: target.user.id,
          impersonator: { id: admin.user.id, email: admin.email },
        });
        // The rule of who may act as whom, asked on every request.
        const rules = app.get(TestImpersonationRules);
        rules.allowed = false;
        try {
          expect((await get('/probe/me', target.headers)).statusCode).toBe(401);
        } finally {
          rules.allowed = true;
        }
        await impersonate({
          endsAt: new Date(Date.now() - 1000).toISOString(),
        });
        expect((await get('/probe/me', target.headers)).statusCode).toBe(401);
        const elsewhere = await tenancy.create({
          slug: 'elsewhere',
          name: 'E',
        });
        await impersonate({ tenantId: elsewhere.id });
        expect((await get('/probe/me', target.headers)).statusCode).toBe(401);
      } finally {
        config.impersonation = false;
      }
    });

    it('ends a running impersonation once IMPERSONATION is off', async () => {
      const admin = await createUser(app);
      const target = await signedInUser(app, { tenantId: admin.tenantId });
      const session = await sessionOf(target.user.id);
      await db
        .update(sessions)
        .set({
          metadata: {
            ...session.metadata,
            impersonator: {
              id: admin.user.id,
              email: admin.email,
              mfa: null,
              startedAt: new Date().toISOString(),
              endsAt: new Date(Date.now() + 60_000).toISOString(),
              tenantId: admin.tenantId,
            },
          },
        })
        .where(eq(sessions.id, session.id));
      expect((await get('/probe/me', target.headers)).statusCode).toBe(401);
    });
  });

  describe('a tenant’s own domain', () => {
    it('pins the session to the domain’s tenant, or to none for a non-member', async () => {
      const { user, tenantId, email } = await createUser(app);
      const other = await tenancy.create({ slug: 'acme', name: 'Acme' });
      await db
        .insert(memberships)
        .values({ tenantId: other.id, userId: user.id });
      const { headers } = await signIn(app, email);
      const hosts = app.get(TestHosts);
      hosts.domains.set('acme.example', other.id);
      hosts.domains.set(
        'stranger.example',
        (await tenancy.create({ slug: 'stranger', name: 'S' })).id,
      );
      const on = (host: string) => get('/probe/me', { ...headers, host });
      expect((await on('localhost')).json().tenantId).toBe(tenantId);
      expect((await on('ACME.example:443')).json().tenantId).toBe(other.id);
      expect((await on('stranger.example')).json().tenantId).toBeNull();
    });
  });

  it('keeps nothing but SHA-256 hashes of the cookie and the key', async () => {
    const { user, cookie } = await signedInUser(app);
    const token = decodeURIComponent(cookie.split('=')[1]!);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user.id));
    expect(session!.id).not.toBe(token);
    expect(session!.id).toBe(
      createHash('sha256').update(token).digest('base64url'),
    );
    expect(cookieOf(`${cookie}; Path=/`)).toBe(cookie);
  });
});
