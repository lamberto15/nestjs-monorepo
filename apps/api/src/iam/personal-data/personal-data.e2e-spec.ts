import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import { InMemoryMailTransport, MailTransport } from '@nestjs/mail';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { accessModules } from '../../../test/access.js';
import { browser, CheapPasswordsModule } from '../../../test/account.js';
import { createUser } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { MAIL_QUEUE } from '../../core/mail/mail.queue.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccountModule } from '../account/account.module.js';
import { userIdentities } from '../account/account.tables.js';
import { auditLog } from '../audit/audit.tables.js';
import { memberships, sessions, users } from '../auth/auth.tables.js';
import { HoldsModule } from '../holds/holds.module.js';
import { legalHolds } from '../holds/holds.tables.js';
import { AccountDeletionJob } from './account-deletion.job.js';
import { PersonalDataModule } from './personal-data.module.js';
import {
  type PersonalDataBatch,
  PersonalDataService,
} from './personal-data.service.js';
import { accountDeletions, consents } from './personal-data.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-personal-data-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    PASSWORD_BREACH_CHECK: 'off',
    WEB_URL: 'https://web.example.com',
    ACCOUNT_DELETION_GRACE_DAYS: '14',
  });
});

const DAY = 86_400_000;

describe('personal data: consents, deletion, export (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let mailbox: InMemoryMailTransport;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      AccountModule,
      HoldsModule,
      PersonalDataModule,
      CheapPasswordsModule,
    );
    db = app.get<Database>(getDrizzleToken());
    mailbox = app.get(MailTransport) as InMemoryMailTransport;
  });

  afterAll(async () => {
    await app
      ?.get<Queue>(`BullQueue_${MAIL_QUEUE}`)
      .obliterate({ force: true });
    await app?.close();
  });

  /** A member signed in in a browser, from its own address (the per-address limits). */
  async function signedIn() {
    const created = await createUser(app);
    const agent = browser(
      app,
      `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    );
    const response = await agent.post('/v1/auth/sign-in', {
      email: created.email,
      password: created.password,
    });
    expect(response.statusCode).toBe(200);
    return { ...created, agent };
  }

  async function cancelToken(to: string) {
    let token: string | undefined;
    await vi.waitFor(
      () => {
        const mail = [...mailbox.mails]
          .reverse()
          .find((m) => m.to.some((a) => a.address === to));
        token = mail?.html?.match(/cancel-deletion\?token=([\w.-]+)/)?.[1];
        expect(token).toBeDefined();
      },
      { timeout: 15_000 },
    );
    return token!;
  }

  const inNoTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(null, work);

  it('lists the consent kinds to anyone, records and withdraws consents, keeps the history', async () => {
    const kinds = await app.inject({
      method: 'GET',
      url: '/v1/account/consent-kinds',
    });
    expect(kinds.statusCode).toBe(200);
    expect(kinds.json().items.map((k: { kind: string }) => k.kind)).toEqual([
      'terms',
      'privacy',
      'marketing',
    ]);
    const { agent, user } = await signedIn();
    expect(
      (await agent.post('/v1/account/consents', { kind: 'nope', version: '1' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await agent.post('/v1/account/consents', {
          kind: 'marketing',
          version: '2020-01',
        })
      ).statusCode,
    ).toBe(400);
    for (const kind of ['terms', 'marketing']) {
      expect(
        (await agent.post('/v1/account/consents', { kind, version: '2026-01' }))
          .statusCode,
      ).toBe(201);
    }
    expect((await agent.delete('/v1/account/consents/terms')).statusCode).toBe(
      409,
    );
    const withdrawn = await agent.delete('/v1/account/consents/marketing');
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().withdrawnAt).toEqual(expect.any(String));
    expect(
      (await agent.delete('/v1/account/consents/marketing')).statusCode,
    ).toBe(404);
    const state = (await agent.get('/v1/account')).json();
    expect(state.deletion).toBeNull();
    expect(state.consents).toHaveLength(2);
    const rows = await inNoTenant(() =>
      db.select().from(consents).where(eq(consents.userId, user.id)),
    );
    expect(rows).toHaveLength(2);
  });

  it('wants the password to ask for the deletion, signs out the other sessions, and cancels', async () => {
    const { agent, user, email, password } = await signedIn();
    const other = browser(app, '10.9.9.9');
    await other.post('/v1/auth/sign-in', { email, password });
    expect((await agent.post('/v1/account/deletion', {})).statusCode).toBe(400);
    expect(
      (await agent.post('/v1/account/deletion', { password: 'wrong' }))
        .statusCode,
    ).toBe(403);
    const asked = await agent.post('/v1/account/deletion', { password });
    expect(asked.statusCode).toBe(200);
    const scheduled = new Date(asked.json().scheduledFor).getTime();
    expect(scheduled).toBeGreaterThan(Date.now() + 13 * DAY);
    // Asked again: the same request.
    expect(
      (await agent.post('/v1/account/deletion', { password })).json(),
    ).toEqual(asked.json());
    expect((await other.get('/v1/auth/me')).statusCode).toBe(401);
    expect((await agent.get('/v1/account')).json().deletion).toEqual(
      asked.json(),
    );
    await cancelToken(email);
    expect((await agent.delete('/v1/account/deletion')).statusCode).toBe(204);
    expect((await agent.delete('/v1/account/deletion')).statusCode).toBe(404);
    const actions = (
      await inNoTenant(() =>
        db.select().from(auditLog).where(eq(auditLog.targetId, user.id)),
      )
    ).map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'account.deletion-refused',
        'account.deletion-requested',
        'account.deletion-cancelled',
      ]),
    );
  });

  it("cancels with the mail's link once, without a sign-in", async () => {
    const { agent, email, password, user } = await signedIn();
    await agent.post('/v1/account/deletion', { password });
    const token = await cancelToken(email);
    const cancel = (value: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/account/deletion/cancel',
        payload: { token: value },
      });
    expect((await cancel('forged')).statusCode).toBe(400);
    expect((await cancel(token)).statusCode).toBe(204);
    expect((await cancel(token)).statusCode).toBe(400);
    // Audited as the account itself, through the link.
    const [entry] = await inNoTenant(() =>
      db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetId, user.id),
            eq(auditLog.action, 'account.deletion-cancelled'),
          ),
        ),
    );
    expect(entry).toMatchObject({
      actor: `user:${user.id}`,
      actorLabel: email,
      details: { via: 'link' },
    });
    expect((await agent.get('/v1/account')).json().deletion).toBeNull();
  });

  it('exports what every section holds about the person', async () => {
    const { agent, user } = await signedIn();
    await agent.post('/v1/account/consents', {
      kind: 'terms',
      version: '2026-01',
    });
    const batches: PersonalDataBatch[] = [];
    await app.get(PersonalDataService).export(user.id, async (batch) => {
      batches.push(batch);
    });
    const sections = new Set(batches.map((batch) => batch.section));
    expect([...sections]).toEqual(
      expect.arrayContaining([
        'account',
        'consents',
        'audit',
        'sign-in-methods',
      ]),
    );
    const profile = batches
      .find((batch) => batch.section === 'account')!
      .rows.find((row) => row.kind === 'profile')!;
    expect(profile).toMatchObject({ id: user.id, email: user.email });
    expect(profile).not.toHaveProperty('passwordHash');
  });

  it('erases the account after the grace period: anonymised, signed out, its entries relabelled', async () => {
    const { agent, user, tenantId, email, password } = await signedIn();
    await inNoTenant(() =>
      db.insert(userIdentities).values({
        provider: 'google',
        subject: randomUUID(),
        userId: user.id,
        email,
      }),
    );
    await agent.post('/v1/account/deletion', { password });
    const job = app.get(AccountDeletionJob);
    // Not due yet.
    await job.deleteDue(new Date());
    expect((await agent.get('/v1/account')).statusCode).toBe(200);

    expect(await job.deleteDue(new Date(Date.now() + 15 * DAY))).toBe(1);
    const [account] = await inNoTenant(() =>
      db.select().from(users).where(eq(users.id, user.id)),
    );
    expect(account).toMatchObject({
      name: 'Deleted user',
      email: `deleted-${user.id}@anonymized.invalid`,
      passwordHash: null,
      active: false,
    });
    const left = await inNoTenant(async () => ({
      memberships: await db
        .select()
        .from(memberships)
        .where(eq(memberships.userId, user.id)),
      sessions: await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, user.id)),
      identities: await db
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.userId, user.id)),
      labels: await db
        .select({ label: auditLog.actorLabel })
        .from(auditLog)
        .where(eq(auditLog.actor, `user:${user.id}`)),
    }));
    expect(left.memberships).toEqual([]);
    expect(left.sessions).toEqual([]);
    expect(left.identities).toEqual([]);
    expect(left.labels.length).toBeGreaterThan(0);
    expect(left.labels.every((row) => row.label === 'Deleted user')).toBe(true);
    const inTenant = await app.get(Tenancy).run(tenantId, () =>
      db
        .select({ label: auditLog.actorLabel })
        .from(auditLog)
        .where(eq(auditLog.actor, `user:${user.id}`)),
    );
    expect(inTenant.every((row) => row.label === 'Deleted user')).toBe(true);
    expect((await agent.get('/v1/auth/me')).statusCode).toBe(401);
    const [done] = await inNoTenant(() =>
      db
        .select()
        .from(accountDeletions)
        .where(eq(accountDeletions.userId, user.id)),
    );
    expect(done!.completedAt).not.toBeNull();
  });

  it('keeps the account whole while a legal hold names the person', async () => {
    const { agent, user, tenantId, password } = await signedIn();
    await agent.post('/v1/account/deletion', { password });
    await app.get(Tenancy).run(tenantId, () =>
      db.insert(legalHolds).values({
        subject: 'User',
        recordId: user.id,
        reason: 'A court order',
        placedBy: 'user:someone',
      }),
    );
    expect(
      await app
        .get(AccountDeletionJob)
        .deleteDue(new Date(Date.now() + 15 * DAY)),
    ).toBe(0);
    const state = (await agent.get('/v1/account')).json();
    expect(state.deletion).not.toBeNull();
  });

  it('cancels nothing once the job claimed the request', async () => {
    const { agent, user, password } = await signedIn();
    await agent.post('/v1/account/deletion', { password });
    await inNoTenant(() =>
      db
        .update(accountDeletions)
        .set({ startedAt: new Date() })
        .where(eq(accountDeletions.userId, user.id)),
    );
    expect((await agent.delete('/v1/account/deletion')).statusCode).toBe(404);
  });
});
