import { SessionService } from '@nestjs/authentication';
import { randomUUID } from 'node:crypto';
import {
  Controller,
  Get,
  Injectable,
  Module,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../../test/access.js';
import { apiClient, createUser, signIn } from '../../../../test/auth.js';
import { bootModules } from '../../../../test/boot.js';
import { fakeDns, verifyDomain } from '../../../../test/sso.js';
import type { Database } from '../../../core/database/database.js';
import { QueuesModule } from '../../../core/queues/queues.module.js';
import { Tenancy } from '../../../core/tenancy/tenancy.service.js';
import {
  apiClientRoles,
  rolePermissions,
  roles,
} from '../../access/access.tables.js';
import {
  ACCESS_EVENTS,
  type MemberDeactivatedEvent,
} from '../../access/access.events.js';
import { auditLog } from '../../audit/audit.tables.js';
import { memberships, users } from '../../auth/auth.tables.js';
import type { RequestPrincipal } from '../../auth/principal.js';
import { organizationalUnitMemberships } from '../../organization/organization.tables.js';
import { SsoModule } from '../sso.module.js';
import { SSO_TXT_RESOLVER, type TxtResolver } from '../sso.queue.js';
import { scimDeprovisionedUsers } from '../sso.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.APP_ROLE = 'all';
  process.env.DATA_ENCRYPTION_KEYS = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  );
  process.env.REDIS_PREFIX = `test-scim-${process.pid}-${Date.now()}`;
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
/** What access announced of deactivations (realtime ends the member's sockets on it). */
@Injectable()
class Deactivations {
  readonly seen: MemberDeactivatedEvent[] = [];
  readonly committed: MemberDeactivatedEvent[] = [];

  @OnEvent(ACCESS_EVENTS.memberDeactivated)
  deactivated(event: MemberDeactivatedEvent) {
    this.seen.push(event);
  }

  @OnEvent(ACCESS_EVENTS.memberDeactivationCommitted)
  deactivationCommitted(event: MemberDeactivatedEvent) {
    this.committed.push(event);
  }
}

@Module({ controllers: [ProbeController], providers: [Deactivations] })
class ProbeModule {}

const DOMAIN = 'acme.test';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
type Headers = Record<string, string>;

/**
 * SCIM 2.0 provisioning (README.md, "SCIM"): the IdP's token is an API
 * client key whose role holds Access.provisionScim; users and groups
 * (units) of its tenant only.
 */
describe('SCIM provisioning (e2e)', () => {
  let app: NestNodeApplication;
  const dns = fakeDns();
  let tenantId: string;
  let admin: { id: string; headers: Headers };
  let scim: Headers;
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(id: string, work: () => Promise<T>) =>
    app.get(Tenancy).run(id, work);

  /** An API client of the tenant whose role holds Access.provisionScim: its headers. */
  const scimToken = async (tenant: string) => {
    const { client, headers } = await apiClient(app, tenant);
    await inTenant(tenant, async () => {
      const [role] = await db()
        .insert(roles)
        .values({ name: `scim-${randomUUID().slice(0, 8)}` })
        .returning();
      await db().insert(rolePermissions).values({
        roleId: role!.id,
        subject: 'Access',
        action: 'provisionScim',
      });
      await db()
        .insert(apiClientRoles)
        .values({ clientId: client.id, roleId: role!.id });
    });
    return headers;
  };

  const send = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    headers: Headers,
    body?: object,
  ) =>
    app.inject({
      method,
      url: `/v1/scim${path}`,
      headers: {
        ...headers,
        ...(body && { 'content-type': 'application/scim+json' }),
      },
      ...(body && { payload: JSON.stringify(body) }),
    });

  const newUser = (overrides: Record<string, unknown> = {}) => {
    const email = `${randomUUID().slice(0, 8)}@${DOMAIN}`;
    return {
      schemas: [USER],
      userName: email,
      externalId: randomUUID(),
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      emails: [{ value: email, primary: true, type: 'work' }],
      active: true,
      ...overrides,
    };
  };
  const provision = async (overrides: Record<string, unknown> = {}) => {
    const created = await send('POST', '/Users', scim, newUser(overrides));
    expect(created.statusCode, created.body).toBe(201);
    return created.json<{
      id: string;
      userName: string;
      meta: { location: string };
    }>();
  };

  const account = async (id: string) =>
    (await db().select().from(users).where(eq(users.id, id)))[0];
  const membership = async (id: string) =>
    (
      await db()
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.userId, id), eq(memberships.tenantId, tenantId)),
        )
    )[0];
  const audited = (action: string, targetId: string) =>
    inTenant(tenantId, () =>
      db()
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)),
        ),
    );

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SsoModule,
      ProbeModule,
    );
    app.get<TxtResolver>(SSO_TXT_RESOLVER).resolveTxt = (name) =>
      dns.resolver.resolveTxt(name);
    ({ tenantId, admin } = await tenantWithAdmin(app));
    await verifyDomain(app, dns, admin.headers, tenantId, DOMAIN);
    scim = await scimToken(tenantId);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('needs a key whose client holds Access.provisionScim, and answers SCIM errors', async () => {
    const anonymous = await send('GET', '/Users', {});
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['content-type']).toContain(
      'application/scim+json',
    );
    expect(anonymous.json().schemas).toEqual([ERROR]);
    const plain = await apiClient(app, tenantId);
    expect((await send('GET', '/Users', plain.headers)).statusCode).toBe(403);
    // A user's token is no SCIM token, whatever they may do.
    expect((await send('GET', '/Users', admin.headers)).statusCode).toBe(401);
    const config = await send('GET', '/ServiceProviderConfig', scim);
    expect(config.statusCode).toBe(200);
    expect(config.json().patch.supported).toBe(true);
  });

  it('provisions a user of a verified domain, found as IdPs look, once', async () => {
    const input = newUser();
    const created = await send('POST', '/Users', scim, input);
    expect(created.statusCode).toBe(201);
    const user = created.json();
    expect(created.headers.location).toBe(user.meta.location);
    expect(user).toMatchObject({
      userName: input.userName,
      externalId: input.externalId,
      active: true,
    });
    expect((await membership(user.id))?.active).toBe(true);
    expect(await audited('scim.user-provisioned', user.id)).toHaveLength(1);
    const found = await send(
      'GET',
      `/Users?filter=${encodeURIComponent(`userName eq "${input.userName.toUpperCase()}"`)}`,
      scim,
    );
    expect(found.json()).toMatchObject({
      totalResults: 1,
      Resources: [{ id: user.id }],
    });
    const again = await send('POST', '/Users', scim, input);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      scimType: 'uniqueness',
      status: '409',
    });
  });

  it('refuses an address of an unverified domain, and an unsupported filter', async () => {
    const refused = await send(
      'POST',
      '/Users',
      scim,
      newUser({ userName: 'x@elsewhere.test', emails: [] }),
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json().scimType).toBe('invalidValue');
    const filter = await send(
      'GET',
      `/Users?filter=${encodeURIComponent('userName co "a"')}`,
      scim,
    );
    expect(filter.statusCode).toBe(400);
    expect(filter.json().scimType).toBe('invalidFilter');
  });

  it('updates a user (PUT, PATCH) without changing the account’s name', async () => {
    const input = newUser();
    const user = await provision(input);
    const replaced = await send('PUT', `/Users/${user.id}`, scim, {
      ...input,
      displayName: 'Ada L.',
      title: 'Engineer',
    });
    expect(replaced.json()).toMatchObject({
      displayName: 'Ada L.',
      title: 'Engineer',
    });
    const patched = await send('PATCH', `/Users/${user.id}`, scim, {
      schemas: [PATCH],
      Operations: [{ op: 'replace', path: 'name.givenName', value: 'Augusta' }],
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().name.givenName).toBe('Augusta');
    expect((await account(user.id))?.name).toBe('Ada Lovelace');
  });

  it('deprovisions the last membership: the account off (kept), its session ended, POST brings it back', async () => {
    // A member with a password, signed in, then taken over by the IdP.
    const email = `${randomUUID().slice(0, 8)}@${DOMAIN}`;
    const created = await createUser(app, { tenantId, email });
    const session = await signIn(app, email, created.password);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/probe/me',
          headers: session.headers,
        })
      ).statusCode,
    ).toBe(200);
    const user = await provision({
      userName: email,
      emails: [{ value: email, primary: true }],
    });
    expect(user.id).toBe(created.user.id);

    // Azure sends its booleans as strings.
    const off = await send('PATCH', `/Users/${user.id}`, scim, {
      schemas: [PATCH],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect(off.json().active).toBe(false);
    expect((await membership(user.id))?.active).toBe(false);
    expect((await account(user.id))?.active).toBe(false);
    // Ended, not only refused: the store announces it, so live sockets close.
    expect(
      await app.get(SessionService, { strict: false }).list(user.id),
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/probe/me',
          headers: session.headers,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/sign-in',
          payload: { email, password: created.password },
        })
      ).statusCode,
    ).toBe(401);

    // RFC 7644 §3.6: 204, then 404. Deactivated, never deleted.
    expect((await send('DELETE', `/Users/${user.id}`, scim)).statusCode).toBe(
      204,
    );
    expect((await send('GET', `/Users/${user.id}`, scim)).statusCode).toBe(404);
    expect(await account(user.id)).toMatchObject({
      email,
      active: false,
      passwordHash: created.user.passwordHash,
    });
    expect(
      await db()
        .select()
        .from(scimDeprovisionedUsers)
        .where(eq(scimDeprovisionedUsers.userId, user.id)),
    ).toHaveLength(1);
    expect(
      (await audited('scim.account-deactivated', user.id)).length,
    ).toBeGreaterThan(0);

    // Provisioned again: the same account, and its password works again.
    const again = await provision({
      userName: email,
      emails: [{ value: email, primary: true }],
    });
    expect(again.id).toBe(user.id);
    expect((await account(user.id))?.active).toBe(true);
    await signIn(app, email, created.password);
  });

  it('keeps the account active while another tenant’s membership is', async () => {
    const user = await provision();
    const other = await tenantWithAdmin(app);
    await db()
      .insert(memberships)
      .values({ tenantId: other.tenantId, userId: user.id });
    expect((await send('DELETE', `/Users/${user.id}`, scim)).statusCode).toBe(
      204,
    );
    expect((await account(user.id))?.active).toBe(true);
    expect(await audited('scim.account-deactivated', user.id)).toHaveLength(0);
  });

  it('manages groups as units, with provisioned users only', async () => {
    const alice = await provision();
    const bob = await provision();
    const outsider = await member(app, tenantId, ['viewer']);
    const created = await send('POST', '/Groups', scim, {
      schemas: [GROUP],
      displayName: 'Engineering',
      externalId: randomUUID(),
      members: [{ value: alice.id }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const group = created.json();
    expect(group.members.map((m: { value: string }) => m.value)).toEqual([
      alice.id,
    ]);
    const patched = await send('PATCH', `/Groups/${group.id}`, scim, {
      schemas: [PATCH],
      Operations: [
        { op: 'add', path: 'members', value: [{ value: bob.id }] },
        { op: 'remove', path: `members[value eq "${alice.id}"]` },
        { op: 'replace', path: 'displayName', value: 'Platform' },
      ],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({
      displayName: 'Platform',
      members: [{ value: bob.id }],
    });
    // Alice's membership ended, kept as history.
    const history = await inTenant(tenantId, () =>
      db()
        .select()
        .from(organizationalUnitMemberships)
        .where(eq(organizationalUnitMemberships.unitId, group.id)),
    );
    expect(
      history.find((row) => row.userId === alice.id)?.validTo,
    ).toBeInstanceOf(Date);
    const refused = await send('PATCH', `/Groups/${group.id}`, scim, {
      schemas: [PATCH],
      Operations: [
        { op: 'add', path: 'members', value: [{ value: outsider.id }] },
      ],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().scimType).toBe('invalidValue');
    const found = await send(
      'GET',
      `/Groups?filter=${encodeURIComponent('displayName eq "platform"')}&excludedAttributes=members`,
      scim,
    );
    expect(found.json()).toMatchObject({
      totalResults: 1,
      Resources: [{ id: group.id }],
    });
    expect(found.json().Resources[0].members).toBeUndefined();
    expect((await send('DELETE', `/Groups/${group.id}`, scim)).statusCode).toBe(
      204,
    );
    expect((await send('GET', `/Groups/${group.id}`, scim)).statusCode).toBe(
      404,
    );
  });

  it('announces a deprovisioned membership, its actor the IdP’s client', async () => {
    const user = await provision();
    expect((await send('DELETE', `/Users/${user.id}`, scim)).statusCode).toBe(
      204,
    );
    const deactivations = app.get(Deactivations);
    for (const events of [deactivations.seen, deactivations.committed]) {
      const event = events.filter((seen) => seen.userId === user.id);
      expect(event).toEqual([
        expect.objectContaining({
          tenantId,
          actor: expect.objectContaining({ kind: 'client' }),
        }),
      ]);
    }
  });

  it('reactivates a deprovisioned account when an administrator turns its membership on', async () => {
    const user = await provision();
    expect((await send('DELETE', `/Users/${user.id}`, scim)).statusCode).toBe(
      204,
    );
    expect((await account(user.id))?.active).toBe(false);
    const on = await app.inject({
      method: 'PATCH',
      url: `/v1/access/users/${user.id}`,
      headers: admin.headers,
      payload: { active: true },
    });
    expect(on.statusCode, on.body).toBe(204);
    expect((await membership(user.id))?.active).toBe(true);
    expect((await account(user.id))?.active).toBe(true);
    expect(
      await db()
        .select()
        .from(scimDeprovisionedUsers)
        .where(eq(scimDeprovisionedUsers.userId, user.id)),
    ).toHaveLength(0);
    expect(await audited('user.account-reactivated', user.id)).toHaveLength(1);
  });

  it('shows what SCIM manages, and refuses an administrator’s change of its units', async () => {
    const provisioned = await provision();
    const outsider = await member(app, tenantId, ['viewer']);
    const shown = async (id: string) =>
      (
        await app.inject({
          method: 'GET',
          url: `/v1/access/users/${id}`,
          headers: admin.headers,
        })
      ).json().managedByScim;
    expect(await shown(provisioned.id)).toBe(true);
    expect(await shown(outsider.id)).toBe(false);

    const group = (
      await send('POST', '/Groups', scim, {
        schemas: [GROUP],
        displayName: `Team ${randomUUID().slice(0, 8)}`,
        members: [{ value: provisioned.id }],
      })
    ).json();
    const units = (
      await app.inject({
        method: 'GET',
        url: '/v1/access/organizational-units',
        headers: admin.headers,
      })
    ).json().items as { id: string; managedByScim: boolean }[];
    expect(units.find((unit) => unit.id === group.id)?.managedByScim).toBe(
      true,
    );
    const refused = (
      method: 'PATCH' | 'DELETE' | 'POST',
      url: string,
      payload?: object,
    ) =>
      app
        .inject({
          method,
          url: `/v1/access/organizational-units/${group.id}${url}`,
          headers: admin.headers,
          ...(payload && { payload }),
        })
        .then((response) => [response.statusCode, response.json().code]);
    const managed = [409, 'unit_managed_by_scim'];
    expect(await refused('PATCH', '', { name: 'Renamed' })).toEqual(managed);
    expect(await refused('DELETE', '')).toEqual(managed);
    expect(await refused('POST', '/members', { userId: outsider.id })).toEqual(
      managed,
    );
    expect(
      await refused('PATCH', `/members/${provisioned.id}`, { role: 'lead' }),
    ).toEqual(managed);
    expect(await refused('DELETE', `/members/${provisioned.id}`)).toEqual(
      managed,
    );
  });

  it('keeps tenants apart', async () => {
    const user = await provision();
    const group = (
      await send('POST', '/Groups', scim, {
        schemas: [GROUP],
        displayName: 'Ours',
      })
    ).json();
    const other = await tenantWithAdmin(app);
    const theirs = await scimToken(other.tenantId);
    expect((await send('GET', `/Users/${user.id}`, theirs)).statusCode).toBe(
      404,
    );
    expect((await send('GET', `/Groups/${group.id}`, theirs)).statusCode).toBe(
      404,
    );
    expect(
      (
        await send('PUT', `/Users/${user.id}`, theirs, {
          schemas: [USER],
          userName: user.userName,
          active: false,
        })
      ).statusCode,
    ).toBe(404);
    expect((await send('DELETE', `/Users/${user.id}`, theirs)).statusCode).toBe(
      404,
    );
    expect(
      (await send('DELETE', `/Groups/${group.id}`, theirs)).statusCode,
    ).toBe(404);
    expect((await send('GET', '/Users', theirs)).json().totalResults).toBe(0);
    // Their tenant didn't verify acme.test.
    expect((await send('POST', '/Users', theirs, newUser())).statusCode).toBe(
      400,
    );
    expect((await send('GET', `/Users/${user.id}`, scim)).json().active).toBe(
      true,
    );
  });
});
