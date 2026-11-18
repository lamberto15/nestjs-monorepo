import { createHmac } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import {
  accessModules,
  tenantWithAdmin,
  member,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { MessagingRetentionJob } from './messaging.retention.job.js';
import { MessagingModule } from './messaging.module.js';
import { MESSAGING } from './messaging.queue.js';
import { MessagingSender } from './messaging.sender.js';
import {
  messagingDevices,
  messagingUsage,
  phoneNumbers,
} from './messaging.tables.js';
import { MemoryPushProvider } from './providers/memory-push.provider.js';
import { PUSH_PROVIDER } from './providers/push-provider.js';

/**
 * A stand-in for Twilio's REST API on loopback, started before the app
 * loads (TWILIO_API_URL): it records each message the worker sends and
 * answers as `state.next` says.
 */
const twilio = await vi.hoisted(async () => {
  const { createServer } = await import('node:http');
  const state = {
    next: [] as number[],
    bodies: [] as Record<string, string>[],
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      state.bodies.push(
        Object.fromEntries(
          new URLSearchParams(Buffer.concat(chunks).toString()),
        ),
      );
      const status = state.next.shift() ?? 201;
      res
        .writeHead(status, { 'content-type': 'application/json' })
        .end(
          JSON.stringify(
            status === 201
              ? { sid: `SM${state.bodies.length}` }
              : { code: status === 400 ? 21610 : 0 },
          ),
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  Object.assign(process.env, {
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'twilio-test-token',
    TWILIO_FROM: '+15005550006',
    TWILIO_API_URL: `http://127.0.0.1:${port}`,
    TWILIO_WEBHOOK_URL: 'http://127.0.0.1/v1/webhooks/sms/twilio',
    PUSH_PROVIDER: 'memory',
    SMS_ALLOWED_PREFIXES: '+49,+44',
    SMS_DAILY_LIMIT_PER_USER: '3',
    SMS_MAX_LENGTH: '60',
    APP_ROLE: 'all',
    SCHEDULER: 'off',
    REDIS_PREFIX: `test-messaging-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: Buffer.alloc(32, 7).toString('base64'),
    BLIND_INDEX_KEYS: Buffer.alloc(32, 9).toString('base64'),
  });
  return {
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
});

const NUMBER = '+4915112345678';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('push and SMS (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let tenantId: string;
  let ip = 0;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      MetricsModule,
      MessagingModule,
    );
    db = app.get<Database>(getDrizzleToken());
    tenantId = (await tenantWithAdmin(app)).tenantId;
  });
  afterAll(async () => {
    await app.close();
    await twilio.close();
  });
  beforeEach(() => {
    twilio.state.bodies.length = 0;
    twilio.state.next.length = 0;
  });

  const queue = () => app.get<Queue>(getQueueToken(MESSAGING));
  const push = () => app.get<MemoryPushProvider>(PUSH_PROVIDER);

  /** The worker runs in the test: waits until no job is waiting, running or due. */
  async function idle() {
    for (let tries = 0; tries < 400; tries++) {
      const counts = await queue().getJobCounts('waiting', 'active', 'delayed');
      if (Object.values(counts).every((count) => count === 0)) return;
      await sleep(25);
    }
    throw new Error('The messaging queue did not go idle.');
  }

  /** A request from a client address of its own, so one route's throttle doesn't end the file. */
  const call = (
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) =>
    app.inject({
      method,
      url,
      headers,
      remoteAddress: `10.1.0.${++ip}`,
      ...(payload && { payload }),
    });

  const code = () =>
    /code is (\d{6})/.exec(twilio.state.bodies.at(-1)?.Body ?? '')?.[1];

  /** A member whose number is set and verified (the code texted to it, read from the stub). */
  async function userWithPhone(phone = NUMBER) {
    const user = await member(app, tenantId, ['editor']);
    expect(
      (await call('PUT', '/v1/messaging/phone', user.headers, { phone }))
        .statusCode,
    ).toBe(200);
    await idle();
    const verified = await call(
      'POST',
      '/v1/messaging/phone/verify',
      user.headers,
      {
        code: code(),
      },
    );
    expect(verified.statusCode).toBe(200);
    return user;
  }

  describe('devices', () => {
    it('registers, refreshes, lists and removes a device; the token is encrypted and never returned', async () => {
      const user = await member(app, tenantId, ['editor']);
      const registered = await call(
        'PUT',
        '/v1/messaging/devices',
        user.headers,
        {
          platform: 'ios',
          name: 'iPhone',
          token: 'ab12'.repeat(16),
        },
      );
      expect(registered.statusCode).toBe(200);
      const device = registered.json();
      expect(device).toMatchObject({ platform: 'ios', name: 'iPhone' });
      expect(JSON.stringify(device)).not.toContain('ab12ab12');

      const [row] = await db
        .select()
        .from(messagingDevices)
        .where(eq(messagingDevices.id, device.id));
      expect(row!.token).not.toContain('ab12ab12');
      expect(
        app.get(EncryptionService).decrypt(messagingDevices.token, row!.token),
      ).toBe('ab12'.repeat(16));

      // The same token again refreshes it: still one device.
      await call('PUT', '/v1/messaging/devices', user.headers, {
        platform: 'ios',
        name: 'iPhone 16',
        token: 'ab12'.repeat(16),
      });
      const listed = (
        await call('GET', '/v1/messaging/devices', user.headers)
      ).json();
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0].name).toBe('iPhone 16');

      // A token another person had registered moves to the caller.
      const other = await member(app, tenantId, ['editor']);
      await call('PUT', '/v1/messaging/devices', other.headers, {
        platform: 'ios',
        name: 'Shared',
        token: 'ab12'.repeat(16),
      });
      expect(
        (await call('GET', '/v1/messaging/devices', user.headers)).json().items,
      ).toHaveLength(0);

      const mine = (
        await call('GET', '/v1/messaging/devices', other.headers)
      ).json().items[0];
      expect(
        (await call('DELETE', `/v1/messaging/devices/${mine.id}`, user.headers))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await call(
            'DELETE',
            `/v1/messaging/devices/${mine.id}`,
            other.headers,
          )
        ).statusCode,
      ).toBe(204);
    });

    it('validates the body', async () => {
      const user = await member(app, tenantId, ['editor']);
      const bad = await call('PUT', '/v1/messaging/devices', user.headers, {
        platform: 'web',
        name: '',
        token: 'x',
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('push delivery', () => {
    it('pushes to every device through the queue, clips an oversized body, and deletes a device the provider reports dead', async () => {
      const user = await member(app, tenantId, ['editor']);
      for (const token of ['one-token', 'dead-token']) {
        await call('PUT', '/v1/messaging/devices', user.headers, {
          platform: 'android',
          name: token,
          token,
        });
      }
      const pushed = await app.get(MessagingSender).pushToDevices({
        tenantId,
        userId: user.id,
        messageId: 'n-1',
        title: 'Hello',
        body: 'x'.repeat(10_000),
        link: '/things/1',
      });
      expect(pushed).toBe(2);
      await idle();
      expect(push().sent.map((sent) => sent.token)).toEqual(['one-token']);
      const payload = push().sent[0]!.payload;
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(
        3500,
      );
      expect(payload).toMatchObject({
        id: 'n-1',
        title: 'Hello',
        link: '/things/1',
      });
      const left = (
        await call('GET', '/v1/messaging/devices', user.headers)
      ).json().items;
      expect(left.map((device: { name: string }) => device.name)).toEqual([
        'one-token',
      ]);
    });

    it('drops a queued push once another account has registered the device', async () => {
      const alice = await member(app, tenantId, ['editor']);
      const bob = await member(app, tenantId, ['editor']);
      const token = 'handed-over-token';
      const registered = await call(
        'PUT',
        '/v1/messaging/devices',
        alice.headers,
        {
          platform: 'android',
          name: 'Shared phone',
          token,
        },
      );
      const deviceId = registered.json().id;
      await app.get(MessagingSender).pushToDevices({
        tenantId,
        userId: alice.id,
        messageId: 'n-handed-over',
        title: 'For Alice',
        body: 'Only Alice should read this.',
        link: null,
        sendAt: new Date(Date.now() + 3_600_000),
      });
      const job = (await queue().getJob(`push-n-handed-over-${deviceId}`))!;
      expect(await job.getState()).toBe('delayed');

      // Bob signs in on the same phone: the token moves to him and keeps its id.
      const moved = await call('PUT', '/v1/messaging/devices', bob.headers, {
        platform: 'android',
        name: 'Shared phone',
        token,
      });
      expect(moved.json().id).toBe(deviceId);

      const before = push().sent.length;
      await job.promote();
      await idle();
      expect(push().sent.slice(before)).toEqual([]);
      const bobs = (
        await call('GET', '/v1/messaging/devices', bob.headers)
      ).json().items;
      expect(bobs.map((device: { id: string }) => device.id)).toEqual([
        deviceId,
      ]);
    });
  });

  describe('the phone number and SMS delivery', () => {
    it('sets a number, texts a code, verifies it; the number is encrypted and shown masked', async () => {
      const user = await member(app, tenantId, ['editor']);
      const set = await call('PUT', '/v1/messaging/phone', user.headers, {
        phone: NUMBER,
      });
      expect(set.json()).toEqual({
        phone: '+49•••••••••78',
        verified: false,
        optedOut: false,
      });
      await idle();
      expect(twilio.state.bodies.at(-1)).toMatchObject({
        To: NUMBER,
        From: '+15005550006',
      });
      expect(code()).toMatch(/^\d{6}$/);

      const [row] = await db
        .select()
        .from(phoneNumbers)
        .where(eq(phoneNumbers.userId, user.id));
      expect(row!.phone).not.toContain('4915');

      const wrong = await call(
        'POST',
        '/v1/messaging/phone/verify',
        user.headers,
        { code: '000000' },
      );
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().code).toBe('code_invalid');
      const verified = await call(
        'POST',
        '/v1/messaging/phone/verify',
        user.headers,
        { code: code() },
      );
      expect(verified.json()).toEqual({
        phone: '+49•••••••••78',
        verified: true,
        optedOut: false,
      });
      expect(
        (await call('DELETE', '/v1/messaging/phone', user.headers)).statusCode,
      ).toBe(204);
      expect(
        (await call('GET', '/v1/messaging/phone', user.headers)).json().phone,
      ).toBeNull();
    });

    it('voids a code after five wrong guesses, and refuses a number outside the allowed countries or a malformed one', async () => {
      const user = await member(app, tenantId, ['editor']);
      await call('PUT', '/v1/messaging/phone', user.headers, { phone: NUMBER });
      await idle();
      const right = code();
      for (let guess = 0; guess < 5; guess++) {
        await call('POST', '/v1/messaging/phone/verify', user.headers, {
          code: '000001',
        });
      }
      const late = await call(
        'POST',
        '/v1/messaging/phone/verify',
        user.headers,
        { code: right },
      );
      expect(late.statusCode).toBe(400);

      const other = await member(app, tenantId, ['editor']);
      const abroad = await call('PUT', '/v1/messaging/phone', other.headers, {
        phone: '+15551234567',
      });
      expect(abroad.json().code).toBe('phone_country_not_allowed');
      const junk = await call('PUT', '/v1/messaging/phone', other.headers, {
        phone: 'not a number',
      });
      expect(junk.json().code).toBe('phone_invalid');
    });

    it('texts only a verified number, clips the text, and retries a transient provider failure through the queue', async () => {
      const user = await userWithPhone();
      twilio.state.bodies.length = 0;
      twilio.state.next.push(503);
      const sender = app.get(MessagingSender);
      expect(
        await sender.text({
          tenantId,
          userId: user.id,
          messageId: 'n-2',
          title: 'Order',
          body: 'y'.repeat(200),
        }),
      ).toBe(true);
      await vi.waitFor(
        () => expect(twilio.state.bodies.length).toBeGreaterThanOrEqual(1),
        { timeout: 15_000 },
      );
      await vi.waitFor(() => expect(twilio.state.bodies.length).toBe(2), {
        timeout: 30_000,
      });
      expect(twilio.state.bodies[1]!.Body).toHaveLength(60);

      const stranger = await member(app, tenantId, ['editor']);
      expect(
        await sender.text({
          tenantId,
          userId: stranger.id,
          messageId: 'n-3',
          title: 't',
          body: 'b',
        }),
      ).toBe(false);
    });
  });

  describe('toll-fraud caps', () => {
    it('caps a user per day, refuses past it and counts the refusal', async () => {
      const user = await userWithPhone('+4915198765432');
      // The code used one of the three.
      twilio.state.bodies.length = 0;
      const sender = app.get(MessagingSender);
      for (let n = 0; n < 4; n++) {
        await sender.text({
          tenantId,
          userId: user.id,
          messageId: `cap-${n}`,
          title: 'T',
          body: 'B',
        });
      }
      await idle();
      expect(twilio.state.bodies).toHaveLength(2);
      const counters = await app
        .get(Tenancy)
        .run(tenantId, () => db.select().from(messagingUsage));
      expect(
        counters.find((row) => row.counter === 'blocked:user_limit')?.count,
      ).toBe(2);
    });
  });

  describe('STOP and START', () => {
    const sign = (
      fields: Record<string, string>,
      token = 'twilio-test-token',
    ) =>
      createHmac('sha1', token)
        .update(
          'http://127.0.0.1/v1/webhooks/sms/twilio' +
            Object.keys(fields)
              .sort()
              .map((key) => key + fields[key])
              .join(''),
        )
        .digest('base64');
    const inbound = (body: string, token?: string) => {
      const fields = {
        From: '+4915112349999',
        Body: body,
        MessageSid: `SM${Math.random()}`,
      };
      return app.inject({
        method: 'POST',
        url: '/v1/webhooks/sms/twilio',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': sign(fields, token),
        },
        payload: new URLSearchParams(fields).toString(),
      });
    };

    it('refuses what is not signed, opts the number out on STOP (no SMS until START), and ignores other replies', async () => {
      expect((await inbound('STOP', 'wrong-token')).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/webhooks/sms/mailgun',
            payload: 'x',
          })
        ).statusCode,
      ).toBe(404);

      const user = await userWithPhone('+4915112349999');
      const sender = app.get(MessagingSender);
      expect((await inbound('STOP')).statusCode).toBe(204);
      expect(
        (await call('GET', '/v1/messaging/phone', user.headers)).json()
          .optedOut,
      ).toBe(true);
      expect(
        await sender.text({
          tenantId,
          userId: user.id,
          messageId: 'stop-1',
          title: 'T',
          body: 'B',
        }),
      ).toBe(false);

      expect((await inbound('please stop')).statusCode).toBe(204);
      expect((await inbound('START')).statusCode).toBe(204);
      expect(
        (await call('GET', '/v1/messaging/phone', user.headers)).json()
          .optedOut,
      ).toBe(false);
      expect(
        await sender.text({
          tenantId,
          userId: user.id,
          messageId: 'start-1',
          title: 'T',
          body: 'B',
        }),
      ).toBe(true);
      await idle();
    });
  });

  it('sweeps devices not seen for MESSAGING_DEVICE_RETENTION_DAYS', async () => {
    const user = await member(app, tenantId, ['editor']);
    const created = await call('PUT', '/v1/messaging/devices', user.headers, {
      platform: 'ios',
      name: 'Old',
      token: 'cd34'.repeat(16),
    });
    const job = app.get(MessagingRetentionJob);
    expect((await job.run(new Date())).devices).toBe(0);
    const swept = await job.run(new Date(Date.now() + 271 * 86_400_000));
    expect(swept.devices).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select()
      .from(messagingDevices)
      .where(eq(messagingDevices.id, created.json().id));
    expect(rows).toEqual([]);
  });
});
