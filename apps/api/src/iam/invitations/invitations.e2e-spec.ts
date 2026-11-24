import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { BadRequestException } from '@nestjs/common';
import { InMemoryMailTransport, MailTransport } from '@nestjs/mail';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  roleIds,
  tenantWithAdmin,
} from '../../../test/access.js';
import { signedInUser } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { BreachedPasswordsService } from '../account/breached-passwords.service.js';
import { auditLog } from '../audit/audit.tables.js';
import { userRoles } from '../access/access.tables.js';
import { memberships, users } from '../auth/auth.tables.js';
import { invitations } from './invitations.tables.js';
import { InvitationsModule } from './invitations.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.APP_ROLE = 'all';
  process.env.MAIL_TRANSPORT = 'memory';
  process.env.WEB_URL = 'https://web.example.com';
  process.env.REDIS_PREFIX = `test-invitations-${process.pid}-${Date.now()}`;
});

const BREACHED = 'breached password 123';

/** The password check is iam/account's (a network call): a stand-in that refuses one password. */
@Module({
  providers: [
    {
      provide: BreachedPasswordsService,
      useValue: {
        assertNotBreached: (password: string) => {
          if (password === BREACHED) {
            throw new BadRequestException({ code: 'password_breached' });
          }
        },
      },
    },
  ],
})
class BreachCheckModule {}

type Headers = Record<string, string>;
const ACCEPT = '/v1/auth/invitations/accept';
const PASSWORD = 'a long enough password 42';

describe('invitations (e2e)', () => {
  let app: NestNodeApplication;
  let mailbox: InMemoryMailTransport;
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, work);

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      InvitationsModule,
      BreachCheckModule,
    );
    mailbox = app.get(MailTransport) as InMemoryMailTransport;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => mailbox.clear());

  /** The token in the link of the latest mail to this address. */
  async function tokenFor(email: string, count = 1) {
    await vi.waitFor(
      () =>
        expect(
          mailbox.mails.filter((mail) =>
            mail.to.some((to) => to.address === email),
          ),
        ).toHaveLength(count),
      { timeout: 30_000 },
    );
    const mails = mailbox.mails.filter((mail) =>
      mail.to.some((to) => to.address === email),
    );
    const html = mails.at(-1)!.html!;
    const link = /href="([^"]*accept-invitation[^"]*)"/.exec(html)![1]!;
    const url = new URL(link.replaceAll('&amp;', '&'));
    expect(url.origin).toBe('https://web.example.com');
    return url.searchParams.get('token')!;
  }

  const accept = (token: string, payload: object = {}, headers: Headers = {}) =>
    call('POST', ACCEPT, headers, { token, ...payload });

  const emailOf = () => `new-${randomUUID().slice(0, 8)}@acme.dev`;

  it('invites a new address: its link makes the account, with the roles and units, once', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const [editor] = await roleIds(app, tenantId, 'editor');
    const unit = (
      await call('POST', '/v1/access/organizational-units', admin.headers, {
        type: 'team',
        name: 'Sales',
      })
    ).json().id as string;
    const email = emailOf();
    const invited = await call('POST', '/v1/access/users', admin.headers, {
      email,
      name: 'Ada',
      roleIds: [editor],
      unitIds: [unit],
    });
    expect(invited.statusCode).toBe(202);
    expect(invited.json()).toMatchObject({ email, status: 'sent' });
    // The invitation says nothing of any account.
    expect(Object.keys(invited.json()).sort()).toEqual([
      'email',
      'expiresAt',
      'id',
      'status',
    ]);

    const token = await tokenFor(email);
    const missing = await accept(token);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('password_required');
    const short = await accept(token, { password: 'short' });
    expect(short.statusCode).toBe(400);
    const breached = await accept(token, { password: BREACHED });
    expect(breached.json().code).toBe('password_breached');

    const accepted = await accept(token, { password: PASSWORD });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ tenantId, accountCreated: true });
    // Once.
    const again = await accept(token, { password: PASSWORD });
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('invitation_invalid');

    const [user] = await db()
      .select()
      .from(users)
      .where(eq(users.email, email));
    expect(user).toMatchObject({ name: 'Ada', emailVerified: true });
    const joined = (
      await call('GET', `/v1/access/users/${user!.id}`, admin.headers)
    ).json();
    expect(joined).toMatchObject({
      active: true,
      roleIds: [editor],
      unitIds: [unit],
    });
    // The new account signs in with the password it chose.
    const signedIn = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email, password: PASSWORD },
    });
    expect(signedIn.statusCode).toBe(200);

    const actions = (
      await inTenant(tenantId, () => db().select().from(auditLog))
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(['user.invited', 'user.joined']),
    );
    // Accepted: no longer pending.
    expect(
      (await call('GET', '/v1/access/invitations', admin.headers)).json(),
    ).toEqual({ items: [] });
  });

  it('lets an existing account accept only while signed in as itself', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const person = await signedInUser(app);
    const stranger = await signedInUser(app);
    const invited = await call('POST', '/v1/access/users', admin.headers, {
      email: person.email,
    });
    // The same answer as for a new address.
    expect(Object.keys(invited.json()).sort()).toEqual([
      'email',
      'expiresAt',
      'id',
      'status',
    ]);
    const token = await tokenFor(person.email);

    const guest = await accept(token);
    expect(guest.statusCode).toBe(401);
    expect(guest.json().code).toBe('sign_in_required');
    const other = await accept(token, {}, stranger.headers);
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('invitation_other_account');

    const accepted = await accept(token, {}, person.headers);
    expect(accepted.json()).toEqual({ tenantId, accountCreated: false });
    const [row] = await db()
      .select()
      .from(memberships)
      .where(eq(memberships.userId, person.user.id));
    expect(row).toBeDefined();
    const mine = await db()
      .select()
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId));
    expect(mine.map((m) => m.userId)).toContain(person.user.id);
  });

  it('adds an invitation’s roles to a member’s, never taking any away', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const [administrator, viewer] = await roleIds(
      app,
      tenantId,
      'administrator',
      'viewer',
    );
    // A manager who may hand out the viewer role and no more.
    const role = await call('POST', '/v1/access/roles', admin.headers, {
      name: 'People manager',
      permissions: [
        { subject: 'Access', action: 'manageUsers', conditions: [] },
      ],
    });
    const manager = await member(app, tenantId, [role.json().id]);
    const boss = await member(app, tenantId, ['administrator']);
    const invited = await call('POST', '/v1/access/users', manager.headers, {
      email: boss.email,
      roleIds: [viewer],
    });
    expect(invited.statusCode, invited.body).toBe(202);
    const accepted = await accept(await tokenFor(boss.email), {}, boss.headers);
    expect(accepted.statusCode, accepted.body).toBe(200);
    const held = await inTenant(tenantId, () =>
      db()
        .select({ roleId: userRoles.roleId })
        .from(userRoles)
        .where(eq(userRoles.userId, boss.id)),
    );
    expect(held.map((row) => row.roleId).sort()).toEqual(
      [administrator, viewer].sort(),
    );
  });

  it('never turns a deactivated membership back on', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const person = await signedInUser(app);
    await db().insert(memberships).values({
      tenantId,
      userId: person.user.id,
      active: false,
    });
    await call('POST', '/v1/access/users', admin.headers, {
      email: person.email,
    });
    const refused = await accept(
      await tokenFor(person.email),
      {},
      person.headers,
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('membership_inactive');
  });

  it('ends a link at its expiry, and a new link replaces the old one', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const email = emailOf();
    const id = (
      await call('POST', '/v1/access/users', admin.headers, { email })
    ).json().id as string;
    const first = await tokenFor(email);
    await inTenant(tenantId, () =>
      db()
        .update(invitations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(invitations.id, id)),
    );
    expect((await accept(first, { password: PASSWORD })).statusCode).toBe(400);
    const listed = (
      await call('GET', '/v1/access/invitations', admin.headers)
    ).json().items;
    expect(listed).toMatchObject([{ id, status: 'expired', email }]);
    expect(JSON.stringify(listed)).not.toContain('tokenHash');

    const resent = await call(
      'POST',
      `/v1/access/invitations/${id}/send`,
      admin.headers,
    );
    expect(resent.statusCode).toBe(202);
    expect(resent.json().status).toBe('sent');
    const second = await tokenFor(email, 2);
    expect(second).not.toBe(first);
    expect((await accept(first, { password: PASSWORD })).statusCode).toBe(400);
    expect((await accept(second, { password: PASSWORD })).statusCode).toBe(200);
  });

  it('keeps the old resend route as an alias of send, audited as resent', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const email = emailOf();
    const id = (
      await call('POST', '/v1/access/users', admin.headers, { email })
    ).json().id as string;
    const resent = await call(
      'POST',
      `/v1/access/invitations/${id}/resend`,
      admin.headers,
    );
    expect(resent.statusCode).toBe(202);
    expect(resent.headers.deprecation).toBeDefined();
    expect(resent.json()).toMatchObject({ id, status: 'sent' });
    expect(
      await inTenant(tenantId, () =>
        db()
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(eq(auditLog.action, 'invitation.resent')),
      ),
    ).toHaveLength(1);
    const unknown = await call(
      'POST',
      `/v1/access/invitations/${randomUUID()}/resend`,
      admin.headers,
    );
    expect(unknown.statusCode).toBe(404);
  });

  it('prepares a member without a link, changes it, sends it, and withdraws it', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const [editor, viewer] = await roleIds(app, tenantId, 'editor', 'viewer');
    const prepared = await call('POST', '/v1/access/users', admin.headers, {
      send: false,
      roleIds: [editor],
    });
    expect(prepared.json()).toMatchObject({ email: null, status: 'prepared' });
    const id = prepared.json().id as string;
    expect(mailbox.mails).toHaveLength(0);
    const early = await call(
      'POST',
      `/v1/access/invitations/${id}/send`,
      admin.headers,
    );
    expect(early.statusCode).toBe(400);
    expect(early.json().code).toBe('email_required');
    // Sending needs an address at once, too.
    expect(
      (await call('POST', '/v1/access/users', admin.headers, {})).statusCode,
    ).toBe(400);

    const email = emailOf();
    const changed = await call(
      'PATCH',
      `/v1/access/invitations/${id}`,
      admin.headers,
      { email, roleIds: [viewer] },
    );
    expect(changed.json()).toMatchObject({ email, status: 'prepared' });
    await call('POST', `/v1/access/invitations/${id}/send`, admin.headers);
    const token = await tokenFor(email);

    // A new address withdraws the link that went to the old one.
    const moved = await call(
      'PATCH',
      `/v1/access/invitations/${id}`,
      admin.headers,
      { email: emailOf() },
    );
    expect(moved.json().status).toBe('prepared');
    expect((await accept(token, { password: PASSWORD })).statusCode).toBe(400);

    await call('POST', `/v1/access/invitations/${id}/send`, admin.headers);
    expect(
      (await call('DELETE', `/v1/access/invitations/${id}`, admin.headers))
        .statusCode,
    ).toBe(204);
    expect(
      (await call('DELETE', `/v1/access/invitations/${id}`, admin.headers))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('GET', '/v1/access/invitations', admin.headers)).json().items,
    ).toEqual([]);
  });

  it('replaces a pending invitation to the same address', async () => {
    const { admin } = await tenantWithAdmin(app);
    const email = emailOf();
    await call('POST', '/v1/access/users', admin.headers, { email });
    await call('POST', '/v1/access/users', admin.headers, { email });
    expect(
      (await call('GET', '/v1/access/invitations', admin.headers)).json().items,
    ).toHaveLength(1);
  });

  it("refuses a token that is not one, another tenant's, or forged", async () => {
    const { admin } = await tenantWithAdmin(app);
    const email = emailOf();
    await call('POST', '/v1/access/users', admin.headers, { email });
    const token = await tokenFor(email);
    for (const bad of [
      'nonsense',
      `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
      `inv_${randomUUID()}_${'a'.repeat(43)}`,
    ]) {
      const response = await accept(bad, { password: PASSWORD });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('invitation_invalid');
    }
  });

  it('hands out only what the inviter may', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const [administrator, editor] = await roleIds(
      app,
      tenantId,
      'administrator',
      'editor',
    );
    const role = await call('POST', '/v1/access/roles', admin.headers, {
      name: 'People manager',
      permissions: [
        { subject: 'Access', action: 'manageUsers', conditions: [] },
      ],
    });
    const manager = await member(app, tenantId, [role.json().id]);
    const unit = (
      await call('POST', '/v1/access/organizational-units', admin.headers, {
        type: 'team',
        name: 'Finance',
      })
    ).json().id as string;

    const adminRole = await call('POST', '/v1/access/users', manager.headers, {
      email: emailOf(),
      roleIds: [administrator],
    });
    expect(adminRole.statusCode).toBe(403);
    const placed = await call('POST', '/v1/access/users', manager.headers, {
      email: emailOf(),
      unitIds: [unit],
    });
    expect(placed.statusCode).toBe(403);
    expect(placed.json().code).toBe('unit_authority_required');
    const unknownUnit = await call('POST', '/v1/access/users', admin.headers, {
      email: emailOf(),
      unitIds: [randomUUID()],
    });
    expect(unknownUnit.statusCode).toBe(400);
    const unknownRole = await call('POST', '/v1/access/users', admin.headers, {
      email: emailOf(),
      roleIds: [randomUUID()],
    });
    expect(unknownRole.statusCode).toBe(400);
    const past = await call('POST', '/v1/access/users', admin.headers, {
      email: emailOf(),
      roleIds: [editor],
      roleExpiresAt: { [editor!]: '2020-01-01T00:00:00Z' },
    });
    expect(past.statusCode).toBe(400);

    // A prepared invitation with the administrator role: the manager can't change or send it.
    const id = (
      await call('POST', '/v1/access/users', admin.headers, {
        send: false,
        roleIds: [administrator],
      })
    ).json().id as string;
    const patch = await call(
      'PATCH',
      `/v1/access/invitations/${id}`,
      manager.headers,
      { email: emailOf() },
    );
    expect(patch.statusCode).toBe(403);
    // A member who may not manage users sees none of it.
    const plain = await member(app, tenantId, ['viewer']);
    expect(
      (await call('GET', '/v1/access/invitations', plain.headers)).statusCode,
    ).toBe(403);
  });

  it("keeps each tenant's invitations to itself", async () => {
    const one = await tenantWithAdmin(app);
    const two = await tenantWithAdmin(app);
    const email = emailOf();
    const id = (
      await call('POST', '/v1/access/users', one.admin.headers, { email })
    ).json().id as string;
    expect(
      (await call('GET', '/v1/access/invitations', two.admin.headers)).json()
        .items,
    ).toEqual([]);
    expect(
      (await call('DELETE', `/v1/access/invitations/${id}`, two.admin.headers))
        .statusCode,
    ).toBe(404);
  });
});
