import { randomBytes, randomUUID } from 'node:crypto';
import { Controller, Get, Module, VERSION_NEUTRAL } from '@nestjs/common';
import { CurrentUser, MfaService, TokenService } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, desc, eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  roleIds,
  tenantWithAdmin,
} from '../../../test/access.js';
import { signIn, TEST_PASSWORD } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import {
  authnRequestId,
  browser,
  fakeDns,
  larkUser,
  local,
  oauth2Idp,
  oidcIdp,
  samlIdp,
  samlResponse,
  verifyDomain,
} from '../../../test/sso.js';
import type { Database } from '../../core/database/database.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../audit/audit.tables.js';
import { memberships, users } from '../auth/auth.tables.js';
import { tokenClaims } from '../auth/authentication-method.js';
import type { RequestPrincipal } from '../auth/principal.js';
import { SsoModule } from './sso.module.js';
import { SsoDomainsCheckJob, SsoProcessor } from './sso.processor.js';
import { SSO_TXT_RESOLVER, type TxtResolver } from './sso.queue.js';
import {
  ssoConnections,
  ssoDomainRoutes,
  ssoIdentities,
} from './sso.tables.js';
import { ssoProvider } from './sso-accounts.service.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.APP_ROLE = 'all';
  // The fake providers are plain HTTP on loopback.
  process.env.SSO_ALLOW_LOOPBACK = 'on';
  process.env.WEB_URL = 'https://web.example.com';
  // Connections keep their secrets encrypted (core/encryption).
  process.env.DATA_ENCRYPTION_KEYS = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  );
  process.env.REDIS_PREFIX = `test-sso-${process.pid}-${Date.now()}`;
});

// selfsigned (the SP keys of SAML connections) isn't installed yet: the
// test's own certificate builder stands in for it.
vi.mock('selfsigned', async () => {
  const { selfsignedStandIn } = await import('../../../test/sso.js');
  return { ...selfsignedStandIn, default: selfsignedStandIn };
});

/** Who the request is: a route of no module, any principal. */
@Controller({ path: 'probe', version: VERSION_NEUTRAL })
class ProbeController {
  @Can.Anyone()
  @Get('me')
  me(@CurrentUser() user: RequestPrincipal) {
    return user;
  }
}

/** Two-factor is iam/account's: a stand-in saying who is enrolled. */
const enrolled = new Set<string>();
@Module({
  controllers: [ProbeController],
  providers: [
    {
      provide: MfaService,
      useValue: {
        isEnrolled: (id: string) => Promise.resolve(enrolled.has(id)),
      },
    },
  ],
})
class ProbeModule {}

const DOMAIN = 'acme.test';
const newSecret = () => randomBytes(24).toString('base64url');
type Headers = Record<string, string>;

/**
 * Enterprise sign-on (README.md): a tenant's OIDC, OAuth 2.0 and SAML
 * connections against providers the test makes (keys at run time), its
 * verified domains, SSO required and its break-glass exemptions.
 */
describe('enterprise SSO (e2e)', () => {
  let app: NestNodeApplication;
  const dns = fakeDns();
  let tenantId: string;
  let admin: { id: string; headers: Headers };

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const db = () => app.get<Database>(getDrizzleToken());

  /** The reasons this tenant's SSO sign-ins were refused (audited), newest first. */
  const refusals = async () =>
    (
      await app
        .get(Tenancy)
        .run(tenantId, () =>
          db()
            .select({ details: auditLog.details })
            .from(auditLog)
            .where(eq(auditLog.action, 'auth.sign-in-failed'))
            .orderBy(desc(auditLog.at)),
        )
    ).map((row) => String(row.details?.reason));

  const failed = (location: string) =>
    new URL(location).searchParams.get('error') === 'sso_failed';

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SsoModule,
      ProbeModule,
    );
    // The TXT lookups answer from the fake DNS.
    app.get<TxtResolver>(SSO_TXT_RESOLVER).resolveTxt = (name) =>
      dns.resolver.resolveTxt(name);
    ({ tenantId, admin } = await tenantWithAdmin(app));
    await verifyDomain(app, dns, admin.headers, tenantId, DOMAIN);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('connections and domains', () => {
    it('need Access.manageSso, start off, and keep the client secret encrypted', async () => {
      const viewer = await member(app, tenantId, ['viewer']);
      expect(
        (await call('GET', '/v1/sso/connections', viewer.headers)).statusCode,
      ).toBe(403);
      const secret = newSecret();
      const created = await call('POST', '/v1/sso/connections', admin.headers, {
        protocol: 'oidc',
        name: `oidc-${randomUUID().slice(0, 8)}`,
        issuer: 'https://login.acme.test',
        clientId: 'app',
        clientSecret: secret,
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().enabled).toBe(false);
      expect(created.body).not.toContain(secret);
      // Off: its sign-in URL is a 404, as an unknown connection's.
      expect(
        (await browser(app).get(local(created.json().loginUrl))).statusCode,
      ).toBe(404);
      const [row] = await app
        .get(Tenancy)
        .run(tenantId, () =>
          db()
            .select({ stored: ssoConnections.clientSecret })
            .from(ssoConnections)
            .where(eq(ssoConnections.id, created.json().id)),
        );
      expect(String(row!.stored)).not.toContain(secret);
    });

    it('take changing who the IdP is only from whoever may grant the roles it maps', async () => {
      const [administrator] = await roleIds(app, tenantId, 'administrator');
      const created = await call('POST', '/v1/sso/connections', admin.headers, {
        protocol: 'oidc',
        name: `mapped-${randomUUID().slice(0, 8)}`,
        issuer: 'https://login.acme.test',
        clientId: 'app',
        clientSecret: newSecret(),
        roleMappings: [{ group: 'admins', roleId: administrator }],
      });
      expect(created.statusCode, created.body).toBe(201);
      const url = `/v1/sso/connections/${created.json().id}`;
      const role = await call('POST', '/v1/access/roles', admin.headers, {
        name: `SSO manager ${randomUUID().slice(0, 6)}`,
        permissions: [
          { subject: 'Access', action: 'manageSso', conditions: [] },
        ],
      });
      expect(role.statusCode, role.body).toBe(201);
      const manager = await member(app, tenantId, [role.json().id]);

      // A name is not who the IdP is.
      const renamed = await call('PATCH', url, manager.headers, {
        name: `renamed-${randomUUID().slice(0, 8)}`,
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      // An IdP of their own would hand out the administrator role.
      for (const changes of [
        { issuer: 'https://evil.acme.test' },
        { clientId: 'theirs' },
      ]) {
        const refused = await call('PATCH', url, manager.headers, changes);
        expect(refused.statusCode, refused.body).toBe(403);
      }
      const kept = await call('GET', url, admin.headers);
      expect(kept.json().oidc).toMatchObject({
        issuer: 'https://login.acme.test',
        clientId: 'app',
      });
      expect(
        (
          await call('PATCH', url, admin.headers, {
            issuer: 'https://login2.acme.test',
          })
        ).statusCode,
      ).toBe(200);
    });

    it('verify a domain through its TXT record only', async () => {
      await call('POST', '/v1/sso/domains', admin.headers, {
        domain: 'unverified.test',
      });
      const domains = (
        await call('GET', '/v1/sso/domains', admin.headers)
      ).json<{
        items: { domain: string; verified: boolean }[];
      }>();
      const byName = (name: string) =>
        domains.items.find((d) => d.domain === name);
      expect(byName('unverified.test')?.verified).toBe(false);
      expect(byName(DOMAIN)?.verified).toBe(true);
    });
  });

  it('checks every verified domain each night, and ends one whose record is gone', async () => {
    const other = await tenantWithAdmin(app);
    const domain = `moving-${randomUUID().slice(0, 6)}.test`;
    await verifyDomain(app, dns, other.admin.headers, other.tenantId, domain);
    const listed = async () =>
      (await call('GET', '/v1/sso/domains', other.admin.headers))
        .json<{ items: { domain: string; verified: boolean }[] }>()
        .items.find((d) => d.domain === domain);
    const routed = async () =>
      (
        await db()
          .select({ tenantId: ssoDomainRoutes.tenantId })
          .from(ssoDomainRoutes)
          .where(eq(ssoDomainRoutes.domain, domain))
      ).length;
    expect((await listed())?.verified).toBe(true);

    // Still there: nothing changes.
    expect(await app.get(SsoDomainsCheckJob).run()).toBeGreaterThan(0);
    expect((await listed())?.verified).toBe(true);
    // Gone (the domain changed hands): the domain is no longer the tenant's.
    dns.records.delete(`_sso-verification.${domain}`);
    await app.get(SsoDomainsCheckJob).run();
    expect((await listed())?.verified).toBe(false);
    expect(await routed()).toBe(0);
    // This tenant's own domain was left alone.
    expect(
      (await call('GET', '/v1/sso/domains', admin.headers))
        .json<{ items: { domain: string; verified: boolean }[] }>()
        .items.find((d) => d.domain === DOMAIN)?.verified,
    ).toBe(true);
  });

  describe('OpenID Connect', () => {
    let idp: Awaited<ReturnType<typeof oidcIdp>>;
    let connection: { id: string; loginUrl: string };

    beforeAll(async () => {
      idp = await oidcIdp('acme-app');
      const created = await call('POST', '/v1/sso/connections', admin.headers, {
        protocol: 'oidc',
        name: `oidc-${randomUUID().slice(0, 8)}`,
        issuer: idp.issuer,
        clientId: 'acme-app',
        clientSecret: newSecret(),
        jitProvisioning: true,
        enabled: true,
      });
      expect(created.statusCode).toBe(201);
      connection = created.json();
      // The worker's job: the discovery document, through the guarded fetch.
      await app
        .get(SsoProcessor)
        .run({ kind: 'oidc-discovery', connectionId: connection.id, tenantId });
      const fetched = (
        await call('GET', `/v1/sso/connections/${connection.id}`, admin.headers)
      ).json();
      expect(fetched.oidc.metadataError).toBeNull();
    });
    afterAll(() => idp.close());

    const start = async () => {
      const b = browser(app);
      const login = await b.get(local(connection.loginUrl));
      expect(login.statusCode).toBe(302);
      const location = login.headers.location as string;
      expect(location).toContain(`${idp.issuer}/authorize?`);
      expect(location).toContain('code_challenge_method=S256');
      return { b, location };
    };
    const callback = async (
      b: ReturnType<typeof browser>,
      params: Record<string, string>,
    ) => {
      const res = await b.get(
        `/v1/auth/sso/${tenantId}/${connection.id}/oidc/callback?${new URLSearchParams(params)}`,
      );
      expect(res.statusCode).toBe(302);
      return res.headers.location as string;
    };

    it('signs a person in just in time from a verified address (PKCE, state, nonce)', async () => {
      const { b, location } = await start();
      const email = `${randomUUID().slice(0, 8)}@${DOMAIN}`;
      const landed = await callback(
        b,
        idp.issue(location, { sub: randomUUID(), email, email_verified: true }),
      );
      expect(new URL(landed).origin).toBe('https://web.example.com');
      expect(failed(landed)).toBe(false);
      const me = await b.get('/probe/me');
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ email, tenantId });
      expect(idp.tokenRequests.at(-1)!.get('code_verifier')).toBeTruthy();
    });

    it('refuses a wrong nonce, another browser, an unverified address; takes a code once', async () => {
      const first = await start();
      expect(
        failed(
          await callback(
            first.b,
            idp.issue(first.location, {
              sub: randomUUID(),
              email: `a@${DOMAIN}`,
              email_verified: true,
              nonce: 'another',
            }),
          ),
        ),
      ).toBe(true);
      expect((await refusals())[0]).toMatch(/^token_rejected:/);

      const second = await start();
      const params = idp.issue(second.location, {
        sub: randomUUID(),
        email: `b@${DOMAIN}`,
        email_verified: true,
      });
      expect(failed(await callback(browser(app), params))).toBe(true);
      expect((await browser(app).get('/probe/me')).statusCode).toBe(401);

      const third = await start();
      expect(
        failed(
          await callback(
            third.b,
            idp.issue(third.location, {
              sub: randomUUID(),
              email: `c@${DOMAIN}`,
              email_verified: false,
            }),
          ),
        ),
      ).toBe(true);

      const fourth = await start();
      const once = idp.issue(fourth.location, {
        sub: randomUUID(),
        email: `d@${DOMAIN}`,
        email_verified: true,
      });
      expect(failed(await callback(fourth.b, once))).toBe(false);
      expect(failed(await callback(fourth.b, once))).toBe(true);
    });
  });

  describe('OAuth 2.0 (a Lark-shaped provider)', () => {
    let idp: Awaited<ReturnType<typeof oauth2Idp>>;
    const secret = newSecret();
    let connection: { id: string; loginUrl: string };

    beforeAll(async () => {
      idp = await oauth2Idp();
      const created = await call('POST', '/v1/sso/connections', admin.headers, {
        protocol: 'oauth2',
        name: `lark-${randomUUID().slice(0, 8)}`,
        preset: { name: 'lark', region: 'feishu' },
        ...idp.endpoints,
        clientId: 'cli_lark',
        clientSecret: secret,
        jitProvisioning: true,
        enabled: true,
      });
      expect(created.statusCode).toBe(201);
      connection = created.json();
    });
    afterAll(() => idp.close());

    const signIn = async (answer: Parameters<typeof idp.issue>[1]) => {
      const b = browser(app);
      const login = await b.get(local(connection.loginUrl));
      expect(login.statusCode).toBe(302);
      const params = idp.issue(login.headers.location as string, answer);
      const res = await b.get(
        `/v1/auth/sso/${tenantId}/${connection.id}/oauth2/callback?${new URLSearchParams(params)}`,
      );
      expect(res.statusCode).toBe(302);
      return { b, location: res.headers.location as string };
    };

    it('shows the mapping, never the secret, and has no discovery', async () => {
      const shown = await call(
        'GET',
        `/v1/sso/connections/${connection.id}`,
        admin.headers,
      );
      expect(shown.json()).toMatchObject({
        protocol: 'oauth2',
        oauth2: {
          ...idp.endpoints,
          tokenEndpointAuthMethod: 'client_secret_post',
        },
      });
      expect(shown.body).not.toContain(secret);
      const refresh = await call(
        'POST',
        `/v1/sso/connections/${connection.id}/refresh`,
        admin.headers,
      );
      expect(refresh.statusCode).toBe(409);
      expect(refresh.json().code).toBe('sso_no_discovery');
    });

    it('signs a person in (PKCE, the secret posted), and refuses a failed answer', async () => {
      const email = `${randomUUID().slice(0, 8)}@${DOMAIN}`;
      const { b, location } = await signIn(
        larkUser({ open_id: `ou_${randomUUID()}`, enterprise_email: email }),
      );
      expect(failed(location)).toBe(false);
      expect((await b.get('/probe/me')).json()).toMatchObject({ email });
      expect(idp.tokenRequests.at(-1)!.form.get('client_secret')).toBe(secret);

      const refused = await signIn(larkUser({ open_id: 'ou_x' }, 99991663));
      expect(failed(refused.location)).toBe(true);
      expect((await refusals())[0]).toBe('userinfo_error:99991663');
      // A redirect from the user-info endpoint is never followed.
      const redirected = await signIn({ redirect: '/elsewhere' });
      expect(failed(redirected.location)).toBe(true);
      expect(idp.elsewhere).toBe(0);
    });
  });

  describe('SAML', () => {
    const idp = samlIdp();
    let connection: {
      id: string;
      loginUrl: string;
      saml: { spEntityId: string; acsUrl: string; metadataUrl: string };
    };

    beforeAll(async () => {
      const created = await call('POST', '/v1/sso/connections', admin.headers, {
        protocol: 'saml',
        name: `saml-${randomUUID().slice(0, 8)}`,
        idpEntityId: idp.entityId,
        idpSsoUrl: 'https://idp.acme.test/sso',
        idpCertificates: [idp.cert],
        jitProvisioning: true,
        enabled: true,
      });
      expect(created.statusCode).toBe(201);
      connection = created.json();
    });

    const start = async () => {
      const b = browser(app);
      const login = await b.get(local(connection.loginUrl));
      expect(login.statusCode).toBe(302);
      expect(login.headers.location).toMatch(
        /^https:\/\/idp\.acme\.test\/sso\?SAMLRequest=/,
      );
      return { b, requestId: authnRequestId(login.headers.location as string) };
    };
    /**
     * The IdP's form post, then the hand-over: where it landed. Sent
     * without the browser's cross-site headers: core/http's CSRF check
     * doesn't exclude the ACS yet (README.md, "Integration").
     */
    const post = async (b: ReturnType<typeof browser>, response: string) => {
      const acs = await b.send({
        method: 'POST',
        url: local(connection.saml.acsUrl),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ SAMLResponse: response }).toString(),
      });
      expect(acs.statusCode).toBe(303);
      const location = acs.headers.location as string;
      if (!location.includes('/saml/complete')) return location;
      const complete = await b.get(local(location));
      expect(complete.statusCode).toBe(302);
      return complete.headers.location as string;
    };
    const valid = (
      requestId: string | undefined,
      overrides: Partial<Parameters<typeof samlResponse>[1]> = {},
    ) => ({
      audience: connection.saml.spEntityId,
      acs: connection.saml.acsUrl,
      nameId: `employee-${randomUUID()}`,
      email: `${randomUUID().slice(0, 8)}@${DOMAIN}`,
      inResponseTo: requestId,
      ...overrides,
    });

    it('serves its SP metadata', async () => {
      const metadata = await browser(app).get(
        local(connection.saml.metadataUrl),
      );
      expect(metadata.statusCode).toBe(200);
      expect(metadata.headers['content-type']).toContain(
        'application/samlmetadata+xml',
      );
      expect(metadata.body).toContain(connection.saml.acsUrl);
    });

    it('signs a person in from a validly signed assertion, once', async () => {
      const { b, requestId } = await start();
      const assertion = valid(requestId);
      const response = samlResponse(idp, assertion);
      expect(failed(await post(b, response))).toBe(false);
      expect((await b.get('/probe/me')).json()).toMatchObject({
        email: assertion.email,
        tenantId,
      });
      // Replayed, from another browser: refused.
      const attacker = browser(app);
      expect(failed(await post(attacker, response))).toBe(true);
      expect((await attacker.get('/probe/me')).statusCode).toBe(401);
    });

    it('refuses a changed assertion, another key, audience, issuer or an expired one', async () => {
      const cases: Partial<Parameters<typeof samlResponse>[1]>[] = [
        { tamper: (xml) => xml.replace(/employee-[0-9a-f-]+/, 'employee-ceo') },
        { signWith: samlIdp() },
        { audience: 'https://other.example.com/sp' },
        { issuer: 'https://evil.example.com' },
        // Past the clock skew allowed.
        { notOnOrAfter: Date.now() - 10 * 60_000 },
      ];
      for (const [index, overrides] of cases.entries()) {
        const { b, requestId } = await start();
        const landed = await post(
          b,
          samlResponse(idp, valid(requestId, overrides)),
        );
        expect(failed(landed), `case ${index}`).toBe(true);
        expect((await b.get('/probe/me')).statusCode).toBe(401);
      }
    });

    it('refuses an address of an unverified domain', async () => {
      const { b, requestId } = await start();
      expect(
        failed(
          await post(
            b,
            samlResponse(idp, valid(requestId, { email: 'x@unverified.test' })),
          ),
        ),
      ).toBe(true);
    });
  });

  describe('SSO required', () => {
    let beta: Awaited<ReturnType<typeof tenantWithAdmin>>;
    let idp: Awaited<ReturnType<typeof oidcIdp>>;
    let connection: { id: string; loginUrl: string };
    const BETA = 'beta.test';

    beforeAll(async () => {
      beta = await tenantWithAdmin(app);
      await verifyDomain(app, dns, beta.admin.headers, beta.tenantId, BETA);
      idp = await oidcIdp('beta-app');
    });
    afterAll(() => idp.close());

    const setPolicy = (requireSso: boolean) =>
      call('PUT', '/v1/sso/policy', beta.admin.headers, { requireSso });

    it('is refused while it would lock everyone out', async () => {
      expect((await setPolicy(true)).json().code).toBe(
        'sso_connection_required',
      );
      const created = await call(
        'POST',
        '/v1/sso/connections',
        beta.admin.headers,
        {
          protocol: 'oidc',
          name: 'beta',
          issuer: idp.issuer,
          clientId: 'beta-app',
          clientSecret: newSecret(),
          jitProvisioning: true,
          enabled: true,
        },
      );
      connection = created.json();
      await app.get(SsoProcessor).run({
        kind: 'oidc-discovery',
        connectionId: connection.id,
        tenantId: beta.tenantId,
      });
      // A password session, not exempted: they would lock themselves out.
      const lockout = await setPolicy(true);
      expect(lockout.statusCode).toBe(409);
      expect(lockout.json().code).toBe('sso_lockout');
    });

    it('closes every other way in, save the exempted administrator (two-factor)', async () => {
      const viewer = await member(app, beta.tenantId, ['viewer']);
      const exempt = (headers: Headers) =>
        call('PUT', `/v1/sso/exemptions/${beta.admin.id}`, headers, {
          reason: 'Break-glass administrator',
        });
      expect((await exempt(beta.admin.headers)).json().code).toBe(
        'sso_exemption_needs_mfa',
      );
      enrolled.add(beta.admin.id);
      expect((await exempt(beta.admin.headers)).statusCode).toBe(200);
      const policy = await setPolicy(true);
      expect(policy.statusCode).toBe(200);
      expect(policy.json()).toMatchObject({
        requireSso: true,
        exemptions: [{ userId: beta.admin.id }],
      });

      const restricted = await call('GET', '/probe/me', viewer.headers);
      expect(restricted.statusCode).toBe(403);
      expect(restricted.json().code).toBe('sso_required');
      expect(
        (await call('GET', '/probe/me', beta.admin.headers)).statusCode,
      ).toBe(200);
      // Their own exemption is how they are in: not removable by them.
      const own = await call(
        'DELETE',
        `/v1/sso/exemptions/${beta.admin.id}`,
        beta.admin.headers,
      );
      expect(own.json().code).toBe('sso_lockout');

      // Signed in through the tenant's own connection: in.
      const b = browser(app);
      const login = await b.get(local(connection.loginUrl));
      const params = idp.issue(login.headers.location as string, {
        sub: randomUUID(),
        email: `${randomUUID().slice(0, 8)}@${BETA}`,
        email_verified: true,
      });
      const landed = await b.get(
        `/v1/auth/sso/${beta.tenantId}/${connection.id}/oidc/callback?${new URLSearchParams(params)}`,
      );
      expect(failed(landed.headers.location as string)).toBe(false);
      expect((await b.get('/probe/me')).statusCode).toBe(200);

      // A password sign-in asks too: refused where every tenant of the
      // person requires SSO, else it lands in one that doesn't.
      const password = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        payload: { email: viewer.email, password: TEST_PASSWORD },
      });
      expect(password.statusCode).toBe(403);
      expect(password.json().code).toBe('sso_required');
      const both = await member(app, beta.tenantId, ['viewer']);
      await db()
        .insert(memberships)
        .values({ tenantId, userId: both.id, selectedAt: new Date(0) });
      await db()
        .update(memberships)
        .set({ selectedAt: new Date() })
        .where(
          and(
            eq(memberships.userId, both.id),
            eq(memberships.tenantId, beta.tenantId),
          ),
        );
      const landed2 = await signIn(app, both.email);
      const me = await call('GET', '/probe/me', landed2.headers);
      expect(me.statusCode).toBe(200);
      expect(me.json().tenantId).toBe(tenantId);

      expect((await setPolicy(false)).statusCode).toBe(200);
      expect((await call('GET', '/probe/me', viewer.headers)).statusCode).toBe(
        200,
      );
    });

    it('stops counting a connection once it is off, and ends the sessions it signed in', async () => {
      const ssoSession = async () => {
        const b = browser(app);
        const login = await b.get(local(connection.loginUrl));
        const params = idp.issue(login.headers.location as string, {
          sub: randomUUID(),
          email: `${randomUUID().slice(0, 8)}@${BETA}`,
          email_verified: true,
        });
        const landed = await b.get(
          `/v1/auth/sso/${beta.tenantId}/${connection.id}/oidc/callback?${new URLSearchParams(params)}`,
        );
        expect(failed(landed.headers.location as string)).toBe(false);
        expect((await b.get('/probe/me')).statusCode).toBe(200);
        return b;
      };
      const setEnabled = (enabled: boolean) =>
        app
          .get(Tenancy)
          .run(beta.tenantId, () =>
            db()
              .update(ssoConnections)
              .set({ enabled })
              .where(eq(ssoConnections.id, connection.id)),
          );
      const first = await ssoSession();
      expect((await setPolicy(true)).statusCode).toBe(200);
      expect((await first.get('/probe/me')).statusCode).toBe(200);

      // Off, its sessions left in place: they no longer satisfy SSO required.
      await setEnabled(false);
      const stale = await first.get('/probe/me');
      expect(stale.statusCode).toBe(403);
      expect(stale.json().code).toBe('sso_required');

      // Turned off by an administrator: its sessions end.
      await setEnabled(true);
      const second = await ssoSession();
      // A token client of the same person through the connection (a native
      // app's handoff issues these), and one through a password.
      const [{ userId }] = await app
        .get(Tenancy)
        .run(beta.tenantId, () =>
          db()
            .select({ userId: ssoIdentities.userId })
            .from(ssoIdentities)
            .innerJoin(users, eq(users.id, ssoIdentities.userId))
            .where(eq(ssoIdentities.connectionId, connection.id))
            .orderBy(desc(ssoIdentities.createdAt))
            .limit(1),
        );
      const tokens = app.get(TokenService);
      const issue = (method: string) =>
        tokens.issue(userId!, {
          method,
          claims: tokenClaims([], new Date(), beta.tenantId, { method }),
        });
      const viaSso = await issue(ssoProvider(connection.id));
      const viaLink = await issue('magic-link');
      const off = await call(
        'PATCH',
        `/v1/sso/connections/${connection.id}`,
        beta.admin.headers,
        { enabled: false },
      );
      expect(off.statusCode).toBe(200);
      expect((await second.get('/probe/me')).statusCode).toBe(401);
      await expect(tokens.refresh(viaSso.refreshToken!)).rejects.toThrow();
      await expect(tokens.refresh(viaLink.refreshToken!)).resolves.toEqual(
        expect.objectContaining({ refreshToken: expect.any(String) }),
      );

      // Deleted: the same, SSO required or not.
      expect((await setPolicy(false)).statusCode).toBe(200);
      await setEnabled(true);
      const third = await ssoSession();
      expect(
        (
          await call(
            'DELETE',
            `/v1/sso/connections/${connection.id}`,
            beta.admin.headers,
          )
        ).statusCode,
      ).toBe(204);
      expect((await third.get('/probe/me')).statusCode).toBe(401);
    });
  });

  describe('finding the connection by address', () => {
    const discover = (email: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/sso/discover',
        payload: { email },
      });

    it("answers a verified domain's login URL, and nothing about accounts", async () => {
      const found = await discover(`someone@${DOMAIN.toUpperCase()}`);
      expect(found.statusCode).toBe(200);
      expect(found.json().loginUrl).toMatch(
        new RegExp(`/v1/auth/sso/${tenantId}/[0-9a-f-]{36}/login$`),
      );
      expect(
        (await discover(`nobody-${randomUUID()}@${DOMAIN}`)).json(),
      ).toEqual(found.json());
      expect((await discover('someone@unknown.test')).json()).toEqual({
        loginUrl: null,
      });
    });
  });
});
