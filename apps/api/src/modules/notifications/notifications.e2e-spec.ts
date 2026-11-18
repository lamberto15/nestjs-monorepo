import { Transactional } from '@nestjs-cls/transactional';
import { getQueueToken } from '@nestjs/bullmq';
import { Injectable, Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { InMemoryMailTransport, MailTransport } from '@nestjs/mail';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import {
  member,
  accessModules,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { MAIL_QUEUE } from '../../core/mail/mail.queue.js';
import { SharedOutboxModule } from '../../core/outbox/outbox.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { SecretsModule } from '../../core/secrets/secrets.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessRecordFinder } from '../../iam/access/access-record-finder.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { definePermissions } from '../../iam/access/permissions.js';
import { Realtime } from '../realtime/realtime.service.js';
import { NotificationDigestJob } from './notifications.digest.job.js';
import { NotificationsModule } from './notifications.module.js';
import { PUSH_QUEUE, WebPushTransport } from './notifications.push.js';
import { NotificationRetentionJob } from './notifications.retention.job.js';
import {
  notificationCreated,
  unreadCountChanged,
} from './notifications.events.js';
import { NotificationsService } from './notifications.service.js';
import { notifications, pushDevices } from './notifications.tables.js';
import { UnsubscribeLinks } from './notifications.unsubscribe.js';
import { SubscriptionsService } from './subscriptions.service.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-notifications-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    WEB_PUSH_SUBJECT: 'mailto:ops@example.com',
  });
});

const WIDGET = '0199a3f2-0000-7000-8000-000000000001';

/** A subject modules own: watchers need a record finder and a read permission. */
const WIDGET_PERMISSIONS = definePermissions({
  subjects: { Widget: { actions: { read: [] } } },
});

/** What a module that sends notifications does: inside the transaction of its change. */
@Injectable()
class Sender {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  @Transactional()
  send(input: Parameters<NotificationsService['notify']>[0]) {
    return this.notifications.notify(input);
  }

  @Transactional()
  async changeWidget(by: string) {
    return this.subscriptions.notifyWatchers({
      subject: 'Widget',
      recordId: WIDGET,
      type: 'notification.test',
      data: { at: new Date().toISOString() },
      except: by,
    });
  }

  @Transactional()
  async watch(who: { kind: 'user'; id: string }) {
    await this.subscriptions.subscribe(who, {
      subject: 'Widget',
      recordId: WIDGET,
    });
  }
}

@AccessRecordFinder('Widget')
@Injectable()
class WidgetFinder {
  find(id: string) {
    return Promise.resolve(id === WIDGET ? { id } : null);
  }
}

@Module({
  imports: [NotificationsModule, AccessModule.forFeature(WIDGET_PERMISSIONS)],
  providers: [Sender, WidgetFinder],
})
class SenderModule {}

type Headers = Record<string, string>;

describe('notifications (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let mailbox: InMemoryMailTransport;
  let pushed: ReturnType<typeof vi.fn>;
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(id: string, work: () => Promise<T>) =>
    app.get(Tenancy).run(id, work);

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SecretsModule,
      SharedOutboxModule,
      SenderModule,
    );
    mailbox = app.get(MailTransport) as InMemoryMailTransport;
    pushed = vi
      .spyOn(app.get(WebPushTransport), 'send')
      .mockResolvedValue({ statusCode: 201 });
    const tenant = await tenantWithAdmin(app);
    tenantId = tenant.tenantId;
  });
  afterAll(async () => {
    if (!app) return;
    for (const name of [MAIL_QUEUE, PUSH_QUEUE]) {
      await app.get<Queue>(getQueueToken(name)).obliterate({ force: true });
    }
    await app.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  /** The subjects of the mail sent to an address (the queue's worker sends it). */
  const subjects = (address: string) =>
    mailbox.mails
      .filter((mail) => mail.to.some((to) => to.address === address))
      .map((mail) => mail.subject);

  const person = (roles: string[] = []) => member(app, tenantId, roles);

  /** Waits until the worker delivered a notification (its channels were served). */
  const delivered = (id: string) =>
    vi.waitFor(
      async () => {
        const [row] = await inTenant(tenantId, () =>
          db().select().from(notifications).where(eq(notifications.id, id)),
        );
        expect(row?.deliveredAt).toBeTruthy();
        return row;
      },
      { timeout: 20_000 },
    );

  /** A test notification to `who`, sent as the person themselves. */
  async function testNotification(who: { headers: Headers }) {
    const response = await call('POST', '/v1/notifications/test', who.headers);
    expect(response.statusCode).toBe(200);
    return (response.json() as { id: string }).id;
  }

  const send = (input: Parameters<Sender['send']>[0]) =>
    inTenant(tenantId, () => app.get(Sender).send(input));

  it('offers notification.created as a webhook event type, for API clients', async () => {
    const admin = (await tenantWithAdmin(app)).admin;
    const res = await call('GET', '/v1/webhook-event-types', admin.headers);
    expect(res.json().items).toContainEqual({
      group: 'notification',
      types: [
        expect.objectContaining({
          type: 'notification.created',
          subject: 'Notification',
        }),
      ],
    });
  });

  it('delivers: stored, listed, mailed, pushed to the registered browser and announced live; nobody else sees it', async () => {
    const alice = await person();
    const bob = await person();
    const realtime = vi.spyOn(app.get(Realtime), 'toPrincipal');
    const register = await call('PUT', '/v1/devices', alice.headers, {
      name: 'Laptop',
      subscription: {
        endpoint: 'https://push.example.com/send/alice',
        keys: { p256dh: 'BPublicKey', auth: 'secret-auth' },
      },
    });
    expect(register.statusCode).toBe(200);
    expect(
      (await call('GET', '/v1/devices', alice.headers)).json().items,
    ).toHaveLength(1);
    expect(
      (await call('GET', '/v1/devices/web-push', alice.headers)).json()
        .publicKey,
    ).toEqual(expect.any(String));

    const id = await testNotification(alice);
    await delivered(id);

    const list = (await call('GET', '/v1/notifications', alice.headers)).json();
    expect(list.items).toEqual([
      expect.objectContaining({
        id,
        type: 'notification.test',
        title: 'Test notification',
        read: false,
        count: 1,
      }),
    ]);
    expect(
      (
        await call('GET', '/v1/notifications/unread-count', alice.headers)
      ).json(),
    ).toEqual({ unread: 1, unreadCapped: false });
    expect(
      (await call('GET', '/v1/notifications', bob.headers)).json().items,
    ).toEqual([]);

    // The mail (immediate is the type's default), the live push and the browser.
    await vi.waitFor(() =>
      expect(subjects(alice.email)).toContain('Test notification'),
    );
    expect(realtime).toHaveBeenCalledWith(
      expect.objectContaining({ id: alice.id }),
      notificationCreated,
      expect.objectContaining({ id }),
    );
    expect(realtime).toHaveBeenCalledWith(
      expect.objectContaining({ id: alice.id }),
      unreadCountChanged,
      { unread: 1, unreadCapped: false },
    );
    await vi.waitFor(() => expect(pushed).toHaveBeenCalled());
    const [subscription, payload] = pushed.mock.calls.at(-1)!;
    expect(subscription).toMatchObject({
      endpoint: 'https://push.example.com/send/alice',
      keys: { p256dh: 'BPublicKey', auth: 'secret-auth' },
    });
    expect(JSON.parse(payload as string)).toMatchObject({
      title: 'Test notification',
    });
    // The secret is stored encrypted.
    const [stored] = await db()
      .select({ auth: pushDevices.auth })
      .from(pushDevices)
      .where(eq(pushDevices.endpoint, 'https://push.example.com/send/alice'));
    expect(stored!.auth).not.toBe('secret-auth');
  });

  it("marks read one, then all; removes one; never touches another person's", async () => {
    const alice = await person();
    const bob = await person();
    const first = await testNotification(alice);
    const second = await testNotification(alice);
    const third = await testNotification(alice);

    const read = await call(
      'POST',
      `/v1/notifications/${first}/read`,
      alice.headers,
    );
    expect(read.json()).toMatchObject({ id: first, read: true });
    expect(
      (await call('POST', `/v1/notifications/${first}/read`, bob.headers))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', `/v1/notifications/${second}`, bob.headers))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', `/v1/notifications/${second}`, alice.headers))
        .statusCode,
    ).toBe(204);
    expect(
      (await call('GET', '/v1/notifications?read=false', alice.headers))
        .json()
        .items.map((item: { id: string }) => item.id),
    ).toEqual([third]);
    expect(
      (
        await call('POST', '/v1/notifications/read-all', alice.headers, {})
      ).json(),
    ).toEqual({ updated: 1 });
    expect(
      (
        await call('GET', '/v1/notifications/unread-count', alice.headers)
      ).json().unread,
    ).toBe(0);
  });

  it('keeps one notification per key, counted up, newest and unread again', async () => {
    const alice = await person();
    const to = { kind: 'user' as const, id: alice.id };
    const data = { at: new Date().toISOString() };
    const [first] = await send({
      type: 'notification.test',
      to,
      data,
      key: 'k1',
    });
    await call('POST', `/v1/notifications/${first}/read`, alice.headers);
    const [second] = await send({
      type: 'notification.test',
      to,
      data,
      key: 'k1',
    });
    expect(second).not.toBe(first);
    const items = (await call('GET', '/v1/notifications', alice.headers)).json()
      .items;
    expect(items).toEqual([
      expect.objectContaining({ id: second, key: 'k1', count: 2, read: false }),
    ]);
  });

  it('refuses a type nobody declared, and the system principal is told nothing', async () => {
    await expect(
      send({ type: 'nobody.declared', to: 'user:x', data: {} }),
    ).rejects.toThrow(/not declared/);
    expect(
      await send({
        type: 'notification.test',
        to: 'system:job',
        data: { at: new Date().toISOString() },
      }),
    ).toEqual([]);
  });

  it('shows each tenant its own notifications', async () => {
    const alice = await person();
    const other = await tenantWithAdmin(app);
    await testNotification(alice);
    expect(
      (await call('GET', '/v1/notifications', other.admin.headers)).json()
        .items,
    ).toEqual([]);
  });

  it('lists the types and takes preferences, refusing what is not valid by name', async () => {
    const alice = await person();
    const types = (
      await call('GET', '/v1/notifications/types', alice.headers)
    ).json();
    // The watched records' types (record.*) are declared by the module too.
    expect(
      types.items.filter((item: { type: string }) =>
        item.type.startsWith('notification.'),
      ),
    ).toEqual([
      expect.objectContaining({
        type: 'notification.test',
        label: 'Test notification',
        mandatory: false,
        channels: { email: 'immediate', push: true },
      }),
    ]);
    expect(
      (
        await call('GET', '/v1/notifications/preferences', alice.headers)
      ).json(),
    ).toMatchObject({
      types: { 'notification.test': { email: 'immediate', push: true } },
    });

    const put = (body: object) =>
      call('PUT', '/v1/notifications/preferences', alice.headers, body);
    const updated = await put({ 'notification.test': { email: 'daily' } });
    expect(updated.json()).toMatchObject({
      types: { 'notification.test': { email: 'daily', push: true } },
    });
    for (const [body, path] of [
      [{ 'notification.test': { email: 'often' } }, 'notification.test.email'],
      [{ 'nope.type': { email: false } }, 'nope.type'],
      [{ 'notification.test': { sms: true } }, 'notification.test.sms'],
    ] as const) {
      const bad = await put(body);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().errors.map((e: { path: string }) => e.path)).toContain(
        path,
      );
    }
    // Back to the defaults: an empty body replaces the overrides.
    await put({});
    expect(
      (await call('GET', '/v1/notifications/preferences', alice.headers)).json()
        .types['notification.test'].email,
    ).toBe('immediate');
  });

  it('bundles a daily preference into a digest mail, once', async () => {
    const alice = await person();
    await call('PUT', '/v1/notifications/preferences', alice.headers, {
      'notification.test': { email: 'daily' },
    });
    const ids = [await testNotification(alice), await testNotification(alice)];
    for (const id of ids) {
      const row = await delivered(id);
      expect(row?.digest).toBe('daily');
      expect(row?.emailedAt).toBeNull();
    }
    expect(subjects(alice.email)).toEqual([]);
    // The digest is due at the next 08:00 of the recipient's day: two days on.
    const due = new Date(Date.now() + 2 * 86_400_000);
    const first = await app.get(NotificationDigestJob).run(due);
    expect(first.mails).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() =>
      expect(subjects(alice.email)).toEqual(['2 new notifications in api']),
    );
    const rows = await inTenant(tenantId, () =>
      db()
        .select()
        .from(notifications)
        .where(eq(notifications.recipient, `user:${alice.id}`)),
    );
    expect(rows.every((row) => row.digest === null && row.emailedAt)).toBe(
      true,
    );
    // Run again: nothing is left to send.
    await app.get(NotificationDigestJob).run(due);
    expect(subjects(alice.email)).toHaveLength(1);
  });

  it("holds a push back during quiet hours, and the quiet hours are the person's to set", async () => {
    const alice = await person();
    await call('PUT', '/v1/devices', alice.headers, {
      name: 'Phone',
      subscription: {
        endpoint: 'https://push.example.com/send/alice-phone',
        keys: { p256dh: 'BPublicKey', auth: 'secret' },
      },
    });
    const hour = (offset: number) =>
      String((new Date().getUTCHours() + 24 + offset) % 24).padStart(2, '0') +
      ':00';
    const set = await call(
      'PUT',
      '/v1/notifications/quiet-hours',
      alice.headers,
      {
        start: hour(-1),
        end: hour(2),
      },
    );
    expect(set.json().quietHours).toMatchObject({
      start: hour(-1),
      end: hour(2),
      timezone: 'UTC',
    });
    const id = await testNotification(alice);
    await delivered(id);
    const devices = (await call('GET', '/v1/devices', alice.headers)).json()
      .items;
    const queue = app.get<Queue>(getQueueToken(PUSH_QUEUE));
    const job = await queue.getJob(`push-${id}-${devices[0].id}`);
    expect(job?.opts.delay).toBeGreaterThan(0);

    const cleared = await call(
      'DELETE',
      '/v1/notifications/quiet-hours',
      alice.headers,
    );
    expect(cleared.json()).toEqual({ quietHours: null });
    expect(
      (
        await call('PUT', '/v1/notifications/quiet-hours', alice.headers, {
          start: '08:00',
          end: '08:00',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('unsubscribes with the mail link, without signing in: described by GET, done by POST, only that type', async () => {
    const alice = await person();
    const links = app.get(UnsubscribeLinks);
    const token = await links.signType(alice.id, 'notification.test');

    const described = await app.inject({
      method: 'GET',
      url: `/v1/notifications/unsubscribe/${token}`,
    });
    expect(described.json()).toEqual({
      kind: 'type',
      label: 'Test notification',
    });
    // A GET changes nothing.
    expect(
      (await call('GET', '/v1/notifications/preferences', alice.headers)).json()
        .types['notification.test'].email,
    ).toBe('immediate');

    const post = () =>
      app.inject({
        method: 'POST',
        url: `/v1/notifications/unsubscribe/${token}`,
        payload: { 'List-Unsubscribe': 'One-Click' },
      });
    expect((await post()).statusCode).toBe(204);
    expect((await post()).statusCode).toBe(204);
    expect(
      (await call('GET', '/v1/notifications/preferences', alice.headers)).json()
        .types['notification.test'],
    ).toEqual({ email: false, push: true });

    for (const bad of [`${token}x`, 'garbage', `${token.split('.')[0]}.AAAA`]) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/notifications/unsubscribe/${bad}`,
        payload: { 'List-Unsubscribe': 'One-Click' },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/notifications/unsubscribe/${token}`,
          payload: { nope: true },
        })
      ).statusCode,
    ).toBe(400);
    const digest = await links.signDigests(alice.id, ['hourly']);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/notifications/unsubscribe/${digest}`,
        })
      ).json(),
    ).toEqual({ kind: 'digest', modes: ['hourly'] });
  });

  it('deletes old read notifications and any past the maximum age, nightly', async () => {
    const alice = await person();
    const to = { kind: 'user' as const, id: alice.id };
    const data = { at: new Date().toISOString() };
    const [oldRead] = await send({ type: 'notification.test', to, data });
    const [oldUnread] = await send({ type: 'notification.test', to, data });
    const [ancient] = await send({ type: 'notification.test', to, data });
    const [fresh] = await send({ type: 'notification.test', to, data });
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    await inTenant(tenantId, async () => {
      const set = (
        id: string,
        values: Partial<typeof notifications.$inferInsert>,
      ) =>
        db().update(notifications).set(values).where(eq(notifications.id, id));
      await set(oldRead!, { readAt: days(100) });
      await set(oldUnread!, { createdAt: days(100) });
      await set(ancient!, { createdAt: days(400) });
      await set(fresh!, { readAt: days(1) });
    });
    await app.get(NotificationRetentionJob).run();
    const left = await inTenant(tenantId, () =>
      db()
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.recipient, `user:${alice.id}`)),
    );
    expect(left.map((row) => row.id).sort()).toEqual(
      [oldUnread!, fresh!].sort(),
    );
  });

  it("tells the watchers of a record but the one who changed it; lists and ends one's own watching", async () => {
    const alice = await person();
    const bob = await person();
    const sender = app.get(Sender);
    await inTenant(tenantId, async () => {
      await sender.watch({ kind: 'user', id: alice.id });
      await sender.watch({ kind: 'user', id: bob.id });
    });
    const ids = await inTenant(tenantId, () =>
      sender.changeWidget(`user:${bob.id}`),
    );
    expect(ids).toHaveLength(1);
    const mine = (await call('GET', '/v1/notifications', alice.headers)).json()
      .items;
    expect(mine.map((item: { id: string }) => item.id)).toContain(ids[0]);
    expect(
      (await call('GET', '/v1/notifications', bob.headers))
        .json()
        .items.map((item: { id: string }) => item.id),
    ).not.toContain(ids[0]);

    const watched = (
      await call('GET', '/v1/subscriptions?subject=Widget', alice.headers)
    ).json();
    expect(watched.items).toEqual([
      expect.objectContaining({ subject: 'Widget', recordId: WIDGET }),
    ]);
    expect(
      (
        await call(
          'DELETE',
          `/v1/subscriptions/Widget/${WIDGET}`,
          alice.headers,
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await call(
          'DELETE',
          `/v1/subscriptions/Widget/${WIDGET}`,
          alice.headers,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('lets a person watch a record they may read, and answers 404 for any other', async () => {
    const reader = await person(['administrator']);
    const stranger = await person();
    expect(
      (await call('PUT', `/v1/subscriptions/Widget/${WIDGET}`, reader.headers))
        .statusCode,
    ).toBe(204);
    expect(
      await inTenant(tenantId, () =>
        app
          .get(SubscriptionsService)
          .isWatching(
            { kind: 'user', id: reader.id },
            { subject: 'Widget', recordId: WIDGET },
          ),
      ),
    ).toBe(true);
    for (const [who, id] of [
      [stranger, WIDGET],
      [reader, '0199a3f2-0000-7000-8000-00000000ffff'],
    ] as const) {
      expect(
        (await call('PUT', `/v1/subscriptions/Widget/${id}`, who.headers))
          .statusCode,
      ).toBe(404);
    }
  });

  it('moves a browser to whoever registers it last, and removes it on request', async () => {
    const alice = await person();
    const bob = await person();
    const subscription = {
      endpoint: 'https://push.example.com/send/shared',
      keys: { p256dh: 'BPublicKey', auth: 'secret' },
    };
    await call('PUT', '/v1/devices', alice.headers, {
      name: 'Shared',
      subscription,
    });
    const moved = await call('PUT', '/v1/devices', bob.headers, {
      name: 'Shared',
      subscription,
    });
    expect(moved.statusCode).toBe(200);
    expect(
      (await call('GET', '/v1/devices', alice.headers)).json().items,
    ).toEqual([]);
    const { id } = moved.json() as { id: string };
    expect(
      (await call('DELETE', `/v1/devices/${id}`, alice.headers)).statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', `/v1/devices/${id}`, bob.headers)).statusCode,
    ).toBe(204);
  });

  it('forgets a browser the push service says is gone', async () => {
    const alice = await person();
    await call('PUT', '/v1/devices', alice.headers, {
      name: 'Gone',
      subscription: {
        endpoint: 'https://push.example.com/send/gone',
        keys: { p256dh: 'BPublicKey', auth: 'secret' },
      },
    });
    const { WebPushError } = await import('web-push');
    const error = new WebPushError(
      'gone',
      410,
      {},
      '',
      'https://push.example.com',
    );
    pushed.mockRejectedValueOnce(error);
    await testNotification(alice);
    await vi.waitFor(
      async () =>
        expect(
          (await call('GET', '/v1/devices', alice.headers)).json().items,
        ).toEqual([]),
      { timeout: 20_000 },
    );
  });
});
